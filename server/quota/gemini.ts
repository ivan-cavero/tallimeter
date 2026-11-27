import type { Quota, QuotaWindow } from "../../shared/contracts";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * Gemini CLI stores a Google OAuth login and reads its own quota buckets through
 * `retrieveUserQuota`. The buckets are per model family, so they are shown as separate meters
 * instead of summed, which would misreport a plan that is only spent on one family.
 */
const CACHE_MS = 90_000;
const cache = new Map<string, { at: number; value: Quota | null }>();

const iso = (value: unknown): string | null => {
  if (typeof value !== "string" || !value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
};

interface GeminiAuth {
  access_token?: string;
  expiry?: string;
}

function readGeminiAuth(): GeminiAuth | null {
  for (const path of [
    join(homedir(), ".gemini", "oauth_creds.json"),
    join(homedir(), ".config", "gemini", "oauth_creds.json"),
  ]) {
    if (!existsSync(path)) continue;
    try {
      return JSON.parse(readFileSync(path, "utf8")) as GeminiAuth;
    } catch {
      continue;
    }
  }
  return null;
}

const CODE_ASSIST = "https://cloudcode-pa.googleapis.com/v1internal";

/** Pure mapping of `retrieveUserQuota`; `remainingFraction` is remaining, not used. */
export function parseGeminiQuota(body: Record<string, any>): Quota | null {
  const buckets = Array.isArray(body.buckets) ? (body.buckets as Array<Record<string, any>>) : [];
  const windows: QuotaWindow[] = [];
  for (const bucket of buckets) {
    const remaining = bucket.remaining as Record<string, unknown> | undefined;
    const fraction = Number(remaining?.remainingFraction ?? bucket.remainingFraction);
    const model = String(bucket.modelId ?? bucket.model ?? "gemini");
    if (!Number.isFinite(fraction)) continue;
    windows.push({
      id: model,
      label: model.replace(/^gemini-/, "Gemini "),
      shortLabel: "q",
      usedPct: Math.max(0, Math.min((1 - fraction) * 100, 100)),
      resetsAt: iso(bucket.resetTime ?? bucket.reset_time),
    });
  }
  return windows.length > 0
    ? {
        source: "gemini",
        planLabel: "Gemini Code Assist",
        windows,
        balanceUsd: null,
        balanceLimitUsd: null,
        balanceUnit: null,
        note: "One meter per model family; the plan shares one pool.",
        fetchedAt: new Date().toISOString(),
      }
    : null;
}

export async function readGeminiQuota(
  opts: { forceRefresh?: boolean } = {},
): Promise<Quota | null> {
  const cached = cache.get("gemini");
  if (!opts.forceRefresh && cached && Date.now() - cached.at < CACHE_MS) return cached.value;

  const auth = readGeminiAuth();
  if (!auth?.access_token) {
    cache.set("gemini", { at: Date.now(), value: null });
    return null;
  }

  try {
    const response = await fetch(`${CODE_ASSIST}:retrieveUserQuota`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${auth.access_token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      cache.set("gemini", { at: Date.now(), value: null });
      return null;
    }
    const body = (await response.json()) as Record<string, any>;
    const value = parseGeminiQuota(body);
    cache.set("gemini", { at: Date.now(), value });
    return value;
  } catch {
    cache.set("gemini", { at: Date.now(), value: null });
    return null;
  }
}
