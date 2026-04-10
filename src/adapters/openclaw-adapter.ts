import { randomUUID } from "node:crypto";
import WebSocket, { type RawData } from "ws";

import {
  BotAdapterError,
  type BotAdapter,
  type BotEvent,
  type BotReply,
  type SendMessageOptions,
} from "../core/bot-adapter.js";
import {
  buildDeviceAuthPayloadV3,
  loadDeviceKey,
  signDeviceAuthPayload,
  type DeviceKeyMaterial,
} from "./openclaw-device-auth.js";

/**
 * Adapter for OpenClaw gateways (self-hosted, Railway wrapper, etc.).
 *
 * Transport: WebSocket RPC on the same host/port as the gateway's HTTP
 * interface. Protocol discovered by reading the Control UI's JS bundle on
 * a live 2026.3.x install — see docs/openclaw-api.md in M0 for the recon
 * writeup.
 *
 * Frame shapes:
 *   req:   { type: "req",   id, method, params }
 *   res:   { type: "res",   id, ok?, payload?, error? }
 *   event: { type: "event", event, payload, seq? }
 *
 * Handshake:
 *   1. Client opens WS (wrapper auto-adds Bearer on proxied upgrades;
 *      direct connections need the token in the Authorization header).
 *   2. Server pushes { type: "event", event: "connect.challenge",
 *                      payload: { nonce, ts } }.
 *   3. Client sends req/connect with protocol version and client info.
 *      The Control UI optionally adds a signed device attestation when
 *      crypto.subtle is available; for MVP we omit it.
 *   4. Server responds res/connect; client is now usable.
 */
export interface OpenClawAdapterOptions {
  /** Gateway URL. http(s):// — the adapter rewrites the scheme to ws(s). */
  gatewayUrl: string;
  /** Agent identifier to target. Defaults to "main". */
  agentId?: string;
  /**
   * Gateway token. Required, because the gateway's device-auth payload
   * includes it in the signed blob; omitting it is treated as an empty
   * string and the signature won't match.
   */
  token?: string;
  /** Client name advertised in the connect frame. Shows up in bot logs. */
  clientName?: string;
  /** How long to wait for the initial handshake to complete. */
  handshakeTimeoutMs?: number;
  /**
   * PEM-encoded PKCS8 Ed25519 private key for device attestation. The
   * matching public key must already be registered in the gateway's
   * paired.json (see scripts/pair-openclaw.ts). When omitted, the adapter
   * falls back to an unpaired connect — which currently fails `chat.send`
   * with "missing scope: operator.write".
   */
  devicePrivateKeyPem?: string;
}

type Frame =
  | { type: "req"; id: string; method: string; params: unknown }
  | {
      type: "res";
      id: string;
      ok?: boolean;
      payload?: unknown;
      error?: { code?: string; message?: string; details?: unknown };
    }
  | { type: "event"; event: string; payload?: unknown; seq?: number };

interface Pending {
  resolve: (payload: unknown) => void;
  reject: (err: Error) => void;
  events: BotEvent[];
  startedAt: number;
}

interface ActiveRun {
  runId: string;
  startedAt: number;
  events: BotEvent[];
  accumulatedText: string;
  resolve: (reply: BotReply) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

const CLIENT_ID = "openclaw-probe";
const CLIENT_MODE = "webchat";
const ROLE = "operator";
const DEFAULT_SCOPES = [
  "operator.admin",
  "operator.read",
  "operator.write",
  "operator.approvals",
  "operator.pairing",
] as const;
const PLATFORM = "node";
const DEVICE_FAMILY = "agentprobe";

export class OpenClawAdapter implements BotAdapter {
  public readonly name = "openclaw";

  private readonly wsUrl: string;
  private readonly token: string | undefined;
  private readonly agentId: string;
  private readonly clientName: string;
  private readonly handshakeTimeoutMs: number;
  private readonly deviceKey: DeviceKeyMaterial | undefined;

  private ws: WebSocket | undefined;
  private connected = false;
  private readonly pending = new Map<string, Pending>();
  private readonly activeRuns = new Map<string, ActiveRun>();
  private connectNonce: string | undefined;

