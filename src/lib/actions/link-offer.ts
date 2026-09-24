import { spokenWhen } from "@/lib/org-local-time";

/**
 * THE LINK OFFER (Tom Goodman, 2026-09-24). Nort booked "Inspection — Tom Goodman" with no
 * customer (he wasn't in the book), then added Tom as a customer on the next turn. Nothing joined
 * the two, and when Nort thought to ask there was no verb to answer a yes with.
 *
 * After customer.create, this finds the visits THIS person booked in the last few hours that have
 * no customer and name the new customer (title) or sit at their address (location). "The same
 * conversation" has no id at the action layer; same author + a short window + the same name is
 * the honest stand-in. It only OFFERS: the result tells Nort to ask, and appointment.linkCustomer
 * runs on the yes (fill vs execute; the app suggests, a person decides).
 */
export const LINK_OFFER_WINDOW_MS = 3 * 3_600_000;

export type LinkCandidateRow = {
  id: string;
  title: string | null;
  location: string | null;
  starts_at: string | null;
};

export type LinkOffer = { appointment_id: string; title: string; when: string };

const norm = (s: string | null | undefined) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Which of the recent customer-less visits belong to this new customer. Pure (the query is the
 *  caller's), so the matching rule is testable. Name: every word of it appears in the title.
 *  Address: the street line appears in the visit's location. Either is enough; neither, no offer. */
export function matchLinkOffers(
  rows: LinkCandidateRow[],
  customer: { name: string; address?: string | null },
  tz: string,
): LinkOffer[] {
  const nameWords = norm(customer.name).split(" ").filter(Boolean);
  const street = norm(customer.address);
  return rows
    .filter((r) => {
      const title = norm(r.title);
      const byName = nameWords.length > 0 && nameWords.every((w) => title.split(" ").includes(w));
      const byPlace = street.length >= 5 && norm(r.location).includes(street);
      return byName || byPlace;
    })
    .slice(0, 3)
    .map((r) => ({ appointment_id: r.id, title: r.title ?? "appointment", when: spokenWhen(r.starts_at, tz) }));
}

/** The sentence that rides beside the offer, telling Nort what to do with it. */
export function linkOfferNextStep(name: string, offers: LinkOffer[]): string {
  if (offers.length === 1) {
    const o = offers[0];
    return `In THIS answer, ask: "Want me to link ${name} to ${o.title} (${o.when})?" Link only on a yes, with appointment.linkCustomer (id ${o.appointment_id}).`;
  }
  return `In THIS answer, ask which of these visits ${name} belongs to (by title and time). Link only the one they pick, on a yes, with appointment.linkCustomer.`;
}
