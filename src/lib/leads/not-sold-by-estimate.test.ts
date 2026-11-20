import { describe, it, expect } from "vitest";
import { leadsNotSoldByEstimate, NOT_SOLD_BY_ESTIMATE_COLUMNS } from "./not-sold-by-estimate";

/**
 * NOT SOLD BY ITS ESTIMATE (cn-v1172): a lead whose estimate the customer declined joins the Leads
 * page's Not Sold fold by a READ. Nothing is stamped on the lead.
 */
const e = (inquiry_id: string | null, status: string | null, customer_id: string | null = null) => ({ inquiry_id, status, customer_id });

describe("leadsNotSoldByEstimate", () => {
  it("a lead whose only estimate was declined is Not Sold", () => {
    expect(leadsNotSoldByEstimate([e("l1", "declined")])).toEqual(["l1"]);
  });

  it("an estimate marked expired is the same ending", () => {
    expect(leadsNotSoldByEstimate([e("l1", "expired")])).toEqual(["l1"]);
  });

  it("any estimate still in play keeps the lead out of the fold: a draft, one out for an answer, or a win", () => {
    for (const live of ["draft", "sent", "accepted"]) {
      expect(leadsNotSoldByEstimate([e("l1", "declined"), e("l1", live)]), live).toEqual([]);
      expect(leadsNotSoldByEstimate([e("l1", live), e("l1", "declined")]), live).toEqual([]);
    }
  });

  it("a status the rule was never taught counts as in play: nobody is called Not Sold on a guess", () => {
    expect(leadsNotSoldByEstimate([e("l1", "declined"), e("l1", "something-new")])).toEqual([]);
    expect(leadsNotSoldByEstimate([e("l1", "declined"), e("l1", null)])).toEqual([]);
  });

  it("a superseded estimate says nothing either way", () => {
    expect(leadsNotSoldByEstimate([e("l1", "superseded")])).toEqual([]);
    expect(leadsNotSoldByEstimate([e("l1", "superseded"), e("l1", "declined")])).toEqual(["l1"]);
  });

  it("a lead with no estimate, and an estimate with no lead, are not its business", () => {
    expect(leadsNotSoldByEstimate([])).toEqual([]);
    expect(leadsNotSoldByEstimate([e(null, "declined")])).toEqual([]);
  });

  it("each lead once, in the order first met, whatever else is in the read", () => {
    const got = leadsNotSoldByEstimate([e("l2", "declined"), e("l1", "declined"), e("l2", "expired"), e("l3", "sent"), e("l4", "declined"), e("l4", "accepted")]);
    expect(got).toEqual(["l2", "l1"]);
  });
  it("reads the customer too (cn-v1172 fixer)", () => {
    expect(NOT_SOLD_BY_ESTIMATE_COLUMNS).toBe("inquiry_id, status, customer_id");
  });

  it("a declined estimate duplicated for the same customer, and the copy accepted: the lead is not Not Sold", () => {
    // The copy carries no lead (Duplicate does not copy it); the customer ties it to the lead.
    expect(leadsNotSoldByEstimate([e("l1", "declined", "c1"), e(null, "accepted", "c1")])).toEqual([]);
    expect(leadsNotSoldByEstimate([e(null, "accepted", "c1"), e("l1", "declined", "c1")])).toEqual([]);
  });

  it("a draft or sent estimate for the same customer with no lead on it also takes the lead out", () => {
    for (const live of ["draft", "sent"]) {
      expect(leadsNotSoldByEstimate([e("l1", "declined", "c1"), e(null, live, "c1")]), live).toEqual([]);
    }
  });

  it("another customer's estimate in play changes nothing", () => {
    expect(leadsNotSoldByEstimate([e("l1", "declined", "c1"), e(null, "accepted", "c2"), e(null, "sent", "c3")])).toEqual(["l1"]);
  });

  it("a superseded copy for the same customer says nothing", () => {
    expect(leadsNotSoldByEstimate([e("l1", "declined", "c1"), e(null, "superseded", "c1")])).toEqual(["l1"]);
  });

  it("an estimate for a lead with no customer behaves as before", () => {
    expect(leadsNotSoldByEstimate([e("l1", "declined"), e(null, "accepted", "c1")])).toEqual(["l1"]);
    expect(leadsNotSoldByEstimate([e("l1", "declined"), e("l1", "sent")])).toEqual([]);
  });
});
