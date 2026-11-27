import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { createDecipheriv, pbkdf2Sync } from "node:crypto";

/**
 * Reads a signed-in OpenDesign session out of a Chromium-family browser, so the user does not have
 * to open DevTools and copy a cookie by hand.
 *
 * Chromium encrypts cookies with `OSCrypt`:
 *
 *   key = PBKDF2-HMAC-SHA1(password, "saltysalt", 1 iteration, 16 bytes)
 *   cipher = AES-128-CBC, IV = 16 bytes of 0x20, blob prefixed with 3 bytes of "v10"/"v11"
 *
 * The password is the browser's "Safe Storage" entry, and where that lives is the one thing that
 * differs per platform:
 *
 *   Linux   the plain string in the desktop keyring, read with `secret-tool`.
 *   macOS   the same string in the login Keychain, read with `security`.
 *   Windows the key is wrapped with DPAPI, which needs a native call Node does not expose. The
 *           import reports that plainly and the user pastes the cookie instead.
 */

const HOME = homedir();

interface BrowserTarget {
  name: string;
  configDir: string;
  /** What the keyring entry is called on Linux and macOS. */
  keyringService: string;
  keyringUser: string;
}

/**
 * The per-platform browser roots. A browser that is not installed contributes no candidate, so
 * probing all seven costs one `existsSync` each.
 */
function configRoots(): Array<{ name: string; configDir: string; keyringService: string; keyringUser: string }> {
  if (process.platform === "darwin") {
    const base = join(HOME, "Library", "Application Support");
    return [
      { name: "Brave", configDir: join(base, "BraveSoftware", "Brave-Browser"), keyringService: "Brave Safe Storage", keyringUser: "Brave" },
      { name: "Chrome", configDir: join(base, "Google", "Chrome"), keyringService: "Chrome Safe Storage", keyringUser: "Chrome" },
      { name: "Chromium", configDir: join(base, "Chromium"), keyringService: "Chromium Safe Storage", keyringUser: "Chromium" },
      { name: "Vivaldi", configDir: join(base, "Vivaldi"), keyringService: "Vivaldi Safe Storage", keyringUser: "Vivaldi" },
      { name: "Edge", configDir: join(base, "Microsoft Edge"), keyringService: "Microsoft Edge Safe Storage", keyringUser: "Microsoft Edge" },
      { name: "Arc", configDir: join(base, "Arc", "User Data"), keyringService: "Arc Safe Storage", keyringUser: "Arc" },
    ];
  }
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA ?? join(HOME, "AppData", "Local");
    return [
      { name: "Brave", configDir: join(base, "BraveSoftware", "Brave-Browser", "User Data"), keyringService: "", keyringUser: "" },
      { name: "Chrome", configDir: join(base, "Google", "Chrome", "User Data"), keyringService: "", keyringUser: "" },
      { name: "Chromium", configDir: join(base, "Chromium", "User Data"), keyringService: "", keyringUser: "" },
      { name: "Vivaldi", configDir: join(base, "Vivaldi", "User Data"), keyringService: "", keyringUser: "" },
      { name: "Edge", configDir: join(base, "Microsoft", "Edge", "User Data"), keyringService: "", keyringUser: "" },
    ];
  }
  const base = join(HOME, ".config");
  return [
    { name: "Brave", configDir: join(base, "BraveSoftware", "Brave-Browser"), keyringService: "Brave Keys", keyringUser: "Brave Safe Storage" },
    { name: "Chrome", configDir: join(base, "google-chrome"), keyringService: "Chrome Keys", keyringUser: "Chrome Safe Storage" },
    { name: "Chromium", configDir: join(base, "chromium"), keyringService: "Chromium Keys", keyringUser: "Chromium Safe Storage" },
    { name: "Vivaldi", configDir: join(base, "vivaldi"), keyringService: "Vivaldi Keys", keyringUser: "Vivaldi Safe Storage" },
    { name: "Edge", configDir: join(base, "microsoft-edge"), keyringService: "Microsoft Edge Keys", keyringUser: "Microsoft Edge Safe Storage" },
  ];
}

const TARGETS: BrowserTarget[] = configRoots();

/**
 * Stores that may exist for any installed browser. Older builds put `Cookies` directly in the
 * profile folder, newer ones under `Network/`, and Linux Brave still uses the older layout, so
 * both are checked.
 */
function cookieStores(configDir: string): string[] {
  const stores: string[] = [];
  if (!existsSync(configDir)) return stores;

  const profiles = [
    "Default",
    ...readdirSync(configDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => name !== "Default" && name !== "Network" && name !== "ShaderCache" && name !== "GrShaderCache"),
  ];

  for (const profile of profiles) {
    for (const candidate of [
      join(configDir, profile, "Network", "Cookies"),
      join(configDir, profile, "Cookies"),
    ]) {
      if (existsSync(candidate)) stores.push(candidate);
    }
  }
  return stores;
}

/**
 * The password Chromium hashes into its cookie key. Absent means no decryptable cookies: the
 * browser was never signed into the desktop session, or the platform needs DPAPI.
 */
