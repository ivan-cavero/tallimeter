import { afterEach, describe, expect, it, vi } from "vitest";
import { readGoQuota } from "../server/quota/opencode-go";
import { readOpenRouterQuota } from "../server/quota/openrouter";
import { readOllamaQuota } from "../server/quota/ollama";

/**
 * These exercise the network path with a stubbed fetch: status handling, the fallback request,
 * and the decision to return null instead of an invented zero. No real request is made.
 */
function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  vi.stubGlobal("fetch", vi.fn(handler));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("network failures are reported as absence, not as a zero", () => {
  it("openrouter: a 401 returns null", async () => {
    stubFetch(() => json({ error: "unauthorized" }, 401));
    await expect(readOpenRouterQuota("sk-or-test", { forceRefresh: true })).resolves.toBeNull();
  });

  it("openrouter: a thrown request returns null", async () => {
    stubFetch(() => {
      throw new Error("network down");
    });
    await expect(readOpenRouterQuota("sk-or-test", { forceRefresh: true })).resolves.toBeNull();
  });

  it("ollama: a 429 returns null rather than a stale balance", async () => {
    stubFetch(() => json({ error: "rate limited" }, 429));
    await expect(readOllamaQuota("ollama-test", { forceRefresh: true })).resolves.toBeNull();
  });

  it("opencode go: a 500 returns null", async () => {
    stubFetch(() => json({ error: "boom" }, 500));
    await expect(readGoQuota("/tmp/no-such-home", { forceRefresh: true })).resolves.toBeNull();
  });
});

describe("successful reads", () => {
  it("openrouter returns the parsed windows and balance", async () => {
    stubFetch(() =>
      json({
        data: {
          limit: 100,
          limit_remaining: 74.5,
          is_free_tier: false,
          effective_budget: {
            limit_usd: 100,
            spend_usd: 25.5,
            reset_interval: "monthly",
            resets_at: "2026-12-01T00:00:00.000Z",
          },
        },
      }),
    );
    const quota = await readOpenRouterQuota("sk-or-test", { forceRefresh: true });
    expect(quota?.windows[0]?.usedPct).toBeCloseTo(25.5);
    expect(quota?.balanceUsd).toBeCloseTo(74.5);
    expect(quota?.source).toBe("openrouter");
  });

  it("ollama returns the monthly pool and the purchased balance", async () => {
    stubFetch(() =>
      json({
        included: { balance_usd: 72.5, allowance_usd: 100, period: { until: "2026-12-15T09:30:00Z" } },
        purchased: { balance_usd: 25 },
      }),
    );
    const quota = await readOllamaQuota("ollama-test", { forceRefresh: true });
    expect(quota?.windows[0]?.usedPct).toBeCloseTo(27.5);
    expect(quota?.balanceUsd).toBe(25);
  });

  it("a 401 is not cached as a permanent absence: a later success is seen", async () => {
    stubFetch(() => json({ error: "unauthorized" }, 401));
    await expect(readOpenRouterQuota("sk-or-flip", { forceRefresh: true })).resolves.toBeNull();
    stubFetch(() => json({ data: { limit: 10, limit_remaining: 5, effective_budget: { limit_usd: 10, spend_usd: 5 } } }));
    const quota = await readOpenRouterQuota("sk-or-flip", { forceRefresh: true });
    expect(quota?.balanceUsd).toBe(5);
  });
});

describe("request hygiene", () => {
  it("openrouter sends the key as a bearer token and never in the URL", async () => {
    const seen: string[] = [];
    stubFetch((url, init) => {
      seen.push(url);
      expect((init?.headers as Record<string, string>)["Authorization"]).toBe("Bearer sk-or-test");
      return json({ data: { limit: 1, limit_remaining: 1, effective_budget: null } });
    });
    await readOpenRouterQuota("sk-or-test", { forceRefresh: true });
    expect(seen.every((url) => !url.includes("sk-or-test"))).toBe(true);
  });

  it("ollama sends the key as a bearer token and never in the URL", async () => {
    stubFetch((url, init) => {
      expect((init?.headers as Record<string, string>)["Authorization"]).toBe("Bearer ollama-test");
      expect(url).not.toContain("ollama-test");
      return json({ included: { allowance_usd: 10, balance_usd: 10 }, purchased: {} });
    });
    await readOllamaQuota("ollama-test", { forceRefresh: true });
  });
});
