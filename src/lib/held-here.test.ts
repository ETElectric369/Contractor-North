import { describe, it, expect } from "vitest";
import { costsKeyNames, heldOnThisInvoice, idKeyNames, laborKeyNames, withHeldHere, type HereLine } from "./held-here";
import { computeJobLaborBilling, withoutClaimedLabor } from "./labor-billing";
import { planLaborOffer } from "./labor-offer";
import type { ClaimedSources } from "./unbilled-work";

/**
 * ALREADY BILLED, WAVE 1: a charge this invoice made by hand is never offered again by its own
 * importer. The shapes are ET's own invoices, line for line (ids shortened where they don't matter).
 */

// ── INV-060, Bayberry Lane J-039 (paid) ───────────────────────────────────────────────────────────
const HD = "5e1b0b67-f0f3-4ee6-b420-004413d79a48"; // Home Depot, $196.18
const ACE1 = "5b12146d-514a-4f7c-a34b-a68ad292dbda"; // Ace 8/17, $68.66
const ACE2 = "d66d55a9-5b45-42d4-a68f-66f996509a32"; // Ace 8/17, $47.94
const ERIK = "d358effe-e352-401b-93bb-7dde456e9bc0";
const BRIAN = "07b85435-02ff-4382-a4f1-1f932c561d9f";
const E1 = "e0000000-0000-4000-8000-000000000001";
const E2 = "e0000000-0000-4000-8000-000000000002";
const B1 = "297671dc-5596-4d60-9c7c-97b4c852e897";
const B2 = "6edc3395-5711-4283-aba9-7603a690df94";
const B3 = "4b72bee8-4458-41e7-a372-f9f60c258b8d";

const INV060: HereLine[] = [
  { import_source: "labor", import_key: `labor:${ERIK}`, edited: true, source_ids: [E1, E2] }, // "Labor — Erik", $1,160
  { import_source: null, import_key: null, edited: false, source_ids: [B1, B2, B3] }, // "Labor - Brian", typed by hand
  // "Materials — Assorted light bulbs…", $390.98: keyed to the Home Depot bill, edited, and the two
  // Ace receipts added to it by hand (bayberry-ace-on-inv060.sql).
  { import_source: "costs", import_key: `bill:${HD}`, edited: true, source_ids: [HD, ACE1, ACE2] },
];

const entry = (id: string, person: string, name: string, day: string, hours = 8) => ({
  id,
  clock_in: `${day}T15:00:00Z`,
  clock_out: new Date(new Date(`${day}T15:00:00Z`).getTime() + hours * 3_600_000).toISOString(),
  lunch_minutes: 0,
  job_code: null,
  profiles: { id: person, full_name: name, bill_rate: person === ERIK ? 150 : 95 },
});
const J039_ENTRIES = [
  entry(E1, ERIK, "Erik Taylor", "2026-08-12"),
  entry(E2, ERIK, "Erik Taylor", "2026-08-13"),
  entry(B1, BRIAN, "Brian Taylor", "2026-08-12"),
  entry(B2, BRIAN, "Brian Taylor", "2026-08-13"),
  entry(B3, BRIAN, "Brian Taylor", "2026-08-14"),
];

const noCosts = costsKeyNames({ billOfLine: new Map(), movesOfTake: new Map() });

describe("INV-060: a charge made by hand stays charged", () => {
  it("Materials From Costs: the Home Depot bill is its line's own; the two Ace receipts added by hand are taken", () => {
    const held = heldOnThisInvoice(INV060, "costs", noCosts);
    expect(held).toContain(ACE1);
    expect(held).toContain(ACE2);
    expect(held).not.toContain(HD);
  });

  it("Labor From Timecards: Brian's shifts on the hand-typed line are taken; Erik's stay on his own edited line", () => {
    const held = heldOnThisInvoice(INV060, "labor", laborKeyNames(J039_ENTRIES));
    expect(held).toEqual(expect.arrayContaining([B1, B2, B3]));
    expect(held).not.toContain(E1);
    expect(held).not.toContain(E2);
    // What is left to offer: Erik's two shifts, which his edited line already holds, and nothing of Brian's.
    const free = withoutClaimedLabor(J039_ENTRIES, new Set(held));
    expect(free.jobEntries.map((e) => e.id)).toEqual([E1, E2]);
    const plan = planLaborOffer({
      entries: free.jobEntries,
      heldEntries: J039_ENTRIES,
      ownLines: [{ id: "li-erik", import_key: `labor:${ERIK}`, edited: true, source_ids: [E1, E2], quantity: 16, unit_price: 72.5, unit: "hr", description: "Labor — Erik" }],
      dismissed: new Set(),
      bill: (es) => computeJobLaborBilling(es, 95, null).lines,
    });
    expect(plan.offer.map((o) => o.importKey)).toEqual([`labor:${ERIK}`]); // no second line for Brian
    expect(plan.joins).toEqual([]); // nothing new to join onto Erik's line either
  });

  it("before this rule the same read offered Brian a new line: the double bill it closes", () => {
    const plan = planLaborOffer({
      entries: J039_ENTRIES, // every entry "free" because only OTHER invoices were read
      heldEntries: J039_ENTRIES,
      ownLines: [{ id: "li-erik", import_key: `labor:${ERIK}`, edited: true, source_ids: [E1, E2], quantity: 16, unit_price: 72.5, unit: "hr", description: "Labor — Erik" }],
      dismissed: new Set(),
      bill: (es) => computeJobLaborBilling(es, 95, null).lines,
    });
    expect(plan.offer.map((o) => o.importKey)).toContain(`labor:${BRIAN}`);
  });
});

