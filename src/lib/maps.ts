// One source of truth for "navigate to an address" links. A `?q=` URL only drops
// a SEARCH PIN — it does not start guided navigation. Both forms below open guided
// DRIVING directions (native turn-by-turn on the user's phone). Centralized so no
// caller re-introduces a pin link.
export type MapsProvider = "apple" | "google";
export const MAPS_PROVIDER_KEY = "cn_maps_provider";

export function navUrl(address: string, provider: MapsProvider = "apple"): string {
  const a = encodeURIComponent(address);
  return provider === "google"
    ? `https://www.google.com/maps/dir/?api=1&destination=${a}&travelmode=driving`
    : `https://maps.apple.com/?daddr=${a}&dirflg=d`;
}

/** First non-empty, trimmed candidate — the best free-text destination for a Navigate
 *  link. Callers pass [structured address, customer address, job/appt name] in preference
 *  order, so the Navigate button degrades to the next-best target instead of VANISHING
 *  when a job's address was typed into its name (a common field shortcut — the maps app
 *  geocodes free text, so "13631 Northwoods" still routes). Returns "" only when every
 *  candidate is empty, so callers can still gate on it if they truly have nothing. */
export function directionsTarget(...candidates: (string | null | undefined)[]): string {
  for (const c of candidates) {
    const v = (c ?? "").trim();
    if (v) return v;
  }
  return "";
}
