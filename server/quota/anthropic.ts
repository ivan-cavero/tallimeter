import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Quota, QuotaWindow } from "../../shared/contracts";

const HOME = homedir();
const CACHE_MS = 90_000;
const cache = new Map<string, { at: number; value: Quota | null }>();

interface Credentials {
  accessToken: string;
  expiresAt: number | null;
}

/** Claude Code keeps the OAuth token in the config dir on Linux and Windows. */
function readCredentials(configDir: string): Credentials | null {
  for (const name of [".credentials.json", "credentials.json"]) {
    const path = join(configDir, name);
    if (!existsSync(path)) continue;
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
      const oauth = raw.claudeAiOauth ?? raw.oauth ?? raw;
      const accessToken = String(oauth?.accessToken ?? oauth?.access_token ?? "");
      if (!accessToken) continue;
      const expiresRaw = oauth?.expiresAt ?? oauth?.expires_at ?? null;
      const expiresAt =
        typeof expiresRaw === "number" ? expiresRaw : expiresRaw ? Date.parse(String(expiresRaw)) : null;
      return { accessToken, expiresAt: Number.isFinite(expiresAt as number) ? (expiresAt as number) : null };
    } catch {
      continue;
    }
  }
  return null;
}

function planLabel(configDir: string): string | null {
  for (const path of [join(configDir, ".claude.json"), join(HOME, ".claude.json")]) {
    if (!existsSync(path)) continue;
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
      const oauth = raw?.oauthAccount;
      if (!oauth) continue;
      const name = String(oauth?.planDisplayName ?? "");
      if (name) return name;
      const tier = String(oauth?.organizationRateLimitTier ?? "");
      if (tier === "default_claude_max_5x") return "Claude Max 5x";
      if (tier === "default_claude_max_20x") return "Claude Max 20x";
      if (tier.includes("max")) return "Claude Max";
      if (tier.includes("pro")) return "Claude Pro";
      if (tier.includes("team")) return "Claude Team";
    } catch {
      continue;
    }
  }
  return null;
}

const isoDate = (value: unknown): string | null => {
  if (typeof value !== "string" || !value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
};

/** Anthropic reports extra-usage spend in minor units. */
const toUsd = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value / 100 : null;

const NAMED: Array<[string, string, string]> = [
  ["five_hour", "5-hour", "5h"],
  ["seven_day", "Weekly", "wk"],
  ["seven_day_opus", "Weekly · Opus", "wk"],
  ["seven_day_sonnet", "Weekly · Sonnet", "wk"],
];

/**
 * Turns the usage body into windows. Exported so tests can run it without a network or a
 * credential: the parse is the part that a vendor changing its shape would break.
 */
export function parseAnthropicUsage(body: Record<string, any>): {
  windows: QuotaWindow[];
  extra: { spendUsd: number | null; limitUsd: number | null } | null;
} {
  const windows: QuotaWindow[] = [];
  for (const [id, label, shortLabel] of NAMED) {
    const entry = body?.[id] as { utilization?: unknown; resets_at?: unknown } | undefined;
    if (entry && typeof entry.utilization === "number") {
      windows.push({
        id,
        label,
        shortLabel,
        usedPct: Math.max(0, Math.min(entry.utilization, 100)),
        resetsAt: isoDate(entry.resets_at),
      });
    }
  }
  for (const limit of Array.isArray(body?.limits) ? (body.limits as Array<Record<string, any>>) : []) {
    if (limit?.kind !== "weekly_scoped" || typeof limit.percent !== "number") continue;
    const name = String(limit?.scope?.model?.display_name ?? limit?.scope?.surface?.display_name ?? "");
    if (!name) continue;
    const id = `weekly_${name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
    if (windows.some((window) => window.id === id)) continue;
    windows.push({
      id,
      label: `Weekly · ${name}`,
      shortLabel: "wk",
      usedPct: Math.max(0, Math.min(limit.percent, 100)),
      resetsAt: isoDate(limit.resets_at),
    });
  }
  const extra = body?.extra_usage as Record<string, unknown> | undefined;
  return {
    windows,
    extra: extra ? { spendUsd: toUsd(extra.spend ?? extra.used_credits), limitUsd: toUsd(extra.monthly_limit ?? extra.limit) } : null,
  };
}

/**
 * Anthropic's own usage endpoint, the same one Claude Code's `/usage` reads. Cached 90 s per
 * account because the endpoint rate-limits rapid repeats, and the fuller read is retried without
 * the spend section when it is refused.
 */
export async function readClaudeQuota(
  configDir: string,
  opts: { forceRefresh?: boolean } = {},
): Promise<Quota | null> {
  const cached = cache.get(configDir);
  if (!opts.forceRefresh && cached && Date.now() - cached.at < CACHE_MS) return cached.value;

  const credentials = readCredentials(configDir);
  if (!credentials?.accessToken) {
    cache.set(configDir, { at: Date.now(), value: null });
    return null;
  }
  if (credentials.expiresAt !== null && credentials.expiresAt < Date.now()) {
    cache.set(configDir, { at: Date.now(), value: null });
    return null;
  }

  try {
    const read = (url: string) =>
      fetch(url, {
        headers: {
          Authorization: `Bearer ${credentials.accessToken}`,
          "anthropic-beta": "oauth-2025-04-20",
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(15_000),
      });

    // The `cedar_ember` read also returns banked resets; `skip_spend` avoids a second lookup
    // and is the fallback when the fuller read is refused.
    let response = await read("https://api.anthropic.com/api/oauth/usage?cedar_ember=1");
    if (!response.ok && response.status !== 429) {
      response = await read("https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1");
    }
    if (!response.ok) {
      cache.set(configDir, { at: Date.now(), value: null });
      return null;
    }

    const body = (await response.json()) as Record<string, any>;
    const parsed = parseAnthropicUsage(body);
    const windows = parsed.windows;

    const value: Quota = {
      source: "anthropic",
      planLabel: planLabel(configDir),
      windows,
      balanceUsd: parsed.extra?.spendUsd ?? null,
      balanceLimitUsd: parsed.extra?.limitUsd ?? null,
      balanceUnit: parsed.extra ? "usd" : null,
      note: null,
      fetchedAt: new Date().toISOString(),
    };
    const usable = windows.length > 0 ? value : null;
    cache.set(configDir, { at: Date.now(), value: usable });
    return usable;
  } catch {
    cache.set(configDir, { at: Date.now(), value: null });
    return null;
  }
}
