import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Quota, QuotaWindow } from "../../shared/contracts";

const CACHE_MS = 90_000;
const cache = new Map<string, { at: number; value: Quota | null }>();
const ENDPOINT = "https://opencode.ai/zen/go/v1/usage";

/** Window key, label, and the length the plan documents. */
const WINDOWS: Array<[string, string, string]> = [
  ["rolling", "Rolling 5-hour", "5h"],
  ["weekly", "Weekly", "wk"],
  ["monthly", "Monthly", "mo"],
];

const isoDate = (value: unknown): string | null => {
  if (typeof value !== "string" || !value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
};

/**
 * A runtime without `node:sqlite` still reads `auth.json`, so a failed import must not reject:
 * it is caught here and the caller falls through to the JSON path.
 */
let sqliteLoader: Promise<any> | null = null;
function loadSqlite(): Promise<any> {
  sqliteLoader ??= import("node:sqlite").catch(() => {
    throw new Error("this runtime has no node:sqlite");
  });
  return sqliteLoader;
}

/**
 * OpenCode keeps provider logins either in `auth.json` under its data home or in `opencode.db`,
 * depending on version. A per-account provider gets its own data home, so both are tried there.
 */
async function readGoKey(dataHome: string): Promise<string | null> {
  const authPath = join(dataHome, "opencode", "auth.json");
  if (existsSync(authPath)) {
    try {
      const auth = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, any>;
      for (const id of ["opencode-go", "opencode"]) {
        const entry = auth?.[id];
        const key = String(entry?.key ?? entry?.access ?? "");
        if (key) return key;
      }
    } catch {
      // Fall through to the database.
    }
  }

  const dbPath = join(dataHome, "opencode", "opencode.db");
  if (!existsSync(dbPath)) return null;
  try {
    const { DatabaseSync } = await loadSqlite();
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const rows = db
        .prepare("SELECT integration_id, value FROM credential WHERE active = 1")
        .all() as Array<{ integration_id: string; value: string }>;
      for (const row of rows) {
        if (row.integration_id !== "opencode-go" && row.integration_id !== "opencode") continue;
        const parsed = JSON.parse(row.value) as Record<string, unknown>;
        const key = String(parsed?.key ?? parsed?.access ?? "");
        if (key) return key;
      }
      return null;
    } finally {
      db.close?.();
    }
  } catch {
    return null;
  }
}

/** Pure window mapping, so the Go plan's percent payload can be tested offline. */
export function parseGoUsage(body: { usage?: Record<string, any> }): QuotaWindow[] {
  const usage = body.usage ?? {};
  const windows: QuotaWindow[] = [];
  for (const [id, label, shortLabel] of WINDOWS) {
    const entry = usage[id];
    if (!entry || typeof entry.percent !== "number") continue;
    windows.push({
      id,
      label,
      shortLabel,
      // `status: "rate-limited"` still means a full window, so clamp rather than drop it.
      usedPct: Math.max(0, Math.min(Number(entry.percent), 100)),
      resetsAt: isoDate(entry.resetsAt),
    });
  }
  return windows;
}

/**
 * OpenCode Go reports percentages per window, not token counts. The endpoint is undocumented but
 * stable enough that several clients depend on it; a failure here never invents a number.
 */
export async function readGoQuota(
  dataHome: string,
  opts: { forceRefresh?: boolean } = {},
): Promise<Quota | null> {
  const cached = cache.get(dataHome);
  if (!opts.forceRefresh && cached && Date.now() - cached.at < CACHE_MS) return cached.value;

  const key = await readGoKey(dataHome);
  if (!key) {
    cache.set(dataHome, { at: Date.now(), value: null });
    return null;
  }

  try {
    const response = await fetch(ENDPOINT, {
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: "application/json",
        // Cloudflare rejects the default fetch user agent on this host.
        "User-Agent": "tallimeter/1.0",
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      cache.set(dataHome, { at: Date.now(), value: null });
      return null;
    }
    const body = (await response.json()) as { usage?: Record<string, any> };
    const windows = parseGoUsage(body);

    const value: Quota | null =
      windows.length > 0
        ? {
            source: "opencode-go",
            planLabel: "OpenCode Go",
            windows,
            balanceUsd: null,
            balanceLimitUsd: null,
            balanceUnit: null,
            note: null,
            fetchedAt: new Date().toISOString(),
          }
        : null;
    cache.set(dataHome, { at: Date.now(), value });
    return value;
  } catch {
    cache.set(dataHome, { at: Date.now(), value: null });
    return null;
  }
}
