/**
 * WHERE A VISIT LIVES IN THE APP — one rule, two readers.
 *
 * A visit's address (/appointments/<id>) does not say what kind of visit it is, and its kind decides
 * where it lives: an inspection, a final inspection or a quote visit is a row on Sales › Inspections
 * (that list's own filter, lib/statuses ESTIMATE_VISIT_TYPES); every other booking is a block on the
 * Schedule. A tech has neither door: his visits are on My Day.
 *
 *   1. THE SHELL. The visit's page declares `nav` (components/nav-home), so the dock lights the
 *      cluster the visit belongs to and its sub-nav stays (Erik, 2026-11-10: "the sub-nav
 *      disappears when an inspection is clicked").
 *   2. THE WAY OUT. When the visit is deleted or cancelled from its own page, the person lands on
 *      `href` (the same report: deleting an inspection ended on the app's 404 page).
 *
 * `nav` is a dock row's id (lib/dock); the test holds each one to a real row whose page `href` is.
 * Pure: no database, no React, no words.
 */
import { ESTIMATE_VISIT_TYPES } from "@/lib/statuses";

export type VisitHome = {
  /** The dock row the visit belongs under: what the shell lights while its page is open. */
  nav: "sl-inspections" | "s-week" | "t-day";
  /** That place's address: where the person lands once the visit is gone from under its page. */
  href: string;
};

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/**
 * `day` is the visit's own day on the company's clock (YYYY-MM-DD), when it has one: a booking's
 * home is that day on the Schedule, where the hole it left shows. `staff` false is a tech.
 */
export function visitHome(type: string | null | undefined, opts: { day?: string | null; staff?: boolean } = {}): VisitHome {
  if (opts.staff === false) return { nav: "t-day", href: "/planner" };
  if ((ESTIMATE_VISIT_TYPES as readonly string[]).includes(type ?? "")) return { nav: "sl-inspections", href: "/inspections" };
  const day = opts.day && YMD.test(opts.day) ? opts.day : null;
  return { nav: "s-week", href: day ? `/schedule?view=day&date=${day}` : "/schedule" };
}
