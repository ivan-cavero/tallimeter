import { describe, expect, it } from "vitest";
import { parseAnthropicUsage } from "../server/quota/anthropic";
import { parseCodexUsage } from "../server/quota/codex";
import { parseGeminiQuota } from "../server/quota/gemini";
import { parseOllamaBalance } from "../server/quota/ollama";
import { parseGoUsage } from "../server/quota/opencode-go";
import { parseOpenDesignPlan } from "../server/quota/opendesign";
import { parseOpenRouterKey } from "../server/quota/openrouter";
import * as fixtures from "./fixtures";

/** Every window must stay inside 0–100 whatever the vendor reports. */
function expectClamped(windows: Array<{ usedPct: number }>) {
  for (const window of windows) {
    expect(window.usedPct).toBeGreaterThanOrEqual(0);
    expect(window.usedPct).toBeLessThanOrEqual(100);
  }
}

describe("anthropic", () => {
  it("maps the 5-hour, weekly and model-scoped windows", () => {
    const { windows } = parseAnthropicUsage(fixtures.anthropicUsage);
    expect(windows.map((window) => window.id)).toEqual(
      expect.arrayContaining(["five_hour", "seven_day", "seven_day_opus", "weekly_fable_5_2"]),
    );
  });

  it("keeps utilization as used percent, not remaining", () => {
    const { windows } = parseAnthropicUsage(fixtures.anthropicUsage);
    const fiveHour = windows.find((window) => window.id === "five_hour");
    expect(fiveHour?.usedPct).toBe(42.5);
  });

  it("ignores limits of another kind and entries with no percent", () => {
    const { windows } = parseAnthropicUsage(fixtures.anthropicUsage);
    expect(windows.some((window) => window.id === "something_else")).toBe(false);
    expect(windows.every((window) => window.id !== "")).toBe(true);
  });

  it("converts extra usage from minor units to dollars", () => {
    const { extra } = parseAnthropicUsage(fixtures.anthropicUsage);
    expect(extra?.spendUsd).toBeCloseTo(12.34);
    expect(extra?.limitUsd).toBeCloseTo(50);
  });

  it("returns no windows and no extra usage for an empty body", () => {
    const parsed = parseAnthropicUsage(fixtures.anthropicEmpty);
    expect(parsed.windows).toHaveLength(0);
    expect(parsed.extra).toBeNull();
  });

  it("clamps an out-of-range utilization", () => {
    const parsed = parseAnthropicUsage({ five_hour: { utilization: 140 } });
    expectClamped(parsed.windows);
    expect(parsed.windows[0]?.usedPct).toBe(100);
  });
});

describe("opencode go", () => {
  it("maps rolling, weekly and monthly windows", () => {
    const windows = parseGoUsage(fixtures.openCodeGoUsage);
    expect(windows.map((window) => window.id)).toEqual(["rolling", "weekly", "monthly"]);
  });

  it("treats rate-limited as a full window rather than dropping it", () => {
    const windows = parseGoUsage(fixtures.openCodeGoRateLimited);
    const rolling = windows.find((window) => window.id === "rolling");
    expect(rolling?.usedPct).toBe(100);
  });

  it("keeps a partial payload working", () => {
    const windows = parseGoUsage({ usage: { weekly: { percent: 3, resetsAt: "2026-12-01T00:00:00Z" } } });
    expect(windows).toHaveLength(1);
    expect(windows[0]?.id).toBe("weekly");
  });

  it("clamps percentages above 100", () => {
    expectClamped(parseGoUsage({ usage: { rolling: { percent: 250 } } }));
  });

  it("returns nothing for an empty payload", () => {
    expect(parseGoUsage({})).toHaveLength(0);
  });
});

describe("opendesign", () => {
  it("identifies windows by duration, never array position", () => {
    const normal = parseOpenDesignPlan(fixtures.openDesignPreflight);
    const reversed = parseOpenDesignPlan(fixtures.openDesignPreflightReordered);
    const byId = (plan: ReturnType<typeof parseOpenDesignPlan>) =>
      Object.fromEntries(plan.windows.map((window) => [window.id, window.usedPct]));
    expect(byId(reversed)).toEqual(byId(normal));
    // The 5-hour window is always the 18000-second one.
    expect(byId(normal).five_hour).toBeCloseTo(2869 / 50000 * 100, 3);
  });

  it("reads the wallet balance and the plan tier", () => {
    const plan = parseOpenDesignPlan(fixtures.openDesignPreflight);
    expect(plan.balanceUsd).toBeCloseTo(1.25);
    expect(plan.planLabel).toBe("go");
    expect(plan.eligible).toBe(true);
  });

  it("reports an unsubscribed workspace as ineligible with a balance", () => {
    const plan = parseOpenDesignPlan(fixtures.openDesignNoPlan);
    expect(plan.windows).toHaveLength(0);
    expect(plan.eligible).toBe(false);
    expect(plan.balanceUsd).toBeCloseTo(3.5);
  });

  it("never divides by a zero limit", () => {
    const plan = parseOpenDesignPlan({
      codingPlan: { eligible: true, windows: [{ durationSeconds: 18000, usedCredits: "10", limitCredits: "0" }] },
    });
    expect(plan.windows).toHaveLength(0);
  });

  it("accepts a numeric body as well as decimal strings", () => {
    const plan = parseOpenDesignPlan({
      codingPlan: { windows: [{ durationSeconds: 18_000, usedCredits: 100, limitCredits: 1000 }] },
    });
    expect(plan.windows[0]?.usedPct).toBeCloseTo(10);
  });
});

