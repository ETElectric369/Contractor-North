import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * USE IT, ON THE PANEL (the panel-first wave, P1): a read's line on a space a kept breaker already
 * holds ("Photo says: Wine Cooler" under the kept "Bar") puts its words on THE kept circuit the line
 * was drawn under, and sets the read aside. Pinned against a scripted client in the house's shape
 * (panel-readers.test.ts): every statement is scripted, an unscripted one throws, so each case
 * accounts for all of them.
 *
 *   · the tap names the read, the kept circuit it was drawn under (targetId) and what that line
 *     showed for the field being replaced (seen); the server never recomputes the holder;
 *   · a STALE tap — the kept circuit says something else now, or a crewmate moved it off the space —
 *     writes nothing, says who changed it, and carries the circuit as it is now; a change landing
 *     between the read and the write is caught too (the write is conditioned on what was read);
 *   · the words go to the field they came from (the door's words onto the door label);
 *   · the circuit named must still hold the read's space by lib/panel/held's rule (a 2-pole on 9
 *     holds 11; a quad's centre at 1B holds 3A), on the read's panel (a loose read belongs to the
 *     job's only panel);
 *   · every write is org-scoped and read back; a refusal names one thing to do.
 */

const s = vi.hoisted(() => ({ client: null as any }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => s.client) }));
vi.mock("@/lib/staff-guard", () => ({ requireStaff: vi.fn(async () => ({ error: "This action is staff-only." })) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("@/lib/observe", () => ({ reportError: () => {} }));
vi.mock("@/lib/notifications", () => ({ officeRecipients: vi.fn(), ringOffice: vi.fn() }));
vi.mock("@/app/(app)/materials/actions", () => ({ addMaterialItem: vi.fn(), deleteMaterialItem: vi.fn(), ensureJobMaterialList: vi.fn() }));
vi.mock("@/lib/anthropic", () => ({ getAnthropic: () => null }));
vi.mock("@/lib/ai-cost", () => ({ aiAllowed: vi.fn(), modelFor: () => "model", recordAiUsage: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({ rateLimited: vi.fn(), rateLimitLeft: vi.fn(), rateLimitGiveBack: vi.fn() }));

import { useSuggestedWords as applySuggestedWords } from "./panel-actions";

const ORG = "11111111-1111-4111-8111-111111111111";
const JOB = "22222222-2222-4222-8222-222222222222";
const PANEL = "44444444-4444-4444-8444-444444444444";
const BAR = "55555555-5555-4555-8555-555555555555";
const READ = "66666666-6666-4666-8666-666666666666";
const SPLIT = "77777777-7777-4777-8777-777777777777";
const CENTRE = "88888888-8888-4888-8888-888888888888";

type Call = { table: string; verb: string; payload?: any; filters: string[] };
let calls: Call[];

function fakeSupabase(script: Record<string, any[]>) {
  const next = (key: string) => {
    const q = script[key];
    if (!q || q.length === 0) throw new Error(`unscripted call: ${key}`);
    return q.shift();
  };
  return {
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
    from(table: string) {
      const mine: Call = { table, verb: "select", filters: [] };
      calls.push(mine);
      const chain: any = {
        insert(payload: any) { mine.verb = "insert"; mine.payload = payload; return chain; },
        update(payload: any) { mine.verb = "update"; mine.payload = payload; return chain; },
        select() { return chain; },
        eq(c: string, v: unknown) { mine.filters.push(`eq:${c}:${v}`); return chain; },
        is(c: string, v: unknown) { mine.filters.push(`is:${c}:${v}`); return chain; },
        not(c: string, o: string, v: unknown) { mine.filters.push(`not:${c}:${o}:${v}`); return chain; },
        in(c: string, v: unknown[]) { mine.filters.push(`in:${c}:${v.join(",")}`); return chain; },
        or(e: string) { mine.filters.push(`or:${e}`); return chain; },
        order() { return chain; },
        limit() { return chain; },
        maybeSingle: () => Promise.resolve(next(`${table}.${mine.verb}`)),
        then(resolve: any, reject: any) {
          try { resolve(next(`${table}.${mine.verb}`)); } catch (e) { reject?.(e); }
        },
      };
      return chain;
    },
  };
}

function as(script: Record<string, any[]>) {
  calls = [];
  const me = { data: { role: "tech", org_id: ORG, active: true, full_name: "Catbird Tech" }, error: null };
  s.client = fakeSupabase({ ...script, "profiles.select": [me, ...(script["profiles.select"] ?? [])] });
}

const job = { data: { id: JOB, job_number: "J-201", name: "Thistlewood", customer_id: null }, error: null };
const row = (over: Record<string, unknown>) => ({
  org_id: ORG, job_id: JOB, panel_id: PANEL, room: null, description: null, panel_label: null, amps: 20, poles: 1, kind: null,
  space: null, half: null, work: "existing", progress: "planned", state: "kept", source: "hand", source_row: null, removed_at: null, sort_order: 1, updated_by: null,
  ...over,
});
const bar = row({ id: BAR, room: "Bar", description: "Bar", space: 14, half: "B" });
const read = row({ id: READ, state: "suggested", source: "photo", panel_label: "Wine Cooler", space: 14, half: "B", source_row: { key: "photo:14B" } });
const updates = () => calls.filter((c) => c.verb === "update");

beforeEach(() => {
  calls = [];
});

/** The tap as the tab sends it: the read, the kept circuit it was drawn under, what that line showed. */
const tap = (targetId: string, seen: string | null) => ({ suggestedId: READ, targetId, seen });

describe("useSuggestedWords", () => {
  it("a fresh tap puts the photo's words on the kept circuit's door label, conditioned on what it read, and sets the read aside", async () => {
    as({
      "jobs.select": [job],
      "job_circuits.select": [{ data: read, error: null }, { data: bar, error: null }],
      "job_circuits.update": [
        { data: { ...bar, panel_label: "Wine Cooler" }, error: null },
        { data: { ...read, removed_at: "2026-10-30T12:00:00Z" }, error: null },
      ],
    });
    const r = await applySuggestedWords(JOB, tap(BAR, null));
    expect(r).toMatchObject({ ok: true, field: "panel_label", was: null, words: "Bar now says Wine Cooler." });
    const [onBar, aside] = updates();
    expect(onBar.payload).toEqual({ panel_label: "Wine Cooler" });
    // Org-scoped, this job's, a kept live circuit, and only while its label is still empty.
    expect(onBar.filters).toEqual(expect.arrayContaining([`eq:id:${BAR}`, `eq:org_id:${ORG}`, `eq:job_id:${JOB}`, "eq:state:kept", "is:removed_at:null", "is:panel_label:null"]));
    expect(Object.keys(aside.payload)).toEqual(["removed_at"]);
    expect(aside.filters).toEqual(expect.arrayContaining([`eq:id:${READ}`, `eq:org_id:${ORG}`, "eq:state:suggested", "is:removed_at:null"]));
    // The circuit named is read by its id, in this org: the holder is never recomputed.
    const targetRead = calls.filter((c) => c.table === "job_circuits" && c.verb === "select")[1];
    expect(targetRead.filters).toEqual(expect.arrayContaining([`eq:id:${BAR}`, `eq:org_id:${ORG}`]));
  });

  it("a stale tap is refused BY NAME: the line showed nothing, a crewmate has since labelled it Wet Bar — nothing is written", async () => {
    as({
      "jobs.select": [job],
      "job_circuits.select": [{ data: read, error: null }, { data: { ...bar, panel_label: "Wet Bar", updated_by: "user-2" }, error: null }],
      "profiles.select": [{ data: { full_name: "Larkspur Crew" }, error: null }],
    });
    const r = await applySuggestedWords(JOB, tap(BAR, null));
    expect(r).toMatchObject({ ok: false, error: "Larkspur Crew just changed Bar. It shows what's there now; change it again if it still needs it." });
    expect(r.ok ? null : r.current?.panel_label).toBe("Wet Bar");
    expect(updates()).toHaveLength(0);
  });

  it("a tap that saw the crewmate's words writes over them only because the person saw them: seen 'Wet Bar' is a fresh tap", async () => {
    const wet = { ...bar, panel_label: "Wet Bar", updated_by: "user-2" };
    as({
      "jobs.select": [job],
      "job_circuits.select": [{ data: read, error: null }, { data: wet, error: null }],
      "job_circuits.update": [{ data: { ...wet, panel_label: "Wine Cooler" }, error: null }, { data: { ...read, removed_at: "x" }, error: null }],
    });
    expect(await applySuggestedWords(JOB, tap(BAR, "Wet Bar"))).toMatchObject({ ok: true, was: "Wet Bar", words: "Bar now says Wine Cooler." });
    expect(updates()[0].filters).toContain("eq:panel_label:Wet Bar");
  });

  it("a change landing between the read and the write is caught by the conditioned write, and said by name", async () => {
    as({
      "jobs.select": [job],
      "job_circuits.select": [{ data: read, error: null }, { data: bar, error: null }, { data: { ...bar, panel_label: "Wet Bar", updated_by: "user-2" }, error: null }],
      "job_circuits.update": [{ data: null, error: null }],
      "profiles.select": [{ data: { full_name: "Larkspur Crew" }, error: null }],
    });
    const r = await applySuggestedWords(JOB, tap(BAR, null));
    expect(r).toMatchObject({ ok: false, error: "Larkspur Crew just changed Bar. It shows what's there now; change it again if it still needs it." });
    expect(r.ok ? null : r.current?.panel_label).toBe("Wet Bar");
    expect(updates()).toHaveLength(1);
  });

  it("a circuit a crewmate moved off the read's space is refused by name, with where it is now", async () => {
    as({
      "jobs.select": [job],
      "job_circuits.select": [{ data: read, error: null }, { data: { ...bar, space: 16, updated_by: "user-2" }, error: null }],
      "profiles.select": [{ data: { full_name: "Larkspur Crew" }, error: null }],
    });
    const r = await applySuggestedWords(JOB, tap(BAR, null));
    expect(r).toMatchObject({ ok: false, error: "Larkspur Crew just moved Bar: it isn't on space 14 now. It shows where it is; tap Keep to keep the read as its own circuit." });
    expect(r.ok ? null : r.current?.space).toBe(16);
    expect(updates()).toHaveLength(0);
  });

  it("the circuit named must hold the read's space by the held rule: a 2-pole on 9 holds 11; a quad's centre at 1B holds 3A", async () => {
    const split = row({ id: SPLIT, description: "Mini Split", poles: 2, amps: 30, space: 9 });
    const at11 = { ...read, panel_label: "Heat Pump", space: 11, half: null };
    as({
      "jobs.select": [job],
      "job_circuits.select": [{ data: at11, error: null }, { data: split, error: null }],
      "job_circuits.update": [{ data: { ...split, panel_label: "Heat Pump" }, error: null }, { data: { ...at11, removed_at: "x" }, error: null }],
    });
    expect(await applySuggestedWords(JOB, tap(SPLIT, null))).toMatchObject({ ok: true, words: "Mini Split now says Heat Pump." });
    expect(updates()[0].filters).toContain(`eq:id:${SPLIT}`);

    const centre = row({ id: CENTRE, description: "Floor Heat", poles: 2, space: 1, half: "B" });
    const at3A = { ...read, panel_label: "Radiant", space: 3, half: "A" };
    as({
      "jobs.select": [job],
      "job_circuits.select": [{ data: at3A, error: null }, { data: centre, error: null }],
      "job_circuits.update": [{ data: { ...centre, panel_label: "Radiant" }, error: null }, { data: { ...at3A, removed_at: "x" }, error: null }],
    });
    expect(await applySuggestedWords(JOB, tap(CENTRE, null))).toMatchObject({ ok: true, words: "Floor Heat now says Radiant." });
    expect(updates()[0].filters).toContain(`eq:id:${CENTRE}`);
  });

  it("a read on no panel belongs to the job's only panel (lib/panel/held): Use It writes onto the circuit there", async () => {
    const loose = { ...read, panel_id: null };
    as({
      "jobs.select": [job],
      "job_circuits.select": [{ data: loose, error: null }, { data: bar, error: null }],
      "job_panels.select": [{ data: [{ id: PANEL }], error: null }],
      "job_circuits.update": [{ data: { ...bar, panel_label: "Wine Cooler" }, error: null }, { data: { ...loose, removed_at: "x" }, error: null }],
    });
    expect(await applySuggestedWords(JOB, tap(BAR, null))).toMatchObject({ ok: true, words: "Bar now says Wine Cooler." });
    expect(calls.find((c) => c.table === "job_panels")!.filters).toEqual(expect.arrayContaining([`eq:job_id:${JOB}`, `eq:org_id:${ORG}`, "is:removed_at:null"]));
  });

  it("refuses in plain words, writing nothing: the circuit gone, a label check, a read already gone, not this org's", async () => {
    as({ "jobs.select": [job], "job_circuits.select": [{ data: read, error: null }, { data: { ...bar, removed_at: "2026-10-30T00:00:00Z" }, error: null }] });
    expect(await applySuggestedWords(JOB, tap(BAR, null))).toEqual({ ok: false, error: "The circuit it was drawn under isn't on the panel any more. Reload the Panel tab." });

    as({ "jobs.select": [job], "job_circuits.select": [{ data: { ...read, source_row: { key: "k", flag_for: BAR } }, error: null }] });
    expect(await applySuggestedWords(JOB, tap(BAR, null))).toEqual({ ok: false, error: "That one is a label check. Tap Use It on the check." });

    as({ "jobs.select": [job], "job_circuits.select": [{ data: { ...read, removed_at: "2026-10-30T00:00:00Z" }, error: null }] });
    expect(await applySuggestedWords(JOB, tap(BAR, null))).toMatchObject({ ok: false, error: "That suggestion was already kept or set aside." });

    // Another org's row never comes back from an org-scoped read.
    as({ "jobs.select": [job], "job_circuits.select": [{ data: null, error: null }] });
    expect(await applySuggestedWords(JOB, tap(BAR, null))).toEqual({ ok: false, error: "That suggestion isn't on this job. Reload the Panel tab." });
    expect(calls.find((c) => c.table === "job_circuits")!.filters).toContain(`eq:org_id:${ORG}`);

    as({ "jobs.select": [{ data: null, error: null }] });
    expect(await applySuggestedWords(JOB, tap(BAR, null))).toEqual({ ok: false, error: "That job isn't in your book." });
    expect(calls.some((c) => c.verb === "update")).toBe(false);
  });
});
