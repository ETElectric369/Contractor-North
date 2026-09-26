import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

/** Every suite that talks to a database: the TEST database suites and the opt-in production replays. */
const DB_SUITES = ["src/**/*.integration.test.ts", "src/**/*.prod-replay.test.ts"];

/** Unit tests for pure logic (money math, date/pay-period helpers). These run in
 *  plain Node — no DB, no Next runtime — so they're fast and deterministic. The
 *  "@/..." alias mirrors tsconfig so tests import the same way the app does. */
export default defineConfig({
  // tsconfig says jsx "preserve" (Next compiles JSX itself); a test that renders a component with
  // react-dom/server needs it compiled here, with the same automatic runtime Next uses.
  esbuild: { jsx: "automatic" },
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
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          // tests/ holds meta-tests about the harness itself (the CI-creds guard, the DB guard).
          include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
          exclude: [...configDefaults.exclude, ...DB_SUITES],
        },
      },
      {
        // The database suites, run the way they were verified against the TEST database: one file
        // at a time (they share the remote database, and each file shares one connection, so a
        // timed-out test left running poisons the next one) with timeouts sized for a remote round
        // trip (cases take 3-4.5 s from here; the 5 s / 10 s defaults failed them in CI's shape).
        extends: true,
        test: {
          name: "db",
          include: DB_SUITES,
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
