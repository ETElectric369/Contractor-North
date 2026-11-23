import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { standIn, type Row } from "@/lib/inquiries/public-stand-in.test-support";
import { TAHOE_DECK } from "@/lib/playbook/starters/tahoe-deck";
import { tzDateTimeUtc } from "@/lib/tz";

/**
 * THE OPEN-TIMES OFFER AND THE PICK (cn-v1185), on the stand-in that honours eq / neq / in / gt / gte /
 * lt / lte / limit and select lists. Lane O's readers (lib/schedule/open-times) are mocked HERE: lane O
 * proves what is open; this file proves what the two public doors do with the answer. With the offer
 * off, the request door is today's, byte for byte: public-schedule.test.ts runs unedited, unmocked.
 */
const svc = vi.hoisted(() => ({ client: null as any }));
const sent = vi.hoisted(() => ({ bell: [] as any[], push: [] as any[], reported: [] as any[] }));
const ot = vi.hoisted(() => ({
  offers: true,
  offer: [] as any[],
  onDay: [] as any[],
  offerThrows: false,
  onDayThrows: false,
  onDaySideEffect: null as null | (() => void),
  calls: { offer: 0, onDay: 0 },
}));
const limits = vi.hoisted(() => ({ blocked: new Set<string>(), seen: [] as [string, number, number][] }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({
  rateLimited: vi.fn(async (k: string, n: number, w: number) => (limits.seen.push([k, n, w]), limits.blocked.has(k))),
  clientIp: () => "203.0.113.9",
}));
vi.mock("@/lib/supabase/server", () => ({ createServiceClient: () => svc.client, createClient: vi.fn() }));
vi.mock("@/lib/notifications", () => ({ createNotifications: vi.fn(async (...a: any[]) => void sent.bell.push(a)) }));
vi.mock("@/lib/push", () => ({
  orgStaffIds: vi.fn(async () => ["p-owner"]),
  sendPushToProfiles: vi.fn(async (...a: any[]) => void sent.push.push(a)),
}));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn((...a: any[]) => void sent.reported.push(a)) }));
vi.mock("@/lib/schedule/open-times", async (orig) => ({
  ...(await orig<typeof import("@/lib/schedule/open-times")>()),
  offersOpenTimes: () => ot.offers,
  openInspectionTimes: async () => {
    ot.calls.offer++;
    if (ot.offerThrows) throw new Error("calendar unreadable");
    return ot.offer;
  },
  openTimesOnDay: async () => {
    ot.calls.onDay++;
    ot.onDaySideEffect?.();
    if (ot.onDayThrows) throw new Error("calendar unreadable");
    return ot.onDay;
  },
}));

const { publicScheduleInspection, publicPickInspectionTime } = await import("./public-schedule");
const { carryForInquiry } = await import("@/lib/inquiries/carry-intake-answers");

const ORG = "0a0a0a0a-0000-4000-8000-000000000001";
const OTHER = "0b0b0b0b-0000-4000-8000-000000000002";
const LEAD = "1a1a1a1a-0000-4000-8000-000000000011";
const THEIRS = "2b2b2b2b-0000-4000-8000-000000000022";
const TZ = "America/Los_Angeles";
const ago = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
const time = (ymd: string, hm: string) => ({ at: tzDateTimeUtc(ymd, hm, TZ)!, ymd, hm });
const T9 = time("2026-12-01", "09:00");
const T1030 = time("2026-12-01", "10:30");
const T12 = time("2026-12-02", "12:00");
const plus = (iso: string, min: number) => new Date(Date.parse(iso) + min * 60_000).toISOString();

const lead = (over: Row = {}): Row => ({
  id: LEAD,
  org_id: ORG,
  name: "Sam Tillery",
  phone: "555-0101",
  email: null,
  address: "1 Larkspur Way",
  message: "Deck off the back",
  notes: null,
  customer_id: null,
  intake: { intake_answers: { project_type: "New deck" } },
  status: "new",
  site_inspection_required: false,
  created_at: ago(1),
  updated_at: ago(1),
  ...over,
});

