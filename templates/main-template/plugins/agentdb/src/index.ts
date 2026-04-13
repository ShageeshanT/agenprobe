/**
 * agentdb/src/index.ts — v3.0 (OpenClaw-compatible rewrite)
 *
 * OpenClaw Plugin: AgentDB (19 tools, 2 hooks, 1 service)
 *
 * Changes from v2.3:
 *   - Hook "before_agent_start" → "before_prompt_build" (legacy → recommended)
 *   - Hook "agent_end" → "message_sending" (read-only inspection → mutable outbound)
 *   - Removed 4 cron tools (conflict with OpenClaw built-in cron system)
 *   - Hook context access is defensive (optional chaining, multiple fallback fields)
 *   - Hook registration uses 3-arg form: (event, handler, { name, description })
 *
 * SDK pattern:
 *   export default function(api) { ... }
 *   api.registerTool({ name, description, parameters, execute(_id, params) })
 *   execute returns { content: [{ type: "text", text: "..." }] }
 *   api.registerHook(event, handler, { name, description })
 *   api.registerService({ id, start, stop })
 */

import { AgentDatabase } from "./database.js";

let db: AgentDatabase | null = null;
let geminiKey = "";
let embeddingModel = "text-embedding-004";

// ─── Gemini Embeddings ───────────────────────────────────────────

async function getEmbedding(text: string): Promise<Float32Array | null> {
  if (!geminiKey) return null;
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${embeddingModel}:embedContent?key=${geminiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: `models/${embeddingModel}`,
          content: { parts: [{ text }] },
        }),
      }
    );
    const data = await res.json();
    if (data.embedding?.values) return new Float32Array(data.embedding.values);
    return null;
  } catch { return null; }
}

// ─── Phone extraction ────────────────────────────────────────────

function extractPhones(text: string): string[] {
  const found = new Set<string>();
  const patterns = [
    /\+\d{10,15}/g,
    /\+?\d{1,4}[\s.-]?\(?\d{1,4}\)?[\s.-]?\d{1,4}[\s.-]?\d{1,9}/g,
    /(?<=\s|^)0[1-9]\d{7,10}(?=\s|$|[,.])/g,
  ];
  for (const p of patterns) {
    for (const m of text.match(p) || []) {
      const c = m.replace(/[\s.()\-]/g, "");
      if (c.replace(/\D/g, "").length >= 9) found.add(c);
    }
  }
  return Array.from(found);
}

// ─── Helpers ─────────────────────────────────────────────────────

