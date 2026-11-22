import { describe, it, expect } from "vitest";
import {
  applyWonOverrides,
  billingKindOfDocType,
  decideWonState,
  docTypeOfBillingKind,
  isNotSoldOutcome,
  isWonVisitType,
  lineAmount,
  overrideProblem,
  wonStamp,
  wonStartShown,
  wonTotals,
  type WonFacts,
  type WonLine,
  type WonQuoteFact,
} from "./won-sheet";
import { subtotalTaxTotal } from "@/lib/invoice-math";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * WON · START THE JOB, THE RULES WITH NO DATABASE (cn-v1176, M3 + M7). Every row of the state decision in
 * the contract's order; the overrides (remove, quantity, price, a bad number, all removed); the totals
 * through the one subtotalTaxTotal; the stamp.
 */
const J900 = { id: "job-900", number: "J-900" };
const q = (over: Partial<WonQuoteFact> = {}): WonQuoteFact => ({ id: "q-900", number: "E-900", status: "draft", job: null, total: 1200, ...over });
const facts = (over: Partial<WonFacts> = {}): WonFacts => ({
  visit: { type: "inspection", status: "completed", outcome: null, job: null },
  behind: null,
  lead: [],
  estimatesOn: true,
  visitLines: { priced: 2, holes: 0 },
  ...over,
});
const visit = (v: Partial<WonFacts["visit"]>) => ({ ...facts().visit, ...v });

describe("what the sheet shows (M3), row by row", () => {
  it("not an inspection-type sales visit, cancelled, or Not Sold: refused", () => {
    expect(decideWonState(facts({ visit: visit({ type: "job" }) }))).toEqual({ kind: "refuse", why: "not_inspection" });
    expect(decideWonState(facts({ visit: visit({ type: "final_inspection" }) }))).toEqual({ kind: "refuse", why: "not_inspection" });
    expect(decideWonState(facts({ visit: visit({ type: "service_call" }) }))).toEqual({ kind: "refuse", why: "not_inspection" });
    expect(decideWonState(facts({ visit: visit({ status: "cancelled" }) }))).toEqual({ kind: "refuse", why: "cancelled" });
    expect(decideWonState(facts({ visit: visit({ outcome: "lost" }) }))).toEqual({ kind: "refuse", why: "not_sold" });
    // cn-v1176 seam: Not Sold is two stored words, one rule (isNotSoldOutcome), the door's too.
    expect(decideWonState(facts({ visit: visit({ outcome: "no_bid" }) }))).toEqual({ kind: "refuse", why: "not_sold" });
    expect(isNotSoldOutcome("lost")).toBe(true);
    expect(isNotSoldOutcome("no_bid")).toBe(true);
    for (const o of [null, undefined, "won", ""]) expect(isNotSoldOutcome(o as never), String(o)).toBe(false);
    expect(readFileSync(join(process.cwd(), "src/lib/appointments/inspection-page.ts"), "utf8")).toContain("return !isNotSoldOutcome(f.outcome);");
  });
  it("a booked inspection is decided like a done one; a Won one with no job still gets the sheet", () => {
    expect(decideWonState(facts({ visit: visit({ status: "scheduled" }) }))).toEqual({ kind: "visit" });
    expect(decideWonState(facts({ visit: visit({ outcome: "won" }) }))).toEqual({ kind: "visit" });
  });
  it("the visit has a job: has_job", () => {
    expect(decideWonState(facts({ visit: visit({ job: J900 }) }))).toMatchObject({ kind: "has_job", job: J900, quote: null });
    // With the estimate behind it accepted, that estimate rides along (a second tap answers with it).
    const acc = q({ status: "accepted", job: J900 });
    expect(decideWonState(facts({ visit: visit({ job: J900 }), behind: acc }))).toEqual({ kind: "has_job", job: J900, quote: acc });
  });
  it("an estimate behind the visit: accepted with a job, accepted with none, draft or sent; dead ones ignored", () => {
    expect(decideWonState(facts({ behind: q({ status: "accepted", job: J900 }) }))).toMatchObject({ kind: "has_job", job: J900 });
    expect(decideWonState(facts({ behind: q({ status: "accepted" }) }))).toMatchObject({ kind: "finish", quote: { id: "q-900" } });
    expect(decideWonState(facts({ behind: q({ status: "draft" }) }))).toMatchObject({ kind: "existing", quote: { id: "q-900" } });
    expect(decideWonState(facts({ behind: q({ status: "sent" }) }))).toMatchObject({ kind: "existing" });
    for (const status of ["declined", "expired", "superseded"]) {
      expect(decideWonState(facts({ behind: q({ status }) })), status).toEqual({ kind: "visit" });
    }
  });
  it("the lead's estimates: accepted with a job refers, accepted with none finishes, else the newest draft or sent", () => {
    const lead = (x: Partial<WonQuoteFact>, createdAt: string) => ({ ...q(x), createdAt });
    expect(decideWonState(facts({ lead: [lead({ id: "a", status: "accepted", job: J900 }, "2026-11-01"), lead({ id: "d", status: "draft" }, "2026-11-20")] }))).toMatchObject({
      kind: "refer",
      quote: { id: "a" },
      job: J900,
    });
    expect(decideWonState(facts({ lead: [lead({ id: "a", status: "accepted" }, "2026-11-01")] }))).toMatchObject({ kind: "finish", quote: { id: "a" } });
    expect(decideWonState(facts({ lead: [lead({ id: "old", status: "sent" }, "2026-11-01"), lead({ id: "new", status: "draft" }, "2026-11-20")] }))).toMatchObject({
      kind: "existing",
      quote: { id: "new" },
    });
    // The estimate behind the visit is read before the lead's.
    expect(decideWonState(facts({ behind: q({ id: "mine", status: "sent" }), lead: [lead({ id: "other", status: "draft" }, "2026-11-20")] }))).toMatchObject({
      kind: "existing",
      quote: { id: "mine" },
    });
  });
  it("Estimates switched off: plain; but an estimate that stands is still the one approved", () => {
    expect(decideWonState(facts({ estimatesOn: false }))).toEqual({ kind: "plain", why: "estimates_off" });
    expect(decideWonState(facts({ estimatesOn: false, behind: q({ status: "sent" }) }))).toMatchObject({ kind: "existing" });
  });
  it("the builder's lines: none priced and no hole is plain; any priced line or any hole is the estimate", () => {
    expect(decideWonState(facts({ visitLines: { priced: 0, holes: 0 } }))).toEqual({ kind: "plain", why: "nothing_priced" });
    expect(decideWonState(facts({ visitLines: { priced: 0, holes: 2 } }))).toEqual({ kind: "visit" });
    expect(decideWonState(facts({ visitLines: { priced: 1, holes: 0 } }))).toEqual({ kind: "visit" });
  });
});

