import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * THE CLOCK'S SERVER ACTIONS ANSWER IN THE CALLER'S LANGUAGE, AND A LINE SENT TO SOMEBODY ELSE IS
 * WRITTEN IN THAT PERSON'S (cn-v1138, builder T2). Pinned without a database: the fake refuses any
 * statement it was not told about, and profiles.language is what decides the words.
 *
 *   · stopShift: "You're Clocked Out" goes to the crew member through createNotifications' function
 *     form (one call answers Spanish for "es" and English for "en") and the push in the language
 *     langOf read for that one person; the office's own sentence is in the office's language.
 *   · notifyGeofenceExit: "Clock out?" through notifyPeople's function form, "the job site" in each
 *     language when the job has no label.
 *   · geoClockOut: a terminal refusal carries `ended: true` in any language.
 *   · clockOutCurrent / clockIn: a Spanish tech reads Spanish; an English tech reads what he read before.
 *   · setCrewDayAssignment: "Crew assignment" per reader, the push in the member's language.
 */
const state = vi.hoisted(() => ({ client: null as any }));
const spies = vi.hoisted(() => ({ notify: [] as any[], push: [] as any[], people: [] as any[] }));

vi.mock("@/lib/staff-guard", () => ({
  requireStaff: vi.fn(async () => ({ supabase: state.client, userId: "user-1", orgId: "org-1" })),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => state.client),
  createServiceClient: vi.fn(() => state.client),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));
vi.mock("@/lib/notifications", () => ({
  createNotifications: vi.fn(async (...a: any[]) => void spies.notify.push(a)),
  notifyPeople: vi.fn(async (...a: any[]) => { spies.people.push(a); return { bell: true, pushed: [] }; }),
}));
vi.mock("@/lib/push", () => ({
  sendPushToProfiles: vi.fn(async (...a: any[]) => void spies.push.push(a)),
  orgStaffIds: vi.fn(async () => ["office-1", "user-1"]),
}));
vi.mock("../schedule/actions", () => ({ setJobCrew: vi.fn(async () => ({ ok: true })) }));

import { clockIn, clockOutCurrent, geoClockOut, notifyGeofenceExit, stopShift } from "./actions";
import { setCrewDayAssignment } from "./crew-actions";
import { dict, fillText } from "@/lib/i18n";

const en = dict("en");
const es = dict("es");

type Q = { table: string; verb: "select" | "insert" | "update" | "delete" | "upsert" | "rpc"; cols: string; payload?: any; filters: any[] };
type Reply = { data?: any; error?: any } | undefined;

function fakeSupabase(route: (q: Q) => Reply, calls: Q[]) {
  const answer = (q: Q) => {
    const r = route(q);
    if (r === undefined) throw new Error(`unrouted: ${q.table}.${q.verb} [${q.cols}] ${JSON.stringify(q.filters)}`);
    return { data: r.data ?? null, error: r.error ?? null };
  };
  return {
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
    rpc(fn: string, args: any) {
      const q: Q = { table: `rpc:${fn}`, verb: "rpc", cols: "", payload: args, filters: [] };
      calls.push(q);
      return Promise.resolve(answer(q));
    },
    from(table: string) {
      const q: Q = { table, verb: "select", cols: "", filters: [] };
      calls.push(q);
      const chain: any = {
        select(cols?: string) { if (q.verb === "select") q.cols = cols ?? ""; return chain; },
        insert(p: any) { q.verb = "insert"; q.payload = p; return chain; },
        update(p: any) { q.verb = "update"; q.payload = p; return chain; },
        upsert(p: any) { q.verb = "upsert"; q.payload = p; return chain; },
        delete() { q.verb = "delete"; return chain; },
        single() { return Promise.resolve(answer(q)); },
        maybeSingle() { return Promise.resolve(answer(q)); },
        then(resolve: any, reject: any) {
          try { resolve(answer(q)); } catch (e) { reject?.(e); }
        },
      };
      for (const m of ["eq", "neq", "in", "is", "not", "gt", "gte", "lt", "lte", "or", "overlaps", "order", "limit", "contains"]) {
        chain[m] = (...args: any[]) => { q.filters.push([m, ...args]); return chain; };
      }
      return chain;
    },
  };
}

const ENTRY = "0c7fae89-0000-4000-8000-000000000001";
const JOB = "a0000000-0000-4000-8000-00000000011b";
const PUNCH = "a0000000-0000-4000-8000-00000000000a";
const CLOCK_IN = "2001-01-01T21:37:00.000Z"; // 1:37 PM Pacific, a day nobody worked
const SETTINGS = { data: { settings: { timezone: "America/Los_Angeles", timeclock_job_codes: true } } };

