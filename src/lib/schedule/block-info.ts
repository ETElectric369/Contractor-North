/**
 * THE BLOCK SAYS WHERE AND WHO (text to visual, Erik 2026-09-28 on the Schedule page at night: "we
 * definitly need the address showing up on the job block with info too"). Every job and visit block
 * on the schedule (the week and day grids, the day drill's card, the rail's card) and My Day's agenda
 * rows read the same four things, from here, so no surface words them its own way:
 *
 *   the name     the job's name (a visit's title);
 *   the place    the STREET NUMBER AND NAME, never the city or the zip. But a job named for its street
 *                (Erik's rule for names, "street number and name as always") would say the street
 *                twice, so then the place is WHO: the customer's name (and nothing when the name
 *                already says who, "Jackie Burks · Panel Upgrade");
 *   the time     start to end on the company's clock;
 *   the crew     initials chips, a dashed "Nobody" when no one is on it. A visit carries one person.
 *   (the town small, only where there is room: the week's day header already names the day's towns.)
 *
 * A grid block is as tall as its time, so a small one says less, in this order: the name, then the
 * place, then the crew, then the time, then the town (blockRows). Never a line cut in half, never
 * overflowing at 375px. No money here or anywhere near it: the crew reads the same blocks.
 */

/** The street line of a one-line address: "12 Elm St, Testville, CA 96161" → "12 Elm St". A line whose
 *  head is only a town or a zip ("Testville, CA 96161", "96161") has no street: "". */
export function streetOf(line: string | null | undefined): string {
  const parts = String(line ?? "").split(",").map((x) => x.replace(/\s+/g, " ").trim());
  const head = parts[0] ?? "";
  if (!head) return "";
  if (/^(?:[a-z]{2}\s*)?\d{5}(?:-\d{4})?$/i.test(head)) return ""; // "96161", "CA 96161"
  // "Testville, CA 96161": a head with no number, then only a state (and a zip) is a town.
  if (parts.length === 2 && !/\d/.test(head) && /^[a-z]{2}(?:\s+\d{5}(?:-\d{4})?)?$/i.test(parts[1] ?? "")) return "";
  return head;
}

/** The town of a one-line address, when it names one: "12 Elm St, Testville, CA 96161" → "Testville". */
export function townOf(line: string | null | undefined): string {
  const parts = String(line ?? "").split(",").map((x) => x.replace(/\s+/g, " ").trim()).filter(Boolean);
  if (parts.length >= 3) return parts[parts.length - 2];
  if (parts.length === 2 && !/\d/.test(parts[0]) && /^[a-z]{2}(?:\s+\d{5}(?:-\d{4})?)?$/i.test(parts[1])) return parts[0];
  return "";
}

// Street words as a key, so "498 Mil Drae Ln." and "498 Mil Drae Lane" are the same street.
const SUFFIX: Record<string, string> = {
  street: "st", str: "st", avenue: "ave", av: "ave", road: "rd", drive: "dr", lane: "ln", court: "ct",
  boulevard: "blvd", boul: "blvd", place: "pl", circle: "cir", highway: "hwy", parkway: "pkwy", terrace: "ter",
  trail: "trl", way: "wy", north: "n", south: "s", east: "e", west: "w", mount: "mt", saint: "st", apartment: "apt",
  suite: "ste", unit: "unit",
};
function key(s: string | null | undefined): string {
  return String(s ?? "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => SUFFIX[w] ?? w)
    .join("");
}

/** Does the name already say this (the street, the customer)? Case, punctuation and "Lane"/"Ln." aside. */
export function nameSays(name: string | null | undefined, words: string | null | undefined): boolean {
  const k = key(words);
  return k !== "" && key(name).includes(k);
}

export type PlaceLine = { text: string; kind: "street" | "customer" };

/**
 * THE PLACE LINE: the street number and name; when the name already says the street, who (the
 * customer); nothing when the name says both (or there is neither).
 */
export function placeLine(p: { name: string | null | undefined; street: string | null | undefined; customer?: string | null }): PlaceLine | null {
  const street = streetOf(p.street);
  if (street && !nameSays(p.name, street)) return { text: street, kind: "street" };
  const who = String(p.customer ?? "").replace(/\s+/g, " ").trim();
  if (who && !nameSays(p.name, who)) return { text: who, kind: "customer" };
  return null;
}

/** A person on the block, as its chip. */
export type CrewChip = { id: string; initials: string; name: string };

/** The crew as chips, in the order they're on it: initials and the whole name (for the chip's title). */
export function crewChips(ids: readonly (string | null | undefined)[] | null | undefined, team: readonly { id: string; full_name: string | null }[]): CrewChip[] {
  const out: CrewChip[] = [];
  for (const raw of ids ?? []) {
    const id = String(raw ?? "");
    if (!id || out.some((c) => c.id === id)) continue;
    const name = team.find((m) => m.id === id)?.full_name?.trim() || "Unnamed";
    out.push({ id, initials: initialsOf(name), name });
  }
  return out;
}

/** "Erik Taylor" → "ET", "Brian" → "B", "" → "?". */
export function initialsOf(name: string | null | undefined): string {
  const words = String(name ?? "").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  return words
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
}

/** "10a", "9:30a", "12p", "12a" (midnight) — a block's clock in as few letters as it reads. */
export function hmShort(min: number): string {
  const m = ((Math.round(min) % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  const ap = h < 12 ? "a" : "p";
  return `${h % 12 || 12}${mm ? `:${String(mm).padStart(2, "0")}` : ""}${ap}`;
}

/** "10a–12p": a block's start to end, for a grid block's time line. */
export function spanShort(startMin: number, endMin: number): string {
  return `${hmShort(startMin)}–${hmShort(endMin)}`;
}

/** What a grid block has to say beyond its name. */
export type BlockHas = { place: boolean; crew: boolean; time: boolean; town: boolean };

// The block's text is 10px at leading-tight (12.5px a line); a chip row is 14px and a 2px gap; the
// block's own padding and border take 6px.
const CHROME_PX = 6;
const LINE_PX = 12.5;
const CHIPS_PX = 16;

/**
 * WHAT A BLOCK OF THIS HEIGHT SHOWS: the name always, then — each only when the whole line fits under
 * the ones before it — the place, the crew, the time, the town. A half-hour block is its name; an hour
 * is the name, the place and the crew; two hours is everything.
 */
export function blockRows(heightPx: number, has: BlockHas): BlockHas {
  let used = CHROME_PX + LINE_PX;
  const room = (px: number) => {
    if (used + px > heightPx + 0.5) return false;
    used += px;
    return true;
  };
  const place = has.place && room(LINE_PX);
  const crew = has.crew && room(CHIPS_PX);
  const time = has.time && room(LINE_PX);
  const town = has.town && room(LINE_PX);
  return { place, crew, time, town };
}
