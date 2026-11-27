# Provider research notes

Every provider below was checked against its own documentation or a live response, not inferred.
The date is when it was checked. Anything marked UNVERIFIED has no credential here, so its parser
is tested against the documented shape only.

The rule that shapes all of this: **a provider's allowance is never derived from local token
counts.** When a read fails, the card keeps the spend numbers and shows no window.

## Claude (Anthropic)

Checked 2026-11-26 against `api.anthropic.com/api/oauth/usage`.

- Endpoint: `GET /api/oauth/usage?cedar_ember=1`, fallback `&skip_spend=1` when the fuller read is
  refused. Live: 200.
- Auth: `Authorization: Bearer <oauth access token>`, `anthropic-beta: oauth-2025-04-20`. The token
  comes from `<CLAUDE_CONFIG_DIR>/.credentials.json`.
- Shape: `five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet`, each
  `{ utilization, resets_at }`, plus `limits[]` where `kind: "weekly_scoped"` adds a model-specific
  weekly window and `extra_usage` carries pay-as-you-go spend **in minor units** (cents).
- `utilization` is used, not remaining. A 5-hour window at `utilization: 42.5` reads 42.5% used.
- Rate limit: rapid repeats answer 429, so the read is cached 90 s per account.
- Plan label: `.claude.json` → `oauthAccount.planDisplayName`, or the tier
  `default_claude_max_5x` → Max 5x, `default_claude_max_20x` → Max 20x.

## Codex (OpenAI / ChatGPT plan)

Checked 2026-11-26 against CodexBar's provider notes. UNVERIFIED live (no Codex login here).

- Endpoint: `GET chatgpt.com/backend-api/wham/usage` with the Codex access token.
- Auth: `$CODEX_HOME/auth.json` → `tokens.access_token`.
- Shape: either a nested `rate_limits` object with `fiveHour` / `secondary` and camelCase
  `usedPercent` / `resetsAt`, or a flat body with `five_hour` / `weekly` and snake_case
  `used_percent` / `resets_at`. Both are parsed.
- The documented Codex path is the app-server RPC `account/rateLimits/read`; the HTTP surface is the
  same data the dashboard reads.

## Gemini (Code Assist)

Checked 2026-11-26 against CodexBar and the Code Assist protobuf notes. UNVERIFIED live.

- Endpoint: `POST cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota`.
- Auth: `~/.gemini/oauth_creds.json` → `access_token` (Google OAuth).
- Shape: `buckets[]` with `modelId`, `remainingFraction` (**remaining**, not used) and `resetTime`.
- Buckets are per model family and share one pool, so they are shown separately rather than summed.
  A bucket with no `remainingFraction` is skipped instead of rendered as 0%.

## OpenDesign

Checked 2026-11-26 **live** against a real Go-plan account.

- Endpoint: `GET amr-api.open-design.ai/api/v1/workspaces/{id}/billing/preflight` (control key) or
  `/billing/coding-plan-usage` (browser cookie). Wallet: `/wallet/balance`, independent.
- Auth: a browser session `__Secure-better-auth.session_token`, or a `vela_ctrl_…` control key.
  **An `sk-amr-…` model key cannot read billing** (chat-only, answers 401). Confirmed in CodexBar
  #4601 and in the dsh-cost-meter notes.
- Shape: `codingPlan.windows[]` with `usedCredits` / `limitCredits` as **decimal strings**,
  `durationSeconds` (18000 = 5-hour, 604800 = weekly), `resetsAt`, plus `balanceUsd`.
- Window identity comes from `durationSeconds`, never array order, so a reordered response cannot
  mislabel a meter.
- Live reading at check time: 5-hour 8.8% used, weekly 6.8% used, wallet $1.00.
- The device-code route (`POST /api/v1/cli/device-authorizations`) is undocumented and answered
  **500** here, so the browser-session import is the primary path.

## OpenCode Go

