/**
 * THE APP ALREADY KNOWS THIS PERSON.
 *
 * Erik, entering his real lead list: "im running into a bunch of things that are becoming apparent
 * about lack of fluidity and connectivity."
 *
 * Measured against what he actually typed in one sitting: TWELVE leads, FIVE of which already
 * existed as customers in the same org, and only TWO of those got linked. For two of them —
 * Mike Scrivano and Jackie Burks — the CUSTOMER record already held a phone and an email, and the
 * lead came back with neither. So the app had the phone number, he typed the name, and it handed
 * him a lead he cannot call. Ten of his twelve leads now have no way to contact them.
 *
 * One of them also came back with a DIFFERENT address than the customer record, which is the
 * address fork (see the address-model note) reproducing itself one stage earlier than usual.
 *
 * ── THE RULES THIS FOLLOWS ─────────────────────────────────────────────────────────────────
 *
 * FRAGMENT-FIRST — never block. A lead saves whatever it has, always. This only ADDS.
 *
 * WHAT HE TYPED WINS, ALWAYS. Carry a customer's detail across only into a field he left EMPTY.
 * If he typed a different phone, that is him correcting the record, not a conflict to resolve —
 * and silently overwriting it would be the worst thing this could do.
 *
 * NEVER GUESS BETWEEN TWO PEOPLE. Two customers named "Chris Taylor" means the app does not know
 * which one, so it links neither and says so. A wrong link is far more expensive than no link:
 * it attaches a lead to a stranger's history.
 *
 * NOTHING SILENT — the caller gets a sentence naming what was brought across, because a field
 * that fills itself without explanation is how somebody stops trusting the form.
 */

export type KnownCustomer = {
  id: string;
  name: string | null;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  company_name?: string | null;
};

/** Names match as a person would read them: case and surrounding space don't count. */
const norm = (s: string | null | undefined): string =>
  String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");

export type CustomerMatch =
  | { kind: "none" }
  | { kind: "one"; customer: KnownCustomer }
  /** Two or more people share this name — the app must not choose. */
  | { kind: "ambiguous"; count: number };

export function matchKnownCustomer(name: string, customers: KnownCustomer[]): CustomerMatch {
  const want = norm(name);
  if (!want) return { kind: "none" };
  const hits = customers.filter((c) => norm(c.name) === want);
  if (hits.length === 0) return { kind: "none" };
  if (hits.length > 1) return { kind: "ambiguous", count: hits.length };
  return { kind: "one", customer: hits[0] };
}

/** The contact + place fields a lead and a customer both carry. */
const CARRIED = ["phone", "email", "address", "city", "state", "zip", "company_name"] as const;
export type CarriedField = (typeof CARRIED)[number];

/** Human names, for the sentence the office reads. */
const LABEL: Record<CarriedField, string> = {
  phone: "phone",
  email: "email",
  address: "address",
  city: "city",
  state: "state",
  zip: "ZIP",
  company_name: "company",
};

export type Carried = {
  /** Only the fields that were EMPTY on the lead and present on the customer. */
  patch: Partial<Record<CarriedField, string>>;
  /** One sentence for the UI, or "" when nothing moved. */
  note: string;
};

/**
 * Fill the blanks from a customer we're confident is the same person.
 *
 * ADDRESS IS ALL-OR-NOTHING. A street from the customer under a city the user typed is how you
 * get a plausible address that does not exist — the same all-or-nothing rule pickSite already
 * applies everywhere else a place is resolved. So if the lead named any part of the place, the
 * whole place is his and none of it is carried.
 */
export function carryFromCustomer(
  lead: Partial<Record<CarriedField, string | null | undefined>>,
  customer: KnownCustomer,
): Carried {
  const has = (v: unknown) => String(v ?? "").trim() !== "";
  const leadNamedAPlace = has(lead.address) || has(lead.city) || has(lead.state) || has(lead.zip);

  const patch: Partial<Record<CarriedField, string>> = {};
  for (const f of CARRIED) {
    if (has(lead[f])) continue; // what he typed wins
    if ((f === "address" || f === "city" || f === "state" || f === "zip") && leadNamedAPlace) continue;
    const v = String((customer as Record<string, unknown>)[f] ?? "").trim();
    if (v) patch[f] = v;
  }

  const moved = (Object.keys(patch) as CarriedField[]).map((f) => LABEL[f]);
  if (!moved.length) return { patch, note: "" };
  const list = moved.length === 1 ? moved[0] : `${moved.slice(0, -1).join(", ")} and ${moved[moved.length - 1]}`;
  return {
    patch,
    note: `Linked to ${customer.name ?? "an existing customer"} — brought their ${list} across.`,
  };
}
