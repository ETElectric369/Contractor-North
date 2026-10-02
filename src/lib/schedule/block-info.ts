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
 *                already says who, "Marla Finch · Panel Upgrade");
 *   the time     start to end on the company's clock;
 *   the crew     initials chips, a dashed "Nobody" when no one is on it. A visit carries one person.
 *   (the town small, only where there is room: the week's day header already names the day's towns.)
 *
 * A grid block is as tall as its time, so a small one says less, in this order: the name, then the
 * place, then the crew, then the time, then the town (blockRows). Never a line cut in half, never
 * overflowing at 375px. No money here or anywhere near it: the crew reads the same blocks.
 */
import { pillColorForPerson } from "@/lib/employee-color";

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

// Street words as a key, so "498 May Dell Ln." and "498 May Dell Lane" are the same street.
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

/** WHERE A VISIT IS: its own place, else its job's address (a visit booked on a job with no location of
 *  its own, "book an inspection on Honeysuckle at 9"). My Day's agenda row and the schedule's block and
 *  day drill all read it from here, so the same visit never says two places. */
export function visitPlace(a: { location?: string | null; jobs?: { address?: string | null } | null }): string | null {
  return a.location?.trim() || a.jobs?.address?.trim() || null;
}

/**
 * A person on the block, as its chip. The chip wears the PERSON's own color (`dot`, the /timecards
 * person color: lib/employee-color pillColorForPerson), so one person is one color on the tile, the
 * card, the sheet and the worked bars; the block itself keeps its record-type color. `state` is what
 * that day's crew row (Everyone's Day, crew_day_assignments) makes of them, and `title` says it:
 *   on         on it (the default);
 *   off        an 'off' row that day: dimmed and struck through, "<Name> · Off That Day";
 *   elsewhere  a 'job' row for another job that day: dimmed, "<Name> · On <job words> That Day".
 * `departed`: no longer on the active team, still drawn and named ("<Name> · No Longer On The Team").
 */
export type CrewChip = {
  id: string;
  initials: string;
  name: string;
  dot?: string;
  state?: "on" | "off" | "elsewhere";
  title?: string;
  /** For `elsewhere`: the other job's words that day, or null when that job isn't loaded. */
  otherJob?: string | null;
  departed?: boolean;
};

/** One of Everyone's Day's rows (crew_day_assignments, both kinds), as the schedule reads it. */
export type CrewDayRow = { profile_id: string; work_date: string; kind: string; job_id: string | null };

/** Who the crew's ids name: the active team first, then everyone the company ever had (a person who
 *  left still has a name on the days they were on). */
type Person = { id: string; full_name: string | null };

/**
 * THE CREW AS CHIPS, in the order they're on it: initials, the whole name, the person's own color.
 *
 * THE DAY ROW WINS FOR THAT DAY (the 0139/0170 precedence law). Given `day.rows` (that day's rows):
 *   an 'off' row                 dims and strikes the person through ("Off That Day");
 *   a 'job' row for another job  dims them ("On <job words> That Day", "On Another Job That Day"
 *                                when that job isn't loaded) — a job's block only (`day.jobId`);
 *   a 'job' row for THIS job     puts a person who isn't on the job's crew on it for that day.
 * A visit (`day.jobId` null or absent) carries one person, and only an 'off' row applies to it.
 * Without `day` the chips are exactly the crew, as they always were.
 */
