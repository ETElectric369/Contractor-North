import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * MY DAY'S AGENDA ROWS: ONE ⋯. Running Late? and Navigate stay on the row; the office's verbs sit
 * behind one 44px ⋯ (the app's one row sheet): a visit's Mark Done, Move To Another Day… and Edit
 * Details…; a job's Move To Another Day… only. Techs get no ⋯. A job's move starts from the ROW's day.
 */
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/planner",
}));
vi.mock("@/components/toast", () => ({ useToast: () => vi.fn() }));
vi.mock("@/components/use-org-public-base", () => ({ useOrgPublicBase: () => "" }));
vi.mock("../schedule/actions", () => ({ moveJobDay: vi.fn() }));
vi.mock("../appointments/actions", () => ({
  rescheduleAppointment: vi.fn(),
  setAppointmentStatus: vi.fn(),
  createAppointment: vi.fn(),
  updateAppointment: vi.fn(),
  deleteAppointment: vi.fn(),
  createJobFromAppointment: vi.fn(),
  createAppointmentProposal: vi.fn(),
}));

import { AgendaRowActions, AgendaRowMenu, markVisitDone, moveJobFromDay, moveVisitToDay } from "./agenda-move";

const code = readFileSync(join(process.cwd(), "src/app/(app)/planner/page.tsx"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/(^|[^:])\/\/.*$/gm, "$1");

const appt = {
  id: "a1",
  type: "inspection",
  title: "Smith walk-through",
  starts_at: "2026-09-28T16:00:00.000Z", // 9:00 AM Pacific
  ends_at: "2026-09-28T17:00:00.000Z",
  job_id: null,
  customer_id: null,
  location: "85 Whitney",
  notes: null,
  assigned_to: null,
};
const opts = { jobs: [], customers: [], staff: [] };

describe("the row's ⋯", () => {
  it("is 44px, and a row with nothing to act on gets none", () => {
    const html = renderToStaticMarkup(createElement(AgendaRowMenu, { title: "Smith walk-through", appt, fromDate: "2026-09-28", ...opts }));
    expect(html).toMatch(/<button type="button" aria-label="More For Smith walk-through"[^>]*class="[^"]*h-11 w-11[^"]*"/);
    // A week-view visit carries no record: no ⋯ rather than an empty sheet.
    expect(renderToStaticMarkup(createElement(AgendaRowMenu, { title: "Visit", fromDate: "2026-09-28", ...opts }))).toBe("");
  });

  it("renders only for staff, and replaces the row's old icon verbs", () => {
    expect(code.match(/<AgendaRowMenu/g)).toHaveLength(1);
    expect(code).toMatch(/\{isStaff && \(i\.appt \|\| i\.jobId\) && \(\s*<AgendaRowMenu/);
    for (const gone of ["ApptDoneButton", "ApptMoveButton", "JobMoveButton", "h-9 w-9 shrink-0"]) expect(code).not.toContain(gone);
    const src = readFileSync(join(process.cwd(), "src/app/(app)/planner/agenda-move.tsx"), "utf8");
    expect(src).not.toContain("rowTrigger");
    // Running Late? and Navigate stay on the row, outside the ⋯.
    const row = code.slice(code.indexOf("const agendaRows"), code.indexOf("<AgendaRowMenu"));
    expect(row).toContain("Running Late?");
    expect(row).toContain("<NavLink address={i.address}");
  });

  it("a job's Move starts from the ROW's day: today in the day view, that day in the week view", () => {
    expect(code).toContain("const agendaRows = (items: Agenda[], day: string) =>");
    expect(code).toContain("fromDate={day}");
    expect(code).toContain("{agendaRows(d.items, d.dayStr)}");
    for (const g of ["earlierAgenda", "nextAgenda", "laterAgenda"]) expect(code).toContain(`{agendaRows(${g}, todayStr)}`);
    expect(code).not.toContain("fromDate={todayStr}");
  });
});

describe("the sheet's rows", () => {
  const render = (props: Record<string, unknown>) =>
    renderToStaticMarkup(createElement(AgendaRowActions, { close: () => {}, fromDate: "2026-09-28", tz: "America/Los_Angeles", ...opts, ...props } as any));

  it("a visit: Mark Done, Move To Another Day…, Edit Details…, in that order, each a 44px row", () => {
    const html = render({ appt });
    const at = ["Mark Done", "Move To Another Day…", "Edit Details…"].map((w) => html.indexOf(`>${w}</button>`));
    expect(at.every((i) => i > 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(html.match(/<button[^>]*class="[^"]*min-h-\[44px\] w-full[^"]*"/g)).toHaveLength(3);
    // The edit is the words, not the pencil.
    expect(html).not.toContain('title="Edit"');
  });

  it("a job: Move To Another Day… only; Done never sits on a job row", () => {
    const html = render({ jobId: "j9" });
    expect(html).toContain(">Move To Another Day…</button>");
    expect(html).not.toMatch(/Done|Edit Details/);
    expect(html.match(/<button/g)).toHaveLength(1);
  });
});

describe("the verbs", () => {
  it("Move on a job row sends the row's day, and asks before withdrawing a customer's date-pick link", async () => {
    const move = vi.fn(async (..._a: unknown[]) => ({ ok: true }));
    const out = await moveJobFromDay("j9", "2026-10-01", "2026-10-05", { move: move as any, confirm: () => true });
    expect(move).toHaveBeenCalledWith("j9", "2026-10-01", "2026-10-05");
    expect(out).toMatchObject({ ok: true, moved: true });

    const blocked = vi.fn(async (_j: string, _f: string, _t: string, o?: { cancelProposals?: boolean }) =>
      o?.cancelProposals ? { ok: true } : { ok: false, needsProposalConfirm: true, error: "A date-pick link is out." },
    );
    const kept = await moveJobFromDay("j9", "2026-10-01", "2026-10-05", { move: blocked as any, confirm: () => false });
    // Declined: nothing moved, said so, and the sheet stays (moved: false).
    expect(kept).toEqual({ ok: true, note: "Job not moved — the customer's date-pick link is still live.", moved: false });
    const withdrawn = await moveJobFromDay("j9", "2026-10-01", "2026-10-05", { move: blocked as any, confirm: () => true });
    expect(blocked).toHaveBeenLastCalledWith("j9", "2026-10-01", "2026-10-05", { cancelProposals: true });
    expect(withdrawn.moved).toBe(true);
  });

  it("Move on a visit keeps its time of day and length, on the company's clock", async () => {
    const reschedule = vi.fn(async (..._a: unknown[]) => ({ ok: true, note: "The customer's pick-a-time link was withdrawn." }));
    const out = await moveVisitToDay(appt, "2026-10-02", "America/Los_Angeles", { reschedule: reschedule as any });
    expect(reschedule).toHaveBeenCalledWith("a1", "2026-10-02T16:00:00.000Z", "2026-10-02T17:00:00.000Z");
    expect(out).toEqual({ ok: true, error: undefined, note: "The customer's pick-a-time link was withdrawn.", moved: true });
    expect(await moveVisitToDay(appt, null, "America/Los_Angeles", { reschedule: reschedule as any })).toMatchObject({ ok: false, moved: false });
  });

  it("Mark Done closes the sheet and says so, and its Undo writes the old status back", async () => {
    const setStatus = vi.fn(async (_id: string, s: string) => (s === "completed" ? { ok: true, previousStatus: "scheduled" } : { ok: true }));
    const toast = vi.fn();
    const close = vi.fn();
    const refresh = vi.fn();
    await markVisitDone("a1", { setStatus: setStatus as any, toast, refresh, close });
    expect(setStatus).toHaveBeenCalledWith("a1", "completed");
    expect(close).toHaveBeenCalledTimes(1);
    const [words, kind, action] = toast.mock.calls[0];
    expect(words).toBe("Done, Off Your Day");
    expect(kind).toBe("success");
    expect(action.label).toBe("Undo");
    action.onClick();
    await vi.waitFor(() => expect(setStatus).toHaveBeenLastCalledWith("a1", "scheduled"));
    await vi.waitFor(() => expect(toast).toHaveBeenLastCalledWith("Back On Your Day", "success"));
  });

  it("a refused Mark Done keeps the sheet open and says why; a withdrawn link is said and kept until read", async () => {
    const toast = vi.fn();
    const close = vi.fn();
    await markVisitDone("a1", { setStatus: vi.fn(async () => ({ ok: false, error: "That appointment didn't change." })) as any, toast, refresh: vi.fn(), close });
    expect(close).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith("That appointment didn't change.", "error");

    const t2 = vi.fn();
    await markVisitDone("a1", {
      setStatus: vi.fn(async () => ({ ok: true, previousStatus: "proposed", note: "The customer's pick-a-time link was withdrawn and can't be un-withdrawn." })) as any,
      toast: t2,
      refresh: vi.fn(),
      close: vi.fn(),
    });
    expect(t2).toHaveBeenCalledWith("The customer's pick-a-time link was withdrawn and can't be un-withdrawn.", "info", undefined, { sticky: true });
  });
});
