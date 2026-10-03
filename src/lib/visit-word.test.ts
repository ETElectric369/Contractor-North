import { describe, it, expect, vi } from "vitest";

/**
 * THE STORED TYPE NEVER REACHES A READER AS ITS OWN WORD (2026-10-03).
 *
 * Every screen reads the visit's word from ONE function, appointmentTypeLabel, and
 * inspection-word.test.ts sweeps every string literal in src so no second word can be typed in. A
 * COMPUTED string is invisible to that sweep, and two readers were still capitalising
 * appointments.type by hand instead of asking:
 *
 *   1. My Day → Needs You, the Not Closed Out row. From cn-v1034 (2026-09-30) to 2026-10-03 the
 *      label was Walk-Through, so this
 *      row printed "Marla Finch · Inspection" on the FIRST screen he opens while the planner, the
 *      calendar, the job page, the crew board and Google all said Walk-Through for that same visit.
 *      That split is exactly what Erik reported, and on 2026-10-03 the label went back to Inspection
 *      so the shown word and the stored word are the same word again.
 *   2. Nort's schedule_overview, handed the raw type.
 *
 * THE LABEL AND THE RAW VALUE NOW LOOK ALIKE FOR 'inspection', which is the point — and also why
 * these tests still matter: a hand-capitalised reader would pass on that one type and go on failing
 * on every other ("Service call", "Final inspection", "Client meeting"). So the second test below
 * drives all of them, and both tests compare against appointmentTypeLabel itself rather than a typed
 * literal, so there is nothing here to "update" the next time the owner names a different word.
 */

import { appointmentTypeLabel, ESTIMATE_VISIT_TYPES } from "@/lib/statuses";

/** The word that must never come back on a screen (Erik, 2026-10-03). */
const OLD_WORD = /walk.?through/i;

const TODAY = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
const daysAgo = (n: number) => new Date(Date.parse(`${TODAY}T20:00:00Z`) - n * 86_400_000).toISOString();

const state = vi.hoisted(() => ({ visits: [] as any[] }));

/**
 * Every read answers empty, except the two appointment reads, told apart by their select lists: the
 * Not Closed Out feeder names assigned_to, the write-up feeder names capture. The write-up feeder sees
 * only the estimate-visit types, exactly as its own `.in("type", …)` would, so the skip at query.ts
 * ("already surfaced as a write-up") gets its real chance to fire instead of being assumed away.
 */
function fakeClient() {
  const isEstimateVisit = (t: string) => (ESTIMATE_VISIT_TYPES as readonly string[]).includes(t);
  const answer = (table: string, cols: string): any => {
    if (table === "appointments" && cols.includes("capture")) return state.visits.filter((v) => isEstimateVisit(v.type));
    if (table === "appointments" && cols.includes("assigned_to")) return state.visits;
    if (table === "profiles") return { org_id: "org-1", role: "owner" };
    return [];
  };
  const chain = (table: string) => {
    let cols = "";
    const q: any = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "then") {
            const data = answer(table, cols);
            const rows = Array.isArray(data) ? data : [];
            return (ok: any, err: any) => Promise.resolve({ data: Array.isArray(data) ? rows : data, error: null, count: rows.length }).then(ok, err);
          }
          if (prop === "maybeSingle" || prop === "single") {
            return async () => {
              const data = answer(table, cols);
              return { data: Array.isArray(data) ? (data[0] ?? null) : data, error: null };
            };
          }
          if (prop === "select") {
            return (c?: string) => {
              cols = c ?? "";
              return q;
            };
          }
          return () => q;
        },
      },
    );
    return q;
  };
  return { from: (table: string) => chain(table), rpc: () => chain("rpc") };
}

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => fakeClient() }));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));

import { getActionItems } from "@/lib/action-items/query";
import { runDataTool } from "@/lib/assistant-tools";

/** A past, still-scheduled visit with no field data and nothing settling it: the Not Closed Out shape. */
const visit = (id: string, type: string, title: string | null, who: string) => ({
  id,
  type,
  title,
  starts_at: daysAgo(3),
  status: "scheduled",
  job_id: null,
  inquiry_id: null,
  assigned_to: "owner-1",
  absorbed: false,
  capture: null,
  outcome: null,
  customers: { name: who },
  inquiries: null,
});

async function rowsInPile(pile: string) {
  const r = await getActionItems({ todayStr: TODAY, isStaff: true, userId: "owner-1", tz: "America/Los_Angeles" });
  const p = r.now.find((i) => i.id === `pile:${pile}`);
  expect(p, `the visits roll into ${pile}`).toBeTruthy();
  return Object.fromEntries(p!.children!.map((c) => [c.id, c]));
}

const closeOutRows = () => rowsInPile("visits_to_close_out");

