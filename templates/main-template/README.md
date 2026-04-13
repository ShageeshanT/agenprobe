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

1. Copy this entire directory to the bot's workspace.
2. Replace all `{{PLACEHOLDERS}}` with the client's actual values.
3. Install the AgentDB plugin to the plugins path.
4. Install the self-improving skill.
5. Add the owner as the first admin contact in AgentDB.
6. Add the forwarder list contacts.
7. Configure the WhatsApp allowlist in openclaw.json.
8. Run AgentProbe's doctor + scenarios to verify everything is correct.

## What AgentProbe Checks

After deploying this template, run:

```bash
npm run doctor     # Verifies config, schema, channels, plugins, skills
npm run scenarios  # Verifies behavior: greetings, routing, safety, recall
```

The doctor checks verify the STRUCTURE is correct (files present, config matches, plugins enabled). The scenarios verify the BEHAVIOR is correct (bot actually greets properly, refuses to share internals, calls contact_lookup before sending, etc.).
