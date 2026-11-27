/**
 * Live smoke test. Not part of `npm test`: it needs real credentials and reaches the network.
 *
 *   npm run test:live
 *
 * It reports one line per provider: what it read, or why it could not. A provider with no stored
 * credential is expected to report "no credential", not a failure.
 */
import { readCredentials, credentialFor } from "../server/secrets";
import { readQuota } from "../server/quota/index";

const rows: string[] = [];
const pad = (text: string, width: number) => text.padEnd(width);

async function check(brand: string, credentialId: string, extra: Record<string, unknown> = {}) {
  try {
    const quota = await readQuota({ brand, credentialId, forceRefresh: true, ...extra });
    if (!quota) {
      rows.push(`${pad(brand, 16)} no reading (missing credential, refused, or not signed in)`);
      return;
    }
    const windows = quota.windows.map((window) => `${window.id} ${window.usedPct.toFixed(1)}%`).join(", ");
    rows.push(
      `${pad(brand, 16)} ${pad(quota.planLabel ?? "-", 24)} ` +
        `${windows || "no windows"}${quota.balanceUsd !== null ? ` · balance ${quota.balanceUsd}` : ""}`,
    );
  } catch (error) {
    rows.push(`${pad(brand, 16)} ERROR ${error instanceof Error ? error.message : String(error)}`);
  }
}

const stored = readCredentials();
console.log(`stored credentials: ${Object.keys(stored).length}`);
for (const id of Object.keys(stored)) {
  // Only the id and the last four characters: the same redaction the UI shows.
  console.log(`  ${id} ${stored[id]?.kind ?? "?"} …${String(stored[id]?.value ?? "").slice(-4)}`);
}

const openDesign = credentialFor("opendesign:default");
if (openDesign) {
  await check("opendesign", "opendesign:default");
} else {
  rows.push(`${pad("opendesign", 16)} no stored credential`);
}

// A Claude login is read from the config dir, not from the credential file.
await check("anthropic", "claude-default", { store: `${process.env.HOME}/.claude` });
await check("openai", "codex-default", { store: `${process.env.HOME}/.codex` });
await check("opencode-go", "opencode-default", { dataHome: `${process.env.HOME}/.local/share` });
await check("openrouter", "openrouter:default");
await check("ollama", "ollama:default");
await check("gemini", "gemini:default");
await check("deepseek", "deepseek:default");
await check("kimi", "kimi:default");
await check("copilot", "copilot:default");

console.log(rows.join("\n"));
