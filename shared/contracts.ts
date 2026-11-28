import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const providerBrandSchema = z.object({
  id: z.string(),
  /** The vendor the id resolved to, when the id was an alias such as `codex` or `claude`. */
  brandId: z.string().optional(),
  label: z.string(),
  /** Lucide fallback name, used when a mark cannot be drawn. */
  icon: z.string(),
  /** Self-contained inline SVG mark, validated by Paseo. */
  mark: z.string(),
  /** Colour behind the glyph. Absent on a bleed mark, which draws its own tile. */
  tile: z.string().nullable(),
  /** True when the mark is a complete logo tile and the card must draw none behind it. */
  bleed: z.boolean(),
  /** True when the glyph follows `currentColor` and must be painted white. */
  mono: z.boolean(),
  color: z.string(),
  quotaHint: z.string(),
  docsUrl: z.string(),
  credentials: z.array(z.enum(["apiKey", "cookie", "oauth"])),
  quota: z.enum(["subscription", "balance", "none"]),
});

export const brandsRpc = defineRpc({
  name: "tallimeter.brands",
  input: z.object({}).default({}),
  output: z.object({ brands: z.array(providerBrandSchema) }),
});

export const AccountKindSchema = z.enum(["claude", "opencode", "pi", "opendesign", "other"]);

export const TotalsSchema = z.object({
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  reasoning: z.number(),
  cost: z.number(),
  turns: z.number(),
});

/** One quota window as the provider reports it. Never derived from token counts. */
export const QuotaWindowSchema = z.object({
  id: z.string(),
  label: z.string(),
  shortLabel: z.string(),
  usedPct: z.number(),
  resetsAt: z.string().nullable(),
  /** Window length when the provider states it, used for the "will it last" estimate. */
  durationSeconds: z.number().optional(),
  /** Shown in the compact summary until the user pins windows of their own. */
  summary: z.boolean().optional(),
});

export const QuotaSourceSchema = z.enum([
  "anthropic",
  "openai",
  "gemini",
  "opencode-go",
  "opendesign",
  "openrouter",
  "ollama",
  "deepseek",
  "kimi",
  "copilot",
  "none",
]);

export const QuotaSchema = z.object({
  source: QuotaSourceSchema,
  planLabel: z.string().nullable(),
  windows: z.array(QuotaWindowSchema),
  /** Plan credits or extra-usage spend, in the provider's own unit. */
  balanceUsd: z.number().nullable(),
  balanceLimitUsd: z.number().nullable(),
  balanceUnit: z.enum(["usd", "credits"]).nullable().default(null),
  /** Why a quota exists but shows nothing usable, in plain words. */
  note: z.string().nullable(),
  fetchedAt: z.string(),
});

export const AccountStatSchema = z.object({
  id: z.string(),
  label: z.string(),
  provider: z.string(),
  /** Brand id from the registry: drives the accent colour and icon on the card. */
  brand: providerBrandSchema,
  kind: AccountKindSchema,
  store: z.string(),
  /** Harnesses that fed this card, e.g. ["OpenCode (default)", "Pi 1"]. */
  harnesses: z.array(z.string()),
  periodStart: z.string(),
  periodEnd: z.string(),
  totals: TotalsSchema,
  cacheHitPct: z.number().nullable(),
  budgetUsd: z.number().nullable(),
  spentPct: z.number().nullable(),
  remainingUsd: z.number().nullable(),
  projectedUsd: z.number().nullable(),
  projectionPct: z.number().nullable(),
  costPerDay: z.number().nullable(),
  tokensPerHour: z.number().nullable(),
  /** Days of work the spend so far equals, using the configured hours per workday. */
  workdaysSpent: z.number().nullable(),
  /** Days of work the current cycle budget still buys. */
  workdaysLeft: z.number().nullable(),
  lastActivity: z.string().nullable(),
  daysLeft: z.number(),
  /** Subscription quota when the provider exposes one. Null for gateway and pay-per-token logins. */
  quota: QuotaSchema.nullable(),
  byModel: z.array(
    z.object({
      model: z.string(),
      cost: z.number(),
      input: z.number(),
      output: z.number(),
      cacheRead: z.number(),
      turns: z.number(),
    }),
  ),
  daily: z.array(z.object({ date: z.string(), cost: z.number(), tokens: z.number() })),
});

/**
 * One day of history, across every account and model. Used by the trend chart, which is the only
 * place a month of spend fits: per-card charts answer "when do I run out", this answers
 * "what did I spend, on what".
 */
export const HistoryDaySchema = z.object({
  date: z.string(),
  cost: z.number(),
  turns: z.number(),
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  /** Cost per account that day, so the chart can stack one line per account. */
  byAccount: z.array(
    z.object({ id: z.string(), label: z.string(), brand: z.string(), color: z.string(), cost: z.number() }),
  ),
  models: z.array(z.object({ model: z.string(), cost: z.number(), turns: z.number() })),
});

