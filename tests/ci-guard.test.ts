import { describe, it, expect } from "vitest";

// Meta-test guarding the CI safety net itself. The RLS-isolation and billing-draw
// integration tests (src/lib/rls.integration.test.ts, src/lib/billing.integration.test.ts)
// gate on TEST_DB_HOST / TEST_DB_USER / TEST_DBPW and skip cleanly when the creds are
// absent — right for local dev, but in CI it meant a green check that never actually ran
// the multi-tenant security tests. This turns that silent skip into a loud failure:
// GitHub Actions always sets CI=true, so in CI the creds MUST be present (the workflow
// wires them from repo secrets). Locally (CI unset) this suite skips quietly.
const d = process.env.CI ? describe : describe.skip;

d("CI guard: DB integration tests must actually run in CI", () => {
  it("has the TEST_DB_* creds (otherwise the RLS/billing integration tests silently skipped)", () => {
    // secrets that aren't configured arrive as empty strings — treat those as missing too.
    const missing = ["TEST_DB_HOST", "TEST_DB_USER", "TEST_DBPW"].filter((k) => !process.env[k]);
    expect(
      missing,
      `CI is running without TEST DB creds (missing: ${missing.join(", ")}) — the RLS/billing ` +
        "integration tests silently skipped. Add the repo secrets: gh secret set TEST_DB_HOST " +
        "(Supabase pooler host), TEST_DB_USER (pooler user postgres.<project-ref>), " +
        "TEST_DBPW (the database password).",
    ).toEqual([]);
  });
});
