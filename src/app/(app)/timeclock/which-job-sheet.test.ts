import { describe, it, expect, vi } from "vitest";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * "WHICH JOB ARE YOU ON?" — the sheet the clock doors open (Erik, 2026-09-26: "yes").
 *
 *   - it appears only after a punch that is saved and on no job (askAfterPunch, the one rule every
 *     door uses), so a clock that knew the job stays two buttons;
 *   - it opens at once on "Finding your jobs…": the clock has already answered, and the list
 *     arrives after (the clock never waits on it);
 *   - each job is one 44px row; "Skip, The Office Will Pick" is always there and writes nothing;
 *   - a tap is the checked write, and anything but a landed write is a plain line;
 *   - job names only, never a price.
 */
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("./which-job-actions", () => ({
  whichJobChoices: vi.fn(async () => ({ ok: true, jobs: [], isStaff: false })),
  putPunchOnJob: vi.fn(async () => ({ ok: true })),
}));
// My Day's Now card punches through the clock's own actions; the tests below only render it.
vi.mock("./actions", () => ({ clockIn: vi.fn(), clockOut: vi.fn() }));

import { WhichJobSheetView, type SheetPhase } from "../planner/which-job";
import { NowCard } from "../planner/now-card";
import { Modal } from "@/components/ui/modal";
import { askAfterPunch, orderWhichJobChoices, pickOutcome, routePick, sheetAfterLoad, whichJobLabel, type WhichJobOption } from "./which-job-choices";

const jobs: WhichJobOption[] = [
  { id: "j28", label: "85 Whitney", why: "Where you worked last" },
  { id: "j30", label: "13631 Northwoods", why: "On today's schedule" },
  { id: "j39", label: "Tahoe Park Heights" },
];

const view = (state: SheetPhase, over: Partial<Parameters<typeof WhichJobSheetView>[0]> = {}) => ({
  moment: "in" as const,
  state,
  onPick: vi.fn(),
  onSkip: vi.fn(),
  ...over,
});
const render = (props: Parameters<typeof WhichJobSheetView>[0]) => renderToStaticMarkup(createElement(WhichJobSheetView, props));

/** The words inside an element tree (strings only; components are read through their props). */
function textOf(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement(node)) return textOf((node.props as { children?: ReactNode }).children);
  return "";
}
/** The clickable element whose words include `label`, found in the tree the view returns (its
 *  children and its pinned footer): the tap is its onClick, called the way React would. */
