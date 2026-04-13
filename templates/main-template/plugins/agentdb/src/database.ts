/**
 * agentdb/src/database.ts — v3.0
 * Pure SQLite layer — no OpenClaw SDK dependencies.
 *
 * Changes from v2.3:
 *   - Removed cron_jobs table and all cron methods (use OpenClaw built-in cron)
 *   - Removed CronJob type
 *   - Removed cron_jobs from PROTECTED_TABLES and schema registry
 *   - getStats() no longer reports active_crons
 */

import Database from "better-sqlite3";
import { resolve } from "path";
import { mkdirSync } from "fs";

// ─── Types ───────────────────────────────────────────────────────────

export interface Contact {
  id: string; name: string; display_name: string; phones: string[];
  primary_phone: string; role: string; team: string | null;
  department: string | null; language_pref: string | null;
  comm_style: string | null; access_level: string; notes: string | null;
  is_active: boolean; created_at: string; updated_at: string;
}

export interface RequestReply {
  id: string; requester_phone: string; requester_name: string | null;
  target_phone: string; target_name: string | null;
  request_message: string; reply_message: string | null;
  status: string; created_at: string; fulfilled_at: string | null;
  metadata: string | null;
}

export interface AgentDBConfig {
  dbPath: string; agentId?: string; defaultCountryCode?: string;
  allowAgentSchemaChanges?: boolean; maxCustomTables?: number;
  dangerousQueries?: "block" | "warn" | "allow";
}

const PROTECTED_TABLES = [
  "contacts", "contact_phones", "contacts_fts", "message_log",
  "blocked_log", "request_replies", "embeddings",
  "_schema_registry",
];

const DANGEROUS_PATTERNS = [
  /\bDROP\s+TABLE\b/i, /\bDROP\s+DATABASE\b/i, /\bTRUNCATE\b/i,
  /\bATTACH\b/i, /\bDETACH\b/i, /\bPRAGMA\b/i,
  /\bDELETE\s+FROM\s+\w+\s*$/i, /\bDELETE\s+FROM\s+\w+\s*;?\s*$/i,
];

// ─── Database ────────────────────────────────────────────────────────

export class AgentDatabase {
  private db: Database.Database;
  private defaultCC: string;
  private allowSchema: boolean;
  private maxTables: number;
  private dangerousMode: "block" | "warn" | "allow";

  constructor(cfg: AgentDBConfig) {
    let p = cfg.dbPath.replace("{agentId}", cfg.agentId || "default");
    p = p.replace(/^~/, process.env.HOME || "/root");
    p = resolve(p);
    mkdirSync(p.substring(0, p.lastIndexOf("/")), { recursive: true });

    this.db = new Database(p);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.defaultCC = cfg.defaultCountryCode || "";
    this.allowSchema = cfg.allowAgentSchemaChanges !== false;
    this.maxTables = cfg.maxCustomTables || 20;
    this.dangerousMode = cfg.dangerousQueries || "block";
    this.initSchema();
  }

