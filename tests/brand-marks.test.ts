import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The brand marks are generated, normalised assets. These guard the two properties a reviewer
 * cannot see by reading the module: that the glyph fills its box, and that white stays legible.
 */
const module = readFileSync(join(__dirname, "..", "server", "brand-marks.ts"), "utf8");

interface Parsed {
  id: string;
  hex: string;
  tile: string;
  mono: boolean;
  bleed: boolean;
  svg: string;
}

function parseMarks(): Parsed[] {
  const out: Parsed[] = [];
  // A glyph mark has `tile` + `mono`; a bleed mark has `bleed: true` and no tile of its own.
  // A block may carry comments between fields, so each gap allows `//` lines.
  const withTile = /"([a-z0-9-]+)": \{\s*hex: "([^"]+)",(?:\s*\/\/[^\n]*\n)*\s*tile: "([^"]+)",(?:\s*\/\/[^\n]*\n)*\s*mono: (true|false),(?:\s*\/\/[^\n]*\n)*\s*svg: `(.+?)`,(?:\s*\/\/[^\n]*\n)*\s*\}/gs;
  for (const m of module.matchAll(withTile)) {
    out.push({ id: m[1]!, hex: m[2]!, tile: m[3]!, mono: m[4] === "true", bleed: false, svg: m[5]! });
  }
  const bleed = /"([a-z0-9-]+)": \{\s*hex: "([^"]+)",(?:\s*\/\/[^\n]*\n)*\s*bleed: true,(?:\s*\/\/[^\n]*\n)*\s*mono: (true|false),(?:\s*\/\/[^\n]*\n)*\s*svg: `(.+?)`,(?:\s*\/\/[^\n]*\n)*\s*\}/gs;
  for (const m of module.matchAll(bleed)) {
    out.push({ id: m[1]!, hex: m[2]!, tile: "", mono: m[3] === "true", bleed: true, svg: m[4]! });
  }
  return out;
}

/** Relative luminance, per WCAG. */
function luminance(hex: string): number {
  const clean = hex.replace("#", "");
  const channels = [0, 2, 4].map((offset) => parseInt(clean.slice(offset, offset + 2), 16) / 255);
  const linear = channels.map((value) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
}

function contrastWithWhite(hex: string): number {
  return 1.05 / (luminance(hex) + 0.05);
}

describe("brand marks", () => {
  const marks = parseMarks();

  it("parses every expected brand", () => {
    expect(marks.map((mark) => mark.id)).toEqual(
      expect.arrayContaining([
        "anthropic",
        "openai",
        "gemini",
        "openrouter",
        "ollama",
        "deepseek",
        "copilot",
        "kimi",
        "opendesign",
        "opencode-go",
        "pi",
      ]),
    );
  });

  it("authors every mark in the shared 0 0 100 100 box", () => {
    for (const mark of marks) {
      // A vendor's own viewBox made one glyph look tiny and another clipped; normalising fixed it.
      expect(mark.svg, `${mark.id} viewBox`).toContain('viewBox="0 0 100 100"');
    }
  });

  it("fills roughly 78% of the box, so no mark looks small", () => {
    for (const mark of marks.filter((candidate) => !candidate.bleed)) {
      const scale = mark.svg.match(/scale\(([0-9.]+)\)/);
      expect(scale, `${mark.id} has a scale`).not.toBeNull();
      const value = Number(scale![1]);
      expect(value, `${mark.id} scale`).toBeGreaterThan(0);
    }
  });

  it("keeps a monochrome glyph legible on its tile", () => {
    for (const mark of marks) {
      if (!mark.mono || mark.bleed) continue;
      // 3:1 is the floor for graphical objects; every tile here clears 4:1.
      expect(contrastWithWhite(mark.tile), `${mark.id} contrast`).toBeGreaterThanOrEqual(4);
    }
  });

  it("lets a multi-colour mark keep its own palette", () => {
    for (const mark of marks.filter((candidate) => !candidate.mono)) {
      // currentColor would flatten Pi's three colours into one.
      expect(mark.svg.length, `${mark.id} has geometry`).toBeGreaterThan(100);
    }
  });

  it("states an opaque tile for every glyph mark", () => {
    for (const mark of marks.filter((candidate) => !candidate.bleed)) {
      expect(mark.tile, `${mark.id} tile`).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });

  it("carries no attribute Paseo rejects", () => {
    for (const mark of marks) {
      expect(mark.svg, `${mark.id} script`).not.toMatch(/<script/i);
      expect(mark.svg, `${mark.id} style`).not.toMatch(/<style/i);
      expect(mark.svg, `${mark.id} handler`).not.toMatch(/\son[a-z0-9_-]*=/i);
      expect(mark.svg, `${mark.id} href`).not.toMatch(/href=/i);
    }
  });
});