  constructor(opts: OpenClawAdapterOptions) {
    this.wsUrl = toWsUrl(opts.gatewayUrl);
    this.token = opts.token;
    this.agentId = opts.agentId ?? "main";
    this.clientName = opts.clientName ?? "agentprobe";
    this.handshakeTimeoutMs = opts.handshakeTimeoutMs ?? 15_000;
    this.deviceKey = opts.devicePrivateKeyPem
      ? loadDeviceKey(opts.devicePrivateKeyPem)
      : undefined;
  }

  /** The device ID this adapter will present during handshake, if paired. */
  get deviceId(): string | undefined {
    return this.deviceKey?.deviceId;
  }

  async connect(): Promise<void> {
    if (this.connected) return;

    const headers: Record<string, string> = {};
    if (this.token) headers.Authorization = `Bearer ${this.token}`;

    this.ws = new WebSocket(this.wsUrl, { headers });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new BotAdapterError(
            `openclaw handshake timed out after ${this.handshakeTimeoutMs}ms`,
            "handshake_failed",
          ),
        );
        this.ws?.terminate();
      }, this.handshakeTimeoutMs);

      const ws = this.ws!;

      ws.once("error", (err: Error) => {
        clearTimeout(timer);
        reject(
          new BotAdapterError(
            `openclaw websocket error: ${err.message}`,
            "handshake_failed",
            err,
          ),
        );
      });

      ws.once("open", () => {
        // Wait for the challenge event before replying. The handleMessage
        // path below triggers the connect request once the nonce arrives.
      });

      ws.on("message", (raw) => {
        const frame = parseFrame(raw);
        if (!frame) return;

        // Handshake phase: watch for the challenge and the connect response.
        if (frame.type === "event" && frame.event === "connect.challenge") {
          const payload = frame.payload as { nonce?: string } | undefined;
          if (payload?.nonce) {
            this.connectNonce = payload.nonce;
            this.sendConnect().catch((err) => {
              clearTimeout(timer);
              reject(
                new BotAdapterError(
                  `failed to send connect frame: ${(err as Error).message}`,
                  "handshake_failed",
                  err,
                ),
              );
            });
          }
          return;
        }

        if (frame.type === "res") {
          this.routeResponse(frame, {
            onHandshakeDone: () => {
              clearTimeout(timer);
              this.connected = true;
              resolve();
            },
          });
          return;
        }

        if (frame.type === "event") {
          this.routeEvent(frame);
        }
      });

      ws.once("close", (code: number, reason: Buffer) => {
        const reasonText = reason?.toString?.() ?? "";
        if (!this.connected) {
          clearTimeout(timer);
          reject(
            new BotAdapterError(
              `openclaw websocket closed during handshake: ${code} ${reasonText}`,
              "handshake_failed",
              { code, reason: reasonText },
            ),
          );
        } else {
          this.connected = false;
          for (const pending of this.pending.values()) {
            pending.reject(
              new BotAdapterError(
                `websocket closed: ${code} ${reasonText}`,
                "gateway_error",
                { code, reason: reasonText },
              ),
            );
          }
          this.pending.clear();
        }
      });
    });
  }

  async sendMessage(opts: SendMessageOptions): Promise<BotReply> {
    if (!this.connected || !this.ws) {
      throw new BotAdapterError("openclaw adapter is not connected", "not_connected");
    }

    const sessionKey = opts.sessionKey ?? `agentprobe-${randomUUID()}`;
    const idempotencyKey = randomUUID();
    const timeoutMs = opts.timeoutMs ?? 60_000;

    const params = {
      sessionKey,
      message: opts.text,
      deliver: false,
      idempotencyKey,
      attachments: [] as unknown[],
    };

    // Three-phase wait:
    //   1. chat.send ack — res frame with { runId, status: "started" }
    //   2. chat event stream — broadcast events with payload.runId === runId,
    //      terminating on state "final" | "aborted" | "error"
    //   3. chat.history fetch — when deliver:false, the final event carries
    //      only metadata (no message body). The canonical way the Control UI
    //      gets the reply text is a chat.history call keyed by the canonical
    //      session key ("agent:<agentId>:<userSessionKey>"). We capture that
    //      from the lifecycle events and fetch after final.
    const ack = await this.request("chat.send", params, Math.min(timeoutMs, 15_000));
    const runId = extractRunId(ack.result);
    if (!runId) {
      return {
        text: extractReplyText(ack.result),
        responseTimeMs: ack.responseTimeMs,
        raw: ack.result,
        events: ack.events,
      };
    }

    const reply = await this.waitForRun(runId, timeoutMs);
    reply.events.unshift(...ack.events);

    // Prefer any text we already collected from stream deltas. If empty,
    // fetch the session history and extract the last assistant message.
    if (!reply.text) {
      const canonical = extractCanonicalSessionKey(reply.events);
      if (canonical) {
        try {
          const hist = await this.request(
            "chat.history",
            { sessionKey: canonical, limit: 20 },
            10_000,
          );
          const text = extractLastAssistantMessage(hist.result);
          if (text) {
            reply.text = text;
            reply.raw = { finalEvent: reply.raw, history: hist.result };
          }
        } catch {
          /* non-fatal: return what we have */
        }
      }
    }

    return reply;
  }

  private waitForRun(runId: string, timeoutMs: number): Promise<BotReply> {
    return new Promise<BotReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.activeRuns.delete(runId);
        reject(
          new BotAdapterError(
            `chat run ${runId} did not reach a terminal state within ${timeoutMs}ms`,
            "timeout",
          ),
        );
      }, timeoutMs);

      this.activeRuns.set(runId, {
        runId,
        startedAt: Date.now(),
        events: [],
        accumulatedText: "",
        resolve,
        reject,
        timer,
      });
    });
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    const ws = this.ws;
    if (!ws) return;
    await new Promise<void>((resolve) => {
      ws.once("close", () => resolve());
      try {
        ws.close(1000, "agentprobe shutdown");
      } catch {
        resolve();
      }
      setTimeout(() => resolve(), 1_000).unref?.();
    });
    this.ws = undefined;
  }

  // -------- internals --------

  private sendConnect(): Promise<unknown> {
    // Authentication flow:
    //
    // 1. Shared auth (token) is checked first. The Railway wrapper injects
    //    the Bearer header automatically on the WS upgrade; we also put the
    //    token inside the connect payload's auth field so the gateway can
    //    include it in the device-signature payload.
    //
    // 2. Device attestation is an Ed25519 signature over a canonical string
    //    containing deviceId, clientId, clientMode, role, scopes, timestamp,
    //    token, nonce, platform, deviceFamily — in that exact order, joined
    //    by "|", prefixed with "v3". See buildDeviceAuthPayloadV3.
    //
    // 3. The device's publicKey must already be in the gateway's paired.json
    //    with the scopes we're claiming here. Pairing is done once, out of
    //    band, by scripts/pair-openclaw.ts via SSH.
    //
    // Without step 3, `chat.send` fails with "missing scope: operator.write"
    // because clearUnboundScopes() wipes the scope set for unpaired clients.
    const nonce = this.connectNonce;
    if (!nonce) {
      throw new BotAdapterError(
        "no connect.challenge nonce received",
        "handshake_failed",
      );
    }

    const scopes = [...DEFAULT_SCOPES];
    const signedAtMs = Date.now();
    const token = this.token ?? "";

    let device: {
      id: string;
      publicKey: string;
      signature: string;
      signedAt: number;
      nonce: string;
    } | undefined;

    if (this.deviceKey) {
      const payload = buildDeviceAuthPayloadV3({
        deviceId: this.deviceKey.deviceId,
        clientId: CLIENT_ID,
        clientMode: CLIENT_MODE,
        role: ROLE,
        scopes,
        signedAtMs,
        token: token || null,
        nonce,
        platform: PLATFORM,
        deviceFamily: DEVICE_FAMILY,
      });
      const signature = signDeviceAuthPayload(
        this.deviceKey.privateKeyPem,
        payload,
      );
      device = {
        id: this.deviceKey.deviceId,
        publicKey: this.deviceKey.publicKeyRawBase64Url,
        signature,
        signedAt: signedAtMs,
        nonce,
      };
    }

    const params: Record<string, unknown> = {
      minProtocol: 3,
      maxProtocol: 3,
      client: {
        id: CLIENT_ID,
        version: "0.0.1",
        platform: PLATFORM,
        mode: CLIENT_MODE,
        instanceId: randomUUID(),
        deviceFamily: DEVICE_FAMILY,
      },
      role: ROLE,
      scopes,
      caps: ["tool-events"],
      userAgent: `agentprobe/${process.version}`,
      locale: "en-US",
    };
    if (device) params.device = device;
    if (this.token) params.auth = { token: this.token };

    return this.request("connect", params, this.handshakeTimeoutMs, {
      isHandshake: true,
    });
  }

  private request(
    method: string,
    params: unknown,
    timeoutMs: number,
    opts: { isHandshake?: boolean } = {},
  ): Promise<{ result: unknown; events: BotEvent[]; responseTimeMs: number }> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new BotAdapterError("websocket is not open", "not_connected"));
        return;
      }

      const id = randomUUID();
      const startedAt = Date.now();
      const events: BotEvent[] = [];

      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new BotAdapterError(
            `request ${method} timed out after ${timeoutMs}ms`,
            "timeout",
          ),
        );
      }, timeoutMs);

      this.pending.set(id, {
        startedAt,
        events,
        resolve: (payload) => {
          clearTimeout(timer);
          resolve({
            result: payload,
            events,
            responseTimeMs: Date.now() - startedAt,
          });
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });

      // Mark handshake pending so routeResponse can flip the connected flag
      // as soon as res/connect arrives.
      if (opts.isHandshake) {
        this.handshakeRequestId = id;
      }

      const frame = { type: "req", id, method, params };
      this.ws.send(JSON.stringify(frame));
    });
  }

  private handshakeRequestId: string | undefined;

  private routeResponse(
    frame: Extract<Frame, { type: "res" }>,
    hooks: { onHandshakeDone?: () => void } = {},
  ): void {
    const pending = this.pending.get(frame.id);
    if (!pending) return;
    this.pending.delete(frame.id);

    if (frame.error || frame.ok === false) {
      pending.reject(
        new BotAdapterError(
          `gateway error on ${frame.id}: ${frame.error?.message ?? "unknown"}`,
          "gateway_error",
          frame.error ?? frame.payload,
        ),
      );
      return;
    }

    pending.resolve(frame.payload ?? null);

    if (frame.id === this.handshakeRequestId) {
      this.handshakeRequestId = undefined;
      hooks.onHandshakeDone?.();
    }
  }

  private routeEvent(frame: Extract<Frame, { type: "event" }>): void {
    // chat events are broadcast with payload.runId identifying the run they
    // belong to. Find the active run and append the event; if the event is
    // a terminal state ("final"|"aborted"|"error"), resolve or reject the
    // waiting sendMessage promise.
    if (process.env.AGENTPROBE_DEBUG_EVENTS) {
      console.log(
        `[debug] event: ${frame.event} payload=${JSON.stringify(frame.payload)}`,
      );
    }

    const payload = (frame.payload ?? {}) as Record<string, unknown>;
    const runId = typeof payload.runId === "string" ? payload.runId : undefined;
    if (!runId) return;

    const run = this.activeRuns.get(runId);
    if (!run) return;

    const offsetMs = Date.now() - run.startedAt;
    run.events.push({ type: frame.event, payload: frame.payload, offsetMs });

    const state = typeof payload.state === "string" ? payload.state : "";
    const deltaText = extractDeltaText(payload);
    if (deltaText) run.accumulatedText += deltaText;

    if (state === "final") {
      clearTimeout(run.timer);
      this.activeRuns.delete(runId);
      const finalText = extractReplyText(payload.message) || run.accumulatedText;
      run.resolve({
        text: finalText,
        responseTimeMs: offsetMs,
        raw: payload,
        events: run.events,
      });
      return;
    }

    if (state === "aborted") {
      clearTimeout(run.timer);
      this.activeRuns.delete(runId);
      run.reject(
        new BotAdapterError(
          `chat run ${runId} was aborted`,
          "gateway_error",
          payload,
        ),
      );
      return;
    }

    if (state === "error") {
      clearTimeout(run.timer);
      this.activeRuns.delete(runId);
      run.reject(
        new BotAdapterError(
          `chat run ${runId} errored`,
          "gateway_error",
          payload,
        ),
      );
      return;
    }
  }
}

