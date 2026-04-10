import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

import {
  BotAdapterError,
  type BotAdapter,
  type BotReply,
  type SendMessageOptions,
} from "../core/bot-adapter.js";

/**
 * Adapter for Hermes Agent (Nous Research) deployments accessible via SSH.
 *
 * Unlike OpenClaw, Hermes doesn't expose a ready-made HTTP/WS chat API. It
 * ships a CLI entry point `hermes chat -q <query> -Q --source tool` that is
 * explicitly documented as:
 *
 *   > Quiet mode for programmatic use: suppress banner, spinner, and tool
 *   > previews. Only output the final response and session info.
 *
 * and:
 *
 *   > --source tool    Session source tag for filtering (default: cli).
 *   >                  Use 'tool' for third-party integrations that should
 *   >                  not appear in user session lists.
 *
 * So the adapter is a thin shell-out: for every sendMessage call we spawn
 * `railway ssh ... 'hermes chat -q ... -Q --source tool --yolo [-r <id>]'`,
 * then parse the quiet-mode output to extract the reply text and Hermes's
 * session ID. The returned session ID is cached so subsequent sendMessage
 * calls with the same sessionKey resume the same Hermes session via -r.
 *
 * Works for any Hermes deployment reachable via `railway ssh` (Railway-
 * hosted) or plain ssh (bare metal). This implementation targets Railway;
 * a plain-ssh variant is a 20-line change.
 */
export interface HermesAdapterOptions {
  /** Railway project UUID. From the `railway ssh --project=...` flag. */
  railwayProject: string;
  /** Railway environment UUID. */
  railwayEnvironment: string;
  /** Railway service UUID. */
  railwayService: string;
  /**
   * Override the hermes CLI flags if you need to target a specific model,
   * provider, or skills. Defaults are sensible for general-purpose tests.
   */
  extraHermesArgs?: readonly string[];
  /** Per-message timeout in ms. Default: 120s. */
  defaultTimeoutMs?: number;
}

export class HermesAdapter implements BotAdapter {
  public readonly name = "hermes";

  private readonly project: string;
  private readonly environment: string;
  private readonly service: string;
  private readonly extraArgs: readonly string[];
  private readonly defaultTimeoutMs: number;

  /** sessionKey -> Hermes session id (e.g. "20260410_181529_22476d"). */
  private readonly sessionMap = new Map<string, string>();

  constructor(opts: HermesAdapterOptions) {
    this.project = opts.railwayProject;
    this.environment = opts.railwayEnvironment;
    this.service = opts.railwayService;
    this.extraArgs = opts.extraHermesArgs ?? [];
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 120_000;
  }

  // No persistent connection — every message is a fresh SSH invocation.
  // Implementing connect/disconnect as no-ops keeps the BotAdapter contract
  // identical across platforms.
  async connect(): Promise<void> {
    // Light preflight: verify the railway CLI is reachable and the service
    // is resolvable. We ask the container to `echo` and expect it to work.
    try {
      await this.runRemote("echo ok", 10_000);
    } catch (err) {
      throw new BotAdapterError(
        `hermes preflight failed: ${(err as Error).message}`,
        "not_connected",
        err,
      );
    }
  }

  async disconnect(): Promise<void> {
    this.sessionMap.clear();
  }

  async sendMessage(opts: SendMessageOptions): Promise<BotReply> {
    const sessionKey = opts.sessionKey ?? `agentprobe-${randomUUID()}`;
    const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;

    // Build the hermes chat argv. Each element is passed as a distinct shell
    // arg once we assemble the final command string remote-side. Absolute
    // path on the binary because `bash -c` inside the SSH tunnel doesn't
    // source the interactive profile and /usr/local/bin may not be on PATH.
    const hermesArgs = [
      "/usr/local/bin/hermes",
      "chat",
      "-q",
      opts.text,
      "-Q",
      "--source",
      "tool",
      "--yolo",
      ...this.extraArgs,
    ];
    const priorSession = this.sessionMap.get(sessionKey);
    if (priorSession) {
      hermesArgs.push("-r", priorSession);
    }

    const command = buildRemoteBashCommand(hermesArgs);

    const startedAt = Date.now();
    const { stdout, stderr, code } = await this.runRemote(command, timeoutMs);
    const responseTimeMs = Date.now() - startedAt;

    if (code !== 0) {
      throw new BotAdapterError(
        `hermes chat exited with code ${code}: ${firstLines(stderr || stdout, 3)}`,
        "gateway_error",
        { code, stderr, stdout },
      );
    }

    const parsed = parseHermesQuietOutput(stdout);
    if (parsed.sessionId) {
      this.sessionMap.set(sessionKey, parsed.sessionId);
    }

    return {
      text: parsed.text,
      responseTimeMs,
      raw: { stdout, stderr, hermesSessionId: parsed.sessionId ?? null },
      events: [], // Hermes quiet mode doesn't emit intermediate events.
    };
  }

  // -------- internals --------