const ON = { inspection_days: { offer: true, days: ["tue", "wed"], start: "09:00", end: "15:00", per_day: 3 }, features: {} };

function world(leads: Row[], appointments: Row[] = [], opts: Parameters<typeof standIn>[2] = {}, settings: Row = ON) {
  const db = standIn(
    {
      organizations: [
        { id: ORG, settings },
        { id: OTHER, settings },
      ],
      inquiries: leads,
      appointments,
      schedule_proposals: [],
      forms: [
        { id: "form-theirs", org_id: OTHER, is_inspection: true, schema: null, playbook: TAHOE_DECK },
        { id: "form-ours", org_id: ORG, is_inspection: true, schema: null, playbook: TAHOE_DECK },
      ],
    },
    {},
    opts,
  );
  svc.client = db.client;
  return db;
}

const writes = (db: ReturnType<typeof world>) => db.log.filter((l) => l.op !== "select");
const ask = (over: Record<string, unknown> = {}) =>
  publicScheduleInspection({ orgId: ORG, name: "Sam Tillery", phone: "555-0101", leadId: LEAD, ...over });
const pick = (over: Record<string, unknown> = {}) => publicPickInspectionTime({ orgId: ORG, leadId: LEAD, at: T9.at, ...over });

beforeEach(() => {
  sent.bell = [];
  sent.push = [];
  sent.reported = [];
  ot.offers = true;
  ot.offer = [T9, T1030, T12];
  ot.onDay = [T9, T1030];
  ot.offerThrows = false;
  ot.onDayThrows = false;
  ot.onDaySideEffect = null;
  ot.calls = { offer: 0, onDay: 0 };
  limits.blocked = new Set();
  limits.seen = [];
});
afterEach(() => vi.useRealTimers());

describe("the request door offers open times", () => {
  it("offer on and times open: the times come back with their labels, the lead is stamped, and the office is NOT pinged", async () => {
    const mine = lead();
    world([mine]);
    const res = await ask();
    expect(res.ok).toBe(true);
    expect(res.times?.map((t) => t.at)).toEqual([T9.at, T1030.at, T12.at]);
    expect(res.times?.[0].label).toBe("Tue, Dec 1 · 9:00 AM");
    expect(mine.site_inspection_required).toBe(true);
    expect(sent.bell).toEqual([]);
    expect(sent.push).toEqual([]);
  });

  it("nothing open: today's answer and today's ping", async () => {
    ot.offer = [];
    world([lead()]);
    expect(await ask()).toEqual({ ok: true });
    expect(sent.bell).toHaveLength(1);
    expect(sent.bell[0][2].title).toBe("Sam Tillery wants an inspection — send them times");
  });

  it("offer off: the reader is never asked and the office is pinged", async () => {
    ot.offers = false;
    world([lead()]);
    expect(await ask()).toEqual({ ok: true });
    expect(ot.calls.offer).toBe(0);
    expect(sent.bell).toHaveLength(1);
  });

  it("None of These Work (noOffer): no times, the office is pinged", async () => {
    world([lead()]);
    expect(await ask({ noOffer: true })).toEqual({ ok: true });
    expect(ot.calls.offer).toBe(0);
    expect(sent.bell).toHaveLength(1);
  });

  it("a calendar that cannot be read is filed with ids only and never shown: today's ping", async () => {
    ot.offerThrows = true;
    world([lead()]);
    expect(await ask()).toEqual({ ok: true });
    expect(sent.bell).toHaveLength(1);
    expect(sent.reported).toHaveLength(1);
    const ctx = JSON.stringify(sent.reported[0][2]);
    for (const bad of ["Sam", "555", "Larkspur"]) expect(ctx).not.toContain(bad);
    expect(sent.reported[0][2]).toEqual({ orgId: ORG, leadId: LEAD });
  });

  it("ANY live scheduled inspection counts, a picked one with no created_by too: no stamp, no ping, no times, the one answer", async () => {
    const mine = lead();
    const db = world([mine], [{ id: "appt-picked", org_id: ORG, inquiry_id: LEAD, type: "inspection", status: "scheduled", created_by: null }]);
    expect(await ask()).toEqual({ ok: true });
    expect(mine.site_inspection_required).toBe(false);
    expect(sent.bell).toEqual([]);
    expect(ot.calls.offer).toBe(0);
    expect(writes(db)).toEqual([]);
  });

  it("a standing-visit read that fails offers no times (never 'none stands'): today's ping", async () => {
    world([lead()], [], { fail: (t, op) => t === "appointments" && op === "select" });
    expect(await ask()).toEqual({ ok: true });
    expect(ot.calls.offer).toBe(0);
    expect(sent.bell).toHaveLength(1);
  });
});

