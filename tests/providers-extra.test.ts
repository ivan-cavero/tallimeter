import { describe, expect, it } from "vitest";
import { parseCopilotUser } from "../server/quota/copilot";
import { parseDeepSeekBalance } from "../server/quota/deepseek";
import { parseKimiUsages, percentFromCounts } from "../server/quota/kimi";
import * as fixtures from "./fixtures";

describe("deepseek balance", () => {
  it("reads the documented decimal-string balance", () => {
    const quota = parseDeepSeekBalance(fixtures.deepSeekUsd);
    expect(quota?.balanceUsd).toBeCloseTo(110);
    expect(quota?.balanceUnit).toBe("usd");
    expect(quota?.windows).toHaveLength(0);
  });

  it("prefers USD when the account reports both currencies", () => {
    const quota = parseDeepSeekBalance({
      is_available: true,
      balance_infos: [
        { currency: "CNY", total_balance: "800.00", granted_balance: "0", topped_up_balance: "800" },
        { currency: "USD", total_balance: "110.00", granted_balance: "10", topped_up_balance: "100" },
      ],
    });
    expect(quota?.balanceUsd).toBeCloseTo(110);
    expect(quota?.note).toContain("USD");
  });

  it("says the key is unusable when the vendor reports no balance available", () => {
    const quota = parseDeepSeekBalance(fixtures.deepSeekEmpty);
    expect(quota?.note).toContain("no balance");
  });

  it("returns null when no currency row is readable", () => {
    expect(parseDeepSeekBalance({ balance_infos: [] })).toBeNull();
    expect(parseDeepSeekBalance({ balance_infos: [{ currency: "USD", total_balance: "n/a" }] })).toBeNull();
  });

  it("never reports a window, because the vendor publishes no cap", () => {
    expect(parseDeepSeekBalance(fixtures.deepSeekUsd)?.windows).toHaveLength(0);
  });
});

describe("kimi coding plan", () => {
  it("reads count-based windows with a real duration", () => {
    const quota = parseKimiUsages(fixtures.kimiCounting);
    const fiveHour = quota?.windows.find((window) => window.id === "five_hour");
    expect(fiveHour?.usedPct).toBeCloseTo(15);
    expect(fiveHour?.resetsAt).toContain("2026-11-26");
  });

  it("treats a positive limit with no counters as zero usage", () => {
    const parsed = percentFromCounts({ limit: "100", resetTime: "2026-11-26T00:00:00Z" });
    expect(parsed?.usedPct).toBe(0);
  });

  it("derives used from remaining when only remaining is sent", () => {
    expect(percentFromCounts({ limit: "100", remaining: "95" })?.usedPct).toBeCloseTo(5);
  });

  it("multiplies a ratio pool into percent", () => {
    const quota = parseKimiUsages(fixtures.kimiRatios);
    const monthly = quota?.windows.find((window) => window.id === "monthly");
    expect(monthly?.usedPct).toBeCloseTo(0.42);
  });

  it("ignores the Code slice, which is inside the monthly pool", () => {
    const quota = parseKimiUsages(fixtures.kimiRatios);
    expect(quota?.windows.some((window) => window.id.includes("code"))).toBe(false);
  });

  it("rejects a ratio outside 0..1 as drift, not as a quota", () => {
    const quota = parseKimiUsages({ usages: { limit_month_total: { used_ratio: 1.5 } } });
    expect(quota).toBeNull();
  });

  it("returns null for a body with no readable window", () => {
    expect(parseKimiUsages({})).toBeNull();
    expect(parseKimiUsages({ limits: [{ window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" } }] })).toBeNull();
  });
});

describe("copilot premium requests", () => {
  it("uses the vendor's own percent_remaining", () => {
    const quota = parseCopilotUser(fixtures.copilotPremium);
    expect(quota?.windows[0]?.usedPct).toBeCloseTo(12);
    expect(quota?.windows[0]?.id).toBe("premium");
  });

  it("derives the percentage from entitlement and remaining when percent is absent", () => {
    const quota = parseCopilotUser({
      quota_snapshots: { premium_interactions: { entitlement: 1000, remaining: 250 } },
    });
    expect(quota?.windows[0]?.usedPct).toBeCloseTo(75);
  });

  it("reports the plan name from the SKU", () => {
    expect(parseCopilotUser(fixtures.copilotPremium)?.planLabel).toContain("pro");
  });

  it("returns null when no premium allowance is reported", () => {
    expect(parseCopilotUser({ copilot_plan: "free", monthly_quotas: { chat: 100 } })).toBeNull();
  });
});
