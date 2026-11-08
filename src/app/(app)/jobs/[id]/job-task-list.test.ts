import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * THE JOB'S ONE TASK LIST, AS IT RENDERS (0358, and b7f23be0's one face). The office and the crew get
 * the same card; every target is 44px; every clickable is Title Case; a task carries no price; a job
 * with no tasks shows just the Add line; the Done fold says who and when in the company's time zone.
 *
 * ONE FACE (Erik, 2026-09-30: "show the tasks here, additional steps are unnecessary"). The card had
 * been a three-row summary with a "+2 more on the Tasks tab" line and an All Tasks link; it is the
 * whole list now, the same wherever it is drawn, so these tests render it once and ask nothing about
 * where it sits.
 *
 * THE BUY MATERIALS SUB-ROWS (Erik, 2026-11-07: "show the materials as sub items right there on that
 * screen"): the open lines under the row, each a 44px tap. This harness renders markup and clicks
 * nothing (no DOM library in the repo), so what the tap DOES — the editor's write with (id, list, true),
 * the strike that comes back on a refusal, the Undo — is pinned in lib/materials-checklist's tests
 * against a stub write (tickBuyLine), the way undoCheckOff is; here, what the card DRAWS.
 */
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/jobs/j1",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/components/toast", () => ({ useToast: () => () => {} }));
vi.mock("@/app/(app)/tasks/actions", () => ({
  createTask: vi.fn(),
  toggleTask: vi.fn(),
  deleteTask: vi.fn(),
  updateTask: vi.fn(),
  setTaskDonePhoto: vi.fn(),
}));
vi.mock("./upload-job-photos", () => ({ uploadJobPhotos: vi.fn() }));
vi.mock("@/app/(app)/materials/actions", () => ({ setMaterialItemPurchased: vi.fn() }));

import { JobTaskList } from "./job-task-list";
import { LangProvider } from "@/components/lang-provider";
import type { JobTaskRow } from "@/lib/job-tasks";
import type { BuyLine } from "@/lib/materials-checklist";

const row = (id: string, over: Partial<JobTaskRow> = {}): JobTaskRow => ({
  id,
  title: `Task ${id}`,
  status: "open",
  created_by: "u-office",
  created_at: `2026-09-2${id.length}T17:00:00Z`,
  completed_at: null,
  done_by: null,
  done_by_name: null,
  photo_path: null,
  done_photo_path: null,
  sort_order: 0,
  notes: null,
  ...over,
});

// 5 open (a..e in order) and 2 done: one Brian checked off Tuesday, one from before 0358.
const TASKS: JobTaskRow[] = [
  row("a", { created_at: "2026-09-20T17:00:00Z", title: "Pull the permit", photo_path: "o/j/a.jpg" }),
  row("b", { created_at: "2026-09-20T17:01:00Z", title: "Set the meter base" }),
  row("c", { created_at: "2026-09-20T17:02:00Z", title: "Run the feeder" }),
  row("d", { created_at: "2026-09-20T17:03:00Z", title: "Hang the panel" }),
  row("e", { created_at: "2026-09-20T17:04:00Z", title: "Label the circuits" }),
  row("f", { status: "done", title: "Walk the site", completed_at: "2026-09-22T21:14:00Z", done_by: "u-brian", done_by_name: "Brian Smith" }),
  row("g", { status: "done", title: "Order the gear", completed_at: "2026-06-17T18:00:00Z" }),
];
const BASE = {
  jobId: "j1",
  orgId: "o1",
  tasks: TASKS,
  photos: { a: { task: { url: "https://x.test/a.jpg" }, done: null } },
  tz: "America/Los_Angeles",
  nowIso: "2026-09-26T19:00:00Z",
  stamps: true,
};
const office = (over: Record<string, unknown> = {}) =>
  renderToStaticMarkup(createElement(JobTaskList, { ...BASE, viewerId: "u-office", viewerIsStaff: true, ...over } as any));
const tech = (over: Record<string, unknown> = {}) =>
  renderToStaticMarkup(createElement(JobTaskList, { ...BASE, viewerId: "u-brian", viewerIsStaff: false, ...over } as any));
/** The crew's face in Spanish (the provider is a plain context here; its document effect never runs). */
const techEs = (over: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    createElement(LangProvider, { lang: "es" } as any, createElement(JobTaskList, { ...BASE, viewerId: "u-brian", viewerIsStaff: false, ...over } as any)),
  );