function safeStoragePassword(target: BrowserTarget): string[] {
  if (process.platform === "darwin") {
    try {
      const value = execFileSync(
        "security",
        ["find-generic-password", "-w", "-s", target.keyringService, "-a", target.keyringUser],
        { encoding: "utf8", timeout: 8_000, stdio: ["ignore", "pipe", "ignore"] },
      ).trim();
      return value ? [value] : [];
    } catch {
      return [];
    }
  }
  if (process.platform === "linux") {
    try {
      const value = execFileSync(
        "secret-tool",
        ["lookup", "server", target.keyringService, "user", target.keyringUser],
        { encoding: "utf8", timeout: 8_000, stdio: ["ignore", "pipe", "ignore"] },
      ).trim();
      if (!value) return [];
      // Linux builds have shipped both spellings: the string itself, and its base64 decoding.
      // Both are tried, because only the live endpoint can say which one produced a valid token.
      return [value, Buffer.from(value, "base64").toString("utf8")];
    } catch {
      return [];
    }
  }
  return [];
}

function decodeValue(blob: Buffer, password: string): string | null {
  const prefix = blob.subarray(0, 3).toString("latin1");
  if (prefix !== "v10" && prefix !== "v11") return null;
  try {
    const key = pbkdf2Sync(password, "saltysalt", 1, 16, "sha1");
    const decipher = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
    const plain = Buffer.concat([decipher.update(blob.subarray(3)), decipher.final()]);
    const asText = plain.toString("utf8");
    // Newer builds prefix a 32-byte SHA-256 of the cookie's domain.
    const hasBinaryHead = /[\u0000-\u0008\u000e-\u001f]/.test(asText.slice(0, 32));
    return (hasBinaryHead ? plain.subarray(32) : plain).toString("utf8");
  } catch {
    return null;
  }
}

export interface BrowserSession {
  browser: string;
  /** Full `Cookie: __Secure-better-auth.session_token=…` header value. */
  cookie: string;
  /** Which store the cookie came from, for the message shown to the user. */
  store: string;
}

/** Why the import could not run, in words the user can act on. */
export type BrowserSessionFailure = "unsupported" | "no-session";

export interface BrowserSessionResult {
  session: BrowserSession | null;
  failure: BrowserSessionFailure | null;
}

/**
 * Refuses before doing any work on a platform whose cookie key cannot be read, so the message is
 * about the platform rather than about a missing browser session. Windows wraps the key with
 * DPAPI, which needs a native call Node does not expose.
 */
const isUnsupported = () => process.platform === "win32";

/**
 * Returns the OpenDesign session cookie from the first browser that has one. The caller still
 * verifies it against the live API, because a stale cookie decrypts fine and authenticates to
 * nothing.
 */
export async function readOpenDesignCookieFromBrowser(): Promise<BrowserSessionResult> {
  if (isUnsupported()) return { session: null, failure: "unsupported" };

  let sqlite: { DatabaseSync: new (path: string) => any };
  try {
    sqlite = (await import("node:sqlite")) as unknown as { DatabaseSync: new (path: string) => any };
  } catch {
    return { session: null, failure: "unsupported" };
  }

  const tempDir = tmpdir();
  for (const target of TARGETS) {
    const stores = cookieStores(target.configDir);
    if (stores.length === 0) continue;
    const passwords = safeStoragePassword(target);
    if (passwords.length === 0) continue;

    for (const store of stores) {
      // Chromium keeps the database open with a WAL; a copy is the only read that cannot disturb it.
      const copy = join(tempDir, `tallimeter-cookies-${process.pid}-${Math.random().toString(36).slice(2)}.sqlite`);
      try {
        copyFileSync(store, copy);
        const db = new sqlite.DatabaseSync(copy);
        try {
          const rows = db
            .prepare(
              "SELECT host_key, name, encrypted_value FROM cookies WHERE host_key LIKE '%open-design.ai' AND name LIKE '%session_token%'",
            )
            .all() as Array<{ host_key: string; name: string; encrypted_value: Buffer }>;

          const sessionRow =
            rows.find((row) => row.name === "__Secure-better-auth.session_token") ??
            rows.find((row) => row.name.startsWith("__Secure-better-auth.session_token"));

          if (!sessionRow) continue;

          for (const password of passwords) {
            const value = decodeValue(Buffer.from(sessionRow.encrypted_value), password);
            if (!value) continue;
            if (!(await verifyCookie(value))) continue;
            return {
              session: {
                browser: target.name,
                cookie: `__Secure-better-auth.session_token=${value}`,
                store,
              },
              failure: null,
            };
          }
        } finally {
          db.close?.();
        }
      } catch {
        continue;
      } finally {
        try {
          rmSync(copy, { force: true });
        } catch {
          // A leftover temp file is harmless, and `cleanCookieCopies` catches a hard crash.
        }
      }
    }
  }

  return { session: null, failure: "no-session" };
}

/** One cheap call that only succeeds for a valid session, so a stale cookie is never stored. */
async function verifyCookie(value: string): Promise<boolean> {
  try {
    const response = await fetch("https://amr-api.open-design.ai/api/v1/workspaces/current", {
      headers: {
        Accept: "application/json",
        Cookie: `__Secure-better-auth.session_token=${value}`,
        "User-Agent": "tallimeter/1.0",
      },
      signal: AbortSignal.timeout(12_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** The sentence a user sees for each failure kind. */
export function browserSessionMessage(failure: BrowserSessionFailure | null): string {
  if (failure === "unsupported") {
    return process.platform === "win32"
      ? "Automatic import is not available on Windows: Chromium wraps its cookie key with DPAPI. Open open-design.ai, then copy the session cookie from DevTools and paste it as a Credential."
      : "Automatic import needs node:sqlite in the Paseo runtime. Paste the session cookie as a Credential instead.";
  }
  return "No OpenDesign session found. Sign in to open-design.ai in Brave, Chrome or Chromium on this machine, then retry, or paste the cookie as a Credential.";
}
