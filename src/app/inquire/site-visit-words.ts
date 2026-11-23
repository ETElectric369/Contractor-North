/**
 * WHAT A CUSTOMER READS AFTER "REQUEST A SITE VISIT", booked or not (cn-v1180, audit A6). The tap
 * used to answer "You're on the schedule" when the lead it found had a booking, and it found the
 * lead by a typed phone, so a stranger with somebody's phone learned that person was booked. The
 * server's answer no longer says which, and this one sentence is true either way. An English literal:
 * a public page imports no catalog. Both public forms (/inquire and the deck configurator) read it.
 */
export const SITE_VISIT_REQUESTED =
  "Request received. If you're already on our schedule, you're all set; otherwise we'll text you a few time options shortly.";

/**
 * THE OPEN-TIMES OFFER (cn-v1185): what a visitor reads when the company offers open inspection times
 * and they pick one (src/components/site-visit-offer.tsx). English literals, as above.
 */
export const PICK_A_TIME_HEADING = "Pick a time for your site visit";
export const NONE_OF_THESE_WORK = "None of These Work";
export const TIME_JUST_TAKEN = "That time was just taken. Here are the open times now.";
export function bookedSentence(label: string): string {
  return `You're booked for ${label}. We'll see you then.`;
}
/** The button on a form that had no request button (the hosted site's contact form, the intake form). */
export const OFFER_A_SITE_VISIT = "Pick a Time for a Site Visit";
/**
 * WHERE TO COME, asked at the pick when the lead has no address (cn-v1185, skeptic #87 S10): the
 * hosted site's contact form asks none, and a visit with no address sends the crew nowhere.
 */
export const WHERE_SHOULD_WE_COME = "Where should we come?";
export const ADDRESS_PLACEHOLDER = "Street address and city";
export const ADDRESS_FIRST = "Add the address first so we know where to come.";
