import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * Credentials live in one file this plugin owns, never in Paseo's config.
 *
 * Why: Paseo validates `~/.paseo/config.json` strictly and rejects unknown keys under `agents`,
 * so a credential written there breaks `paseo reload`. This file is written atomically, mode 0600,
 * and contains nothing Paseo reads.
 *
 * Portability: copy the file to another machine and the credentials follow. They are machine
 * independent by design: a browser session cookie and a vendor API key are both portable strings.
 * Nothing here is encrypted at rest, because there is no key to encrypt with that the user could
 * carry separately; the file relies on filesystem permissions, which is what other local tools do.
 */
export interface CredentialEntry {
  /** Vendor API key, session cookie, or control key, depending on the provider. */
  value: string;
  /** Display label for the plan or account, e.g. "personal" or "work". */
  label?: string;
  /** Workspace id for providers that scope billing per workspace. */
  workspaceId?: string;
  /** Which vendor surface produced this value, for diagnostics without the value. */
  kind?: "apiKey" | "cookie" | "controlKey" | "oauth";
  updatedAt?: string;
}

export type CredentialsFile = Record<string, CredentialEntry>;

const DIR = join(homedir(), ".paseo");
const FILE = join(DIR, "tallimeter-credentials.json");
/**
 * The plugin was called `paseo-usage` before it was published. A user who set it up then already
 * has a credential file, and silently losing their vendor sessions on upgrade would be a bug from
 * their point of view, so the old file is adopted once, on first read, and left untouched.
 */
const LEGACY_FILE = join(DIR, "paseo-usage-credentials.json");
/** Parsed file, kept for two seconds so one snapshot does not re-read it per account. */
let cache: { at: number; value: CredentialsFile } | null = null;

/**
 * Adopts the pre-rename file once. It is copied, not moved: deleting a file the user cannot
 * recreate from anything but a fresh browser sign-in is the kind of cleanup that should be their
 * decision.
 */
function adoptLegacyFile(): void {
  if (existsSync(FILE) || !existsSync(LEGACY_FILE)) return;
  try {
    const parsed = JSON.parse(readFileSync(LEGACY_FILE, "utf8")) as CredentialsFile;
    if (parsed && typeof parsed === "object" && Object.keys(parsed).length > 0) writeCredentials(parsed);
  } catch {
    // An unreadable legacy file is not worth failing a read over.
  }
}

/** Reads the credential file. A missing or corrupt file is an empty store, never a throw. */
export function readCredentials(): CredentialsFile {
  if (cache && Date.now() - cache.at < 2_000) return cache.value;
  adoptLegacyFile();
  let value: CredentialsFile = {};
  if (existsSync(FILE)) {
    try {
      value = JSON.parse(readFileSync(FILE, "utf8")) as CredentialsFile;
    } catch {
      value = {};
    }
  }
  cache = { at: Date.now(), value };
  return value;
}

export function writeCredentials(next: CredentialsFile): void {
  mkdirSync(DIR, { recursive: true });
  const tmp = join(DIR, `tallimeter-credentials.json.tmp-${process.pid}`);
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, FILE);
  cache = { at: Date.now(), value: next };
}

export function setCredential(id: string, entry: CredentialEntry): void {
  const current = readCredentials();
  writeCredentials({ ...current, [id]: { ...entry, updatedAt: new Date().toISOString() } });
}

export function removeCredential(id: string): void {
  const current = { ...readCredentials() };
  delete current[id];
  writeCredentials(current);
}

/**
 * Finds a credential for a provider. Lookup order: the exact provider id, then a vendor-wide
 * default, then any entry whose label matches, so one plan keyed by harness still works.
 */
export function credentialFor(...candidates: string[]): CredentialEntry | null {
  const all = readCredentials();
  for (const id of candidates) {
    if (!id) continue;
    const entry = all[id];
    if (entry?.value) return entry;
  }
  const vendor = candidates[0]?.split(":")[0];
  if (vendor) {
    const fallback = all[`${vendor}:default`];
    if (fallback?.value) return fallback;
    for (const [id, entry] of Object.entries(all)) {
      if (id.startsWith(`${vendor}:`) && entry.value) return entry;
    }
  }
  return null;
}

/** A redacted view, safe to return to the client and to log. */
export function describeCredentials(): Array<{
  id: string;
  label: string | null;
  kind: string | null;
  workspaceId: string | null;
  updatedAt: string | null;
  preview: string;
}> {
  return Object.entries(readCredentials())
    .filter(([, entry]) => Boolean(entry?.value))
    .map(([id, entry]) => ({
      id,
      label: entry.label ?? null,
      kind: entry.kind ?? null,
      workspaceId: entry.workspaceId ?? null,
      updatedAt: entry.updatedAt ?? null,
      // Last four characters only: enough to tell two keys apart, useless to an attacker.
      preview: `…${entry.value.slice(-4)}`,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}
