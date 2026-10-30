/**
 * WHICH KEPT CIRCUIT HOLDS A SUGGESTION'S SPACE (the panel-first wave, P1). Pure: no React, no
 * Supabase, so the tab's visual and the server's Use It ask the same question and get the same
 * answer.
 *
 * A suggestion that lands on a space a kept circuit already holds is not a second circuit: it is
 * the photo (or the plans) reading a DIFFERENT NAME for the breaker already there ("Photo says:
 * Wine Cooler" under the kept "Bar"). The visual draws it under that kept line with Use It and
 * Skip; useSuggestedWords writes its words onto the circuit this file names.
 *
 * Two handles meet when they sit on the same space and either one is full width or both are in the
 * same half (A with A, B with B). A tandem's A and B share a space without meeting. A 2-pole's
 * slots are its own (slotsOf): a 2-pole on 9 holds 9 and 11.
 *
 * And the one rule for a LOOSE circuit (panel_id null, listed before the job had a panel): which
 * panel it belongs to (belongsToPanel). The tab's door, the line sheet, Move, the Print card, the
 * printed labels and where a photo's read lands all ask it, so none of them can disagree.
 */
import type { JobCircuit, JobPanel, SpaceHalf } from "@/lib/types";
import { slotsOf, type Slot } from "./model";

type Placed = Pick<JobCircuit, "id" | "space" | "half" | "poles">;

/**
 * DOES THIS CIRCUIT BELONG TO THIS PANEL? When it is on it; or when it is on no panel yet and the
 * job has exactly one live panel — the one the server moves it onto (lib/panel/ensure-panel) — or
 * none yet, when the panel asked about is Panel 1 waiting to be made with the next circuit (the
 * tab's stand-in). With several live panels a loose circuit is nobody's until a person picks. A
 * count nobody knows (null) never adopts one.
 */
export function belongsToPanel(c: Pick<JobCircuit, "panel_id">, panel: Pick<JobPanel, "id">, livePanelCount: number | null | undefined): boolean {
  if (c.panel_id != null) return c.panel_id === panel.id;
  return livePanelCount != null && livePanelCount <= 1;
}

/** The circuits that belong to the panel (belongsToPanel), a loose one read as ON it (its panel_id
 *  set to the panel's), the way the server will place it: what the model's spaceMap draws. */
export function circuitsOfPanel<T extends Pick<JobCircuit, "panel_id">>(panel: Pick<JobPanel, "id">, circuits: T[], livePanelCount: number | null | undefined): T[] {
  return circuits.filter((c) => belongsToPanel(c, panel, livePanelCount)).map((c) => (c.panel_id === panel.id ? c : { ...c, panel_id: panel.id }));
}

/** Which field of the kept circuit a suggestion's words go into (Use It): the door's words onto its
 *  door label, what-it-feeds words onto what it feeds; null when the suggestion has no words. */
export function suggestedWordsField(s: Pick<JobCircuit, "panel_label" | "description">): "panel_label" | "description" | null {
  const tidy = (v: string | null | undefined) => String(v ?? "").replace(/\s+/g, " ").trim();
  return tidy(s.panel_label) ? "panel_label" : tidy(s.description) ? "description" : null;
}

/** Do these two slots meet (the same handle position on the door)? */
export function slotsMeet(a: Slot, b: Slot): boolean {
  return a.space === b.space && (a.half == null || b.half == null || a.half === b.half);
}

export type Held<T extends Placed> = {
  /** The suggestion's first slot that something already holds. */
  space: number;
  half: SpaceHalf | null;
  /** Every circuit in `others` that holds that slot (more than one is a collision a person fixes). */
  holders: T[];
  /** Where the (first) holder's own line is on that space: its half, or null when it is full width. */
  lineHalf: SpaceHalf | null;
};

/**
 * The first of `s`'s slots (in slotsOf order) that a circuit in `others` already holds, with every
 * circuit that holds it; null when every slot is open. `s` itself is never its own holder.
 */
export function heldBy<T extends Placed>(s: Placed, others: T[]): Held<T> | null {
  for (const slot of slotsOf(s)) {
    const holders = others.filter((o) => o.id !== s.id && slotsOf(o).some((x) => slotsMeet(x, slot)));
    if (!holders.length) continue;
    const own = slotsOf(holders[0]).find((x) => slotsMeet(x, slot));
    return { space: slot.space, half: slot.half, holders, lineHalf: own?.half ?? null };
  }
  return null;
}