export function crewChips(
  ids: readonly (string | null | undefined)[] | null | undefined,
  team: readonly Person[],
  day?: {
    rows?: readonly CrewDayRow[] | null;
    /** This block's job; null or absent for a visit. */
    jobId?: string | null;
    /** Job words by id ("12 Elm St · J-048"), for the other job a person is on that day. */
    jobNames?: ReadonlyMap<string, string> | null;
    /** Everyone the company ever had (id, name), so a person who left is named, never "Unnamed". */
    people?: readonly Person[] | null;
  },
): CrewChip[] {
  const out: CrewChip[] = [];
  const nameOf = (id: string): { name: string; departed: boolean } => {
    const active = team.find((m) => m.id === id)?.full_name?.trim();
    if (active) return { name: active, departed: false };
    const gone = day?.people?.find((m) => m.id === id)?.full_name?.trim();
    // Named from the whole company's people only when the active team doesn't carry them: they left.
    if (gone) return { name: gone, departed: true };
    return { name: "Unnamed", departed: false };
  };
  const rowOf = new Map<string, CrewDayRow>();
  for (const r of day?.rows ?? []) if (r?.profile_id) rowOf.set(String(r.profile_id), r);
  const jobId = day?.jobId ?? null;

  // A plain chip is { id, initials, name }: its color comes from its id (chipDot), its state is on and
  // its title its name. Only what a day row or a departure changes is written on it.
  const chip = (id: string): CrewChip => {
    const { name, departed } = nameOf(id);
    const c: CrewChip = { id, initials: initialsOf(name), name };
    if (departed) {
      c.departed = true;
      c.title = `${name} · No Longer On The Team`;
    }
    const r = rowOf.get(id);
    if (r?.kind === "off") {
      c.state = "off";
      c.title = `${name} · Off That Day`;
    } else if (jobId && r?.kind === "job" && r.job_id && r.job_id !== jobId) {
      const other = day?.jobNames?.get(r.job_id) ?? null;
      c.state = "elsewhere";
      c.otherJob = other;
      c.title = other ? `${name} · On ${other} That Day` : `${name} · On Another Job That Day`;
    }
    return c;
  };

  for (const raw of ids ?? []) {
    const id = String(raw ?? "");
    if (!id || out.some((c) => c.id === id)) continue;
    out.push(chip(id));
  }
  // Put on this job for the day by Everyone's Day, though not on its crew.
  if (jobId) {
    for (const r of day?.rows ?? []) {
      const id = String(r?.profile_id ?? "");
      if (!id || r.kind !== "job" || r.job_id !== jobId || out.some((c) => c.id === id)) continue;
      out.push(chip(id));
    }
  }
  return out;
}

/** A chip's color: its own, else the person's (the /timecards person color, by a stable hash of the id). */
export function chipDot(c: Pick<CrewChip, "id" | "dot">): string {
  return c.dot ?? pillColorForPerson(c.id).dot;
}

/** The crew in words, for a block's title and label: "Crew: Brian Cole (off that day), Erik Taylor", or
 *  "Nobody on it". */
export function crewWords(crew: readonly CrewChip[]): string {
  if (!crew.length) return "Nobody on it";
  const one = (c: CrewChip) =>
    c.state === "off" ? `${c.name} (off that day)` : c.state === "elsewhere" ? `${c.name} (on ${c.otherJob ?? "another job"} that day)` : c.name;
  return `Crew: ${crew.map(one).join(", ")}`;
}

/** What that day's rows did to the crew, one plain line each, for the tile's sheet: "Brian is off that
 *  day.", "Erik is on 12 Elm St · J-048 that day." Nothing when the day moves nobody. */
export function crewDayLines(crew: readonly CrewChip[] | null | undefined): string[] {
  const first = (c: CrewChip) => c.name.split(/\s+/)[0] || c.name;
  const out: string[] = [];
  for (const c of crew ?? []) {
    if (c.state === "off") out.push(`${first(c)} is off that day.`);
    else if (c.state === "elsewhere") out.push(`${first(c)} is on ${c.otherJob ?? "another job"} that day.`);
  }
  return out;
}

/** Everyone's Day's rows grouped by day (YYYY-MM-DD), for the schedule's chips. Bad rows are dropped. */
export function dayRowsByDay(rows: readonly CrewDayRow[] | null | undefined): Record<string, CrewDayRow[]> {
  const out: Record<string, CrewDayRow[]> = {};
  for (const r of rows ?? []) {
    const d = String(r?.work_date ?? "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !r.profile_id) continue;
    (out[d] ??= []).push({ profile_id: String(r.profile_id), work_date: d, kind: String(r.kind ?? "job"), job_id: r.job_id ? String(r.job_id) : null });
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
