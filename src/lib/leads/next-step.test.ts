import { describe, expect, it } from "vitest";
import { leadNextStep, monthDay, weekdayMonthDay, type LeadStepInput, type LeadVisits } from "./next-step";

/**
 * ONE NEXT-STEP CHIP (W2-07): every rule, in its order, and the show-and-hide rules around it.
 */
const TZ = "America/Los_Angeles";
const TODAY = "2026-09-28";
const lead = (over: Partial<LeadStepInput> = {}): LeadStepInput => ({
  status: "new",
  converted_at: null,
  converted_to: null,
  next_follow_up_at: null,
  lead_bucket: null,
  site_inspection_required: false,
  source: "manual",
  referred_by: null,
  ...over,
});
const step = (l: Partial<LeadStepInput>, v: LeadVisits | null = null, estimatesOn = true) =>
  leadNextStep(lead(l), v, TODAY, { estimatesOn, tz: TZ });
const booked = (nextAt: string | null, over: Partial<LeadVisits> = {}): LeadVisits => ({ done: 0, upcoming: 1, nextAt, ...over });

describe("each rule", () => {
  it("1. a focus row that became something: Became An Estimate / Became A Job, slate", () => {
    expect(step({ converted_at: "2026-09-20T10:00:00Z", converted_to: "quote" })).toMatchObject({ label: "Became An Estimate", tone: "slate" });
    expect(step({ converted_at: "2026-09-20T10:00:00Z", converted_to: "estimate" }).label).toBe("Became An Estimate");
    expect(step({ converted_at: "2026-09-20T10:00:00Z", converted_to: "job", status: "won" })).toMatchObject({ label: "Became A Job", tone: "slate" });
    expect(step({ converted_at: "2026-09-20T10:00:00Z", converted_to: "customer" }).label).toBe("Became A Job");
  });

  it("2. lost: Lost, slate", () => {
    expect(step({ status: "lost" })).toMatchObject({ label: "Lost", tone: "slate" });
  });

  it("3. a follow-up day that has passed: Call Back · <day>, amber", () => {
    expect(step({ next_follow_up_at: "2026-09-20" })).toMatchObject({ label: "Call Back · Sep 20", tone: "amber" });
  });

  it("4. a booked visit: its earliest day on the company's clock, blue; one waiting for a day says so", () => {
    // 2026-10-01T05:30Z is still Sep 30 in California: the company's day, never UTC's.
    expect(step({}, booked("2026-10-01T05:30:00.000Z"))).toMatchObject({ label: "Walk-Through · Wed Sep 30", tone: "blue" });
    expect(step({}, booked("2026-10-01T17:00:00.000Z"))).toMatchObject({ label: "Walk-Through · Thu Oct 1", tone: "blue" });
    expect(step({}, booked(null))).toMatchObject({ label: "Walk-Through · No Day Yet", tone: "blue" });
    // A booked visit that isn't a walk-through says its own kind.
    expect(step({}, booked("2026-10-01T17:00:00.000Z", { nextType: "service_call" })).label).toBe("Service Call · Thu Oct 1");
    expect(step({}, booked("2026-10-01T17:00:00.000Z", { nextType: "call" })).label).toBe("Phone Call · Thu Oct 1");
  });

  it("5. a visit done: Walked · Estimate Next, or Walked with Estimates off, green", () => {
    expect(step({ status: "contacted" }, { done: 1, upcoming: 0, nextAt: null })).toMatchObject({ label: "Walked · Estimate Next", tone: "green" });
    expect(step({ status: "contacted" }, { done: 1, upcoming: 0, nextAt: null }, false)).toMatchObject({ label: "Walked", tone: "green" });
  });

  it("6. a follow-up day still coming (today counts): Call Back · <day>, slate", () => {
    expect(step({ next_follow_up_at: "2026-10-03" })).toMatchObject({ label: "Call Back · Oct 3", tone: "slate" });
    expect(step({ next_follow_up_at: TODAY })).toMatchObject({ label: "Call Back · Sep 28", tone: "slate" });
  });

  it("7. contacted: Contacted, slate", () => {
    expect(step({ status: "contacted" })).toMatchObject({ label: "Contacted", tone: "slate" });
  });

  it("8. quoted by hand: Quoted, indigo", () => {
    expect(step({ status: "quoted" })).toMatchObject({ label: "Quoted", tone: "indigo" });
  });

  it("9. otherwise: New · Call Them, blue", () => {
    expect(step({})).toMatchObject({ label: "New · Call Them", tone: "blue" });
  });
});

