/**
 * WHICH JOB IS THE PHONE STANDING AT (the owner, 2026-11-04: "location for clock-in defaults to the
 * job picker and doesn't necessarily ask location"). Pure: the punch's own fix against the jobs'
 * places (job-coordinates), so the order is pinned without a database or a phone.
 *
 * The app OFFERS, the person decides: exactly one job inside the company's fence radius is the
 * clock's pick (and the clock says so); several nearby only put those first in "Which Job Are You
 * On?", nearest first, each with how far it is. Nothing past MAX_NEAR_M is "near".
 */
import { fillText, translator, type Lang } from "@/lib/i18n";

/** How far a job can be and still be offered as near (2 km, a site and its street). */
export const MAX_NEAR_M = 2000;

export type Fix = { lat: number; lng: number; accuracy?: number | null };
export type Placed = { lat: number; lng: number };
export type Ranked<T> = T & { distanceM: number; within: boolean };

/** A fix the step can use: finite, on the globe, and not so blurred it could be anywhere nearby. */
export function usableFix(fix: Partial<Fix> | null | undefined, maxM: number = MAX_NEAR_M): Fix | null {
  if (!fix) return null;
  const { lat, lng } = fix;
  if (typeof lat !== "number" || typeof lng !== "number" || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180 || (lat === 0 && lng === 0)) return null;
  const acc = typeof fix.accuracy === "number" && Number.isFinite(fix.accuracy) ? fix.accuracy : null;
  if (acc !== null && acc > maxM) return null;
  return { lat, lng, accuracy: acc };
}

/** Metres between two points on the earth (haversine). */
export function haversineM(a: Placed, b: Placed): number {
  const R = 6_371_000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * The jobs within `maxM` of the fix, nearest first, each with its distance and whether it is inside
 * the fence (`radiusM`, the company's geofence_radius_m). A tie keeps the order the jobs came in.
 */
export function rankByDistance<T extends Placed>(
  fix: Placed,
  jobs: readonly T[],
  opts: { radiusM: number; maxM?: number },
): Ranked<T>[] {
  const maxM = opts.maxM ?? MAX_NEAR_M;
  return (jobs ?? [])
    .filter((j) => j && Number.isFinite(j.lat) && Number.isFinite(j.lng))
    .map((j, i) => ({ j, i, d: haversineM(fix, j) }))
    .filter((x) => x.d <= maxM)
    .sort((a, b) => a.d - b.d || a.i - b.i)
    .map(({ j, d }) => ({ ...j, distanceM: Math.round(d), within: d <= opts.radiusM }));
}

/**
 * How far, in the reader's words: feet then miles in English ("120 ft away", "0.8 mi away"),
 * metres then kilometres in Spanish ("a 120 m", "a 1,3 km"). Rounded to ten, never "0".
 */
export function distanceWords(m: number, lang?: Lang | null): string {
  const t = translator(lang);
  const metres = Math.max(0, Number.isFinite(m) ? m : 0);
  if (lang === "es") {
    if (metres < 1000) return fillText(t("cs_distNear"), { n: String(Math.max(10, Math.round(metres / 10) * 10)) });
    return fillText(t("cs_distFar"), { n: (metres / 1000).toFixed(1).replace(".", ",") });
  }
  const ft = metres * 3.28084;
  if (ft < 1000) return fillText(t("cs_distNear"), { n: String(Math.max(10, Math.round(ft / 10) * 10)) });
  return fillText(t("cs_distFar"), { n: (metres / 1609.344).toFixed(1) });
}
