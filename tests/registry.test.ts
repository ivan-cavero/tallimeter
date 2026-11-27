import { describe, expect, it } from "vitest";
import { BRANDS, brandFor, brandForTurnProvider } from "../server/registry";

/**
 * The registry is what the UI paints with, so its shape matters: Paseo renders Lucide icons and
 * rejects unknown names, and every brand needs a parseable colour.
 */
describe("brand registry", () => {
  const entries = Object.entries(BRANDS);

  it("covers the providers this plugin implements", () => {
    const ids = entries.map(([id]) => id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "anthropic",
        "openai",
        "gemini",
        "opendesign",
        "opencode-go",
        "openrouter",
        "ollama",
        "deepseek",
        "kimi",
        "copilot",
        "pi",
      ]),
    );
  });

  it("gives every brand a hex colour", () => {
    for (const [id, brand] of entries) {
      expect(brand.color, `${id} colour`).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });

  it("gives every brand a Lucide icon name", () => {
    // Lucide exports capitalised identifiers; snake_case or spaces would never render.
    for (const [id, brand] of entries) {
      expect(brand.icon, `${id} icon`).toMatch(/^[A-Z][A-Za-z0-9]*$/);
    }
  });

  it("gives every brand a docs link over https", () => {
    for (const [id, brand] of entries) {
      expect(brand.docsUrl, `${id} docs`).toMatch(/^https:\/\//);
    }
  });

  it("declares which credential kinds can read its allowance", () => {
    for (const [id, brand] of entries) {
      expect(brand.credentials.length, `${id} credentials`).toBeGreaterThan(0);
      for (const kind of brand.credentials) expect(["apiKey", "cookie", "oauth"]).toContain(kind);
    }
  });

  it("states a quota kind for every brand", () => {
    for (const [, brand] of entries) {
      expect(["subscription", "balance", "none"]).toContain(brand.quota);
    }
  });

  it("uses a readable quota hint, not an empty placeholder", () => {
    for (const [id, brand] of entries) {
      expect(brand.quotaHint.length, `${id} hint`).toBeGreaterThan(20);
    }
  });
});

describe("brand lookup", () => {
  it("maps a turn provider to its brand", () => {
    expect(brandForTurnProvider("anthropic").id).toBe("anthropic");
    expect(brandForTurnProvider("opendesign").id).toBe("opendesign");
    expect(brandForTurnProvider("opencode").label).toBe("OpenCode");
    expect(brandForTurnProvider("codex").label).toBe("OpenAI / Codex");
    expect((brandForTurnProvider("codex") as { brandId?: string }).brandId).toBe("openai");
  });

  it("falls back for an unknown provider without throwing", () => {
    const brand = brandForTurnProvider("some-new-vendor");
    expect(brand.label).toBe("some-new-vendor");
    expect(brand.icon).toBe("Cpu");
  });

  it("keeps a custom label when the brand is unknown", () => {
    expect(brandFor("mystery", "My Relay").label).toBe("My Relay");
  });
});

describe("brand marks", () => {
  it("gives every brand a Paseo-valid inline SVG", async () => {
    const { BRAND_MARKS, FALLBACK_MARK } = await import("../server/brand-marks");
    const { findSvgIconProblem } = await import("@getpaseo/plugin");
    for (const [id, mark] of Object.entries(BRAND_MARKS)) {
      expect(findSvgIconProblem(mark.svg), `${id} mark`).toBeNull();
    }
    expect(findSvgIconProblem(FALLBACK_MARK.svg)).toBeNull();
  });

  it("paints a mono mark with currentColor and keeps a multi-colour mark native", async () => {
    const { BRAND_MARKS } = await import("../server/brand-marks");
    // A mono glyph must not carry its own fill, or the tile colour cannot reach it.
    for (const [id, mark] of Object.entries(BRAND_MARKS)) {
      if (!mark.mono) continue;
      expect(mark.svg, `${id} mono`).toContain("currentColor");
      expect(mark.svg, `${id} style`).not.toContain("<style");
    }
    // Pi and OpenCode keep their own colours and must not be recoloured.
    expect(BRAND_MARKS.pi?.mono).toBe(false);
    expect(BRAND_MARKS["opencode-go"]?.mono).toBe(false);
  });

  it("states the vendor's real hex, not an invented accent", async () => {
    const { BRAND_MARKS } = await import("../server/brand-marks");
    // These come from Simple Icons' manifest and the vendors' own assets.
    expect(BRAND_MARKS.anthropic?.hex).toBe("#D97757");
    expect(BRAND_MARKS.gemini?.hex).toBe("#8E75B2");
    expect(BRAND_MARKS.deepseek?.hex).toBe("#5786FE");
    expect(BRAND_MARKS.openrouter?.hex).toBe("#94A3B8");
  });

  it("gives every glyph mark a tile, so a dark glyph is never invisible", async () => {
    const { BRAND_MARKS, FALLBACK_MARK } = await import("../server/brand-marks");
    for (const [id, mark] of Object.entries(BRAND_MARKS)) {
      // A bleed mark carries its own tile inside the SVG, so it has no tile field.
      if (mark.bleed) continue;
      expect(mark.tile, `${id} tile`).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
    expect(FALLBACK_MARK.tile).toMatch(/^#[0-9A-Fa-f]{6}$/);
  });

  it("marks the vendors that draw their own tile as bleed", async () => {
    const { BRAND_MARKS } = await import("../server/brand-marks");
    // Both of these are logo tiles, not glyphs: OpenCode is a dark square with a frame cut out,
    // OpenDesign a dark squircle with a cream ring and arrow cut in. A tile drawn behind either
    // one shows as a double frame or a pale ring at the corners.
    expect(BRAND_MARKS["opencode-go"]?.bleed).toBe(true);
    expect(BRAND_MARKS.opendesign?.bleed).toBe(true);
    // A glyph mark must not claim bleed, or the card would draw no tile behind it.
    expect(BRAND_MARKS.anthropic?.bleed ?? false).toBe(false);
  });

  it("resolves a mark for every registry brand through brandFor", async () => {
    const { BRANDS, brandFor } = await import("../server/registry");
    for (const id of Object.keys(BRANDS)) {
      expect(brandFor(id).mark, `${id} resolved mark`).toBeTruthy();
    }
  });

  it("keeps every mark small enough to travel per account card", async () => {
    const { BRAND_MARKS } = await import("../server/brand-marks");
    // 8 KiB is far under Paseo's 64 KiB icon cap, and ten accounts still fit in one payload.
    for (const [id, mark] of Object.entries(BRAND_MARKS)) {
      expect(mark.svg.length, `${id} size`).toBeLessThan(8 * 1024);
    }
  });
});

describe("documentation links", () => {
  it("points every brand at a specific page, not a site root", () => {
    // A docs link is the remedy the empty card offers, so a dead one costs a user the fix.
    // The reachability of each URL is checked by hand; the shape is checked here.
    for (const [id, brand] of Object.entries(BRANDS)) {
      const path = new URL(brand.docsUrl).pathname.replace(/\/+$/, "");
      expect(path.length, `${id} docs path`).toBeGreaterThan(1);
    }
  });
});
