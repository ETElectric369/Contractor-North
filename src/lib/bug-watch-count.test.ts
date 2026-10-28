import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const { reportError } = vi.hoisted(() => ({ reportError: vi.fn() }));
vi.mock("@/lib/observe", () => ({ reportError }));

import { NEW_ERRORS_FILTERS, OPEN_BUGS_FILTER, countOpenBugs } from "./bug-watch-count";

/**
 * BUG WATCH COUNTS ITS OWN (NY-list part; the sink since cn-v1136): the SUM of two exact head counts
 * under the viewer's client — the open bug reports by the Bugs page's rule, and the error sink's NEW
 * rows that are not a trace — for platform admins only. Either count failing is no number and an
 * ops-sink line: never a crash, never a false zero, never a half number.
 */
type Answer = { count: number | null; error: unknown } | "throw";
type Seen = { cols?: string; opts?: unknown; or?: string; filters?: [string, string, string][] };

function fakeClient(answers: Record<string, Answer>) {
  const seen: Record<string, Seen> = {};
  const client = {
    from(table: string) {
      const s: Seen = (seen[table] = {});
      const answer = () => {
        const a = answers[table];
        return a === "throw" ? Promise.reject(new Error("network")) : Promise.resolve(a);
      };
      const chain: any = {
        or(filter: string) {
          s.or = filter;
          return answer();
        },
        filter(column: string, operator: string, value: string) {
          (s.filters ??= []).push([column, operator, value]);
          return chain;
        },
        then(onFulfilled: any, onRejected: any) {
          return answer().then(onFulfilled, onRejected);
        },
      };
      return {
        select(cols: string, opts: { count: "exact"; head: true }) {
          s.cols = cols;
          s.opts = opts;
          return chain;
        },
      };
    },
  };
  return { client, seen };
}

const both = (reports: Answer, errors: Answer) => fakeClient({ bug_reports: reports, error_events: errors });

beforeEach(() => reportError.mockClear());

describe("countOpenBugs", () => {
  it("is the SUM of two exact HEAD counts (no rows come back): open reports plus new, non-trace errors", async () => {
    const { client, seen } = both({ count: 31, error: null }, { count: 4, error: null });
    expect(await countOpenBugs(client)).toBe(35);
    expect(seen.bug_reports).toEqual({ cols: "id", opts: { count: "exact", head: true }, or: "status.is.null,status.eq.open" });
    expect(seen.error_events).toEqual({ cols: "id", opts: { count: "exact", head: true }, filters: [["status", "eq", "new"], ["level", "neq", "trace"]] });
  });

  it("uses the Bugs page's rule for a report: a missing status counts as open (bug-list.tsx), not status = 'open' alone", () => {
    expect(OPEN_BUGS_FILTER).toBe("status.is.null,status.eq.open");
    const list = readFileSync(join(process.cwd(), "src/app/(app)/bugs/bug-list.tsx"), "utf8");
    expect(list).toContain('const statusOf = (r: BugReport) => r.status || "open";');
  });

  it("counts an error only while it is NEW and not a trace: triaged is in hand, fixed and ignored are closed, a trace is not work", () => {
    expect(NEW_ERRORS_FILTERS).toEqual([["status", "eq", "new"], ["level", "neq", "trace"]]);
    // Through filter(column, operator, value), not .eq().neq(): the real client's eq and neq make the
    // layout's assignment "excessively deep" (TS2589); filter's plain overload does not. Same SQL.
    const src = readFileSync(join(process.cwd(), "src/lib/bug-watch-count.ts"), "utf8");
    const fn = src.slice(src.indexOf("export async function countOpenBugs"));
    expect(fn).toContain('.from("error_events")');
    expect(fn).toContain(".filter(...NEW_ERRORS_FILTERS[0])");
    expect(fn).toContain(".filter(...NEW_ERRORS_FILTERS[1])");
    expect(fn).not.toMatch(/\.eq\(|\.neq\(/);
    // The sink's list treats new and triaged as open ROWS (they still carry doors), but the badge counts only what wants a first look.
    const list = readFileSync(join(process.cwd(), "src/app/(app)/bugs/error-list.tsx"), "utf8");
    expect(list).toContain('export const isOpenStatus = (status: string) => status === "new" || status === "triaged";');
  });

  it("zero is zero (the menu then shows no number), on both sides", async () => {
    expect(await countOpenBugs(both({ count: 0, error: null }, { count: 0, error: null }).client)).toBe(0);
    expect(await countOpenBugs(both({ count: 0, error: null }, { count: 2, error: null }).client)).toBe(2);
    expect(await countOpenBugs(both({ count: 5, error: null }, { count: 0, error: null }).client)).toBe(5);
    expect(reportError).not.toHaveBeenCalled();
  });

  it("either half failing is no number and a line in the ops sink — never a crash, never a false zero, never a half number", async () => {
    expect(await countOpenBugs(both({ count: null, error: { message: "permission denied" } }, { count: 4, error: null }).client)).toBeNull();
    expect(await countOpenBugs(both({ count: 31, error: null }, { count: null, error: { message: "permission denied" } }).client)).toBeNull();
    expect(await countOpenBugs(both("throw", { count: 4, error: null }).client)).toBeNull();
    expect(await countOpenBugs(both({ count: 31, error: null }, "throw").client)).toBeNull();
    // a count that came back without a number is a failure too, not a zero
    expect(await countOpenBugs(both({ count: 31, error: null }, { count: null, error: null }).client)).toBeNull();
    expect(reportError).toHaveBeenCalledTimes(5);
    expect(reportError.mock.calls.every((c) => c[0] === "app-layout:bug-count")).toBe(true);
  });
});

describe("the layout asks only for a platform admin, and never waits on it", () => {
  const layout = readFileSync(join(process.cwd(), "src/app/(app)/layout.tsx"), "utf8");

  it("counts after isPlatformAdmin resolved, only when it said yes", () => {
    expect(layout).toContain("const bugCount: Promise<number | null> | null = platformAdmin ? countOpenBugs(supabase) : null;");
    // Stage one resolves platformAdmin before the count is asked for.
    expect(layout.indexOf("isPlatformAdmin(supabase),")).toBeLessThan(layout.indexOf("countOpenBugs(supabase)"));
    // Handed on unresolved: nothing in the layout awaits it.
    expect(layout).not.toMatch(/await\s+bugCount|await\s+countOpenBugs/);
  });

  it("hands it through the top bar to the avatar menu's Bug Watch row", () => {
    const topbarLine = layout.split("\n").find((l) => l.includes("<Topbar ")) ?? "";
    expect(topbarLine).toContain("bugCount={bugCount}");
    expect(topbarLine).toContain("features={doors}");
    const bar = readFileSync(join(process.cwd(), "src/components/app-shell/topbar.tsx"), "utf8");
    expect(bar).toContain("bugCount={bugCount}");
    const menu = readFileSync(join(process.cwd(), "src/components/account-menu.tsx"), "utf8");
    expect(menu).toContain("{bugWatchLabel(bugs)}");
    // The count lives inside the pinned Link shape (bug-report-actions.test).
    expect(menu).toMatch(/\{platformAdmin && \(\s*<Link\s+href="\/bugs"[\s\S]{0,400}bugWatchLabel\(bugs\)/);
  });
});
