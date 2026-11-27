import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildSnapshot } from "../server/aggregate";
import type { StoreRef } from "../server/stores";
import type { Quota } from "../shared/contracts";

/**
 * End-to-end through the aggregator with a synthetic transcript on disk: grouping, cost,
 * cache ratio, projection and the plan merge. No Paseo, no network, no real credential.
 */
let root = "";

function claudeTurn(timestamp: string, model: string, usage: Record<string, number>) {
  return JSON.stringify({ timestamp, message: { model, usage } });
}

function writeClaudeStore(dir: string, lines: string[]) {
  const projects = join(dir, "projects", "-demo-");
  mkdirSync(projects, { recursive: true });
  writeFileSync(join(projects, "session.jsonl"), lines.join("\n"));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tallimeter-aggregate-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const claudeRef = (dir: string): StoreRef => ({
  id: "claude-1",
  label: "Claude 1",
  provider: "claude-1",
  kind: "claude",
  store: dir,
  reader: "claude-jsonl",
  quotaKind: "anthropic",
});

// Claude list price, so a Claude turn has a real cost rather than the unknown-price warning.
const plans = {
  "deepseek-v4.1-flash-eco": { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0.3 },
  "claude-sonnet-5-5": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
};

describe("aggregate grouping", () => {
  it("builds one card per store and vendor", async () => {
    const dir = join(root, "claude");
    writeClaudeStore(dir, [
      claudeTurn(new Date().toISOString(), "claude-sonnet-5-5", { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200 }),
    ]);
    const result = await buildSnapshot({
      refs: [claudeRef(dir)],
      budgets: {},
      defaultStartDay: 1,
      quotas: new Map(),
      prices: plans,
      hoursPerWorkday: 8,
      hourlyRateUsd: 0,
    });
    expect(result.accounts).toHaveLength(1);
    expect(result.accounts[0]?.provider).toBe("anthropic");
    expect(result.accounts[0]?.brand.id).toBe("anthropic");
  });

  it("computes the cache hit ratio from cache reads against total input", async () => {
    const dir = join(root, "claude");
    writeClaudeStore(dir, [
      claudeTurn(new Date().toISOString(), "claude-sonnet-5-5", { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 }),
    ]);
    const result = await buildSnapshot({
      refs: [claudeRef(dir)], budgets: {}, defaultStartDay: 1, quotas: new Map(), prices: plans, hoursPerWorkday: 8, hourlyRateUsd: 0,
    });
    // 900 of (100 + 900 + 0) = 90%.
    expect(result.accounts[0]?.cacheHitPct).toBeCloseTo(90, 1);
  });

  it("counts every turn and sums tokens", async () => {
    const dir = join(root, "claude");
    const now = new Date().toISOString();
    writeClaudeStore(dir, [
      claudeTurn(now, "claude-sonnet-5-5", { input_tokens: 100, output_tokens: 20 }),
      claudeTurn(now, "claude-sonnet-5-5", { input_tokens: 200, output_tokens: 30 }),
    ]);
    const result = await buildSnapshot({
      refs: [claudeRef(dir)], budgets: {}, defaultStartDay: 1, quotas: new Map(), prices: plans, hoursPerWorkday: 8, hourlyRateUsd: 0,
    });
    expect(result.accounts[0]?.totals.turns).toBe(2);
    expect(result.accounts[0]?.totals.input).toBe(300);
    expect(result.accounts[0]?.totals.output).toBe(50);
  });

  it("ignores turns outside the cycle", async () => {
    const dir = join(root, "claude");
    const old = new Date(Date.now() - 90 * 86_400_000).toISOString();
    writeClaudeStore(dir, [claudeTurn(old, "claude-sonnet-5-5", { input_tokens: 100, output_tokens: 20 })]);
    const result = await buildSnapshot({
      refs: [claudeRef(dir)], budgets: {}, defaultStartDay: 1, quotas: new Map(), prices: plans, hoursPerWorkday: 8, hourlyRateUsd: 0,
    });
    // A configured account still gets a card, but with an empty cycle.
    expect(result.accounts[0]?.totals.turns).toBe(0);
  });

  it("warns once per card whose model has no price", async () => {
    const dir = join(root, "claude");
    writeClaudeStore(dir, [claudeTurn(new Date().toISOString(), "unknown-model", { input_tokens: 100, output_tokens: 20 })]);
    const result = await buildSnapshot({
      refs: [claudeRef(dir)], budgets: {}, defaultStartDay: 1, quotas: new Map(), prices: {}, hoursPerWorkday: 8, hourlyRateUsd: 0,
    });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("no known price");
  });

  it("attaches the plan allowance to the card that spent on it", async () => {
    const dir = join(root, "claude");
    writeClaudeStore(dir, [claudeTurn(new Date().toISOString(), "claude-sonnet-5-5", { input_tokens: 10, output_tokens: 5 })]);
    const quota: Quota = {
      source: "anthropic",
      planLabel: "Claude Max 5x",
      windows: [{ id: "five_hour", label: "5-hour", shortLabel: "5h", usedPct: 40, resetsAt: null }],
      balanceUsd: null,
      balanceLimitUsd: null,
      balanceUnit: null,
      note: null,
      fetchedAt: new Date().toISOString(),
    };
    const result = await buildSnapshot({
      refs: [claudeRef(dir)],
      budgets: {},
      defaultStartDay: 1,
      quotas: new Map([["quota:claude-1:anthropic", quota]]),
      prices: plans,
      hoursPerWorkday: 8,
      hourlyRateUsd: 0,
      resolveQuota: async () => quota,
    });
    expect(result.accounts[0]?.quota?.windows).toHaveLength(1);
  });

  it("projects the cycle from the pace so far, never negative days", async () => {
    const dir = join(root, "claude");
    writeClaudeStore(dir, [claudeTurn(new Date().toISOString(), "claude-sonnet-5-5", { input_tokens: 1000, output_tokens: 500 })]);
    const result = await buildSnapshot({
      refs: [claudeRef(dir)], budgets: {}, defaultStartDay: 1, quotas: new Map(), prices: plans, hoursPerWorkday: 8, hourlyRateUsd: 0,
    });
    const account = result.accounts[0];
    expect(account?.projectedUsd ?? 0).toBeGreaterThan(0);
    expect(account?.daysLeft ?? -1).toBeGreaterThanOrEqual(0);
  });

  it("translates spend into workdays only when an hourly rate is set", async () => {
    const dir = join(root, "claude");
    writeClaudeStore(dir, [claudeTurn(new Date().toISOString(), "claude-sonnet-5-5", { input_tokens: 100, output_tokens: 50 })]);
    const withoutRate = await buildSnapshot({
      refs: [claudeRef(dir)], budgets: {}, defaultStartDay: 1, quotas: new Map(), prices: plans, hoursPerWorkday: 8, hourlyRateUsd: 0,
    });
    expect(withoutRate.accounts[0]?.workdaysSpent).toBeNull();

    const withRate = await buildSnapshot({
      refs: [claudeRef(dir)], budgets: {}, defaultStartDay: 1, quotas: new Map(), prices: plans, hoursPerWorkday: 8, hourlyRateUsd: 50,
    });
    expect(withRate.accounts[0]?.workdaysSpent).not.toBeNull();
  });

  it("keeps an empty card for a configured account, without inventing cost", async () => {
    const dir = join(root, "claude");
    mkdirSync(dir, { recursive: true });
    const result = await buildSnapshot({
      refs: [claudeRef(dir)], budgets: {}, defaultStartDay: 1, quotas: new Map(), prices: plans, hoursPerWorkday: 8, hourlyRateUsd: 0,
    });
    expect(result.accounts).toHaveLength(1);
    expect(result.accounts[0]?.totals.cost).toBe(0);
    expect(result.accounts[0]?.totals.turns).toBe(0);
  });

  it("groups OpenDesign turns from two harnesses onto cards keyed by plan", async () => {
    const dirA = join(root, "a");
    const dirB = join(root, "b");
    writeClaudeStore(dirA, [claudeTurn(new Date().toISOString(), "claude-sonnet-5-5", { input_tokens: 10, output_tokens: 5 })]);
    writeClaudeStore(dirB, [claudeTurn(new Date().toISOString(), "claude-sonnet-5-5", { input_tokens: 10, output_tokens: 5 })]);
    // A gateway provider reports its turns as `opendesign`, which is what the merge uses.
    const result = await buildSnapshot({
      refs: [
        { ...claudeRef(dirA), id: "opendesign-1", kind: "opendesign", quotaKind: "opendesign" },
        { ...claudeRef(dirB), id: "opendesign-2", kind: "opendesign", quotaKind: "opendesign" },
      ],
      budgets: {},
      defaultStartDay: 1,
      quotas: new Map(),
      prices: plans,
      hoursPerWorkday: 8,
      hourlyRateUsd: 0,
      openDesignPlanFor: (storeId) => storeId,
      openDesignPlans: { "opendesign-1": "personal", "opendesign-2": "work" },
    });
    expect(result.accounts).toHaveLength(2);
    expect(result.accounts.map((account) => account.label)).toEqual(
      expect.arrayContaining(["OpenDesign · personal", "OpenDesign · work"]),
    );
  });
});
