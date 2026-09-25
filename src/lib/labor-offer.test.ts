import { describe, it, expect } from "vitest";
import { planLaborOffer } from "./labor-offer";
import { computeJobLaborBilling } from "./labor-billing";

const ERIK = { id: "p-erik", full_name: "Erik Taylor", bill_rate: 115 };
const BRIAN = { id: "p-brian", full_name: "Brian Taylor", bill_rate: 85 };
const shift = (id: string, who: typeof ERIK, day: string, hours: number) => ({
  id,
  clock_in: `${day}T15:00:00Z`,
  clock_out: new Date(new Date(`${day}T15:00:00Z`).getTime() + hours * 3_600_000).toISOString(),
  lunch_minutes: 0,
  job_code: null,
  profiles: who,
});
const bill = (entries: any[]) => computeJobLaborBilling(entries, 95, null).lines;

// J-011 in miniature: Erik's and Brian's lines on INV-078 carry Andrew's negotiated rates (edited),
// each holding the shifts it was negotiated over; then each works a new 6-hour day.
const OLD_E = shift("e-old", ERIK, "2026-08-01", 8);
const OLD_B = shift("b-old", BRIAN, "2026-08-01", 5);
const NEW_E = shift("e-new", ERIK, "2026-09-22", 6);
const NEW_B = shift("b-new", BRIAN, "2026-09-22", 6);
const EDITED = [
  { import_key: "labor:p-erik", edited: true, source_ids: ["e-old"] },
  { import_key: "labor:p-brian", edited: true, source_ids: ["b-old"] },
];

describe("planLaborOffer — new hours beside a negotiated line", () => {
  it("J-011: the new 6 + 6 hours land on their own lines at bill rate; the negotiated lines are offered unchanged", () => {
    const offer = planLaborOffer({ entries: [OLD_E, OLD_B, NEW_E, NEW_B], ownLines: EDITED, dismissed: new Set(), bill });
    const byKey = Object.fromEntries(offer.map((o) => [o.importKey, o.line]));
    expect(Object.keys(byKey).sort()).toEqual(["labor:p-brian", "labor:p-brian:2", "labor:p-erik", "labor:p-erik:2"]);
    expect(byKey["labor:p-erik:2"]).toMatchObject({ quantity: 6, rate: 115, amount: 690, sourceIds: ["e-new"] });
    expect(byKey["labor:p-brian:2"]).toMatchObject({ quantity: 6, rate: 85, amount: 510, sourceIds: ["b-new"] });
    // The card's $1,200 of labor, exactly.
    expect(byKey["labor:p-erik:2"].amount + byKey["labor:p-brian:2"].amount).toBe(1200);
  });

  it("no edited line → exactly today's offer: one line per person, one key", () => {
    const offer = planLaborOffer({
      entries: [OLD_E, NEW_E],
      ownLines: [{ import_key: "labor:p-erik", edited: false, source_ids: ["e-old"] }],
      dismissed: new Set(),
      bill,
    });
    expect(offer.map((o) => o.importKey)).toEqual(["labor:p-erik"]);
    expect(offer[0].line.sourceIds.sort()).toEqual(["e-new", "e-old"]);
  });

  it("an edited line holding every hour → no second line (nothing new to add)", () => {
    const offer = planLaborOffer({ entries: [OLD_E], ownLines: [EDITED[0]], dismissed: new Set(), bill });
    expect(offer.map((o) => o.importKey)).toEqual(["labor:p-erik"]);
  });

  it("the second line edited too → the third takes what is newer still", () => {
    const newer = shift("e-newer", ERIK, "2026-09-23", 2);
    const offer = planLaborOffer({
      entries: [OLD_E, NEW_E, newer],
      ownLines: [EDITED[0], { import_key: "labor:p-erik:2", edited: true, source_ids: ["e-new"] }],
      dismissed: new Set(),
      bill,
    });
    const third = offer.find((o) => o.importKey === "labor:p-erik:3");
    expect(third?.line).toMatchObject({ quantity: 2, sourceIds: ["e-newer"] });
    expect(offer.some((o) => o.importKey === "labor:p-erik:2")).toBe(false); // the edited one is not re-offered
  });

  it("a deleted overflow line is never brought back (the tombstone stops the chain)", () => {
    const offer = planLaborOffer({ entries: [OLD_E, NEW_E], ownLines: [EDITED[0]], dismissed: new Set(["labor:p-erik:2"]), bill });
    expect(offer.map((o) => o.importKey)).toEqual(["labor:p-erik"]);
  });

  it("a deleted base line is left to the RPC's tombstone, as before — no overflow invented", () => {
    const offer = planLaborOffer({ entries: [OLD_E, NEW_E], ownLines: [], dismissed: new Set(["labor:p-erik"]), bill });
    expect(offer.map((o) => o.importKey)).toEqual(["labor:p-erik"]);
  });
});
