import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * THE FLAG ON A JOB'S TASK, AS THE TASKS TAB DRAWS IT (cn-v1179). The owner, 2026-11-22: "there are
 * some tasks id like to flag as a reminder to do for certain jobs sometimes [...] so maybe these tasks
 * should go in the needs you under operations instead". Each OPEN row carries the office's toggle
 * (Flag for Needs You / Remove the Flag, in both languages); a tech sees a flagged task's filled mark
 * and never the toggle; a checked-off row carries neither. What the tap stores is pinned against the
 * action itself (tasks/job-task-flag.test.ts); here, what the card draws.
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
  setJobTaskFlag: vi.fn(),
}));
vi.mock("./upload-job-photos", () => ({ uploadJobPhotos: vi.fn() }));
vi.mock("@/app/(app)/materials/actions", () => ({ setMaterialItemPurchased: vi.fn() }));

import { JobTaskList } from "./job-task-list";
import { LangProvider } from "@/components/lang-provider";
import { dict } from "@/lib/i18n";
import type { JobTaskRow } from "@/lib/job-tasks";

const row = (id: string, over: Partial<JobTaskRow> = {}): JobTaskRow => ({
  id,
  title: `Task ${id}`,
  status: "open",
  created_by: "u-office",
  created_at: "2026-11-20T17:00:00Z",
  completed_at: null,
  done_by: null,
  done_by_name: null,
  photo_path: null,
  done_photo_path: null,
  sort_order: 0,
  notes: null,
  ...over,
});

// Larkspur's list: "Print panel labels" flagged, "Hang the panel" not, one checked off (flagged once).
const TASKS = [
  row("t-labels", { title: "Print panel labels" }),
  row("t-panel", { title: "Hang the panel" }),
  row("t-done", { title: "Pull the permit", status: "done", completed_at: "2026-11-21T17:00:00Z" }),
];
const BASE = { jobId: "j1", orgId: "o1", tasks: TASKS, tz: "America/Los_Angeles", nowIso: "2026-11-22T18:00:00Z", stamps: true, doneOpen: true, flaggedIds: ["t-labels", "t-done"] };

const draw = (staff: boolean, lang: "en" | "es" = "en", over: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    createElement(LangProvider, { lang } as any, createElement(JobTaskList, { ...BASE, viewerId: staff ? "u-office" : "u-tech", viewerIsStaff: staff, ...over } as any)),
  );
const toggleOf = (html: string, id: string) => html.match(new RegExp(`<button[^>]*data-flag-toggle="${id}"[^>]*>[\\s\\S]*?</button>`))?.[0] ?? "";
const markOf = (html: string, id: string) => html.match(new RegExp(`<span[^>]*data-flag-mark="${id}"[^>]*>`))?.[0] ?? "";

describe("the flag on the job's Tasks tab", () => {
  it("the office gets a toggle on every OPEN row, pressed when flagged, named for what a tap does", () => {
    const html = draw(true);
    const on = toggleOf(html, "t-labels");
    const off = toggleOf(html, "t-panel");
    expect(on).toContain('aria-pressed="true"');
    expect(on).toContain(`aria-label="${dict("en").jb_btn_removeFlag}"`);
    expect(on).toContain("fill-current");
    expect(off).toContain('aria-pressed="false"');
    expect(off).toContain(`aria-label="${dict("en").jb_btn_flagForNeedsYou}"`);
    expect(off).not.toContain("fill-current");
    // 44px, like every target on the card.
    expect(on).toContain("h-11 w-11");
  });

  it("a checked-off row carries no toggle and no mark, flagged or not (it is on no Needs You)", () => {
    for (const staff of [true, false]) {
      const html = draw(staff);
      expect(toggleOf(html, "t-done")).toBe("");
      expect(markOf(html, "t-done")).toBe("");
    }
  });

  it("a tech sees the filled mark on a flagged task and never a toggle", () => {
    const html = draw(false);
    expect(html).not.toContain("data-flag-toggle");
    expect(markOf(html, "t-labels")).toContain(`aria-label="${dict("en").jb_flaggedMark}"`);
    expect(markOf(html, "t-panel")).toBe("");
  });

  it("speaks Spanish: the toggle's two names and the mark", () => {
    const office = draw(true, "es");
    expect(toggleOf(office, "t-labels")).toContain(`aria-label="${dict("es").jb_btn_removeFlag}"`);
    expect(toggleOf(office, "t-panel")).toContain(`aria-label="${dict("es").jb_btn_flagForNeedsYou}"`);
    expect(markOf(draw(false, "es"), "t-labels")).toContain(`aria-label="${dict("es").jb_flaggedMark}"`);
  });

  it("no flagged ids (or a lost read): nothing is drawn flagged", () => {
    const html = draw(true, "en", { flaggedIds: undefined });
    expect(toggleOf(html, "t-labels")).toContain('aria-pressed="false"');
    expect(markOf(draw(false, "en", { flaggedIds: undefined }), "t-labels")).toBe("");
  });

  it("the words: Title Case on the toggle in both languages, Needs You's own Spanish name, the toast says where it went", () => {
    expect(dict("en").jb_btn_flagForNeedsYou).toBe("Flag for Needs You");
    expect(dict("en").jb_btn_removeFlag).toBe("Remove the Flag");
    expect(dict("es").jb_btn_flagForNeedsYou).toBe("Poner Bandera para Te Necesita");
    expect(dict("es").jb_btn_removeFlag).toBe("Quitar la Bandera");
    expect(dict("es").jb_btn_flagForNeedsYou).toContain(dict("es").md_needsYou);
    expect(dict("en").jb_flaggedToast).toBe("Flagged. It's on Needs You, under Operations.");
    expect(dict("en").jb_unflaggedToast).toBe("Flag removed.");
    expect(dict("es").jb_flaggedToast).toContain(dict("es").md_needsYou);
    expect(dict("es").jb_flaggedToast).toContain(dict("es").ny_btn_tileOperations);
  });
});
