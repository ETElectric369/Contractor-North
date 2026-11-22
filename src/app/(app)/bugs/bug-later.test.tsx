import { describe, it, expect, vi, beforeEach } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A LATER LIST FOR BUG WATCH (cn-v1175, 0412). The owner: "can we have the bug reports with checked
 * off automatically as they are fixed vs me having to do it so the bug report can always stay current
 * with the newest report only to remove all clutter"; and "go for the later list we might as well
 * build it". An idea or request nobody is building now is filed as Later: NOT OPEN (no count on the
 * door, no line in the digest, no "resolved" to the filer) and NOT CLOSED (its picture stays).
 */
const state = vi.hoisted(() => ({ rpcCalls: [] as unknown[] }));
vi.mock("@/components/toast", () => ({ useToast: () => vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(), createServiceClient: vi.fn() }));
vi.mock("@/lib/site-editor-guard", () => ({ resolveSiteContext: vi.fn() }));
vi.mock("@/lib/platform-admin", () => ({
  requirePlatformAdmin: vi.fn(async () => ({
    userId: "admin",
    supabase: {
      rpc: (fn: string, args: unknown) => {
        state.rpcCalls.push({ fn, args });
        return Promise.resolve({ data: true, error: null });
      },
    },
  })),
}));

import { BugList, TABS } from "./bug-list";
import { setBugReportStatus, type BugReport } from "../bug-report-actions";
import { OPEN_BUGS_FILTER } from "@/lib/bug-watch-count";

const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const R = (o: Partial<BugReport>): BugReport => ({
  id: "b1",
  note: "the Share button did nothing",
  page: "/billing",
  status: "open",
  created_at: "2026-11-20T17:00:00Z",
  reporter: "Sam Tillery",
  screenshot_path: null,
  org: null,
  ...o,
});
const rows = [R({ id: "o1" }), R({ id: "o2", note: "a second open one" }), R({ id: "l1", status: "later", note: "an idea for the price list" }), R({ id: "f1", status: "fixed", note: "fixed already" })];
const render = (initialTab: (typeof TABS)[number]["key"]) => renderToStaticMarkup(createElement(BugList, { initial: rows, initialTab }));
const doorWords = (s: string) => [...s.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((m) => m[1].replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'").trim());

beforeEach(() => {
  state.rpcCalls = [];
});

describe("Bug Watch's Later tab", () => {
  it("sits right after Open, and each says its own count", () => {
    expect(TABS.map((t) => t.label)).toEqual(["Open", "Later", "Fixed", "Won't Fix", "All"]);
    const words = doorWords(render("open"));
    expect(words).toContain("Open (2)");
    expect(words).toContain("Later (1)");
  });

  it("an open report's row has a Later door beside Fixed and Won't", () => {
    const html = render("open");
    expect(html).toContain("the Share button did nothing");
    expect(html).not.toContain("an idea for the price list");
    expect(doorWords(html).filter((w) => w === "Later")).toHaveLength(2); // one per open row
    expect(doorWords(html).filter((w) => w === "Fixed")).toHaveLength(3); // the tab and one per open row
  });

  it("the Later tab lists only Later reports, unstruck, each with Fixed, Won't and Re-open (one tap to close, skeptic #78)", () => {
    const html = render("later");
    expect(html).toContain("an idea for the price list");
    expect(html).not.toContain("the Share button did nothing");
    expect(html).not.toContain("fixed already");
    expect(html).not.toContain("line-through");
    const words = doorWords(html);
    expect(words).toContain("Re-open");
    expect(words.filter((w) => w === "Won't")).toHaveLength(1); // the row's own
    expect(words.filter((w) => w === "Fixed")).toHaveLength(2); // the tab and the row's
    // The row's three doors, in that order, and no Later door on a Later report.
    expect(words.slice(-3)).toEqual(["Fixed", "Won't", "Re-open"]);
    expect(words.filter((w) => w === "Later")).toHaveLength(0);
  });

  it("a closed report keeps Re-open alone", () => {
    const words = doorWords(render("fixed"));
    expect(words.filter((w) => w === "Re-open")).toHaveLength(1);
    expect(words).not.toContain("Won't");
  });

  it("the Later row's doors go through the same setStatus with the page's own statuses", () => {
    const list = src("src/app/(app)/bugs/bug-list.tsx");
    const later = list.slice(list.indexOf(') : st === "later" ? ('), list.indexOf("Re-open\n                    </button>\n                    </>"));
    expect(later).toContain('setStatus(r.id, "fixed")');
    expect(later).toContain('setStatus(r.id, "wontfix")');
    expect(later).toContain('setStatus(r.id, "open")');
  });

  it("an empty Later tab says so in its own words", () => {
    const html = renderToStaticMarkup(createElement(BugList, { initial: [R({})], initialTab: "later" }));
    expect(html).toContain("Nothing for later");
  });
});

describe("the status whitelist takes later, through the one door", () => {
  it("Later, Re-open, and a Later report's Fixed and Won't go through platform_set_bug_status", async () => {
    expect(await setBugReportStatus("l1", "later")).toEqual({ ok: true });
    expect(await setBugReportStatus("l1", "open")).toEqual({ ok: true });
    expect(await setBugReportStatus("l1", "fixed")).toEqual({ ok: true });
    expect(await setBugReportStatus("l1", "wontfix")).toEqual({ ok: true });
    expect(state.rpcCalls).toEqual([
      { fn: "platform_set_bug_status", args: { p_id: "l1", p_status: "later" } },
      { fn: "platform_set_bug_status", args: { p_id: "l1", p_status: "open" } },
      { fn: "platform_set_bug_status", args: { p_id: "l1", p_status: "fixed" } },
      { fn: "platform_set_bug_status", args: { p_id: "l1", p_status: "wontfix" } },
    ]);
  });

  it("a status nobody knows is still refused", async () => {
    expect(await setBugReportStatus("l1", "someday")).toEqual({ ok: false, error: "Unknown status." });
    expect(state.rpcCalls).toEqual([]);
  });
});

describe("LATER IS NOT OPEN: no count, no digest line, no 'your report was resolved'", () => {
  it("the door's count and the Monday digest read open as open or no status, never later", () => {
    expect(OPEN_BUGS_FILTER).toBe("status.is.null,status.eq.open");
    expect(src("src/lib/bug-watch-digest.ts")).toContain('.or(OPEN_BUGS_FILTER), "open bug reports")');
  });

  it("Nort tells the filer only of a report that was fixed or won't be, never one filed for later", () => {
    const updates = src("src/lib/nort/updates.ts");
    expect(updates).toContain('const RESOLVED = ["fixed", "closed", "wontfix"];');
    expect(updates).not.toMatch(/RESOLVED = \[[^\]]*later/);
  });

  it("the assistant writes no status: bug.report files, and there is no resolve", () => {
    expect(src("src/lib/actions/entities/bug.ts")).not.toMatch(/status:\s*["'](later|fixed|wontfix)/);
    expect(src("src/lib/actions/agent-tools.ts")).not.toContain('"bug.resolve"');
  });
});
