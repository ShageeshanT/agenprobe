/**
 * Bot instance management.
 *
 * An "instance" is a single bot you're testing — identified by a name
 * like "echo-staging" or "client-x-prod". Each instance has its own
 * platform, connection credentials, pairing key, and report history.
 *
 * Instance configs live as individual JSON files under `instances/`.
 * This replaces the old `.env`-based approach where one file held one
 * bot's config and connecting a new bot overwrote the old one.
 *
 * Migration from .env: on first boot with no instances/ directory, the
 * server creates one auto-migrated instance from the existing .env vars
 * so nothing breaks for existing users.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { extname, join } from "node:path";

export type InstancePlatform = "openclaw" | "hermes";

export interface BotInstance {
  /** Unique name used as the filename, route param, and display label. */
  name: string;
  /** Which adapter to use. */
  platform: InstancePlatform;
  /** When this instance was created. */
  createdAt: string;

  // ---- OpenClaw fields ----
  /** Public gateway URL. */
  gatewayUrl?: string;
  /** Gateway auth token. */
  gatewayToken?: string;
  /** Agent id (default "main"). */
  agentId?: string;

  // ---- Railway SSH coordinates (shared by both platforms) ----
  railwayProject?: string;
  railwayEnvironment?: string;
  railwayService?: string;

  /**
   * Filename (relative to .agentprobe-keys/) for this instance's Ed25519
   * pairing key. Each instance gets its own key so different gateways
   * have independent pairing state.
   */
  pairingKeyFilename?: string;
}

/**
 * Sanitize a user-provided name to be safe as a filename and route param.
 * Allows lowercase alphanumeric, dashes, underscores, and dots. Max 64
 * chars.
 */
export function sanitizeInstanceName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "default";
}

export interface InstanceStore {
  /** List all saved instances, sorted by name. */
  list(): BotInstance[];
  /** Get a single instance by name. */
  get(name: string): BotInstance | undefined;
  /** Save (create or update) an instance. */
  save(instance: BotInstance): void;
  /** Delete an instance by name. */
  remove(name: string): boolean;
  /** Path to the instances directory. */
  readonly dir: string;
}

/**
 * Filesystem-backed instance store. Each instance lives at
 * `<dir>/<name>.json`.
 */
export function createInstanceStore(dir: string): InstanceStore {
  const ensure = () => {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  };

  return {
    dir,

    list(): BotInstance[] {
      if (!existsSync(dir)) return [];
      return readdirSync(dir)
        .filter((f) => extname(f).toLowerCase() === ".json")
        .sort()
        .map((f) => {
          try {
            const raw = readFileSync(join(dir, f), "utf8");
            const parsed = JSON.parse(raw);
            if (isInstance(parsed)) return parsed;
          } catch {
            /* skip malformed files */
          }
          return null;
        })
        .filter((v): v is BotInstance => v !== null);
    },

    get(name: string): BotInstance | undefined {
      const filePath = join(dir, `${name}.json`);
      if (!existsSync(filePath)) return undefined;
      try {
        const raw = readFileSync(filePath, "utf8");
        const parsed = JSON.parse(raw);
        if (isInstance(parsed)) return parsed;
      } catch {
        /* ignore */
      }
      return undefined;
    },

    save(instance: BotInstance): void {
      ensure();
      const filePath = join(dir, `${instance.name}.json`);
      writeFileSync(filePath, JSON.stringify(instance, null, 2), {
        encoding: "utf8",
      });
    },

    remove(name: string): boolean {
      const filePath = join(dir, `${name}.json`);
      if (!existsSync(filePath)) return false;
      unlinkSync(filePath);
      return true;
    },
  };
}

/**
 * If no instances/ directory exists (or it's empty), auto-migrate from
 * the legacy .env variables into one or two instances. Returns true if
 * a migration happened.
 */
export function migrateFromEnv(store: InstanceStore): boolean {
  const existing = store.list();
  if (existing.length > 0) return false;

  let migrated = false;

  // OpenClaw from .env
  const ocUrl = process.env.OPENCLAW_GATEWAY_URL;
  if (ocUrl) {
    const inst: BotInstance = {
      name: "default-openclaw",
      platform: "openclaw",
      createdAt: new Date().toISOString(),
      gatewayUrl: ocUrl,
      agentId: process.env.OPENCLAW_AGENT_ID ?? "main",
      pairingKeyFilename: "openclaw-ed25519.pem",
    };
    const token = process.env.OPENCLAW_GATEWAY_TOKEN;
    if (token) inst.gatewayToken = token;
    const rp = process.env.RAILWAY_PROJECT;
    const re = process.env.RAILWAY_ENVIRONMENT;
    const rs = process.env.RAILWAY_SERVICE;
    if (rp && re && rs) {
      inst.railwayProject = rp;
      inst.railwayEnvironment = re;
      inst.railwayService = rs;
    }
    store.save(inst);
    migrated = true;
  }

  // Hermes from .env
  const hp = process.env.HERMES_RAILWAY_PROJECT;
  const he = process.env.HERMES_RAILWAY_ENVIRONMENT;
  const hs = process.env.HERMES_RAILWAY_SERVICE;
  if (hp && he && hs) {
    store.save({
      name: "default-hermes",
      platform: "hermes",
      createdAt: new Date().toISOString(),
      railwayProject: hp,
      railwayEnvironment: he,
      railwayService: hs,
    });
    migrated = true;
  }

  return migrated;
}

function isInstance(v: unknown): v is BotInstance {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.name === "string" &&
    (o.platform === "openclaw" || o.platform === "hermes") &&
    typeof o.createdAt === "string"
  );
}
