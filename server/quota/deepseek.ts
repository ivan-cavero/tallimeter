import type { Quota } from "../../shared/contracts";

/**
 * DeepSeek: a prepaid wallet, no subscription windows.
 *
 *   GET https://api.deepseek.com/user/balance
 *   Authorization: Bearer $DEEPSEEK_API_KEY
 *
 * Documented response:
 *   { is_available, balance_infos: [{ currency: "CNY" | "USD", total_balance,
 *     granted_balance, topped_up_balance }] }
 *
 * Every amount is a **decimal string**, not a number, and `is_available: false` means the account
 * cannot make calls at all. The vendor publishes no spend cap, so this reports a balance only.
 */
const ENDPOINT = "https://api.deepseek.com/user/balance";
const CACHE_MS = 90_000;
const cache = new Map<string, { at: number; value: Quota | null }>();

const money = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

export function parseDeepSeekBalance(body: Record<string, any>): Quota | null {
  const infos = Array.isArray(body.balance_infos) ? (body.balance_infos as Array<Record<string, any>>) : [];
  if (infos.length === 0) return null;

  // USD is preferred when both currencies are returned: mixing them would need an FX rate.
  const usd = infos.find((info) => String(info.currency).toUpperCase() === "USD");
  const chosen = usd ?? infos[0];
  const total = money(chosen?.total_balance);
  if (total === null) return null;

  const granted = money(chosen?.granted_balance);
  const topped = money(chosen?.topped_up_balance);
  const currency = String(chosen?.currency ?? "USD").toUpperCase();

  return {
    source: "deepseek",
    planLabel: currency === "USD" ? "DeepSeek credit (USD)" : `DeepSeek credit (${currency})`,
    // No cap is published, so there is no window to draw a percentage against.
    windows: [],
    balanceUsd: total,
    balanceLimitUsd: null,
    balanceUnit: "usd",
    note:
      body.is_available === false
        ? "This key has no balance, so calls will fail"
        : granted !== null && topped !== null
          ? `${currency} balance · granted ${granted} · topped up ${topped}`
          : null,
    fetchedAt: new Date().toISOString(),
  };
}

export async function readDeepSeekQuota(
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
    const value = parseDeepSeekBalance((await response.json()) as Record<string, any>);
    cache.set(cacheKey, { at: Date.now(), value });
    return value;
  } catch {
    cache.set(cacheKey, { at: Date.now(), value: null });
    return null;
  }
}
