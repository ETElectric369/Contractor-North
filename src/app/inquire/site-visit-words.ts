/**
 * WHAT A CUSTOMER READS AFTER "REQUEST A SITE VISIT", booked or not (cn-v1180, audit A6). The tap
 * used to answer "You're on the schedule" when the lead it found had a booking, and it found the
 * lead by a typed phone, so a stranger with somebody's phone learned that person was booked. The
 * server's answer no longer says which, and this one sentence is true either way. An English literal:
 * a public page imports no catalog. Both public forms (/inquire and the deck configurator) read it.
 */
export const SITE_VISIT_REQUESTED =
  "Request received. If you're already on our schedule, you're all set; otherwise we'll text you a few time options shortly.";
