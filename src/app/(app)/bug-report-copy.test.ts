import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A BUG REPORT CARRIES ITS PICTURE IN THE ROW (cn-v1175, 0412). The owner: "if you cant open
 * screenshots from the bug reports then that needs to be fixed right?". The server keeps a JPEG data
 * URL under the cap and DROPS anything else; the report itself always files, on a database without
 * the column too (the deploy and the migration are two steps).
 */
const state = vi.hoisted(() => ({
  inserts: [] as Record<string, unknown>[],
  answers: [] as ({ error: null | { code?: string; message?: string } })[],
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "u1" } } }) },
    from: () => ({
      insert: (row: Record<string, unknown>) => {
        state.inserts.push(row);
        return Promise.resolve(state.answers.shift() ?? { error: null });
      },
    }),
  })),
  createServiceClient: vi.fn(),
}));
vi.mock("@/lib/platform-admin", () => ({ requirePlatformAdmin: vi.fn() }));
vi.mock("@/lib/site-editor-guard", () => ({ resolveSiteContext: vi.fn(async (id: string) => ({ orgId: id })) }));

import { createBugReport } from "./bug-report-actions";

const COPY = "data:image/jpeg;base64," + "A".repeat(2_000);
const base = { page: "/planner", note: "the button did nothing", console: [], userAgent: "test", viewport: "390x844", screenshotPath: "o1/bug-screenshots/1.jpg" };

beforeEach(() => {
  state.inserts = [];
  state.answers = [];
});

describe("the server's check on the row's copy", () => {
  it("keeps a JPEG data URL under the cap, beside the path", async () => {
    expect(await createBugReport({ ...base, screenshotCopy: COPY })).toEqual({ ok: true });
    expect(state.inserts).toHaveLength(1);
    expect(state.inserts[0]).toMatchObject({ screenshot_path: base.screenshotPath, screenshot_copy: COPY });
  });

  it.each([
    ["a PNG", "data:image/png;base64,AAAA"],
    ["one over the cap", "data:image/jpeg;base64," + "A".repeat(300_000)],
    ["a link", "https://example.test/a.jpg"],
    ["nothing", undefined],
  ])("drops %s and files the report without it", async (_n, copy) => {
    expect(await createBugReport({ ...base, screenshotCopy: copy as string | undefined })).toEqual({ ok: true });
    expect(state.inserts).toHaveLength(1);
    expect(state.inserts[0]).not.toHaveProperty("screenshot_copy");
  });

  it("the /content path carries no copy, as it carries no file", async () => {
    await createBugReport({ ...base, screenshotCopy: COPY, orgId: "o2" });
    expect(state.inserts[0]).toMatchObject({ org_id: "o2", screenshot_path: null });
    expect(state.inserts[0]).not.toHaveProperty("screenshot_copy");
  });
});

describe("the report always files", () => {
  it("before 0412 is applied: filed again without the copy", async () => {
    state.answers = [{ error: { code: "PGRST204", message: "Could not find the 'screenshot_copy' column of 'bug_reports' in the schema cache" } }];
    expect(await createBugReport({ ...base, screenshotCopy: COPY })).toEqual({ ok: true });
    expect(state.inserts).toHaveLength(2);
    expect(state.inserts[1]).not.toHaveProperty("screenshot_copy");
    expect(state.inserts[1]).toMatchObject({ note: base.note, screenshot_path: base.screenshotPath });
  });

  it("0412's check refusing the copy: filed again without it", async () => {
    state.answers = [{ error: { code: "23514", message: 'violates check constraint "bug_reports_screenshot_copy_shape"' } }];
    expect(await createBugReport({ ...base, screenshotCopy: COPY })).toEqual({ ok: true });
    expect(state.inserts).toHaveLength(2);
  });

  it("any other failure is said, and not retried", async () => {
    state.answers = [{ error: { code: "42501", message: "new row violates row-level security policy" } }];
    const res = await createBugReport({ ...base, screenshotCopy: COPY });
    expect(res.ok).toBe(false);
    expect(state.inserts).toHaveLength(1);
  });
});

