import type { AccountStat, Quota, Totals } from "../shared/contracts";
import { costOf, type Price } from "./prices";
import { brandForTurnProvider } from "./registry";
import { readTurns, type StoreRef, type Turn } from "./stores";

export type { Price };

/**
 * Converts spend into days of work. Needs a non-zero hourly rate: without one, "days of work"
 * would be an invented number, so the plugin reports null instead.
 */
function workdays(usd: number | null, hourlyRateUsd: number, hoursPerWorkday: number): number | null {
  if (usd === null || hourlyRateUsd <= 0) return null;
  return usd / (hourlyRateUsd * hoursPerWorkday);
}

/** The card's stable id, and the label shown on it. Both come from one place so they agree. */
function cardId(bucket: Bucket): string {
  return `${bucket.store.id}:${bucket.provider}`;
}

function cardLabel(
  bucket: Bucket,
  override: string | undefined,
  input: AggregateInput,
): string {
  if (override) return override;
  if (bucket.provider === "opendesign") {
    const plan = input.openDesignPlans?.[bucket.planId ?? "default"];
    // A plan the user has not named is simply OpenDesign; appending "shared plan" to every card
    // is noise, and there is only one plan to disambiguate from until they name a second.
    return plan && plan !== "shared plan" ? `OpenDesign · ${plan}` : "OpenDesign";
  }
  return bucket.label || `${providerLabel(bucket.provider, bucket.kind)}${storeSuffix(bucket)}`;
}

/**
 * The budget for a card, looked up by every key it answers to.
 *
 * A merged OpenDesign plan is fed by several harnesses, so which store happened to arrive first
 * decides its card id: setting a budget against that one id would silently stop applying the day a
 * different agent runs first. The card therefore accepts the budget under any provider id that fed
 * it, and under the plan key, which is what the plan itself is called.
 */
function budgetFor(
  bucket: Bucket,
  budgets: AggregateInput["budgets"],
): { budgetUsd?: number; cycleStartDay?: number; label?: string } {
  // A card id is <store>:<vendor>, so every harness that fed the card names a valid key.
  const keys = [
    bucket.store.id,
    cardId(bucket),
    ...bucket.storeIds,
    ...bucket.storeIds.map((id) => `${id}:${bucket.provider}`),
  ];
  if (bucket.planId) keys.push("plan:" + bucket.planId);
  for (const key of keys) {
    const found = budgets[key];
    if (found) return found;
  }
  return {};
}

/** A brand as the card schema needs it: every field present, never optional. */
function resolveBrand(provider: string) {
  const brand = brandForTurnProvider(provider);
  return {
    ...brand,
    mark: brand.mark ?? "",
    tile: brand.tile ?? brand.color,
    bleed: brand.bleed ?? false,
    mono: brand.mono ?? true,
  };
}

const emptyTotals = (): Totals => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
  cost: 0,
  turns: 0,
});

/** Billing cycle that starts on `day` and contains `now`. */
export function periodFor(day: number, now = new Date()) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  if (now.getDate() >= day) start.setMonth(now.getMonth(), day);
  else start.setMonth(now.getMonth() - 1, day);
  const end = new Date(start);
  end.setMonth(end.getMonth() + 1);
  return { start, end };
}

export interface AggregateInput {
  refs: StoreRef[];
  budgets: Record<string, { budgetUsd?: number; cycleStartDay?: number; label?: string }>;
  defaultStartDay: number;
  quotas: Map<string, Quota | null>;
  prices: Record<string, Price>;
  hoursPerWorkday: number;
  hourlyRateUsd: number;
  /** Which plan pays for a store's OpenDesign turns. Defaults to the shared plan. */
  openDesignPlanFor?: (storeId: string) => string;
  /** Display name per plan id, for the card title. */
  openDesignPlans?: Record<string, string>;
  /** Reads allowance for a store and the vendor that served its turns. */
  resolveQuota?: (ref: StoreRef, vendor: string) => Promise<Quota | null>;
  /**
   * Leave out a card with no spend, no window and no balance. A card always shown is one that
   * would tell the user something; the rest is a provider entry that has never run.
   */
  hideEmptyAccounts?: boolean;
}