function txt(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

function json(obj: any) {
  return txt(JSON.stringify(obj, null, 2));
}

function fmtContact(c: any) {
  return {
    id: c.id, name: c.name, display_name: c.display_name,
    phone: c.primary_phone, all_phones: c.phones, role: c.role,
    team: c.team, department: c.department, language_pref: c.language_pref,
    comm_style: c.comm_style, access_level: c.access_level, notes: c.notes,
  };
}

// ─── Plugin Entry Point ──────────────────────────────────────────

export default function register(api: any) {
  const config = api.pluginConfig || {};

  const dbPath = config.dbPath || "~/.openclaw/agentdb-{agentId}.sqlite";
  const defaultCC = config.defaultCountryCode || "";
  const blockUnknown = config.blockOnUnknownNumber !== false;
  const blockRouting = config.blockOnRoutingConfusion !== false;
  const injectContext = config.injectContactContext !== false;
  geminiKey = resolveEnvVar(config.geminiApiKey || "");
  embeddingModel = config.embeddingModel || "text-embedding-004";

  const log = api.logger || console;

  // ─── Service ─────────────────────────────────────────────────

  api.registerService({
    id: "agentdb",
    start() {
      db = new AgentDatabase({
        dbPath,
        agentId: "main",
        defaultCountryCode: defaultCC,
        allowAgentSchemaChanges: config.allowAgentSchemaChanges !== false,
        maxCustomTables: config.maxCustomTables || 20,
        dangerousQueries: config.dangerousQueries || "block",
      });
      log.info("[agentdb] Database ready");
    },
    stop() {
      db?.close();
      db = null;
    },
  });

  // ═══════════════════════════════════════════════════════════════
  // HOOK: before_prompt_build — inject sender context
  // ═══════════════════════════════════════════════════════════════
  //
  // Docs: concepts/agent-loop.md §Plugin hooks
  //   "before_prompt_build: runs after session load (with messages)
  //    to inject prependContext/systemPrompt before prompt submission."
  //
  // The event context shape for plugin hooks is not fully documented.
  // We access fields defensively with multiple fallback paths:
  //   - event.context.from / event.context.senderId  (event-stream shape)
  //   - event.message?.sender / event.message?.from   (possible internal shape)
  //   - event.senderId                                (flat shape)
  //
  // prependContext() is explicitly documented as available in this phase.
  // ═══════════════════════════════════════════════════════════════

  api.registerHook(
    "before_prompt_build",
    async (event: any) => {
      if (!db) { log.warn("[agentdb] DB not initialized — skipping context injection"); return; }
      if (!injectContext) return;

      // Defensively extract sender from all possible context shapes
      const sender =
        event?.context?.from ||
        event?.context?.senderId ||
        event?.message?.sender ||
        event?.message?.from ||
        event?.senderId ||
        null;

      if (!sender) return;

      const contact = db.getContactByPhone(sender);

      // Helper: try multiple ways to prepend context
      const prepend = (xml: string) => {
        if (typeof event.prependContext === "function") {
          event.prependContext(xml);
        } else if (typeof event?.context?.prependContext === "function") {
          event.context.prependContext(xml);
        } else {
          // Last resort: push to messages array if available
          log.warn("[agentdb] prependContext not found — cannot inject sender context");
        }
      };

      // Helper: try to attach session metadata
      const setSession = (key: string, val: any) => {
        if (event?.session) event.session[key] = val;
        else if (event?.context?.session) event.context.session[key] = val;
      };

      if (!contact) {
        prepend(
          `<agentdb-context><sender status="UNKNOWN"><phone>${sender}</phone>` +
          `<warning>Unknown sender. Do NOT share team info.</warning>` +
          `</sender></agentdb-context>`
        );
        return;
      }

      // Build team context
      let teamCtx = "";
      if (contact.team) {
        const mates = db.listContacts({ team: contact.team }).filter(t => t.id !== contact.id);
        if (mates.length) {
          teamCtx = `<team name="${contact.team}">${mates.map(t =>
            `<member name="${t.display_name}" phone="${t.primary_phone}"/>`
          ).join("")}</team>`;
        }
      }

      // Check pending requests
      const pending = db.checkPendingRequests(sender);
      let reqCtx = "";
      if (pending.length) {
        reqCtx = `<pending_requests>${pending.map(r =>
          `<request id="${r.id}" from="${r.requester_name || r.requester_phone}" message="${r.request_message}"/>`
        ).join("")}</pending_requests>`;
      }

      prepend(
        `<agentdb-context>` +
        `<sender status="VERIFIED">` +
        `<n>${contact.display_name}</n>` +
        `<phone>${contact.primary_phone}</phone>` +
        `<role>${contact.role}</role>` +
        `<access>${contact.access_level}</access>` +
        `<lang>${contact.language_pref}</lang>` +
        `<style>${contact.comm_style}</style>` +
        `</sender>` +
        teamCtx + reqCtx +
        `<rules>` +
        `<rule>ALWAYS use contact_lookup for phone numbers. NEVER recall from memory.</rule>` +
        `<rule>Confirmations go back to ${contact.display_name}, NOT to the person you messaged.</rule>` +
        (pending.length ? `<rule>This sender has ${pending.length} pending request(s). Check if their message fulfills any.</rule>` : "") +
        `</rules>` +
        `</agentdb-context>`
      );

      // Stash sender info in session for the message_sending hook
      setSession("_agentdb_orig", sender);
      setSession("_agentdb_origName", contact.display_name);
      setSession("_agentdb_origAccess", contact.access_level);
    },
    {
      name: "agentdb.inject-sender-context",
      description: "Looks up inbound sender in contacts DB and injects context before prompt",
    }
  );

  // ═══════════════════════════════════════════════════════════════
  // HOOK: message_sending — safety gates on outbound messages
  // ═══════════════════════════════════════════════════════════════
  //
  // Docs: concepts/agent-loop.md §Plugin hooks
  //   "message_received / message_sending / message_sent:
  //    inbound + outbound message hooks."
  //
  // automation/hooks.md documents message:sent event context with
  //   { from, to, content, channelId, success }
  //
  // For the plugin hook "message_sending" (pre-send), we expect a
  // similar shape and attempt to mutate content/to to block or
  // redirect unsafe messages. Fields are accessed defensively.
  // ═══════════════════════════════════════════════════════════════

  api.registerHook(
    "message_sending",
    async (event: any) => {
      if (!db) { log.warn("[agentdb] DB not initialized — skipping message gates"); return; }

      // Extract outbound message fields defensively
      const text =
        event?.context?.content ||
        event?.response?.text ||
        event?.content ||
        event?.text ||
        "";

      const recip =
        event?.context?.to ||
        event?.response?.recipient ||
        event?.to ||
        event?.recipient ||
        "";

      // Get original sender from session (stashed in before_prompt_build)
      const orig =
        event?.session?._agentdb_orig ||
        event?.context?.session?._agentdb_orig ||
        "";

      const origAccess =
        event?.session?._agentdb_origAccess ||
        event?.context?.session?._agentdb_origAccess ||
        "restricted";

      const isExplicit =
        event?.response?.isExplicitOutbound ||
        event?.context?.isExplicitOutbound ||
        false;

      // Helper: try to overwrite outbound content
      const setContent = (newText: string) => {
        if (event?.context && "content" in event.context) event.context.content = newText;
        if (event?.response && "text" in event.response) event.response.text = newText;
        if ("content" in event) event.content = newText;
        if ("text" in event) event.text = newText;
      };

      // Helper: try to overwrite recipient
      const setRecipient = (newRecip: string) => {
        if (event?.context && "to" in event.context) event.context.to = newRecip;
        if (event?.response && "recipient" in event.response) event.response.recipient = newRecip;
        if ("to" in event) event.to = newRecip;
        if ("recipient" in event) event.recipient = newRecip;
      };

      // ─── Gate 1: Unknown number verification ───────────────
      if (blockUnknown && text) {
        const phones = extractPhones(text);
        const unknown = phones.length ? db.findUnknownPhones(phones) : [];
        if (unknown.length) {
          const matches = unknown.map(h => {
            const m = db!.findClosestPhone(h);
            return m
              ? `${h} → did you mean ${m.phone} (${m.contact.name})?`
              : `${h} is not in contacts`;
          });
          const msg = "⚠️ Blocked: unverified phone number(s).\n" + matches.join("\n");
          db.logBlocked({
            sender_phone: orig,
            reason: "unknown_number",
            original_message: text.substring(0, 300),
            corrected_action: msg,
            hallucinated_numbers: JSON.stringify(unknown),
          });
          setContent(msg);
          if (orig) setRecipient(orig);
          return;
        }
      }

      // ─── Gate 2: Routing confusion ─────────────────────────
      if (blockRouting && orig && recip && !isExplicit) {
        const oN = orig.replace(/\D/g, "");
        const rN = recip.replace(/\D/g, "");
        if (oN !== rN) {
          const confirmPatterns = [
            /\bI('ve|'ve| have) (sent|told|informed|notified|messaged|forwarded)\b/i,
            /\bmessage (sent|delivered|forwarded) to\b/i,
            /✅\s*(sent|done|delivered|forwarded)/i,
          ];
          if (confirmPatterns.some(p => p.test(text))) {
            db.logBlocked({
              sender_phone: orig,
              reason: "routing_confusion",
              original_message: text.substring(0, 300),
              corrected_action: `Redirected to ${orig}`,
            });
            setRecipient(orig);
          }
        }
      }

      // ─── Gate 3: Data leak prevention ──────────────────────
      if (orig && (origAccess === "customer" || origAccess === "restricted") && text) {
        const sender = db.getContactByPhone(orig);
        if (sender) {
          const others = db.listContacts().filter(c => c.id !== sender.id && c.access_level !== "admin");
          for (const o of others) {
            if (o.access_level === "customer" || o.access_level === "restricted") {
              for (const ph of o.phones) {
                if (text.includes(ph) && !(sender.team && sender.team === o.team)) {
                  db.logBlocked({
                    sender_phone: orig,
                    reason: "data_leak",
                    original_message: text.substring(0, 300),
                    corrected_action: "Blocked — contained another customer's phone",
                  });
                  setContent("I was about to share information not appropriate for this conversation. Let me rephrase.");
                  if (orig) setRecipient(orig);
                  return;
                }
              }
            }
          }
        }
      }
    },
    {
      name: "agentdb.message-safety-gates",
      description: "Blocks outbound messages with unverified phones, routing confusion, or data leaks",
    }
  );

  // ═══════════════════════════════════════════════════════════════
  // TOOLS: CONTACTS (5)
  // ═══════════════════════════════════════════════════════════════

  api.registerTool({
    name: "contact_lookup",
    description: "Look up a contact by name or phone. ALWAYS use this instead of recalling numbers from memory.",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "Name or phone number" } },
      required: ["query"],
    },
    async execute(_id: string, params: any) {
      if (!db) return txt("Database not initialized");
      const byPhone = db.getContactByPhone(params.query);
      if (byPhone) return json({ found: true, contact: fmtContact(byPhone) });
      const byName = db.searchContacts(params.query);
      if (byName.length) return json({ found: true, contacts: byName.map(fmtContact) });
      return json({ found: false, message: `No contact found for "${params.query}". Ask the user for details.` });
    },
  });

  api.registerTool({
    name: "contact_add",
    description: "Add a new contact to the verified contacts database.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string" },
        display_name: { type: "string" },
        phone: { type: "string", description: "International format" },
        additional_phones: { type: "array", items: { type: "string" } },
        role: { type: "string", enum: ["admin", "team", "customer", "supplier", "restricted"] },
        team: { type: "string" },
        department: { type: "string" },
        language_pref: { type: "string" },
        comm_style: { type: "string", enum: ["detailed", "completion-only", "silent-execute"] },
        access_level: { type: "string", enum: ["admin", "team", "customer", "supplier", "restricted"] },
        notes: { type: "string" },
      },
      required: ["name", "display_name", "phone", "role", "access_level"],
    },
    async execute(_id: string, params: any) {
      if (!db) return txt("Database not initialized");
      const phones = [params.phone, ...(params.additional_phones || [])];
      const c = db.addContact({ ...params, phones, primary_phone: params.phone });
      if (geminiKey) {
        const text = `${c.name} ${c.display_name} ${c.role} ${c.team || ""} ${c.department || ""} ${c.notes || ""}`;
        const emb = await getEmbedding(text);
        if (emb) db.storeEmbedding("contacts", c.id, text, emb);
      }
      return json({ success: true, contact: fmtContact(c) });
    },
  });

  api.registerTool({
    name: "contact_update",
    description: "Update an existing contact.",
    parameters: {
      type: "object",
      properties: {
        contact_id: { type: "string" },
        name: { type: "string" },
        display_name: { type: "string" },
        phone: { type: "string" },
        additional_phones: { type: "array", items: { type: "string" } },
        role: { type: "string" },
        team: { type: "string" },
        department: { type: "string" },
        language_pref: { type: "string" },
        comm_style: { type: "string" },
        access_level: { type: "string" },
        notes: { type: "string" },
        is_active: { type: "boolean" },
      },
      required: ["contact_id"],
    },
    async execute(_id: string, params: any) {
      if (!db) return txt("Database not initialized");
      const { contact_id, additional_phones, phone, ...u } = params;
      if (phone) {
        u.primary_phone = phone;
        u.phones = [phone, ...(additional_phones || [])];
      }
      const c = db.updateContact(contact_id, u);
      return c ? json({ success: true, contact: fmtContact(c) }) : json({ error: `Contact ${contact_id} not found` });
    },
  });

  api.registerTool({
    name: "contact_search",
    description: "Search contacts by name, role, or team.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        role: { type: "string" },
        team: { type: "string" },
      },
    },
    async execute(_id: string, params: any) {
      if (!db) return txt("Database not initialized");
      if (params.query) return json({ contacts: db.searchContacts(params.query).map(fmtContact) });
      return json({ contacts: db.listContacts({ role: params.role, team: params.team }).map(fmtContact) });
    },
  });

  api.registerTool({
    name: "contact_list",
    description: "List all contacts with optional filters.",
    parameters: {
      type: "object",
      properties: {
        role: { type: "string" },
        team: { type: "string" },
      },
    },
    async execute(_id: string, params: any) {
      if (!db) return txt("Database not initialized");
      const list = db.listContacts({ role: params.role, team: params.team });
      return json({
        count: list.length,
        contacts: list.map(c => ({
          id: c.id, name: c.display_name, phone: c.primary_phone,
          role: c.role, team: c.team,
        })),
      });
    },
  });

  // ═══════════════════════════════════════════════════════════════
  // CRON TOOLS REMOVED — Use OpenClaw's built-in cron system
  // ═══════════════════════════════════════════════════════════════
  //
  // OpenClaw has a built-in cron system (automation/cron-jobs.md) that:
  //   - Stores jobs in ~/.openclaw/cron/jobs.json
  //   - Runs inside the Gateway scheduler (actually executes)
  //   - Supports isolated/main sessions, delivery modes, retry
  //   - Exposes a built-in "cron" tool to the agent
  //
  // The old agentdb cron tools only wrote to SQLite but NEVER
  // registered with the Gateway scheduler, so jobs would never fire.
  // The tool names also conflicted with the built-in cron tool names.
  //
  // The agent should use OpenClaw's /cron command or the built-in
  // cron tool. Contact context from this plugin's before_prompt_build
  // hook is automatically available during cron-triggered agent runs.
  // ═══════════════════════════════════════════════════════════════

  // ═══════════════════════════════════════════════════════════════
  // TOOLS: DATABASE (6)
  // ═══════════════════════════════════════════════════════════════

  api.registerTool({
    name: "db_query",
    description: "Execute SQL against the agent database. SELECT returns rows. INSERT/UPDATE/DELETE returns change count. Use db_list_tables to discover available tables first.",
    parameters: {
      type: "object",
      properties: {
        sql: { type: "string" },
        purpose: { type: "string" },
      },
      required: ["sql"],
    },
    async execute(_id: string, params: any) {
      if (!db) return txt("Database not initialized");
      return json(db.executeQuery(params.sql));
    },
  });

  api.registerTool({
    name: "db_create_table",
    description: "Create a custom table when you identify a recurring need to track structured data (orders, inventory, penalties, etc). Gets auto id/created_at/updated_at columns.",
    parameters: {
      type: "object",
      properties: {
        table_name: { type: "string", description: "lowercase_with_underscores" },
        columns: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              type: { type: "string", enum: ["TEXT", "INTEGER", "REAL", "BOOLEAN", "DATE", "DATETIME", "JSON"] },
              constraints: { type: "string" },
            },
            required: ["name", "type"],
          },
        },
        purpose: { type: "string" },
      },
      required: ["table_name", "columns", "purpose"],
    },
    async execute(_id: string, params: any) {
      if (!db) return txt("Database not initialized");
      return json(db.createCustomTable(params.table_name, params.columns, params.purpose));
    },
  });

  api.registerTool({
    name: "db_alter_table",
    description: "Add columns to an agent-created table. Cannot alter system tables.",
    parameters: {
      type: "object",
      properties: {
        table_name: { type: "string" },
        new_columns: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              type: { type: "string" },
              default_value: { type: "string" },
            },
            required: ["name", "type"],
          },
        },
      },
      required: ["table_name", "new_columns"],
    },
    async execute(_id: string, params: any) {
      if (!db) return txt("Database not initialized");
      return json(db.alterCustomTable(params.table_name, params.new_columns));
    },
  });

  api.registerTool({
    name: "db_drop_table",
    description: "Delete an agent-created table. Irreversible. Cannot drop system tables.",
    parameters: {
      type: "object",
      properties: { table_name: { type: "string" } },
      required: ["table_name"],
    },
    async execute(_id: string, params: any) {
      if (!db) return txt("Database not initialized");
      return json(db.dropCustomTable(params.table_name));
    },
  });

  api.registerTool({
    name: "db_list_tables",
    description: "List all tables (system + custom) with purpose, columns, and row counts. Use this before db_query to discover available data.",
    parameters: { type: "object", properties: {} },
    async execute() {
      if (!db) return txt("Database not initialized");
      return json({ tables: db.listTables() });
    },
  });

  api.registerTool({
    name: "db_stats",
    description: "Database statistics overview.",
    parameters: { type: "object", properties: {} },
    async execute() {
      if (!db) return txt("Database not initialized");
      return json(db.getStats());
    },
  });

  // ═══════════════════════════════════════════════════════════════
  // TOOLS: SEMANTIC SEARCH (2)
  // ═══════════════════════════════════════════════════════════════

  api.registerTool({
    name: "semantic_search",
    description: "Search all stored data by meaning using Gemini embeddings. Use when exact keyword search fails — e.g. 'who handles development?' finds someone whose notes say 'build side'.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural language query" },
        limit: { type: "number" },
      },
      required: ["query"],
    },
    async execute(_id: string, params: any) {
      if (!db) return txt("Database not initialized");
      if (!geminiKey) return json({ error: "Semantic search requires a Gemini API key. Set geminiApiKey in plugin config." });
      const emb = await getEmbedding(params.query);
      if (!emb) return json({ error: "Failed to generate embedding" });
      const results = db.searchEmbeddings(emb, params.limit || 5);
      return json({ results });
    },
  });

  api.registerTool({
    name: "semantic_index",
    description: "Store content as a Gemini embedding for later semantic search. Use to index important facts, decisions, or any text you want to find by meaning later.",
    parameters: {
      type: "object",
      properties: {
        source_table: { type: "string", description: "Table name this content belongs to (e.g. 'contacts', 'notes', or any custom table)" },
        source_id: { type: "string", description: "ID of the source record" },
        content: { type: "string", description: "Text to embed and index" },
      },
      required: ["source_table", "source_id", "content"],
    },
    async execute(_id: string, params: any) {
      if (!db) return txt("Database not initialized");
      if (!geminiKey) return json({ error: "Requires Gemini API key" });
      const emb = await getEmbedding(params.content);
      if (!emb) return json({ error: "Failed to generate embedding" });
      db.storeEmbedding(params.source_table, params.source_id, params.content, emb);
      return json({ success: true, dimensions: emb.length });
    },
  });

  // ═══════════════════════════════════════════════════════════════
  // TOOLS: REQUEST-REPLY TRACKING (4)
  // ═══════════════════════════════════════════════════════════════

  api.registerTool({
    name: "request_create",
    description: "Log a cross-session request. Use when someone asks you to check with another person. Tracks the request so the reply can be routed back.",
    parameters: {
      type: "object",
      properties: {
        requester_phone: { type: "string" },
        requester_name: { type: "string" },
        target_phone: { type: "string" },
        target_name: { type: "string" },
        request_message: { type: "string", description: "What was asked" },
        metadata: { type: "string" },
      },
      required: ["requester_phone", "target_phone", "request_message"],
    },
    async execute(_id: string, params: any) {
      if (!db) return txt("Database not initialized");
      const req = db.createRequest(params);
      return req
        ? json({ success: true, request: req })
        : json({ success: false, error: "Failed to create request — possible ID collision, try again" });
    },
  });

  api.registerTool({
    name: "request_check",
    description: "Check if an inbound sender has pending requests waiting for their reply.",
    parameters: {
      type: "object",
      properties: { phone: { type: "string", description: "Sender's phone number" } },
      required: ["phone"],
    },
    async execute(_id: string, params: any) {
      if (!db) return txt("Database not initialized");
      const pending = db.checkPendingRequests(params.phone);
      return json({ count: pending.length, requests: pending });
    },
  });

  api.registerTool({
    name: "request_fulfill",
    description: "Mark a request as answered and capture the response. The response should be routed back to the original requester.",
    parameters: {
      type: "object",
      properties: {
        request_id: { type: "string" },
        reply_message: { type: "string", description: "The response to send back to the requester" },
      },
      required: ["request_id", "reply_message"],
    },
    async execute(_id: string, params: any) {
      if (!db) return txt("Database not initialized");
      const r = db.fulfillRequest(params.request_id, params.reply_message);
      return r
        ? json({ success: true, request: r, route_reply_to: r.requester_phone })
        : json({ error: "Request not found" });
    },
  });

  api.registerTool({
    name: "request_list",
    description: "View all pending or fulfilled requests.",
    parameters: {
      type: "object",
      properties: { status: { type: "string", enum: ["pending", "fulfilled"] } },
    },
    async execute(_id: string, params: any) {
      if (!db) return txt("Database not initialized");
      return json({ requests: db.listRequests(params.status) });
    },
  });

  // ═══════════════════════════════════════════════════════════════
  // TOOLS: AUDIT (2)
  // ═══════════════════════════════════════════════════════════════

  api.registerTool({
    name: "message_history",
    description: "Search the message audit log by phone, channel, or date.",
    parameters: {
      type: "object",
      properties: {
        phone: { type: "string" },
        since: { type: "string" },
        limit: { type: "number" },
      },
    },
    async execute(_id: string, params: any) {
      if (!db) return txt("Database not initialized");
      return json({ messages: db.getMessageHistory(params) });
    },
  });

  api.registerTool({
    name: "blocked_messages",
    description: "View recently blocked or redirected messages.",
    parameters: {
      type: "object",
      properties: { limit: { type: "number" } },
    },
    async execute(_id: string, params: any) {
      if (!db) return txt("Database not initialized");
      return json({ blocked: db.getRecentBlocked(params.limit || 20) });
    },
  });
}

// ─── Env var resolution ──────────────────────────────────────────

function resolveEnvVar(val: string): string {
  if (!val) return "";
  const match = val.match(/^\$\{(.+)\}$/);
  if (match) return process.env[match[1]] || "";
  return val;
}
