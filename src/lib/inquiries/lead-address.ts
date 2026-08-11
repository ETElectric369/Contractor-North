/**
 * A LEAD HAS TWO ADDRESSES, AND ONE RULE FOR TELLING THEM APART (0189).
 *
 * Erik: *"if the customer has an address on file then i noticed there is another job address now
 * so maybe i just need clarification where is what"* — and Andrew, who hit the same edge from the
 * other side, wanting the intake form's fixed contact box to say "home address" with the project
 * address kept separate.
 *
 * ── THE TWO ROLES ───────────────────────────────────────────────────────────────────────────
 *
 *   inquiries.address          THE SITE. Where the work happens. Copied onto jobs.address at
 *                              conversion, rendered on every document by pickSite, and the string
 *                              the job name is derived from.
 *   inquiries.contact_address  THE PERSON. Where they live or bill from. Fills customers.address.
 *
 * For a residential service call they are the same place, which is why one column carried both for
 * a year without anybody noticing. For a general contractor they never are: the lead lives in a
 * house that exists and is building on a lot that does not.
 *
 * ── WHY THE RULE LIVES HERE AND NOT AT ITS TWO CALL SITES ───────────────────────────────────
 *
 * It is applied twice — once writing the lead (the intake door) and once reading it (conversion to
 * a customer + job). Two copies of "coalesce these unless that one is set" is exactly the shape
 * that drifts, and when it drifts the symptom is a customer's home address printed on a contractor's
 * estimate as the job site. One function, both directions, tested.
 *
 * BACKWARD COMPATIBILITY IS THE POINT OF THE FALLBACK. `contact_address` is null on all 34 leads
 * captured before 0189 and on every door that still asks once — /inquire, the partner webhook, the
 * deck configurator. For those, the person's address IS the site address, which is precisely what
 * the app assumed yesterday.
 */

export interface AddressParts {
  address?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
}

const clean = (v: unknown, n: number): string | null => {
  const s = String(v ?? "").trim().slice(0, n);
  return s || null;
};

/**
 * WRITE SIDE — what the intake door stores.
 *
 * `site` is what the customer typed in the project block, or null when they left "the work is at
 * my home address" ticked. A site with no street is not a site: a stray city with no address is
 * how you get a job located in a town and nowhere else.
 */
export function splitLeadAddress(input: { contact: AddressParts; site?: AddressParts | null }): {
  site: AddressParts;
  contact: AddressParts;
} {
  const contact: AddressParts = {
    address: clean(input.contact?.address, 300),
    city: clean(input.contact?.city, 80),
    state: clean(input.contact?.state, 40),
    zip: clean(input.contact?.zip, 20),
  };
  const siteStreet = clean(input.site?.address, 300);
  return {
    contact,
    site: siteStreet
      ? { address: siteStreet, city: clean(input.site?.city, 80), state: clean(input.site?.state, 40), zip: clean(input.site?.zip, 20) }
      : { ...contact },
  };
}

/**
 * READ SIDE — the address the CUSTOMER record gets at conversion.
 *
 * All-or-nothing, never a per-field coalesce: mixing the contact's street with the site's city
 * produces an address that exists on no record and in no town. That is the same law
 * lib/site-address.ts' pickSite is built on, and it was learned the same way.
 */
export function customerAddressFrom(inq: {
  address?: string | null; city?: string | null; state?: string | null; zip?: string | null;
  contact_address?: string | null; contact_city?: string | null; contact_state?: string | null; contact_zip?: string | null;
}): AddressParts {
  return inq.contact_address
    ? { address: inq.contact_address, city: inq.contact_city ?? null, state: inq.contact_state ?? null, zip: inq.contact_zip ?? null }
    : { address: inq.address ?? null, city: inq.city ?? null, state: inq.state ?? null, zip: inq.zip ?? null };
}
