/**
 * Response fixtures, each copied from the vendor's documented shape or from a sanitized live
 * response recorded in this repo's notes. They are the contract the parsers are tested against;
 * a vendor changing its shape shows up here first.
 */

/** Anthropic, `GET /api/oauth/usage?cedar_ember=1`. Percent is `utilization`, resets are ISO. */
export const anthropicUsage = {
  five_hour: { utilization: 42.5, resets_at: "2026-11-26T08:00:00.000+00:00" },
  seven_day: { utilization: 61.2, resets_at: "2026-12-01T00:00:00.000+00:00" },
  seven_day_opus: { utilization: 88, resets_at: "2026-12-01T00:00:00.000+00:00" },
  limits: [
    {
      kind: "weekly_scoped",
      percent: 12,
      resets_at: "2026-12-01T00:00:00.000Z",
      scope: { model: { display_name: "Fable 5.2" } },
    },
    // A non-weekly limit must be ignored: nothing else has a percent window.
    { kind: "something_else", percent: 99 },
  ],
  extra_usage: { spend: 1234, monthly_limit: 5000 },
};

/** Anthropic with no windows at all: a signed-in account with no subscription quota. */
export const anthropicEmpty = { extra_usage: null };

/** OpenCode Go, `GET https://opencode.ai/zen/go/v1/usage`. Percent is used. */
export const openCodeGoUsage = {
  usage: {
    rolling: { status: "ok", percent: 19, resetsAt: "2026-11-26T06:00:00.000Z" },
    weekly: { status: "ok", percent: 47, resetsAt: "2026-12-01T00:00:00.000Z" },
    monthly: { status: "ok", percent: 12, resetsAt: "2026-12-11T22:26:38.000Z" },
  },
};

/** The full-window shape: `rate-limited` still means 100% used, not a parse failure. */
export const openCodeGoRateLimited = {
  usage: {
    rolling: { status: "rate-limited", percent: 100, resetsAt: "2026-11-26T04:00:00.000Z" },
    weekly: { status: "ok", percent: 3, resetsAt: "2026-12-01T00:00:00.000Z" },
  },
};

/** OpenDesign, `GET /api/v1/workspaces/{id}/billing/preflight`. Credits are decimal strings. */
export const openDesignPreflight = {
  schemaVersion: 1,
  workspaceId: "ws_demo",
  workspaceMemberId: "member_demo",
  generatedAt: "2026-11-26T00:00:00.000Z",
  balanceUsd: "1.25",
  codingPlan: {
    workspaceId: "ws_demo",
    eligible: true,
    tier: "go",
    windows: [
      {
        policyId: "policy_5h",
        durationSeconds: 18_000,
        resetMode: "anchored_recurring",
        usedCredits: "2869",
        limitCredits: "50000",
        remainingCredits: "47131",
        windowStart: "2026-11-25T21:43:55.766Z",
        resetsAt: "2026-11-26T02:43:55.766Z",
      },
      {
        policyId: "policy_week",
        durationSeconds: 604_800,
        resetMode: "anchored_recurring",
        usedCredits: "8756",
        limitCredits: "150000",
        remainingCredits: "141244",
        windowStart: "2026-11-24T11:43:55.766Z",
        resetsAt: "2026-12-01T11:43:55.766Z",
      },
    ],
  },
};

/** The same windows in reverse order: identity must come from duration, never array position. */
export const openDesignPreflightReordered = {
  ...openDesignPreflight,
  codingPlan: {
    ...openDesignPreflight.codingPlan,
    windows: [...openDesignPreflight.codingPlan.windows].reverse(),
  },
};

/** A workspace with no coding plan: a readable wallet and no windows is a real answer. */
export const openDesignNoPlan = {
  workspaceId: "ws_demo",
  balanceUsd: "3.50",
  codingPlan: { eligible: false, tier: null, windows: [] },
};

/** OpenRouter, `GET /api/v1/key`. A per-key cap plus spend per UTC day/week/month. */
export const openRouterKey = {
  data: {
    label: "sk-or-v1-…890",
    limit: 100,
    limit_reset: "monthly",
    limit_remaining: 74.5,
    include_byok_in_limit: false,
    budgets: [],
    effective_budget: {
      scope: "key_limit",
      limit_usd: 100,
      spend_usd: 25.5,
      remaining_usd: 74.5,
      reset_interval: "monthly",
      resets_at: "2026-12-01T00:00:00.000Z",
    },
    usage: 25.5,
    usage_daily: 2.4,
    usage_weekly: 9.1,
    usage_monthly: 25.5,
    is_free_tier: false,
    free_model_daily_requests: { used: 12, limit: 50, remaining: 38 },
  },
};

/** A free-tier key: no spend cap, so no window, but a real balance. */
export const openRouterFreeTier = {
  data: {
    limit: null,
    limit_remaining: null,
    effective_budget: null,
    usage_daily: 0,
    is_free_tier: true,
    free_model_daily_requests: { used: 3, limit: 50, remaining: 47 },
  },
};