Checked 2026-11-26 against opencode.ai/docs/console/go. UNVERIFIED live (no Go login in the
OpenCode database here).

- Endpoint: `GET opencode.ai/zen/go/v1/usage`.
- Auth: `Bearer <key>` from OpenCode's own `auth.json` or its credential table.
- Shape: `usage.rolling` / `weekly` / `monthly`, each `{ percent, resetsAt, status }`. `percent` is
  **used**. `status: "rate-limited"` is a full window and must render as 100%, not be dropped.
- Plan windows: rolling 5-hour, weekly (resets Monday 00:00 UTC), monthly (per billing period).
- Cloudflare refuses the default fetch user agent on this host, so a `User-Agent` is sent.

## OpenRouter

Checked 2026-11-26 against openrouter.ai/docs/api/api-reference/limits.

- Endpoint: `GET openrouter.ai/api/v1/key`. **The `/credits` endpoint needs a management key** and
  answers an inference key with 403, so it is never requested.
- Shape: `data.limit`, `limit_remaining`, `limit_reset`, `usage_daily` / `weekly` / `monthly`,
  `effective_budget` (`limit_usd`, `spend_usd`, `reset_interval`, `resets_at`), `is_free_tier`.
- The per-key cap is the only real window. Daily/weekly/monthly `usage_*` are spend, not limits, so
  they are not rendered as meters.
- A free-tier key has no cap and no window, but still reports a balance.

## Ollama Cloud

Checked 2026-11-26 against docs.ollama.com/api/balance and /api/cloud-usage.

- Endpoints: `GET ollama.com/api/balance` for allowance; `/api/usage` is spend history, not a cap.
- Crafted to the current per-token plans: `included.balance_usd` + `included.allowance_usd` +
  `included.period.until`, and `purchased.balance_usd` for top-ups.
- Legacy plans return `included.session` / `included.weekly` with `remaining_percent`
  (**remaining**, 0–100), so it is inverted to used.
- Rate limit: 10 requests per minute per user shared across keys, so a 90 s cache stays well inside.

## DeepSeek, Kimi, Copilot

Implemented from the vendors' published shapes, UNVERIFIED live (no credential here).

- DeepSeek: `GET api.deepseek.com/user/balance` with `Authorization: Bearer <key>`. Every amount is
  a **decimal string**, not a number. There is no published spend cap, so it reports a balance and
  no window.
- Kimi: `GET api.kimi.com/coding/v1/usages` with `Bearer <key>`. Windows carry `used_ratio` as a
  0..1 fraction (**used**, not remaining), so it is multiplied by 100.
- Copilot: `GET api.github.com/copilot_internal/user`, **verified live** on 2026-11-27 with a `gh`
  token. Windows are `quota_snapshots.premium_interactions` (and `chat` / `completions` on plans
  that cap them), each with `entitlement` and `remaining`. An allowance the plan does not include
  reports `entitlement: 0` and `has_quota: false`, which is an absent window: reading it as 100%
  used would alarm a user about an allowance they never had.

## Pi

Pi is a harness, not a vendor: its transcripts name whichever login served the turn, so its spend is
read from `~/.pi/**/sessions/*.jsonl` and its allowance comes from that vendor's reader.

## Windows the plugin cannot read

A provider with no stored credential shows spend and no window. That is deliberate: an invented
percentage is worse than an empty meter, because it looks authoritative.

## How credentials are handled

- One file: `~/.paseo/tallimeter-credentials.json`, atomic write, mode 0600.
- Never in Paseo's config (its schema rejects unknown keys under `agents`).
- Never in plugin settings: settings are readable by every connected client, including phones.
- Never returned to a client: the browser import saves server-side and the UI only sees the last
  four characters of a value.
- Portable: the file is plain JSON, so copying it to another machine moves the accounts.
- Not encrypted at rest. There is no key the user could carry separately, and a local key would give
  false confidence; the file relies on filesystem permissions, like other local tooling.
