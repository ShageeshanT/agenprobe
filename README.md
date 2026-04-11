# AgentProbe

A QA / smoke-test harness for AI agent platforms.

AgentProbe lets you send messages to a bot built on OpenClaw or Hermes Agent
and assert on what the bot actually does — the reply, the latency, the tools
it called, the state it touched. Same test, any supported platform.

You point it at a bot, it runs a scenario, you get a report.

---

## Status

This is an MVP-0 working prototype. It is not production software.

What works today:

- **OpenClaw adapter** — connects to any self-hosted OpenClaw instance over
  its native WebSocket RPC, completes the device-attested handshake, sends a
  chat message, waits for the run to finish, returns the reply text.
- **Hermes adapter** — shells out to `hermes chat -q ... -Q --source tool`
  over `railway ssh`, captures the quiet-mode reply, maintains session
  continuity via Hermes's own session IDs.
- **Device pairing (OpenClaw)** — generate an Ed25519 keypair, register the
  public key in the gateway's paired-device store, authenticate subsequent
  connections with real device signatures.
- **Scenario engine** — YAML test scenarios with multi-step conversations,
  session continuity, seven assertion types, per-step timeouts, and
  severity levels (critical / warning / info). Scenarios are organised by
  platform: `scenarios/common/` runs against every adapter, while
  `scenarios/openclaw/` and `scenarios/hermes/` hold platform-specific
  tests for E.C.H.O. and Jarvis respectively.
- **CLI scenario runner** — `npm run scenarios` (OpenClaw) or
  `npx tsx scripts/run-scenario.ts scenarios --adapter hermes` runs the
  right suite for the chosen adapter and prints a readable pass/fail
  report. Exit code 0/1 so it drops straight into CI.
- **Web dashboard** — single-page UI at `http://localhost:4000` with an
  adapter picker in the topbar (OpenClaw / Hermes), live chat with session
  pinning, a scenario browser with one-click run and run-all, and
  per-assertion pass/fail display. Hermes is connected lazily on first use
  to avoid paying the SSH preflight cost when you're not using it.

What is not built yet:

- A proper CLI (`agentprobe init`, `agentprobe run`, etc.) — today's entry
  points are scripts under `scripts/`.
- Run history / report persistence (the Results tab still shows placeholders).
- Multi-profile / multi-environment configuration (one `.env` per install).
- Reporting exports (JUnit, HTML).
- Scenario authoring UI (you write YAML by hand for now).

