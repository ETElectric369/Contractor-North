import { describe, it, expect, vi } from "vitest";

/**
 * THE HOLDS BACK PILE'S PIPS ON SHIP DAY (Wave 1 seam fix). 0366 has no backfill, so the holds with
 * no day are the ones from before it, the oldest on the list (J-013, J-034, J-048). Their rows were
 * built with since = their day (null), and pileAges reads an empty since as age 0: every old hold
 * drew a grey "new" pip and the amber "waited over a week" mark never lit where it matters. A no-day
 * hold now ages from its last touch; its words stay "No Day Set".
 */

const TODAY = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
const daysAgo = (n: number) => new Date(Date.parse(`${TODAY}T20:00:00Z`) - n * 86_400_000).toISOString();

const state = vi.hoisted(() => ({ held: [] as any[] }));

/** Every read answers empty, except the held-jobs read, told apart by its select. */
function fakeClient() {
  const answer = (table: string, cols: string) => {
    if (table === "jobs" && cols.includes("hold_reason") && cols.includes("hold_until")) return state.held;
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

import { getActionItems } from "./query";
import { pileAges } from "./piles";

const hold = (id: string, num: string, name: string, touched: string, until: string | null) => ({
  id,
  job_number: num,
  name,
  updated_at: touched,
  hold_reason: "Waiting on the customer",
  hold_until: until,
  hold_by: null,
  holder: null,
  customers: { name: "A Customer" },
});

describe("a hold with no day ages from when it was last touched", () => {
  it("old no-day holds draw amber pips; the words still say No Day Set", async () => {
    state.held = [hold("j13", "J-013", "Birch Remodel", daysAgo(40), null), hold("j34", "J-034", "Alder Service", daysAgo(10), null), hold("j48", "J-048", "Tanager Panel", daysAgo(2), null)];
    const r = await getActionItems({ todayStr: TODAY, isStaff: true, userId: "owner-1", tz: "America/Los_Angeles" });
    const pile = r.now.find((i) => i.id === "pile:holds_back");
    expect(pile, "the three holds roll into the Holds Back pile").toBeTruthy();
    const kids = pile!.children!;
    expect(kids.map((k) => k.subtitle)).toEqual(["No Day Set", "No Day Set", "No Day Set"]);
    const byId = Object.fromEntries(kids.map((k) => [k.id, k]));
    const pips = (id: string) => pileAges([byId[id]], TODAY).pips[0];
    expect(pips("onhold-j13")).toBe("old");
    expect(pips("onhold-j34")).toBe("old");
    expect(pips("onhold-j48")).toBe("new");
  });

  it("a hold whose day has come ages from that day, as before", async () => {
    state.held = [hold("j13", "J-013", "Birch Remodel", daysAgo(1), daysAgo(9).slice(0, 10)), hold("j48", "J-048", "Tanager Panel", daysAgo(40), TODAY)];
    const r = await getActionItems({ todayStr: TODAY, isStaff: true, userId: "owner-1", tz: "America/Los_Angeles" });
    const kids = r.now.find((i) => i.id === "pile:holds_back")!.children!;
    const byId = Object.fromEntries(kids.map((k) => [k.id, k]));
    expect(byId["onhold-j13"].since).toBe(daysAgo(9).slice(0, 10));
    expect(byId["onhold-j48"].since).toBe(TODAY);
  });
});
