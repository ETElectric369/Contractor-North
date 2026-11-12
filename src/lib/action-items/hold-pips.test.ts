import { describe, it, expect, vi } from "vitest";

/**
 * THE HOLDS BACK PILE ON SHIP DAY (Wave 1 seam fix; re-pinned for the redraw, cn-v1161). 0366 has no
 * backfill, so the holds with no day are the ones from before it, the oldest on the list. Their rows
 * were built with since = their day (null), and the old pips read an empty since as age 0: every old
 * hold drew a grey "new" pip. A no-day hold now ages from its last touch (`since`); its words stay
 * "No Day Set". The pips are gone. Since cn-v1162 a hold is Due (SOON) only on its own CLOCK: the
 * come-back day somebody picked, from the day it came through seven days after. A hold with no day has
 * no clock and is plain; its last touch orders it (oldest first) and marks nothing.
 */

// A fixed day: the test reads no clock.
const TODAY = "2026-11-11";
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
  it("a hold with no day is plain, and so is its pile; its since is its last touch, the oldest first; the words still say No Day Set", async () => {
    state.held = [hold("j34", "J-034", "Alder Service", daysAgo(10), null), hold("j48", "J-048", "Tupelo Panel", daysAgo(2), null), hold("j13", "J-013", "Birch Remodel", daysAgo(40), null)];
    const r = await getActionItems({ todayStr: TODAY, isStaff: true, userId: "owner-1", tz: "America/Los_Angeles" });
    const pile = r.now.find((i) => i.id === "pile:holds_back");
    expect(pile, "the three holds roll into the Holds Back pile").toBeTruthy();
    expect(pile!.level).toBe("none");
    const kids = pile!.children!;
    expect(kids.map((k) => k.subtitle)).toEqual(["No Day Set", "No Day Set", "No Day Set"]);
    expect(kids.map((k) => k.level)).toEqual(["none", "none", "none"]);
    expect(kids.map((k) => k.clock)).toEqual([null, null, null]);
    // Age is the order now: the oldest touch first, whatever order the read gave them in.
    expect(kids.map((k) => k.id)).toEqual(["onhold-j13", "onhold-j34", "onhold-j48"]);
    const byId = Object.fromEntries(kids.map((k) => [k.id, k]));
    expect(byId["onhold-j13"].since).toBe(daysAgo(40).slice(0, 10));
    expect(byId["onhold-j34"].since).toBe(daysAgo(10).slice(0, 10));
    expect(byId["onhold-j48"].since).toBe(daysAgo(2).slice(0, 10));
    // The pile carries its oldest child's own day, so it sits where that child would have.
    expect(pile!.since).toBe(daysAgo(40).slice(0, 10));
  });

  it("a hold whose day has come: its clock is that day, Due for seven days after, then plain", async () => {
    state.held = [
      hold("j13", "J-013", "Birch Remodel", daysAgo(1), daysAgo(9).slice(0, 10)),
      hold("j21", "J-021", "Larkspur Deck", daysAgo(1), daysAgo(7).slice(0, 10)),
      hold("j48", "J-048", "Tupelo Panel", daysAgo(40), TODAY),
    ];
    const r = await getActionItems({ todayStr: TODAY, isStaff: true, userId: "owner-1", tz: "America/Los_Angeles" });
    const pile = r.now.find((i) => i.id === "pile:holds_back")!;
    const byId = Object.fromEntries(pile.children!.map((k) => [k.id, k]));
    expect(byId["onhold-j13"].since).toBe(daysAgo(9).slice(0, 10));
    expect(byId["onhold-j48"].since).toBe(TODAY);
    expect(byId["onhold-j13"].clock).toBe(daysAgo(9).slice(0, 10));
    expect(byId["onhold-j48"].clock).toBe(TODAY);
    // Back nine days: past the window, plain. Back seven days and back today: Due. The pile wears it.
    expect(byId["onhold-j13"].level).toBe("none");
    expect(byId["onhold-j21"].level).toBe("soon");
    expect(byId["onhold-j48"].level).toBe("soon");
    expect(pile.level).toBe("soon");
  });
});
