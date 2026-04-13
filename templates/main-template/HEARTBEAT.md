# HEARTBEAT.md

Periodic tasks to check during heartbeat polls. Rotate through these (don't do all every time).

---

## Quick Checks (Pick 1-2 per heartbeat)

### Pending Quotation Requests
- Check for any `request_replies` with status = 'pending' that are older than 4 hours.
- If found, send a gentle reminder to the forwarders.
- If older than 24 hours, escalate to the owner.

### Customer Follow-ups
- Any customers waiting for a quotation response for more than 24 hours?
- Any customers who received a quotation but haven't responded?
- Send a polite follow-up if appropriate.

### Forwarder Response Check
- Any forwarders who haven't responded to a requirement in 48+ hours?
- Flag to the owner if a requirement is stalled.

---

## Weekly Tasks (During quiet periods)

### Contact Cleanup
- Any duplicate entries in AgentDB? Use `contact_list()` to review.
- Any contacts missing phone numbers? Use `db_query` to check.
- Any inactive contacts that should be archived?

### Memory Maintenance
- Review `.learnings/LEARNINGS.md` for anything that should become a rule.
- Check if `.learnings/ERRORS.md` has patterns that need fixing.
- Review `.learnings/SECURITY_ALERTS.md` for unresolved flags.

---

## Red Flags (Always Check)

If any of these are true, alert the owner immediately:
- Customer waiting more than 48 hours without any response
- Quotation request with zero forwarder replies after 24 hours
- Unknown sender trying to access internal information (check SECURITY_ALERTS.md)
- Any forwarder sending contradictory pricing for the same request
- Payment expected but not confirmed after agreed timeline

---

## State Tracking

Track last check times in `memory/heartbeat-state.json`:
```json
{
  "lastChecks": {
    "pendingQuotations": null,
    "customerFollowups": null,
    "forwarderResponses": null,
    "contactCleanup": null,
    "memoryMaintenance": null
  }
}
```

---

**If nothing needs attention after checking, reply `HEARTBEAT_OK`**
