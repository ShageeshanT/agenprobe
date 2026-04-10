/**
 * The minimum contract every bot adapter implements.
 *
 * Intentionally small: OpenClaw, Hermes, and n8n are three very different
 * platforms, and this interface is the lowest common denominator across them.
 * Platform-specific capabilities (AgentDB reads, workflow-execution inspection,
 * tool call tracing, etc.) live on the concrete adapter classes and scenarios
 * opt into them via type narrowing, not via a fake-generic superclass.
 */
export interface BotAdapter {
  /** Human-readable name for logs and reports. */
  readonly name: string;

  /** Open the underlying transport and perform any handshake. */
  connect(): Promise<void>;

  /** Send one user message and wait for the bot's reply. */
  sendMessage(opts: SendMessageOptions): Promise<BotReply>;

  /** Close the underlying transport cleanly. */
  disconnect(): Promise<void>;
}

export interface SendMessageOptions {
  /** The user's message text. */
  text: string;

  /**
   * Optional conversation/session scope. When omitted, the adapter generates
   * a fresh session per message — effectively a stateless probe. Pass an
   * explicit value to carry context across multiple `sendMessage` calls.
   */
  sessionKey?: string;

  /** How long to wait for the reply before failing. Default: 60s. */
  timeoutMs?: number;
}

export interface BotReply {
  /** The bot's final textual reply. */
  text: string;

  /** Wall-clock time from request sent to final response received. */
  responseTimeMs: number;

  /** The raw protocol payload of the final response frame, for debugging. */
  raw: unknown;

  /**
   * Intermediate events the bot emitted while producing the reply
   * (tool calls, streaming tokens, routing decisions, etc.).
   * Shape is adapter-specific.
   */
  events: BotEvent[];
}

export interface BotEvent {
  /** Adapter-scoped event name, e.g. "chat.token", "tool.called". */
  type: string;
  /** Raw payload. Shape depends on the adapter and the event type. */
  payload: unknown;
  /** ms since the triggering request was sent. */
  offsetMs: number;
}

export class BotAdapterError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "not_connected"
      | "handshake_failed"
      | "timeout"
      | "protocol_error"
      | "gateway_error",
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "BotAdapterError";
  }
}