/** Human name for a provider id as the agents themselves report it. */
function providerLabel(provider: string, kind: string): string {
  switch (provider) {
    case "anthropic":
      return "Claude";
    case "opendesign":
      return "OpenDesign";
    case "opencode":
      return "OpenCode";
    case "opencode-go":
      return "OpenCode Go";
    default:
      if (kind === "opendesign") return "OpenDesign";
      if (kind === "claude") return "Claude";
      if (kind === "pi") return provider;
      return provider;
  }
}

/**
 * A merged card is one subscription fed by several harnesses, and naming the harnesses in the
 * title reads badly. The store list is still shown inside the card, so the title stays short.
 */
function storeSuffix(bucket: { stores: string[]; provider: string }): string {
  const unique = [...new Set(bucket.stores)].filter(Boolean);
  if (unique.length === 0) return "";
  // Naming the owning store is what tells two plans apart, so a merge of three or more keeps
  // the first two names instead of dropping the suffix entirely.
  return ` · ${unique.slice(0, 2).join(" + ")}`;
}

/** OpenDesign is reached through several harnesses, so its turns are one subscription, one card. */
function quotaKeyFor(ref: StoreRef, provider: string, kind: string, planId: string): string | null {
  // One plan is one card. Every OpenDesign turn lands on the plan that pays for it, whichever
  // harness served it, so OpenCode and Pi turns cannot end up as two cards for one subscription.
  if (provider === "opendesign" || kind === "opendesign") return `plan:${planId}`;
  if (ref.quotaKind === "anthropic" && provider === "anthropic") return ref.id;
  // A provider entry that has no gateway URL still reads Anthropic quota for Claude turns.
  if (ref.quotaKind === "opendesign-or-anthropic" && provider === "anthropic") return ref.id;
  if (ref.quotaKind === "opencode-go" && (provider === "opencode" || provider === "opencode-go")) return ref.id;
  return null;
}

interface Bucket {
  id: string;
  label: string;
  provider: string;
  kind: AccountStat["kind"];
  store: StoreRef;
  /** Every store that fed this card, deduplicated when the label is built. */
  stores: string[];
  /** Every provider id that fed this card, so a budget can be found by any of them. */
  storeIds: string[];
  turns: Turn[];
  quotaKey: string | null;
  /** The OpenDesign plan this card spends against, when it is one. */
  planId?: string;
}

/**
 * How far back the aggregator asks for turns. A cycle can start up to a month back and the trend
 * window looks thirty days back, so sixty-two days covers both with margin.
 */
const LOOKBACK_MS = 62 * 86_400_000;