describe("Needs You's Not Closed Out row says Inspection", () => {
  it("the subtitle and the untitled row's title both read the type by its label", async () => {
    state.visits = [visit("ap1", "inspection", null, "Marla Finch"), visit("ap2", "inspection", "Kitchen hood outlet", "Tess Zane")];
    const rows = await closeOutRows();

    // An untitled visit falls back to the type — and to the ONE function that words it.
    const word = appointmentTypeLabel("inspection");
    expect(word).toBe("Inspection");
    expect(rows["ap1"].title).toBe(word);
    expect(rows["ap1"].subtitle).toBe(`Marla Finch · ${word}`);
    // A titled visit keeps its title; the type still rides the subtitle.
    expect(rows["ap2"].title).toBe("Kitchen hood outlet");
    expect(rows["ap2"].subtitle).toBe(`Tess Zane · ${word}`);

    // And the word he threw out is nowhere on the row a person reads.
    for (const row of Object.values(rows)) {
      expect(`${row.title} ${row.subtitle ?? ""}`, row.id).not.toMatch(OLD_WORD);
    }
  });

  it("every other type reads by its label too, so no second rule can grow back here", async () => {
    state.visits = [
      visit("sc", "service_call", null, "Marla Finch"),
      visit("ca", "call", null, "Tess Zane"),
      visit("fi", "final_inspection", null, "Marla Finch"),
      visit("qu", "quote", null, "Tess Zane"),
      visit("me", "meeting", null, "Marla Finch"),
    ];
    const rows = await closeOutRows();
    // Hand-capitalising gave "Service call", "Call", "Final inspection", "Quote", "Meeting" — so
    // these are the types that still catch a reader inventing its own word.
    expect(rows["sc"].title).toBe("Service Call");
    expect(rows["ca"].title).toBe("Phone Call");
    expect(rows["fi"].title).toBe("Final Inspection"); // the CITY'S, its own type, its own name
    expect(rows["qu"].title).toBe("Quote / Estimate");
    expect(rows["me"].title).toBe("Client Meeting");
    // Said once more against the one rule, so a renamed label cannot leave this row behind.
    for (const [id, type] of [["sc", "service_call"], ["ca", "call"], ["fi", "final_inspection"], ["qu", "quote"], ["me", "meeting"]] as const) {
      expect(rows[id].title, id).toBe(appointmentTypeLabel(type));
    }
  });
});

/**
 * THE OTHER FEEDER OFF THE SAME TABLE, which had the word typed into it: Inspections To Write Up
 * read `a.title || "Inspection"`. It carries every ESTIMATE_VISIT_TYPE, so that literal printed
 * "Inspection" over an untitled QUOTE visit and over the city's Final Inspection — two rows calling
 * themselves something they are not, on the first screen he opens.
 */
describe("Needs You's To Write Up row reads the type by its label too", () => {
  it("an untitled quote visit is a Quote / Estimate, and the city's stays Final Inspection", async () => {
    // Completed, nothing settling it (no job, no inquiry, no outcome) — the write-up shape.
    const done = (id: string, type: string, title: string | null) => ({ ...visit(id, type, title, "Marla Finch"), status: "completed" });
    state.visits = [done("w1", "inspection", null), done("w2", "quote", null), done("w3", "final_inspection", null), done("w4", "inspection", "Kitchen hood outlet")];
    const rows = await rowsInPile("inspections_to_write_up");

    expect(rows["w1"].title).toBe(appointmentTypeLabel("inspection"));
    expect(rows["w1"].title).toBe("Inspection");
    expect(rows["w2"].title).toBe("Quote / Estimate");
    expect(rows["w3"].title).toBe("Final Inspection");
    expect(rows["w4"].title).toBe("Kitchen hood outlet");
    for (const row of Object.values(rows)) {
      expect(`${row.title} ${row.subtitle ?? ""}`, row.id).not.toMatch(OLD_WORD);
    }
  });
});

/** Enough of the builder for schedule_overview's four reads, answering by table. */
function fakeScheduleDb(appts: any[]) {
  const rows = (table: string) => (table === "appointments" ? appts : []);
  const chain = (table: string) => {
    const q: any = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "then") return (ok: any, err: any) => Promise.resolve({ data: rows(table), error: null }).then(ok, err);
          if (prop === "maybeSingle") return async () => ({ data: null, error: null }); // no org settings row → defaults
          return () => q;
        },
      },
    );
    return q;
  };
  return { from: (table: string) => chain(table) };
}

describe("Nort reads the visit by its label, not the stored type", () => {
  it("schedule_overview hands him the label, never the raw stored type and never the old word", async () => {
    const db = fakeScheduleDb([
      { id: "ap1", title: null, type: "inspection", starts_at: `${TODAY}T17:00:00.000Z`, ends_at: null, location: null, status: "scheduled", customers: { name: "Marla Finch" }, jobs: null },
      { id: "ap2", title: "Breaker swap", type: "service_call", starts_at: `${TODAY}T20:00:00.000Z`, ends_at: null, location: null, status: "scheduled", customers: { name: "Tess Zane" }, jobs: null },
      // A TITLE STORED between cn-v1034 (2026-09-30) and 2026-10-03, which is what Erik's own test
      // bookings carry. Handed over as stored, Nort says the other word back beside a type that says
      // Inspection — the same split, in his mouth (lib/statuses visitTitle).
      { id: "ap3", title: "Walk-Through: Tom Goodman", type: "inspection", starts_at: `${TODAY}T22:00:00.000Z`, ends_at: null, location: null, status: "scheduled", customers: { name: "Tom Goodman" }, jobs: null },
    ]);
    const out = JSON.parse(await runDataTool("schedule_overview", { date: TODAY }, db));
    const byId = Object.fromEntries(out.appointments.map((a: any) => [a.id, a]));
    expect(byId["ap1"].type).toBe(appointmentTypeLabel("inspection"));
    expect(byId["ap1"].type).toBe("Inspection");
    expect(byId["ap3"].title).toBe("Inspection: Tom Goodman");
    expect(byId["ap2"].title).toBe("Breaker swap"); // a title a person typed is his
    // The RAW value is lowercase; the label is the word. A reader handing over the stored string
    // would fail here, which is the defect this test exists for.
    expect(byId["ap1"].type).not.toBe("inspection");
    expect(byId["ap2"].type).toBe("Service Call");
    expect(JSON.stringify(out.appointments)).not.toMatch(OLD_WORD);
    // The id is still the handle a reschedule takes, so labelling the word costs him nothing.
    expect(byId["ap1"].id).toBe("ap1");
  });
});
