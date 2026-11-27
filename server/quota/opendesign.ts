import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Quota, QuotaWindow } from "../../shared/contracts";

const API = "https://amr-api.open-design.ai/api/v1";
const CACHE_MS = 120_000;
const cache = new Map<string, { at: number; value: Quota | null }>();

const isoDate = (value: unknown): string | null => {
  if (typeof value !== "string" || !value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
};

const num = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

/** The plan reports window length, never an array position, so a reorder cannot mislabel a meter. */
const windowFor = (durationSeconds: number | null): { id: string; label: string; shortLabel: string; durationSeconds?: number } => {
  if (durationSeconds === 18_000) return { id: "five_hour", label: "5-hour", shortLabel: "5h", durationSeconds };
  if (durationSeconds === 604_800) return { id: "weekly", label: "Weekly", shortLabel: "wk", durationSeconds };
  if (durationSeconds !== null && durationSeconds > 0) {
    return { id: `d${Math.round(durationSeconds / 86_400)}`, label: `${Math.round(durationSeconds / 3_600)}h window`, shortLabel: "win", durationSeconds };
  }
  return { id: "unknown", label: "Limit", shortLabel: "lim" };
};

interface CodingPlanWindow {
  durationSeconds?: unknown;
  usedCredits?: unknown;
  limitCredits?: unknown;
  resetsAt?: unknown;
}

/**
 * Maps a preflight or coding-plan-usage body to windows. Identity comes from durationSeconds,
 * never array position, so a reordered response cannot mislabel the 5-hour meter as weekly.
 */
export function parseOpenDesignPlan(body: Record<string, any>): {
  windows: QuotaWindow[];
  eligible: boolean;
  planLabel: string;
  balanceUsd: number | null;
} {
  const plan = (body?.codingPlan ?? body) as Record<string, any>;
  const rawWindows = Array.isArray(plan?.windows)
    ? (plan.windows as CodingPlanWindow[])
    : Array.isArray(body?.windows)
      ? (body.windows as CodingPlanWindow[])
      : [];
  const windows: QuotaWindow[] = [];
  for (const entry of rawWindows) {
    const used = num(entry.usedCredits);
    const limit = num(entry.limitCredits);
    if (used === null || limit === null || limit <= 0) continue;
    const identity = windowFor(num(entry.durationSeconds));
    windows.push({
      ...identity,
      usedPct: Math.max(0, Math.min((used / limit) * 100, 100)),
      resetsAt: isoDate(entry.resetsAt),
    });
  }
  const eligible = plan?.eligible ?? body?.eligible ?? true;
  const balance = num(plan?.balanceUsd ?? body?.balanceUsd);
  return {
    windows,
    eligible: Boolean(eligible),
    planLabel:
      String(plan?.tier ?? plan?.planId ?? body?.tier ?? body?.personalMembershipTier ?? "") || "OpenDesign",
    balanceUsd: balance,
  };
}

/**
 * OpenDesign Go/Pro allowance. An inference key (`sk-amr_...`) is chat-only and cannot read
 * billing, so this needs a control key (`vela_ctrl`, the same credential `vela login` stores) or a
 * pasted browser session cookie. The response nests the windows under `codingPlan` and reports
 * credits, not tokens.
 *
 * Three credential shapes reach this function: a full cookie header, a bare session token, and a
 * control key. Only cookies and control keys can read billing, and saying so beats a 401.
 */
export async function readOpenDesignQuota(
  input: { controlKey?: string; cookie?: string; workspaceId?: string },
  opts: { forceRefresh?: boolean } = {},
): Promise<Quota | null> {
  const credential = input.controlKey?.trim() || input.cookie?.trim() || "";
  if (!credential) return null;
  const cacheKey = `${input.workspaceId ?? ""}|${credential.slice(0, 8)}|${credential.slice(-8)}`;
  const cached = cache.get(cacheKey);
  if (!opts.forceRefresh && cached && Date.now() - cached.at < CACHE_MS) return cached.value;

  // Three shapes reach this function: a full cookie, a bare session token, and a vela control key.
  // Only cookies and control keys can read billing; a model key cannot, and saying so beats a 401.
  const isCookie = credential.startsWith("__Secure-") || credential.includes("session_token=") || !credential.startsWith("vela_");
  if (credential.startsWith("sk-")) {
    return null;
  }
  const headers: Record<string, string> = { Accept: "application/json" };
  if (isCookie) headers.Cookie = credential.includes("session_token=") ? credential : `__Secure-better-auth.session_token=${credential}`;
  else headers.Authorization = `Bearer ${credential}`;

  let workspaceId = input.workspaceId?.trim() || "";
  if (!workspaceId) {
    try {
      const response = await fetch(`${API}/workspaces/current`, { headers, signal: AbortSignal.timeout(15_000) });
      if (!response.ok) {
        cache.set(cacheKey, { at: Date.now(), value: null });
        return null;
      }
      const body = (await response.json()) as Record<string, any>;
      workspaceId = String(body?.activeWorkspaceId ?? body?.workspaceId ?? "");
    } catch {
      cache.set(cacheKey, { at: Date.now(), value: null });
      return null;
    }
  }
  if (!workspaceId) {
    cache.set(cacheKey, { at: Date.now(), value: null });
    return null;
  }

  // Both credential kinds can usually read both routes, so every route is tried with the header
  // shape this credential needs. preflight carries a wallet balance even without a subscription.
  const routes = [
    `${API}/workspaces/${workspaceId}/billing/preflight`,
    `${API}/workspaces/${workspaceId}/billing/coding-plan-usage`,
  ];

  for (const url of routes) {
    try {
      // The workspace header is required on every billing route; the auth header varies by kind.
      const requestHeaders: Record<string, string> = {
        Accept: "application/json",
        "x-vela-workspace-id": workspaceId,
      };
      const cookie = headers["Cookie"];
      const authorization = headers["Authorization"];
      if (isCookie && cookie) requestHeaders["Cookie"] = cookie;
      else if (authorization) requestHeaders["Authorization"] = authorization;
      const response = await fetch(url, { headers: requestHeaders, signal: AbortSignal.timeout(15_000) });
      if (!response.ok) continue;
      const body = (await response.json()) as Record<string, any>;

      const parsed = parseOpenDesignPlan(body);
      const windows = parsed.windows;
      // A cookie read has no preflight, so the wallet is a separate, independent call.
      if (isCookie && parsed.balanceUsd === null) {
        try {
          const wallet = await fetch(`${API}/workspaces/${workspaceId}/wallet/balance`, {
            headers: { ...headers, "x-vela-workspace-id": workspaceId },
            signal: AbortSignal.timeout(12_000),
          });
          if (wallet.ok) {
            const walletBody = (await wallet.json()) as Record<string, unknown>;
            (body as Record<string, unknown>).balanceUsd = num(walletBody?.balanceUsd);
          }
        } catch {
          // A missing wallet never hides the windows.
        }
      }
      const balance = num((body as Record<string, unknown>).balanceUsd);
      const value: Quota = {
        source: "opendesign",
        planLabel: parsed.planLabel,
        windows,
        balanceUsd: balance,
        balanceLimitUsd: null,
        balanceUnit: balance !== null ? "usd" : null,
        note:
          windows.length === 0 && !parsed.eligible ? "No active coding plan on this workspace" : null,
        fetchedAt: new Date().toISOString(),
      };
      // A readable balance with no windows is a real answer, not a failure: keep it.
      const usable = value.windows.length > 0 || value.balanceUsd !== null ? value : null;
      cache.set(cacheKey, { at: Date.now(), value: usable });
      return usable;
    } catch {
      continue;
    }
  }

  cache.set(cacheKey, { at: Date.now(), value: null });
  return null;
}