export async function buildSnapshot(input: AggregateInput): Promise<{
  accounts: AccountStat[];
  totals: Totals;
  warnings: string[];
  history: Array<{
    date: string;
    cost: number;
    turns: number;
    input: number;
    output: number;
    cacheRead: number;
    byAccount: Array<{ id: string; label: string; brand: string; color: string; cost: number }>;
    models: Array<{ model: string; cost: number; turns: number }>;
  }>;
}> {
  const now = new Date();
  const warnings: string[] = [];
  const accounts: AccountStat[] = [];
  const totals = emptyTotals();
  const historyDays = new Map<string, {
    date: string;
    cost: number;
    turns: number;
    input: number;
    output: number;
    cacheRead: number;
    byAccount: Map<string, { id: string; label: string; brand: string; color: string; cost: number }>;
    models: Map<string, { model: string; cost: number; turns: number }>;
  }>();

  const buckets = new Map<string, Bucket>();

  // The trend window is fixed at 30 days, so the panel is useful even when the cycle just reset.
  const historyStart = now.getTime() - 30 * 86_400_000;

  // Read every store once, then split its turns by the provider that served them.
  for (const ref of input.refs) {
    let turns: Turn[];
    try {
      turns = await readTurns(ref, now.getTime() - LOOKBACK_MS);
    } catch (error) {
      warnings.push(`${ref.label}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const planId = input.openDesignPlanFor?.(ref.id) ?? "default";
    // Claude transcripts never name their provider, so a gateway store (OpenDesign, Z.AI) is
    // known only from its own config. Without this, gateway turns would be counted as Anthropic.
    const normalised =
      ref.kind === "opendesign"
        ? turns.map((turn) => (turn.provider === "anthropic" ? { ...turn, provider: "opendesign" } : turn))
        : turns;
    for (const turn of normalised) {
      const quotaKey = quotaKeyFor(ref, turn.provider, ref.kind, planId);
      // One card per plan, aggregating every harness that spends against it.
      const key =
        turn.provider === "opendesign" || ref.kind === "opendesign"
          ? `plan:${planId}`
          : `${ref.id}|${turn.provider}`;
      const existing =
        buckets.get(key) ??
        ({
          id: key,
          label: turn.provider === "opendesign" ? "" : ref.label,
          provider: turn.provider,
          kind: turn.provider === "opendesign" ? "opendesign" : ref.kind,
          store: ref,
          stores: [ref.label],
          storeIds: [ref.id],
          turns: [],
          quotaKey,
          planId,
        } satisfies Bucket);
      existing.turns.push(turn);
      existing.stores.push(ref.label);
      if (!existing.storeIds.includes(ref.id)) existing.storeIds.push(ref.id);
      // Two plans are told apart by the harnesses that spend on them, so remember every store.
      buckets.set(key, existing);
    }
  }

  // Every configured provider gets a card, so an account you track but have not used yet is
  // visible with an empty state instead of silently missing. Refs that share one subscription
  // (every OpenDesign harness) collapse onto the plan's single card.
  for (const ref of input.refs) {
    const alreadyUsed = [...buckets.values()].some((bucket) => bucket.store.id === ref.id);
    if (alreadyUsed) continue;
    // An unused OpenDesign provider belongs to the shared plan's card, not a card of its own.
    if (ref.kind === "opendesign") {
      const planId = input.openDesignPlanFor?.(ref.id) ?? "default";
      const key = `plan:${planId}`;
      if (buckets.has(key)) continue;
      buckets.set(key, {
        id: key,
        label: ref.label,
        provider: "opendesign",
        kind: "opendesign",
        store: ref,
        stores: [ref.label],
        storeIds: [ref.id],
        turns: [],
        quotaKey: key,
        planId,
      });
      continue;
    }
    const key = `${ref.id}|providers`;
    if (buckets.has(key)) continue;
    buckets.set(key, {
      id: key,
      // A card for an unused account keeps its provider label, so "Claude 1" stays "Claude 1".
      label: ref.label,
      provider: ref.kind,
      kind: ref.kind,
      store: ref,
      stores: [ref.label],
      storeIds: [ref.id],
      turns: [],
      quotaKey:
        ref.quotaKind === "opendesign-or-anthropic"
          ? ref.id
          : ref.quotaKind === "none"
            ? null
            : ref.id,
    });
  }

  // Every provider that can spend against a card's plan, so a budget set on any of them is found
  // by the shared card whichever harness happened to produce its first turn. A merged plan's card
  // is built from one store, and a budget written against another one must still apply.
  const providersPerPlan = new Map<string, string[]>();
  for (const ref of input.refs) {
    const planId = input.openDesignPlanFor?.(ref.id) ?? "default";
    const list = providersPerPlan.get(planId) ?? [];
    list.push(ref.id);
    providersPerPlan.set(planId, list);
  }
  for (const bucket of buckets.values()) {
    if (!bucket.planId) continue;
    for (const id of providersPerPlan.get(bucket.planId) ?? []) {
      if (!bucket.storeIds.includes(id)) bucket.storeIds.push(id);
    }
  }

  for (const bucket of buckets.values()) {
    const budget = budgetFor(bucket, input.budgets);
    const startDay = budget.cycleStartDay ?? input.defaultStartDay;
    const { start, end } = periodFor(startDay, now);
    // Days for the trend panel, from this bucket's own turns.
    for (const turn of bucket.turns) {
      if (turn.at < historyStart) continue;
      const date = new Date(turn.at).toISOString().slice(0, 10);
      const day = historyDays.get(date) ?? {
        date,
        cost: 0,
        turns: 0,
        input: 0,
        output: 0,
        cacheRead: 0,
        byAccount: new Map<string, { id: string; label: string; brand: string; color: string; cost: number }>(),
        models: new Map<string, { model: string; cost: number; turns: number }>(),
      };
      const cost = typeof turn.cost === "number" && turn.cost > 0
        ? turn.cost
        : costOf(turn.model, { input: turn.input, output: turn.output, cacheRead: turn.cacheRead, cacheWrite: turn.cacheWrite }, input.prices) ?? 0;
      day.cost += cost;
      day.turns += 1;
      day.input += turn.input;
      day.output += turn.output;
      day.cacheRead += turn.cacheRead;

      const id = cardId(bucket);
      const accountEntry = day.byAccount.get(id) ?? {
        id,
        label: cardLabel(bucket, budget.label, input),
        brand: brandForTurnProvider(bucket.provider).label,
        color: brandForTurnProvider(bucket.provider).color,
        cost: 0,
      };
      accountEntry.cost += cost;
      day.byAccount.set(id, accountEntry);

      const modelEntry = day.models.get(turn.model) ?? { model: turn.model, cost: 0, turns: 0 };
      modelEntry.cost += cost;
      modelEntry.turns += 1;
      day.models.set(turn.model, modelEntry);

      historyDays.set(date, day);
    }

    const inPeriod = bucket.turns.filter((turn) => turn.at >= start.getTime() && turn.at <= end.getTime());
    // An empty card is a valid state: it says the account exists and has no usage this cycle.
    let quotaForBucket = bucket.quotaKey ? input.quotas.get(bucket.quotaKey) ?? null : null;
    // A bucket's vendor is the provider that served its turns, which is how allowance is found.
    if (!quotaForBucket && input.resolveQuota) {
      const vendor = bucket.provider === "opendesign" ? "opendesign" : bucket.provider;
      quotaForBucket = await input.resolveQuota(bucket.store, vendor).catch(() => null);
      if (quotaForBucket && bucket.quotaKey) input.quotas.set(bucket.quotaKey, quotaForBucket);
    }
    const accountTotals = emptyTotals();
    const perModel = new Map<string, { cost: number; input: number; output: number; cacheRead: number; turns: number }>();
    const dailyMap = new Map<string, { cost: number; tokens: number }>();
    let unknownPriced = false;

    for (const turn of inPeriod) {
      const reported = typeof turn.cost === "number" && turn.cost > 0 ? turn.cost : null;
      let cost = reported;
      if (cost === null) {
        const estimate = costOf(
          turn.model,
          { input: turn.input, output: turn.output, cacheRead: turn.cacheRead, cacheWrite: turn.cacheWrite },
          input.prices,
        );
        if (estimate === null) {
          unknownPriced = true;
          cost = 0;
        } else {
          cost = estimate;
        }
      }
      accountTotals.input += turn.input;
      accountTotals.output += turn.output;
      accountTotals.cacheRead += turn.cacheRead;
      accountTotals.cacheWrite += turn.cacheWrite;
      accountTotals.reasoning += turn.reasoning;
      accountTotals.cost += cost;
      accountTotals.turns += 1;

      const model = perModel.get(turn.model) ?? { cost: 0, input: 0, output: 0, cacheRead: 0, turns: 0 };
      model.cost += cost;
      model.input += turn.input;
      model.output += turn.output;
      model.cacheRead += turn.cacheRead;
      model.turns += 1;
      perModel.set(turn.model, model);

      const date = new Date(turn.at).toISOString().slice(0, 10);
      const daily = dailyMap.get(date) ?? { cost: 0, tokens: 0 };
      daily.cost += cost;
      daily.tokens += turn.input + turn.output + turn.cacheRead + turn.cacheWrite;
      dailyMap.set(date, daily);
    }

    const elapsedDays = Math.max((now.getTime() - start.getTime()) / 86_400_000, 0.25);
    const totalDays = Math.max((end.getTime() - start.getTime()) / 86_400_000, 1);
    const daysLeft = Math.max(totalDays - elapsedDays, 0);
    const costPerDay = accountTotals.cost / elapsedDays;
    const projectedUsd = costPerDay * totalDays;
    const budgetUsd = budget.budgetUsd ?? null;
    const spentPct = budgetUsd && budgetUsd > 0 ? (accountTotals.cost / budgetUsd) * 100 : null;
    const projectionPct = budgetUsd && budgetUsd > 0 ? (projectedUsd / budgetUsd) * 100 : null;
    const remainingUsd = budgetUsd !== null ? budgetUsd - accountTotals.cost : null;
    const cacheDenominator = accountTotals.input + accountTotals.cacheRead + accountTotals.cacheWrite;
    const cacheHitPct = cacheDenominator > 0 ? (accountTotals.cacheRead / cacheDenominator) * 100 : null;
    const lastActivity =
      inPeriod.length > 0 ? new Date(Math.max(...inPeriod.map((turn) => turn.at))).toISOString() : null;
    const elapsedHours = Math.max((now.getTime() - start.getTime()) / 3_600_000, 0.5);

    if (unknownPriced) {
      warnings.push(
        `${providerLabel(bucket.provider, bucket.kind)} in ${bucket.store.label}: a model has no known price, so that spend is counted as zero`,
      );
    }

    const quota = quotaForBucket;

    // A card with nothing to say is hidden only when asked: the empty state is a real answer
    // ("this account exists and has not spent"), just not a useful one on a short screen.
    const informative =
      accountTotals.cost > 0 || (quota?.windows.length ?? 0) > 0 || (quota?.balanceUsd ?? null) !== null;
    if (input.hideEmptyAccounts && !informative) continue;

    accounts.push({
      id: cardId(bucket),
      label: cardLabel(bucket, budget.label, input),
      provider: bucket.provider,
      brand: resolveBrand(bucket.provider),
      kind: bucket.kind,
      store: bucket.store.store,
      harnesses: [...new Set(bucket.stores)],
      periodStart: start.toISOString(),
      periodEnd: end.toISOString(),
      totals: { ...accountTotals },
      cacheHitPct,
      budgetUsd,
      spentPct,
      remainingUsd,
      projectedUsd,
      projectionPct,
      costPerDay,
      tokensPerHour:
        (accountTotals.input +
          accountTotals.output +
          accountTotals.cacheRead +
          accountTotals.cacheWrite +
          accountTotals.reasoning) /
        elapsedHours,
      workdaysSpent: workdays(accountTotals.cost, input.hourlyRateUsd, input.hoursPerWorkday),
      workdaysLeft: workdays(remainingUsd, input.hourlyRateUsd, input.hoursPerWorkday),
      lastActivity,
      daysLeft,
      quota,
      byModel: [...perModel.entries()].map(([model, value]) => ({ model, ...value })).sort((a, b) => b.cost - a.cost),
      daily: [...dailyMap.entries()].map(([date, value]) => ({ date, ...value })).sort((a, b) => a.date.localeCompare(b.date)),
    });

    totals.input += accountTotals.input;
    totals.output += accountTotals.output;
    totals.cacheRead += accountTotals.cacheRead;
    totals.cacheWrite += accountTotals.cacheWrite;
    totals.reasoning += accountTotals.reasoning;
    totals.cost += accountTotals.cost;
    totals.turns += accountTotals.turns;
  }

  // Fill the gaps so the chart has one point per day, not one per day with activity.
  const history = [];
  for (let offset = 29; offset >= 0; offset -= 1) {
    const date = new Date(now.getTime() - offset * 86_400_000).toISOString().slice(0, 10);
    const day = historyDays.get(date);
    history.push({
      date,
      cost: day?.cost ?? 0,
      turns: day?.turns ?? 0,
      input: day?.input ?? 0,
      output: day?.output ?? 0,
      cacheRead: day?.cacheRead ?? 0,
      byAccount: [...(day?.byAccount.values() ?? [])].sort((a, b) => b.cost - a.cost),
      models: [...(day?.models.values() ?? [])].sort((a, b) => b.cost - a.cost),
    });
  }

  return { accounts: accounts.sort((a, b) => b.totals.cost - a.totals.cost), totals, warnings, history };
}
