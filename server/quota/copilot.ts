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

/** Named allowances Copilot reports as a capped window, in the order worth showing. */
const NAMED: Array<[string, string, string]> = [
  ["premium_interactions", "Premium requests", "prem"],
  ["chat", "Chat requests", "chat"],
  ["completions", "Completions", "cmp"],
];

export function parseCopilotUser(body: Record<string, any>): Quota | null {
  const windows: QuotaWindow[] = [];
  const snapshots = (body.quota_snapshots ?? {}) as Record<string, Record<string, any> | undefined>;
  const resetsAt = iso(body.quota_reset_date ?? body.quota_reset_date_utc);

  for (const [key, label, shortLabel] of NAMED) {
    const snapshot = snapshots[key];
    if (!snapshot) continue;
    const entitlement = num(snapshot.entitlement) ?? num(snapshot.total);
    // A plan without this allowance reports entitlement 0 and `has_quota: false`. That is an
    // absent window, not a used-up one: a free plan read as "100% used" is the kind of wrong that
    // looks like an alarm.
    if (snapshot.has_quota === false || (entitlement !== null && entitlement <= 0)) continue;
    const remaining = num(snapshot.remaining);
    const percentRemaining = num(snapshot.percent_remaining);
    // Used percent is derivable from either the counts or the vendor's own percentage.
    const usedPct =
      entitlement !== null && entitlement > 0 && remaining !== null
        ? Math.max(0, Math.min(((entitlement - remaining) / entitlement) * 100, 100))
        : percentRemaining !== null
          ? Math.max(0, Math.min(100 - percentRemaining, 100))
          : null;
    if (usedPct === null) continue;
    windows.push({ id: key, label, shortLabel, usedPct, resetsAt, durationSeconds: 2_592_000 });
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
