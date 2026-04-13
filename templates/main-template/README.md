# Main Template

This is the golden template for setting up a customer-facing OpenClaw bot. Every bot you deploy for a client should start from this template.

## What's Inside

```
main-template/
+-- SOUL.md              # Complete persona, business flow, access control,
|                         # anti-hallucination rules, forwarder system,
|                         # and security directives.
+-- MEMORY.md            # Operational memory: security rules, phone number
|                         # limitation, pricing limitation, decision limitation,
|                         # contact role reference.
+-- IDENTITY.md          # First-time interaction flows for owners, customers,
|                         # and forwarders.
+-- HEARTBEAT.md         # Periodic check tasks: pending quotations, customer
|                         # follow-ups, forwarder response checks, cleanup.
+-- TOOLS.md             # Tool usage rules and when to use each AgentDB tool.
+-- AGENTS.md            # Agent configuration, channel notes, sub-agent rules.
+-- USER.md              # Owner's guide: what the bot does, common commands,
|                         # setup instructions.
+-- openclaw.json        # Golden config template with all required settings.
|
+-- plugins/
|   +-- agentdb/         # AgentDB plugin v3 — contacts, relay tracking, safety
|       +-- openclaw.plugin.json    # Plugin manifest
|       +-- package.json            # Dependencies (better-sqlite3)
|       +-- src/
|       |   +-- database.ts         # SQLite schema + all DB operations
|       |   +-- index.ts            # OpenClaw plugin API integration
|       +-- skills/
|           +-- agentdb/
|               +-- SKILL.md        # Behavioral rules the bot follows
|                                     (contact_lookup before send, relay
|                                     tracking, access level enforcement,
|                                     unknown sender blocking)
|
+-- skills/
|   +-- self-improving/  # Self-improving skill v1.2.16 — learning + memory
|       +-- SKILL.md                # Main skill definition
|       +-- _meta.json              # ClawHub metadata
|       +-- setup.md                # Installation guide
|       +-- memory.md               # Hot storage template
|       +-- memory-template.md      # Template for new memory files
|       +-- learning.md             # Learning signal mechanics
|       +-- corrections.md          # Correction log format
|       +-- reflections.md          # Self-reflection format
|       +-- boundaries.md           # Security boundaries
|       +-- scaling.md              # Scaling rules
|       +-- operations.md           # Memory operations
|       +-- heartbeat-rules.md      # Heartbeat integration
|       +-- heartbeat-state.md      # State tracking template
|       +-- HEARTBEAT.md            # Workspace heartbeat snippet
|       +-- openclaw-heartbeat.md   # OpenClaw-specific heartbeat seed
|
+-- workspace/
    +-- .learnings/
    |   +-- LEARNINGS.md
    |   +-- ERRORS.md
    |   +-- SECURITY_ALERTS.md
    |   +-- FEATURE_REQUESTS.md
    +-- memory/
    |   +-- heartbeat-state.json
    |   +-- sops.md
    +-- .config/
        +-- admin.env
```

## Placeholders

Replace these in every file before deploying:

| Placeholder | Example | Where Used |
|---|---|---|
| `{{AGENT_NAME}}` | "Aria" | SOUL, IDENTITY, AGENTS, USER |
| `{{BUSINESS_NAME}}` | "TechCorp Solutions" | SOUL, IDENTITY, MEMORY, USER |
| `{{BUSINESS_DESCRIPTION}}` | "We provide IT consulting and managed services." | SOUL |
| `{{BUSINESS_SHORT_PITCH}}` | "We help businesses with their IT needs." | IDENTITY |
| `{{OWNER_PHONE}}` | "+94771234567" | .config/admin.env |
| `{{OWNER_NAME}}` | "John" | .config/admin.env |
| `{{WORKSPACE_PATH}}` | "/root/.openclaw/workspace" | openclaw.json |
| `{{TIMEZONE}}` | "Asia/Colombo" | openclaw.json |
| `{{GEMINI_API_KEY}}` | "AIzaSy..." | openclaw.json |
| `{{TELEGRAM_BOT_TOKEN}}` | "8550082522:AAF..." | openclaw.json |
| `{{GATEWAY_TOKEN}}` | (auto-generated hex) | openclaw.json |
| `{{PLUGIN_PATH}}` | "/root/.openclaw/plugins" | openclaw.json |
| `{{SLA_HOURS}}` | "4" | workspace/memory/sops.md |

## Setup Steps

1. Copy this entire directory to the bot's server.
2. Replace all `{{PLACEHOLDERS}}` with the client's actual values.
3. Copy `plugins/agentdb/` to the bot's plugin path (e.g. `/root/.openclaw/plugins/agentdb/`).
4. Run `cd /path/to/plugins/agentdb && npm install` to install better-sqlite3.
5. Copy `skills/self-improving/` to the bot's skills directory or `~/self-improving/`.
6. Copy `workspace/` contents to the bot's workspace directory.
7. Copy the MD files (SOUL.md, MEMORY.md, etc.) to the bot's workspace root.
8. Copy `openclaw.json` to the bot's config path (after replacing placeholders).
9. Start the bot and message it as the owner to complete first-time setup.
10. Add the owner as the first admin contact in AgentDB.
11. Add the forwarder list contacts.
12. Configure the WhatsApp allowlist in openclaw.json with allowed numbers.
13. Run AgentProbe to verify everything is correct:
    ```
    npm run doctor     # Verifies config, schema, channels, plugins, skills
    npm run scenarios  # Verifies behavior: greetings, routing, safety, recall
    ```

## What AgentProbe Checks

After deploying this template, run:

```bash
npm run doctor     # Verifies config, schema, channels, plugins, skills
npm run scenarios  # Verifies behavior: greetings, routing, safety, recall
```

The doctor checks verify the STRUCTURE is correct (files present, config matches, plugins enabled). The scenarios verify the BEHAVIOR is correct (bot actually greets properly, refuses to share internals, calls contact_lookup before sending, etc.).
