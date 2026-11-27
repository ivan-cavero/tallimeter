import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // The server modules use node builtins and one global fetch; a node environment matches them.
    environment: "node",
    restoreMocks: true,
  },
});