describe("the pick books the time the visitor tapped", () => {
  it("writes Book It's row plus the company, scheduled, no end, no length, the carried sheet; the lead goes to contacted; the office hears the day and time from the lead's row", async () => {
    const mine = lead();
    const db = world([mine], [
      { id: "appt-proposed", org_id: ORG, inquiry_id: LEAD, type: "inspection", status: "proposed", starts_at: T12.at, created_at: ago(2) },
    ]);
    db.tables.schedule_proposals.push({ id: "prop-1", org_id: ORG, appointment_id: "appt-proposed", status: "pending" });
    const res = await pick();
    expect(res).toEqual({ ok: true, booked: { label: "Tue, Dec 1 · 9:00 AM" } });

    const row = db.tables.appointments.find((a) => a.status === "scheduled")!;
    expect(row).toMatchObject({
      org_id: ORG,
      inquiry_id: LEAD,
      type: "inspection",
      title: "Inspection: Sam Tillery",
      starts_at: T9.at,
      location: "1 Larkspur Way",
      created_by: null,
      status: "scheduled",
      inspection_template_id: "form-ours",
    });
    expect(row.notes).toContain("Deck off the back");
    expect(row.notes).toContain("Already answered by the customer online");
    expect((row.inspection_answers as Row).project_type).toBe("New deck");
    for (const k of ["ends_at", "planned_minutes", "duration_minutes"]) expect(row).not.toHaveProperty(k);
    const formRead = db.log.find((l) => l.table === "forms");
    expect(formRead?.filters).toContain(`org_id=${ORG}`);

    expect(mine.status).toBe("contacted");
    const moved = db.log.find((l) => l.op === "update" && l.table === "inquiries");
    expect(moved?.filters).toEqual([`id=${LEAD}`, `org_id=${ORG}`, "status=new"]);

    // The pick link the office sent earlier is withdrawn, by id AND company.
    expect(db.tables.appointments.find((a) => a.id === "appt-proposed")?.status).toBe("cancelled");
    const cancel = db.log.find((l) => l.op === "update" && l.table === "appointments");
    expect(cancel?.filters).toEqual(["id=appt-proposed", `org_id=${ORG}`, "status=proposed"]);
    expect(db.tables.schedule_proposals[0].status).toBe("cancelled");

    expect(sent.bell).toHaveLength(1);
    const p = sent.bell[0][2];
    expect(p.title).toBe("Sam Tillery picked Tue, Dec 1 · 9:00 AM for an inspection");
    expect(p.body).toBe("555-0101 · 1 Larkspur Way");
    expect(p.url).toBe(`/leads/${LEAD}`);
    expect({ type: "inquiry", ...sent.push[0][2] }).toEqual(p);
  });

  it("the instant is compared, the server's own string is written", async () => {
    const db = world([lead()]);
    const sameInstant = T9.at.replace("Z", "+00:00").replace(".000", "");
    expect((await pick({ at: sameInstant })).booked).toBeTruthy();
    expect(db.tables.appointments[0].starts_at).toBe(T9.at);
  });

  it("a time the calendar no longer shows is refused with the fresh open times, and nothing is written", async () => {
    ot.onDay = [T1030];
    ot.offer = [T1030, T12];
    const db = world([lead()]);
    const res = await pick();
    expect(res).toEqual({ ok: false, taken: true, times: [
      { at: T1030.at, label: "Tue, Dec 1 · 10:30 AM" },
      { at: T12.at, label: "Wed, Dec 2 · 12:00 PM" },
    ] });
    expect(writes(db)).toEqual([]);
    expect(sent.bell).toEqual([]);
  });

  it("nothing open at all any more: the office is asked for times and the visitor reads the generic sentence", async () => {
    ot.onDay = [];
    ot.offer = [];
    const mine = lead();
    const db = world([mine]);
    expect(await pick()).toEqual({ ok: true });
    expect(db.tables.appointments).toEqual([]);
    expect(mine.site_inspection_required).toBe(true);
    expect(sent.bell[0][2].title).toBe("Sam Tillery wants an inspection — send them times");
  });

  it("a calendar that cannot be read at the tap books nothing and asks the office", async () => {
    ot.onDayThrows = true;
    ot.offerThrows = true;
    const db = world([lead()]);
    expect(await pick()).toEqual({ ok: true });
    expect(db.tables.appointments).toEqual([]);
    expect(sent.bell[0][2].title).toContain("send them times");
  });
});

