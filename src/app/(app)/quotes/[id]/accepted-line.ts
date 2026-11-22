/**
 * WHO SAID YES, SAID ON THE ESTIMATE'S PAGE (cn-v1176, M6). Under the status control, only while the
 * estimate is accepted, for the office (the page is the office's: quotes are staff-only under RLS), as
 * plain text, never a button:
 *
 *   in_person       Approved in person by <name> · <day>     (no name when the profile is gone)
 *   office          Marked accepted by <name> · <day>
 *   customer_link   Accepted by the customer on their link · <day>
 *   none (before 0413) Accepted · <day>
 *
 * Never on the customer's paper, the public page or the portal: those keep saying only that it was
 * accepted. Pure: the page hands the words (its translator) and the day already formatted.
 */
export type AcceptedFacts = {
  status: string | null | undefined;
  how: string | null | undefined;
  /** The recorder's name, or null when there is none (the customer's link, a gone profile, before 0413). */
  byName: string | null | undefined;
  /** The day, already formatted in the company's zone and the reader's language; null = not recorded. */
  day: string | null | undefined;
};

export function acceptedLine(f: AcceptedFacts, t: (key: string) => string): string | null {
  if (f.status !== "accepted") return null;
  const day = f.day?.trim() || "";
  const who = f.byName?.trim() || "";
  const fill = (key: string) => t(key).replace("{who}", who).replace("{day}", day);
  // With no day recorded the line has nothing to say beyond the status the select already shows.
  if (!day) return null;
  if (f.how === "in_person") return fill(who ? "qe_acceptedInPersonBy" : "qe_acceptedInPerson");
  if (f.how === "office") return fill(who ? "qe_acceptedOfficeBy" : "qe_acceptedOffice");
  if (f.how === "customer_link") return fill("qe_acceptedOnLink");
  return fill("qe_acceptedOn");
}
