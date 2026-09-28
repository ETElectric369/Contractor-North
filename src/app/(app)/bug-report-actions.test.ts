import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// BUG REPORTS ARE NORTH'S, NOT A COMPANY'S (Wave 0). Every company files (Report A Problem, Nort's
// bug.report); only a platform admin (0176) reads the list or marks one fixed, and another
// company's report is marked through platform_set_bug_status (0354), because 0176's WITH CHECK
// keeps a direct write in the admin's own org.
const state = vi.hoisted(() => ({
  ctx: null as any,
  rpc: { data: true as unknown, error: null as null | { code?: string; message?: string } },
  updated: [] as unknown[],
  rpcCalls: [] as unknown[],
}));
vi.mock("@/lib/platform-admin", () => ({ requirePlatformAdmin: vi.fn(async () => state.ctx) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(), createServiceClient: vi.fn() }));
vi.mock("@/lib/site-editor-guard", () => ({ resolveSiteContext: vi.fn() }));

import { listBugReports, setBugReportStatus } from "./bug-report-actions";

function client() {
  const chain: any = {
    update: () => chain,
    eq: () => chain,
    select: () => Promise.resolve({ data: state.updated, error: null }),
  };
  return {
    rpc: (fn: string, args: unknown) => {
      state.rpcCalls.push({ fn, args });
      return Promise.resolve(state.rpc);
    },
    from: () => chain,
  };
}

beforeEach(() => {
  state.ctx = { supabase: client(), userId: "admin" };
  state.rpc = { data: true, error: null };
  state.updated = [];
  state.rpcCalls = [];
});

describe("the bug list is North's own", () => {
  it("gives a company's owner nothing", async () => {
    state.ctx = { error: "Only North's own team can do that." };
    expect(await listBugReports()).toEqual([]);
  });

  it("refuses a company's Mark Fixed in words", async () => {
    state.ctx = { error: "Only North's own team can do that." };
    expect(await setBugReportStatus("b1", "fixed")).toEqual({ ok: false, error: "Only North's own team can do that." });
    expect(state.rpcCalls).toEqual([]);
  });
});

describe("a platform admin marks any company's report", () => {
  it("through platform_set_bug_status", async () => {
    expect(await setBugReportStatus("b1", "fixed")).toEqual({ ok: true });
    expect(state.rpcCalls).toEqual([{ fn: "platform_set_bug_status", args: { p_id: "b1", p_status: "fixed" } }]);
  });

  it("says so when the report is gone", async () => {
    state.rpc = { data: false, error: null };
    expect(await setBugReportStatus("b1", "fixed")).toMatchObject({ ok: false });
  });

  it("before 0354: its own company's report still marks, another's says why it can't", async () => {
    state.rpc = { data: null, error: { code: "PGRST202", message: "not found" } };
    state.updated = [{ id: "b1" }];
    expect(await setBugReportStatus("b1", "fixed")).toEqual({ ok: true });
    state.updated = [];
    const res = await setBugReportStatus("b2", "fixed");
    expect(res.ok).toBe(false);
    expect(res.error).toContain("another company's report");
  });

  it("never writes a status the page can't show", async () => {
    expect(await setBugReportStatus("b1", "banana")).toEqual({ ok: false, error: "Unknown status." });
    expect(state.rpcCalls).toEqual([]);
  });
});

describe("where the bug doors are", () => {
  const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

  it("Report A Problem mounts for everyone; its list and Mark Fixed are the platform admin's", () => {
    const layout = src("src/app/(app)/layout.tsx");
    expect(layout).not.toContain("isStaff && <BugReporter");
    expect(layout).toContain("<BugReporter orgId={profile.org_id} platformAdmin={platformAdmin} />");
    const reporter = src("src/components/bug-reporter.tsx");
    expect(reporter).toContain('title="Report A Problem"');
    expect(reporter).toContain("{platformAdmin && reports.length > 0 && (");
  });

  it("no company inbox reads bug_reports: North's own triage lives on Bug Watch, with its own count (Wave 1, NY-list)", () => {
    const query = src("src/lib/action-items/query.ts");
    expect(query).not.toContain('.from("bug_reports")');
    expect(query).not.toContain('kind: "bug_report"');
    expect(src("src/lib/action-items/types.ts")).not.toContain('"bug_report"');
  });

  it("company Nort files reports but neither lists nor resolves them", () => {
    expect(src("src/lib/actions/agent-tools.ts")).not.toContain('"bug.resolve"');
    expect(src("src/lib/actions/agent-tools.ts")).toContain('"bug.report"');
    expect(src("src/lib/assistant-tools.ts")).not.toContain("list_bug_reports");
    expect(src("src/app/api/chat/route.ts")).not.toContain("list_bug_reports");
  });

  it("Bug Watch sits in the avatar menu for a platform admin only", () => {
    expect(src("src/components/account-menu.tsx")).toMatch(/\{platformAdmin && \(\s*<Link\s+href="\/bugs"/);
  });
});
