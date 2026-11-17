/**
 * THE JOB MAP'S PIN: where it goes and what its card says. Pure (no React, no catalog, no Google).
 *
 * 2026-11-16, the owner, on the Schedule's Job map, looking at a pin near Montreal that carried the
 * name of a street in his own town: "so where is this random address near montreal stored because
 * when i click on it it brings me to the [right] job with the [right town's] address, something is
 * weird".
 * It was stored nowhere. The map asked Google for each job's place every time it opened, and it sent
 * the job's STREET LINE alone: the town, the state and the ZIP sit in their own columns (0177) and
 * never went along, so a street name that exists in many towns was answered with one of the others.
 * The fence's lookup has sent the whole line since 0404 (lib/timeclock/job-coordinates
 * jobAddressLine). The map sends that same line now, and where the job already keeps its point from
 * that lookup the map uses the point and asks nobody.
 */
export type MapPin = {
  id: string;
  name: string;
  /** The line Google reads: the street, then the city, state and ZIP (jobAddressLine). */
  address: string | null;
  customer: string | null;
  /** The point already kept on the job (0404: geo_lat, geo_lng), when it has one. */
  lat?: number | null;
  lng?: number | null;
};

/** A stored coordinate as a number, or null. A numeric column can come back as a number or a string. */
export function storedCoord(v: unknown): number | null {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/** The point kept on the job, when it has both halves and they are a latitude and a longitude. */
export function storedPoint(p: { lat?: unknown; lng?: unknown }): { lat: number; lng: number } | null {
  const lat = storedCoord(p.lat);
  const lng = storedCoord(p.lng);
  if (lat === null || lng === null) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

/**
 * The card a pin opens, built as NODES. A job's name and its customer's name are words people typed
 * (a customer's can begin on the public form), and this card used to be one HTML string with both
 * written into it.
 */
export function pinCard(doc: Document, j: Pick<MapPin, "id" | "name" | "customer">, openWords: string): HTMLElement {
  const box = doc.createElement("div");
  box.style.fontSize = "13px";
  const name = doc.createElement("strong");
  name.textContent = j.name;
  box.append(name, doc.createElement("br"));
  if (j.customer) box.append(doc.createTextNode(j.customer), doc.createElement("br"));
  const open = doc.createElement("a");
  open.href = `/jobs/${encodeURIComponent(j.id)}`;
  open.textContent = `${openWords} →`;
  box.append(open);
  return box;
}
