import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";
import {
  nextId,
  providers,
  readConfig,
  writeConfig,
  type ProviderEntry,
} from "./config";
import type { AccountEntry } from "../shared/contracts";

const run = promisify(execFile);
const HOME = homedir();

const MODELS = [
  { id: "deepseek-v4.1-flash-eco", label: "DeepSeek V4.1 Flash Eco", isDefault: true },
  { id: "deepseek-v4.1-flash", label: "DeepSeek V4.1 Flash" },
  { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro" },
  { id: "glm-5.3-flash", label: "GLM 5.3 Flash" },
  { id: "kimi-k2.7-code", label: "Kimi K2.7 Code" },
  { id: "gpt-6-luna", label: "GPT-6 Luna" },
  { id: "mimo-v2.6-pro", label: "MiMo V2.6 Pro" },
  { id: "minimax-m3.1-flash", label: "MiniMax M3.1 Flash" },
];

const ensureDir = (path: string) => {
  mkdirSync(path, { recursive: true, mode: 0o700 });
};

export interface AddInput {
  family: "claude" | "opencode" | "opendesign" | "pi";
  label: string;
  apiKey: string;
  controlKey: string;
  workspaceId: string;
}

/** Returns the entry's provider id and a sentence describing the next manual step, if any. */
export function addAccount(input: AddInput): { id: string; message: string } {
  const config = readConfig();
  const all = providers(config);
  const label = input.label.trim();

  if (input.family === "claude") {
    const id = nextId("claude", all);
    // Folder named after the label suffix only, so an id of "claude-2" does not become ".claude-claude-2".
    const dir = join(HOME, `.claude-${id.replace(/^claude-/, "")}`);
    ensureDir(dir);
    all[id] = {
      extends: "claude",
      label: label || `Claude ${id.split("-")[1]}`,
      description: `Claude account in ${dir}`,
      order: 100,
      enabled: true,
      env: { CLAUDE_CONFIG_DIR: dir },
    } satisfies ProviderEntry;
    writeConfig(config);
    return {
      id,
      message: `Added ${id}. Run CLAUDE_CONFIG_DIR=${dir} claude, then /login inside it to sign this account in.`,
    };
  }

  if (input.family === "pi") {
    const id = nextId("pi", all);
    const dir = join(HOME, `.pi`, `agent-${id.replace(/^pi-/, "")}`);
    ensureDir(dir);
    all[id] = {
      extends: "pi",
      label: label || `Pi ${id.split("-")[1]}`,
      description: `Pi account in ${dir}`,
      order: 130,
      enabled: true,
      env: { PI_CODING_AGENT_DIR: dir },
    } satisfies ProviderEntry;
    writeConfig(config);
    return { id, message: `Added ${id}. Run PI_CODING_AGENT_DIR=${dir} pi and sign in with /login.` };
  }

  if (input.family === "opencode") {
    const id = nextId("opencode", all);
    const configDir = join(HOME, `.config`, `${id}`);
    const dataHome = join(HOME, `.local`, "share", id);
    const stateHome = join(HOME, `.local`, "state", id);
    for (const dir of [configDir, dataHome, stateHome]) ensureDir(dir);
    all[id] = {
      extends: "opencode",
      label: label || `OpenCode ${id.split("-")[1]}`,
      description: `OpenCode Go account with its own config and data directories`,
      order: 120,
      enabled: true,
      env: {
        OPENCODE_CONFIG_DIR: configDir,
        XDG_DATA_HOME: dataHome,
        XDG_STATE_HOME: stateHome,
      },
    } satisfies ProviderEntry;
    writeConfig(config);
    const seeded = input.apiKey.trim();
    return {
      id,
      message: seeded
        ? `Added ${id}. The key still has to be saved where OpenCode reads it: open that provider once and /connect.`
        : `Added ${id}. Open its first agent and sign in with /connect to OpenCode Go.`,
    };
  }

  // Open Design through Claude Code: the gateway speaks the Anthropic protocol, so the provider
  // extends claude and inherits modes, tools, and the transcript layout the Usage screen reads.
  const id = nextId("opendesign", all);
  const dir = join(HOME, `.claude-${id.replace(/^opendesign-/, "od-")}`);
  ensureDir(dir);
  const apiKey = input.apiKey.trim();
  all[id] = {
    extends: "claude",
    label: label || `OpenDesign ${id.split("-")[1]}`,
    description: "OpenDesign AMR gateway through Claude Code",
    order: 210,
    enabled: true,
    env: {
      ANTHROPIC_BASE_URL: "https://amr-link.open-design.ai/v1",
      ANTHROPIC_AUTH_TOKEN: apiKey || "REPLACE_WITH_OPEN_DESIGN_KEY",
      ANTHROPIC_API_KEY: "",
      CLAUDE_CONFIG_DIR: dir,
      ANTHROPIC_DEFAULT_SONNET_MODEL: "deepseek-v4.1-flash",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "deepseek-v4.1-flash-eco",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "deepseek-v4-pro",
      API_TIMEOUT_MS: "3000000",
    },
    disallowedTools: ["WebSearch"],
    models: MODELS,
  } satisfies ProviderEntry;

  writeConfig(config);
  return {
    id,
    message: apiKey
      ? `Added ${id}. Quota reads need a control key: use Get control key by device login, or paste one.`
      : `Added ${id}. Paste a sk-amr model key in its provider settings before using it.`,
  };
}

export function removeAccount(id: string): string {
  const config = readConfig();
  const all = providers(config);
  if (!all[id]) throw new Error(`No provider named ${id}`);
  delete all[id];
  const usage = config.agents?.openDesignQuota as Record<string, unknown> | undefined;
  if (usage) delete usage[id];
  writeConfig(config);
  return `Removed ${id}. Its directory is left on disk, so the login is not lost.`;
}

export function renameAccount(id: string, label: string): string {
  const config = readConfig();
  const all = providers(config);
  const entry = all[id];
  if (!entry) throw new Error(`No provider named ${id}`);
  entry.label = label;
  writeConfig(config);
  return `Renamed ${id} to ${label}.`;
}

/** Describes what exists, without exposing any credential value. */
export function listAccounts(): AccountEntry[] {
  const config = readConfig();
  const all = providers(config);
  const usage = (config.agents?.openDesignQuota ?? {}) as Record<string, { controlKey?: string }>;

  return Object.entries(all)
    .filter(([, entry]) => entry.enabled !== false && entry.extends)
    .map(([id, entry]) => {
      const env = entry.env ?? {};
      return {
        id,
        label: entry.label ?? id,
        extends: String(entry.extends),
        hasKey: Boolean(
          env.ANTHROPIC_AUTH_TOKEN && !env.ANTHROPIC_AUTH_TOKEN.startsWith("REPLACE_WITH"),
        ),
        hasQuotaCredential: Boolean(usage[id]?.controlKey),
        store: env.CLAUDE_CONFIG_DIR ?? env.PI_CODING_AGENT_DIR ?? env.XDG_DATA_HOME ?? null,
        enabled: entry.enabled !== false,
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Asks the daemon to reload providers after a config write, so the app sees the change at once. */
export async function reloadDaemon(): Promise<void> {
  const cli = "paseo";
  try {
    await run(cli, ["reload"], { timeout: 20_000 });
  } catch {
    // A reload failure is reported by the CLI on its own; the config is already saved.
  }
}
