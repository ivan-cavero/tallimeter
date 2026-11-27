import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Quota } from "../../shared/contracts";
import { credentialFor } from "../secrets";
import { readClaudeQuota } from "./anthropic";
import { readCopilotQuota } from "./copilot";
import { readDeepSeekQuota } from "./deepseek";
import { readKimiQuota } from "./kimi";
import { readCodexQuota } from "./codex";
import { readGeminiQuota } from "./gemini";
import { readOllamaQuota } from "./ollama";
import { readOpenDesignQuota } from "./opendesign";
import { readOpenRouterQuota } from "./openrouter";
import { readGoQuota } from "./opencode-go";
import type { StoreRef } from "../stores";

export interface QuotaRequest {
  /** Brand id: `anthropic`, `openai`, `opendesign`, `opencode-go`, `openrouter`, `ollama`, … */
  brand: string;
  /** Credential id to look up, usually the provider id. */
  credentialId: string;
  /** Store directory for providers whose own files carry the login. */
  store?: string;
  dataHome?: string;
  workspaceId?: string;
  forceRefresh?: boolean;
}

const cache = new Map<string, { at: number; value: Quota | null }>();
const TTL_MS = 90_000;

function cached(key: string, opts: { forceRefresh?: boolean }): { hit: boolean; value: Quota | null } {
  const entry = cache.get(key);
  if (!opts.forceRefresh && entry && Date.now() - entry.at < TTL_MS) return { hit: true, value: entry.value };
  return { hit: false, value: null };
}

function remember(key: string, value: Quota | null): Quota | null {
  cache.set(key, { at: Date.now(), value });
  return value;
}

/**
 * Every vendor gets its own branch, because no two expose allowance the same way. Nothing is
 * derived from local token counts: a failed read reports no window rather than an estimate.
 */
export async function readQuota(request: QuotaRequest): Promise<Quota | null> {
  const key = `${request.brand}:${request.credentialId}`;
  const early = cached(key, request);
  if (early.hit) return early.value;

  switch (request.brand) {
    case "anthropic": {
      const dir = request.store ?? join(homedir(), ".claude");
      return remember(key, await readClaudeQuota(dir, { forceRefresh: request.forceRefresh }));
    }
    case "openai": {
      const dir = request.store ?? join(homedir(), ".codex");
      return remember(key, await readCodexQuota(dir, { forceRefresh: request.forceRefresh }));
    }
    case "gemini":
      return remember(key, await readGeminiQuota({ forceRefresh: request.forceRefresh }));
    case "openrouter": {
      const credential = credentialFor(request.credentialId, "openrouter:default");
      if (!credential?.value) return remember(key, null);
      return remember(key, await readOpenRouterQuota(credential.value, { forceRefresh: request.forceRefresh }));
    }
    case "ollama": {
      const credential = credentialFor(request.credentialId, "ollama:default");
      if (!credential?.value) return remember(key, null);
      return remember(key, await readOllamaQuota(credential.value, { forceRefresh: request.forceRefresh }));
    }
    case "opencode-go": {
      const dataHome = request.dataHome ?? join(homedir(), ".local", "share");
      return remember(key, await readGoQuota(dataHome, { forceRefresh: request.forceRefresh }));
    }
    case "deepseek": {
      const credential = credentialFor(request.credentialId, "deepseek:default");
      if (!credential?.value) return remember(key, null);
      return remember(key, await readDeepSeekQuota(credential.value, { forceRefresh: request.forceRefresh }));
    }
    case "kimi": {
      const credential = credentialFor(request.credentialId, "kimi:default");
      if (!credential?.value) return remember(key, null);
      return remember(key, await readKimiQuota(credential.value, { forceRefresh: request.forceRefresh }));
    }
    case "copilot":
      return remember(key, await readCopilotQuota({ forceRefresh: request.forceRefresh }));
    case "opendesign": {
      const credential = credentialFor(request.credentialId, "opendesign:default");
      if (!credential?.value) return remember(key, null);
      const value = await readOpenDesignQuota(
        { controlKey: credential.value, workspaceId: credential.workspaceId ?? request.workspaceId },
        { forceRefresh: request.forceRefresh },
      );
      return remember(key, value);
    }
    default:
      return remember(key, null);
  }
}

/**
 * Reads allowance for a store, choosing the vendor by the turns it served. A store can hold
 * turns from several vendors, so this is called once per (store, vendor) pair.
 */
export function quotaRequestForStore(ref: StoreRef, turnProvider: string, forceRefresh: boolean): QuotaRequest {
  switch (turnProvider) {
    case "anthropic":
      return { brand: "anthropic", credentialId: ref.id, store: ref.store, forceRefresh };
    case "opendesign":
      return { brand: "opendesign", credentialId: ref.id, forceRefresh };
    case "openai":
      return { brand: "openai", credentialId: ref.id, store: ref.store, forceRefresh };
    case "gemini":
      return { brand: "gemini", credentialId: ref.id, forceRefresh };
    case "opencode":
    case "opencode-go":
      return { brand: "opencode-go", credentialId: ref.id, dataHome: ref.dataHome, forceRefresh };
    case "openrouter":
      return { brand: "openrouter", credentialId: ref.id, forceRefresh };
    case "ollama":
      return { brand: "ollama", credentialId: ref.id, forceRefresh };
    case "deepseek":
      return { brand: "deepseek", credentialId: ref.id, forceRefresh };
    case "kimi":
      return { brand: "kimi", credentialId: ref.id, forceRefresh };
    case "copilot":
      return { brand: "copilot", credentialId: ref.id, forceRefresh };
    default:
      return { brand: "none", credentialId: ref.id, forceRefresh };
  }
}

/**
 * Deletes the private cookie copies a browser import made, if a crash left one behind. The import
 * already removes its own copy; this only catches an interrupted run.
 */
export function cleanCookieCopies(): void {
  try {
    for (const entry of readdirSync("/tmp")) {
      if (entry.startsWith("tallimeter-cookies-")) rmSync(join("/tmp", entry), { force: true });
    }
  } catch {
    // Nothing to clean, or /tmp is unreadable; both are harmless.
  }
}