/** The two language reads: the caller's (callerLang) and a named person's (langOf). */
const languages = (caller: "en" | "es", people: Record<string, "en" | "es">) => (q: Q): Reply => {
  if (q.table !== "profiles") return undefined;
  if (q.cols === "language") return { data: { language: caller } };
  if (q.cols === "id, language") return { data: Object.entries(people).map(([id, language]) => ({ id, language })) };
  return undefined;
};

let calls: Q[] = [];
beforeEach(() => {
  calls = [];
  spies.notify = [];
  spies.push = [];
  spies.people = [];
});

describe("stopShift: the crew member is told in their own language, the office reads its own", () => {
  const openRow = {
    id: ENTRY, profile_id: "brian-1", org_id: "org-1", clock_in: CLOCK_IN, clock_out: null, status: "open", job_id: JOB, notes: null, paid_at: null, split_from: null,
    profiles: { full_name: "Brian Taylor" }, job: { job_number: "J-011", name: "Larkspur" },
  };
  const routes = (caller: "en" | "es", brian: "en" | "es") => (q: Q): Reply => {
    const lang = languages(caller, { "brian-1": brian })(q);
    if (lang) return lang;
    if (q.table === "organizations") return SETTINGS;
    if (q.table === "profiles") return { data: { full_name: "Erik Taylor" } };
    if (q.table === "jobs") return { data: { id: JOB, job_number: "J-011", name: "Larkspur" } };
    if (q.table === "time_entries" && q.verb === "select" && /status/.test(q.cols)) return { data: openRow };
    if (q.table === "time_entries" && q.verb === "select") return { data: [] }; // the overlap read: a clear day
    if (q.table === "time_entries" && q.verb === "update") return { data: [{ id: ENTRY }] };
    return undefined;
  };

  it("ONE call carries both languages: the function form answers Spanish for es and English for en; the push follows langOf", async () => {
    state.client = fakeSupabase(routes("en", "es"), calls);
    const r = await stopShift({ entry_id: ENTRY, clock_out: "2001-01-02T01:00:00.000Z", lunch_minutes: 30 });
    expect(r.ok).toBe(true);
    // The office (English) reads its sentence as before.
    expect(r.sentence).toBe("Brian is Clocked Out: 2.88 h on Larkspur, Mon Jan 1, 1:37 PM to 5:00 PM. Brian has been told.");
    expect(spies.notify).toHaveLength(1);
    const [org, to, byLang] = spies.notify[0];
    expect(org).toBe("org-1");
    expect(to).toEqual(["brian-1"]);
    expect(typeof byLang).toBe("function");
    const esLine = byLang("es");
    const enLine = byLang("en");
    expect(esLine).toMatchObject({ type: "clock_stopped", title: "Tienes Salida Marcada", url: "/timeclock" });
    // The Spanish clock is "5:00 pm" (plainSpaces strips ICU's dots), so the sentence keeps its own period.
    expect(esLine.body).toBe("Erik te marcó salida a las 5:00 pm: 2.88 h en Larkspur, lun 1 ene, de 1:37 pm a 5:00 pm, 30 min de almuerzo. Si no es correcto, díselo a Erik.");
    expect(esLine.body).not.toMatch(/[  ]/);
    expect(enLine).toMatchObject({ type: "clock_stopped", title: "You're Clocked Out", url: "/timeclock" });
    expect(enLine.body).toBe("Erik clocked you out at 5:00 PM: 2.88 h on Larkspur, Mon Jan 1, 1:37 PM to 5:00 PM, 30 min lunch. If that is wrong, tell Erik.");
    // The bare push resolved Brian's language once (langOf) and went out in Spanish.
    expect(spies.push).toHaveLength(1);
    expect(spies.push[0][0]).toEqual(["brian-1"]);
    expect(spies.push[0][1]).toBe("clock_out");
    expect(spies.push[0][2].title).toBe("Tienes Salida Marcada");
    expect(spies.push[0][2].body).toBe(esLine.body);
    expect(calls.some((c) => c.table === "profiles" && c.cols === "id, language")).toBe(true);
  });

  it("an English crew member's push is the English line, byte for byte what it was", async () => {
    state.client = fakeSupabase(routes("en", "en"), calls);
    await stopShift({ entry_id: ENTRY, clock_out: "2001-01-02T01:00:00.000Z", lunch_minutes: 0 });
    expect(spies.push[0][2]).toEqual({
      title: "You're Clocked Out",
      body: "Erik clocked you out at 5:00 PM: 3.38 h on Larkspur, Mon Jan 1, 1:37 PM to 5:00 PM, no lunch. If that is wrong, tell Erik.",
      url: "/timeclock",
    });
  });

  it("a Spanish office reads the whole sentence in Spanish on the company's clock — the headline, the facts, who was told; a refusal too", async () => {
    state.client = fakeSupabase(routes("es", "en"), calls);
    const r = await stopShift({ entry_id: ENTRY, clock_out: "2001-01-02T01:00:00.000Z", lunch_minutes: 0 });
    // The headline and "has been told" come from clockedOutWords in the office's language (cn-v1138);
    // the clock reads "pm" so the sentence's own period stands.
    expect(r.sentence).toBe("Brian Tiene Salida Marcada: 3.38 h en Larkspur, lun 1 ene, de 1:37 pm a 5:00 pm. Ya se le avisó a Brian.");
    expect(r.sentence).not.toContain("..");
    expect(spies.push[0][2].title).toBe("You're Clocked Out"); // Brian reads English
    calls = [];
    state.client = fakeSupabase(routes("es", "en"), calls);
    expect(await stopShift({ entry_id: ENTRY, clock_out: "not a time", lunch_minutes: 0 })).toEqual({ ok: false, error: es.cs_pickTimeShiftStopped });
  });
});

