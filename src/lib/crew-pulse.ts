import type { CrewMember } from "@/lib/crew-status";
import { formatTime } from "@/lib/utils";
import { todayStrInTz } from "@/lib/tz";

/**
 * WHO ELSE IS ON THE CLOCK, for My Day's Now card (Erik, 2026-10-13: "the who's on the clock should
 * just live with the timeclock"). The card is the office's clock, so the crew's presence sits in it
 * — the same getCrewStatus read Money › Timecards draws (cn-v503), which keeps its block beside the
 * hours it becomes. Pure: the page reads, this shapes, the card draws.
 *
 * The caller is counted but never listed — their own punch IS the card above. Rows run longest-on
 * first, each naming the job by NAME ([[name-jobs-not-numbers]]) or saying it has none yet, since
 * when the SHIFT began — the start of its first piece when a Switch Job cut it (audit v994 SW1,
 * lib/shift-chain; the page passes the starts it could read, the piece's own clock-in stands in) —
 * with its day when it was not today, so "since 7:10 AM" is never read as this morning when it
 * was Tuesday's. A row opens the office's fix door for that entry: Timecards' open-shift read is
 * org-wide and week-less, so ?entry= finds an open entry from any week.
 */
export type CrewPulseRow = { id: string; name: string; job: string | null; since: string; href: string };
export type CrewPulse = { on: number; of: number; rows: CrewPulseRow[] };

export function sinceWords(clockIn: string | null, tz: string, todayStr: string): string {
  if (!clockIn) return "—";
  const d = new Date(clockIn);
  if (!Number.isFinite(d.getTime())) return "—";
  // ICU puts a narrow no-break space before AM/PM on newer Nodes; the card prints a plain one.
  const time = formatTime(d, tz).replace(/\u202f/g, " ");
  if (todayStrInTz(tz, d) === todayStr) return time;
  return `${d.toLocaleDateString("en-US", { timeZone: tz, weekday: "short" })} ${time}`;
}

const ms = (iso: string | null) => (iso ? Date.parse(iso) : NaN);

export function crewPulse(
  crew: CrewMember[],
  selfId: string | null,
  tz: string,
  todayStr: string,
  /** entry id → the shift's start (lib/shift-chain), for pieces cut at a Switch Job. */
  shiftStarts: ReadonlyMap<string, string> = new Map(),
): CrewPulse {
  const on = crew.filter((c) => c.clockedIn);
  const since = (c: CrewMember) => (c.entryId && shiftStarts.get(c.entryId)) || c.clockIn;
  const rows = on
    .filter((c) => c.id !== selfId)
    .sort((a, b) => (ms(since(a)) || Infinity) - (ms(since(b)) || Infinity))
    .map((c) => ({
      id: c.id,
      name: c.name,
      job: c.jobLabel,
      since: sinceWords(since(c), tz, todayStr),
      href: `/timecards?week=0&entry=${encodeURIComponent(c.entryId ?? "")}`,
    }));
  return { on: on.length, of: crew.length, rows };
}

/** What the Now card gets: undefined = not for this viewer, or a one-person company (quiet until a
 *  second person, the switch board's rule j: a block reading "1 of 1 · Just you." under a clock that
 *  already says so is noise); null = the read failed (said); else the pulse. */
export function crewForCard(
  read: { crew: CrewMember[] | null | undefined; starts?: ReadonlyMap<string, string> },
  selfId: string | null,
  tz: string,
  todayStr: string,
): CrewPulse | null | undefined {
  if (read.crew === undefined) return undefined;
  if (read.crew === null) return null;
  const pulse = crewPulse(read.crew, selfId, tz, todayStr, read.starts);
  return pulse.of >= 2 ? pulse : undefined;
}
