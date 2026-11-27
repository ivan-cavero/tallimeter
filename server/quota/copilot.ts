import type { Quota, QuotaWindow } from "../../shared/contracts";

/**
 * GitHub Copilot: a monthly premium-request allowance.
 *
 *   GET https://api.github.com/copilot_internal/user
 *   Authorization: Bearer <GitHub OAuth token>
 *   Editor-Version: vscode/1.85.0  (the internal surface expects an editor identity)
 *
 * This is Copilot's own internal endpoint, the same one the editor calls. It is not a documented
 * public API, so the parse tolerates both shapes seen in clients:
 *
 *   quota_snapshots.premium_interactions  { entitlement, remaining, percent_remaining }
 *   monthly_quotas                        { chat, completions } as plain remaining counts
 *
 * A plan with no premium allowance reports only chat/completions, which are not windows with a
 * cap here, so this returns null rather than inventing one.
 */
const ENDPOINT = "https://api.github.com/copilot_internal/user";
const CACHE_MS = 90_000;
const cache = new Map<string, { at: number; value: Quota | null }>();

const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const iso = (value: unknown): string | null => {
  if (typeof value !== "string" || !value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
};

export function parseCopilotUser(body: Record<string, any>): Quota | null {
  const windows: QuotaWindow[] = [];
  const snapshot = body.quota_snapshots?.premium_interactions as Record<string, any> | undefined;

  if (snapshot) {
    const entitlement = num(snapshot.entitlement) ?? num(snapshot.total);
    const remaining = num(snapshot.remaining);
    const percentRemaining = num(snapshot.percent_remaining);
    // Used percent is derivable from either the counts or the vendor's own percentage.
    const usedPct =
      percentRemaining !== null
        ? Math.max(0, Math.min(100 - percentRemaining, 100))
        : entitlement !== null && entitlement > 0 && remaining !== null
          ? Math.max(0, Math.min(((entitlement - remaining) / entitlement) * 100, 100))
          : null;
    if (usedPct !== null) {
      windows.push({
        id: "premium",
        label: "Premium requests",
        shortLabel: "prem",
        usedPct,
        resetsAt: iso(body.quota_reset_date ?? body.quota_reset_date_utc),
        durationSeconds: 2_592_000,
      });
    }
  }

  const plan = String(body.copilot_plan ?? body.copilotPlan ?? "");
  if (windows.length === 0) return null;

  return {
    source: "copilot",
    planLabel: plan ? `Copilot ${plan}` : "GitHub Copilot",
    windows,
    balanceUsd: null,
    balanceLimitUsd: null,
    balanceUnit: null,
    note: body.access_type_sku ? `Plan SKU ${body.access_type_sku}` : null,
    fetchedAt: new Date().toISOString(),
  };
}

/** Reads a GitHub token from the usual places, so a `gh` login is enough. */
export async function readCopilotToken(): Promise<string | null> {
  for (const name of ["COPILOT_GITHUB_TOKEN", "GITHUB_TOKEN", "GH_TOKEN"]) {
    const value = process.env[name];
    if (value?.trim()) return value.trim();
  }
  try {
    const { execFileSync } = await import("node:child_process");
    const token = execFileSync("gh", ["auth", "token"], {
      encoding: "utf8",
      timeout: 8_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return token || null;
  } catch {
    return null;
  }
}

export async function readCopilotQuota(
  opts: { forceRefresh?: boolean } = {},
): Promise<Quota | null> {
  const cached = cache.get("copilot");
  if (!opts.forceRefresh && cached && Date.now() - cached.at < CACHE_MS) return cached.value;

  const token = await readCopilotToken();
  if (!token) {
    cache.set("copilot", { at: Date.now(), value: null });
    return null;
  }

  try {
    const response = await fetch(ENDPOINT, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Editor-Version": "vscode/1.85.0",
        "User-Agent": "tallimeter/1.0",
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      cache.set("copilot", { at: Date.now(), value: null });
      return null;
    }
    const value = parseCopilotUser((await response.json()) as Record<string, any>);
    cache.set("copilot", { at: Date.now(), value });
    return value;
  } catch {
    cache.set("copilot", { at: Date.now(), value: null });
    return null;
  }
}
