import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";


export type Kind = "claude" | "opencode" | "pi" | "opendesign" | "other";

export interface Turn {
  at: number;
  /** Who served the turn: a gateway, a plan, a vendor. Turns are attributed by this, not by store. */
  provider: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  cost: number | null;
}

/** Which provider owns the subscription allowance for this account, if any. */
export type QuotaKind = "anthropic" | "opencode-go" | "opendesign" | "opendesign-or-anthropic" | "none";

export interface StoreRef {
  id: string;
  label: string;
  provider: string;
  kind: Kind;
  store: string;
  reader: "claude-jsonl" | "opencode-sqlite" | "pi-jsonl";
  quotaKind: QuotaKind;
  /** OpenCode provider logins live under this data home; unset for the default account. */
  dataHome?: string;
  /**
   * Vendors this store can produce allowance for, discovered from the turns it holds. A single
   * OpenCode database can serve OpenDesign and OpenCode at once, so this is not fixed config.
   */
  providers?: string[];
}

const HOME = homedir();

function listFilesRecursive(dir: string, ext: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) listFilesRecursive(path, ext, out);
    else if (entry.name.endsWith(ext)) out.push(path);
  }
  return out;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/* ------------------------------ Claude Code ------------------------------ */

function readClaudeTurns(storeDir: string, since: number): Turn[] {
  const projectsDir = join(storeDir, "projects");
  const turns: Turn[] = [];
  for (const file of listFilesRecursive(projectsDir, ".jsonl")) {
    let mtime = 0;
    try {
      mtime = statSync(file).mtimeMs;
    } catch {
      continue;
    }
    // Cheap pre-filter: a transcript untouched since the period cannot contribute.
    if (mtime < since - 36 * 3600_000) continue;
    let raw = "";
    try {
      raw = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n")) {
      if (!line || line[0] !== "{") continue;
      let row: any;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      const usage = row?.message?.usage;
      if (!usage) continue;
      const stamp = row.timestamp ? Date.parse(row.timestamp) : NaN;
      if (!Number.isFinite(stamp) || stamp < since) continue;
      turns.push({
        at: stamp,
        provider: "anthropic",
        model: String(row?.message?.model ?? row?.model ?? "unknown"),
        input: num(usage.input_tokens),
        output: num(usage.output_tokens),
        cacheRead: num(usage.cache_read_input_tokens),
        cacheWrite: num(usage.cache_creation_input_tokens),
        reasoning: 0,
        cost: null,
      });
    }
  }
  return turns;
}

/* -------------------------------- OpenCode ------------------------------- */

/**
 * The plugin bundle is an ES module and Paseo rewrites `import.meta`, so `node:sqlite` is loaded
 * with a dynamic import. That also keeps the module optional: a runtime without it fails here only,
 * not when the plugin starts.
 */
let sqliteModule: Promise<any> | null = null;
function loadSqlite(): Promise<any> {
  sqliteModule ??= import("node:sqlite").catch(() => {
    throw new Error("This Paseo runtime has no node:sqlite, so OpenCode usage cannot be read");
  });
  return sqliteModule;
}

async function readOpencodeTurns(dbPath: string, since: number): Promise<Turn[]> {
  if (!existsSync(dbPath)) return [];
  const { DatabaseSync } = await loadSqlite();
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db
      .prepare(
        "SELECT data, time_created FROM session_message WHERE type='assistant' AND time_created >= ?",
      )
      .all(since);
    const turns: Turn[] = [];
    for (const row of rows) {
      let parsed: any;
      try {
        parsed = JSON.parse(row.data);
      } catch {
        continue;
      }
      const tokens = parsed?.tokens;
      if (!tokens) continue;
      turns.push({
        at: num(row.time_created),
        // One OpenCode database can hold several providers, so attribution has to come from here.
        provider: String(parsed?.model?.providerID ?? "opencode"),
        model: String(parsed?.model?.id ?? "unknown"),
        input: num(tokens.input),
        output: num(tokens.output),
        cacheRead: num(tokens.cache?.read),
        cacheWrite: num(tokens.cache?.write),
        reasoning: num(tokens.reasoning),
        cost: typeof parsed.cost === "number" ? parsed.cost : null,
      });
    }
    return turns;
  } finally {
    db.close?.();
  }
}