/** The live row the way the job page hands it (lib/materials-checklist buyMaterials). */
const buy = (open: number, lines: BuyLine[] = []) => ({ open, lines });
/** Two open lines, the way TECH_ITEM_COLUMNS reads them: no price, no vendor. */
const LINES: BuyLine[] = [
  { id: "m1", list_id: "L1", description: "12/2 Romex", quantity: 250, unit: "ft" },
  { id: "m2", list_id: "L1", description: "Wire Nuts", quantity: 2, unit: "ea" },
];
/** A sub-row: the button that buys the line, found by its aria. */
const subRow = (html: string, aria: string) => html.match(new RegExp(`<button[^>]*aria-label="${aria.replace(/[/]/g, "\\/")}"[^>]*>[\\s\\S]*?<\\/button>`))?.[0] ?? "";

/** Every <button> / <a> / <label> element's visible text. */
const clickables = (html: string) =>
  [...html.matchAll(/<(button|a)\b[^>]*>([\s\S]*?)<\/\1>/g)]
    .map((m) => m[2].replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").trim())
    .filter(Boolean);

describe("the one list: the one-line answer, every open task, the Add line, the Done fold", () => {
  it("every open task is on it — no three-row cap, no '+N more', no All Tasks link to tap", () => {
    const html = office();
    expect(html).toContain("Tasks: 2 of 7 done");
    for (const t of ["Pull the permit", "Set the meter base", "Run the feeder", "Hang the panel", "Label the circuits"]) {
      expect(html).toContain(t);
    }
    expect(html).not.toContain("more on the Tasks tab");
    expect(html).not.toContain("All Tasks");
    expect(html).toContain('placeholder="Add a Task…"');
    expect(html).toMatch(/>Photo<\/button>|> Photo<\/button>/);
    // The Done fold is here too, closed: the count, not the rows.
    expect(html).toMatch(/>2 Done<svg|>2 Done</);
    expect(html).not.toContain("Walk the site");
  });

  it("the crew gets the same list: same rows, same Add line, same fold", () => {
    const o = office();
    const t = tech();
    for (const s of ["Tasks: 2 of 7 done", "Pull the permit", "Label the circuits", "Add a Task", "Photo", "2 Done"]) {
      expect(o).toContain(s);
      expect(t).toContain(s);
    }
  });

  it("a job with no tasks shows just the Add line: no header, no rows, no fold", () => {
    const html = office({ tasks: [], photos: {} });
    expect(html).toContain('placeholder="Add a Task…"');
    expect(html).not.toContain("Tasks:");
    expect(html).not.toMatch(/>\d+ Done</);
    expect(html).not.toContain("<ul");
  });

  it("a list that couldn't be read says so, never 'no tasks'", () => {
    const html = office({ tasks: [], failed: true });
    expect(html).toContain("Couldn’t read this job’s tasks just now. Reload to try again.");
    expect(html).not.toContain("Add a Task");
  });

  it("a list that couldn't be read gives no count: no 'X of Y done' built from the Buy Materials row alone", () => {
    const html = office({ tasks: [], photos: {}, failed: true, materials: buy(3) });
    expect(html).toContain("Couldn’t read this job’s tasks just now. Reload to try again.");
    expect(html).not.toContain("Tasks:");
    // The row is read from the materials list, so it still shows.
    expect(html).toContain("Buy Materials · 3 Open");
    const bought = office({ tasks: [], photos: {}, failed: true, materials: buy(0), doneOpen: true });
    expect(bought).not.toContain("Tasks:");
    expect(bought).not.toMatch(/>\d+ Done</);
  });

  it("before 0358 it says, plainly, what waits for the database update, and draws no photo door", () => {
    const html = office({ stamps: false });
    expect(html).toContain("Photos on tasks, and who checked each one off, start after the next database update.");
    expect(clickables(html)).not.toContain("Photo");
  });
});

describe("the laws, on every face", () => {
  const faces = [office(), tech(), office({ doneOpen: true }), tech({ doneOpen: true }), office({ materials: buy(2, LINES) }), techEs({ materials: buy(2, LINES) })];

  it("no prices: nothing with a dollar sign reaches a task list", () => {
    for (const html of faces) expect(html).not.toMatch(/\$\s?\d/);
  });

  it("44px targets: every checkbox wraps in an h-11 w-11 label, every row button is min-h-[44px]", () => {
    for (const html of faces) {
      const boxes = html.match(/<input[^>]*type="checkbox"/g) ?? [];
      const labels = html.match(/<label class="flex h-11 w-11/g) ?? [];
      expect(boxes.length).toBeGreaterThan(0);
      expect(labels.length).toBe(boxes.length);
      for (const b of html.match(/<button[^>]*>/g) ?? []) expect(b, b).toMatch(/h-11|min-h-\[44px\]/);
      for (const a of html.match(/<a [^>]*>/g) ?? []) expect(a, a).toMatch(/min-h-\[44px\]/);
    }
  });

  it("Title Case clickables: Add, Photo, Buy Materials — never a lowercase verb", () => {
    for (const html of faces) {
      for (const words of clickables(html)) {
        // Task titles and materials lines are the rows' own words (the crew's typing), not labels.
        if (/^Task |^Pull|^Set|^Run|^Hang|^Label|^Walk|^Order|^12\/2 Romex|^Wire Nuts/.test(words)) continue;
        for (const w of words.split(/\s+/)) if (/^[a-z]/.test(w)) throw new Error(`"${words}" isn't Title Case`);
      }
    }
  });

  it("a photo is a 44px thumbnail that opens it; a deleted one says Photo removed", () => {
    expect(office()).toMatch(/<button[^>]*aria-label="Photo for Pull the permit"[^>]*h-11 w-11/);
    const gone = office({ photos: { a: { task: "removed", done: null } } });
    expect(gone).toContain("Photo removed");
  });
});

describe("the Done fold", () => {
  it("starts closed: the count, not the rows", () => {
    expect(office()).not.toContain("Walk the site");
  });

  it("open: who and when in the company's time zone; a pre-0358 row says Done 6/17 and no name", () => {
    for (const html of [office({ doneOpen: true }), tech({ doneOpen: true })]) {
      expect(html).toContain("Walk the site");
      expect(html).toContain("Brian · Tue 2:14 PM");
      expect(html).toContain("Order the gear");
      expect(html).toContain("Done 6/17");
      // The quiet, optional photo of the finished work (never required).
      expect(html).toContain("Add Photo");
    }
    // Before 0358 a done row offers no photo door.
    expect(office({ doneOpen: true, stamps: false })).not.toContain("Add Photo");
  });
});

describe("the live Buy Materials row (Erik, 2026-09-27: open materials create a task)", () => {
  const buyLink = /<a[^>]*href="\?tab=materials"[^>]*>[\s\S]*?Buy Materials · (\d+) Open[\s\S]*?<\/a>/;

  it("leads the list while anything is left to buy, opens the Materials tab, and counts as one task", () => {
    const html = office({ materials: buy(3) });
    expect(html).toMatch(buyLink);
    expect(html.match(buyLink)?.[1]).toBe("3");
    // One more task in the count: 7 tasks + the row = 8, and the row is open.
    expect(html).toContain("Tasks: 2 of 8 done");
    // It leads, and it pushes nothing off: every open task is still under it.
    expect(html.indexOf("Buy Materials")).toBeLessThan(html.indexOf("Pull the permit"));
    for (const t of ["Set the meter base", "Run the feeder", "Hang the panel", "Label the circuits"]) expect(html).toContain(t);
    expect(html).not.toContain("more on the Tasks tab");
  });

  it("is a door, not a checkbox: no one checks it off by hand, the list does", () => {
    const html = office({ tasks: [], photos: {}, materials: buy(2, LINES) });
    expect(html).not.toMatch(/<input[^>]*type="checkbox"/);
    expect(html).toContain("Tasks: 0 of 1 done");
    expect(html).toMatch(buyLink);
  });

  it("the crew sees the same row (no price on it)", () => {
    const html = tech({ materials: buy(3) });
    expect(html).toMatch(buyLink);
    expect(html).not.toMatch(/\$\s?\d/);
  });

  it("gone from the open list once everything is bought; reads All Bought in the Done fold", () => {
    const closed = office({ materials: buy(0) });
    expect(closed).toContain("Tasks: 3 of 8 done");
    expect(closed).toMatch(/>3 Done<svg|>3 Done</);
    // Closed fold: the row is inside it, not on the open list.
    expect(closed).not.toContain("Buy Materials");
    const open = office({ materials: buy(0), doneOpen: true });
    expect(open).toContain("Buy Materials · All Bought");
  });

  it("no row, and no change to the count, when nothing on the list is to buy", () => {
    const html = office({ materials: null });
    expect(html).not.toContain("Buy Materials");
    expect(html).toContain("Tasks: 2 of 7 done");
  });

  it("keeps the laws: 44px door, Title Case words", () => {
    const html = office({ materials: buy(4) });
    expect(html).toMatch(/<a[^>]*min-h-\[44px\][^>]*href="\?tab=materials"/);
    expect(clickables(html)).toContain("Buy Materials · 4 Open");
  });
});

describe("the open lines under the row (Erik, 2026-11-07: the materials as sub items right there)", () => {
  it("each open line is a sub-row under the row, in the row's own li, above the tasks, with its words", () => {
    const html = office({ materials: buy(2, LINES) });
    expect(html).toContain("Buy Materials · 2 Open");
    expect(html).toContain("12/2 Romex · 250 ft");
    expect(html).toContain("Wire Nuts · 2 ea");
    // Under the row's door, in its order, and above the first task.
    expect(html.indexOf("Buy Materials · 2 Open")).toBeLessThan(html.indexOf("12/2 Romex"));
    expect(html.indexOf("12/2 Romex")).toBeLessThan(html.indexOf("Wire Nuts"));
    expect(html.indexOf("Wire Nuts")).toBeLessThan(html.indexOf("Pull the permit"));
    // The row's li holds the door and then the lines: the nested list opens right after the door's
    // </a> and closes with the row's own </li>, the two lines inside it.
    const nested = html.match(/<\/a><ul class="pb-1">([\s\S]*?)<\/ul><\/li>/);
    expect(nested, html).not.toBeNull();
    expect(nested![1]).toContain("12/2 Romex · 250 ft");
    expect(nested![1]).toContain("Wire Nuts · 2 ea");
    expect(nested![1].match(/<li>/g)?.length).toBe(2);
    // Still one task in the count: the lines are the row's, not tasks of their own.
    expect(html).toContain("Tasks: 2 of 8 done");
  });

  it("a sub-row is a 44px button, indented past the row's icon, behind an empty circle, named by what a tap does", () => {
    const html = office({ materials: buy(2, LINES) });
    const row = subRow(html, "Bought: 12/2 Romex");
    expect(row, html).not.toBe("");
    expect(row).toMatch(/<button type="button"/);
    expect(row).toContain("min-h-[44px]");
    expect(row).toContain("pl-14");
    expect(row).toContain("lucide-circle ");
    expect(row).not.toContain("line-through");
    expect(subRow(html, "Bought: Wire Nuts")).toContain("Wire Nuts · 2 ea");
    // Not struck until a tap: no filled check anywhere on the card.
    expect(html).not.toMatch(/lucide-circle-check|lucide-check-circle/);
  });

  it("the crew gets the same sub-rows, no price on them; in Spanish the tap is named in Spanish and the line's words are the list's", () => {
    const en = tech({ materials: buy(2, LINES) });
    expect(subRow(en, "Bought: 12/2 Romex")).not.toBe("");
    expect(en).not.toMatch(/\$\s?\d/);
    const es = techEs({ materials: buy(2, LINES) });
    expect(subRow(es, "Comprado: 12/2 Romex")).toContain("12/2 Romex · 250 ft");
    expect(subRow(es, "Comprado: Wire Nuts")).toContain("Wire Nuts · 2 ea");
    expect(es).not.toContain("Bought:");
  });

  it("no sub-rows in the Done fold (All Bought carries no lines), and none when the row has none to carry", () => {
    const fold = office({ materials: buy(0, LINES), doneOpen: true });
    expect(fold).toContain("Buy Materials · All Bought");
    expect(fold).not.toContain("12/2 Romex");
    expect(fold).not.toContain("<ul class=\"pb-1\"");
    const bare = office({ materials: buy(3) });
    expect(bare).toContain("Buy Materials · 3 Open");
    expect(bare).not.toContain("<ul class=\"pb-1\"");
  });

  it("still a door, not a checkbox: the lines are buttons; the row's Link to the whole list stays", () => {
    const html = office({ tasks: [], photos: {}, materials: buy(2, LINES) });
    expect(html).not.toMatch(/<input[^>]*type="checkbox"/);
    expect(html).toMatch(/<a[^>]*href="\?tab=materials"/);
    expect(html.match(/<button type="button" aria-label="Bought: /g)?.length).toBe(2);
    expect(html).toContain("Tasks: 0 of 1 done");
  });
});
