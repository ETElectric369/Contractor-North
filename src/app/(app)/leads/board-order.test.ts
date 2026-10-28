import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LEAD_BOARD_ORDER, compareLeadsForBoard, orderLeadBoard, sortLeadsForBoard } from "@/lib/leads/board-order";

/**
 * NEWEST FIRST ON THE LEADS BOARD (cn-v1137; Bug Watch: "a hand-added lead lands in the middle of
 * the list"). The board sorted the triage's priority first, so a lead typed by hand — priority 0,
 * because createInquiry sets none and 0097 defaults it — sat under every web lead the triage had
 * scored. The order is one rule (lib/leads/board-order) the page's query chains and this test sorts
 * in memory: a priority-0 lead created last is first.
 */
const lead = (over: { id: string; created_at: string; priority?: number; next_follow_up_at?: string | null }) => ({
  next_follow_up_at: null,
  priority: 0,
  ...over,
});

describe("the one order: created_at DESC first, then the follow-up order, then the score", () => {
  it("a hand-added lead (priority 0) created last sorts FIRST, over every scored web lead", () => {
    const rows = [
      lead({ id: "web-hot", created_at: "2026-10-27T09:00:00Z", priority: 68 }),
      lead({ id: "web-warm", created_at: "2026-10-27T15:00:00Z", priority: 23 }),
      lead({ id: "dated", created_at: "2026-10-26T10:00:00Z", next_follow_up_at: "2026-10-29" }),
      lead({ id: "typed-just-now", created_at: "2026-10-28T08:12:00Z", priority: 0 }),
    ];
    expect(sortLeadsForBoard(rows).map((r) => r.id)).toEqual(["typed-just-now", "web-warm", "web-hot", "dated"]);
  });

  it("ties on the moment fall to the follow-up order (undated first, then soonest), then the hotter score", () => {
    const at = "2026-10-28T08:00:00Z";
    const rows = [
      lead({ id: "due-later", created_at: at, next_follow_up_at: "2026-11-03" }),
      lead({ id: "cool", created_at: at, priority: 5 }),
      lead({ id: "due-soon", created_at: at, next_follow_up_at: "2026-10-30" }),
      lead({ id: "hot", created_at: at, priority: 40 }),
    ];
    expect(sortLeadsForBoard(rows).map((r) => r.id)).toEqual(["hot", "cool", "due-soon", "due-later"]);
    expect(compareLeadsForBoard(lead({ id: "a", created_at: at }), lead({ id: "b", created_at: at }))).toBe(0);
  });

  it("the query chains the same keys in the same order, created_at DESC first", () => {
    const calls: [string, { ascending: boolean; nullsFirst?: boolean }][] = [];
    const q = { order(column: string, opts: { ascending: boolean; nullsFirst?: boolean }) { calls.push([column, opts]); return q; } };
    expect(orderLeadBoard(q)).toBe(q);
    expect(calls).toEqual([
      ["created_at", { ascending: false, nullsFirst: undefined }],
      ["next_follow_up_at", { ascending: true, nullsFirst: true }],
      ["priority", { ascending: false, nullsFirst: undefined }],
    ]);
    expect(LEAD_BOARD_ORDER[0]).toEqual({ column: "created_at", ascending: false });
  });

  it("the page reads the open list through the rule, and the old priority-first comment is gone", () => {
    const page = readFileSync(join(process.cwd(), "src/app/(app)/leads/page.tsx"), "utf8");
    expect(page).toContain('import { orderLeadBoard } from "@/lib/leads/board-order";');
    expect(page).toMatch(/orderLeadBoard\(\s*supabase\s*\.from\("inquiries"\)/);
    expect(page).not.toContain('.order("priority"');
    expect(page).not.toContain("Hottest qualified leads first");
  });
});
