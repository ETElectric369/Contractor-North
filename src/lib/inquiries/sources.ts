/**
 * WHERE A LEAD CAME FROM, AS ONE LIST (W2-07).
 *
 * The lead row drew "web" for two sources and "deck site" for two more, and knew nothing of the
 * other doors a company's website has (the contact form, the site chat), so half the web leads read
 * as typed by hand. This is the one list of inquiries.source values that mean "your website", beside
 * the lead writers: the row draws one Globe ("From Your Website") for any of them, and
 * sources.test.ts scans every lead door so a new door's source can't be missing from it.
 *
 *   public_form        the public lead form (the submit_inquiry RPC)
 *   intake             the company's intake form (/intake/<handle>)
 *   website_contact    the website's contact form
 *   site_chat          the website's chat ("Ask <company>")
 *   deck_configurator  the online estimate configurator (/estimate/<handle>)
 *   tahoe_deck         a stored legacy value: what the inbound-lead API wrote for a configurator
 *                      lead before its source was named for what it is (no new row should say it)
 *
 * Everything else a person typed ("manual"). Pure: no database, no React.
 */
export const WEB_SOURCES = [
  "public_form",
  "intake",
  "website_contact",
  "site_chat",
  "deck_configurator",
  "tahoe_deck",
] as const;

export type WebSource = (typeof WEB_SOURCES)[number];

/** True when a lead's source is one of the website's doors. */
export const isWebSource = (source: string | null | undefined): boolean =>
  (WEB_SOURCES as readonly string[]).includes(String(source ?? ""));
