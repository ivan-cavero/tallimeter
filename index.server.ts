import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  accountRpc,
  brandsRpc,
  credentialsRpc,
  snapshotRpc,
  usageSettings,
  type Quota,
  type UsageSettings,
} from "./shared/contracts";
import { BRANDS, brandFor } from "./server/registry";
import {
  addAccount,
  listAccounts,
  removeAccount,
  renameAccount,
  reloadDaemon,
} from "./server/accounts";
import { buildSnapshot } from "./server/aggregate";
import { loadPrices } from "./server/prices";
import { readQuota, quotaRequestForStore } from "./server/quota/index";
import { readOpenDesignQuota } from "./server/quota/opendesign";
import { browserSessionMessage, readOpenDesignCookieFromBrowser } from "./server/browser-cookie";
import { credentialFor, describeCredentials, readCredentials, removeCredential, setCredential } from "./server/secrets";
import { cleanCookieCopies } from "./server/quota/index";
import { discoverStores, type StoreRef } from "./server/stores";

/**
 * A live check that costs nothing and proves the credential. Each vendor has one cheap endpoint
 * that refuses an invalid credential, so the user never stores a key that silently fails later.
 */
async function verifyCredential(id: string, value: string): Promise<boolean> {
  const vendor = id.split(":")[0];
  try {
    if (vendor === "opendesign") {
      const cookie = value.startsWith("__Secure") ? value : `__Secure-better-auth.session_token=${value}`;
      const response = await fetch("https://amr-api.open-design.ai/api/v1/workspaces/current", {
        headers: { Accept: "application/json", Cookie: cookie, "User-Agent": "tallimeter/1.0" },
        signal: AbortSignal.timeout(12_000),
      });
      return response.ok;
    }
    if (vendor === "openrouter") {
      const response = await fetch("https://openrouter.ai/api/v1/key", {
        headers: { Authorization: `Bearer ${value}`, Accept: "application/json" },
        signal: AbortSignal.timeout(12_000),
      });
      return response.ok;
    }
    if (vendor === "ollama") {
      const response = await fetch("https://ollama.com/api/balance", {
        headers: { Authorization: `Bearer ${value}`, Accept: "application/json" },
        signal: AbortSignal.timeout(12_000),
      });
      return response.ok;
    }
    if (vendor === "deepseek") {
      const response = await fetch("https://api.deepseek.com/user/balance", {
        headers: { Authorization: `Bearer ${value}`, Accept: "application/json" },
        signal: AbortSignal.timeout(12_000),
      });
      return response.ok;
    }
    // Anthropic, Codex, Gemini and Copilot credentials are OAuth tokens their own CLI owns; the
    // plugin reads them from disk and never stores them, so there is nothing to verify here.
    return false;
  } catch {
    return false;
  }
}

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(usageSettings);
  // A crashed browser-cookie import can leave a decrypted database copy in the temp directory.
  // Sweeping it here means the next start cleans up after the last one.
  cleanCookieCopies();

  const readValues = async (): Promise<UsageSettings> => {
    const state = await settings.read();
    return state.status === "ready"
      ? state.values
      : { accounts: {}, defaultCycleStartDay: 1, hoursPerWorkday: 8, hourlyRateUsd: 0 };
  };

  server.handle(snapshotRpc, async (input) => {
    const values = await readValues();
    const [refs, prices] = await Promise.all([Promise.resolve(discoverStores()), loadPrices()]);

    // Each provider rate-limits its own usage endpoint, so quota reads are cached per account
    // and the refresh button only bypasses that cache.
    const quotas = new Map<string, Quota | null>();
    // Which vendor a store's turns belong to is known only after reading them, so the aggregator
    // asks for allowance per (store, vendor) pair through this callback.
    const resolveQuota = async (ref: StoreRef, vendor: string): Promise<Quota | null> => {
      const key = `quota:${ref.id}:${vendor}`;
      if (quotas.has(key)) return quotas.get(key) ?? null;
      try {
        const value = await readQuota(quotaRequestForStore(ref, vendor, input.refreshQuota));
        quotas.set(key, value);
        return value;
      } catch {
        quotas.set(key, null);
        return null;
      }
    };

    // OpenDesign plans come from the credential file, which is the only place a secret is stored.
    // A plan entry is one subscription: its own windows, its own wallet, its own card.
    const openDesignEntries = Object.entries(readCredentials()).filter(([id]) => id.startsWith("opendesign:"));
    const planIds = openDesignEntries.length > 0 ? openDesignEntries.map(([id]) => id.slice("opendesign:".length)) : ["default"];
    const planFor = (storeId: string): string =>
      planIds.includes(storeId) ? storeId : planIds.includes("default") ? "default" : (planIds[0] ?? "default");
    const planNames: Record<string, string> = Object.fromEntries(
      planIds.map((planId) => {
        const entry = credentialFor(`opendesign:${planId}`);
        const label = entry?.label && entry.label !== planId ? entry.label : planId === "default" ? "shared plan" : planId;
        return [planId, label];
      }),
    );

    await Promise.all(
      planIds.map(async (planId) => {
        const entry = credentialFor(`opendesign:${planId}`);
        if (!entry?.value) {
          quotas.set(`plan:${planId}`, null);
          return;
        }
        try {
          quotas.set(
            `plan:${planId}`,
            await readOpenDesignQuota(
              { controlKey: entry.value, workspaceId: entry.workspaceId },
              { forceRefresh: input.refreshQuota },
            ),
          );
        } catch {
          quotas.set(`plan:${planId}`, null);
        }
      }),
    );

    const result = await buildSnapshot({
      refs,
      budgets: values.accounts,
      defaultStartDay: values.defaultCycleStartDay,
      quotas,
      prices,
      hoursPerWorkday: values.hoursPerWorkday,
      hourlyRateUsd: values.hourlyRateUsd,
      openDesignPlanFor: planFor,
      openDesignPlans: planNames,
      resolveQuota,
    });

    const summary = result.accounts
      .filter((account) => account.kind === "opendesign" || (account.quota?.windows.length ?? 0) > 0)
      .map((account) => `${account.label}:${account.quota?.windows.length ?? 0}w`);
    console.log(`[tallimeter] ${refs.length} stores, ${result.accounts.length} cards; ${summary.join(" | ")}`);
    return { generatedAt: new Date().toISOString(), ...result };
  });

  server.handle(accountRpc, async (input) => {
    try {
      if (input.action === "list") {
        return { accounts: listAccounts(), message: null };
      }
      if (input.action === "add") {
        const result = addAccount({
          family: input.family,
          label: input.label,
          apiKey: input.apiKey,
          controlKey: "",
          workspaceId: input.workspaceId,
        });
        if (input.family === "opendesign" && input.controlKey.trim()) {
          setCredential(`opendesign:${result.id}`, {
            value: input.controlKey.trim(),
            workspaceId: input.workspaceId.trim() || undefined,
            kind: "cookie",
            label: input.label || undefined,
          });
        }
        await reloadDaemon();
        return { accounts: listAccounts(), message: result.message };
      }
      if (input.action === "remove") {
        const message = removeAccount(input.id);
        await reloadDaemon();
        return { accounts: listAccounts(), message };
      }
      const message = renameAccount(input.id, input.label);
      await reloadDaemon();
      return { accounts: listAccounts(), message };
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : String(error));
    }
  });

  server.handle(brandsRpc, async () => ({
    brands: Object.keys(BRANDS).map((id) => {
      const brand = brandFor(id);
      return {
        id: brand.id,
        brandId: brand.brandId,
        label: brand.label,
        icon: brand.icon,
        mark: brand.mark ?? "",
        tile: brand.tile ?? null,
        bleed: brand.bleed ?? false,
        mono: brand.mono ?? true,
        color: brand.color,
        quotaHint: brand.quotaHint,
        docsUrl: brand.docsUrl,
        credentials: brand.credentials,
        quota: brand.quota,
      };
    }),
  }));

  server.handle(credentialsRpc, async (input) => {
    if (input.action === "list") {
      return { credentials: describeCredentials(), message: null, verified: null };
    }
    if (input.action === "set") {
      setCredential(input.id, {
        value: input.value,
        label: input.label,
        workspaceId: input.workspaceId,
        kind: input.kind,
      });
      return {
        credentials: describeCredentials(),
        message: `Saved ${input.id}.`,
        verified: null,
      };
    }
    if (input.action === "remove") {
      removeCredential(input.id);
      return { credentials: describeCredentials(), message: `Removed ${input.id}.`, verified: null };
    }
    if (input.action === "import-browser") {
      const { session, failure } = await readOpenDesignCookieFromBrowser();
      if (!session) {
        return {
          credentials: describeCredentials(),
          message: browserSessionMessage(failure),
          verified: false,
        };
      }
      const id = `opendesign:${(input.planId ?? "default").trim() || "default"}`;
      setCredential(id, { value: session.cookie, label: input.planId, kind: "cookie" });
      return {
        credentials: describeCredentials(),
        message: `Read a valid session from ${session.browser} and saved it for ${id}.`,
        verified: true,
      };
    }

    // verify: one live request that only succeeds for a working credential.
    const entry = credentialFor(input.id);
    if (!entry?.value) {
      return { credentials: describeCredentials(), message: "No credential stored under that id.", verified: false };
    }
    const valid = await verifyCredential(input.id, entry.value);
    return {
      credentials: describeCredentials(),
      message: valid
        ? `The provider accepted ${input.id}.`
        : `The provider rejected ${input.id}, or this kind of credential cannot be checked live.`,
      verified: valid,
    };
  });

  return () => {};
}
