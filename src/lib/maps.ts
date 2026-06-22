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
