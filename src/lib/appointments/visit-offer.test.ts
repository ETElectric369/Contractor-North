import { describe, expect, it } from "vitest";
import { offerCustomerOf, offerJobLabel, visitOffer, type OfferCandidate } from "./visit-offer";

/**
 * THE OFFER, NEVER A GUESS (cn-v1175, R5). A job made for the visit's own customer record after the
 * visit is OFFERED; a name match never is; the newest is the button and the others go behind the dots.
 * Made-up records only.
 */

const VISIT = { starts_at: "2026-11-01T17:00:00Z", job_id: null, customer_id: "cust-1" };
const job = (id: string, over: Partial<OfferCandidate> = {}): OfferCandidate => ({
  kind: "job",
  id,
  customer_id: "cust-1",
  created_at: "2026-11-05T17:00:00Z",
  label: `J-${id}`,
  ...over,
});

describe("visitOffer", () => {
  it("a job made for the same customer record after the visit is offered", () => {
    expect(visitOffer(VISIT, [job("900")])).toEqual({ kind: "job", id: "900", label: "J-900", others: [] });
  });

  it("the newest is the button; the others, newest first, go behind the dots", () => {
    const o = visitOffer(VISIT, [job("901", { created_at: "2026-11-03T17:00:00Z" }), job("902", { created_at: "2026-11-09T17:00:00Z" }), job("903", { created_at: "2026-11-06T17:00:00Z" })]);
    expect(o?.id).toBe("902");
    expect(o?.others.map((x) => x.id)).toEqual(["903", "901"]);
  });

  it("never by a name: only the customer record links (another customer's job is nothing)", () => {
    expect(visitOffer(VISIT, [job("900", { customer_id: "cust-2", label: "J-900 Sam Tillery" })])).toBeNull();
    // A visit with no customer record of its own and no lead's is offered nothing.
    expect(visitOffer({ ...VISIT, customer_id: null }, [job("900")])).toBeNull();
  });

  it("its lead's customer record counts when the visit has none of its own", () => {
    expect(offerCustomerOf({ customer_id: null, lead_customer_id: "cust-1" })).toBe("cust-1");
    expect(visitOffer({ ...VISIT, customer_id: null, lead_customer_id: "cust-1" }, [job("900")])?.id).toBe("900");
  });

  it("a job made BEFORE the visit, a visit that already has a job, or a visit with no day: nothing", () => {
    expect(visitOffer(VISIT, [job("900", { created_at: "2026-10-30T17:00:00Z" })])).toBeNull();
    expect(visitOffer({ ...VISIT, job_id: "job-1" }, [job("900")])).toBeNull();
    expect(visitOffer({ ...VISIT, starts_at: null }, [job("900")])).toBeNull();
  });

  it("only the kinds that have a door: an estimate is not offered (no door ties one to a visit yet)", () => {
    const est: OfferCandidate = { kind: "estimate", id: "e-900", customer_id: "cust-1", created_at: "2026-11-05T17:00:00Z", label: "E-900" };
    expect(visitOffer(VISIT, [est])).toBeNull();
    expect(visitOffer(VISIT, [est], ["job", "estimate"])?.id).toBe("e-900");
  });

  it("a job with nothing to call it by is not offered (the button would name nothing)", () => {
    expect(visitOffer(VISIT, [job("900", { label: " " })])).toBeNull();
    expect(offerJobLabel({ job_number: "J-900", name: "Larkspur panel" })).toBe("J-900 Larkspur panel");
    expect(offerJobLabel({ job_number: null, name: null })).toBe("");
  });
});
