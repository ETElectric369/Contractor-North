import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  putBackPlan,
  somethingCaptured,
  wontHappenConfirm,
  wontHappenToast,
  wontHappenUndo,
  wontHappenVerdict,
} from "@/lib/appointments/wont-happen";

/**
 * WON'T HAPPEN (W2-11): the visit page's one door for a visit that isn't going ahead. DELETED only
 * when nothing is on it, nothing was written from it, nothing points at it and no customer is
 * holding a pick-a-time link; otherwise CANCELLED, everything kept, with Undo. And a cancelled visit
 * can go back on the schedule.
 */
type Row = Record<string, unknown>;
const s = vi.hoisted(() => ({
  row: null as null | Row,
  answers: {} as unknown,
  answersError: null as null | { code: string; message: string },
  invoices: 0,
  links: 0,
  deleteHits: 1,
  updateHits: 1,
  gone: false,
  deletes: [] as { table: string; filters: unknown[][] }[],
  updates: [] as { table: string; patch: Row; filters: unknown[][] }[],
  calendar: [] as string[],
}));

function builder(table: string) {
  const filters: unknown[][] = [];
  let op: "select" | "update" | "delete" = "select";
  let head = false;
  let patch: Row | null = null;
  const run = () => {
    if (table === "organizations") return { data: { settings: { timezone: "America/Los_Angeles" } }, error: null };
    if (table === "appointment_answers") return s.answersError ? { data: null, error: s.answersError } : { data: { inspection_answers: s.answers }, error: null };
    if (op === "delete") {
      s.deletes.push({ table, filters });
      return { data: Array.from({ length: s.deleteHits }, () => ({ id: "a1" })), error: null };
    }
    if (op === "update") {
      s.updates.push({ table, patch: patch!, filters });
      if (table === "schedule_proposals") return { data: Array.from({ length: s.links }, (_, i) => ({ id: `p${i}` })), error: null };
      return { data: Array.from({ length: s.updateHits }, () => ({ id: "a1" })), error: null };
    }
    if (head) return { data: null, count: table === "invoices" ? s.invoices : s.links, error: null };
    if (table === "appointments") return { data: s.gone ? null : s.row, error: null };
    return { data: null, error: null };
  };
  const b: any = {
    select: (_cols?: string, opts?: { head?: boolean }) => ((head = !!opts?.head), b),
    update: (p: Row) => ((op = "update"), (patch = p), b),
    delete: () => ((op = "delete"), b),
    maybeSingle: async () => run(),
    single: async () => run(),
    then: (ok: (v: unknown) => unknown) => Promise.resolve(run()).then(ok),
  };
  for (const m of ["eq", "in", "is", "neq", "order", "limit"]) b[m] = (...a: unknown[]) => (filters.push([m, ...a]), b);
  return b;
}
const client = { from: (t: string) => builder(t), auth: { getUser: async () => ({ data: { user: { id: "office-1" } } }) } };

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => client), createServiceClient: vi.fn(() => client) }));
vi.mock("@/lib/staff-guard", () => ({
  requireStaff: vi.fn(async () => ({ supabase: client, userId: "office-1", orgId: "org-1" })),
  requireMember: vi.fn(async () => ({ supabase: client, userId: "office-1", orgId: "org-1" })),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("@/lib/calendar-sync", () => ({
  pushCalendarItem: vi.fn(async (_k: string, id: string) => void s.calendar.push(`push:${id}`)),
  deleteCalendarItem: vi.fn(async (_k: string, id: string) => void s.calendar.push(`delete:${id}`)),
}));
vi.mock("@/lib/notifications", () => ({ notifyPeople: vi.fn(async () => ({ bell: true, pushed: [] })) }));
vi.mock("@/lib/push", () => ({ sendPushToProfiles: vi.fn(async () => {}) }));

const { wontHappenAppointment, putVisitBackOnSchedule } = await import("./actions");

const row = (over: Row = {}): Row => ({
  id: "a1",
  status: "scheduled",
  capture: null,
  updated_at: "2026-09-28T16:00:00.000000+00:00",
  starts_at: "2026-10-01T16:00:00.000Z",
  ...over,
});

beforeEach(() => {
  s.row = row();
  s.answers = {};
  s.answersError = null;
  s.invoices = 0;
  s.links = 0;
  s.deleteHits = 1;
  s.updateHits = 1;
  s.gone = false;
  s.deletes = [];
  s.updates = [];
  s.calendar = [];
});

const statusWrites = () => s.updates.filter((u) => u.table === "appointments").map((u) => u.patch.status);

describe("Won't Happen deletes only a visit with nothing on it", () => {
  it("nothing captured, nothing written from it, nothing pointing at it: deleted (Google first), and only the row as it was read", async () => {
    expect(await wontHappenAppointment("a1")).toEqual({ ok: true, did: "deleted" });
    expect(s.calendar).toEqual(["delete:a1"]);
    expect(s.deletes).toHaveLength(1);
    expect(s.deletes[0].filters).toContainEqual(["eq", "updated_at", "2026-09-28T16:00:00.000000+00:00"]);
    expect(s.deletes[0].filters).toContainEqual(["eq", "status", "scheduled"]);
    expect(statusWrites()).toEqual([]);
  });

  it("notes: cancelled, with the previous status for Undo, nothing deleted", async () => {
    s.row = row({ capture: { notes: "Panel is behind the water heater" } });
    expect(await wontHappenAppointment("a1")).toEqual({ ok: true, did: "cancelled", previousStatus: "scheduled" });
    expect(s.deletes).toEqual([]);
    expect(statusWrites()).toEqual(["cancelled"]);
  });

  it("photos, items or measures: cancelled", async () => {
    for (const capture of [{ photos: ["org-1/appointments/a1/p.jpg"] }, { items: [{ description: "3 boxes" }] }, { measures: [{ label: "Deck", value: 12 }] }]) {
      s.updates = [];
      s.row = row({ capture });
      expect(await wontHappenAppointment("a1"), JSON.stringify(capture)).toMatchObject({ ok: true, did: "cancelled" });
    }
    expect(s.deletes).toEqual([]);
  });

  it("an answer on the sheet (read through the view): cancelled; an unreadable sheet counts as something there", async () => {
    s.answers = { work_type: "Lighting" };
    expect(await wontHappenAppointment("a1")).toMatchObject({ did: "cancelled" });
    s.answers = {};
    s.answersError = { code: "42501", message: "permission denied" };
    expect(await wontHappenAppointment("a1")).toMatchObject({ did: "cancelled" });
    expect(s.deletes).toEqual([]);
  });

  it("an estimate written from it (capture.quote_id): cancelled", async () => {
    s.row = row({ capture: { quote_id: "q-1" } });
    expect(await wontHappenAppointment("a1")).toMatchObject({ ok: true, did: "cancelled" });
    expect(s.deletes).toEqual([]);
  });

  it("an invoice points at it: cancelled, never deleted (the bill would lose its visit)", async () => {
    s.invoices = 1;
    expect(await wontHappenAppointment("a1")).toMatchObject({ ok: true, did: "cancelled" });
    expect(s.deletes).toEqual([]);
  });

  it("a pick-a-time link is waiting: cancelled, the link withdrawn, and said", async () => {
    s.row = row({ status: "proposed" });
    s.links = 1;
    const res = await wontHappenAppointment("a1");
    expect(res).toMatchObject({ ok: true, did: "cancelled", previousStatus: "proposed" });
    expect(res.note).toBe("The customer's pick-a-time link was withdrawn and can't be un-withdrawn.");
    expect(s.updates.some((u) => u.table === "schedule_proposals" && u.patch.status === "cancelled")).toBe(true);
    expect(s.deletes).toEqual([]);
  });

  it("a save that slipped in after the read: the delete lands on nothing, so it is cancelled instead", async () => {
    s.deleteHits = 0;
    expect(await wontHappenAppointment("a1")).toMatchObject({ ok: true, did: "cancelled" });
    expect(statusWrites()).toEqual(["cancelled"]);
  });

  it("a zero-row write is an error, never 'done'", async () => {
    s.row = row({ capture: { notes: "x" } });
    s.updateHits = 0;
    const res = await wontHappenAppointment("a1");
    expect(res.ok).toBe(false);
    expect(res.error).toBe("That appointment didn't change — reload and check it still exists.");
  });

  it("a visit that is gone is said", async () => {
    s.gone = true;
    expect(await wontHappenAppointment("a1")).toEqual({ ok: false, error: "That visit isn't there any more. Reload to see the schedule as it is." });
  });

  it("a visit that happened (Done) is refused in words; one already cancelled is said", async () => {
    s.row = row({ status: "completed" });
    const done = await wontHappenAppointment("a1");
    expect(done.ok).toBe(false);
    expect(done.error).toContain("marked Done");
    s.row = row({ status: "cancelled" });
    expect(await wontHappenAppointment("a1")).toEqual({ ok: false, error: "This visit is already marked Cancelled." });
    expect(s.deletes).toEqual([]);
    expect(s.updates).toEqual([]);
  });
});

describe("Put It Back On The Schedule", () => {
  // Today, on the company's clock, as the action sees it.
  const tz = "America/Los_Angeles";
  const ymd = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toLocaleDateString("en-CA", { timeZone: tz });

  it("a day still ahead keeps its day", async () => {
    s.row = row({ status: "cancelled", starts_at: `${ymd(3)}T17:00:00.000Z` });
    const res = await putVisitBackOnSchedule("a1");
    expect(res.ok).toBe(true);
    expect(res.message).toMatch(/^Back on the schedule for [A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2}\.$/);
    const w = s.updates.find((u) => u.table === "appointments")!;
    expect(w.patch.status).toBe("scheduled");
    expect("starts_at" in w.patch).toBe(false);
    expect(w.filters).toContainEqual(["eq", "status", "cancelled"]);
    expect(s.calendar).toEqual(["push:a1"]);
  });

  it("a day that has passed comes back waiting for a day (date cleared), and says which day had passed", async () => {
    s.row = row({ status: "cancelled", starts_at: `${ymd(-5)}T17:00:00.000Z` });
    const res = await putVisitBackOnSchedule("a1");
    expect(res.ok).toBe(true);
    expect(res.message).toMatch(/^Back on the schedule, waiting for a day: [A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2} had passed\.$/);
    expect(s.updates.find((u) => u.table === "appointments")!.patch).toMatchObject({ status: "scheduled", starts_at: null, ends_at: null });
  });

  it("only a cancelled visit", async () => {
    s.row = row({ status: "scheduled" });
    expect(await putVisitBackOnSchedule("a1")).toEqual({ ok: false, error: "Only a cancelled visit can go back on the schedule." });
    expect(s.updates).toEqual([]);
  });
});

describe("the rule, pure", () => {
  const facts = { capture: null, answers: {}, invoiceCount: 0, pendingLinks: 0 };

  it("deletes only when all four hold; anything unread is 'something there'", () => {
    expect(wontHappenVerdict(facts)).toBe("delete");
    expect(wontHappenVerdict({ ...facts, answers: { a: null, b: "", c: [] } })).toBe("delete"); // blank answers say nothing
    expect(wontHappenVerdict({ ...facts, answers: { a: "Yes" } })).toBe("cancel");
    expect(wontHappenVerdict({ ...facts, capture: { quote_id: "q1" } })).toBe("cancel");
    expect(wontHappenVerdict({ ...facts, invoiceCount: 2 })).toBe("cancel");
    expect(wontHappenVerdict({ ...facts, pendingLinks: 1 })).toBe("cancel");
    expect(wontHappenVerdict({ ...facts, invoiceCount: null })).toBe("cancel");
    expect(wontHappenVerdict({ ...facts, pendingLinks: null })).toBe("cancel");
    expect(wontHappenVerdict({ ...facts, answersUnread: true })).toBe("cancel");
    expect(somethingCaptured({ notes: "   " }, {})).toBe(false);
  });

  it("the words: the confirm says which, the toast repeats the server's verdict", () => {
    expect(wontHappenConfirm("delete")).toBe("This visit won't happen? Nothing was captured on it, so it will be deleted.");
    expect(wontHappenConfirm("cancel")).toBe("This visit won't happen? Its notes, photos and answers stay on file, marked Cancelled.");
    expect(wontHappenToast("deleted")).toBe("Deleted. Nothing was on it.");
    expect(wontHappenToast("cancelled")).toBe("Marked Cancelled. Everything on it stays on file.");
    expect(wontHappenToast("cancelled", "The customer's pick-a-time link was withdrawn and can't be un-withdrawn.")).toBe(
      "Marked Cancelled. Everything on it stays on file. The customer's pick-a-time link was withdrawn and can't be un-withdrawn.",
    );
  });

  it("Undo restores the previous status, except a visit that was waiting on a pick comes back Scheduled and says the link stays withdrawn", () => {
    expect(wontHappenUndo("scheduled")).toEqual({ status: "scheduled", note: null });
    expect(wontHappenUndo("proposed")).toEqual({ status: "scheduled", note: "The pick-a-time link stays withdrawn — send a new one." });
  });

  it("put back: today counts as still ahead", () => {
    expect(putBackPlan("2026-10-01", "2026-10-01")).toEqual({ keepDay: true, message: "Back on the schedule for Thu Oct 1." });
    expect(putBackPlan("2026-09-20", "2026-10-01")).toEqual({ keepDay: false, message: "Back on the schedule, waiting for a day: Sun Sep 20 had passed." });
    expect(putBackPlan(null, "2026-10-01")).toEqual({ keepDay: false, message: "Back on the schedule, waiting for a day." });
  });
});

describe("the visit page's header: at most one main button, then ⋯", () => {
  const page = readFileSync(join(process.cwd(), "src/app/(app)/appointments/[id]/page.tsx"), "utf8");
  const rows = readFileSync(join(process.cwd(), "src/app/(app)/appointments/[id]/visit-header-actions.tsx"), "utf8");

  it("Get Paid on a work visit, Mark Walk-Through Done on a booked walk-through, none otherwise", () => {
    expect(page).toContain("{viewerIsStaff && a.status !== \"cancelled\" && !walkThrough && (");
    expect(page).toContain("{viewerIsStaff && walkThrough && booked && (");
    expect(page).toContain('<MarkCompleteButton id={a.id} label="Mark Walk-Through Done" />');
    expect(page).not.toContain("Mark inspection complete");
  });

  it("the ⋯ rows, in order, 44px and Title Case, Won't Happen red and last behind a divider", () => {
    const menu = page.slice(page.indexOf("<SectionActionsMenu tree={VISIT_ACTIONS_MENU}>"), page.indexOf("</SectionActionsMenu>"));
    const order = ["<MarkDoneRow", "<AppointmentButton", "<UnscheduleButton id={a.id} menuItem", "<PutBackRow", "<WontHappenRow"].map((t) => menu.indexOf(t));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
    expect(menu).toContain('rowLabel="Edit Details…"');
    expect(menu).toContain("triggerClassName={ACTIONS_ROW_CLS}");
    expect(menu).toContain("afterDeleteHref={scheduleDayHref}");
    expect(page).toContain('const VISIT_ACTIONS_MENU: NavTree = { center: { label: "Actions", icon: "more" }, nodes: [] };');
    for (const w of ['"Mark Done"', '"Put It Back On The Schedule"', '"Won\'t Happen"']) expect(rows).toContain(w);
    expect(rows).toMatch(/<div className=\{ACTIONS_DIVIDER_CLS\} \/>\s*<button[^>]*className=\{ACTIONS_DANGER_ROW_CLS\}/);
  });
});
