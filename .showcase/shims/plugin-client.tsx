// The showcase mounts the real screen against stubbed hooks, so a capture shows the actual layout
// and the actual formatting functions rather than a drawing of them.
import { createElement } from "react";

export type PluginScreenProps = { theme: any; layout: any; host?: any };

export function useRpc(contract: { name: string }) {
  const name = contract?.name ?? "";
  return async () => {
    if (name.endsWith(".snapshot")) return (globalThis as any).__MOCK_SNAPSHOT__;
    if (name.endsWith(".brands")) return (globalThis as any).__MOCK_BRANDS__;
    if (name.endsWith(".accounts")) return (globalThis as any).__MOCK_ACCOUNTS__;
    if (name.endsWith(".credentials")) return (globalThis as any).__MOCK_CREDENTIALS__;
    return {};
  };
}

export function useSettings() {
  return {
    status: "ready" as const,
    revision: "rev-1",
    values: (globalThis as any).__MOCK_SETTINGS__,
    saving: false,
    saveError: null,
    save: async () => {},
  };
}

export function usePaseo() {
  return {};
}

export { createElement };
