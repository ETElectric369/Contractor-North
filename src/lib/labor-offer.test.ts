import { describe, it, expect } from "vitest";
import { isHoursUnit, joinedSentence, leftOffSentence, planLaborOffer, rateWords } from "./labor-offer";
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

// J-011 in miniature: Erik's and Brian's lines on INV-078 carry Andrew's negotiated rates ($100/$50,
// edited), each holding the shifts it was negotiated over; then each works a new 6-hour day.
const OLD_E = shift("e-old", ERIK, "2026-08-01", 8);
const OLD_B = shift("b-old", BRIAN, "2026-08-01", 5);
const NEW_E = shift("e-new", ERIK, "2026-09-22", 6);
const NEW_B = shift("b-new", BRIAN, "2026-09-22", 6);
const E_LINE = { id: "li-e", import_key: "labor:p-erik", edited: true, source_ids: ["e-old"], quantity: "8.00", unit_price: "100.00", unit: "hr", description: "Labor - Erik Taylor" };
const B_LINE = { id: "li-b", import_key: "labor:p-brian", edited: true, source_ids: ["b-old"], quantity: "5.00", unit_price: "50.00", unit: "hr", description: "Labor - Brian Taylor" };

describe("planLaborOffer — new hours join the person's line (Erik's INV-078 rule)", () => {
  it("J-011: the new 6 + 6 hours JOIN the two top lines at their own rates; no :2 line is offered", () => {
    const plan = planLaborOffer({ entries: [OLD_E, OLD_B, NEW_E, NEW_B], ownLines: [E_LINE, B_LINE], dismissed: new Set(), bill });
    expect(plan.offer.map((o) => o.importKey).sort()).toEqual(["labor:p-brian", "labor:p-erik"]);
    expect(plan.offer.some((o) => /:\d+$/.test(o.importKey))).toBe(false);
    const byPerson = Object.fromEntries(plan.joins.map((j) => [j.personId, j]));
    expect(byPerson["p-erik"]).toMatchObject({ lineId: "li-e", fromQuantity: 8, addHours: 6, addIds: ["e-new"], heldIds: ["e-old"], rate: 100 });
    expect(byPerson["p-brian"]).toMatchObject({ lineId: "li-b", fromQuantity: 5, addHours: 6, addIds: ["b-new"], rate: 50 });
    expect(joinedSentence(byPerson["p-erik"])).toBe("Added 6 h to Labor - Erik Taylor at $100");
    expect(plan.leftOff).toEqual([]);
  });

  it("no edited line → exactly the old offer: one line per person, refreshed with every hour, nothing joined", () => {
    const plan = planLaborOffer({
      entries: [OLD_E, NEW_E],
      ownLines: [{ ...E_LINE, edited: false }],
      dismissed: new Set(),
      bill,
    });
    expect(plan.offer.map((o) => o.importKey)).toEqual(["labor:p-erik"]);
    expect(plan.offer[0].line.sourceIds.sort()).toEqual(["e-new", "e-old"]);
    expect(plan.joins).toEqual([]);
  });

  it("an edited line holding every hour → nothing to join", () => {
    const plan = planLaborOffer({ entries: [OLD_E], ownLines: [E_LINE], dismissed: new Set(), bill });
    expect(plan.offer.map((o) => o.importKey)).toEqual(["labor:p-erik"]);
    expect(plan.joins).toEqual([]);
  });

  it("an old unedited :2 line beside the edited top line is not offered (the RPC removes it) and its hours join the top line", () => {
    const plan = planLaborOffer({
      entries: [OLD_E, NEW_E],
      ownLines: [E_LINE, { id: "li-e2", import_key: "labor:p-erik:2", edited: false, source_ids: ["e-new"], quantity: 6, unit_price: 115, unit: "hr", description: "Labor - Erik Taylor" }],
      dismissed: new Set(),
      bill,
    });
    expect(plan.offer.map((o) => o.importKey)).toEqual(["labor:p-erik"]);
    expect(plan.joins).toHaveLength(1);
    expect(plan.joins[0]).toMatchObject({ lineId: "li-e", addHours: 6, addIds: ["e-new"], rate: 100 });
  });

  it("an EDITED :2 line keeps its hours; only what neither edited line holds joins the top line", () => {
    const newer = shift("e-newer", ERIK, "2026-09-23", 2);
    const plan = planLaborOffer({
      entries: [OLD_E, NEW_E, newer],
      ownLines: [E_LINE, { id: "li-e2", import_key: "labor:p-erik:2", edited: true, source_ids: ["e-new"], quantity: 6, unit_price: 115, unit: "hr", description: "Labor - Erik Taylor" }],
      dismissed: new Set(),
      bill,
    });
    expect(plan.joins).toHaveLength(1);
    expect(plan.joins[0]).toMatchObject({ lineId: "li-e", addHours: 2, addIds: ["e-newer"] });
  });

  it("INV-078's leftover :2 tombstones don't strand the hours: they join the top line", () => {
    const plan = planLaborOffer({
      entries: [OLD_E, NEW_E],
      ownLines: [E_LINE],
      dismissed: new Set(["labor:p-erik:2", "labor:p-brian:2"]),
      bill,
    });
    expect(plan.joins.map((j) => [j.lineId, j.addHours])).toEqual([["li-e", 6]]);
    expect(plan.leftOff).toEqual([]);
  });

  it("a person whose line the office DELETED is not brought back — the hours are named as left off", () => {
    const plan = planLaborOffer({ entries: [OLD_B, NEW_B], ownLines: [], dismissed: new Set(["labor:p-brian"]), bill });
    expect(plan.offer).toEqual([]);
    expect(plan.joins).toEqual([]);
    expect(plan.leftOff).toEqual([{ personId: "p-brian", name: "Brian Taylor", hours: 11, why: "deleted" }]);
    expect(leftOffSentence(plan.leftOff[0], "INV-078")).toBe(
      "Brian Taylor's labor line was deleted from INV-078, so Brian Taylor's 11 h were not added. They stay unbilled on the job - Start It Over on Labor brings the line back",
    );
  });

  it("a deleted top line with an edited :2 still on the invoice → the :2 is the person's line and takes the hours", () => {
    const newer = shift("e-newer", ERIK, "2026-09-23", 2);
    const plan = planLaborOffer({
      entries: [NEW_E, newer],
      ownLines: [{ id: "li-e2", import_key: "labor:p-erik:2", edited: true, source_ids: ["e-new"], quantity: 6, unit_price: 100, unit: "hr", description: "Labor - Erik Taylor" }],
      dismissed: new Set(["labor:p-erik"]),
      bill,
    });
    expect(plan.offer.map((o) => o.importKey)).toEqual(["labor:p-erik:2"]);
    expect(plan.joins[0]).toMatchObject({ lineId: "li-e2", addHours: 2, addIds: ["e-newer"] });
  });

  it("an edited line priced as a lump (1 lot) never takes hours: nothing joins, the hours are named", () => {
    const plan = planLaborOffer({
      entries: [OLD_E, NEW_E],
      ownLines: [{ ...E_LINE, quantity: 1, unit: "lot", unit_price: 2000, description: "Labor - rough-in" }],
      dismissed: new Set(),
      bill,
    });
    expect(plan.joins).toEqual([]);
    expect(plan.leftOff).toEqual([{ personId: "p-erik", name: "Erik Taylor", hours: 6, why: "notHours", lineDescription: "Labor - rough-in" }]);
  });

  it("a brand-new person on the job gets their own line", () => {
    const plan = planLaborOffer({ entries: [OLD_E, NEW_B], ownLines: [E_LINE], dismissed: new Set(), bill });
    expect(plan.offer.map((o) => o.importKey).sort()).toEqual(["labor:p-brian", "labor:p-erik"]);
    expect(plan.joins).toEqual([]);
  });
});

describe("the words", () => {
  it("rates read the way Erik says them", () => {
    expect(rateWords(100)).toBe("$100");
    expect(rateWords(62.5)).toBe("$62.50");
    expect(rateWords(1250)).toBe("$1,250");
  });
  it("hours units", () => {
    expect(isHoursUnit("hr")).toBe(true);
    expect(isHoursUnit("HRS")).toBe(true);
    expect(isHoursUnit(null)).toBe(true);
    expect(isHoursUnit("lot")).toBe(false);
    expect(isHoursUnit("ea")).toBe(false);
  });
});