describe("the pick learns nothing and writes nothing it should not", () => {
  // F7 (skeptic #87): nobody is told on these paths, so the words promise nothing; they name one action.
  const OFF = { ok: false, error: "Online booking isn't available right now. Call us to set a time." };
  it.each([
    ["another company's lead id", () => [lead({ id: THEIRS, org_id: OTHER })], THEIRS],
    ["a lead not touched in 24 hours", () => [lead({ created_at: ago(50), updated_at: ago(30) })], LEAD],
    ["an unknown id", () => [lead()], "3c3c3c3c-0000-4000-8000-000000000033"],
    ["no id at all", () => [lead()], null],
    ["something that is not an id", () => [lead()], "x' or 1=1"],
  ])("%s: the same refusal as the offer being off, nothing written, nobody told", async (_n, leads, leadId) => {
    const db = world(leads());
    expect(await pick({ leadId })).toEqual(OFF);
    expect(writes(db)).toEqual([]);
    expect(sent.bell).toEqual([]);
    expect(ot.calls.onDay).toBe(0);
  });

  it("the offer off: refused, nothing read beyond the company", async () => {
    ot.offers = false;
    const db = world([lead()]);
    expect(await pick()).toEqual(OFF);
    expect(db.log.map((l) => l.table)).toEqual(["organizations"]);
  });

  it("an unknown company: refused", async () => {
    const db = world([lead()]);
    expect(await pick({ orgId: "9f9f9f9f-0000-4000-8000-000000000099" })).toEqual(OFF);
    expect(writes(db)).toEqual([]);
  });

  it("a visit already stands: { ok: true }, nothing written, never a time", async () => {
    const db = world([lead()], [{ id: "appt-1", org_id: ORG, inquiry_id: LEAD, type: "inspection", status: "scheduled", created_by: "p-owner", starts_at: T12.at }]);
    expect(await pick()).toEqual({ ok: true });
    expect(writes(db)).toEqual([]);
  });

  it.each([["not a date"], ["2026-12-01"], ["2026-12-01T17:00:00"], [""]])("an `at` that is not an ISO instant (%s) is refused before any read", async (at) => {
    const db = world([lead()]);
    const res = await pick({ at });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("That time didn't come through. Call us to set a time.");
    expect(db.log).toEqual([]);
  });

  it("the honeypot: a silent fake success, nothing read", async () => {
    const db = world([lead()]);
    expect(await pick({ hp: "x" })).toEqual({ ok: true });
    expect(db.log).toEqual([]);
  });

  it.each([["pick:203.0.113.9"], ["pick-day:203.0.113.9"]])("rate limit %s: refused with 'call us', nothing written", async (key) => {
    limits.blocked.add(key);
    const db = world([lead()]);
    expect(await pick()).toEqual({ ok: false, error: "Too many tries. Call us to set a time." });
    expect(writes(db)).toEqual([]);
  });

  it("the limits are 5 a minute and 6 a day per address, 10 a day per company", async () => {
    world([lead()]);
    await pick();
    expect(limits.seen).toEqual([
      ["pick:203.0.113.9", 5, 60],
      ["pick-day:203.0.113.9", 6, 86400],
      [`pick-org:${ORG}`, 10, 86400],
    ]);
  });

  it("a lead read that fails is a failure, never 'no lead'", async () => {
    const db = world([lead()], [], { fail: (t, op) => t === "inquiries" && op === "select" });
    expect(await pick()).toEqual({ ok: false, error: "That didn't go through. Call us to set a time." });
    expect(writes(db)).toEqual([]);
  });
});