describe("notifyGeofenceExit: Clock out? in the reader's language, the job site named in it too", () => {
  const routes = (q: Q): Reply => {
    if (q.table === "profiles") return { data: { role: "tech", org_id: "org-1" } };
    if (q.table === "time_entries" && q.verb === "select") return { data: { id: ENTRY, last_geofence_push_at: null } };
    if (q.table === "time_entries" && q.verb === "update") return { data: null };
    return undefined;
  };
  it("one call, both languages, with the label", async () => {
    state.client = fakeSupabase(routes, calls);
    expect(await notifyGeofenceExit("41 Larkspur")).toEqual({ ok: true });
    expect(spies.people).toHaveLength(1);
    const [org, ids, kind, byLang] = spies.people[0];
    expect([org, ids, kind]).toEqual(["org-1", ["user-1"], "clock_out"]);
    expect(byLang("es")).toEqual({ title: "¿Marcar salida?", body: "Parece que saliste de 41 Larkspur — sigues en el reloj.", url: "/timeclock" });
    expect(byLang("en")).toEqual({ title: "Clock out?", body: "Looks like you left 41 Larkspur — you're still on the clock.", url: "/timeclock" });
  });
  it("a job with no label is the job site in each language", async () => {
    state.client = fakeSupabase(routes, calls);
    await notifyGeofenceExit();
    const byLang = spies.people[0][3];
    expect(byLang("es").body).toBe("Parece que saliste de el sitio de trabajo — sigues en el reloj.".replace("de el", "de el"));
    expect(byLang("es").body).toContain(es.gf_theJobSite);
    expect(byLang("en").body).toBe("Looks like you left the job site — you're still on the clock.");
  });
});

describe("geoClockOut and clockOutCurrent: a Spanish tech reads Spanish, and a terminal refusal says ended", () => {
  it("geoClockOut with nothing open: ended, in the caller's language", async () => {
    state.client = fakeSupabase((q) => languages("es", {})(q) ?? (q.table === "time_entries" ? { data: null } : undefined), calls);
    expect(await geoClockOut(null, "2001-01-02T01:00:00.000Z", false, ENTRY)).toEqual({ ok: false, error: es.cs_notClockedIn, ended: true });
    state.client = fakeSupabase((q) => languages("en", {})(q) ?? (q.table === "time_entries" ? { data: null } : undefined), calls);
    expect(await geoClockOut(null, "2001-01-02T01:00:00.000Z", false, ENTRY)).toEqual({ ok: false, error: "Not clocked in.", ended: true });
  });
  it("geoClockOut on a shift the monitor was not watching: ended, in Spanish", async () => {
    state.client = fakeSupabase((q) => languages("es", {})(q) ?? (q.table === "time_entries" ? { data: { id: PUNCH, notes: null, lunch_minutes: 0 } } : undefined), calls);
    expect(await geoClockOut(null, "2001-01-02T01:00:00.000Z", true, ENTRY)).toEqual({ ok: false, error: es.cs_shiftAlreadyEnded, ended: true });
    expect(calls.some((c) => c.verb === "update")).toBe(false);
  });
  it("clockOutCurrent with no open entry", async () => {
    state.client = fakeSupabase((q) => languages("es", {})(q) ?? (q.table === "time_entries" ? { data: null } : undefined), calls);
    expect(await clockOutCurrent({})).toEqual({ ok: false, error: es.cs_youreNotClockedIn });
    state.client = fakeSupabase((q) => languages("en", {})(q) ?? (q.table === "time_entries" ? { data: null } : undefined), calls);
    expect(await clockOutCurrent({})).toEqual({ ok: false, error: "You're not clocked in." });
  });
});

