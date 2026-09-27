/**
 * WHO FILLS IN THE WALK-THROUGH (0356). Erik, 2026-09-26: "crew leader yes tech no".
 *
 *   office    staff (owner / admin / office): everything, as before: the price book, scope prices,
 *             Start The Estimate, the address, the links.
 *   crewLead  a crew lead (profiles.crew_lead, set only by an owner or admin) who is ON this visit
 *             (assigned_to = him, the rule 0227 reads by): the sheet's answers, notes, measurements,
 *             materials and photos. Never a price, the price book or Start The Estimate; never the
 *             schedule, status, customer, address or links; he adds photos and never takes one off.
 *   view      everyone else who can open the visit (a plain tech on his own visit): read-only.
 *
 * The database is the boundary (save_walkthrough_capture checks the same rule and holds a crew lead's
 * save to capture only); this is what the page renders from. `rpcReady` is the page's probe of that
 * function: before 0356 is applied a crew lead sees the read-only walk-through, never a Save that
 * cannot work.
 */
export type WalkthroughAccess = "office" | "crewLead" | "view";

export function walkthroughAccess(v: {
  isStaff: boolean;
  crewLead: boolean;
  onThisVisit: boolean;
  rpcReady: boolean;
}): WalkthroughAccess {
  if (v.isStaff) return "office";
  if (v.crewLead && v.onThisVisit && v.rpcReady) return "crewLead";
  return "view";
}

/** PostgREST (PGRST202) or Postgres (42883) saying the function isn't there: 0356 not applied yet. */
export const isMissingRpc = (e: { code?: string | null } | null | undefined): boolean =>
  !!e && (e.code === "PGRST202" || e.code === "42883");

/**
 * THE ANSWERS, WITH NO PRICE IN THEM, for anyone who isn't the office.
 *
 * A scopes question stores [{code, qty, price}] (lib/playbook/scopes.ts), and the page hands the
 * stored answers to the browser. The crew's Inspector never draws a price, but a price in the page's
 * payload has already left the building, so it is taken out on the server before it goes. Only the
 * `price` key goes: the code and quantity say what was picked. The database keeps the office's
 * priced answers whatever a crew lead's save sends back (save_walkthrough_capture).
 */
export function answersWithoutPrices<T extends Record<string, unknown>>(answers: T | null | undefined): T {
  const src = (answers && typeof answers === "object" ? answers : {}) as Record<string, unknown>;
  const strip = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map((x) => (x && typeof x === "object" && !Array.isArray(x) ? omitPrice(x as Record<string, unknown>) : x));
    if (v && typeof v === "object") return omitPrice(v as Record<string, unknown>);
    return v;
  };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) out[k] = strip(v);
  return out as T;
}

function omitPrice(o: Record<string, unknown>): Record<string, unknown> {
  if (!("price" in o)) return o;
  const { price: _drop, ...rest } = o;
  void _drop;
  return rest;
}

/**
 * A crew lead's photo list: every photo already on the walk-through stays, in its place, and his
 * new ones follow. He adds; the office takes one off. Merged on the server before the save, so a
 * photo the office added while his page was open is kept rather than refused.
 */
export function keepStoredPhotos(stored: readonly string[], next: readonly string[]): string[] {
  return [...new Set([...stored, ...next])];
}
