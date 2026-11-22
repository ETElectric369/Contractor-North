import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * A LEAD'S ENDING TAKES ITS PICK-A-TIME LINK WITH IT (cn-v1180, the audit of 2026-11-22: A3, the carried
 * C7, and C6, A5, C9 in the same door), against a stand-in database that HONOURS what a read asks for:
 * eq / neq / in / is / gte / lt filters, and only the columns a read lists. A stand-in that ignores them
 * is blind to exactly this rule (which visits are a lead's, which company's, which are `proposed`).
 *
 * The doors run for real: leads/actions (Not Sold, Book It, the rail's batch, Lead to Job) and
 * appointments/actions (Start Now, the visit's Not Sold, and the status door every withdrawal goes
 * through). Only the session, the calendar push, the cache and the filing of errors are stood in.
 */
type Row = Record<string, any>;

const db = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  seq: 0,
  /** Refuse an update the way the database would (returns the error), or change rows first (a race). */
  onUpdate: null as null | ((table: string, patch: Row) => { message: string } | undefined),
  /** A delete that the database answers with no rows (a policy, a row already gone). */
  deleteTouchesNothing: null as null | ((table: string) => boolean),
}));

function project(row: Row, cols?: string): Row {
  if (!cols || cols.trim() === "*") return { ...row };
  const out: Row = {};
  for (const c of cols.split(",").map((x) => x.trim()).filter(Boolean)) {
    if (/[():]/.test(c)) continue;
    out[c] = row[c] ?? null;
  }
  return out;
}