const line = (key: string, quantity: number, unitPrice: number, hole: WonLine["hole"] = null): WonLine => ({
  key,
  description: key,
  quantity,
  unit: "ea",
  unitPrice,
  amount: lineAmount(quantity, unitPrice),
  hole,
});
const lines = [line("scope:a:S1", 2, 150), line("task:b:t2", 1, 0, { kind: "flag", flag: "hours?" }), line("typed:c1", 200, 0, { kind: "zero", flag: null })];

describe("the overrides, by key", () => {
  it("remove leaves; a price answers the hole; a quantity alone answers nothing", () => {
    const out = applyWonOverrides(lines, [
      { key: "typed:c1", remove: true },
      { key: "task:b:t2", unitPrice: 425 },
      { key: "scope:a:S1", quantity: 3 },
    ]);
    expect(out.map((l) => l.key)).toEqual(["scope:a:S1", "task:b:t2"]);
    expect(out[0]).toMatchObject({ quantity: 3, unitPrice: 150, amount: 450, hole: null });
    expect(out[1]).toMatchObject({ unitPrice: 425, amount: 425, hole: null });
    expect(applyWonOverrides(lines, [{ key: "typed:c1", quantity: 5 }])[2].hole).toEqual({ kind: "zero", flag: null });
    expect(applyWonOverrides(lines, [{ key: "typed:c1", unitPrice: 0 }])[2].hole).toEqual({ kind: "zero", flag: null });
  });
  it("a bad number is refused by the door and never drawn; an unknown key does nothing; all removed is empty", () => {
    expect(overrideProblem([{ key: "scope:a:S1", quantity: -1 }])).toBe("scope:a:S1");
    expect(overrideProblem([{ key: "scope:a:S1", quantity: 0 }])).toBe("scope:a:S1");
    expect(overrideProblem([{ key: "scope:a:S1", unitPrice: Number.NaN }])).toBe("scope:a:S1");
    expect(overrideProblem([{ key: "scope:a:S1", unitPrice: Infinity }])).toBe("scope:a:S1");
    expect(overrideProblem([{ key: "scope:a:S1", unitPrice: -0.01 }])).toBe("scope:a:S1");
    expect(overrideProblem([{ key: "scope:a:S1", unitPrice: 0, quantity: 2.5 }])).toBeNull();
    expect(applyWonOverrides(lines, [{ key: "scope:a:S1", quantity: -1 }])[0]).toEqual(lines[0]);
    expect(applyWonOverrides(lines, [{ key: "nope", remove: true }])).toEqual(lines);
    expect(applyWonOverrides(lines, lines.map((l) => ({ key: l.key, remove: true })))).toEqual([]);
  });
});