function clickable(node: ReactNode, label: string): ReactElement<{ onClick: () => void }> | null {
  if (node == null || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const n of node) {
      const hit = clickable(n, label);
      if (hit) return hit;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  const props = node.props as { onClick?: unknown; children?: ReactNode; footer?: ReactNode };
  if (typeof props.onClick === "function" && textOf(props.children).includes(label)) return node as ReactElement<{ onClick: () => void }>;
  return clickable(props.footer, label) ?? clickable(props.children, label);
}

describe("when the sheet appears", () => {
  it("only after a saved punch the clock couldn't put on a job, at clock-in or clock-out", () => {
    expect(askAfterPunch({ ok: true, id: "p1", noJob: true }, "in")).toEqual({ entryId: "p1", moment: "in" });
    expect(askAfterPunch({ ok: true, id: "p1", noJob: true }, "out")).toEqual({ entryId: "p1", moment: "out" });
  });

  it("never when the job was known, the punch was refused, or there is no punch id", () => {
    expect(askAfterPunch({ ok: true, id: "p1" }, "in")).toBeNull();
    expect(askAfterPunch({ ok: true }, "in")).toBeNull();
    expect(askAfterPunch({ ok: true, noJob: true }, "in")).toBeNull();
    expect(askAfterPunch({ ok: false, noJob: true, id: "p1" }, "in")).toBeNull();
    expect(askAfterPunch(null, "out")).toBeNull();
  });
});

describe("the sheet", () => {
  it("opens at once, before its list: the clock already answered, and Skip is there from the start", () => {
    const html = render(view({ phase: "loading" }));
    expect(html).toContain("Which Job Are You On?");
    expect(html).toContain("Finding your jobs…");
    expect(html).toContain("You&#x27;re clocked in.");
    expect(html).toContain("Skip, The Office Will Pick");
  });

  it("lists each job as one 44px row, the likely ones with why, and names only (no price)", () => {
    const html = render(view({ phase: "ready", jobs, isStaff: false }));
    for (const j of jobs) expect(html).toContain(j.label);
    expect(html).toContain("Where you worked last");
    expect(html).toContain("On today&#x27;s schedule");
    const rows = html.match(/<button type="button"[^>]*class="flex min-h-\[44px\] w-full/g) ?? [];
    expect(rows).toHaveLength(jobs.length);
    expect(html).not.toMatch(/\$\d|price|rate|amount/i);
  });

  it("at clock-out it asks about the shift that just closed", () => {
    expect(render(view({ phase: "ready", jobs, isStaff: false }, { moment: "out" }))).toContain(
      "You&#x27;re clocked out, and this punch has no job. Tap the job it was on.",
    );
  });

  it("Skip writes nothing and closes; a row tap picks that job", () => {
    const props = view({ phase: "ready", jobs, isStaff: false });
    const tree = WhichJobSheetView(props);
    clickable(tree, "Skip, The Office Will Pick")!.props.onClick();
    expect(props.onSkip).toHaveBeenCalledTimes(1);
    expect(props.onPick).not.toHaveBeenCalled();
    clickable(tree, "13631 Northwoods")!.props.onClick();
    expect(props.onPick).toHaveBeenCalledWith(jobs[1]);
  });

  it("an empty list says who picks instead (the office for a tech), and a failed load says so", () => {
    expect(render(view({ phase: "ready", jobs: [], isStaff: false }))).toContain("The office puts it on the right job.");
    expect(render(view({ phase: "ready", jobs: [], isStaff: true }))).toContain("from Timecards");
    expect(render(view({ phase: "failed", error: "Couldn't load the jobs just now." }))).toContain("Couldn&#x27;t load the jobs just now.");
  });

  it("nothing to offer, nothing to ask: an empty list closes the sheet with a toast saying where the punch went", () => {
    // A new or idle company (nothing in progress, nothing on today's schedule, nothing punched
    // lately) got a Skip-only modal at clock-in and again at clock-out.
    expect(sheetAfterLoad({ ok: true, jobs: [], isStaff: false }, { confirmInline: false })).toEqual({
      close: true,
      sentence: "No job is going right now, so your punch is saved on no job. The office puts it on the right job.",
    });
    expect(sheetAfterLoad({ ok: true, jobs: [], isStaff: true }, { confirmInline: false })).toEqual({
      close: true,
      sentence: "No job is going right now, so your punch is saved on no job. Put it on its job from Timecards when you know it.",
    });
    // The offline queue's door has no toast: its sheet keeps the sentence, with Skip.
    expect(sheetAfterLoad({ ok: true, jobs: [], isStaff: false }, { confirmInline: true })).toEqual({
      close: false,
      state: { phase: "ready", jobs: [], isStaff: false },
    });
    // A list, or a failed load, is shown as ever.
    expect(sheetAfterLoad({ ok: true, jobs, isStaff: false }, { confirmInline: false })).toEqual({ close: false, state: { phase: "ready", jobs, isStaff: false } });
    expect(sheetAfterLoad({ ok: false, error: "Couldn't load the jobs just now.", isStaff: false }, { confirmInline: false })).toEqual({
      close: false,
      state: { phase: "failed", error: "Couldn't load the jobs just now." },
    });
  });

  it("a refused pick is a plain line; a landed one with no toast to say it is said in the sheet, with Done", () => {
    const refused = render(view({ phase: "ready", jobs, isStaff: false }, { err: "That job is finished." }));
    expect(refused).toContain('role="alert"');
    expect(refused).toContain("That job is finished.");
    const placed = render(view({ phase: "ready", jobs, isStaff: false }, { placed: "Your punch is on 85 Whitney." }));
    expect(placed).toContain("Your punch is on 85 Whitney.");
    expect(placed).toContain(">Done</button>");
    expect(placed).not.toContain("Skip, The Office Will Pick");
  });
});

describe("a tap on a row", () => {
  const job = jobs[0];

  it("saves through the checked write and says where the punch went", async () => {
    const put = vi.fn(async () => ({ ok: true, label: "85 Whitney" }));
    expect(await pickOutcome(put, "p1", job)).toEqual({ kind: "placed", sentence: "Your punch is on 85 Whitney." });
    expect(put).toHaveBeenCalledWith("p1", "j28");
  });

  it("a refusal, a punch that moved, or no connection is a sentence, and the punch stays saved", async () => {
    expect(await pickOutcome(async () => ({ ok: false, error: "That job is finished." }), "p1", job)).toEqual({
      kind: "refused",
      sentence: "That job is finished.",
    });
    expect((await pickOutcome(async () => ({ ok: false, stale: true, error: "Nothing changed." }), "p1", job)).kind).toBe("stale");
    const offline = await pickOutcome(
      async () => {
        throw new Error("fetch failed");
      },
      "p1",
      job,
    );
    expect(offline).toEqual({ kind: "refused", sentence: "No connection, so the punch is still on no job. Try again when you have a bar or two, or skip." });
  });
});

describe("where a pick's answer lands", () => {
  const placed = { kind: "placed", sentence: "Your punch is on 85 Whitney." } as const;
  const stale = { kind: "stale", sentence: "That shift closed a while ago, so the office puts it on its job from Timecards." } as const;
  const refused = { kind: "refused", sentence: "That job is finished." } as const;
  const open = { confirmInline: false, gone: false };

  it("with the sheet up: a landed pick is a toast and the sheet closes; a punch that moved too; a refusal stays on its line", () => {
    expect(routePick(placed, open)).toEqual({ refresh: true, toast: { sentence: placed.sentence, kind: "success" }, inline: null, placed: null, close: true });
    expect(routePick(stale, open)).toEqual({ refresh: true, toast: { sentence: stale.sentence, kind: "error" }, inline: null, placed: null, close: true });
    expect(routePick(refused, open)).toEqual({ refresh: false, toast: null, inline: refused.sentence, placed: null, close: false });
  });

  it("the door with no toast says a landed pick on the sheet, with Done", () => {
    expect(routePick(placed, { confirmInline: true, gone: false })).toMatchObject({ refresh: true, toast: null, placed: placed.sentence, close: false });
    expect(routePick(refused, { confirmInline: true, gone: false })).toMatchObject({ refresh: false, toast: null, inline: refused.sentence, close: false });
  });

  it("a punch that moved underneath refreshes the screen behind at the offline queue's door too: its sentence says the screen is catching up", () => {
    expect(routePick(stale, { confirmInline: true, gone: false })).toEqual({ refresh: true, toast: null, inline: stale.sentence, placed: null, close: false });
  });

  it("closed while the write was out (Back, the X, a tap outside): every answer rides a toast, and nothing closes twice", () => {
    const gone = { confirmInline: false, gone: true };
    // The refusal is the one that used to vanish: it went to the line of a sheet nobody could see.
    expect(routePick(refused, gone)).toEqual({ refresh: false, toast: { sentence: refused.sentence, kind: "error" }, inline: null, placed: null, close: false });
    expect(routePick(stale, gone)).toEqual({ refresh: true, toast: { sentence: stale.sentence, kind: "error" }, inline: null, placed: null, close: false });
    // A second onClose here reopened a crew lead's debrief he had already shut.
    expect(routePick(placed, gone)).toEqual({ refresh: true, toast: { sentence: placed.sentence, kind: "success" }, inline: null, placed: null, close: false });
  });

  it("the door with no toast holds its sheet while a pick is out: the X, a tap outside and Escape wait for the answer", () => {
    const held = WhichJobSheetView(view({ phase: "ready", jobs, isStaff: false }, { busyId: "j28", holdWhileBusy: true })) as ReactElement<{ holdOpen?: boolean }>;
    expect(held.props.holdOpen).toBe(true);
    const idle = WhichJobSheetView(view({ phase: "ready", jobs, isStaff: false }, { holdWhileBusy: true })) as ReactElement<{ holdOpen?: boolean }>;
    expect(idle.props.holdOpen).toBe(false);
    // Every other door has a toast for the answer, so its sheet closes whenever it's asked to.
    const toastDoor = WhichJobSheetView(view({ phase: "ready", jobs, isStaff: false }, { busyId: "j28" })) as ReactElement<{ holdOpen?: boolean }>;
    expect(toastDoor.props.holdOpen).toBe(false);
    const x = (holdOpen: boolean) => {
      const props = { open: true, onClose: () => {}, title: "T", holdOpen, historyClose: false } as Parameters<typeof Modal>[0];
      return renderToStaticMarkup(createElement(Modal, props, "body")).match(/<button[^>]*aria-label="Close"[^>]*>/)![0];
    };
    expect(x(true)).toContain(' disabled=""');
    expect(x(false)).not.toContain(' disabled=""');
  });
});

describe("My Day asks from the same list the clock asked from", () => {
  const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
  const onNoJob = { id: "p1", clock_in: "2026-09-27T14:00:00Z", notes: null, job_id: null };

  it("the Now card on a punch with no job has ONE door, Pick The Job, and it opens the clock's own sheet", () => {
    const html = renderToStaticMarkup(createElement(NowCard, { userId: "u1", open: onNoJob, job: null }));
    expect(html).toContain("Which job are you on?");
    expect(html).toContain("You’re on the clock, but this punch has no job yet.");
    // One door, 44px (the default button is h-11), and no list of its own to fall short of the sheet.
    expect(html.match(/Pick The Job/g)).toHaveLength(1);
    expect(html).toMatch(/<button[^>]*class="[^"]*h-11[^"]*"[^>]*>Pick The Job<\/button>/);
    expect(html).not.toContain("<select");
    expect(html).not.toContain("Put It on the Job");
    const card = src("src/app/(app)/planner/now-card.tsx");
    expect(card).toMatch(/onClick=\{\(\) => setAsk\(\{ entryId: open\.id, moment: "in" \}\)\}>\s*Pick The Job/);
    // The card mounts the sheet once: the same one the clock opens after a punch on no job.
    expect(card.match(/<WhichJobSheet /g)).toHaveLength(1);
    expect(card).not.toContain("/planner#which-job");
  });

  it("the page draws no Which Job block of its own and reads no in-progress-only list for it", () => {
    // A tech helping on a crewmate's job scheduled today found it on the sheet, tapped Skip, and
    // couldn't find it in the page's own shorter list. One list now, the sheet's.
    const page = src("src/app/(app)/planner/page.tsx");
    expect(page).not.toContain("<WhichJob entryId=");
    expect(page).not.toMatch(/\.eq\("status", "in_progress"\)\.order\("created_at"/);
    const block = src("src/app/(app)/planner/which-job.tsx");
    expect(block).not.toMatch(/export function WhichJob\(/);
    // The sheet and its view keep their names and props: Timeclock and the offline queue open it too.
    expect(block).toContain("export function WhichJobSheet({");
    expect(block).toContain("export function WhichJobSheetView({");
    expect(existsSync(join(process.cwd(), "src/app/(app)/planner/my-day-clock.tsx"))).toBe(false);
  });
});

describe("the order, and the label", () => {
  it("each job once, in its first group; finished and other-day jobs are left for the office", () => {
    const out = orderWhichJobChoices({
      jobs: [
        { id: "done", name: "Done", status: "complete" },
        { id: "a", name: "A", status: "in_progress", created_at: "2026-09-01" },
        { id: "a", name: "A", status: "in_progress", created_at: "2026-09-01" },
        { id: "later", name: "Later", status: "scheduled", scheduled_start: "2026-10-05T15:00:00Z" },
      ],
      lastJobId: "done",
      segToday: new Set(),
      hasSegments: new Set(),
      todayStr: "2026-09-26",
      tz: "America/Los_Angeles",
      codesOn: true,
    });
    expect(out).toEqual([{ id: "a", label: "A" }]);
  });

  it("A GAP DAY IS NOT A JOB DAY: a job booked day 1 and day 3 is not on today's schedule on day 2; the job booked today is", () => {
    // Herringbone: 9/18, 9/22 and 9/24, its window mirrored 9/18 8 AM to 9/24 4 PM. Seiler: 9/23 only.
    const herringbone = { id: "herringbone", name: "Herringbone", status: "scheduled", scheduled_start: "2026-09-18T15:00:00Z", scheduled_end: "2026-09-24T23:00:00Z" };
    const seiler = { id: "seiler", name: "Seiler", status: "scheduled", scheduled_start: "2026-09-23T17:00:00Z", scheduled_end: "2026-09-23T19:00:00Z" };
    const base = { jobs: [herringbone, seiler], lastJobId: null, tz: "America/Los_Angeles", codesOn: true };
    // 9/23: Seiler's segment covers it; Herringbone has day rows, none today, so its window is not asked.
    expect(orderWhichJobChoices({ ...base, segToday: new Set(["seiler"]), hasSegments: new Set(["herringbone", "seiler"]), todayStr: "2026-09-23" })).toEqual([
      { id: "seiler", label: "Seiler", why: "On today's schedule" },
    ]);
    // A job with no day rows at all still rides in on its own window.
    expect(orderWhichJobChoices({ ...base, segToday: new Set(), hasSegments: new Set(), todayStr: "2026-09-23" }).map((o) => o.id)).toEqual([
      "herringbone",
      "seiler",
    ]);
  });

  it("codes off, a job reads the way the crew knows it: customer · street", () => {
    const j = { id: "x", name: "Panel swap", address: "85 Whitney", customers: { name: "Nora" } };
    expect(whichJobLabel(j, false)).toBe("Nora · 85 Whitney");
    expect(whichJobLabel(j, true)).toBe("Panel swap");
  });
});