function from(table: string) {
  const filters: Array<(r: Row) => boolean> = [];
  let mode: "select" | "insert" | "update" | "delete" = "select";
  let cols: string | undefined;
  let head = false;
  let single = false;
  let pending: Row[] = [];
  let patch: Row = {};
  const rows = () => (db.tables[table] ??= []);
  const b: any = {
    select(c?: string, opts?: { head?: boolean }) {
      cols = c;
      head = !!opts?.head;
      return b;
    },
    eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), b),
    neq: (c: string, v: unknown) => (filters.push((r) => r[c] != null && r[c] !== v), b),
    in: (c: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[c])), b),
    is: (c: string, v: unknown) => (filters.push((r) => (r[c] ?? null) === v), b),
    gte: (c: string, v: any) => (filters.push((r) => r[c] != null && r[c] >= v), b),
    lt: (c: string, v: any) => (filters.push((r) => r[c] != null && r[c] < v), b),
    // Not on any path under test; a read that used them would be read whole, which these cases avoid.
    or: () => b,
    not: () => b,
    order: () => b,
    limit: () => b,
    insert(r: Row | Row[]) {
      mode = "insert";
      // The set_org_id trigger: a session's insert lands in the caller's company.
      pending = (Array.isArray(r) ? r : [r]).map((x) => ({ org_id: "org-1", ...x, id: x.id ?? `${table}-${++db.seq}` }));
      rows().push(...pending);
      return b;
    },
    update(p: Row) {
      mode = "update";
      patch = p;
      return b;
    },
    delete() {
      mode = "delete";
      return b;
    },
    maybeSingle: () => ((single = true), b),
    single: () => ((single = true), b),
    then(ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) {
      return Promise.resolve(run()).then(ok, bad);
    },
  };
  function run(): { data: unknown; error: unknown; count?: number } {
    const hit = () => rows().filter((r) => filters.every((f) => f(r)));
    if (mode === "insert") {
      const out = pending.map((r) => project(r, cols ?? "id"));
      return { data: single ? out[0] : out, error: null };
    }
    if (mode === "update") {
      const refused = db.onUpdate?.(table, patch);
      if (refused) return { data: null, error: refused };
      const h = hit();
      for (const r of h) Object.assign(r, patch);
      return { data: h.map((r) => project(r, cols ?? "id")), error: null };
    }
    if (mode === "delete") {
      if (db.deleteTouchesNothing?.(table)) return { data: [], error: null };
      const h = hit();
      db.tables[table] = rows().filter((r) => !h.includes(r));
      return { data: h.map((r) => project(r, cols ?? "id")), error: null };
    }
    const h = hit();
    if (head) return { data: null, error: null, count: h.length };
    const out = h.map((r) => project(r, cols));
    return { data: single ? (out[0] ?? null) : out, error: null };
  }
  return b;
}
const client = { from, auth: { getUser: async () => ({ data: { user: { id: "office-1" } } }) } };

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => client), createServiceClient: vi.fn(() => client) }));
vi.mock("@/lib/staff-guard", () => ({
  requireStaff: vi.fn(async () => ({ supabase: client, userId: "office-1", orgId: "org-1" })),
  requireMember: vi.fn(async () => ({ supabase: client, userId: "office-1", orgId: "org-1" })),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("@/lib/calendar-sync", () => ({ pushCalendarItem: vi.fn(async () => {}), deleteCalendarItem: vi.fn(async () => {}) }));
vi.mock("@/lib/notifications", () => ({ notifyPeople: vi.fn(async () => ({ bell: true, pushed: [] })) }));
vi.mock("@/lib/push", () => ({ sendPushToProfiles: vi.fn(async () => {}) }));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({ rateLimited: async () => false }));
vi.mock("@/lib/plan-brief-run", () => ({ runPlanBrief: vi.fn() }));
vi.mock("@/lib/pdf-cache", () => ({ bustBillsOfQuotes: vi.fn(), bustDocPdf: vi.fn(), bustLeadPdfs: vi.fn() }));
vi.mock("../schedule/actions", () => ({ planDayTimes: vi.fn() }));
vi.mock("../quotes/actions", () => ({ saveQuote: vi.fn() }));
vi.mock("@/lib/inquiries/carry-intake-answers", () => ({
  carryForInquiry: vi.fn(async () => ({ inspectionTemplateId: null, inspectionAnswers: {}, carried: [], briefCarried: [] })),
  carriedNote: () => null,
  briefNote: () => null,
}));

const { setInquiryStatus, convertInquiry, scheduleLeadsOnDay, createInquiry } = await import("./actions");
const { createInspectionNow, setAppointmentOutcome, setAppointmentStatus, putVisitBackOnSchedule } = await import("../appointments/actions");
const { withdrawLeadPicks } = await import("@/lib/leads/withdraw-picks");
const { reportError } = await import("@/lib/observe");

const GONE_BY = "2026-11-01T17:00:00.000Z"; // the first time offered, long past
const AHEAD = "2099-01-01T17:00:00.000Z";

const lead = (id: string, org = "org-1", over: Row = {}): Row => ({
  id, org_id: org, name: "Sam Tillery", status: "contacted", converted_at: null, last_contacted_at: GONE_BY,
  address: "4 Larkspur Ln", city: "Thistlewood", state: "CA", zip: "96161", message: "Deck", notes: null,
  customer_id: null, email: null, phone: null, company_name: null, type: "residential", unit: null, project_type: null, intake: null, ...over,
});
const visit = (id: string, inquiry_id: string, status: string, org = "org-1", over: Row = {}): Row => ({
  id, org_id: org, inquiry_id, status, type: "inspection", outcome: null, starts_at: GONE_BY, job_id: null, ...over,
});
const link = (id: string, appointment_id: string, org = "org-1", status = "pending"): Row => ({ id, org_id: org, appointment_id, status, token: `tok-${id}` });

beforeEach(() => {
  db.seq = 0;
  db.onUpdate = null;
  db.deleteTouchesNothing = null;
  vi.mocked(reportError).mockClear();
  db.tables = {
    profiles: [{ id: "office-1", org_id: "org-1", language: "en" }],
    organizations: [{ id: "org-1", settings: { timezone: "America/Los_Angeles" }, phone: null }],
    inquiries: [lead("l1"), lead("l2"), lead("l9", "org-2")],
    appointments: [
      // l1: times were sent, the first went by with no pick (its visit no longer stands).
      visit("v1", "l1", "proposed"),
      // l2, the same company: a link of its own, which no ending of l1 may touch.
      visit("v2", "l2", "proposed"),
      // Another company's visit that names the same lead id (never reachable on a real session; the
      // helper names the company by hand anyway).
      visit("v9", "l1", "proposed", "org-2"),
    ],
    schedule_proposals: [link("p1", "v1"), link("p2", "v2"), link("p9", "v9", "org-2")],
    jobs: [],
    customers: [],
  };
});

const appt = (id: string) => db.tables.appointments.find((a) => a.id === id)!;
const prop = (id: string) => db.tables.schedule_proposals.find((p) => p.id === id)!;
/** l1 in org-1 holds no pending link and no proposed visit; l2 and org-2 are exactly as they were. */
function l1Closed() {
  const mine = db.tables.appointments.filter((a) => a.org_id === "org-1" && a.inquiry_id === "l1");
  expect(mine.filter((a) => a.status === "proposed")).toEqual([]);
  const mineIds = new Set(mine.map((a) => a.id));
  expect(db.tables.schedule_proposals.filter((p) => mineIds.has(p.appointment_id) && p.status === "pending")).toEqual([]);
  expect(appt("v2").status).toBe("proposed");
  expect(prop("p2").status).toBe("pending");
  expect(appt("v9").status).toBe("proposed");
  expect(prop("p9").status).toBe("pending");
}

describe("the one helper (lib/leads/withdraw-picks)", () => {
  const cancel = (id: string) => setAppointmentStatus(id, "cancelled");

  it("takes the lead's proposed visits off through the status door, and sweeps a pending link the door could not reach", async () => {
    // A pending link left on a visit that is no longer proposed (booked by hand): only the sweep reaches it.
    db.tables.appointments.push(visit("v3", "l1", "scheduled", "org-1", { starts_at: AHEAD }));
    db.tables.schedule_proposals.push(link("p3", "v3"));
    const r = await withdrawLeadPicks(client as never, { orgId: "org-1", inquiryId: "l1" }, cancel);
    expect(r).toEqual({ visits: ["v1"], links: 2, failed: [] });
    expect(appt("v1").status).toBe("cancelled");
    expect(prop("p1").status).toBe("cancelled");
    expect(prop("p3").status).toBe("cancelled");
    expect(appt("v3").status).toBe("scheduled");
    l1Closed();
  });

  it("leaves the visit it is told to except exactly as it is, link and all", async () => {
    const r = await withdrawLeadPicks(client as never, { orgId: "org-1", inquiryId: "l1", exceptVisitId: "v1" }, cancel);
    expect(r).toEqual({ visits: [], links: 0, failed: [] });
    expect(appt("v1").status).toBe("proposed");
    expect(prop("p1").status).toBe("pending");
  });

  it("a visit the door could not cancel is returned as failed, never counted as withdrawn", async () => {
    const r = await withdrawLeadPicks(client as never, { orgId: "org-1", inquiryId: "l1" }, async () => ({ ok: false, error: "no" }));
    expect(r.failed).toEqual(["v1"]);
    expect(r.visits).toEqual([]);
  });

  it("no company, no read: an error, never a quiet nothing", async () => {
    const r = await withdrawLeadPicks(client as never, { orgId: null, inquiryId: "l1" }, cancel);
    expect(r.error).toBeInstanceOf(Error);
    expect(appt("v1").status).toBe("proposed");
  });
});

describe("every ending of a lead asks it (A3, C7)", () => {
  it("Not Sold on the lead: the link goes, and the toast says Undo can't bring it back", async () => {
    // The lead row's own door, which offers the Undo (lead-doors markLeadNotSold).
    const r = await setInquiryStatus("l1", "lost", { withUndo: true });
    expect(r).toEqual({ ok: true, note: "Their pick-a-time link was withdrawn; Undo can't bring it back.", pickLink: "withdrawn" });
    expect(db.tables.inquiries.find((l) => l.id === "l1")!.status).toBe("lost");
    l1Closed();
  });

  it("Not Sold in Spanish says it in Spanish", async () => {
    db.tables.profiles[0].language = "es";
    const r = await setInquiryStatus("l1", "lost", { withUndo: true });
    expect(r.note).toBe("Se retiró su enlace para elegir hora; Deshacer no lo puede traer de vuelta.");
  });

  it("skeptic #83 (S6): the assistant's mark-lost has no Undo, so its sentence never mentions one", async () => {
    const { inquiryActions } = await import("@/lib/actions/entities/inquiry");
    const r = (await inquiryActions["inquiry.markLost"].handler({ id: "l1" } as never, {} as never)) as { note?: string };
    expect(r).toMatchObject({ ok: true, pickLink: "withdrawn" });
    expect(r.note).toBe("Their pick-a-time link was withdrawn, so the times sent earlier can't book a second visit.");
    expect(r.note).not.toMatch(/Undo/);
    l1Closed();
  });

  it("skeptic #83 (S6): with no Undo on offer the plain sentence, in Spanish too", async () => {
    db.tables.profiles[0].language = "es";
    const r = await setInquiryStatus("l1", "lost");
    expect(r.note).toBe("Se retiró su enlace para elegir hora, así que las horas que se enviaron antes ya no pueden agendar una segunda visita.");
  });

  it("an Undo (back to contacted) withdraws nothing, and nothing is said", async () => {
    const r = await setInquiryStatus("l1", "contacted");
    expect(r).toEqual({ ok: true });
    expect(appt("v1").status).toBe("proposed");
  });

  it("Book It: the old link goes, and the visit it just booked is never cancelled", async () => {
    const r = await convertInquiry("l1", "inspection", { startDate: "2099-01-05" });
    expect(r.ok).toBe(true);
    expect(r.note).toBe("Their pick-a-time link was withdrawn, so the times sent earlier can't book a second visit.");
    // The new visit (its status is the column's default, which this insert leaves to the database).
    const booked = db.tables.appointments.filter((a) => a.inquiry_id === "l1" && a.org_id === "org-1" && a.id !== "v1");
    expect(booked).toHaveLength(1);
    expect(booked[0].status).not.toBe("cancelled");
    expect(booked[0].starts_at).toMatch(/^2099-01-05/);
    l1Closed();
  });

  it("Start Now: the old link goes, and the visit just started stands", async () => {
    const r = await createInspectionNow({ inquiryId: "l1" });
    expect(r.ok).toBe(true);
    expect(r.note).toBe("Their pick-a-time link was withdrawn, so the times sent earlier can't book a second visit.");
    expect(appt(r.id!).status).toBe("scheduled");
    l1Closed();
  });

  it("the rail's batch books through Book It, and says once what it withdrew", async () => {
    const r = await scheduleLeadsOnDay(["l1"], "2099-01-05");
    expect(r).toMatchObject({ ok: true, booked: 1, failures: [], note: "The pick-a-time link sent earlier to one of these was withdrawn." });
    l1Closed();
  });

  it("a lead with no link out: every ending says nothing about one", async () => {
    db.tables.appointments = db.tables.appointments.filter((a) => a.id !== "v1");
    expect(await setInquiryStatus("l1", "lost")).toEqual({ ok: true });
    const r = await convertInquiry("l2", "inspection", { startDate: "2099-01-05" });
    expect(r.note).toBe("Their pick-a-time link was withdrawn, so the times sent earlier can't book a second visit.");
    expect(appt("v9").status).toBe("proposed");
  });
});

describe("the visit's own Not Sold on a visit waiting for a pick (A3)", () => {
  it("whatever its first time was, a proposed visit is taken off and its link withdrawn", async () => {
    const r = await setAppointmentOutcome("v1", "lost", { offSchedule: true });
    expect(r.ok).toBe(true);
    expect(r.offSchedule?.previousStatus).toBe("proposed");
    expect(appt("v1").status).toBe("cancelled");
    expect(prop("p1").status).toBe("cancelled");
    expect(appt("v2").status).toBe("proposed");
  });

  it("skeptic #83 (S9): a visit's Not Sold that marks its LEAD Not Sold takes the lead's OTHER links too", async () => {
    // l1 was visited (a past visit, answered now) and also sent times that ran out (v1, link p1).
    db.tables.appointments.push(visit("v4", "l1", "scheduled"));
    const r = await setAppointmentOutcome("v4", "lost", { offSchedule: true });
    expect(r).toMatchObject({ ok: true, leadMarked: true, note: "Their pick-a-time link was withdrawn; Undo can't bring it back." });
    expect(db.tables.inquiries.find((l) => l.id === "l1")!.status).toBe("lost");
    // The visit answered keeps its status (its day has gone by); the lead's other link is gone.
    expect(appt("v4").status).toBe("scheduled");
    l1Closed();
  });

  it("skeptic #83 (S9): the assistant's route (no Undo) says the plain sentence, and a lead left open withdraws nothing", async () => {
    db.tables.appointments.push(visit("v4", "l1", "scheduled"));
    const r = await setAppointmentOutcome("v4", "lost");
    expect(r.note).toBe("Their pick-a-time link was withdrawn, so the times sent earlier can't book a second visit.");
    l1Closed();
    // A lead that does NOT go Not Sold (another visit still stands) keeps its links.
    db.tables.appointments.push(visit("v6", "l2", "scheduled"), visit("v7", "l2", "scheduled", "org-1", { starts_at: AHEAD }));
    const r2 = await setAppointmentOutcome("v6", "lost");
    expect(r2.leadMarked).toBeUndefined();
    expect(r2.note).toBeUndefined();
    expect(appt("v2").status).toBe("proposed");
    expect(prop("p2").status).toBe("pending");
  });

  it("a booked visit whose day has gone by still keeps its status (it may have happened)", async () => {
    db.tables.appointments.push(visit("v4", "l2", "scheduled"));
    const r = await setAppointmentOutcome("v4", "lost", { offSchedule: true });
    expect(r.offSchedule).toBeUndefined();
    expect(appt("v4").status).toBe("scheduled");
  });
});

describe("skeptic #83 (S1): the Undo of Not Sold on a visit waiting for a pick never makes it an agreed visit", () => {
  // The Inspections row's own Not Sold, its Undo run for real against the real doors (the visit page's
  // Not Sold row makes the same two calls: the outcome cleared, then the door back told what it was).
  const io = () => {
    const toast = vi.fn();
    return { toast: toast as any, refresh: () => {}, close: () => {}, lang: "en" as const, t: ((k: string) => k) as any };
  };
  const settle = () => new Promise((r) => setTimeout(r, 0));

  for (const [when, startsAt] of [["its first offered time has passed", GONE_BY], ["its first offered time is still ahead", AHEAD]] as const) {
    it(`${when}: Not Sold, then Undo, leaves it waiting for a day, not Scheduled on a time nobody picked`, async () => {
      const { markItLost } = await import("../inspections/inspection-row-menu");
      appt("v1").starts_at = startsAt;
      appt("v1").ends_at = startsAt;
      const door = io();
      await markItLost("v1", door, { setOutcome: setAppointmentOutcome, putBack: putVisitBackOnSchedule });
      expect(appt("v1").status).toBe("cancelled");
      const undo = door.toast.mock.calls.find((c: unknown[]) => c[2])![2] as { onClick: () => void };
      undo.onClick();
      await settle();
      await settle();
      expect(appt("v1").status).toBe("scheduled");
      expect(appt("v1").starts_at).toBeNull();
      expect(appt("v1").ends_at).toBeNull();
      expect(appt("v1").outcome).toBeNull();
      // The link it lost stays lost: never `proposed` again with a dead link.
      expect(prop("p1").status).toBe("cancelled");
      // Where it went is said (the lead went Not Sold with it and came back open: its own words lead).
      expect(door.toast).toHaveBeenLastCalledWith("vp_undoneLeadToo Back on the schedule, waiting for a day.", "success");
    });
  }
});

describe("Lead to Job keeps the lead's own customer (A5) and takes back what it made when its stamp fails (C6)", () => {
  beforeEach(() => {
    db.tables.customers = [{ id: "c-owner", org_id: "org-1", name: "Dana Rook", company_name: null, type: "residential", email: null, phone: "(530) 555-0101" }];
  });

  it("a lead tied to its customer: the job goes under THAT customer, no card is made, and the tie is never re-stamped", async () => {
    // Started from the owner's page, with the tenant's name and phone typed.
    db.tables.inquiries.push(lead("l5", "org-1", { name: "Theo Vance", phone: "(530) 555-0102", customer_id: "c-owner" }));
    const r = await convertInquiry("l5", "job");
    expect(r.ok).toBe(true);
    expect(db.tables.jobs).toHaveLength(1);
    expect(db.tables.jobs[0].customer_id).toBe("c-owner");
    expect(db.tables.customers.map((c) => c.id)).toEqual(["c-owner"]);
    expect(db.tables.inquiries.find((l) => l.id === "l5")!.customer_id).toBe("c-owner");
  });

  it("the caller's explicit pick still wins for the job, and the lead's own tie is still never re-stamped", async () => {
    db.tables.customers.push({ id: "c-other", org_id: "org-1", name: "Theo Vance", company_name: null, type: "residential", email: null, phone: null });
    db.tables.inquiries.push(lead("l5", "org-1", { name: "Theo Vance", customer_id: "c-owner" }));
    const r = await convertInquiry("l5", "job", { customerId: "c-other" });
    expect(r.ok).toBe(true);
    expect(db.tables.jobs[0].customer_id).toBe("c-other");
    expect(db.tables.inquiries.find((l) => l.id === "l5")!.customer_id).toBe("c-owner");
  });

  it("a stamp that fails: the job and the card made just now are taken back, and the failure is said in the app's words", async () => {
    db.tables.inquiries.push(lead("l6", "org-1", { name: "Casey Loam", phone: "(530) 555-0103" }));
    db.onUpdate = (table, patch) => (table === "inquiries" && "converted_at" in patch ? { message: "deadlock detected" } : undefined);
    const r = await convertInquiry("l6", "job");
    expect(r).toEqual({ ok: false, error: "This lead couldn't be marked converted, so nothing was made. Try again." });
    expect(db.tables.jobs).toEqual([]);
    expect(db.tables.customers.map((c) => c.id)).toEqual(["c-owner"]);
    expect(reportError).toHaveBeenCalledWith("leads:convert:stamp", { message: "deadlock detected" }, { leadId: "l6" });
  });

  // skeptic #83 (S5): the take-back may remove only a card THIS call made (mintedFromLead). A customer that
  // existed before, by the lead's own tie or by the caller's pick, stays whatever fails after it.
  it("a stamp that fails on a lead TIED to a customer: the job made just now goes, the customer stays", async () => {
    db.tables.inquiries.push(lead("l6", "org-1", { name: "Theo Vance", phone: "(530) 555-0102", customer_id: "c-owner" }));
    db.onUpdate = (table, patch) => (table === "inquiries" && "converted_at" in patch ? { message: "deadlock detected" } : undefined);
    const r = await convertInquiry("l6", "job");
    expect(r).toEqual({ ok: false, error: "This lead couldn't be marked converted, so nothing was made. Try again." });
    expect(db.tables.jobs).toEqual([]);
    expect(db.tables.customers.map((c) => c.id)).toEqual(["c-owner"]);
  });

  it("a stamp that fails with the caller's explicit pick: the job made just now goes, the picked customer stays", async () => {
    db.tables.customers.push({ id: "c-other", org_id: "org-1", name: "Theo Vance", company_name: null, type: "residential", email: null, phone: null });
    db.tables.inquiries.push(lead("l6", "org-1", { name: "Theo Vance" }));
    db.onUpdate = (table, patch) => (table === "inquiries" && "converted_at" in patch ? { message: "deadlock detected" } : undefined);
    const r = await convertInquiry("l6", "job", { customerId: "c-other" });
    expect(r.ok).toBe(false);
    expect(db.tables.jobs).toEqual([]);
    expect(db.tables.customers.map((c) => c.id)).toEqual(["c-owner", "c-other"]);
  });

  it("a delete that touches nothing is read back and named, never called taken back", async () => {
    db.tables.inquiries.push(lead("l7", "org-1", { name: "Casey Loam", phone: "(530) 555-0103" }));
    db.onUpdate = (table, patch) => (table === "inquiries" && "converted_at" in patch ? { message: "deadlock detected" } : undefined);
    db.deleteTouchesNothing = (table) => table === "jobs";
    const r = await convertInquiry("l7", "job");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/^This lead couldn't be marked converted, and the job made for it couldn't be removed — delete job jobs-\d+ by hand\.$/);
  });

  it("the lost race (zero rows): the card made just now goes too, each delete read back", async () => {
    db.tables.inquiries.push(lead("l8", "org-1", { name: "Casey Loam", phone: "(530) 555-0103" }));
    // Another tap converts the lead between this call's guard and its stamp.
    db.onUpdate = (table, patch) => {
      if (table === "inquiries" && "converted_at" in patch) db.tables.inquiries.find((l) => l.id === "l8")!.converted_at = "2026-11-22T10:00:00Z";
      return undefined;
    };
    const r = await convertInquiry("l8", "job");
    expect(r).toEqual({ ok: false, error: "This lead was already converted — open its customer or estimate instead." });
    expect(db.tables.jobs).toEqual([]);
    expect(db.tables.customers.map((c) => c.id)).toEqual(["c-owner"]);
  });
});

describe("New Lead from a customer's page says when that customer could not be read (C9)", () => {
  const form = (f: Record<string, string>) => {
    const d = new FormData();
    for (const [k, v] of Object.entries(f)) d.set(k, v);
    return d;
  };
  it("an id that reads nothing and no match: the lead saves untied, and the answer says so", async () => {
    const r = await createInquiry(form({ customer_id: "c-gone", name: "Casey Loam" }));
    expect(r).toMatchObject({ ok: true, note: "That customer couldn't be read; the lead was saved without them." });
    expect(db.tables.inquiries.at(-1)!.customer_id).toBeNull();
  });
  it("in Spanish, in Spanish", async () => {
    db.tables.profiles[0].language = "es";
    const r = await createInquiry(form({ customer_id: "c-gone", name: "Casey Loam" }));
    expect(r.note).toBe("No se pudo leer ese cliente; el prospecto se guardó sin él.");
  });
  it("nothing posted says nothing of it", async () => {
    const r = await createInquiry(form({ name: "Casey Loam" }));
    expect(r.note).toBeUndefined();
  });
});