describe("two visitors, one time, the same second (check after write)", () => {
  it("a visit written first on that time, after the calendar was asked, wins: ours is taken back off and the fresh times come back", async () => {
    ot.offer = [T1030];
    const db = world([lead()]);
    ot.onDaySideEffect = () =>
      db.tables.appointments.push({ id: "appt-rival", org_id: ORG, type: "inspection", status: "scheduled", starts_at: T9.at, created_at: ago(0.001) });
    const res = await pick();
    expect(res).toEqual({ ok: false, taken: true, times: [{ at: T1030.at, label: "Tue, Dec 1 · 10:30 AM" }] });
    expect(db.tables.appointments.map((a) => a.id)).toEqual(["appt-rival"]);
    const del = db.log.find((l) => l.op === "delete");
    expect(del?.filters[0]).toMatch(/^id=appointments-new-/);
    expect(del?.filters[1]).toBe(`org_id=${ORG}`);
    expect(sent.bell).toEqual([]);
  });

  it("the same instant: the smaller id was written first", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-22T20:00:00Z"));
    const now = new Date().toISOString();
    const db = world([lead({ created_at: now, updated_at: now })]);
    ot.onDaySideEffect = () =>
      db.tables.appointments.push({ id: "appointments-0", org_id: ORG, type: "inspection", status: "scheduled", starts_at: T9.at, created_at: now });
    expect((await pick()).taken).toBe(true);
    expect(db.tables.appointments.map((a) => a.id)).toEqual(["appointments-0"]);
  });

  it("a rival written AFTER ours loses: ours stands", async () => {
    const db = world([lead()]);
    ot.onDaySideEffect = () =>
      db.tables.appointments.push({ id: "appt-late", org_id: ORG, type: "inspection", status: "scheduled", starts_at: T9.at, created_at: plus(new Date().toISOString(), 1) });
    expect((await pick()).booked).toBeTruthy();
    expect(db.tables.appointments).toHaveLength(2);
  });

  it("a visit that was there BEFORE the calendar was asked (ends before ours starts) is the schedule's to judge, not a clash", async () => {
    const db = world([lead()], [
      { id: "appt-early", org_id: ORG, type: "inspection", status: "scheduled", starts_at: plus(T9.at, -75), created_at: ago(5) },
    ]);
    expect((await pick()).booked).toBeTruthy();
    expect(db.tables.appointments).toHaveLength(2);
  });

  it("another company's visit on the same time never takes ours off", async () => {
    const db = world([lead()]);
    ot.onDaySideEffect = () =>
      db.tables.appointments.push({ id: "appt-theirs", org_id: OTHER, type: "inspection", status: "scheduled", starts_at: T9.at, created_at: ago(0.001) });
    expect((await pick()).booked).toBeTruthy();
  });

  it("a call on the same time is not a visit: ours stands", async () => {
    const db = world([lead()]);
    ot.onDaySideEffect = () =>
      db.tables.appointments.push({ id: "appt-call", org_id: ORG, type: "call", status: "scheduled", starts_at: T9.at, created_at: ago(0.001) });
    expect((await pick()).booked).toBeTruthy();
  });

  it("the day re-counted: past per_day, the newest is taken off", async () => {
    ot.offer = [];
    const db = world(
      [lead()],
      [],
      {},
      { ...ON, inspection_days: { ...ON.inspection_days, per_day: 1 } },
    );
    ot.onDaySideEffect = () =>
      db.tables.appointments.push({ id: "appt-pm", org_id: ORG, type: "inspection", status: "scheduled", starts_at: T9.at.replace("T17:", "T21:"), created_at: ago(0.001) });
    expect(await pick()).toEqual({ ok: true });
    expect(db.tables.appointments.map((a) => a.id)).toEqual(["appt-pm"]);
    expect(sent.bell[0][2].title).toContain("send them times");
  });
});

