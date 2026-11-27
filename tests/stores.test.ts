import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Discovery reads Paseo's provider config and resolves each provider to the directory its login
 * lives in. The rules matter more than the code: a disabled provider must not get a card, a
 * gateway base URL must not be treated as an Anthropic subscription, and one store must never be
 * read twice.
 *
 * The module resolves the home directory at import time, so every test re-imports it after
 * pointing HOME at a temporary tree.
 */
let home = "";

function writeConfig(providers: Record<string, unknown>): void {
  mkdirSync(join(home, ".paseo"), { recursive: true });
  writeFileSync(join(home, ".paseo", "config.json"), JSON.stringify({ version: 1, agents: { providers } }));
}

function seed(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tallimeter-stores-"));
  process.env.HOME = home;
  vi.resetModules();
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const discover = async () => (await import("../server/stores")).discoverStores();

describe("store discovery", () => {
  it("maps a Claude provider to its own config dir and marks it as an Anthropic login", async () => {
    const dir = join(home, "claude-a");
    seed(dir);
    writeConfig({ "claude-1": { extends: "claude", label: "Claude A", env: { CLAUDE_CONFIG_DIR: dir } } });

    const stores = await discover();
    const entry = stores.find((ref) => ref.id === "claude-1");
    expect(entry?.store).toBe(dir);
    expect(entry?.reader).toBe("claude-jsonl");
    expect(entry?.quotaKind).toBe("opendesign-or-anthropic");
  });

  it("treats a Claude provider with a foreign base URL as a gateway, not a subscription", async () => {
    const dir = join(home, "gateway");
    seed(dir);
    writeConfig({
      "claude-zai": {
        extends: "claude",
        env: { CLAUDE_CONFIG_DIR: dir, ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic" },
      },
    });

    const stores = await discover();
    const entry = stores.find((ref) => ref.id === "claude-zai");
    expect(entry?.quotaKind).toBe("none");
  });

  it("recognises an OpenDesign gateway from its base URL", async () => {
    const dir = join(home, "od");
    seed(dir);
    writeConfig({
      "opendesign-1": {
        extends: "claude",
        env: { CLAUDE_CONFIG_DIR: dir, ANTHROPIC_BASE_URL: "https://amr-link.open-design.ai/v1" },
      },
    });

    const stores = await discover();
    const entry = stores.find((ref) => ref.id === "opendesign-1");
    expect(entry?.kind).toBe("opendesign");
    expect(entry?.quotaKind).toBe("opendesign-or-anthropic");
  });

  it("skips a disabled provider, because a disabled account has no spend to report", async () => {
    const dir = join(home, "off");
    seed(dir);
    writeConfig({ "claude-off": { extends: "claude", enabled: false, env: { CLAUDE_CONFIG_DIR: dir } } });

    const stores = await discover();
    expect(stores.some((ref) => ref.id === "claude-off")).toBe(false);
  });

  it("skips a provider whose store directory does not exist", async () => {
    writeConfig({ "claude-ghost": { extends: "claude", env: { CLAUDE_CONFIG_DIR: join(home, "nope") } } });

    const stores = await discover();
    expect(stores.some((ref) => ref.id === "claude-ghost")).toBe(false);
  });

  it("gives an OpenCode provider its own data home, so two logins stay separate", async () => {
    const dataHome = join(home, ".local", "share", "opencode-2");
    mkdirSync(join(dataHome, "opencode"), { recursive: true });
    writeFileSync(join(dataHome, "opencode", "opencode.db"), "");
    writeConfig({
      "opencode-2": {
        extends: "opencode",
        env: { OPENCODE_CONFIG_DIR: join(home, ".config", "opencode-2"), XDG_DATA_HOME: dataHome },
      },
    });

    const stores = await discover();
    const entry = stores.find((ref) => ref.id === "opencode-2");
    expect(entry?.store).toBe(join(dataHome, "opencode", "opencode.db"));
    expect(entry?.dataHome).toBe(dataHome);
    expect(entry?.quotaKind).toBe("opencode-go");
  });

  it("reads one database once, even when two providers point at it", async () => {
    const dataHome = join(home, ".local", "share");
    mkdirSync(join(dataHome, "opencode"), { recursive: true });
    writeFileSync(join(dataHome, "opencode", "opencode.db"), "");
    writeConfig({
      "opencode-a": { extends: "opencode", env: { XDG_DATA_HOME: dataHome } },
      "opencode-b": { extends: "opencode", env: { XDG_DATA_HOME: dataHome } },
    });

    const stores = await discover();
    const matches = stores.filter((ref) => ref.store === join(dataHome, "opencode", "opencode.db"));
    expect(matches).toHaveLength(1);
  });

  it("expands a tilde in a provider path", async () => {
    const dir = join(home, "claude-tilde");
    seed(dir);
    writeConfig({ "claude-t": { extends: "claude", env: { CLAUDE_CONFIG_DIR: "~/claude-tilde" } } });

    const stores = await discover();
    expect(stores.find((ref) => ref.id === "claude-t")?.store).toBe(dir);
  });
});

describe("turn reading is cached so a poll does not re-parse history", () => {
  function writeSession(dir: string, lines: string[]): void {
    const projects = join(dir, "projects", "-demo-");
    mkdirSync(projects, { recursive: true });
    writeFileSync(join(projects, "session.jsonl"), lines.join("\n"));
  }

  const turn = (timestamp: string) =>
    JSON.stringify({ timestamp, message: { model: "claude-sonnet-5-5", usage: { input_tokens: 10, output_tokens: 5 } } });

  it("ignores turns older than its horizon, because no number on screen needs them", async () => {
    const dir = join(home, "claude-old");
    writeSession(dir, [turn(new Date().toISOString()), turn("2020-01-01T00:00:00.000Z")]);

    const { readTurns } = await import("../server/stores");
    const ref = {
      id: "claude-old",
      label: "Claude old",
      provider: "claude-old",
      kind: "claude" as const,
      store: dir,
      reader: "claude-jsonl" as const,
      quotaKind: "anthropic" as const,
    };

    expect(await readTurns(ref, Date.now() - 86_400_000)).toHaveLength(1);
    // Even an epoch horizon cannot return the 2020 turn: the reader never parsed it.
    expect(await readTurns(ref, 0)).toHaveLength(1);
  });

  it("serves the next poll from memory instead of re-reading the transcript", async () => {
    const dir = join(home, "claude-cache");
    writeSession(dir, [turn(new Date().toISOString())]);

    const { readTurns } = await import("../server/stores");
    const ref = {
      id: "claude-cache",
      label: "Claude cache",
      provider: "claude-cache",
      kind: "claude" as const,
      store: dir,
      reader: "claude-jsonl" as const,
      quotaKind: "anthropic" as const,
    };

    expect(await readTurns(ref, 0)).toHaveLength(1);
    // A transcript that gains a turn between two polls within the cache window is not re-read;
    // that is the trade the cache makes, and one minute is shorter than a cycle changes.
    writeSession(dir, [turn(new Date().toISOString()), turn(new Date().toISOString())]);
    expect(await readTurns(ref, 0)).toHaveLength(1);
  });
});
