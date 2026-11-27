import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface ProviderEntry {
  extends?: string;
  label?: string;
  description?: string;
  enabled?: boolean;
  order?: number;
  env?: Record<string, string>;
  models?: Array<Record<string, unknown>>;
  disallowedTools?: string[];
  [key: string]: unknown;
}

export interface DaemonConfig {
  version?: number;
  agents?: {
    providers?: Record<string, ProviderEntry>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

const CONFIG = join(homedir(), ".paseo", "config.json");

/** Nothing else in this plugin writes Paseo's config, so every read is a fresh one. */
export function readConfig(): DaemonConfig {
  try {
    return JSON.parse(readFileSync(CONFIG, "utf8")) as DaemonConfig;
  } catch {
    return { version: 1, agents: { providers: {} } };
  }
}

/**
 * Writes through a temporary file so a crash mid-write cannot leave the daemon without a config.
 * Paseo reloads providers from this file, so the edit takes effect on the next `paseo reload`.
 */
export function writeConfig(config: DaemonConfig): void {
  const dir = join(homedir(), ".paseo");
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `config.json.tmp-${process.pid}`);
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, CONFIG);
}

export function providers(config: DaemonConfig): Record<string, ProviderEntry> {
  config.agents ??= {};
  config.agents.providers ??= {};
  return config.agents.providers;
}

/** Free ids like `claude-3`, skipping any that already exist. */
export function nextId(prefix: string, existing: Record<string, ProviderEntry>): string {
  for (let index = 1; index < 100; index += 1) {
    const id = `${prefix}-${index}`;
    if (!existing[id]) return id;
  }
  throw new Error(`No free ${prefix} id`);
}