describe("openrouter", () => {
  it("uses the effective budget as the only real window", () => {
    const quota = parseOpenRouterKey(fixtures.openRouterKey.data);
    expect(quota.windows).toHaveLength(1);
    expect(quota.windows[0]?.usedPct).toBeCloseTo(25.5);
    expect(quota.windows[0]?.resetsAt).toContain("2026-12-01");
  });

  it("reports the remaining credit balance in dollars", () => {
    const quota = parseOpenRouterKey(fixtures.openRouterKey.data);
    expect(quota.balanceUsd).toBeCloseTo(74.5);
    expect(quota.balanceUnit).toBe("usd");
  });

  it("gives a free-tier key no spend window but keeps its note", () => {
    const quota = parseOpenRouterKey(fixtures.openRouterFreeTier.data);
    expect(quota.windows).toHaveLength(0);
    expect(quota.note).toContain("Free tier");
  });

  it("does not treat a null limit as an exhausted window", () => {
    const quota = parseOpenRouterKey({ limit: null, limit_remaining: 10, effective_budget: null });
    expect(quota.windows).toHaveLength(0);
    expect(quota.balanceUsd).toBe(10);
  });
});

describe("ollama", () => {
  it("reads the monthly pool from the disclosed allowance", () => {
    const quota = parseOllamaBalance(fixtures.ollamaBalance);
    expect(quota.windows).toHaveLength(1);
    expect(quota.windows[0]?.id).toBe("monthly");
    // 72.5 left of 100 means 27.5% consumed.
    expect(quota.windows[0]?.usedPct).toBeCloseTo(27.5);
    expect(quota.windows[0]?.resetsAt).toContain("2026-12-15");
  });

  it("keeps purchased credits as a separate balance", () => {
    const quota = parseOllamaBalance(fixtures.ollamaBalance);
    expect(quota.balanceUsd).toBeCloseTo(25);
  });

  it("maps a legacy plan's remaining percentages to used percentages", () => {
    const quota = parseOllamaBalance(fixtures.ollamaLegacy);
    const session = quota.windows.find((window) => window.id === "session");
    expect(session?.usedPct).toBe(25);
    expect(quota.windows.find((window) => window.id === "weekly")?.usedPct).toBe(60);
  });

  it("never derives a window from a body with no numbers", () => {
    const quota = parseOllamaBalance({ included: {}, purchased: {} });
    expect(quota.windows).toHaveLength(0);
    expect(quota.note).toContain("No readable allowance");
  });
});

describe("codex", () => {
  it("reads a flat snake_case body", () => {
    const quota = parseCodexUsage(fixtures.codexFlat);
    expect(quota.windows.map((window) => window.id)).toEqual(["five_hour", "weekly"]);
    expect(quota.windows[0]?.usedPct).toBe(23);
    expect(quota.windows[1]?.usedPct).toBe(55);
  });

  it("reads the same data nested with camelCase keys", () => {
    const quota = parseCodexUsage(fixtures.codexNested);
    expect(quota.windows[0]?.usedPct).toBe(23);
    expect(quota.windows[1]?.usedPct).toBe(55);
  });

  it("keeps credits as a balance", () => {
    expect(parseCodexUsage(fixtures.codexFlat).balanceUsd).toBeCloseTo(4.2);
  });

  it("says so when the dashboard reported nothing", () => {
    const quota = parseCodexUsage({});
    expect(quota.windows).toHaveLength(0);
    expect(quota.note).toContain("no windows");
  });
});

describe("gemini", () => {
  it("turns remainingFraction into used percent", () => {
    const quota = parseGeminiQuota(fixtures.geminiQuota);
    expect(quota?.windows.map((window) => window.id)).toEqual(["gemini-2.5-pro", "gemini-2.5-flash"]);
    expect(quota?.windows[0]?.usedPct).toBeCloseTo(38);
    expect(quota?.windows[1]?.usedPct).toBeCloseTo(10);
  });

  it("skips a bucket with no fraction instead of rendering 0%", () => {
    const quota = parseGeminiQuota(fixtures.geminiQuota);
    expect(quota?.windows.some((window) => window.id === "gemini-2.5-flash-lite")).toBe(false);
  });

  it("returns null when no bucket is readable", () => {
    expect(parseGeminiQuota({ buckets: [{ modelId: "x" }] })).toBeNull();
  });
});
