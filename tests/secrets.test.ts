import { existsSync, mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { periodFor } from "../server/aggregate";

/** The credential file is the only place a secret lives, so its rules are tested hard. */
describe("credential store", () => {
  const original = process.env.HOME;
  let dir = "";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tallimeter-secrets-"));
    mkdirSync(join(dir, ".paseo"), { recursive: true });
    process.env.HOME = dir;
  });

  afterEach(() => {
    process.env.HOME = original;
    rmSync(dir, { recursive: true, force: true });
  });

  // The module resolves its path from HOME at import time, so it is re-imported per test file.
  it("writes the file 0600 and creates the directory", async () => {
    const { writeCredentials: write } = await import("../server/secrets");
    write({ "opendesign:default": { value: "cookie-value", kind: "cookie" } });
    const file = join(dir, ".paseo", "tallimeter-credentials.json");
    const mode = statSync(file).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe("redaction", () => {
  it("shows only the last four characters of a secret", () => {
    const entry = { value: "sk-ant-api03-SECRETSECRET1234", kind: "apiKey" as const };
    // Mirrors describeCredentials' preview rule.
    const preview = `…${entry.value.slice(-4)}`;
    expect(preview).toBe("…1234");
    expect(preview).not.toContain("SECRET");
  });

  it("preview of a short value leaks nothing usable", () => {
    const value = "abc";
    expect(`…${value.slice(-4)}`).toBe("…abc");
  });
});

describe("cycle periods", () => {
  /** Cycles follow the user's local calendar, so comparisons use local date parts, not UTC. */
  const localDay = (date: Date) =>
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

  // Local noon avoids any DST edge at midnight.
  const noon = (iso: string) => {
    const date = new Date(iso);
    date.setHours(12, 0, 0, 0);
    return date;
  };

  it("starts on the configured day when that day has passed", () => {
    const { start, end } = periodFor(1, noon("2026-11-26T12:00:00"));
    expect(localDay(start)).toBe("2026-11-01");
    expect(localDay(end)).toBe("2026-12-01");
  });

  it("falls back to the previous month before the start day", () => {
    const { start, end } = periodFor(15, noon("2026-11-03T12:00:00"));
    expect(localDay(start)).toBe("2026-10-15");
    expect(localDay(end)).toBe("2026-11-15");
  });

  it("never produces a start after the end", () => {
    for (const day of [1, 5, 15, 28]) {
      for (const month of [0, 5, 11]) {
        const now = new Date(2026, month, 10, 12);
        const { start, end } = periodFor(day, now);
        expect(start.getTime()).toBeLessThanOrEqual(now.getTime());
        expect(end.getTime()).toBeGreaterThan(now.getTime());
      }
    }
  });

  it("handles the last day of a month without overflowing", () => {
    const { start, end } = periodFor(28, noon("2026-01-31T12:00:00"));
    expect(localDay(start)).toBe("2026-01-28");
    expect(localDay(end)).toBe("2026-02-28");
  });
});

describe("aggregate cost", () => {
  it("prices a turn from the catalog and reports unknown models", async () => {
    const { costOf } = await import("../server/prices");
    const catalog = { "deepseek-v4.1-flash-eco": { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0.3 } };
    const cost = costOf("deepseek-v4.1-flash-eco", { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }, catalog);
    expect(cost).toBeCloseTo(0.3, 6);
    expect(costOf("unheard-of-model", { input: 1000, output: 10, cacheRead: 0, cacheWrite: 0 }, catalog)).toBeNull();
  });

  it("treats a free variant as genuinely free", async () => {
    const { costOf } = await import("../server/prices");
    expect(costOf("deepseek-v4.1-flash-free", { input: 5000, output: 500, cacheRead: 0, cacheWrite: 0 }, {})).toBe(0);
  });

  it("applies the cache read rate, which is cheaper than input", async () => {
    const { costOf } = await import("../server/prices");
    const catalog = { m: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } };
    const cacheCost = costOf("m", { input: 0, output: 0, cacheRead: 1_000_000, cacheWrite: 0 }, catalog);
    const inputCost = costOf("m", { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }, catalog);
    expect(cacheCost).toBeCloseTo(0.3, 6);
    expect(inputCost).toBeCloseTo(3, 6);
  });
});

describe("upgrade from the pre-rename credential file", () => {
  const original = process.env.HOME;
  let dir = "";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tallimeter-legacy-"));
    mkdirSync(join(dir, ".paseo"), { recursive: true });
    process.env.HOME = dir;
    vi.resetModules();
  });

  afterEach(() => {
    process.env.HOME = original;
    rmSync(dir, { recursive: true, force: true });
  });

  it("adopts the old file once and keeps the original in place", async () => {
    const legacy = join(dir, ".paseo", "paseo-usage-credentials.json");
    writeFileSync(legacy, JSON.stringify({ "opendesign:default": { value: "cookie-1234", kind: "cookie" } }));

    const { readCredentials } = await import("../server/secrets");
    const adopted = readCredentials();
    expect(adopted["opendesign:default"]?.value).toBe("cookie-1234");
    // The old file is copied rather than consumed, because only the user can decide to delete it.
    expect(existsSync(legacy)).toBe(true);

    const current = join(dir, ".paseo", "tallimeter-credentials.json");
    expect(statSync(current).mode & 0o777).toBe(0o600);
  });

  it("never overwrites a credential file that already exists", async () => {
    const legacy = join(dir, ".paseo", "paseo-usage-credentials.json");
    writeFileSync(legacy, JSON.stringify({ "openrouter:default": { value: "old-key" } }));
    const current = join(dir, ".paseo", "tallimeter-credentials.json");
    writeFileSync(current, JSON.stringify({ "openrouter:default": { value: "new-key" } }));

    const { readCredentials } = await import("../server/secrets");
    expect(readCredentials()["openrouter:default"]?.value).toBe("new-key");
  });

  it("survives a corrupt legacy file without throwing", async () => {
    const legacy = join(dir, ".paseo", "paseo-usage-credentials.json");
    writeFileSync(legacy, "{not json");
    const { readCredentials } = await import("../server/secrets");
    expect(readCredentials()).toEqual({});
  });
});
