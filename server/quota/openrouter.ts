import type { Quota, QuotaWindow } from "../../shared/contracts";

/**
 * OpenRouter: one inference key can read its own allowance. `GET /api/v1/key` returns a per-key
 * credit cap and daily/weekly/monthly spend; the account Credits endpoint needs a *management*
 * key, so it is never requested from an inference key (it answers 403).
 *
 * Shape, verified against the published reference:
 *   data.limit / limit_remaining / limit_reset, data.usage_daily / weekly / monthly,
 *   data.effective_budget.limit_usd / spend_usd / resets_at / reset_interval.
 */
const ENDPOINT = "https://openrouter.ai/api/v1/key";
const CACHE_MS = 90_000;

const cache = new Map<string, { at: number; value: Quota | null }>();

const iso = (value: unknown): string | null => {
  if (typeof value !== "string" || !value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
};

const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/** Pure mapping of `GET /api/v1/key`. A free-tier key has no cap, so it gets no window. */
export function parseOpenRouterKey(data: Record<string, any>): Quota {
  const windows: QuotaWindow[] = [];
  const budget = data.effective_budget as Record<string, any> | null | undefined;
  const limitUsd = num(budget?.limit_usd) ?? num(data.limit);
  const spendUsd = num(budget?.spend_usd);
  if (limitUsd !== null && limitUsd > 0 && spendUsd !== null) {
    const interval = String(budget?.reset_interval ?? data.limit_reset ?? "");
    windows.push({
      id: interval ? `key_${interval}` : "key",
      label: interval ? `Key budget · ${interval}` : "Key budget",
      shortLabel: interval === "weekly" ? "wk" : interval === "monthly" ? "mo" : interval === "daily" ? "day" : "cap",
      usedPct: Math.max(0, Math.min((spendUsd / limitUsd) * 100, 100)),
      resetsAt: iso(budget?.resets_at),
      durationSeconds:
        interval === "daily" ? 86_400 : interval === "weekly" ? 604_800 : interval === "monthly" ? 2_592_000 : undefined,
    });
  }
  return {
    source: "openrouter",
    planLabel: data.is_free_tier ? "Free tier" : "OpenRouter credits",
    windows,
    balanceUsd: num(data.limit_remaining),
    balanceLimitUsd: limitUsd,
    balanceUnit: "usd",
    note: data.is_free_tier ? "Free tier: the daily free-model request cap is not a spend window" : null,
    fetchedAt: new Date().toISOString(),
  };
}

export async function readOpenRouterQuota(
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
    const body = (await response.json()) as { data?: Record<string, any> };
    const data = body.data ?? {};
    const value = parseOpenRouterKey(data);
    const usable = value.windows.length > 0 || value.balanceUsd !== null ? value : null;
    cache.set(cacheKey, { at: Date.now(), value: usable });
    return usable;
  } catch {
    cache.set(cacheKey, { at: Date.now(), value: null });
    return null;
  }
}
