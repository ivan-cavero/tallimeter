import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export interface Price {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** USD per million tokens, used only when a provider does not report its own cost per turn. */
const STATIC: Record<string, Price> = {
  // Claude list price: an API-equivalent value for subscription logins, not your bill.
  "claude-opus-5-5": { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  "claude-sonnet-5-5": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-haiku-5-5": { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
};

const HOME = homedir();
const CACHE_DIR = join(HOME, ".cache", "tallimeter");
const PRICE_CACHE = join(CACHE_DIR, "opendesign-prices.json");
const TTL_MS = 24 * 3600_000;

interface CacheFile {
  fetchedAt: number;
  prices: Record<string, Price>;
}

let memory: CacheFile | null = null;

function readCache(): CacheFile | null {
  if (memory) return memory;
  try {
    if (!existsSync(PRICE_CACHE)) return null;
    const parsed = JSON.parse(readFileSync(PRICE_CACHE, "utf8")) as CacheFile;
    memory = parsed;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * OpenDesign publishes its whole price table without authentication. One request a day keeps
 * model pricing current, including new models, instead of hardcoding rates that go stale.
 */
async function fetchOpenDesignPrices(): Promise<Record<string, Price> | null> {
  try {
    const response = await fetch("https://amr-api.open-design.ai/api/v1/public/model-prices", {
      // Cloudflare refuses the default fetch user agent on this origin.
      headers: { Accept: "application/json", "User-Agent": "tallimeter/1.0" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { data?: Array<Record<string, any>> };
    const prices: Record<string, Price> = {};
    for (const entry of body.data ?? []) {
      const id = String(entry.model ?? "");
      const pricing = entry.pricing as Record<string, any> | undefined;
      if (!id || !pricing) continue;
      const input = Number(pricing.input ?? 0);
      const output = Number(pricing.output ?? 0);
      if (!Number.isFinite(input) || !Number.isFinite(output)) continue;
      prices[id] = {
        input,
        output,
        cacheRead: Number(pricing.cacheRead ?? input),
        cacheWrite: Number(pricing.cacheWrite ?? input),
      };
    }
    if (Object.keys(prices).length === 0) return null;
    const payload: CacheFile = { fetchedAt: Date.now(), prices };
    try {
      mkdirSync(dirname(PRICE_CACHE), { recursive: true });
      writeFileSync(PRICE_CACHE, JSON.stringify(payload), "utf8");
    } catch {
      // A warm cache is nice, not required.
    }
    memory = payload;
    return prices;
  } catch {
    return null;
  }
}

export async function loadPrices(): Promise<Record<string, Price>> {
  const cached = readCache();
  if (cached && Date.now() - cached.fetchedAt < TTL_MS) {
    return { ...STATIC, ...cached.prices };
  }
  const fresh = await fetchOpenDesignPrices();
  if (fresh) return { ...STATIC, ...fresh };
  return { ...STATIC, ...(cached?.prices ?? {}) };
}

export function priceFor(model: string, catalog: Record<string, Price>): Price | null {
  const exact = catalog[model];
  if (exact) return exact;
  const family = model.toLowerCase();
  // A gateway's free variants carry no price at all; treating them as unpriced would skew totals.
  if (family.includes("free")) return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  if (family.includes("opus")) return catalog["claude-opus-5-5"] ?? null;
  if (family.includes("sonnet")) return catalog["claude-sonnet-5-5"] ?? null;
  if (family.includes("haiku")) return catalog["claude-haiku-5-5"] ?? null;
  return null;
}

export function costOf(
  model: string,
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number },
  catalog: Record<string, Price>,
): number | null {
  const price = priceFor(model, catalog);
  if (!price) return null;
  return (
    (tokens.input * price.input +
      tokens.output * price.output +
      tokens.cacheRead * price.cacheRead +
      tokens.cacheWrite * price.cacheWrite) /
    1_000_000
  );
}