function extractRunId(payload: unknown): string | undefined {
  if (payload && typeof payload === "object") {
    const runId = (payload as Record<string, unknown>).runId;
    if (typeof runId === "string") return runId;
  }
  return undefined;
}

function extractCanonicalSessionKey(events: BotEvent[]): string | undefined {
  for (const ev of events) {
    if (!ev.payload || typeof ev.payload !== "object") continue;
    const sk = (ev.payload as Record<string, unknown>).sessionKey;
    if (typeof sk === "string" && sk.length > 0) return sk;
  }
  return undefined;
}

function extractLastAssistantMessage(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const obj = payload as Record<string, unknown>;
  const messages = obj.messages ?? obj.history ?? obj.entries;
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || typeof m !== "object") continue;
    const mObj = m as Record<string, unknown>;
    const role = mObj.role;
    if (role !== "assistant") continue;
    const content = mObj.content ?? mObj.text ?? mObj.message;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      // Content parts array (OpenAI-style). Concatenate text parts.
      const parts = content
        .map((p) => {
          if (typeof p === "string") return p;
          if (p && typeof p === "object") {
            const pp = p as Record<string, unknown>;
            if (typeof pp.text === "string") return pp.text;
          }
          return "";
        })
        .filter(Boolean);
      if (parts.length) return parts.join("");
    }
  }
  return "";
}

