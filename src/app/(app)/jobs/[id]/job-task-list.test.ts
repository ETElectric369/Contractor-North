import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * THE JOB'S ONE TASK LIST, AS IT RENDERS (0358). The office and the crew get the same card; every
 * target is 44px; every clickable is Title Case; a task carries no price; a job with no tasks shows
 * just the Add line; the Done fold says who and when in the company's time zone.
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

import { JobTaskList } from "./job-task-list";
import type { JobTaskRow } from "@/lib/job-tasks";

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
  renderToStaticMarkup(createElement(JobTaskList, { ...BASE, viewerId: "u-office", viewerIsStaff: true, mode: "card", ...over } as any));
const tech = (over: Record<string, unknown> = {}) =>
  renderToStaticMarkup(createElement(JobTaskList, { ...BASE, viewerId: "u-brian", viewerIsStaff: false, mode: "card", ...over } as any));

/** Every <button> / <a> / <label> element's visible text. */
const clickables = (html: string) =>
  [...html.matchAll(/<(button|a)\b[^>]*>([\s\S]*?)<\/\1>/g)]
    .map((m) => m[2].replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").trim())
    .filter(Boolean);

describe("the Overview card (mode card)", () => {
  it("the one-line answer, the next three, All Tasks, and the Add line", () => {
    const html = office();
    expect(html).toContain("Tasks: 2 of 7 done");
    for (const t of ["Pull the permit", "Set the meter base", "Run the feeder"]) expect(html).toContain(t);
    for (const t of ["Hang the panel", "Label the circuits"]) expect(html).not.toContain(t);
    expect(html).toContain("+2 more on the Tasks tab");
    expect(html).toMatch(/<a[^>]*href="\?tab=tasks"[^>]*>All Tasks<\/a>/);
    expect(html).toContain('placeholder="Add A Task…"');
    expect(html).toMatch(/>Photo<\/button>|> Photo<\/button>/);
    // The Done fold lives on the Tasks tab, not on the small card.
    expect(html).not.toContain("Walk the site");
  });

  it("the crew gets the same card: same rows, same Add line, same All Tasks", () => {
    const o = office();
    const t = tech();
    for (const s of ["Tasks: 2 of 7 done", "Pull the permit", "All Tasks", "Add A Task", "Photo"]) {
      expect(o).toContain(s);
      expect(t).toContain(s);
    }
  });

  it("a job with no tasks shows just the Add line: no header, no rows, no All Tasks", () => {
    const html = office({ tasks: [], photos: {} });
    expect(html).toContain('placeholder="Add A Task…"');
    expect(html).not.toContain("Tasks:");
    expect(html).not.toContain("All Tasks");
    expect(html).not.toContain("<ul");
  });

  it("a list that couldn't be read says so, never 'no tasks'", () => {
    const html = office({ tasks: [], failed: true });
    expect(html).toContain("Couldn’t read this job’s tasks just now. Reload to try again.");
    expect(html).not.toContain("Add A Task");
  });

  it("a list that couldn't be read gives no count: no 'X of Y done' built from the Buy Materials row alone", () => {
    for (const mode of ["card", "tab"] as const) {
      const html = office({ mode, tasks: [], photos: {}, failed: true, materials: { open: 3 } });
      expect(html).toContain("Couldn’t read this job’s tasks just now. Reload to try again.");
      expect(html).not.toContain("Tasks:");
      // The row is read from the materials list, so it still shows.
      expect(html).toContain("Buy Materials · 3 Open");
      const bought = office({ mode, tasks: [], photos: {}, failed: true, materials: { open: 0 }, doneOpen: true });
      expect(bought).not.toContain("Tasks:");
      expect(bought).not.toMatch(/>\d+ Done</);
    }
  });
});

describe("the Tasks tab (mode tab)", () => {
  it("every open task, the Add line, and the Done fold with its count", () => {
    const html = office({ mode: "tab" });
    for (const t of ["Pull the permit", "Set the meter base", "Run the feeder", "Hang the panel", "Label the circuits"]) {
      expect(html).toContain(t);
    }
    expect(html).toMatch(/>2 Done<svg|>2 Done</);
    expect(html).not.toContain("All Tasks");
  });

  it("before 0358 it says, plainly, what waits for the database update, and draws no photo door", () => {
    const html = office({ mode: "tab", stamps: false });
    expect(html).toContain("Photos on tasks, and who checked each one off, start after the next database update.");
    expect(clickables(html)).not.toContain("Photo");
  });
});

describe("the laws, on every face", () => {
  const faces = [office(), tech(), office({ mode: "tab" }), tech({ mode: "tab" })];

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

  it("Title Case clickables: All Tasks, Add, Photo — never a lowercase verb", () => {
    for (const html of faces) {
      for (const words of clickables(html)) {
        // Task titles are the rows' own words (the crew's typing), not labels.
        if (/^Task |^Pull|^Set|^Run|^Hang|^Label|^Walk|^Order/.test(words)) continue;
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
  it("starts closed on the tab: the count, not the rows", () => {
    const html = office({ mode: "tab" });
    expect(html).not.toContain("Walk the site");
  });

  it("open: who and when in the company's time zone; a pre-0358 row says Done 6/17 and no name", () => {
    for (const html of [office({ mode: "tab", doneOpen: true }), tech({ mode: "tab", doneOpen: true })]) {
      expect(html).toContain("Walk the site");
      expect(html).toContain("Brian · Tue 2:14 PM");
      expect(html).toContain("Order the gear");
      expect(html).toContain("Done 6/17");
      // The quiet, optional photo of the finished work (never required).
      expect(html).toContain("Add Photo");
    }
    // Before 0358 a done row offers no photo door.
    expect(office({ mode: "tab", doneOpen: true, stamps: false })).not.toContain("Add Photo");
  });
});

describe("the live Buy Materials row (Erik, 2026-09-27: open materials create a task)", () => {
  const buyLink = /<a[^>]*href="\?tab=materials"[^>]*>[\s\S]*?Buy Materials · (\d+) Open[\s\S]*?<\/a>/;

  it("leads the card while anything is left to buy, opens the Materials tab, and counts as one task", () => {
    const html = office({ materials: { open: 3 } });
    expect(html).toMatch(buyLink);
    expect(html.match(buyLink)?.[1]).toBe("3");
    // One more task in the count: 7 tasks + the row = 8, and the row is open.
    expect(html).toContain("Tasks: 2 of 8 done");
    // Still three rows on the small card: the row first, then the next two tasks.
    expect(html.indexOf("Buy Materials")).toBeLessThan(html.indexOf("Pull the permit"));
    expect(html).toContain("Set the meter base");
    expect(html).not.toContain("Run the feeder");
    expect(html).toContain("+3 more on the Tasks tab");
  });

  it("is a door, not a checkbox: no one checks it off by hand, the list does", () => {
    const html = office({ tasks: [], photos: {}, materials: { open: 2 } });
    expect(html).not.toMatch(/<input[^>]*type="checkbox"/);
    expect(html).toContain("Tasks: 0 of 1 done");
    expect(html).toMatch(buyLink);
  });

  it("the crew sees the same row (no price on it)", () => {
    const html = tech({ materials: { open: 3 } });
    expect(html).toMatch(buyLink);
    expect(html).not.toMatch(/\$\s?\d/);
  });

  it("gone from the open list once everything is bought; reads All Bought in the tab's Done fold", () => {
    const card = office({ materials: { open: 0 } });
    expect(card).not.toContain("Buy Materials");
    expect(card).toContain("Tasks: 3 of 8 done");
    const tab = office({ mode: "tab", materials: { open: 0 }, doneOpen: true });
    expect(tab).toMatch(/>3 Done<svg|>3 Done</);
    expect(tab).toContain("Buy Materials · All Bought");
  });

  it("no row, and no change to the count, when nothing on the list is to buy", () => {
    const html = office({ materials: null });
    expect(html).not.toContain("Buy Materials");
    expect(html).toContain("Tasks: 2 of 7 done");
  });

  it("keeps the laws: 44px door, Title Case words", () => {
    const html = office({ mode: "tab", materials: { open: 4 } });
    expect(html).toMatch(/<a[^>]*min-h-\[44px\][^>]*href="\?tab=materials"/);
    expect(clickables(html)).toContain("Buy Materials · 4 Open");
  });
});