The [Roadmap](#roadmap) section has the full picture.

---

## The idea in one paragraph

Testing agentic systems is hard because the interesting behaviour lives at the
seams: routing, tool calls, scheduled jobs, multi-actor conversations,
connector side-effects. Traditional test frameworks only see the final reply.
AgentProbe is a dedicated client that speaks each platform's real transport
(WebSocket RPC for OpenClaw, SSH shell-out for Hermes), impersonates a user,
captures every intermediate event the bot emits, and lets you write
assertions against any of it. The goal is one scenario file that runs
identically against every supported bot.

---

## How it works (high level)

```
┌─────────────────────┐
│  Your scenario      │   (YAML + assertions)
└──────────┬──────────┘
           │ sendMessage("hi", { sessionKey: "..." })
           ▼
┌─────────────────────┐
│  BotAdapter         │   Tiny common interface:
│  (generic)          │     connect / sendMessage / disconnect
└──────────┬──────────┘
           │ polymorphic dispatch
      ┌────┴────┐
      ▼         ▼
 ┌─────────┐ ┌─────────┐
 │OpenClaw │ │ Hermes  │
 │ WS RPC  │ │ SSH CLI │
 └─────────┘ └─────────┘
```

The `BotAdapter` interface is intentionally minimal — `connect`,
`sendMessage`, `disconnect`. Platform-specific capabilities (OpenClaw's
AgentDB, Hermes's memory/skills introspection, tool-call tracing, etc.)
live on the concrete adapters and are opt-in per scenario. We do not try
to force two very different platforms behind a fake-generic superclass.

For OpenClaw specifically, "sendMessage" is not a single HTTP POST. It's a
five-step dance with an Ed25519-signed handshake, a streamed event log, and
a follow-up history fetch. See
[OpenClaw integration deep dive](#openclaw-integration-deep-dive).

---

## Prerequisites

1. **Node.js ≥ 20.** Check with `node --version`.
2. **npm.** Ships with Node. `pnpm` and `yarn` also work if you prefer.
3. **Railway CLI** if your OpenClaw instance runs on Railway. Install with
   `npm i -g @railway/cli` and authenticate with `railway login`. Check with
   `railway whoami`.
4. **SSH access into the OpenClaw container.** For Railway that's the
   `railway ssh --project=... --environment=... --service=...` command you
   already have. For a bare-metal OpenClaw install, plain `ssh user@host`
   works — the pairing step just needs a way to write a file inside the
   container.

---

## Setup

Clone (or download) the project and install dependencies:

```bash
cd AgenProbe
npm install
```

Create a `.env` by copying the example:

```bash
cp .env.example .env
```

Fill in the values in `.env`. The five that matter are:

```bash
# Public URL of the OpenClaw gateway. For Railway this is the
# RAILWAY_PUBLIC_DOMAIN (visible in the container env). For bare-metal
# installs it's whatever host:port your reverse proxy serves.
OPENCLAW_GATEWAY_URL=https://<your-bot>.up.railway.app

# The gateway's auth token. Live inside the container at
# /data/.openclaw/openclaw.json → auth.token. See "Discovering the token"
# below for a one-liner to read it.
OPENCLAW_GATEWAY_TOKEN=<hex-token-from-openclaw.json>

# Which agent to talk to. Default OpenClaw installs use "main".
OPENCLAW_AGENT_ID=main

# Railway coordinates — only needed for scripts/pair-openclaw.ts. Pulled
# directly from the SSH command your Railway dashboard gives you.
RAILWAY_PROJECT=<uuid>
RAILWAY_ENVIRONMENT=<uuid>
RAILWAY_SERVICE=<uuid>
```

### Discovering the token

If you don't know the token, fetch it directly from the container in one call:

```bash
railway ssh --project=<uuid> --environment=<uuid> --service=<uuid> \
  'node -e "console.log(JSON.parse(require(\"fs\").readFileSync(\"/data/.openclaw/openclaw.json\",\"utf8\")).gateway.auth.token)"'
```

### Discovering the public URL

Same trick, for the gateway URL:

```bash
railway ssh --project=<uuid> --environment=<uuid> --service=<uuid> \
  'echo $RAILWAY_PUBLIC_DOMAIN'
```

The value it prints is the host; add `https://` in front when setting
`OPENCLAW_GATEWAY_URL`.

---

## One-time pairing

OpenClaw requires every client to be a *paired device* — it identifies clients
by an Ed25519 public key, not just by token. Without pairing, the gateway
wipes your scope list during the handshake and `chat.send` fails with
`missing scope: operator.write`.

Pairing is a one-time setup per OpenClaw instance:

1. Generate a keypair locally (stored in `.agentprobe-keys/`, gitignored,
   permanent).
2. Compute the device ID (`sha256hex(rawPublicKey)`).
3. Write the public key plus full operator scopes into the gateway's
   `/data/.openclaw/devices/paired.json`.

The intended command is:

```bash
npx tsx scripts/pair-openclaw.ts
```

This generates the key if it doesn't exist, and merges a device record into
`paired.json` over `railway ssh`.

**Known bug:** on Windows, that script's `railway ssh` invocation hits a
shell-quoting issue when the embedded remote Node script gets re-quoted by
`cmd.exe`. Until that's fixed, use this manual one-liner instead. Replace
`<deviceId>` and `<publicKey>` with the values computed by the script (it
prints them before it fails), and replace the Railway UUIDs with yours:

```bash
DEVICE_JSON='{"deviceId":"<deviceId>","publicKey":"<publicKey>","platform":"node","clientId":"openclaw-probe","clientMode":"webchat","role":"operator","roles":["operator"],"scopes":["operator.admin","operator.read","operator.write","operator.approvals","operator.pairing"],"deviceFamily":"agentprobe","name":"agentprobe"}'
B64=$(echo -n "$DEVICE_JSON" | base64 -w0)
railway ssh --project=<uuid> --environment=<uuid> --service=<uuid> \
  "echo $B64 | base64 -d > /tmp/agentprobe-device.json && node -e 'const fs=require(\"fs\");const p=\"/data/.openclaw/devices/paired.json\";let o={};try{o=JSON.parse(fs.readFileSync(p,\"utf8\"));}catch{}const d=JSON.parse(fs.readFileSync(\"/tmp/agentprobe-device.json\",\"utf8\"));o[d.deviceId]=d;fs.writeFileSync(p,JSON.stringify(o,null,2));console.log(\"paired count:\",Object.keys(o).length);'"
```

You should see `paired count: N` where N includes your new device.

To compute the `deviceId` and `publicKey` without running the full script:

```bash
node -e "
const {createPrivateKey,createPublicKey,createHash}=require('node:crypto');
const {readFileSync}=require('node:fs');
const pem=readFileSync('.agentprobe-keys/openclaw-ed25519.pem','utf8');
const pub=createPublicKey(createPrivateKey(pem));
const raw=pub.export({format:'der',type:'spki'}).subarray(12);
console.log(JSON.stringify({
  deviceId: createHash('sha256').update(raw).digest('hex'),
  publicKey: raw.toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')
}));
"
```

### Verifying the pairing is in place

```bash
railway ssh --project=<uuid> --environment=<uuid> --service=<uuid> \
  "node -e 'const d=JSON.parse(require(\"fs\").readFileSync(\"/data/.openclaw/devices/paired.json\",\"utf8\"));console.log(Object.keys(d).length+\" devices:\");for(const k of Object.keys(d)){console.log(\"  \"+k.slice(0,16)+\"...\\t\"+d[k].clientId+\"\\t\"+(d[k].scopes||[]).join(\",\"))}'"
```

Look for an entry with `clientId = openclaw-probe` and scopes that include
`operator.write`.

---

## Running the smoke test

With `.env` filled in and the device paired, this is the whole UX:

```bash
npm run smoke
```

That sends a default `"ping from agentprobe smoke test"` message and prints:

```
-> connecting to https://<your-bot>.up.railway.app ...
-> handshake ok
-> sending: "ping from agentprobe smoke test"
-> reply (2879ms):
<the bot's actual reply>
-> 3 intermediate events:
   [233ms]  agent   lifecycle.start
   [2876ms] agent   lifecycle.end
   [2879ms] chat    state=final
-> raw final payload:
{ ... }
```

Four things to glance at, in order:

1. `handshake ok` — WebSocket connected and pairing accepted.
2. `reply (Nms):` followed by non-empty text — the bot actually replied.
3. The intermediate event count — lifecycle, tool calls, and chat state
   transitions get logged here.
4. `raw final payload` — for when you want to debug what the gateway said.

To send a custom message, pass it as the argument:

```bash
npx tsx scripts/smoke-openclaw.ts "what time is it?"
npx tsx scripts/smoke-openclaw.ts "list the tools you have access to"
npx tsx scripts/smoke-openclaw.ts "what is in your SOUL.md file?"
```

Multi-word messages must be quoted.

### Debug mode

Set `AGENTPROBE_DEBUG_EVENTS=1` to log every WebSocket event the gateway
sends, even ones the adapter would normally ignore. Useful when a reply is
empty, a run hangs, or you're reverse-engineering a new event type.

```bash
AGENTPROBE_DEBUG_EVENTS=1 npx tsx scripts/smoke-openclaw.ts "your message"
```

### Probes worth running

These are good for verifying your bot is actually healthy, not just that the
transport works:

```bash
# Does the bot know itself?
npx tsx scripts/smoke-openclaw.ts "who are you and what's your agent id?"

# Does it have real-world awareness?
npx tsx scripts/smoke-openclaw.ts "what is today's date?"

# Does it have tool access?
npx tsx scripts/smoke-openclaw.ts "list the tools you have available"

# Does it know its own identity file?
npx tsx scripts/smoke-openclaw.ts "summarize your SOUL.md in one sentence"
```

Note that each smoke run uses a fresh session, so the bot will **not**
remember across invocations. For session continuity across turns use a
[scenario](#scenarios-and-the-cli-runner) with `session: shared`.

---

## Scenarios and the CLI runner

A scenario is a YAML file that describes a multi-step conversation with
assertions against the bot's replies. Example:

```yaml
name: identity-check
description: Bot knows its own name and remembers context across turns.
defaultTimeoutMs: 30000
session: shared           # shared | per-step (default: shared)

steps:
  - name: Ask who it is
    send: "who are you? respond in one short sentence."
    assertions:
      - type: response_is_non_empty
        severity: critical
      - type: response_not_contains
        value: "undefined"
        caseInsensitive: true
        severity: critical

  - name: Session continuity check
    send: "what was the first thing I asked you?"
    assertions:
      - type: response_is_non_empty
        severity: critical
      - type: response_not_contains
        value: "I don't know"
        caseInsensitive: true
        severity: warning
```

### Running scenarios

```bash
# Run every *.yaml / *.yml in ./scenarios/
npm run scenarios

# Run one specific scenario file
npm run scenario scenarios/02-identity-check.yaml

# Run a scenario directory other than ./scenarios/
npx tsx scripts/run-scenario.ts ./my-scenarios/
```

Exit codes:

- `0` — every scenario passed (criticals only; warnings do not fail).
- `1` — one or more scenarios had critical failures or a runtime error.
- `2` — configuration or YAML load error before any scenario could run.

Example output:

```
========================================================================
identity-check
  Bot knows its own name/identity and doesn't leak internal placeholders.
========================================================================
  [PASS] Ask who it is  (5918ms, 3 events)
       send:  who are you? respond in one short sentence.
       reply: I am E.C.H.O., your personal AI assistant...
         [ ok ] reply is non-empty
         [ ok ] reply correctly does not contain "undefined"
  [PASS] Follow-up — session continuity  (3219ms, 3 events)
       send:  what was the first thing I asked you?
       reply: You asked me "who are you? respond in one short sentence."
         [ ok ] reply is non-empty
         [ ok ] reply correctly does not contain "I don't know"
```

### Assertion catalog

| Type | Fields | Purpose |
|---|---|---|
| `response_contains` | `value`, `caseInsensitive?` | Reply must contain the substring. |
| `response_not_contains` | `value`, `caseInsensitive?` | Reply must NOT contain the substring. Great for catching placeholder leaks (`undefined`, `{{`, `null`). |
| `response_matches` | `pattern`, `flags?` | Reply must match a regex. |
| `response_time_under` | `valueMs` | End-to-end latency must be under N milliseconds. |
| `response_time_over` | `valueMs` | Latency must be over N ms (for "the bot should actually think, not echo"). |
| `response_is_non_empty` | (none) | Reply must have non-whitespace content. |
| `response_is_empty` | (none) | Reply must be empty (rare, but useful for no-op instructions). |

Every assertion accepts:

- `severity`: `critical` (default), `warning`, or `info`. Only critical
  failures fail the scenario.
- `description`: human-readable note shown in reports.

### Authoring tips

- **YAML regex escaping.** Use single quotes (`'...'`) for patterns — they
  don't process backslash escapes, so `'^\s*OK\s*$'` is a real regex with
  one backslash per escape. Double-quoted strings eat a backslash level and
  turn `"\\s"` into `\s`, which is correct but easy to get wrong.
- **Session continuity** is on by default. Set `session: per-step` if each
  step must run in isolation (e.g. testing strict output formats, where
  conversation history would muddy the result).
- **Critical vs. warning.** A failing critical assertion fails your CI; a
  warning is logged but does not. Use warnings for soft preferences and
  latency SLOs where an occasional miss is acceptable.
- **Starter scenarios** live in `scenarios/` — `basic-ping`,
  `identity-check`, `tool-awareness`, `format-compliance`. Copy one as a
  starting point.

---

## Web dashboard

```bash
npm run web
# → AgentProbe dashboard running at http://localhost:4000
```

Open `http://localhost:4000` in a browser. The dashboard has two panels:

### Live chat (left)

- Type a message, hit enter, see the bot's reply with total response time
  and the full list of intermediate events (lifecycle phases, tool calls,
  chat state transitions) with their timings.
- **Pin session across messages** — tick the checkbox to use one session
  key for every subsequent send, so the bot remembers context. Unticking
  clears the pinned session.
- **Clear** wipes the log and unpins the session.

### Scenario runner (right)

- All YAML files from `scenarios/` are loaded at page open.
- Each card shows the scenario name, description, and metadata (step count,
  assertion count, session mode).
- **Run** executes one scenario against the live bot and shows a
  verdict (`PASS` / `PASS (warnings)` / `FAIL`), total duration, and every
  step's assertions inline.
- **Run all** runs every scenario sequentially.

### HTTP API (for your own tools)

The web server also exposes a tiny JSON API on the same port, if you want
to drive it from scripts or other tools:

| Endpoint | Description |
|---|---|
| `GET /api/status` | Connection state, gateway URL, agent id. |
| `POST /api/chat` | Body: `{ text, sessionKey? }`. Returns reply + events. |
| `GET /api/scenarios` | List all scenarios with metadata. |
| `POST /api/scenarios/:name` | Run one scenario by name. Returns full result. |
| `POST /api/scenarios` | Run every scenario. Returns `{ passed, total, results }`. |

The server holds a single long-lived OpenClaw connection, so requests do
not pay the handshake cost each time.

### Environment

The server reads the same `.env` as the CLI scripts:
`OPENCLAW_GATEWAY_URL`, `OPENCLAW_GATEWAY_TOKEN`, `OPENCLAW_AGENT_ID`, plus
the pairing key at `.agentprobe-keys/openclaw-ed25519.pem`. Override the
port with `PORT=8080 npm run web`.

---

## OpenClaw integration deep dive

This section exists so future you (or anyone else debugging this) can answer
"why does the adapter work this way" without re-reading the OpenClaw source.

### Transport

The OpenClaw gateway speaks two protocols on the same host:port:

- **HTTP** for health checks (`/healthz`, `/health`), the Control UI bundle
  (`/openclaw`), channel webhooks (`/hooks/whatsapp`, `/hooks/telegram`), and
  `POST /tools/invoke` for direct tool invocation.
- **WebSocket RPC** for everything else, including chat. This is what the
  Control UI uses and what AgentProbe targets.

The public docs at `docs.openclaw.ai` mention OpenAI-compatible endpoints at
`/v1/chat/completions` and `/v1/responses`. **These do not exist on real
current installs.** Those docs are aspirational or out of date. I confirmed
this on OpenClaw 2026.3.13 by direct probing — those routes return 404 even
from localhost with the correct token. Don't rely on them.

### Frame format

WebSocket frames are JSON objects with a `type` discriminator:

```ts
// Client → server: a request.
{ type: "req", id: "<uuid>", method: "<name>", params: { ... } }

// Server → client: a response to a specific request id.
{ type: "res", id: "<uuid>", ok?: boolean, payload?: unknown, error?: { ... } }

// Server → client: a broadcast event (no id, but typically includes runId
// in the payload for chat events).
{ type: "event", event: "<name>", payload: { ... }, seq?: number }
```

Requests use a UUIDv4 as the id; responses are correlated by matching id.
Events are broadcast — the adapter routes them to active runs by inspecting
`payload.runId`.

### Handshake

```
Client              Gateway
  │ connect (WS)       │
  ├───────────────────>│
  │                    │
  │ event/connect.challenge { nonce, ts }
  │<───────────────────┤
  │                    │
  │ req/connect {      │
  │   minProtocol: 3,  │
  │   maxProtocol: 3,  │
  │   client: {...},   │
  │   role: "operator",│
  │   scopes: [...],   │
  │   device: {        │
  │     id, publicKey, │
  │     signature,     │
  │     signedAt,      │
  │     nonce          │
  │   },               │
  │   auth: { token }  │
  │ }                  │
  ├───────────────────>│
  │                    │
  │ res/connect (ok)   │
  │<───────────────────┤
  │                    │
  │ ... ready to send requests ...
```

Key facts discovered during implementation:

- `client.id` and `client.mode` are both whitelisted enums. Valid `client.id`
  values include `openclaw-control-ui`, `cli`, `test`, `openclaw-probe`,
  `gateway-client`, and others. AgentProbe uses `openclaw-probe`
  (literally the constant OpenClaw defined for this use case).
- Claiming to be `openclaw-control-ui` triggers stricter device-identity
  rules — specifically the `control-ui-requires-device-identity` check that
  demands either localhost or a browser secure context. **Do not impersonate
  the Control UI.**
- `role: "operator"` is the only meaningful value for chat. The other allowed
  value is `"node"`, used for OpenClaw's internal inter-node RPC.

### Device attestation (Ed25519)

Every non-trivial request requires a paired device. The gateway stores each
paired device's public key in `/data/.openclaw/devices/paired.json`, keyed by
device ID. Device ID is computed as:

```
deviceId = sha256hex(rawEd25519PublicKey)
```

The signed payload the client sends is a pipe-delimited string — field order
and exact values matter. Schema v3, matching OpenClaw's
`buildDeviceAuthPayloadV3`:

```
v3|<deviceId>|<clientId>|<clientMode>|<role>|<scopes joined by ",">|<signedAtMs>|<token>|<nonce>|<platform>|<deviceFamily>
```

`platform` and `deviceFamily` are lowercased ASCII-normalized (trim then
`[A-Z]` → `[a-z]`). `token` is the gateway shared-auth token; if absent the
field is literally an empty string between the two pipes. `nonce` is the
value the gateway sent in `connect.challenge`.

The signature is `Ed25519(privateKey, UTF-8 bytes of that payload)`,
base64url-encoded (no padding). Node's `crypto.sign(null, buf, privateKey)`
on an Ed25519 key produces the correct bytes directly.

The Ed25519 SPKI DER for the public key is 44 bytes: a 12-byte constant prefix
`0x30 0x2a 0x30 0x05 0x06 0x03 0x2b 0x65 0x70 0x03 0x21 0x00` followed by the
32-byte raw public key. AgentProbe strips that prefix to produce the raw
bytes the gateway expects in the device record.

All of this lives in `src/adapters/openclaw-device-auth.ts`.

### Scope bypass

The handshake runs `evaluateMissingDeviceIdentity(...)`, which clears the
client's scope list unless specific conditions hold. For unpaired clients,
scopes are always cleared — which is why `chat.send` rejects with
`missing scope: operator.write`. Pairing a device and presenting a valid
signature is the only clean path to keeping scopes. AgentProbe advertises
all five operator scopes in the connect frame (`operator.admin`,
`operator.read`, `operator.write`, `operator.approvals`, `operator.pairing`),
and admin is a global bypass in `authorizeGatewayMethod`, so as long as the
signature validates you can call anything.

### chat.send lifecycle

```
Client                              Gateway
  │ req/chat.send { sessionKey,        │
  │   message, deliver: false,         │
  │   idempotencyKey, attachments }    │
  ├────────────────────────────────────>│
  │                                    │
  │ res/chat.send { runId, status }    │
  │<───────────────────────────────────┤   (ack — does NOT carry the reply)
  │                                    │
  │ event/agent { runId, stream:       │
  │   "lifecycle", data: {             │
  │     phase: "start" } }             │
  │<───────────────────────────────────┤
  │                                    │
  │   (bot thinks, calls tools, ...)   │
  │                                    │
  │ event/agent { runId, stream:       │
  │   "lifecycle", data: {             │
  │     phase: "end" } }               │
  │<───────────────────────────────────┤
  │                                    │
  │ event/chat { runId, state:         │
  │   "final" }                        │
  │<───────────────────────────────────┤
  │                                    │
  │ req/chat.history { sessionKey,     │   (!) the reply text is NOT in any
  │   limit }                          │       of the events above when
  ├────────────────────────────────────>│       deliver:false. We fetch
  │                                    │       it from history afterwards.
  │ res/chat.history { messages: [     │
  │   ..., { role: "assistant",        │
  │   content: [ { type: "text",       │
  │   text: "..." } ] } ] }            │
  │<───────────────────────────────────┤
```

Two things that surprised me during implementation:

1. **`res/chat.send` does not carry the reply.** It's a synchronous ack with
   `{ runId, status: "started" }`. You wait on the event stream for
   `state === "final"` to know the run is done.
2. **The final event does not carry the reply either.** When the client
   passes `deliver: false` (which is what the Control UI does, and what
   AgentProbe does), the gateway writes the reply to the session transcript
   and emits a terse `{ runId, sessionKey, seq, state: "final" }` event. To
   read the actual text you call `chat.history` with the canonical session
   key (the one on the events — `agent:<agentId>:<userSessionKey>`, not the
   short key you sent) and pull the last `role: "assistant"` message.
3. The assistant message has OpenAI-style content parts: an array of
   `{ type: "thinking", thinking: "..." }` (internal reasoning) and
   `{ type: "text", text: "..." }` (what the user sees). AgentProbe extracts
   the text parts and joins them.

Terminal states:

| State | Meaning | Adapter behaviour |
|---|---|---|
| `final` | Normal completion. | Resolve with reply text. |
| `aborted` | User or system cancelled. | Reject with `gateway_error`. |
| `error` | Run failed. | Reject with `gateway_error`. |

### Why the Railway wrapper matters

OpenClaw on Railway runs behind a thin Node wrapper
(`openclaw-railway-template`) that does three things:

1. Provides a `/setup` wizard and an on-boot `openclaw doctor --fix` pass.
2. Spawns the real gateway as a subprocess bound to loopback only
   (`--bind loopback --port 18789`).
3. Proxies every non-setup HTTP/WS request to the gateway, **auto-injecting
   the Bearer Authorization header**:
   ```js
   proxyReq.setHeader("Authorization", `Bearer ${OPENCLAW_GATEWAY_TOKEN}`);
   ```
   …except for `/hooks/*`, where real channel webhooks bring their own auth.

The net effect for AgentProbe: when you hit the public Railway URL, you don't
need to send any Authorization header yourself — the wrapper adds it before
forwarding. AgentProbe's adapter still sends the token **inside** the connect
payload (`params.auth.token`) because the token is also part of the signed
device-auth payload.

For a non-Railway OpenClaw install (bare-metal, docker compose, etc.) you're
talking to the gateway directly — there's no wrapper — and you must send the
Bearer header yourself on the WebSocket upgrade. The adapter already does
this when `OPENCLAW_GATEWAY_TOKEN` is set.

---

## Project structure

```
AgenProbe/
├── README.md                            — this file
├── package.json                         — dependencies, npm scripts
├── tsconfig.json                        — strict TS with exactOptionalPropertyTypes
├── .env                                 — your secrets, never committed
├── .env.example                         — template
├── .gitignore
├── .agentprobe-keys/
│   └── openclaw-ed25519.pem             — your pairing private key (never commit)
│
├── scenarios/                           — YAML test scenarios
│   ├── 01-basic-ping.yaml
│   ├── 02-identity-check.yaml
│   ├── 03-tool-awareness.yaml
│   └── 04-format-compliance.yaml
│
├── src/
│   ├── core/
│   │   ├── bot-adapter.ts               — BotAdapter interface, BotReply,
│   │   │                                   BotEvent, BotAdapterError
│   │   ├── scenario.ts                  — Scenario / Step / Assertion types
│   │   ├── assertions.ts                — evaluate + summarize assertions
│   │   ├── scenario-runner.ts           — executes a Scenario against an adapter
│   │   └── scenario-loader.ts           — YAML parser + shape validation
│   ├── adapters/
│   │   ├── openclaw-adapter.ts          — WebSocket client, handshake,
│   │   │                                   chat.send lifecycle, history fetch
│   │   └── openclaw-device-auth.ts      — Ed25519 key gen/load, payload
│   │                                      builder, signer, deviceId derivation
│   └── web/
│       ├── server.ts                    — Express server, JSON API
│       └── public/
│           └── index.html               — single-file dashboard UI
│
└── scripts/
    ├── pair-openclaw.ts                 — generate key, inject device record
    │                                      (Windows quoting bug — see Setup)
    ├── smoke-openclaw.ts                — end-to-end probe, the main UX
    ├── run-scenario.ts                  — CLI scenario runner
    └── run-web.ts                       — web dashboard entry point
```

### npm scripts

| Command | What it does |
|---|---|
| `npm run smoke` | Send one message (default or CLI arg) to the bot, print reply. |
| `npm run scenario <file>` | Run a single scenario YAML file. |
| `npm run scenarios` | Run every scenario in `./scenarios/`. Exits 0/1/2 for CI. |
| `npm run web` | Start the dashboard on `http://localhost:4000`. |
| `npm run typecheck` | TypeScript strict typecheck, no emit. |
| `npm run build` | Compile TypeScript to `dist/`. |

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `handshake failed: ... invalid connect params` | OpenClaw version changed the `client.id` / `client.mode` enum, or you edited the payload. | Grep the new SPA bundle for the enum values; update `CLIENT_ID` / `CLIENT_MODE` constants in `openclaw-adapter.ts`. |
| `handshake failed: ... device identity required` | Pairing is gone (`paired.json` wiped) or the gateway token in `openclaw.json` rotated, invalidating the signature. | Re-run pairing. If the token rotated, update `OPENCLAW_GATEWAY_TOKEN` in `.env` first. |
| `missing scope: operator.write` | Device is paired but without write scope. | Re-run pairing — the current injector writes all five operator scopes. |
| `chat run ... did not reach a terminal state within 60000ms` | Bot is thinking too long, stuck on a tool call, or the model provider is down. | Bump `timeoutMs` in `sendMessage` options, and check the OpenClaw server log: `railway ssh ... 'tail -200 /data/.openclaw/server.log'`. |
| Reply text is empty but events arrived | New OpenClaw version changed the event payload shape or the `chat.history` response shape. | Run with `AGENTPROBE_DEBUG_EVENTS=1` and inspect the raw payloads. Update `extractLastAssistantMessage` / `extractReplyText` to match. |
| `ECONNREFUSED` or `ENOTFOUND` | Railway service asleep (free tier), URL typo, or network. | Visit the public URL in a browser to wake the service, double-check `OPENCLAW_GATEWAY_URL`, retry. |
| `railway: command not found` when running the pair script | Railway CLI not installed or not on `PATH`. | `npm i -g @railway/cli && railway login`. |
| Pair script crashes on Windows with shell-quoting errors | Known bug — see Setup. | Use the manual `DEVICE_JSON` / `base64` one-liner instead. |

---

## Security notes

- **`.env` contains secrets.** Gateway token, Railway coordinates, anything
  else you add. It is gitignored. Do not commit it and do not paste it into
  screenshots or bug reports.
- **`.agentprobe-keys/openclaw-ed25519.pem` is equivalent to an SSH private
  key for your bot.** Anyone with this file can reach your OpenClaw gateway
  at full operator scope — list sessions, read chat history, invoke tools.
  Treat it accordingly. It is gitignored.
- **The OpenClaw config file on the container
  (`/data/.openclaw/openclaw.json`) itself contains secrets** — gateway
  token, model provider API keys, connector credentials. Read it carefully
  when discovering the token and do not copy the whole file anywhere.
- **Token rotation breaks pairing signatures**, because the token is part of
  the signed connect payload. If your gateway auto-rotates tokens, you need
  to re-read the token and reconnect; a future adapter improvement is to
  detect signature-mismatch errors and refresh the token automatically.
- **Pairing inserts AgentProbe into the gateway's trusted-device list.**
  This means every future connection from anywhere using that private key is
  accepted as a full operator. If the key is lost or rotated, remove the
  corresponding `deviceId` from `paired.json` on the container.

---

## Roadmap

### Next

- **Run history / persistent reports.** Save every `npm run scenarios`
  run to `reports/<timestamp>-<adapter>.json` and wire the dashboard's
  Results tab to real aggregate data (pass rate over time, average
  latency, which scenarios are flakiest). Closes the loop on the
  placeholders currently shown there.
- **Single-command `agentprobe init openclaw "<railway ssh command>"`**
  — parse SSH command, discover URL/token/agent ID, generate key, pair,
  write `.env`, run smoke test. One command from a fresh OpenClaw
  instance to a working test harness.
- **Fix the Windows shell-quoting bug in `scripts/pair-openclaw.ts`** so
  the pairing flow doesn't need the manual base64 workaround documented
  in Setup.

### Later

- Scenario templates for common bot shapes (lead nurturing, customer
  support, appointment booking).
- Report export: JUnit XML for CI, HTML for humans.
- Adversarial scenarios beyond the current four (role confusion, data
  extraction via nested instructions, prompt injection in tool outputs).
- AI-driven virtual users: Claude API personas that react to the bot's
  replies instead of following a scripted turn list.
- Platform-specific extensions:
  - OpenClaw: AgentDB assertions (contact created, score updated, custom
    table writes), cron-job injection for time-travel testing, tool-call
    tracing.
  - Hermes: memory / skill introspection, session history assertions.
- Connector proxy: intercept and mock Composio calls to test
  Gmail/Sheets/Calendar integrations without touching real accounts.
- Multi-profile support (`environments/<name>.yaml`) so you can test more
  than one bot of each platform from a single install.

### Deferred indefinitely

- Live passthrough (injecting tagged test messages into real production
  WhatsApp/Telegram channels). Different product, different risk profile.
- A hosted SaaS version of AgentProbe. Not interesting until the CLI
  version is solid.

---

## References

- **OpenClaw docs:** <https://docs.openclaw.ai/> — mostly useful for concepts;
  the API details are partially out of date, as noted above.
- **OpenClaw Railway template:**
  <https://github.com/codetitlan/openclaw-railway-template> — the wrapper
  that sits in front of the gateway on Railway.
- **Hermes Agent:** <https://github.com/NousResearch/hermes-agent> and
  <https://hermes-agent.nousresearch.com/docs/>.
- **Ed25519 in Node:** <https://nodejs.org/api/crypto.html> — see
  `generateKeyPairSync("ed25519")` and `sign(null, data, key)` for the exact
  APIs AgentProbe uses.

---

## License

This is an internal/personal project. No license is granted; treat it as
source-available but not open source until that changes.
