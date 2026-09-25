import { describe, it, expect } from "vitest";
import { isActualsDraw, refreshesFromActuals, unbilledCardDoor, pulledIntoSentence, contractDrawRefusal } from "./actuals-draw";
import { formatCurrency } from "./utils";

/** INV-078 as it sits in Erik's database on 2026-09-24: a progress draw, 31 lines from the
 *  materials importer and 3 from the labor importer, four deleted receipt lines tombstoned, on a
 *  T&M job with no payment schedule. */
const INV_078 = {
  invoiceKind: "progress",
  scheduleActive: false,
  lineSources: [...Array(31).fill("costs"), "labor", "labor", "labor"],
  dismissedKeys: ["bli:51f476d0-5bac-44fc-91e1-1592334cc057", "bli:29b282fe-0346-4719-930b-160a8116e0f4"],
};

describe("isActualsDraw / refreshesFromActuals — which documents take new work", () => {
  it("a T&M progress report (INV-078) is refreshable", () => {
    expect(isActualsDraw(INV_078)).toBe(true);
    expect(refreshesFromActuals(INV_078)).toBe(true);
  });

  it("a final report built from actuals is refreshable too, and a hand line on it changes nothing", () => {
    expect(refreshesFromActuals({ invoiceKind: "final", scheduleActive: false, lineSources: ["labor", null, "draw_credit"] })).toBe(true);
  });

  it("a fixed-price percent draw is NOT (one hand line: '50% of remaining estimate')", () => {
    const pct = { invoiceKind: "progress", scheduleActive: false, lineSources: [null] };
    expect(isActualsDraw(pct)).toBe(false);
    expect(refreshesFromActuals(pct)).toBe(false);
  });

  it("a fixed deposit is NOT", () => {
    expect(refreshesFromActuals({ invoiceKind: "deposit", scheduleActive: false, lineSources: [null] })).toBe(false);
  });

  it("a scheduled draw is NOT — neither by its milestone line nor on a scheduled job", () => {
    expect(refreshesFromActuals({ invoiceKind: "progress", scheduleActive: false, lineSources: ["milestone"] })).toBe(false);
    // Even carrying labor lines, a draw on a job with a schedule never takes actuals (H4).
    expect(refreshesFromActuals({ ...INV_078, scheduleActive: true })).toBe(false);
    // A milestone line poisons a mixed draw: the contract slice decides.
    expect(refreshesFromActuals({ invoiceKind: "progress", scheduleActive: false, lineSources: ["milestone", "labor"] })).toBe(false);
  });

  it("an empty draw is NOT — nothing says it was built from actuals", () => {
    expect(refreshesFromActuals({ invoiceKind: "progress", scheduleActive: false, lineSources: [] })).toBe(false);
  });

  it("a report whose imported lines were all deleted is still one (the tombstones say so)", () => {
    expect(refreshesFromActuals({ invoiceKind: "progress", scheduleActive: false, lineSources: [null], dismissedKeys: ["labor:p-1"] })).toBe(true);
    expect(refreshesFromActuals({ invoiceKind: "progress", scheduleActive: false, lineSources: [], dismissedKeys: ["bill:b-1:remainder"] })).toBe(true);
    // An estimate line's tombstone is not evidence of actuals.
    expect(refreshesFromActuals({ invoiceKind: "progress", scheduleActive: false, lineSources: [null], dismissedKeys: ["quote:q-1"] })).toBe(false);
  });

  it("a standard invoice refreshes as it always has, whatever its lines", () => {
    expect(refreshesFromActuals({ invoiceKind: "standard", scheduleActive: false, lineSources: [] })).toBe(true);
    expect(refreshesFromActuals({ invoiceKind: null, scheduleActive: false, lineSources: [null] })).toBe(true);
    expect(isActualsDraw({ invoiceKind: "standard", scheduleActive: false, lineSources: ["labor"] })).toBe(false);
  });

  it("the server's refusal names the document and the way forward", () => {
    const s = contractDrawRefusal("INV-080", "the job's hours");
    expect(s).toContain("INV-080");
    expect(s).toContain("the job's hours");
    expect(s).toMatch(/next progress payment/);
  });
});

describe("unbilledCardDoor — the card never offers what the server refuses", () => {
  const base = { workPending: true, returns: 0, total: 1572.27, newWork: 1572.27, money: formatCurrency };

  it("J-011: an open actuals draw → Add to INV-078 ($1,572.27)", () => {
    const d = unbilledCardDoor({ ...base, openDraft: { id: "inv-078", number: "INV-078", refreshable: true } });
    expect(d).toEqual({ kind: "add", label: "Add to INV-078 ($1,572.27)" });
  });

  it("an open fixed-price draw → Open INV-080, going to it", () => {
    const d = unbilledCardDoor({ ...base, openDraft: { id: "inv-080", number: "INV-080", refreshable: false } });
    expect(d).toEqual({ kind: "open", label: "Open INV-080", href: "/billing/inv-080" });
  });

  it("an open standard draft → Add, as today", () => {
    expect(unbilledCardDoor({ ...base, openDraft: { id: "x", number: "INV-062", refreshable: true } })?.kind).toBe("add");
  });

  it("no draft → Create Invoice for $X; nothing pending → no button", () => {
    expect(unbilledCardDoor({ ...base, openDraft: null })).toEqual({ kind: "create", label: "Create Invoice for $1,572.27" });
    expect(unbilledCardDoor({ ...base, workPending: false, total: 0, newWork: 0, openDraft: null })).toBeNull();
    expect(unbilledCardDoor({ ...base, workPending: false, total: 0, newWork: 0, openDraft: { id: "x", number: "INV-078", refreshable: true } })).toBeNull();
  });

  it("a pending return alone reaches an open draft that takes it, never mints one", () => {
    const ret = { ...base, workPending: false, returns: 1, total: -40, newWork: 0 };
    expect(unbilledCardDoor({ ...ret, openDraft: { id: "x", number: "INV-078", refreshable: true } })).toEqual({ kind: "add", label: "Add to INV-078" });
    expect(unbilledCardDoor({ ...ret, openDraft: null })).toBeNull();
  });
});

describe("pulledIntoSentence — says what landed, in hours and bills", () => {
  it("J-011's sentence", () => {
    expect(pulledIntoSentence("INV-078", { hours: 12, bills: 1 }, { hours: 0, bills: 0 })).toBe("Pulled 12 hours and 1 bill into INV-078.");
  });
  it("singulars, fractions and nothing", () => {
    expect(pulledIntoSentence("INV-078", { hours: 1, bills: 2 })).toBe("Pulled 1 hour and 2 bills into INV-078.");
    expect(pulledIntoSentence("INV-078", { hours: 5.25, bills: 0 })).toBe("Pulled 5.25 hours into INV-078.");
    expect(pulledIntoSentence("INV-078", { hours: 0, bills: 0 })).toBe("Nothing new to pull into INV-078.");
  });
  it("what stayed off is said, never silent", () => {
    expect(pulledIntoSentence("INV-078", { hours: 6, bills: 1 }, { hours: 6, bills: 0 })).toBe(
      "Pulled 6 hours and 1 bill into INV-078. Still not on it: 6 hours - the Import row on INV-078 says why.",
    );
  });
});
