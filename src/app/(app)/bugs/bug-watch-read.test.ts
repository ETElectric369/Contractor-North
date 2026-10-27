import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * BUG WATCH SAYS A FAILED READ (cn-v1130, the deep review's ops finding: "a failed read is never an
 * empty run"). listBugReports returned [] on a refused or broken read, and the page said "All clear —
 * no open bug reports to triage" over it. The read now comes back as { rows, error }: the gate's
 * nothing is a plain nothing, a failed read carries its sentence, and the page shows that sentence
 * where the list would be, with no open count it does not know.
 */
const state = vi.hoisted(() => ({
  ctx: null as any,
  read: { data: null as unknown[] | null, error: null as null | { message: string } },
}));
vi.mock("@/lib/platform-admin", () => ({ requirePlatformAdmin: vi.fn(async () => state.ctx) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(), createServiceClient: vi.fn() }));
vi.mock("@/lib/site-editor-guard", () => ({ resolveSiteContext: vi.fn() }));

import { listBugReports } from "@/app/(app)/bug-report-actions";

/** The list read's chain, answered from `state.read`; nothing else is reached when every row has
 *  a reporter name and the rows share one org (no collaborator lookup, no tenant labels). */
function client() {
  const chain: any = {
    select: () => chain,
    order: () => chain,
    limit: () => Promise.resolve(state.read),
  };
  return { from: () => chain, rpc: async () => ({ data: null, error: null }) };
}

const ROW = {
  id: "b1",
  note: "Save did nothing on the task sheet",
  page: "/jobs/abc",
  status: "open",
  created_at: "2026-10-26T10:00:00Z",
  screenshot_path: null,
  reported_by: "u1",
  org_id: "o1",
  profiles: { full_name: "Snowbell Bayberry" },
};

beforeEach(() => {
  state.ctx = { supabase: client(), userId: "admin" };
  state.read = { data: null, error: null };
});

describe("listBugReports: rows beside the read's error", () => {
  it("the gate: anyone but a platform admin gets nothing, and no error", async () => {
    state.ctx = { error: "Only North's own team can do that." };
    expect(await listBugReports()).toEqual({ rows: [], error: null });
  });

  it("a failed read is NOT an empty list: no rows, and the database's sentence", async () => {
    state.read = { data: null, error: { message: "could not connect to server" } };
    expect(await listBugReports()).toEqual({ rows: [], error: "could not connect to server" });
    // a refusal is said in English (dbError), never as a bare constraint
    state.read = { data: null, error: { message: "permission denied for table bug_reports" } };
    const refused = await listBugReports();
    expect(refused.rows).toEqual([]);
    expect(refused.error).toContain("You don't have access");
  });

  it("a good read maps the rows and carries no error", async () => {
    state.read = { data: [ROW], error: null };
    expect(await listBugReports()).toEqual({
      rows: [
        {
          id: "b1",
          note: "Save did nothing on the task sheet",
          page: "/jobs/abc",
          status: "open",
          created_at: "2026-10-26T10:00:00Z",
          reporter: "Snowbell Bayberry",
          screenshot_path: null,
          org: null,
        },
      ],
      error: null,
    });
  });
});

describe("Bug Watch shows the failed read where the list would be", () => {
  const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

  it("the page hands the read's error to the list", () => {
    const page = src("src/app/(app)/bugs/page.tsx");
    expect(page).toContain("const { rows, error } = await listBugReports();");
    expect(page).toContain("<BugList initial={rows} readError={error} />");
  });

  it("'All clear' sits behind the readError branch, under its own title, and the Open count is withheld", () => {
    const list = src("src/app/(app)/bugs/bug-list.tsx");
    expect(list).toContain("readError?: string | null");
    expect(list).toContain('title="Couldn\'t read the reports" description={readError}');
    // the RENDERED sentence, not the comment that names it: it is reached only past the branch
    const branch = list.indexOf("{readError ? (");
    const allClear = list.indexOf("All clear — no open bug reports to triage.");
    expect(branch).toBeGreaterThan(-1);
    expect(allClear).toBeGreaterThan(branch);
    expect(list.lastIndexOf("All clear — no open bug reports to triage.")).toBe(allClear);
    expect(list).toContain("!readError && openCount > 0");
  });

  it("the Report A Problem panel reads the rows out of the same shape, and a failed read never wipes a list that had loaded", () => {
    const reporter = src("src/components/bug-reporter.tsx");
    expect(reporter).not.toContain(".then(setReports)");
    // Both reads set the rows ONLY when the read came back clean (cn-v1130, skeptic #34): a failed
    // read hands back rows [] beside its error, and setting those would blank a loaded list.
    expect(reporter).not.toContain("listBugReports().then((r) => setReports(r.rows))");
    expect(reporter.split("listBugReports().then((r) => { if (!r.error) setReports(r.rows); })").length - 1).toBe(2);
  });
});