describe("the order: the first rule that matches wins", () => {
  it("became something beats lost; lost beats a passed follow-up", () => {
    expect(step({ converted_at: "2026-09-20T10:00:00Z", converted_to: "job", status: "lost" }).label).toBe("Became A Job");
    expect(step({ status: "lost", next_follow_up_at: "2026-09-01" }).label).toBe("Lost");
  });

  it("a passed follow-up beats a booked visit; a booked visit beats a done one and a coming follow-up", () => {
    expect(step({ next_follow_up_at: "2026-09-20" }, booked("2026-10-01T17:00:00.000Z")).label).toBe("Call Back · Sep 20");
    expect(step({ next_follow_up_at: "2026-10-03" }, booked("2026-10-01T17:00:00.000Z", { done: 2 })).label).toBe("Walk-Through · Thu Oct 1");
  });

  it("a done visit beats a coming follow-up; a coming follow-up beats contacted and quoted", () => {
    expect(step({ next_follow_up_at: "2026-10-03" }, { done: 1, upcoming: 0, nextAt: null }).label).toBe("Walked · Estimate Next");
    expect(step({ status: "contacted", next_follow_up_at: "2026-10-03" }).label).toBe("Call Back · Oct 3");
    expect(step({ status: "quoted", next_follow_up_at: "2026-10-03" }).label).toBe("Call Back · Oct 3");
  });
});

describe("what shows around the chip", () => {
  it("a bucket's letter leads it only when the lead carries one", () => {
    expect(step({ lead_bucket: "A" })).toMatchObject({ label: "A · New · Call Them", bucket: "A" });
    expect(step({ lead_bucket: "C", status: "contacted" })).toMatchObject({ label: "C · Contacted", bucket: "C" });
    expect(step({})).toMatchObject({ bucket: null });
    expect(step({ lead_bucket: "Z" })).toMatchObject({ label: "New · Call Them", bucket: null });
    // A settled lead has no next step to rank.
    expect(step({ lead_bucket: "A", status: "lost" }).label).toBe("Lost");
  });

  it("· Needs A Visit follows when a site visit is required and nothing is booked", () => {
    expect(step({ site_inspection_required: true }).label).toBe("New · Call Them · Needs A Visit");
    expect(step({ site_inspection_required: true, lead_bucket: "B" }).label).toBe("B · New · Call Them · Needs A Visit");
    expect(step({ site_inspection_required: true }, booked(null)).label).toBe("Walk-Through · No Day Yet");
    expect(step({ site_inspection_required: true }, { done: 1, upcoming: 0, nextAt: null }).label).toBe("Walked · Estimate Next");
  });

  it("a website lead gets the Globe; one typed by hand does not", () => {
    for (const source of ["public_form", "intake", "website_contact", "site_chat", "deck_configurator", "tahoe_deck"]) {
      expect(step({ source }).web, source).toBe(true);
    }
    expect(step({ source: "manual" }).web).toBe(false);
    expect(step({ source: null }).web).toBe(false);
  });
});

describe("the day words", () => {
  it("read the same in every timezone", () => {
    expect(monthDay("2026-09-20")).toBe("Sep 20");
    expect(weekdayMonthDay("2026-10-01")).toBe("Thu Oct 1");
  });
});