describe("a failure after the insert: never 'booked' for a visit not there, never a failure for one that is", () => {
  it("the insert fails: nothing written, the visitor is told it didn't go through", async () => {
    const db = world([lead()], [], { fail: (t, op) => t === "appointments" && op === "insert" });
    expect(await pick()).toEqual({ ok: false, error: "That didn't go through. Call us to set a time." });
    expect(db.tables.appointments).toEqual([]);
    expect(sent.bell).toEqual([]);
  });

  it("the check after write cannot read: our row is taken back off and the office is asked (the generic sentence)", async () => {
    let armed = false;
    const db = world([lead()], [], { fail: (t, op, f) => armed && t === "appointments" && op === "select" && f.some((x) => x.startsWith("starts_at>=")) });
    ot.onDaySideEffect = () => void (armed = true);
    expect(await pick()).toEqual({ ok: true });
    expect(db.tables.appointments).toEqual([]);
    expect(sent.bell[0][2].title).toContain("send them times");
  });

  it("a clash whose take-back fails: the visit stands, so the visitor is told it is booked", async () => {
    const db = world([lead()], [], { fail: (t, op) => t === "appointments" && op === "delete" });
    ot.onDaySideEffect = () =>
      db.tables.appointments.push({ id: "appt-rival", org_id: ORG, type: "inspection", status: "scheduled", starts_at: T9.at, created_at: ago(0.001) });
    const res = await pick();
    expect(res.booked).toBeTruthy();
    expect(db.tables.appointments).toHaveLength(2);
    expect(sent.reported.map((r) => r[0])).toContain("public-schedule:pick-clash");
  });

  it("moving the lead fails: the visit stands and is booked; the miss is filed with ids only", async () => {
    const db = world([lead()], [], { fail: (t, op) => t === "inquiries" && op === "update" });
    expect((await pick()).booked).toBeTruthy();
    expect(db.tables.appointments).toHaveLength(1);
    expect(sent.reported.map((r) => r[0])).toContain("public-schedule:pick-lead");
    for (const r of sent.reported) for (const bad of ["Sam", "555", "Larkspur"]) expect(JSON.stringify(r[2])).not.toContain(bad);
  });
});

describe("carryForInquiry on the service client names the company", () => {
  it("with a company, reads that company's inspection form, never the first one found", async () => {
    world([]);
    const inq = { intake: { intake_answers: { project_type: "New deck" } } };
    expect((await carryForInquiry(svc.client, inq, { orgId: ORG })).inspectionTemplateId).toBe("form-ours");
    // Without one (the staff callers, fenced by RLS) the read is as before: no company filter.
    const db = world([]);
    expect((await carryForInquiry(svc.client, inq)).inspectionTemplateId).toBe("form-theirs");
    expect(db.log[0].filters).toEqual(["is_inspection=true"]);
  });
});

const inspections = (db: ReturnType<typeof world>) =>
  db.tables.appointments.filter((a) => a.inquiry_id === LEAD && a.type === "inspection" && a.status === "scheduled");
const SEND_TIMES = "Sam Tillery wants an inspection — send them times";