/* ----------------------------------- Pi ---------------------------------- */

function readPiTurns(agentDir: string, since: number): Turn[] {
  const turns: Turn[] = [];
  for (const file of listFilesRecursive(join(agentDir, "sessions"), ".jsonl")) {
    let raw = "";
    try {
      raw = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n")) {
      if (!line || line[0] !== "{") continue;
      let row: any;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      if (row?.type !== "message") continue;
      const usage = row?.message?.usage;
      if (!usage) continue;
      const stamp = row.timestamp ? Date.parse(row.timestamp) : NaN;
      if (!Number.isFinite(stamp) || stamp < since) continue;
      turns.push({
        at: stamp,
        provider: String(row?.message?.provider ?? "pi"),
        model: String(row?.message?.model ?? "unknown"),
        input: num(usage.input),
        output: num(usage.output),
        cacheRead: num(usage.cacheRead),
        cacheWrite: num(usage.cacheWrite),
        reasoning: num(usage.reasoning),
        cost: typeof usage.cost?.total === "number" ? usage.cost.total : null,
      });
    }
  }
  return turns;
}

/**
 * How far back any reader looks. The aggregation needs the current billing cycle plus the 30-day
 * trend window, so 100 days covers a 31-day cycle with its trend and leaves margin; nothing older
 * can affect a number on screen, and skipping it is what keeps a poll cheap.
 */
const READ_HORIZON_MS = 100 * 86_400_000;

/**
 * Assembled turns per store, so a refresh does not re-parse the same transcripts. One minute is
 * enough: the screen polls every fifteen seconds and no allowance changes meaningfully that fast.
 * A cached entry keeps turns from the horizon of *its* read, so a caller asking for an older
 * `since` is served correctly as long as both use the same horizon.
 */
const turnCache = new Map<string, { at: number; turns: Turn[] }>();
const TURN_CACHE_MS = 60_000;

/**
 * Turns from `since` onward. Readers get a fixed horizon rather than the caller's `since`, which
 * is what makes the cache safe: every cold read covers the same span, and filtering happens
 * afterwards. Before this, the aggregator asked for the epoch, so the Claude reader parsed years
 * of transcripts on every refresh and its mtime prefilter never fired.
 */
export async function readTurns(ref: StoreRef, since: number): Promise<Turn[]> {
  const key = `${ref.reader}:${ref.store}`;
  const cached = turnCache.get(key);
  if (cached && Date.now() - cached.at < TURN_CACHE_MS) {
    return cached.turns.filter((turn) => turn.at >= since);
  }

  const floor = Date.now() - READ_HORIZON_MS;
  const read = async (): Promise<Turn[]> => {
    switch (ref.reader) {
      case "claude-jsonl":
        return readClaudeTurns(ref.store, floor);
      case "opencode-sqlite":
        return readOpencodeTurns(ref.store, floor);
      case "pi-jsonl":
        return readPiTurns(ref.store, floor);
    }
  };
  const turns = await read();
  turnCache.set(key, { at: Date.now(), turns });
  return turns.filter((turn) => turn.at >= since);
}

/* ------------------------------- Discovery ------------------------------- */

export function expandHome(value: string): string {
  return value.startsWith("~/") ? join(HOME, value.slice(2)) : value;
}

interface ProviderConfig {
  extends?: string;
  label?: string;
  enabled?: boolean;
  env?: Record<string, string>;
  models?: { id?: string; isDefault?: boolean }[];
}

export function readProviderConfig(): Record<string, ProviderConfig> {
  try {
    const raw = readFileSync(join(HOME, ".paseo", "config.json"), "utf8");
    const parsed = JSON.parse(raw);
    return parsed?.agents?.providers ?? {};
  } catch {
    return {};
  }
}

