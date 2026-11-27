import type { Quota, QuotaWindow } from "../../shared/contracts";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * Codex (ChatGPT plan) keeps its login in `$CODEX_HOME/auth.json`, and the Codex CLI exposes the
 * plan windows through its own RPC. The CLI route is preferred because it is the vendor's own
 * surface; a missing CLI means no reading rather than a scraped web dashboard.
 */
const CACHE_MS = 90_000;
const cache = new Map<string, { at: number; value: Quota | null }>();

const iso = (value: unknown): string | null => {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const parsed = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
};

const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

interface CodexAuth {
  tokens?: { access_token?: string; account_id?: string };
  OPENAI_API_KEY?: string;
}

function readCodexAuth(codexHome: string): CodexAuth | null {
  for (const path of [join(codexHome, "auth.json"), join(homedir(), ".codex", "auth.json")]) {
    if (!existsSync(path)) continue;
    try {
      return JSON.parse(readFileSync(path, "utf8")) as CodexAuth;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * `account/rateLimits/read` through the Codex app-server is the documented path. It needs the CLI
 * and a live process, so this uses `codex` only when it is installed: a plugin must not fork a
 * heavy process per refresh, and the CLI is the only honest source for these windows.
 */
/**
 * Pure mapping of the ChatGPT backend usage body. Two shapes exist in the wild: a nested
 * `rate_limits` object with camelCase keys, and a flat body with snake_case ones.
 */
export function parseCodexUsage(body: Record<string, any>): Quota {
  const windows: QuotaWindow[] = [];
  const roots = [body.rate_limits, body.rateLimits, body].filter(Boolean) as Array<Record<string, any>>;
  const pairs: Array<[string, string, string, number, string[]]> = [
    ["five_hour", "5-hour", "5h", 18_000, ["five_hour", "fiveHour", "primary"]],
    ["weekly", "Weekly", "wk", 604_800, ["weekly", "seven_day", "secondary"]],
  ];
  for (const [id, label, shortLabel, durationSeconds, aliases] of pairs) {
    for (const root of roots) {
      const entry = aliases
        .map((alias) => root[alias])
        .find((candidate) => candidate && typeof candidate === "object");
      if (!entry) continue;
      const used =
        num((entry as Record<string, any>).used_percent) ??
        num((entry as Record<string, any>).usedPercent) ??
        num((entry as Record<string, any>).percent);
      if (used === null) continue;
      windows.push({
        id,
        label,
        shortLabel,
        usedPct: Math.max(0, Math.min(used, 100)),
        resetsAt: iso(
          (entry as Record<string, any>).resets_at ??
            (entry as Record<string, any>).resetsAt ??
            (entry as Record<string, any>).reset_at,
        ),
        durationSeconds,
      });
      break;
    }
  }
  const credits = body.credits as Record<string, unknown> | undefined;
  return {
    source: "openai",
    planLabel: "ChatGPT plan",
    windows,
    balanceUsd: credits ? num(credits.balance_usd ?? credits.balanceUsd) : null,
    balanceLimitUsd: null,
    balanceUnit: "usd",
    note: windows.length === 0 ? "The dashboard reported no windows for this account" : null,
    fetchedAt: new Date().toISOString(),
  };
}

export async function readCodexQuota(
  codexHome: string,
  opts: { forceRefresh?: boolean } = {},
): Promise<Quota | null> {
  const auth = readCodexAuth(codexHome);
  if (!auth) return null;
  const cacheKey = String(auth.tokens?.account_id ?? "codex");
  const cached = cache.get(cacheKey);
  if (!opts.forceRefresh && cached && Date.now() - cached.at < CACHE_MS) return cached.value;

  // No CLI and no readable token: report nothing rather than guessing from local usage.
  const token = auth.tokens?.access_token;
  if (!token) {
    cache.set(cacheKey, { at: Date.now(), value: null });
    return null;
  }

  try {
    // The plan windows live behind the ChatGPT backend, which accepts the Codex access token.
    const response = await fetch("https://chatgpt.com/backend-api/wham/usage", {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "User-Agent": "tallimeter/1.0",
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      cache.set(cacheKey, { at: Date.now(), value: null });
      return null;
    }
    const body = (await response.json()) as Record<string, any>;
    const value = parseCodexUsage(body);
    const usable = value.windows.length > 0 ? value : null;
    cache.set(cacheKey, { at: Date.now(), value: usable });
    return usable;
  } catch {
    cache.set(cacheKey, { at: Date.now(), value: null });
    return null;
  }
}
