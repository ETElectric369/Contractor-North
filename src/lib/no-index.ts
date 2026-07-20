import type { Metadata } from "next";

/**
 * THE robots directive for every PUBLIC-TOKEN page (/i, /q, /c, /portal, /pick, /voice).
 *
 * Those URLs are protected by a permanent, non-expiring bearer token in the path, so URL
 * secrecy is the ONLY control — and the pages behind them carry real PII (customer name,
 * street address, line items, balance due) on the contractor's OWN branded domain. A customer
 * pasting their invoice link into a forum or a review is enough for a crawler to find it, and
 * once it's indexed the only remedy is rotating tokens, which breaks every link already sitting
 * in customers' inboxes.
 *
 * `nocache` + `noimageindex` keep Google's cached copy and the document's images out too, and
 * `noarchive` blocks the Wayback-style archive snapshot — noindex alone doesn't.
 *
 * robots.txt is the OTHER half (src/app/robots.txt/route.ts) and is NOT sufficient on its own:
 * a Disallow'd URL can still be indexed URL-only from an inbound link. Both layers, always.
 */
export const NO_INDEX: Metadata["robots"] = {
  index: false,
  follow: false,
  nocache: true,
  noarchive: true,
  googleBot: { index: false, follow: false, noimageindex: true },
};
