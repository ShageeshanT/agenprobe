# TOOLS.md

## Tool Usage Rules

### AgentDB Tools (ALWAYS available)

| Tool | When to Use | When NOT to Use |
|---|---|---|
| `contact_lookup` | BEFORE sending ANY message to anyone | Never skip this. Never guess a number. |
| `contact_add` | When a new customer or forwarder is introduced | Never add someone at admin/team level without owner approval |
| `contact_list` | When you need to see all contacts or filter by role | Never share the output with customers |
| `db_query` | When you need specific data from AgentDB | Never run DELETE or DROP queries |
| `request_create` | When forwarding a customer requirement to the team | Always include both phone numbers and the full message |
| `request_fulfill` | When a forwarder replies to a pending requirement | Always route the reply back to the customer |
| `message_history` | When you need to review what was sent | Never share message logs with customers |
| `blocked_messages` | When checking what was blocked by safety gates | Report blocks to the owner/tech team |

### File Tools

| Tool | When to Use |
|---|---|
| `read` | Read workspace files, configs, learnings |
| `write` | Update learnings, memory files, heartbeat state |
| `edit` | Modify existing files (safer than full overwrite) |

### Communication Tools

| Tool | When to Use |
|---|---|
| `message` | Send a message to a verified contact (after contact_lookup) |

### Rules

1. ALWAYS `contact_lookup` before `message`. No exceptions.
2. NEVER run destructive database queries (DELETE, DROP, TRUNCATE).
3. NEVER share tool outputs directly with customers. Summarize in natural language.
4. Log every error in `.learnings/ERRORS.md`.
5. Log every security concern in `.learnings/SECURITY_ALERTS.md`.