describe("F2 (skeptic #87, S2) · the request door offers times only on the browser's own lead", () => {
  it.each([
    ["no id", () => [] as Row[], null],
    ["an id past 24 hours", () => [lead({ created_at: ago(50), updated_at: ago(30) })], LEAD],
    ["another company's id", () => [lead({ id: THEIRS, org_id: OTHER })], THEIRS],
  ])("%s: a schedule_button lead is inserted, the office is pinged, and no times come back", async (_n, leads, leadId) => {
    const db = world(leads());
    const res = await ask({ leadId });
    expect(res).toEqual({ ok: true });
    expect(ot.calls.offer).toBe(0);
    const made = db.tables.inquiries.filter((r) => r.source === "schedule_button");
    expect(made).toHaveLength(1);
    expect(made[0].org_id).toBe(ORG);
    expect(sent.bell).toHaveLength(1);
    expect(sent.bell[0][2].title).toBe(SEND_TIMES);
  });

  it("the browser's own lead with the offer on: times, and no ping (as before)", async () => {
    world([lead()]);
    expect((await ask()).times).toHaveLength(3);
    expect(sent.bell).toEqual([]);
  });
});

describe("F4 (skeptic #87, S4) · an ended lead is never booked and never re-opened", () => {
  it("a pick on a lead the office marked lost writes NO visit and asks the office instead", async () => {
    const mine = lead({ status: "lost" });
    const db = world([mine]);
    expect(await pick()).toEqual({ ok: true });
    expect(db.tables.appointments).toEqual([]);
    expect(mine.status).toBe("lost");
    expect(mine.site_inspection_required).toBe(true);
    expect(sent.bell).toHaveLength(1);
    expect(sent.bell[0][2].title).toBe(SEND_TIMES);
    expect(ot.calls.onDay).toBe(0);
  });

  it("the request door never offers times on a lead the office ended: today's ping", async () => {
    world([lead({ status: "won" })]);
    expect(await ask()).toEqual({ ok: true });
    expect(ot.calls.offer).toBe(0);
    expect(sent.bell[0][2].title).toBe(SEND_TIMES);
  });

  it("a quoted lead is booked and stays quoted: nothing writes its status", async () => {
    const mine = lead({ status: "quoted" });
    const db = world([mine]);
    expect((await pick()).booked).toBeTruthy();
    expect(mine.status).toBe("quoted");
    expect(db.log.some((l) => l.op === "update" && l.table === "inquiries" && "status" in (l.patch ?? {}))).toBe(false);
  });

  it("a lead the office moves between the read and the write keeps the office's status, and zero rows is no failure", async () => {
    const mine = lead();
    world([mine]);
    ot.onDaySideEffect = () => void (mine.status = "quoted");
    expect((await pick()).booked).toBeTruthy();
    expect(mine.status).toBe("quoted");
    expect(sent.reported.map((r) => r[0])).not.toContain("public-schedule:pick-lead");
  });
});

describe("F5 (skeptic #87, S5) · the company's daily ceiling counts bookings, not calls", () => {
  it("ten calls with no lead, a stale lead or a time that is not open never touch the company's ceiling", async () => {
    for (let i = 0; i < 4; i++) {
      world([lead()]);
      await pick({ leadId: null });
      world([lead({ created_at: ago(50), updated_at: ago(30) })]);
      await pick();
    }
    ot.onDay = [T1030];
    for (let i = 0; i < 2; i++) {
      world([lead()]);
      expect((await pick()).taken).toBe(true);
    }
    expect(limits.seen.filter(([k]) => k.startsWith("pick-org:"))).toEqual([]);
  });

  it("over the ceiling, a real booking writes no row, pings the office and reads the generic sentence", async () => {
    limits.blocked.add(`pick-org:${ORG}`);
    const mine = lead();
    const db = world([mine]);
    expect(await pick()).toEqual({ ok: true });
    expect(db.tables.appointments).toEqual([]);
    expect(mine.site_inspection_required).toBe(true);
    expect(sent.bell[0][2].title).toBe(SEND_TIMES);
  });
});