  private runRemote(
    command: string,
    timeoutMs: number,
  ): Promise<{ stdout: string; stderr: string; code: number }> {
    return new Promise((resolve, reject) => {
      // We must assemble the full cmd.exe command line ourselves because:
      //
      //   1. Windows needs `shell: true` to resolve `railway.cmd`.
      //   2. With `shell: true`, Node concatenates args with spaces, which
      //      breaks any arg containing pipes (|) — cmd.exe interprets the
      //      pipe *locally* and splits our remote command across processes.
      //
      // Solution: build a single command string and wrap the remote command
      // in double quotes so cmd.exe passes it as one literal arg to the
      // railway executable. The remote command is base64-wrapped upstream,
      // so it's guaranteed not to contain double quotes or backslashes.
      const cmdLine =
        `railway ssh` +
        ` --project=${this.project}` +
        ` --environment=${this.environment}` +
        ` --service=${this.service}` +
        ` "${command}"`;

      const child = spawn(cmdLine, [], { shell: true });

      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`remote command timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));

      child.on("error", (err: Error) => {
        clearTimeout(timer);
        reject(err);
      });

      child.on("close", (code: number | null) => {
        clearTimeout(timer);
        resolve({ stdout, stderr, code: code ?? -1 });
      });
    });
  }
}

// -------- helpers (exported for testing) --------

/**
 * Assemble a bash command string that safely executes the given argv on the
 * remote side. We base64-encode a small shell script so the arbitrary user
 * text in argv (which may contain quotes, backticks, $, etc.) never touches
 * any shell parser along the way — not the local `railway ssh` wrapper, not
 * the ssh tunnel, not the remote bash. Everything gets decoded and exec'd
 * via `exec` with a proper argv inside the remote script.
 */
export function buildRemoteBashCommand(argv: readonly string[]): string {
  // Build a bash script that sets argv via `set --` and exec's it.
  // `printf '%q ' "$@"` + set -- handles quoting at the remote side.
  const remoteScript =
    "set -- " +
    argv
      .map(
        (a) =>
          // Single-quote escape: '..' splits on ' and concatenates with
          // escaped single quotes. Works in bash regardless of input bytes.
          "'" + a.replace(/'/g, "'\\''") + "'",
      )
      .join(" ") +
    ' && exec "$@"';
  const b64 = Buffer.from(remoteScript, "utf8").toString("base64");
  return `echo ${b64} | base64 -d | bash`;
}

/**
 * Parse the output of `hermes chat -q ... -Q` into { text, sessionId }.
 *
 * Example output (with ANSI stripped):
 *
 *     ╭─ ⚕ Hermes ───────────────────────────────────╮
 *     HERMES WORKS
 *
 *     session_id: 20260410_181529_22476d
 *
 * The reply is whatever sits between the top box-drawing line and the
 * `session_id:` marker. Quiet mode keeps this predictable.
 */
export function parseHermesQuietOutput(raw: string): {
  text: string;
  sessionId?: string;
} {
  const stripped = stripAnsi(raw);
  const sessionMatch = stripped.match(/session_id:\s*([A-Za-z0-9_.-]+)/);
  const sessionId = sessionMatch ? sessionMatch[1] : undefined;

  // Cut off everything from the session_id marker on.
  let body = stripped;
  if (sessionMatch) {
    body = stripped.slice(0, sessionMatch.index);
  }

  // Drop any framing lines produced by hermes chat's box-drawn header.
  // Example header: "╭─ ⚕ Hermes ───────────────────────────╮"
  // Rule: any line whose first non-whitespace character is a box-drawing
  // glyph is a frame line, not content. This also covers footer ╰─...─╯
  // variants if hermes emits them.
  //
  // When the caller passes -r <session_id>, hermes prints a "↻ Resumed
  // session ... (N user messages, M total messages)" line above the reply.
  // That's metadata, not part of the bot's response — strip it too.
  const lines = body.split(/\r?\n/);
  const cleaned: string[] = [];
  for (const line of lines) {
    const trimmed = line.trimEnd();
    if (trimmed === "") {
      cleaned.push(trimmed);
      continue;
    }
    const firstChar = trimmed.trimStart().charCodeAt(0);
    if (firstChar >= 0x2500 && firstChar <= 0x257f) continue;
    if (/^[\s\u2500-\u257F]*$/.test(trimmed)) continue;
    // "↻ Resumed session ..." prefix line. The ↻ is U+21BB; the text varies
    // but always starts with that character (or its plain-text fallback).
    if (/^\s*[↻⟲]\s*Resumed session\b/.test(trimmed)) continue;
    if (/^\s*Resumed session\s+\d{8}_\d{6}_/.test(trimmed)) continue;
    cleaned.push(trimmed);
  }
  const text = cleaned.join("\n").trim();

  if (sessionId) return { text, sessionId };
  return { text };
}

export function stripAnsi(input: string): string {
  // Matches CSI, OSC, and related escape sequences. Adapted from the
  // well-known ansi-regex package to avoid a dep for one function.
  return input.replace(
    // eslint-disable-next-line no-control-regex
    /[\u001B\u009B][[()#;?]*(?:(?:(?:(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*|[a-zA-Z\d]+(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PRZcf-ntqry=><~]))/g,
    "",
  );
}

function firstLines(s: string, n: number): string {
  return s.split(/\r?\n/).slice(0, n).join(" ").trim();
}
