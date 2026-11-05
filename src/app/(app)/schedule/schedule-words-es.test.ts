import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * THE SCHEDULE'S ANSWERS IN THE CALLER'S LANGUAGE (the agenda-in-Spanish wave): a Spanish-reading
 * office gets every refusal and note from lib/words/agenda-server in Spanish (the profile's language,
 * read once per call), a plural as its own sentence, a day in Spanish; an English reader gets the very
 * bytes the actions always said. Without a database: the worked-day fake, plus the caller's profile.
 */
type Row = Record<string, any>;
const db = vi.hoisted(() => ({
  jobs: [] as Row[],
  segments: [] as Row[],
  entries: [] as Row[],
  appts: [] as Row[],
  writes: [] as { table: string; op: string; patch?: Row }[],
  tz: "America/Los_Angeles",
  language: "es" as string,
}));

function builder(table: string) {
  const filters: ((r: Row) => boolean)[] = [];
  let op: "select" | "update" | "insert" | "delete" = "select";
  let patch: Row | null = null;
  let inserted: Row[] = [];
  let returning = false;
  let single = false;
  let orderBy: string | null = null;
  const rowsOf = (): Row[] =>
    table === "jobs" ? db.jobs : table === "job_schedule_segments" ? db.segments : table === "time_entries" ? db.entries : table === "appointments" ? db.appts : [];
  const run = () => {
    if (table === "organizations") return { data: single ? { settings: { timezone: db.tz, work_day_start: "09:00", work_day_end: "17:00" } } : [], error: null };
    if (table === "schedule_proposals") return { data: [], error: null };
    // The caller's profile: the one language read an answer with words makes (lib/lang-of callerLang).
    if (table === "profiles") return { data: single ? { language: db.language } : [{ language: db.language }], error: null };
    const all = rowsOf();
    const hit = all.filter((r) => filters.every((f) => f(r)));
    if (op === "insert") {
      db.writes.push({ table, op });
      for (const r of inserted) all.push({ id: `row-${all.length + 1}`, ...r });
      return { data: returning ? inserted : null, error: null };
    }
    if (op === "delete") {
      db.writes.push({ table, op });
      for (const r of hit) all.splice(all.indexOf(r), 1);
      return { data: null, error: null };
    }
    if (op === "update") {
      db.writes.push({ table, op, patch: patch! });
      for (const r of hit) Object.assign(r, patch);
      return { data: returning ? hit.map((r) => ({ id: r.id })) : null, error: null };
    }
    const out = orderBy ? [...hit].sort((a, b) => String(a[orderBy!]).localeCompare(String(b[orderBy!]))) : hit;
    const copy = out.map((r) => ({ ...r }));
    return { data: single ? (copy[0] ?? null) : copy, error: null };
  };
  const b: any = {
    select: () => ((returning = op !== "select"), b),
    insert: (r: Row | Row[]) => ((op = "insert"), (inserted = Array.isArray(r) ? r : [r]), b),
    update: (p: Row) => ((op = "update"), (patch = p), b),
    delete: () => ((op = "delete"), b),
    eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), b),
    in: (c: string, v: unknown[]) => (filters.push((r) => v.includes(r[c])), b),
    lte: (c: string, v: string) => (filters.push((r) => r[c] != null && String(r[c]) <= v), b),
    lt: (c: string, v: string) => (filters.push((r) => r[c] != null && String(r[c]) < v), b),
    gte: (c: string, v: string) => (filters.push((r) => r[c] != null && String(r[c]) >= v), b),
    order: (c: string) => ((orderBy = c), b),
    limit: () => b,
    maybeSingle: async () => ((single = true), run()),
    then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(run()).then(ok, bad),
  };
  return b;
}
const client = { from: (t: string) => builder(t) };

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => client), createServiceClient: vi.fn(() => client) }));
vi.mock("@/lib/staff-guard", () => ({ requireStaff: async () => ({ supabase: { from: (t: string) => builder(t) }, userId: "office-1", orgId: "org-1" }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("@/lib/calendar-sync", () => ({ pushCalendarItem: vi.fn(async () => undefined) }));
vi.mock("@/lib/crew-notify", () => ({ notifyJobCrewAdded: vi.fn(async () => undefined) }));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));

const { addJobDay, bookWorkedDay, clearJobDate, moveJobDay, unbookWorkedDay } = await import("./actions");
const { todayStrInTz, tzDateTimeUtc } = await import("@/lib/tz");
const { addDays, shortDay } = await import("@/lib/come-back-days");
const { dayWords } = await import("@/lib/schedule/job-block");

const LA = "America/Los_Angeles";
const today = () => todayStrInTz(LA);
const at = (ymd: string, hm: string) => tzDateTimeUtc(ymd, hm, LA) as string;
const enShort = (ymd: string) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

beforeEach(() => {
  db.jobs = [];
  db.segments = [];
  db.entries = [];
  db.appts = [];
  db.writes = [];
  db.language = "es";
});

/** Larkspur: planned ahead, worked on the days given (each a past day, two hours). */
function larkspur(worked: string[]) {
  const planned = addDays(today(), 5);
  db.jobs = [{ id: "j1", name: "14 Larkspur Lane", job_number: "J-101", status: "scheduled", scheduled_start: at(planned, "09:00"), scheduled_end: at(planned, "11:00"), planned_minutes: 120 }];
  db.segments = [
    { id: "s0", job_id: "j1", start_date: planned, end_date: planned, start_time: null, end_time: null },
    ...worked.map((d, i) => ({ id: `s${i + 1}`, job_id: "j1", start_date: d, end_date: d, start_time: null, end_time: null })),
  ];
  db.entries = worked.map((d, i) => ({ id: `e${i}`, profile_id: "p-1", job_id: "j1", clock_in: at(d, "09:00"), clock_out: at(d, "11:00") }));
}

describe("a Spanish reader", () => {
  it("a refusal is the Spanish sentence, and a stored status reads in Spanish inside it (a slot)", async () => {
    expect(await moveJobDay("j1", null, "not-a-day")).toEqual({ ok: false, error: "Elige el día al que moverlo." });
    db.jobs = [{ id: "j1", name: "Snowbell Deck", status: "complete", scheduled_start: null, scheduled_end: null, planned_minutes: null }];
    const res = await addJobDay("j1", { day: addDays(today(), 2) });
    expect(res.ok).toBe(false);
    // The status slot reads lower case mid-sentence in Spanish ("está terminado", not "está Terminado").
    expect(res.error).toBe("Snowbell Deck está terminado, así que no puede tomar otro día. Primero cambia su estado en la página del trabajo.");
    expect(res.error).not.toMatch(/is |can't/);
  });

  it("a note names the day in Spanish and the job in its slot", async () => {
    const worked = addDays(today(), -3);
    db.jobs = [{ id: "j2", name: "9 Bayberry Court", job_number: "J-102", status: "scheduled", scheduled_start: null, scheduled_end: null, planned_minutes: null }];
    db.entries = [{ id: "e1", profile_id: "p-1", job_id: "j2", clock_in: at(worked, "10:00"), clock_out: at(worked, "12:00") }];
    const booked = await bookWorkedDay("j2", worked);
    expect(booked.note?.startsWith(`Se agregó el ${dayWords(worked, "es")} a la agenda de `)).toBe(true);
    expect(booked.note).toMatch(/J-102.*\.$/);
    const again = await unbookWorkedDay("j2", addDays(today(), -4));
    expect(again.ok).toBe(false); // nobody clocked that day
    expect(again.error).toMatch(/^Nadie marcó tiempo en .*J-102.* el .+, así que no hay nada que agendar\.$/);
  });

  it("a plural is its own sentence: one kept day, two kept days (\"y\" joins them)", async () => {
    const d1 = addDays(today(), -6);
    const d2 = addDays(today(), -5);
    larkspur([d1]);
    const one = await clearJobDate("j1");
    expect(one.note).toBe(`${shortDay(d1, "es")} se quedó en el calendario: ese día se trabajó.`);
    larkspur([d1, d2]);
    const two = await clearJobDate("j1");
    expect(two.note).toBe(`${shortDay(d1, "es")} y ${shortDay(d2, "es")} se quedaron en el calendario: esos días se trabajó.`);
  });
});

describe("an English reader gets the same bytes as before the wave", () => {
  it("the refusal, the plural and the note", async () => {
    db.language = "en";
    expect(await moveJobDay("j1", null, "not-a-day")).toEqual({ ok: false, error: "Pick a day to move it to." });
    const d1 = addDays(today(), -6);
    const d2 = addDays(today(), -5);
    larkspur([d1, d2]);
    expect((await clearJobDate("j1")).note).toBe(`Kept ${enShort(d1)} and ${enShort(d2)} on the calendar: work was done on those days.`);
  });

  it("a status in its slot reads as it always did (\"is complete\")", async () => {
    db.language = "en";
    db.jobs = [{ id: "j1", name: "Snowbell Deck", status: "complete", scheduled_start: null, scheduled_end: null, planned_minutes: null }];
    const res = await addJobDay("j1", { day: addDays(today(), 2) });
    expect(res.error).toBe("Snowbell Deck is complete, so it can't take another day. Change its status on the job page first.");
  });
});