describe("F3 (skeptic #87, S3) · one lead, one visit", () => {
  it("two picks for one lead at two different times in the same instant leave ONE visit and one 'booked'", async () => {
    const db = world([lead()]);
    const res = await Promise.all([pick({ at: T9.at }), pick({ at: T1030.at })]);
    expect(inspections(db)).toHaveLength(1);
    expect(res.filter((r) => r.booked)).toHaveLength(1);
    expect(res.filter((r) => !r.booked)).toEqual([{ ok: true }]);
  });

  it("a visit the office wrote for the lead between step 6 and the check takes the pick back: no ping, no times", async () => {
    const db = world([lead()]);
    ot.onDaySideEffect = () =>
      db.tables.appointments.push({ id: "appt-office", org_id: ORG, inquiry_id: LEAD, type: "inspection", status: "scheduled", starts_at: T12.at, created_at: ago(0.001) });
    expect(await pick()).toEqual({ ok: true });
    expect(db.tables.appointments.map((a) => a.id)).toEqual(["appt-office"]);
    expect(sent.bell).toEqual([]);
  });

  it("the lead's other visits are read by company, lead, type and status", async () => {
    const db = world([lead()]);
    await pick();
    const read = db.log.find((l) => l.table === "appointments" && l.op === "select" && l.filters.some((f) => f.startsWith("id!=")) && l.filters.includes(`inquiry_id=${LEAD}`));
    expect(read?.filters.slice(0, 4)).toEqual([`org_id=${ORG}`, `inquiry_id=${LEAD}`, "type=inspection", "status=scheduled"]);
  });
});

describe("F6 (skeptic #87, S10) · a site visit needs an address, asked at the pick", () => {
  it("a lead with no address: the typed one builds the visit's location, fills the lead's blank, and the ring says where", async () => {
    const mine = lead({ address: null });
    const db = world([mine]);
    expect((await pick({ address: "  4 Snowbell Rd, Truckee  " })).booked).toBeTruthy();
    expect(inspections(db)[0].location).toBe("4 Snowbell Rd, Truckee");
    expect(mine.address).toBe("4 Snowbell Rd, Truckee");
    const fill = db.log.find((l) => l.op === "update" && l.table === "inquiries" && "address" in (l.patch ?? {}));
    expect(fill?.filters).toEqual([`id=${LEAD}`, `org_id=${ORG}`, "address is null"]);
    expect(sent.bell[0][2].body).toBe("555-0101 · 4 Snowbell Rd, Truckee");
  });

  it("an empty-string address is filled only while it is still exactly that", async () => {
    const mine = lead({ address: "" });
    const db = world([mine]);
    await pick({ address: "4 Snowbell Rd" });
    expect(mine.address).toBe("4 Snowbell Rd");
    const fill = db.log.find((l) => l.op === "update" && l.table === "inquiries" && "address" in (l.patch ?? {}));
    expect(fill?.filters).toEqual([`id=${LEAD}`, `org_id=${ORG}`, "address="]);
  });

  it("an address the lead already has is NEVER replaced, and the visit goes there", async () => {
    const mine = lead();
    const db = world([mine]);
    await pick({ address: "4 Snowbell Rd" });
    expect(mine.address).toBe("1 Larkspur Way");
    expect(inspections(db)[0].location).toBe("1 Larkspur Way");
    expect(db.log.some((l) => l.op === "update" && l.table === "inquiries" && "address" in (l.patch ?? {}))).toBe(false);
  });

  it("an address somebody wrote meanwhile is kept: the fill misses, is filed with ids, and the visit stands", async () => {
    const mine = lead({ address: null });
    world([mine]);
    ot.onDaySideEffect = () => void (mine.address = "9 Larkspur Ct");
    expect((await pick({ address: "4 Snowbell Rd" })).booked).toBeTruthy();
    expect(mine.address).toBe("9 Larkspur Ct");
    const miss = sent.reported.find((r) => r[0] === "public-schedule:pick-address");
    expect(miss?.[2]).toEqual({ orgId: ORG, leadId: LEAD });
  });

  it("no address anywhere still books, and the ring says No address given", async () => {
    const db = world([lead({ address: null })]);
    expect((await pick()).booked).toBeTruthy();
    expect(inspections(db)[0].location).toBeNull();
    expect(sent.bell[0][2].body).toBe("555-0101 · No address given");
  });
});