function kindOf(providerId: string, cfg: ProviderConfig): Kind {
  const base = cfg.extends ?? providerId;
  const env = cfg.env ?? {};
  const baseUrl = String(env.ANTHROPIC_BASE_URL ?? env.OPENAI_BASE_URL ?? "");
  if (baseUrl.includes("open-design") || baseUrl.includes("amr-link")) return "opendesign";
  if (base === "claude") return "claude";
  if (base === "opencode") return "opencode";
  if (base === "pi" || base === "omp") {
    if (baseUrl.includes("open-design")) return "opendesign";
    return "pi";
  }
  return "other";
}

/** A third-party base URL means the account is a gateway key, not an Anthropic subscription. */
function hasGateway(env: Record<string, string>): boolean {
  const base = String(env.ANTHROPIC_BASE_URL ?? "");
  return base !== "" && !base.includes("api.anthropic.com");
}

/**
 * Builds the list of usage stores from Paseo's provider config, so one provider entry
 * equals one account card. Disabled providers and stores without usage data are skipped.
 */
export function discoverStores(): StoreRef[] {
  const providers = readProviderConfig();
  const stores: StoreRef[] = [];
  const seen = new Set<string>();

  const push = (ref: StoreRef) => {
    const dedupe = `${ref.reader}:${ref.store}`;
    if (seen.has(dedupe)) return;
    seen.add(dedupe);
    if (!existsSync(ref.store)) return;
    stores.push(ref);
  };

  for (const [providerId, cfg] of Object.entries(providers)) {
    if (!cfg || cfg.enabled === false) continue;
    const env = cfg.env ?? {};
    const label = cfg.label ?? providerId;
    const base = cfg.extends ?? providerId;
    const kind = kindOf(providerId, cfg);

    if (base === "claude") {
      const dir = expandHome(env.CLAUDE_CONFIG_DIR ?? join(HOME, ".claude"));
      push({
        id: providerId,
        label,
        provider: providerId,
        kind,
        store: dir,
        reader: "claude-jsonl",
        // A gateway base URL means no Anthropic subscription: only a real login has 5h/weekly windows.
        quotaKind:
          kind === "opendesign" || kind === "claude"
            ? kind === "claude" && hasGateway(env)
              ? "none"
              : "opendesign-or-anthropic"
            : "none",
      });
      continue;
    }

    if (base === "opencode") {
      const dataHome = expandHome(env.XDG_DATA_HOME ?? join(HOME, ".local/share"));
      push({
        id: providerId,
        label,
        provider: providerId,
        kind,
        store: join(dataHome, "opencode", "opencode.db"),
        reader: "opencode-sqlite",
        quotaKind: "opencode-go",
        dataHome,
      });
      continue;
    }

    if (base === "pi" || base === "omp") {
      const agentDir = expandHome(env.PI_CODING_AGENT_DIR ?? join(HOME, ".pi", "agent"));
      push({
        id: providerId,
        label,
        provider: providerId,
        kind,
        store: agentDir,
        reader: "pi-jsonl",
        quotaKind: "none",
      });
    }
  }

  // Built-in entries that have no config override but do have data on disk.
  push({
    id: "claude-default",
    label: "Claude (default)",
    provider: "claude",
    kind: "claude",
    store: join(HOME, ".claude"),
    reader: "claude-jsonl",
    quotaKind: "anthropic",
  });
  const defaultDataHome = expandHome(join(HOME, ".local", "share"));
  push({
    id: "opencode-default",
    label: "OpenCode (default)",
    provider: "opencode",
    kind: "opencode",
    store: join(defaultDataHome, "opencode", "opencode.db"),
    reader: "opencode-sqlite",
    quotaKind: "opencode-go",
    dataHome: defaultDataHome,
  });
  push({
    id: "pi-default",
    label: "Pi (default)",
    provider: "pi",
    kind: "pi",
    store: join(HOME, ".pi", "agent"),
    reader: "pi-jsonl",
    quotaKind: "none",
  });

  return stores;
}
