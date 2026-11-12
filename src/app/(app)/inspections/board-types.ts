import type { InspectionTile } from "@/lib/inspections";

/**
 * WHAT THE PAGE HANDS ITS BOARD. The page reads, buckets and words everything on the server, in the
 * reader's language and the company's timezone, so the board and a row's ⋯ are handed finished
 * strings and never a date to format (nothing here can differ between the server's render and the
 * phone's).
 */

/** Which of the four moves a row's ⋯ offers. All false, or no menu at all: the row has no ⋯. */
export type RowMenu = {
  /** Move to Another Day… (only a visit that has a start can keep its time of day). */
  move: boolean;
  /** It Happened: Write It Up (marks the visit done, so it moves to Write Up). */
  happened: boolean;
  /** Lost (the visit did not become work; it is kept, under Lost). */
  lost: boolean;
  /** Delete…, behind its ask (removed when nothing hangs on it, otherwise cancelled and kept). */
  del: boolean;
};

/** One inspection, as a row. */
export type BoardRow = {
  /** The visit's id: the row's key, and what its doors write to. */
  id: string;
  /** Who it is for, in bold. */
  who: string;
  /** What it is, as a phrase. May be empty. */
  what: string;
  /** The row's one right edge: how long ago, or its day. Null when the visit has no day to say. */
  edge: string | null;
  /** The inspection's own page. */
  href: string;
  /** The row's own small verb, where its next step is plain (Create Estimate, Pick a Day). */
  verb: { label: string; href: string } | null;
  menu: RowMenu | null;
  /** The visit's start and end as stored, for Move to Another Day… (it keeps the time and the length). */
  startsAt: string | null;
  endsAt: string | null;
};

/** One tile and the rows it opens. */
export type BoardTile = {
  id: InspectionTile;
  /** Its name (Title Case: a tile is a button). */
  name: string;
  /** Its accessible label, said whole. */
  label: string;
  count: number;
  /** One quiet line under the count; null on a tile with nothing in it. */
  line: string | null;
  rows: BoardRow[];
};
