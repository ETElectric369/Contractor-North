import { describe, it, expect, vi } from "vitest";

/**
 * THE STORED WORD NEVER REACHES A READER (W2-10 follow-up, 2026-10-03).
 *
 * The rename gave the site visit ONE word — Walk-Through — and walk-through-word.test.ts sweeps every
 * string literal in src so the old one cannot come back. A COMPUTED string is invisible to that sweep,
 * and two readers were still building their own word out of the stored type:
 *
 *   1. My Day → Needs You, the Not Closed Out row, which capitalised appointments.type by hand and so
 *      printed "Marla Finch · Inspection" on the FIRST screen he opens, while the planner, the
 *      calendar, the job page, the crew board and Google all said Walk-Through for that same visit.
 *      Production is mostly type 'inspection' (statuses.ts: 44 rows), so that was the dominant case.
 *   2. Nort's schedule_overview, handed the raw type — while nort-product-map.ts tells him "inspection"
 *      is kept for the CITY'S inspection. So he called a walk-through the one thing the map reserves.
 *
 * These tests DRIVE both readers instead of reading literals: the output itself has to say the word.
 * One rule, one place — appointmentTypeLabel — and these are its teeth.
 */

import { ESTIMATE_VISIT_TYPES } from "@/lib/statuses";

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

async function closeOutRows() {
  const r = await getActionItems({ todayStr: TODAY, isStaff: true, userId: "owner-1", tz: "America/Los_Angeles" });
  const pile = r.now.find((i) => i.id === "pile:visits_to_close_out");
  expect(pile, "the visits roll into the Visits To Close Out pile").toBeTruthy();
  return Object.fromEntries(pile!.children!.map((c) => [c.id, c]));
}

describe("Needs You's Not Closed Out row says Walk-Through", () => {
  it("the subtitle and the untitled row's title both read the type by its label", async () => {
    state.visits = [visit("ap1", "inspection", null, "Marla Finch"), visit("ap2", "inspection", "Kitchen hood outlet", "Tess Zane")];
    const rows = await closeOutRows();

    // An untitled visit falls back to the type — the word, not the stored value.
    expect(rows["ap1"].title).toBe("Walk-Through");
    expect(rows["ap1"].subtitle).toBe("Marla Finch · Walk-Through");
    // A titled visit keeps its title; the type still rides the subtitle.
    expect(rows["ap2"].title).toBe("Kitchen hood outlet");
    expect(rows["ap2"].subtitle).toBe("Tess Zane · Walk-Through");

    // And the old word is nowhere on the row a person reads.
    for (const row of Object.values(rows)) {
      expect(`${row.title} ${row.subtitle ?? ""}`, row.id).not.toMatch(/inspect/i);
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
    // Hand-capitalising gave "Service call", "Call", "Final inspection", "Quote", "Meeting".
    expect(rows["sc"].title).toBe("Service Call");
    expect(rows["ca"].title).toBe("Phone Call");
    expect(rows["fi"].title).toBe("Final Inspection"); // the CITY'S inspection keeps its word
    expect(rows["qu"].title).toBe("Quote / Estimate");
    expect(rows["me"].title).toBe("Client Meeting");
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
  it("schedule_overview hands him Walk-Through, never the word the product map reserves for the city", async () => {
    const db = fakeScheduleDb([
      { id: "ap1", title: null, type: "inspection", starts_at: `${TODAY}T17:00:00.000Z`, ends_at: null, location: null, status: "scheduled", customers: { name: "Marla Finch" }, jobs: null },
      { id: "ap2", title: "Breaker swap", type: "service_call", starts_at: `${TODAY}T20:00:00.000Z`, ends_at: null, location: null, status: "scheduled", customers: { name: "Tess Zane" }, jobs: null },
    ]);
    const out = JSON.parse(await runDataTool("schedule_overview", { date: TODAY }, db));
    const byId = Object.fromEntries(out.appointments.map((a: any) => [a.id, a]));
    expect(byId["ap1"].type).toBe("Walk-Through");
    expect(byId["ap2"].type).toBe("Service Call");
    expect(JSON.stringify(out.appointments)).not.toMatch(/inspect/i);
    // The id is still the handle a reschedule takes, so labelling the word costs him nothing.
    expect(byId["ap1"].id).toBe("ap1");
  });
});