describe("clockIn: the language rides on the punch's own profile read, and names the job it could not read in it", () => {
  const brianOnLarkspur = (lang: "en" | "es") => (q: Q): Reply => {
    if (q.table === "profiles" && q.cols === "org_id, language") return { data: { org_id: "org-1", language: lang } };
    if (q.table === "profiles") return { data: { role: "tech" } };
    if (q.table === "organizations") return SETTINGS;
    if (q.table === "crew_day_assignments") return { data: { job_id: JOB, kind: "job" } };
    if (q.table === "jobs" && q.cols === "id") return { data: { id: JOB } };
    if (q.table === "jobs" && q.cols.startsWith("org_id")) return { data: { org_id: "org-1", status: "scheduled" } };
    if (q.table === "jobs" && q.verb === "update") return { data: [] };
    if (q.table === "jobs" && q.cols.startsWith("id, job_number")) return { data: null }; // the label read comes back empty
    if (q.table === "time_entries" && q.verb === "insert") return { data: { id: PUNCH } };
    return undefined;
  };
  it("Spanish: the unread label and the sentence's job are in Spanish; English: unchanged", async () => {
    state.client = fakeSupabase(brianOnLarkspur("es"), calls);
    const r = await clockIn({ job_id: null, job_code: null, gps: null });
    expect(r.ok).toBe(true);
    expect(r.jobPick).toMatchObject({ chosenBy: "app", id: JOB, from: "schedule", label: es.cs_unreadJobLabel });
    // No second profile read for the language: the punch's own select carried it.
    expect(calls.filter((c) => c.table === "profiles" && c.cols === "language")).toHaveLength(0);
    calls = [];
    state.client = fakeSupabase(brianOnLarkspur("en"), calls);
    const r2 = await clockIn({ job_id: null, job_code: null, gps: null });
    expect(r2.jobPick).toMatchObject({ chosenBy: "app", label: "a job it couldn't name just now" });
  });
});

describe("setCrewDayAssignment: Crew assignment per reader, the push in the member's language", () => {
  const routes = (caller: "en" | "es", brian: "en" | "es") => (q: Q): Reply => {
    const lang = languages(caller, { "brian-1": brian })(q);
    if (lang) return lang;
    if (q.table === "profiles" && q.cols === "id") return { data: { id: "brian-1" } };
    if (q.table === "jobs") return { data: { id: JOB, org_id: "org-1", job_number: "J-011", name: "Larkspur", assigned_to: ["brian-1"] } };
    if (q.table === "crew_day_assignments" && q.verb === "select") return { data: { job_id: null } };
    if (q.table === "crew_day_assignments" && q.verb === "upsert") return { data: null };
    return undefined;
  };
  it("one call answers both languages; the push is Brian's", async () => {
    state.client = fakeSupabase(routes("en", "es"), calls);
    expect(await setCrewDayAssignment({ profileId: "brian-1", workDate: "2001-01-02", jobId: JOB })).toEqual({ ok: true });
    expect(spies.notify).toHaveLength(1);
    const [org, to, byLang] = spies.notify[0];
    expect([org, to]).toEqual(["org-1", ["brian-1"]]);
    expect(byLang("en")).toEqual({ type: "assigned", title: "Crew assignment", body: "You're on J-011 · Larkspur for Tuesday, January 2.", url: "/timeclock" });
    const esLine = byLang("es");
    expect(esLine).toMatchObject({ type: "assigned", title: "Asignación de cuadrilla", url: "/timeclock" });
    expect(esLine.body).toMatch(/^Estás en J-011 · Larkspur el martes, 2 de enero\.$/);
    expect(spies.push).toHaveLength(1);
    expect(spies.push[0][2].title).toBe("Asignación de cuadrilla");
  });
  it("a Spanish office is refused in Spanish; an English one as before", async () => {
    state.client = fakeSupabase(routes("es", "en"), calls);
    expect(await setCrewDayAssignment({ profileId: "", workDate: "2001-01-02", jobId: JOB })).toEqual({ ok: false, error: es.cs_pickACrewMember });
    expect(await setCrewDayAssignment({ profileId: "brian-1", workDate: "soon", jobId: JOB })).toEqual({ ok: false, error: es.cs_couldntReadDate });
    state.client = fakeSupabase(routes("en", "en"), calls);
    expect(await setCrewDayAssignment({ profileId: "", workDate: "2001-01-02", jobId: JOB })).toEqual({ ok: false, error: "Pick a crew member." });
    expect(en.cs_couldntReadDate).toBe("I couldn't read that date.");
    expect(fillText(en.cs_youreOnJobForDay, { label: "x", day: "y" })).toBe("You're on x for y.");
  });
});
