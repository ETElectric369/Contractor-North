import { lastFix, type GeoCoords } from "@/lib/geo";

/**
 * WHERE AN ADDRESS BOX LOOKS FIRST.
 *
 * Every AddressAutocomplete sends this with its keystrokes (/api/places adds the circle). Two
 * sources, in order: the phone's most recent real fix from ANY caller (a clock-in this morning,
 * the weather's Use My Location, the geofence) — within a day, because a company works near where
 * it worked this morning; else the company's own address, which the app shell geocodes once and
 * hands down (OrgPlaceBias). An office desktop has no fix and gets the shop; a phone in the field
 * gets itself. Neither asks the person for permission: a fix is only ever read from the cache a
 * real tap already filled (lib/geo, THE iOS RULE).
 */
export const FIX_MAX_AGE_MS = 24 * 60 * 60 * 1000;

let orgBias: GeoCoords | null = null;

/** Set by the app shell for the signed-in company; cleared when it unmounts. */
export function setOrgBias(bias: GeoCoords | null): void {
  orgBias = bias;
}

export function addressBias(): GeoCoords | null {
  return lastFix(FIX_MAX_AGE_MS) ?? orgBias;
}