/** Ollama Cloud, `GET /api/balance` with the current per-token plans. */
export const ollamaBalance = {
  included: {
    balance_usd: 72.5,
    allowance_usd: 100,
    period: { from: "2026-11-15T09:30:00Z", until: "2026-12-15T09:30:00Z" },
  },
  purchased: { balance_usd: 25 },
};

/** Ollama Cloud on a legacy plan: session and weekly percentages, remaining not used. */
export const ollamaLegacy = {
  included: {
    session: { remaining_percent: 75, resets_at: "2026-11-26T07:00:00Z" },
    weekly: { remaining_percent: 40, resets_at: "2026-11-30T00:00:00Z" },
  },
  purchased: { balance_usd: 0 },
};

/** Codex, `chatgpt.com/backend-api/wham/usage`, flat shape. */
export const codexFlat = {
  five_hour: { used_percent: 23, resets_at: "2026-11-26T09:00:00Z" },
  weekly: { used_percent: 55, resets_at: "2026-12-01T00:00:00Z" },
  credits: { balance_usd: 4.2 },
};

/** Codex, same data under a `rate_limits` object with camelCase keys. */
export const codexNested = {
  rate_limits: {
    fiveHour: { usedPercent: 23, resetsAt: "2026-11-26T09:00:00Z" },
    secondary: { usedPercent: 55, resetsAt: "2026-12-01T00:00:00Z" },
  },
};

/** Gemini Code Assist, `retrieveUserQuota`. `remainingFraction` is remaining, not used. */
export const geminiQuota = {
  buckets: [
    { modelId: "gemini-2.5-pro", remainingFraction: 0.62, resetTime: "2026-11-27T00:00:00Z" },
    { modelId: "gemini-2.5-flash", remainingFraction: 0.9, resetTime: "2026-11-27T00:00:00Z" },
    // Malformed bucket: no fraction and no amount must be skipped, never rendered as 0%.
    { modelId: "gemini-2.5-flash-lite" },
  ],
};

/** DeepSeek, `GET /user/balance`. Amounts are decimal strings, USD preferred. */
export const deepSeekUsd = {
  is_available: true,
  balance_infos: [
    { currency: "USD", total_balance: "110.00", granted_balance: "10.00", topped_up_balance: "100.00" },
  ],
};

/** DeepSeek with an exhausted balance: calls would fail. */
export const deepSeekEmpty = {
  is_available: false,
  balance_infos: [{ currency: "USD", total_balance: "0.00", granted_balance: "0.00", topped_up_balance: "0.00" }],
};

/** Kimi, `GET /coding/v1/usages`, count-based shape. Numbers arrive as strings. */
export const kimiCounting = {
  usage: { limit: "100", used: "5", remaining: "95", resetTime: "2026-11-30T08:25:53.153617Z" },
  limits: [
    {
      window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
      detail: { limit: "100", used: "15", remaining: "85", resetTime: "2026-11-26T14:18:14.197162Z" },
    },
  ],
  user: { membership: { level: "pro" } },
};

/**
 * Kimi newer shape: no `usage` block, ratio pools instead. `used_ratio` is a fraction 0..1, and
 * `limit_month_code` is the Code slice inside the monthly pool, not a second allowance.
 */
export const kimiRatios = {
  limits: [
    {
      window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
      // A live row may omit `used` on an idle window: that is zero usage, not a parse error.
      detail: { limit: "100", remaining: "100", resetTime: "2026-11-26T14:18:14Z" },
    },
  ],
  usages: {
    limit_5h: { used_ratio: 0, reset_time: "2026-11-26T14:18:14Z" },
    limit_7d: { used_ratio: 0.0543, reset_time: "2026-11-30T08:25:53Z" },
    limit_month_total: { used_ratio: 0.0042, reset_time: "2026-12-15T09:19:24Z" },
    limit_month_code: { used_ratio: 0.0042, reset_time: "2026-12-15T09:19:24Z" },
  },
};

/**
 * Copilot, `GET /copilot_internal/user`, checked live on 2026-11-27. `percent_remaining` is
 * remaining, and an allowance the plan does not include reports `entitlement: 0` with
 * `has_quota: false`, which is an absent window rather than a full one.
 */
export const copilotPremium = {
  copilot_plan: "individual_pro",
  access_type_sku: "annual_individual_pro",
  quota_reset_date: "2026-12-01T00:00:00.000Z",
  quota_snapshots: {
    premium_interactions: { entitlement: 1500, remaining: 1320, percent_remaining: 88, unlimited: false },
    chat: { entitlement: 0, remaining: 0, unlimited: true },
    completions: { entitlement: 0, remaining: 0, unlimited: true },
  },
};

/** Claude Code `auth status --json`, for sign-in detection without a network call. */
export const claudeAuthStatus = {
  loggedIn: true,
  email: "someone@example.com",
  orgId: "org_demo",
  subscriptionType: "max",
};