describe("the projection law: nothing lists the copy; the sweep clears it with the file", () => {
  const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

  it("no select in the app names screenshot_copy", async () => {
    const { execSync } = await import("node:child_process");
    const hits = execSync(`grep -rln "screenshot_copy" src --include=*.ts --include=*.tsx || true`, { cwd: process.cwd() })
      .toString()
      .trim()
      .split("\n")
      .filter((f) => f && !/\.test\.tsx?$/.test(f))
      .sort();
    // The writer, the export's omission, the sweep, and the helper that names it in its error test.
    expect(hits).toEqual(["src/app/(app)/bug-report-actions.ts", "src/lib/bug-shot-copy.ts", "src/lib/export/registry.ts", "src/lib/storage-sweep.ts"]);
    expect(src("src/app/(app)/bug-report-actions.ts")).not.toMatch(/select\([^)]*screenshot_copy/);
  });

  it("the reporter draws the capture at captureScale and makes the file and the row's copy from that one canvas", () => {
    const reporter = src("src/components/bug-reporter.tsx");
    expect(reporter).toContain("scale: captureScale(window.innerWidth),");
    expect(reporter).not.toContain("scale: 0.6,");
    expect(reporter).toContain("return { blob, copy: copyOf(canvas) };");
  });

  it("the word for it is copy: no thumbnail is left anywhere in this release's files", () => {
    for (const f of [
      "src/lib/bug-shot-copy.ts",
      "src/components/bug-reporter.tsx",
      "src/app/(app)/bug-report-actions.ts",
      "src/lib/storage-sweep.ts",
      "src/lib/export/registry.ts",
      "src/app/north-site/privacy/page.tsx",
      "supabase/migrations/0412_a_bug_report_carries_its_picture.sql",
    ]) {
      expect(src(f), f).not.toMatch(/thumb|small copy/i);
    }
  });

  it("the sweep clears the copy in the same write as the path, and a closed report's copy at the file's age: 7 days", () => {
    const sweep = src("src/lib/storage-sweep.ts");
    expect(sweep).toContain("const BUG_SHOT_AGE_MS = 7 * 24 * 60 * 60 * 1000;");
    expect(sweep).toContain("await clear({ screenshot_path: null, screenshot_copy: null });");
    expect(sweep).toContain("if (clearErr && isCopyColumnMissing(clearErr)) ({ error: clearErr } = await clear({ screenshot_path: null }));");
    expect(sweep).toMatch(/\.update\(\{ screenshot_copy: null \}\)\s*\.in\("status", \[\.\.\.BUG_CLOSED_STATUSES\]\)\s*\.lt\("created_at", new Date\(now - BUG_SHOT_AGE_MS\)\.toISOString\(\)\)/);
  });

  it("LATER IS NOT CLOSED: a Later report keeps its picture; closed is fixed or won't fix, in both of the sweep's writes", async () => {
    const sweep = src("src/lib/storage-sweep.ts");
    const { BUG_CLOSED_STATUSES } = await import("@/lib/storage-sweep");
    expect([...BUG_CLOSED_STATUSES]).toEqual(["fixed", "wontfix"]);
    // The file's keep-set: every report that is not closed (open or later) keeps the file it points at.
    expect(sweep).toContain('.not("status", "in", NOT_CLOSED)');
    expect(sweep).not.toContain('.eq("status", "open")');
    expect(sweep).not.toContain('.neq("status", "open")');
  });

  it("the export leaves it out, with its why; the file itself is in the zip", async () => {
    const { OMITTED_COLUMNS, EXPORT_TABLES } = await import("@/lib/export/registry");
    const row = OMITTED_COLUMNS.find((c) => c.table === "bug_reports" && c.column === "screenshot_copy");
    expect(row?.why).toContain("already in the zip");
    expect(EXPORT_TABLES.find((t) => t.table === "bug_reports")?.columns).not.toContain("screenshot_copy");
    expect(src("src/lib/export/records-zip.ts")).toContain('for (const r of rowsOf("bug_reports")) add(DOCUMENTS_BUCKET, r.screenshot_path, "bug_reports", r.id);');
  });
});
