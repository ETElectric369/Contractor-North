import { describe, expect, it } from "vitest";
import { exactJobMatch, linkableFullName, offerCustomerOf, offerJobLabel, visitOffer, type MatchJob, type OfferCandidate, type OfferVisit } from "./visit-offer";

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

/**
 * A VISIT FINDS ITS JOB BY NAME AND STREET, EXACTLY (cn-v1181, I3). The owner's case, in stand-ins: a
 * visit titled "Site inspection: Dana Rook" at "410 Larkspur Lane", no customer record and no lead; a
 * job made by hand two weeks later for the customer Dana Rook at 410 Larkspur Lane.
 */
describe("exactJobMatch: the rule's table", () => {
  const V: OfferVisit = {
    starts_at: "2026-11-01T17:00:00Z",
    job_id: null,
    customer_id: null,
    lead_customer_id: null,
    location: "410 Larkspur Lane, Truckee, CA 96161",
    title: "Site inspection: Dana Rook",
    lead_name: null,
  };
  const J: MatchJob = { created_at: "2026-11-15T17:00:00Z", address: "410 Larkspur Ln", customer_id: "cust-dana", customer_name: "Dana Rook" };

  it("the name in the title, the same street (Lane is Ln; the town and zip are not the street): a match", () => {
    expect(exactJobMatch(V, J)).toBe(true);
    // Case-blind, whole words, anywhere in the title; or in the lead's name.
    expect(exactJobMatch({ ...V, title: "dana rook — panel" }, J)).toBe(true);
    expect(exactJobMatch({ ...V, title: "Site inspection", lead_name: "DANA ROOK" }, J)).toBe(true);
  });

  it("a record match: the visit's own customer record, or its lead's, is the job's customer (no name needed)", () => {
    expect(exactJobMatch({ ...V, title: "Inspection", customer_id: "cust-dana" }, J)).toBe(true);
    expect(exactJobMatch({ ...V, title: "Inspection", lead_customer_id: "cust-dana" }, J)).toBe(true);
    // A record that is someone else's is not overruled by the name in the title.
    expect(exactJobMatch({ ...V, customer_id: "cust-other" }, J)).toBe(false);
  });

  it("a placeholder name refuses; a first name alone refuses; a part of a word is not a word", () => {
    expect(exactJobMatch({ ...V, title: "Inspection: Unknown caller" }, { ...J, customer_name: "Unknown caller" })).toBe(false);
    expect(exactJobMatch({ ...V, title: "Inspection: 5550123 5550124" }, { ...J, customer_name: "5550123 5550124" })).toBe(false);
    expect(exactJobMatch({ ...V, title: "Inspection: Dana" }, { ...J, customer_name: "Dana" })).toBe(false);
    expect(exactJobMatch({ ...V, title: "Inspection: Dana Rookwood" }, J)).toBe(false);
    expect(linkableFullName("Dana Rook")).toEqual(["dana", "rook"]);
    expect(linkableFullName("Unknown caller")).toBeNull();
    expect(linkableFullName("Dana")).toBeNull();
  });

  it("another street refuses: another number, another street type, no street at all", () => {
    expect(exactJobMatch(V, { ...J, address: "412 Larkspur Ln" })).toBe(false);
    expect(exactJobMatch(V, { ...J, address: "410 Larkspur Dr" })).toBe(false);
    expect(exactJobMatch(V, { ...J, address: null })).toBe(false);
    expect(exactJobMatch({ ...V, location: null }, J)).toBe(false);
    expect(exactJobMatch({ ...V, location: "Larkspur Lane" }, J)).toBe(false);
  });

  it("a job made before the visit refuses", () => {
    expect(exactJobMatch(V, { ...J, created_at: "2026-10-20T17:00:00Z" })).toBe(false);
    expect(exactJobMatch({ ...V, starts_at: null }, J)).toBe(false);
  });

  it("a job with no customer, or another person's, refuses", () => {
    expect(exactJobMatch(V, { ...J, customer_id: null })).toBe(false);
    expect(exactJobMatch(V, { ...J, customer_name: "Theo Vance" })).toBe(false);
  });

  it("the offer: a visit with no record is offered its exact match; two candidates, the newest first and the other behind the dots", () => {
    const c = (id: string, over: Partial<OfferCandidate> = {}): OfferCandidate => ({
      kind: "job",
      id,
      customer_id: "cust-dana",
      created_at: "2026-11-15T17:00:00Z",
      label: `J-${id}`,
      address: "410 Larkspur Ln",
      customer_name: "Dana Rook",
      ...over,
    });
    expect(visitOffer(V, [c("900")])?.id).toBe("900");
    const two = visitOffer(V, [c("901", { created_at: "2026-11-10T17:00:00Z" }), c("902", { created_at: "2026-11-18T17:00:00Z" })]);
    expect(two?.id).toBe("902");
    expect(two?.others.map((o) => o.id)).toEqual(["901"]);
    // Not exact: nothing, as before (never a guess by a name alone, never by a street alone).
    expect(visitOffer(V, [c("903", { address: "9 Snowbell Ct" })])).toBeNull();
    expect(visitOffer(V, [c("904", { customer_name: "Sam Tillery" })])).toBeNull();
  });
});
