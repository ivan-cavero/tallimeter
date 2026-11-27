import type { Quota, QuotaWindow } from "../../shared/contracts";

/**
 * Ollama Cloud has documented billing endpoints, so nothing is guessed.
 *
 *   GET /api/balance  → included.balance_usd + included.allowance_usd + included.period,
 *                       or, for legacy plans, included.session/weekly.remaining_percent.
 *   GET /api/usage    → spend history. Not used for the meter: it is gross consumption, not a cap.
 *
 * Both allow 10 requests per minute per user, so one read per 90 s is well inside the budget.
 */
const BASE = "https://ollama.com/api";
const CACHE_MS = 90_000;

const cache = new Map<string, { at: number; value: Quota | null }>();

const iso = (value: unknown): string | null => {
  if (typeof value !== "string" || !value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
};

const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

interface LegacyWindow {
  remaining_percent?: unknown;
  resets_at?: unknown;
}

/** Pure mapping of `GET /api/balance`, for both the per-token and the legacy plan shapes. */
export function parseOllamaBalance(body: Record<string, any>): Quota {
  const included = (body.included ?? {}) as Record<string, any>;
  const windows: QuotaWindow[] = [];

  const allowance = num(included.allowance_usd);
  const balance = num(included.balance_usd);
  if (allowance !== null && allowance > 0 && balance !== null) {
    const used = Math.max(allowance - balance, 0);
    windows.push({
      id: "monthly",
      label: "Monthly allowance",
      shortLabel: "mo",
      summary: true,
      usedPct: Math.max(0, Math.min((used / allowance) * 100, 100)),
      resetsAt: iso(included.period?.until),
      durationSeconds: 2_592_000,
    });
  }

  for (const [id, label, shortLabel, durationSeconds] of [
    ["session", "Session", "5h", 18_000],
    ["weekly", "Weekly", "wk", 604_800],
  ] as const) {
    const legacy = included[id] as LegacyWindow | undefined;
    const remaining = num(legacy?.remaining_percent);
    if (remaining === null) continue;
    windows.push({
      id,
      label,
      shortLabel,
      usedPct: Math.max(0, Math.min(100 - remaining, 100)),
      resetsAt: iso(legacy?.resets_at),
      durationSeconds,
    });
  }

  const purchased = num((body.purchased ?? {}).balance_usd);
  return {
    source: "ollama",
    planLabel: windows.some((window) => window.id === "monthly")
      ? "Ollama Cloud"
      : windows.length > 0
        ? "Ollama Cloud (legacy plan)"
        : "Ollama Cloud",
    windows,
    balanceUsd: purchased,
    balanceLimitUsd: null,
    balanceUnit: "usd",
    note:
      windows.length === 0 && purchased === null
        ? "No readable allowance on this key"
        : purchased !== null
          ? "Purchased credits are spent after the included allowance"
          : null,
    fetchedAt: new Date().toISOString(),
  };
}

export async function readOllamaQuota(
  apiKey: string,
  opts: { forceRefresh?: boolean } = {},
): Promise<Quota | null> {
  if (!apiKey) return null;
  const cacheKey = apiKey.slice(-8);
  const cached = cache.get(cacheKey);
  if (!opts.forceRefresh && cached && Date.now() - cached.at < CACHE_MS) return cached.value;

  try {
    const response = await fetch(`${BASE}/balance`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      cache.set(cacheKey, { at: Date.now(), value: null });
      return null;
    }
    const body = (await response.json()) as Record<string, any>;
    const value = parseOllamaBalance(body);
    const usable = value.windows.length > 0 || value.balanceUsd !== null ? value : null;
    cache.set(cacheKey, { at: Date.now(), value: usable });
    return usable;
  } catch {
    cache.set(cacheKey, { at: Date.now(), value: null });
    return null;
  }
}
