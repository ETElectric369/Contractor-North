import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const { reportError } = vi.hoisted(() => ({ reportError: vi.fn() }));
vi.mock("@/lib/observe", () => ({ reportError }));

import { OPEN_BUGS_FILTER, countOpenBugs } from "./bug-watch-count";

/**
 * BUG WATCH COUNTS ITS OWN (NY-list part): one exact head count of the open bug reports, by the Bugs
 * page's own rule, for platform admins only; a failed count is no number and an ops-sink line.
 */
function fakeClient(res: { count: number | null; error: unknown } | "throw") {
  const seen: { table?: string; cols?: string; opts?: unknown; filter?: string } = {};
  const client = {
    from(table: string) {
      seen.table = table;
      return {
        select(cols: string, opts: { count: "exact"; head: true }) {
          seen.cols = cols;
          seen.opts = opts;
          return {
            or(filter: string) {
              seen.filter = filter;
              if (res === "throw") return Promise.reject(new Error("network"));
              return Promise.resolve(res);
            },
          };
        },
      };
    },
  };
  return { client, seen };
}

beforeEach(() => reportError.mockClear());

describe("countOpenBugs", () => {
  it("is one exact HEAD count (no rows come back) of bug_reports that are open or have no status", async () => {
    const { client, seen } = fakeClient({ count: 31, error: null });
    expect(await countOpenBugs(client)).toBe(31);
    expect(seen).toEqual({ table: "bug_reports", cols: "id", opts: { count: "exact", head: true }, filter: "status.is.null,status.eq.open" });
  });

  it("uses the Bugs page's rule: a missing status counts as open (bug-list.tsx), not status = 'open' alone", () => {
    expect(OPEN_BUGS_FILTER).toBe("status.is.null,status.eq.open");
    const list = readFileSync(join(process.cwd(), "src/app/(app)/bugs/bug-list.tsx"), "utf8");
    expect(list).toContain('const statusOf = (r: BugReport) => r.status || "open";');
  });

  it("zero is zero (the menu then shows no number)", async () => {
    expect(await countOpenBugs(fakeClient({ count: 0, error: null }).client)).toBe(0);
  });

  it("a refused or failed count is no number and a line in the ops sink — never a crash, never a false zero", async () => {
    expect(await countOpenBugs(fakeClient({ count: null, error: { message: "permission denied" } }).client)).toBeNull();
    expect(await countOpenBugs(fakeClient("throw").client)).toBeNull();
    expect(reportError).toHaveBeenCalledTimes(2);
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