  private initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS _schema_registry (
        table_name TEXT PRIMARY KEY, created_by TEXT NOT NULL DEFAULT 'system',
        purpose TEXT NOT NULL DEFAULT '', columns_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS contacts (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, display_name TEXT NOT NULL,
        primary_phone TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'customer',
        team TEXT, department TEXT, language_pref TEXT DEFAULT 'english',
        comm_style TEXT DEFAULT 'detailed', access_level TEXT NOT NULL DEFAULT 'customer',
        notes TEXT, is_active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS contact_phones (
        contact_id TEXT NOT NULL, phone TEXT NOT NULL, label TEXT NOT NULL DEFAULT 'primary',
        FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE,
        PRIMARY KEY (contact_id, phone)
      );
      CREATE INDEX IF NOT EXISTS idx_cp_phone ON contact_phones(phone);
      CREATE TABLE IF NOT EXISTS message_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL DEFAULT (datetime('now')),
        sender_phone TEXT NOT NULL, sender_name TEXT,
        recipient_phone TEXT NOT NULL, recipient_name TEXT,
        channel TEXT DEFAULT 'whatsapp', message_preview TEXT,
        was_verified INTEGER NOT NULL DEFAULT 1, direction TEXT NOT NULL DEFAULT 'outbound'
      );
      CREATE INDEX IF NOT EXISTS idx_ml_time ON message_log(timestamp);
      CREATE TABLE IF NOT EXISTS blocked_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL DEFAULT (datetime('now')),
        sender_phone TEXT, sender_name TEXT,
        intended_recipient_phone TEXT, intended_recipient_name TEXT,
        reason TEXT NOT NULL, original_message TEXT,
        corrected_action TEXT, hallucinated_numbers TEXT
      );
      CREATE TABLE IF NOT EXISTS request_replies (
        id TEXT PRIMARY KEY, requester_phone TEXT NOT NULL,
        requester_name TEXT, target_phone TEXT NOT NULL,
        target_name TEXT, request_message TEXT NOT NULL,
        reply_message TEXT, status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        fulfilled_at TEXT, metadata TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_rr_target ON request_replies(target_phone, status);
      CREATE INDEX IF NOT EXISTS idx_rr_requester ON request_replies(requester_phone, status);
      CREATE TABLE IF NOT EXISTS embeddings (
        id TEXT PRIMARY KEY, source_table TEXT NOT NULL,
        source_id TEXT NOT NULL, content_text TEXT NOT NULL,
        embedding BLOB, created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_emb_source ON embeddings(source_table, source_id);
    `);
    // Try to create FTS — may fail if already exists with different schema, that's OK
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS contacts_fts USING fts5(
          name, display_name, notes, role, team, department,
          content='contacts', content_rowid='rowid'
        );
        CREATE TRIGGER IF NOT EXISTS contacts_fts_ai AFTER INSERT ON contacts BEGIN
          INSERT INTO contacts_fts(rowid, name, display_name, notes, role, team, department)
          VALUES (new.rowid, new.name, new.display_name, new.notes, new.role, new.team, new.department);
        END;
        CREATE TRIGGER IF NOT EXISTS contacts_fts_ad AFTER DELETE ON contacts BEGIN
          INSERT INTO contacts_fts(contacts_fts, rowid, name, display_name, notes, role, team, department)
          VALUES ('delete', old.rowid, old.name, old.display_name, old.notes, old.role, old.team, old.department);
        END;
        CREATE TRIGGER IF NOT EXISTS contacts_fts_au AFTER UPDATE ON contacts BEGIN
          INSERT INTO contacts_fts(contacts_fts, rowid, name, display_name, notes, role, team, department)
          VALUES ('delete', old.rowid, old.name, old.display_name, old.notes, old.role, old.team, old.department);
          INSERT INTO contacts_fts(rowid, name, display_name, notes, role, team, department)
          VALUES (new.rowid, new.name, new.display_name, new.notes, new.role, new.team, new.department);
        END;
      `);
    } catch { /* FTS or triggers already exist */ }
    this.registerBuiltInTables();
  }

  private registerBuiltInTables() {
    const ins = this.db.prepare(
      "INSERT OR IGNORE INTO _schema_registry (table_name, created_by, purpose, columns_json) VALUES (?, 'system', ?, '[]')"
    );
    ins.run("contacts", "Verified contacts with phone numbers, roles, teams, preferences");
    ins.run("contact_phones", "Normalized E.164 phone numbers linked to contacts");
    ins.run("message_log", "Audit trail of outbound messages");
    ins.run("blocked_log", "Messages blocked or redirected by safety gates");
    ins.run("request_replies", "Cross-session request-reply tracking");
    ins.run("embeddings", "Gemini vector embeddings for semantic search");
  }

  // ─── Contacts ──────────────────────────────────────────────────

  addContact(c: any): Contact {
    const id = c.id || this.genId(c.name);
    const now = new Date().toISOString();
    const txn = this.db.transaction(() => {
      this.db.prepare(
        `INSERT OR REPLACE INTO contacts (id,name,display_name,primary_phone,role,team,department,language_pref,comm_style,access_level,notes,is_active,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?,?)`
      ).run(
        id, c.name, c.display_name, this.normPhone(c.primary_phone),
        c.role, c.team || null, c.department || null,
        c.language_pref || "english", c.comm_style || "detailed",
        c.access_level, c.notes || null, now, now
      );
      this.db.prepare("DELETE FROM contact_phones WHERE contact_id=?").run(id);
      const phones = Array.isArray(c.phones) ? c.phones : [c.primary_phone];
      const pn = this.normPhone(c.primary_phone);
      for (const ph of phones) {
        const n = this.normPhone(ph);
        this.db.prepare(
          "INSERT OR REPLACE INTO contact_phones (contact_id,phone,label) VALUES (?,?,?)"
        ).run(id, n, n === pn ? "primary" : "secondary");
      }
    });
    txn();
    return this.getContact(id)!;
  }

  getContact(id: string): Contact | null {
    const r = this.db.prepare("SELECT * FROM contacts WHERE id=?").get(id) as any;
    if (!r) return null;
    const ph = this.db.prepare("SELECT phone FROM contact_phones WHERE contact_id=?").all(id) as { phone: string }[];
    return { ...r, phones: ph.map(p => p.phone), is_active: !!r.is_active };
  }

  getContactByPhone(phone: string): Contact | null {
    const n = this.normPhone(phone);
    const r = this.db.prepare("SELECT contact_id FROM contact_phones WHERE phone=?").get(n) as any;
    return r ? this.getContact(r.contact_id) : null;
  }

  searchContacts(q: string): Contact[] {
    try {
      const safeQ = '"' + q.replace(/"/g, '""') + '"';
      const rows = this.db.prepare(
        "SELECT c.* FROM contacts c JOIN contacts_fts f ON c.rowid=f.rowid WHERE contacts_fts MATCH ? AND c.is_active=1 ORDER BY rank LIMIT 10"
      ).all(safeQ) as any[];
      return rows.map(r => {
        const ph = this.db.prepare("SELECT phone FROM contact_phones WHERE contact_id=?").all(r.id) as any[];
        return { ...r, phones: ph.map((p: any) => p.phone), is_active: !!r.is_active };
      });
    } catch { return []; }
  }

  listContacts(filters?: { role?: string; team?: string }): Contact[] {
    let sql = "SELECT * FROM contacts WHERE is_active=1";
    const p: any[] = [];
    if (filters?.role) { sql += " AND role=?"; p.push(filters.role); }
    if (filters?.team) { sql += " AND team=?"; p.push(filters.team); }
    sql += " ORDER BY name";
    return (this.db.prepare(sql).all(...p) as any[]).map(r => {
      const ph = this.db.prepare("SELECT phone FROM contact_phones WHERE contact_id=?").all(r.id) as any[];
      return { ...r, phones: ph.map((p2: any) => p2.phone), is_active: !!r.is_active };
    });
  }

  updateContact(id: string, u: any): Contact | null {
    const fields: string[] = [];
    const vals: any[] = [];
    for (const k of [
      "name", "display_name", "primary_phone", "role", "team",
      "department", "language_pref", "comm_style", "access_level", "notes", "is_active",
    ]) {
      if (u[k] !== undefined) { fields.push(`${k}=?`); vals.push(u[k]); }
    }
    if (!fields.length) return this.getContact(id);
    fields.push("updated_at=?");
    vals.push(new Date().toISOString());
    vals.push(id);
    this.db.prepare(`UPDATE contacts SET ${fields.join(",")} WHERE id=?`).run(...vals);
    if (u.phones) {
      this.db.prepare("DELETE FROM contact_phones WHERE contact_id=?").run(id);
      const pn = this.normPhone(u.primary_phone || "");
      for (const ph of u.phones) {
        const n = this.normPhone(ph);
        this.db.prepare(
          "INSERT OR REPLACE INTO contact_phones (contact_id,phone,label) VALUES (?,?,?)"
        ).run(id, n, n === pn ? "primary" : "secondary");
      }
    }
    return this.getContact(id);
  }

  // ─── Phone verification ────────────────────────────────────────

  isKnownPhone(phone: string): boolean {
    return !!this.db.prepare(
      "SELECT 1 FROM contact_phones cp JOIN contacts c ON cp.contact_id=c.id WHERE cp.phone=? AND c.is_active=1"
    ).get(this.normPhone(phone));
  }

  findUnknownPhones(phones: string[]): string[] {
    return phones.filter(p => !this.isKnownPhone(p));
  }

  findClosestPhone(h: string): { phone: string; contact: Contact; distance: number } | null {
    const n = this.normPhone(h);
    const all = this.db.prepare(
      "SELECT cp.phone,cp.contact_id FROM contact_phones cp JOIN contacts c ON cp.contact_id=c.id WHERE c.is_active=1 LIMIT 500"
    ).all() as any[];
    let best: any = null;
    for (const r of all) {
      if (Math.abs(n.length - r.phone.length) > 3) continue;
      const d = this.lev(n, r.phone);
      if (d <= 3 && (!best || d < best.distance)) {
        best = { ...r, distance: d };
        if (d === 1) break;
      }
    }
    if (!best) return null;
    const c = this.getContact(best.contact_id);
    return c ? { phone: best.phone, contact: c, distance: best.distance } : null;
  }

  // ─── Request-Reply tracking ────────────────────────────────────

  createRequest(r: any): RequestReply | null {
    const id = r.id || this.genId("req");
    try {
      this.db.prepare(
        "INSERT INTO request_replies (id,requester_phone,requester_name,target_phone,target_name,request_message,status,metadata) VALUES (?,?,?,?,?,?,'pending',?)"
      ).run(
        id, r.requester_phone, r.requester_name || null,
        r.target_phone, r.target_name || null,
        r.request_message, r.metadata || null
      );
      return this.db.prepare("SELECT * FROM request_replies WHERE id=?").get(id) as RequestReply || null;
    } catch (e: any) { return null; }
  }

  checkPendingRequests(phone: string): RequestReply[] {
    return this.db.prepare(
      "SELECT * FROM request_replies WHERE target_phone=? AND status='pending' ORDER BY created_at"
    ).all(this.normPhone(phone)) as RequestReply[];
  }

  fulfillRequest(id: string, reply: string): RequestReply | null {
    this.db.prepare(
      "UPDATE request_replies SET reply_message=?, status='fulfilled', fulfilled_at=? WHERE id=?"
    ).run(reply, new Date().toISOString(), id);
    return this.db.prepare("SELECT * FROM request_replies WHERE id=?").get(id) as RequestReply;
  }

  listRequests(status?: string): RequestReply[] {
    if (status) {
      return this.db.prepare(
        "SELECT * FROM request_replies WHERE status=? ORDER BY created_at DESC LIMIT 50"
      ).all(status) as RequestReply[];
    }
    return this.db.prepare(
      "SELECT * FROM request_replies ORDER BY created_at DESC LIMIT 50"
    ).all() as RequestReply[];
  }

  // ─── Embeddings ────────────────────────────────────────────────

  storeEmbedding(sourceTable: string, sourceId: string, text: string, embedding: Float32Array): void {
    const buf = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
    this.db.prepare(
      "INSERT OR REPLACE INTO embeddings (id,source_table,source_id,content_text,embedding) VALUES (?,?,?,?,?)"
    ).run(`${sourceTable}:${sourceId}`, sourceTable, sourceId, text, buf);
  }

  searchEmbeddings(queryEmbedding: Float32Array, limit = 5): { source_table: string; source_id: string; content_text: string; score: number }[] {
    const count = (this.db.prepare("SELECT COUNT(*) as c FROM embeddings").get() as any).c;
    const results: { source_table: string; source_id: string; content_text: string; score: number }[] = [];
    const batchSize = 200;
    for (let offset = 0; offset < count; offset += batchSize) {
      const batch = this.db.prepare("SELECT * FROM embeddings LIMIT ? OFFSET ?").all(batchSize, offset) as any[];
      for (const row of batch) {
        const rawBuf = row.embedding as Buffer;
        const aligned = new ArrayBuffer(rawBuf.byteLength);
        new Uint8Array(aligned).set(rawBuf);
        const stored = new Float32Array(aligned);
        const score = this.cosineSim(queryEmbedding, stored);
        results.push({ source_table: row.source_table, source_id: row.source_id, content_text: row.content_text, score });
      }
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  private cosineSim(a: Float32Array, b: Float32Array): number {
    if (a.length !== b.length) return 0;
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    const denom = Math.sqrt(na) * Math.sqrt(nb);
    return denom === 0 ? 0 : Math.max(-1, Math.min(1, dot / denom));
  }

  // ─── Audit ─────────────────────────────────────────────────────

  logMessage(sender: string, sName: string | null, recip: string, rName: string | null, preview: string): void {
    this.db.prepare(
      "INSERT INTO message_log (sender_phone,sender_name,recipient_phone,recipient_name,message_preview) VALUES (?,?,?,?,?)"
    ).run(sender, sName, recip, rName, (preview || "").substring(0, 500));
  }

  logBlocked(e: any): void {
    this.db.prepare(
      "INSERT INTO blocked_log (sender_phone,sender_name,intended_recipient_phone,intended_recipient_name,reason,original_message,corrected_action,hallucinated_numbers) VALUES (?,?,?,?,?,?,?,?)"
    ).run(
      e.sender_phone, e.sender_name || null,
      e.intended_recipient_phone || null, e.intended_recipient_name || null,
      e.reason, e.original_message || null,
      e.corrected_action || null, e.hallucinated_numbers || null
    );
  }

  getRecentBlocked(limit = 20): any[] {
    return this.db.prepare("SELECT * FROM blocked_log ORDER BY timestamp DESC LIMIT ?").all(limit);
  }

  getMessageHistory(filters?: any): any[] {
    let sql = "SELECT * FROM message_log WHERE 1=1";
    const p: any[] = [];
    if (filters?.phone) { sql += " AND (sender_phone=? OR recipient_phone=?)"; p.push(filters.phone, filters.phone); }
    if (filters?.since) { sql += " AND timestamp>?"; p.push(filters.since); }
    sql += " ORDER BY timestamp DESC LIMIT ?";
    p.push(filters?.limit || 50);
    return this.db.prepare(sql).all(...p);
  }

  // ─── Agent schema ──────────────────────────────────────────────

  createCustomTable(name: string, cols: { name: string; type: string; constraints?: string }[], purpose: string): { success: boolean; error?: string } {
    if (!this.allowSchema) return { success: false, error: "Schema changes disabled" };
    const safe = name.replace(/[^a-zA-Z0-9_]/g, "").toLowerCase();
    if (!safe || safe.startsWith("_")) return { success: false, error: "Invalid table name" };
    if (PROTECTED_TABLES.includes(safe)) return { success: false, error: `'${safe}' is a protected system table` };
    const cnt = (this.db.prepare("SELECT COUNT(*) as c FROM _schema_registry WHERE created_by='agent'").get() as any).c;
    if (cnt >= this.maxTables) return { success: false, error: `Max custom tables (${this.maxTables}) reached` };
    if (this.db.prepare("SELECT 1 FROM _schema_registry WHERE table_name=?").get(safe)) return { success: false, error: `Table '${safe}' already exists` };
    const SAFE_CONSTRAINT = /^(NOT NULL|UNIQUE|DEFAULT\s+'[^']{0,100}'|DEFAULT\s+\d+|DEFAULT\s+NULL)$/i;
    const ALLOWED_TYPES = ["TEXT", "INTEGER", "REAL", "BLOB", "NUMERIC", "BOOLEAN", "DATE", "DATETIME", "JSON"];
    const defs = [
      "id TEXT PRIMARY KEY",
      ...cols.map(c => {
        const n = c.name.replace(/[^a-zA-Z0-9_]/g, "").toLowerCase();
        if (!n || n === "id" || n === "created_at" || n === "updated_at") return null;
        const t = c.type.toUpperCase().replace(/[^A-Z]/g, "");
        if (!ALLOWED_TYPES.includes(t)) return null;
        let cs = "";
        if (c.constraints) {
          cs = " " + c.constraints.split(/\s*,\s*/).filter((p: string) => SAFE_CONSTRAINT.test(p.trim())).join(" ");
        }
        return `${n} ${t}${cs}`;
      }).filter(Boolean),
      "created_at TEXT DEFAULT (datetime('now'))",
      "updated_at TEXT DEFAULT (datetime('now'))",
    ];
    try {
      this.db.exec(`CREATE TABLE ${safe} (${defs.join(",")})`);
      this.db.prepare(
        "INSERT INTO _schema_registry (table_name,created_by,purpose,columns_json) VALUES (?,'agent',?,?)"
      ).run(safe, purpose, JSON.stringify(cols));
      return { success: true };
    } catch (e: any) { return { success: false, error: e.message }; }
  }

  alterCustomTable(name: string, newCols: { name: string; type: string; default_value?: string }[]): { success: boolean; error?: string } {
    if (!this.allowSchema) return { success: false, error: "Schema changes disabled" };
    const safe = name.replace(/[^a-zA-Z0-9_]/g, "").toLowerCase();
    const reg = this.db.prepare("SELECT * FROM _schema_registry WHERE table_name=?").get(safe) as any;
    if (!reg) return { success: false, error: `Table '${safe}' not found` };
    if (reg.created_by === "system") return { success: false, error: `Cannot alter system table` };
    try {
      const ALLOWED_TYPES = ["TEXT", "INTEGER", "REAL", "BLOB", "NUMERIC", "BOOLEAN", "DATE", "DATETIME", "JSON"];
      for (const c of newCols) {
        const n = c.name.replace(/[^a-zA-Z0-9_]/g, "").toLowerCase();
        if (!n) continue;
        const t = c.type.toUpperCase().replace(/[^A-Z]/g, "");
        if (!ALLOWED_TYPES.includes(t)) continue;
        const safeDefault = c.default_value ? c.default_value.replace(/'/g, "''").replace(/;/g, "").substring(0, 100) : "";
        const def = safeDefault ? ` DEFAULT '${safeDefault}'` : "";
        this.db.exec(`ALTER TABLE ${safe} ADD COLUMN ${n} ${t}${def}`);
      }
      return { success: true };
    } catch (e: any) { return { success: false, error: e.message }; }
  }

  dropCustomTable(name: string): { success: boolean; error?: string } {
    if (!this.allowSchema) return { success: false, error: "Schema changes disabled" };
    const safe = name.replace(/[^a-zA-Z0-9_]/g, "").toLowerCase();
    const reg = this.db.prepare("SELECT * FROM _schema_registry WHERE table_name=?").get(safe) as any;
    if (!reg) return { success: false, error: "Not found" };
    if (reg.created_by === "system") return { success: false, error: "Cannot drop system table" };
    this.db.exec(`DROP TABLE IF EXISTS ${safe}`);
    this.db.prepare("DELETE FROM _schema_registry WHERE table_name=?").run(safe);
    return { success: true };
  }

  listTables(): any[] {
    return (this.db.prepare("SELECT * FROM _schema_registry ORDER BY created_by,table_name").all() as any[]).map(r => {
      let cnt = 0;
      try { cnt = (this.db.prepare(`SELECT COUNT(*) as c FROM ${r.table_name}`).get() as any).c; } catch {}
      return { ...r, row_count: cnt };
    });
  }

  executeQuery(sql: string): { success: boolean; data?: any; changes?: number; error?: string; warning?: string } {
    const t = sql.trim();
    for (const p of DANGEROUS_PATTERNS) {
      if (p.test(t)) {
        if (this.dangerousMode === "block") return { success: false, error: "Query blocked — matches dangerous pattern" };
      }
    }
    try {
      if (/^\s*SELECT\b/i.test(t)) return { success: true, data: this.db.prepare(t).all() };
      return { success: true, changes: this.db.prepare(t).run().changes };
    } catch (e: any) { return { success: false, error: e.message }; }
  }

  getStats(): any {
    const contacts = (this.db.prepare("SELECT COUNT(*) as c FROM contacts WHERE is_active=1").get() as any).c;
    const pending = (this.db.prepare("SELECT COUNT(*) as c FROM request_replies WHERE status='pending'").get() as any).c;
    const blocked7d = (this.db.prepare("SELECT COUNT(*) as c FROM blocked_log WHERE timestamp>datetime('now','-7 days')").get() as any).c;
    const tables = this.listTables();
    return {
      active_contacts: contacts,
      pending_requests: pending,
      blocked_7d: blocked7d,
      tables: tables.map((t: any) => ({ name: t.table_name, type: t.created_by, rows: t.row_count })),
    };
  }

  // ─── Utils ─────────────────────────────────────────────────────

  normPhone(phone: string): string {
    let c = (phone || "").replace(/[^\d+]/g, "");
    if (!c.startsWith("+")) {
      if (this.defaultCC) {
        if (c.startsWith("0")) c = c.substring(1);
        c = this.defaultCC + c;
      } else {
        c = "+" + c;
      }
    }
    return c;
  }

  private genId(prefix: string): string {
    const s = prefix.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const ts = Date.now().toString(36).slice(-6);
    const rand = Math.random().toString(36).slice(2, 6);
    return `${s}-${ts}${rand}`;
  }

  private lev(a: string, b: string): number {
    const m = a.length, n = b.length;
    const d: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
    for (let i = 0; i <= m; i++) d[i][0] = i;
    for (let j = 0; j <= n; j++) d[0][j] = j;
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        d[i][j] = a[i - 1] === b[j - 1] ? d[i - 1][j - 1] : 1 + Math.min(d[i - 1][j], d[i][j - 1], d[i - 1][j - 1]);
      }
    }
    return d[m][n];
  }

  close() { this.db.close(); }
}