// ── INV-078, 13897 Honeysuckle (Andrew's running draft) ────────────────────────────────────────
describe("INV-078: the person's own edited labor line keeps its hours in play, so new hours still JOIN it", () => {
  const OLD = "7e000000-0000-4000-8000-000000000001";
  const NEW = "7e000000-0000-4000-8000-000000000002";
  const JIMMY = "9432ea48-357e-4d81-bed8-b38388dd5477";
  const J1 = "7e000000-0000-4000-8000-000000000003";
  const CED = "c9daf1b8-03fb-4435-a518-24a000d31c3a";
  const LINE = "d26f3d69-76ea-4e63-ae72-69c7d0a7c480";
  const entries = [entry(OLD, ERIK, "Erik Taylor", "2026-09-10"), entry(NEW, ERIK, "Erik Taylor", "2026-09-22", 6), entry(J1, JIMMY, "Jimmy Starling", "2026-09-10")];
  const lines: HereLine[] = [
    { import_source: "labor", import_key: `labor:${ERIK}`, edited: true, source_ids: [OLD] }, // Andrew's $100
    { import_source: "labor", import_key: `labor:${JIMMY}`, edited: true, source_ids: [J1] },
    { import_source: "costs", import_key: `bli:${LINE}`, edited: false, source_ids: [CED] },
    { import_source: "costs", import_key: `bill:${CED}:remainder`, edited: true, source_ids: [CED] },
  ];

  it("no labor entry is taken, and the materials on the draft are another source's", () => {
    const held = heldOnThisInvoice(lines, "labor", laborKeyNames(entries));
    expect(held).toEqual([CED]);
  });

  it("the join is planned exactly as before: 6 new hours onto Erik's line at its own rate", () => {
    const held = new Set(heldOnThisInvoice(lines, "labor", laborKeyNames(entries)));
    const free = withoutClaimedLabor(entries, held);
    const plan = planLaborOffer({
      entries: free.jobEntries,
      heldEntries: entries,
      ownLines: [
        { id: "li-erik", import_key: `labor:${ERIK}`, edited: true, source_ids: [OLD], quantity: 8, unit_price: 100, unit: "hr", description: "Labor - Erik Taylor" },
        { id: "li-jimmy", import_key: `labor:${JIMMY}`, edited: true, source_ids: [J1], quantity: 8, unit_price: 50, unit: "hr", description: "Labor - Jimmy Starling" },
      ],
      dismissed: new Set(),
      bill: (es) => computeJobLaborBilling(es, 95, null).lines,
    });
    expect(plan.joins).toHaveLength(1);
    expect(plan.joins[0]).toMatchObject({ lineId: "li-erik", addHours: 6, addIds: [NEW], heldIds: [OLD], rate: 100 });
    expect(plan.leftOff).toEqual([]);
  });

  it("the draft's own materials lines take nothing from Materials From Costs: an unedited line is rewritten, an edited one names its bill", () => {
    const held = heldOnThisInvoice(lines, "costs", costsKeyNames({ billOfLine: new Map([[LINE, CED]]), movesOfTake: new Map() }));
    expect(held).toEqual([OLD, J1]); // only the other source's ids
  });
});

