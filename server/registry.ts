/**
 * Provider registry: the single place that says what each provider is called, how its brand
 * looks, where its docs live, and which credential kinds can read its allowance.
 *
 * Colours are the vendors' own primary tones, darkened enough to stay legible on Paseo's light
 * and dark surfaces. `icon` is a Lucide name, because Paseo renders Lucide icons and rejects
 * unknown names; a brand wordmark SVG would drift from the vendor's own artwork.
 */

import { brandColor, markFor } from "./brand-marks";

export type CredentialKind = "apiKey" | "cookie" | "oauth";

export interface ProviderBrand {
  /** Stable id used in settings, cards and the credential store. */
  id: string;
  label: string;
  /** Lucide icon name, validated by Paseo. Used only when no mark is available. */
  icon: string;
  /** Inline SVG mark. Attached by `brandFor` from the mark registry, not written per entry. */
  mark?: string;
  /** Colour behind the glyph. Absent on a bleed mark. */
  tile?: string;
  /** True when the mark carries its own tile. */
  bleed?: boolean;
  /** True when the glyph must be painted white on the tile. */
  mono?: boolean;
  /** The vendor id an alias resolved to, when this id is an alias. */
  brandId?: string;
  /** Brand colour for the accent rail and meter fill. */
  color: string;
  /** How allowance is read, in one line for the card footer. */
  quotaHint: string;
  docsUrl: string;
  /** Credential kinds that can read allowance. A model key alone often cannot. */
  credentials: CredentialKind[];
  /**
   * "subscription" means a plan with windows and resets; "balance" means a prepaid wallet;
   * "none" means the vendor exposes no readable allowance and only local token cost applies.
   */
  quota: "subscription" | "balance" | "none";
}

export const BRANDS: Record<string, ProviderBrand> = {
  anthropic: {
    id: "anthropic",
    label: "Claude",
    icon: "Sparkles",
    color: "#D97757",
    quotaHint: "5-hour and weekly windows from the Claude Code login",
    docsUrl: "https://code.claude.com/docs/en/usage",
    credentials: ["oauth"],
    quota: "subscription",
  },
  openai: {
    id: "openai",
    label: "OpenAI / Codex",
    icon: "Bot",
    color: "#0B0B0B",
    quotaHint: "5-hour and weekly windows from the Codex login",
    docsUrl: "https://developers.openai.com/codex",
    credentials: ["oauth"],
    quota: "subscription",
  },
  opendesign: {
    id: "opendesign",
    label: "OpenDesign",
    icon: "Palette",
    color: "#26251E",
    quotaHint: "5-hour and weekly plan windows plus wallet, from a browser session or control key",
    docsUrl: "https://open-design.ai/model-credits",
    credentials: ["cookie", "apiKey"],
    quota: "subscription",
  },
  "opencode-go": {
    id: "opencode-go",
    label: "OpenCode Go",
    icon: "Terminal",
    color: "#131010",
    quotaHint: "rolling, weekly and monthly windows from the Go plan API",
    docsUrl: "https://opencode.ai/docs/console/go",
    credentials: ["apiKey"],
    quota: "subscription",
  },
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    icon: "Route",
    color: "#94A3B8",
    quotaHint: "key budget, daily, weekly and monthly spend",
    docsUrl: "https://openrouter.ai/docs/api/api-reference/limits",
    credentials: ["apiKey"],
    quota: "balance",
  },
  ollama: {
    id: "ollama",
    label: "Ollama Cloud",
    icon: "Boxes",
    color: "#0B0B0B",
    quotaHint: "monthly included allowance and purchased credits",
    docsUrl: "https://docs.ollama.com/api/balance",
    credentials: ["apiKey"],
    quota: "balance",
  },
  deepseek: {
    id: "deepseek",
    label: "DeepSeek",
    icon: "Waves",
    color: "#5786FE",
    quotaHint: "prepaid balance from /user/balance; the vendor publishes no cap",
    docsUrl: "https://api-docs.deepseek.com",
    credentials: ["apiKey"],
    quota: "balance",
  },
  kimi: {
    id: "kimi",
    label: "Kimi",
    icon: "Moon",
    color: "#0B0B0B",
    quotaHint: "5-hour and monthly coding-plan windows from /coding/v1/usages",
    docsUrl: "https://platform.moonshot.ai/docs",
    credentials: ["apiKey"],
    quota: "subscription",
  },
  copilot: {
    id: "copilot",
    label: "GitHub Copilot",
    icon: "Github",
    color: "#0B0B0B",
    quotaHint: "monthly premium-request allowance from Copilot's internal API",
    docsUrl: "https://docs.github.com/en/copilot",
    credentials: ["oauth"],
    quota: "subscription",
  },
  gemini: {
    id: "gemini",
    label: "Gemini",
    icon: "Gem",
    color: "#8E75B2",
    quotaHint: "per-model quota buckets from the Gemini Code Assist login",
    docsUrl: "https://developers.google.com/gemini-code-assist/docs/overview",
    credentials: ["oauth"],
    quota: "subscription",
  },
  pi: {
    id: "pi",
    label: "Pi",
    icon: "Pi",
    color: "#F09082",
    quotaHint: "whichever vendor login the Pi session uses; read from that vendor",
    docsUrl: "https://pi.dev/docs/latest/models",
    credentials: ["apiKey"],
    quota: "none",
  },
};

/** Unknown providers still render with their own id and a neutral accent. */
export const FALLBACK_BRAND: Omit<ProviderBrand, "id" | "label" | "mark" | "color"> & { color?: string } = {
  icon: "Cpu",
  color: "#94A3B8",
  quotaHint: "no readable allowance; local cost only",
  docsUrl: "https://paseo.sh/docs",
  credentials: ["apiKey"],
  quota: "none",
};

/** Provider ids that mean a different brand: a turn names the tool, not always the vendor. */
const BRAND_ALIAS: Record<string, string> = {
  claude: "anthropic",
  "claude-code": "anthropic",
  codex: "openai",
  chatgpt: "openai",
  opencode: "opencode-go",
  moonshot: "kimi",
  "kimi-coding": "kimi",
  "github-copilot": "copilot",
  "google-gemini": "gemini",
  "open-design": "opendesign",
};

export function brandFor(id: string, label?: string): ProviderBrand {
  const brandId = BRAND_ALIAS[id] ?? id;
  const known = BRANDS[brandId];
  const mark = markFor(brandId);
  if (known) {
    // The mark registry carries the vendor's real hex, so colour comes from there rather than
    // from a table that drifted. An alias keeps its own id and tags the brand it resolved to.
    return {
      ...known,
      id,
      label: label ?? known.label,
      color: brandColor(brandId),
      tile: mark.tile,
      bleed: mark.bleed ?? false,
      mono: mark.mono,
      mark: mark.svg,
      brandId,
    } as ProviderBrand & { brandId: string };
  }
  return {
    ...FALLBACK_BRAND,
    id,
    label: label ?? id,
    color: brandColor(id),
    tile: mark.tile,
    bleed: mark.bleed ?? false,
    mono: mark.mono,
    mark: mark.svg,
  };
}

/** Maps a turn's provider string to the brand that owns it. */
export function brandForTurnProvider(provider: string): ProviderBrand {
  const branded = brandFor(provider);
  // OpenCode without a plan is the free harness, not the paid Go plan, so relabel it.
  if (provider === "opencode") return { ...branded, label: "OpenCode" };
  return branded;
}
