import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/** Unit tests for pure logic (money math, date/pay-period helpers). These run in
 *  plain Node — no DB, no Next runtime — so they're fast and deterministic. The
 *  "@/..." alias mirrors tsconfig so tests import the same way the app does. */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // The action registry pulls in server actions (→ supabase/server → "server-only").
      // Stub it so registry STRUCTURE can be tested in plain Node; handlers are never
      // invoked in unit tests, so the server runtime itself isn't needed.
      "server-only": fileURLToPath(new URL("./src/test/server-only-stub.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
