import { describe, expect, it } from "vitest";
import type { StoreRef } from "../server/stores";
import { quotaRequestForStore, readQuota } from "../server/quota/index";

/**
 * Routing a turn to the reader that owns its allowance. A turn names the harness or the vendor, not
 * always the same string, so the mapping is where a silent mistake would be easiest: reading the
 * wrong vendor's quota is a wrong number that still renders.
 */
const ref = (overrides: Partial<StoreRef> = {}): StoreRef => ({
  id: "claude-1",
  label: "Claude 1",
  provider: "claude-1",
  kind: "claude",
  store: "/tmp/claude-1",
  reader: "claude-jsonl",
  quotaKind: "anthropic",
  ...overrides,
});

describe("quota routing by turn provider", () => {
  it("routes Claude turns to the Anthropic reader and passes the store dir", () => {
    const request = quotaRequestForStore(ref(), "anthropic", false);
    expect(request.brand).toBe("anthropic");
    expect(request.store).toBe("/tmp/claude-1");
    // Every read carries the refresh flag, which is how the button bypasses the cache.
    expect(request.forceRefresh).toBe(false);
  });

  it("routes OpenDesign turns to the OpenDesign reader without a store dir", () => {
    const request = quotaRequestForStore(ref({ kind: "opendesign" }), "opendesign", true);
    expect(request.brand).toBe("opendesign");
    expect(request.store).toBeUndefined();
    expect(request.forceRefresh).toBe(true);
  });

  it("routes both OpenCode spellings to the Go reader, with the store's data home", () => {
    for (const provider of ["opencode", "opencode-go"]) {
      const request = quotaRequestForStore(ref({ quotaKind: "opencode-go", dataHome: "/tmp/data" }), provider, false);
      expect(request.brand).toBe("opencode-go");
      expect(request.dataHome).toBe("/tmp/data");
    }
  });

  it("routes gateway vendors to their own readers", () => {
    const expectations: Array<[string, string]> = [
      ["openrouter", "openrouter"],
      ["ollama", "ollama"],
      ["deepseek", "deepseek"],
      ["kimi", "kimi"],
      ["gemini", "gemini"],
      ["copilot", "copilot"],
      ["openai", "openai"],
    ];
    for (const [provider, brand] of expectations) {
      expect(quotaRequestForStore(ref(), provider, false).brand).toBe(brand);
    }
  });

  it("reports no allowance for a provider it does not know", () => {
    expect(quotaRequestForStore(ref(), "some-new-gateway", false).brand).toBe("none");
  });
});

describe("quota reads without a credential", () => {
  it("returns null rather than a zero for a keyed vendor with no stored key", async () => {
    // A missing credential is an absence of knowledge, not a balance of zero.
    for (const brand of ["openrouter", "ollama", "deepseek", "kimi"]) {
      const quota = await readQuota({
        brand,
        credentialId: `${brand}:definitely-not-stored`,
        forceRefresh: true,
      });
      expect(quota).toBeNull();
    }
  });

  it("returns null for an unknown brand instead of throwing", async () => {
    await expect(readQuota({ brand: "not-a-vendor", credentialId: "x", forceRefresh: true })).resolves.toBeNull();
  });
});