function extractDeltaText(payload: Record<string, unknown>): string {
  // Delta events carry incremental text. Try common field paths.
  const msg = payload.message;
  if (typeof msg === "string") return msg;
  if (msg && typeof msg === "object") {
    const m = msg as Record<string, unknown>;
    if (typeof m.delta === "string") return m.delta;
    if (typeof m.content === "string") return m.content;
    if (typeof m.text === "string") return m.text;
  }
  if (typeof payload.delta === "string") return payload.delta;
  if (typeof payload.text === "string") return payload.text;
  return "";
}

// -------- helpers --------

function toWsUrl(httpUrl: string): string {
  const u = new URL(httpUrl);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  if (!u.pathname || u.pathname === "/") u.pathname = "/";
  return u.toString();
}

function parseFrame(raw: RawData): Frame | undefined {
  try {
    const text = typeof raw === "string" ? raw : raw.toString("utf8");
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && typeof parsed.type === "string") {
      return parsed as Frame;
    }
  } catch {
    /* fall through */
  }
  return undefined;
}

function lastEntry(map: Map<string, Pending>): Pending | undefined {
  let last: Pending | undefined;
  for (const v of map.values()) last = v;
  return last;
}

/**
 * OpenClaw can respond with several shapes depending on the agent/plugin
 * stack: a plain { text }, an array of { role, content } messages, a
 * streamed stitched reply, etc. Extract the most likely "what the bot said"
 * without making strong shape assumptions.
 */
function extractReplyText(payload: unknown): string {
  if (!payload) return "";
  if (typeof payload === "string") return payload;
  if (typeof payload === "object") {
    const obj = payload as Record<string, unknown>;
    if (typeof obj.text === "string") return obj.text;
    if (typeof obj.content === "string") return obj.content;
    if (typeof obj.reply === "string") return obj.reply;
    if (obj.message && typeof obj.message === "object") {
      const msg = obj.message as Record<string, unknown>;
      if (typeof msg.content === "string") return msg.content;
      if (typeof msg.text === "string") return msg.text;
    }
    if (Array.isArray(obj.messages)) {
      const last = obj.messages[obj.messages.length - 1];
      if (last && typeof last === "object") {
        const m = last as Record<string, unknown>;
        if (typeof m.content === "string") return m.content;
        if (typeof m.text === "string") return m.text;
      }
    }
  }
  return "";
}