// ── INV-00023, Pinyon Sage J-010 (paid) ─────────────────────────────────────────────────────────
describe("INV-00023: a typed Materials line and a legacy keyless labor line", () => {
  const PINYON = "52462c4b-bbac-4865-9050-4af6e90dec45";
  const T = ["3bd20403-0000-4000-8000-00000000000a", "3bd20403-0000-4000-8000-00000000000b", "3bd20403-0000-4000-8000-00000000000c"];
  const lines: HereLine[] = [
    { import_source: "labor", import_key: null, edited: true, source_ids: T }, // "Labor — Brian Taylor", before keys
    { import_source: null, import_key: null, edited: false, source_ids: [PINYON] }, // "Materials", $110, typed by hand
  ];

  it("the CED bill the Materials line charges is taken", () => {
    expect(heldOnThisInvoice(lines, "costs", noCosts)).toEqual(expect.arrayContaining([PINYON]));
  });

  it("a keyless edited labor line names nobody, so its shifts are taken (no second Brian line)", () => {
    expect(heldOnThisInvoice(lines, "labor", laborKeyNames([]))).toEqual(expect.arrayContaining(T));
  });
});

describe("the key rules, one by one", () => {
  const BILL = "b1000000-0000-4000-8000-000000000001";
  const OTHER = "b1000000-0000-4000-8000-000000000002";
  const BLI = "11111111-0000-4000-8000-000000000001";
  const GONE = "11111111-0000-4000-8000-000000000009";

  it("an unedited line of the importer's own takes nothing, whatever it holds", () => {
    expect(heldOnThisInvoice([{ import_source: "costs", import_key: `bill:${BILL}`, edited: false, source_ids: [BILL, OTHER] }], "costs", noCosts)).toEqual([]);
  });

  it("an edited bli: line names its bill (read from the receipt's lines), anything else on it is taken", () => {
    const names = costsKeyNames({ billOfLine: new Map([[BLI, BILL]]), movesOfTake: new Map() });
    expect(heldOnThisInvoice([{ import_source: "costs", import_key: `bli:${BLI}`, edited: true, source_ids: [BILL, OTHER] }], "costs", names)).toEqual([OTHER]);
  });

  it("an edited bli: line whose receipt line is gone names the id the importer wrote first", () => {
    expect(heldOnThisInvoice([{ import_source: "costs", import_key: `bli:${GONE}`, edited: true, source_ids: [BILL, OTHER] }], "costs", noCosts)).toEqual([OTHER]);
  });

  it("an edited take line names its moves", () => {
    const names = costsKeyNames({ billOfLine: new Map(), movesOfTake: new Map([["g-1", ["m-1", "m-2"]]]) });
    expect(heldOnThisInvoice([{ import_source: "costs", import_key: "stock:g-1", edited: true, source_ids: ["m-1", "m-2", "m-9"] }], "costs", names)).toEqual(["m-9"]);
  });

  it("an edited keyless materials line (an old import) names nothing: all it holds is taken", () => {
    expect(heldOnThisInvoice([{ import_source: "costs", import_key: null, edited: true, source_ids: [BILL, OTHER] }], "costs", noCosts)).toEqual([BILL, OTHER]);
  });

  it("estimate lines and change orders: the key's own id is the line's, the rest is taken", () => {
    const Q = "a0000000-0000-4000-8000-000000000001";
    expect(heldOnThisInvoice([{ import_source: "quote", import_key: `quote:${Q}`, edited: true, source_ids: [Q, BILL] }], "quote", idKeyNames("quote"))).toEqual([BILL]);
    expect(heldOnThisInvoice([{ import_source: "change_orders", import_key: `co:${Q}`, edited: true, source_ids: [Q] }], "change_orders", idKeyNames("co"))).toEqual([]);
    expect(heldOnThisInvoice([{ import_source: "quote", import_key: `quote:${Q}`, edited: true, source_ids: [Q] }], "change_orders", idKeyNames("co"))).toEqual([Q]);
  });

  it("a shift on another person's edited line is taken (a legacy overflow key names its person too)", () => {
    const es = [entry(E1, ERIK, "Erik", "2026-08-12"), entry(B1, BRIAN, "Brian", "2026-08-12")];
    const held = heldOnThisInvoice([{ import_source: "labor", import_key: `labor:${ERIK}:2`, edited: true, source_ids: [E1, B1] }], "labor", laborKeyNames(es));
    expect(held).toEqual([B1]);
  });

  it("withHeldHere adds this invoice as the holder without taking an id from the invoice that already holds it", () => {
    const other = { id: "inv-a", invoice_number: "INV-061", status: "sent", created_at: "2026-08-01" };
    const here = { id: "inv-b", invoice_number: "INV-060", status: "paid", created_at: "2026-08-18" };
    const claims: ClaimedSources = { owner: new Map([[BILL, other]]), invoices: [], schemaReady: true };
    const merged = withHeldHere(claims, here, [BILL, OTHER]);
    expect(merged.owner.get(BILL)).toBe(other);
    expect(merged.owner.get(OTHER)).toBe(here);
    expect(claims.owner.has(OTHER)).toBe(false); // the input is not mutated
  });
});
