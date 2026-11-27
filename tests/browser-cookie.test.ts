import { describe, expect, it } from "vitest";
import { browserSessionMessage } from "../server/browser-cookie";

/**
 * The browser import is the one path that touches a secret on disk, so its refusals matter as much
 * as its successes: each failure kind must name the thing the user can actually do next.
 */
describe("browser session messages", () => {
  it("says a missing session is about signing in, and names the fallback", () => {
    const message = browserSessionMessage("no-session");
    expect(message).toContain("Sign in to open-design.ai");
    // The paste path must be offered, because the import can never be the only way in.
    expect(message).toMatch(/paste/i);
  });

  it("explains the platform instead of blaming the session on Windows", () => {
    const message = browserSessionMessage("unsupported");
    // On a non-Windows host the message must be about the runtime, not about the user's browser.
    if (process.platform === "win32") expect(message).toContain("DPAPI");
    else expect(message).toContain("node:sqlite");
    expect(message).toMatch(/paste/i);
  });

  it("never claims success while reporting a failure", () => {
    for (const failure of ["unsupported", "no-session"] as const) {
      const message = browserSessionMessage(failure);
      expect(message.toLowerCase()).not.toContain("saved");
    }
  });
});