export const SnapshotSchema = z.object({
  generatedAt: z.string(),
  totals: TotalsSchema,
  accounts: z.array(AccountStatSchema),
  /** The last 30 days, independent of the current cycle, for the trend panel. */
  history: z.array(HistoryDaySchema),
  warnings: z.array(z.string()),
});

export const SETTINGS_ID = "usage-settings";

export const UsageSettingsSchema = z
  .object({
    accounts: z
      .record(
        z.string(),
        z.object({
          budgetUsd: z.number().min(0).optional(),
          cycleStartDay: z.number().min(1).max(28).optional(),
          label: z.string().max(60).optional(),
        }),
      )
      .default({}),
    /**
     * Hide a card that has neither spend nor allowance: a configured provider nobody has used
     * yet is noise on a screen whose job is answering "what am I spending".
     */
    hideEmptyAccounts: z.boolean().default(false),
    defaultCycleStartDay: z.number().min(1).max(28).default(1),
    /** Hours a full-time working day represents, used to translate spend into days of work. */
    hoursPerWorkday: z.number().min(1).max(24).default(8),
    /** Hourly cost of a workday, used with hoursPerWorkday for the workday estimate. */
    hourlyRateUsd: z.number().min(0).default(0),
  })
  .default({
    accounts: {},
    hideEmptyAccounts: false,
    defaultCycleStartDay: 1,
    hoursPerWorkday: 8,
    hourlyRateUsd: 0,
  });

export const usageSettings = defineSettings({
  id: SETTINGS_ID,
  scope: "host",
  version: 1,
  schema: UsageSettingsSchema,
});

export const accountEntrySchema = z.object({
  id: z.string(),
  label: z.string(),
  extends: z.string(),
  hasKey: z.boolean(),
  hasQuotaCredential: z.boolean(),
  store: z.string().nullable(),
  enabled: z.boolean(),
});

export const accountRpc = defineRpc({
  name: "tallimeter.accounts",
  input: z.discriminatedUnion("action", [
    z.object({ action: z.literal("list") }),
    z.object({
      action: z.literal("add"),
      family: z.enum(["claude", "opencode", "opendesign", "pi"]),
      label: z.string().max(60).default(""),
      apiKey: z.string().max(400).default(""),
      controlKey: z.string().max(400).default(""),
      workspaceId: z.string().max(120).default(""),
    }),
    z.object({ action: z.literal("remove"), id: z.string().min(1) }),
    z.object({ action: z.literal("rename"), id: z.string().min(1), label: z.string().min(1).max(60) }),
  ]),
  output: z.object({
    accounts: z.array(accountEntrySchema),
    message: z.string().nullable(),
  }),
});

export const credentialEntrySchema = z.object({
  id: z.string(),
  label: z.string().nullable(),
  kind: z.string().nullable(),
  workspaceId: z.string().nullable(),
  updatedAt: z.string().nullable(),
  /** Last four characters only. Enough to tell keys apart, useless to an attacker. */
  preview: z.string(),
});

export const credentialsRpc = defineRpc({
  name: "tallimeter.credentials",
  input: z.discriminatedUnion("action", [
    z.object({ action: z.literal("list") }),
    z.object({
      action: z.literal("set"),
      id: z.string().min(1).max(120),
      value: z.string().min(1).max(4096),
      label: z.string().max(60).optional(),
      workspaceId: z.string().max(120).optional(),
      kind: z.enum(["apiKey", "cookie", "controlKey", "oauth"]).optional(),
    }),
    z.object({ action: z.literal("remove"), id: z.string().min(1) }),
    z.object({ action: z.literal("import-browser"), planId: z.string().max(60).optional() }),
    z.object({ action: z.literal("verify"), id: z.string().min(1) }),
  ]),
  output: z.object({
    credentials: z.array(credentialEntrySchema),
    message: z.string().nullable(),
    /** Whether the live API accepted the credential, when verification was requested. */
    verified: z.boolean().nullable(),
  }),
});

export const snapshotRpc = defineRpc({
  name: "tallimeter.snapshot",
  input: z.object({ refreshQuota: z.boolean().default(false) }).default({ refreshQuota: false }),
  output: SnapshotSchema,
});

export type Totals = z.infer<typeof TotalsSchema>;
export type AccountEntry = z.infer<typeof accountEntrySchema>;
export type QuotaWindow = z.infer<typeof QuotaWindowSchema>;
export type ProviderBrand = z.infer<typeof providerBrandSchema>;
export type CredentialEntry = z.infer<typeof credentialEntrySchema>;
export type AccountStat = z.infer<typeof AccountStatSchema>;
export type Snapshot = z.infer<typeof SnapshotSchema>;
export type Quota = z.infer<typeof QuotaSchema>;
export type UsageSettings = z.infer<typeof UsageSettingsSchema>;