describe("the totals and the stamp", () => {
  it("each amount the stored way (half away from zero, two places), the totals through subtotalTaxTotal", () => {
    expect(lineAmount(2.25, 95.5)).toBe(214.88);
    expect(lineAmount(3, 0.1)).toBe(0.3);
    const ls = [line("a", 2.25, 95.5), line("b", 2.25, 95.5)];
    expect(wonTotals(ls, 0.0825)).toEqual(subtotalTaxTotal([214.88, 214.88], 0.0825));
    expect(wonTotals(ls, 0).total).toBe(429.76);
  });
  it("the stamp is short, the same for the same sheet, and moves when a line or the tax moves", () => {
    const t = wonTotals(lines, 0);
    const s = wonStamp(lines, 0, t);
    expect(s).toMatch(/^[0-9a-f]{8}$/);
    expect(wonStamp(lines.map((l) => ({ ...l })), 0, t)).toBe(s);
    const moved = applyWonOverrides(lines, [{ key: "scope:a:S1", quantity: 3 }]);
    expect(wonStamp(moved, 0, wonTotals(moved, 0))).not.toBe(s);
    expect(wonStamp(lines, 0.05, wonTotals(lines, 0.05))).not.toBe(s);
  });
  it("the document's word and the job's billing kind map one to one", () => {
    expect(billingKindOfDocType("estimate")).toBe("tm");
    expect(billingKindOfDocType("quote")).toBe("fixed");
    expect(billingKindOfDocType(null)).toBe("tm");
    expect(docTypeOfBillingKind("tm")).toBe("estimate");
    expect(docTypeOfBillingKind("fixed")).toBe("quote");
  });
  it("imports no catalog (a lib under src/lib)", async () => {
    const { readFileSync } = await import("node:fs");
    expect(readFileSync("src/lib/appointments/won-sheet.ts", "utf8")).not.toMatch(/@\/lib\/(i18n|words)/);
    expect(readFileSync("src/lib/estimate/visit-lines.ts", "utf8")).not.toMatch(/@\/lib\/(i18n|words)/);
  });
});

describe("cn-v1176 fixes: the pure rules", () => {
  it("F6: a line's amount is rounded the way the stored line is (decimal half away from zero), never float dust", () => {
    expect(lineAmount(0.25, 4.02)).toBe(1.01);
    expect(lineAmount(-0.25, 4.02)).toBe(-1.01);
    expect(lineAmount(1.005, 1)).toBe(1.01);
    expect(lineAmount(0.1, 0.1)).toBe(0.01);
    expect(lineAmount(2.25, 95.5)).toBe(214.88);
  });
  it("F3: a priced line with a quantity or an amount of 0 or less stays a hole after the overrides", () => {
    const typed = line("typed:c9", 0, 0, { kind: "zero", flag: null });
    // A price typed on a 0-quantity row does not clear it: the Qty box still asks.
    expect(applyWonOverrides([typed], [{ key: "typed:c9", unitPrice: 50 }])[0]).toMatchObject({ quantity: 0, unitPrice: 50, amount: 0, hole: { kind: "zero", flag: null } });
    const negative = line("typed:c8", -2, 0, { kind: "zero", flag: null });
    expect(applyWonOverrides([negative], [{ key: "typed:c8", unitPrice: 50 }])[0].hole).toEqual({ kind: "zero", flag: null });
    // Both answered: priced.
    expect(applyWonOverrides([typed], [{ key: "typed:c9", quantity: 2, unitPrice: 50 }])[0]).toMatchObject({ amount: 100, hole: null });
    // A flagged line (hours?) with a price but no quantity still asks.
    const hours = line("task:t1:labor", 0, 0, { kind: "flag", flag: "hours?" });
    expect(applyWonOverrides([hours], [{ key: "task:t1:labor", unitPrice: 95 }])[0].hole).toEqual({ kind: "zero", flag: null });
    // An amount that rounds to $0.00 asks too.
    const dust = line("typed:c7", 0.001, 0, { kind: "zero", flag: null });
    expect(applyWonOverrides([dust], [{ key: "typed:c7", unitPrice: 1 }])[0].hole).toEqual({ kind: "zero", flag: null });
  });
  it("F2: ONE type rule for the Won sheet: an inspection or an estimate visit; the lists' and the card's link read it", () => {
    for (const t of ["inspection", "quote"]) expect(isWonVisitType(t), t).toBe(true);
    for (const t of ["final_inspection", "job", "service_call", "call", "meeting", "appointment", "other", null, ""]) expect(isWonVisitType(t as never), String(t)).toBe(false);
    expect(decideWonState(facts({ visit: visit({ type: "quote" }) }))).toEqual({ kind: "visit" });
    expect(wonStartShown({ type: "inspection", outcome: "won", hasJob: false })).toBe(true);
    expect(wonStartShown({ type: "quote", outcome: "won", hasJob: false })).toBe(true);
    expect(wonStartShown({ type: "call", outcome: "won", hasJob: false })).toBe(false);
    expect(wonStartShown({ type: "meeting", outcome: "won", hasJob: false })).toBe(false);
    expect(wonStartShown({ type: "inspection", outcome: "won", hasJob: true })).toBe(false);
    expect(wonStartShown({ type: "inspection", outcome: null, hasJob: false })).toBe(false);
  });
});
