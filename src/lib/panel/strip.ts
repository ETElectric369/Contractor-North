/**
 * THE LABEL STRIPS, AS DATA (the panel-first wave, P0). Pure: no React, no Supabase.
 *
 * A panel door's labels are two strips, one beside each column of breakers: the left strip names
 * the odd spaces, the right strip the even ones, in the order they hang (space 1 at the top unless
 * the panel's numbers run bottom up). Each strip is a column of boxes, one box per HANDLE:
 *
 *   single   a full-width 1-pole breaker: one box, one space tall (the pitch).
 *   tandem   a twin or a quad's outer pole: its space holds two handles, A over B, so it is two
 *            boxes, each half a space tall. A half nobody uses is an empty box of the same height.
 *   pole2    a 2-pole covers s and s+2 on the same side; BOTH its boxes carry the same words
 *            ("Dryer" twice), each as tall as the handle (a quad's centre 2-pole is two half-space
 *            handles, its first space's half and the other half of the next — model slotsOf;
 *            sB and (s+2)A when space 1 is at the top, sA and (s+2)B when it is at the bottom,
 *            quadCentreHalf — so its two boxes are half a space tall, in the middle of the quad).
 *   pole3    the same on three spaces.
 *   empty    a space (or a half) with nothing in it: a blank box, so the boxes below still line up.
 *   dead     a No Stab space with nothing in it: a blank box.
 *   none     the cell beside the last space of a panel with an odd count (doorRows' rightNone): not
 *            on the panel at all. No box is printed for it (only the gap it leaves, so the two
 *            strips still line up), it is never a line to fill, and it adds nothing to a strip's
 *            length.
 *
 * Where a circuit sits and what collides is the model's (spaceMap, doorRows in model.ts): this file
 * only turns its cells into boxes, so the strip, the tab's door and the printed directory can never
 * disagree about which circuit is in which space. A circuit COMING OUT (work 'removed') gets no
 * label: the strips are the door after the work. The words are the door's (panel_label) when set,
 * else what it feeds (description), trimmed; the amps ride separately for the caller to add.
 */
import type { JobCircuit, JobPanel, SpaceHalf } from "@/lib/types";
import { doorRows, spaceMap } from "./model";
import { panelGeometry, type GeometryPanel } from "./geometry";

export type StripLineKind = "single" | "tandem" | "pole2" | "pole3" | "empty" | "dead" | "none";

export type StripLine = {
  space: number;
  /** A or B on a tandem space; null on a full-width line. */
  half: SpaceHalf | null;
  /** The box's height in inches: the pitch, or half of it on a tandem space. */
  heightIn: number;
  /** The door's words for it ("" on an empty or dead box). Two circuits on one line (a collision
   *  the warnings name) are both said, "A / B", never one silently dropped. */
  text: string;
  amps: number | null;
  circuitId: string | null;
  kind: StripLineKind;
};

export type Strips = {
  left: StripLine[];
  right: StripLine[];
  /** The model's warnings, as a person reads them (two on one space, No Stab, past the end). */
  warnings: string[];
};

export type StripPanel = Pick<JobPanel, "id" | "spaces" | "numbering" | "dead_spaces" | "twin_spaces"> & GeometryPanel;
export type StripCircuit = Pick<
  JobCircuit,
  "id" | "panel_id" | "space" | "half" | "poles" | "state" | "removed_at" | "room" | "description" | "panel_label" | "amps"
> &
  Partial<Pick<JobCircuit, "work">>;

/** What the door says for a circuit: its door label, else what it feeds, spaces tidied. */
export function stripWords(c: Pick<JobCircuit, "panel_label" | "description">): string {
  const tidy = (s: string | null | undefined) => String(s ?? "").replace(/\s+/g, " ").trim();
  return tidy(c.panel_label) || tidy(c.description);
}

export function stripLines(panel: StripPanel, circuits: StripCircuit[]): Strips {
  const { pitchIn } = panelGeometry(panel);
  const onDoor = circuits.filter((c) => c.work !== "removed");
  const map = spaceMap(panel, onDoor);
  const byId = new Map(onDoor.map((c) => [c.id, c]));
  const dead = new Set(panel.dead_spaces ?? []);
  // A panel whose size nobody has said runs as far as its circuits do; a sized one is exactly its
  // spaces (a circuit past the end is a warning, never an extra box below the box).
  const rows = doorRows(panel, panel.spaces == null ? [...map.cells.keys()] : []);

  const line = (space: number, half: SpaceHalf | null, ids: string[], heightIn: number): StripLine => {
    const cs = [...new Set(ids)].map((id) => byId.get(id)).filter((c): c is StripCircuit => !!c);
    if (!cs.length) {
      return { space, half, heightIn, text: "", amps: null, circuitId: null, kind: !half && dead.has(space) ? "dead" : "empty" };
    }
    const first = cs[0];
    const poles = Math.max(1, Math.min(3, Number(first.poles) || 1));
    const kind: StripLineKind = poles === 3 ? "pole3" : poles === 2 ? "pole2" : half ? "tandem" : "single";
    return {
      space,
      half,
      heightIn,
      text: cs.map(stripWords).filter(Boolean).join(" / "),
      amps: first.amps ?? null,
      circuitId: first.id,
      kind,
    };
  };

  const boxes = (space: number): StripLine[] => {
    const k = map.cells.get(space);
    if (!k || (!k.full.length && !k.A.length && !k.B.length)) return [line(space, null, [], pitchIn)];
    // A full-width handle takes the whole space (anything else on it is a collision the warnings say).
    if (k.full.length) return [line(space, null, k.full, pitchIn)];
    return [line(space, "A", k.A, pitchIn / 2), line(space, "B", k.B, pitchIn / 2)];
  };

  // The cell beside an odd panel's last space: nothing there, never a box.
  const none = (space: number): StripLine => ({ space, half: null, heightIn: pitchIn, text: "", amps: null, circuitId: null, kind: "none" });

  return {
    left: rows.flatMap((r) => boxes(r.left)),
    right: rows.flatMap((r) => (r.rightNone ? [none(r.right)] : boxes(r.right))),
    warnings: map.warnings.map((w) => w.message),
  };
}

/** A strip's length in inches: what its printed boxes add up to (the door's column, top to bottom).
 *  The gap beside an odd panel's last space is not a box and is not counted. */
export function stripLengthIn(lines: Pick<StripLine, "heightIn" | "kind">[]): number {
  return lines.reduce((s, l) => s + (l.kind === "none" ? 0 : l.heightIn), 0);
}
