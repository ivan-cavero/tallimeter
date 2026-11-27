import type { Quota, QuotaWindow } from "../../shared/contracts";

/**
 * Kimi Code / Kimi For Coding.
 *
 *   GET https://api.kimi.com/coding/v1/usages
 *   Authorization: Bearer $KIMI_API_KEY
 *
 * Two shapes exist on this account surface:
 *
 *   `limits[]` — count-based windows. `window.duration` plus `timeUnit` gives the length, and
 *   `detail.{limit, used, remaining, resetTime}` are **strings**. A live row may omit `used`
 *   entirely (zero usage) and may omit both counters, so a positive `limit` with no counters is
 *   zero usage, never a parse failure.
 *
 *   `usages{}` — ratio pools keyed by name: `limit_5h`, `limit_7d`, `limit_month_total`,
 *   `limit_month_code`. `used_ratio` is a **fraction 0..1**, so it multiplies to percent.
 *   `limit_month_code` is the Code slice inside the monthly pool, never a second allowance, so it
 *   is ignored.
 *
 * The older shape has a top-level `usage` block, which is the weekly counter.
 */
const ENDPOINT = "https://api.kimi.com/coding/v1/usages";
const CACHE_MS = 90_000;
const cache = new Map<string, { at: number; value: Quota | null }>();

const iso = (value: unknown): string | null => {
  if (typeof value !== "string" || !value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
};

/** Counts arrive as strings, numbers, or absent. Absent is zero, not an error. */
const count = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

interface CountBlock {
  limit?: unknown;
  used?: unknown;
  remaining?: unknown;
  resetTime?: unknown;
  resetAt?: unknown;
  reset_at?: unknown;
}

/** Turns a count block into a used percentage. `remaining` is authoritative when `used` is absent. */
export function percentFromCounts(block: CountBlock): { usedPct: number; resetsAt: string | null } | null {
  const limit = count(block?.limit);
  if (limit === null || limit <= 0) return null;
  const used = count(block?.used);
  const remaining = count(block?.remaining);
  const usedCount = used ?? (remaining !== null ? Math.max(limit - remaining, 0) : 0);
  return {
    usedPct: Math.max(0, Math.min((usedCount / limit) * 100, 100)),
    resetsAt: iso(block?.resetTime ?? block?.resetAt ?? block?.reset_at),
  };
}

/** Window length in seconds from `{ duration, timeUnit }`, where the unit may carry a prefix. */
function windowSeconds(window: Record<string, any> | undefined): number | null {
  if (!window) return null;
  const duration = count(window.duration);
  if (duration === null || duration <= 0) return null;
  const unit = String(window.timeUnit ?? window.time_unit ?? "").replace(/^TIME_UNIT_/, "").toUpperCase();
  if (unit.startsWith("MINUTE")) return duration * 60;
  if (unit.startsWith("HOUR")) return duration * 3_600;
  if (unit.startsWith("DAY")) return duration * 86_400;
  if (unit.startsWith("SECOND")) return duration;
  return null;
}

const windowName = (seconds: number | null): { id: string; label: string; shortLabel: string } => {
  if (seconds === 18_000) return { id: "five_hour", label: "5-hour", shortLabel: "5h" };
  if (seconds === 604_800) return { id: "weekly", label: "Weekly", shortLabel: "wk" };
  if (seconds !== null && seconds >= 2_000_000) return { id: "monthly", label: "Monthly", shortLabel: "mo" };
  if (seconds !== null) return { id: `w${Math.round(seconds / 3_600)}`, label: `${Math.round(seconds / 3_600)}h window`, shortLabel: "win" };
  return { id: "window", label: "Limit", shortLabel: "lim" };
};

export function parseKimiUsages(body: Record<string, any>): Quota | null {
  const windows: QuotaWindow[] = [];

  // Count-based windows first: they are the vendor's own advertised windows.
  const limits = Array.isArray(body.limits) ? (body.limits as Array<Record<string, any>>) : [];
  for (const entry of limits) {
    const seconds = windowSeconds(entry.window as Record<string, any> | undefined);
    const parsed = percentFromCounts((entry.detail ?? {}) as CountBlock);
    if (!parsed) continue;
    windows.push({ ...windowName(seconds), ...parsed, durationSeconds: seconds ?? undefined });
  }

  // The legacy top-level weekly counter.
  if (body.usage && typeof body.usage === "object") {
    const parsed = percentFromCounts(body.usage as CountBlock);
    if (parsed && !windows.some((window) => window.id === "weekly")) {
      windows.push({ id: "weekly", label: "Weekly", shortLabel: "wk", ...parsed, durationSeconds: 604_800 });
    }
  }

  // Ratio pools, only for a window the count list did not already cover.
  const ratios = (body.usages ?? {}) as Record<string, Record<string, unknown>>;
  for (const [key, id, label, shortLabel, durationSeconds] of [
    ["limit_5h", "five_hour", "5-hour", "5h", 18_000],
    ["limit_7d", "weekly", "Weekly", "wk", 604_800],
    ["limit_month_total", "monthly", "Monthly", "mo", 2_592_000],
  ] as const) {
    if (windows.some((window) => window.id === id)) continue;
    const ratio = count(ratios[key]?.used_ratio);
    if (ratio === null || ratio < 0 || ratio > 1) continue;
    windows.push({
      id,
      label,
      shortLabel,
      usedPct: ratio * 100,
      resetsAt: iso(ratios[key]?.reset_time),
      durationSeconds,
    });
  }

  if (windows.length === 0) return null;
  const level = String(body.user?.membership?.level ?? "");
  return {
    source: "kimi",
    planLabel: level ? `Kimi ${level}` : "Kimi Code",
    windows,
    balanceUsd: null,
    balanceLimitUsd: null,
    balanceUnit: null,
    note: null,
    fetchedAt: new Date().toISOString(),
  };
}

export async function readKimiQuota(
  apiKey: string,
  opts: { forceRefresh?: boolean } = {},
): Promise<Quota | null> {
  if (!apiKey) return null;
  const cacheKey = apiKey.slice(-8);
  const cached = cache.get(cacheKey);
  if (!opts.forceRefresh && cached && Date.now() - cached.at < CACHE_MS) return cached.value;

  try {
    const response = await fetch(ENDPOINT, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      cache.set(cacheKey, { at: Date.now(), value: null });
      return null;
    }
    const value = parseKimiUsages((await response.json()) as Record<string, any>);
    cache.set(cacheKey, { at: Date.now(), value });
    return value;
  } catch {
    cache.set(cacheKey, { at: Date.now(), value: null });
    return null;
  }
}
