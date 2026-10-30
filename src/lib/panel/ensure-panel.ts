/**
 * PANEL 1 EXISTS THE MOMENT A JOB HAS A CIRCUIT (the panel-first wave, P0).
 *
 * Before this wave a circuit could live with no panel (job_circuits.panel_id null) and nothing ever
 * made a job_panels row, so a job's Panel tab said it had no panel over a list of 34 circuits. Now
 * every door that creates or keeps a circuit asks this first: the job's first live panel (oldest,
 * then by id), or a new one called Panel 1 when it has none. Then the job's circuits that sit on no
 * panel move onto it, so the door the crew looks at shows every one of them.
 *
 * THE RULES IT KEEPS (0333's guard, in the person's own session — RLS and the trigger decide, this
 * only asks):
 *   · A new panel is 24 spaces, numbered top down — unless the job's circuits already sit past
 *     space 24, and then it is just big enough to hold them (the next even number, at most 84), so
 *     no circuit a person placed is stranded by a guess.
 *   · A KEPT, live circuit is never moved onto a space the panel calls No Stab or past its end (the
 *     database would refuse the whole batch): those stay where they are and are counted in `left`,
 *     for the person to place. Suggestions move freely; the guard checks them when they are kept.
 *     A circuit taken off moves with the rest (Undo puts it back on the panel), uncounted.
 *   · Only when the job has ONE live panel do its loose circuits move. With several, which panel a
 *     loose circuit belongs to is a person's pick, never this file's (they are counted in `left`).
 *   · Every write reads back what it wrote (the silent-write law): a move that hits nobody — a
 *     crewmate placed them first — is zero adopted, not an error, and not passed off as a move.
 *
 * Not a server action ("use server" is not on this file): nothing a browser can call directly. It
 * takes the caller's own client. A failed read or write THROWS, with the database's answer as its
 * cause; the callers in panel-actions.ts catch it, file it, and carry on the way they did before.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { JobCircuit, JobPanel } from "@/lib/types";
import { MAX_SPACES } from "./input";
import { slotsOf } from "./model";

/** Every column of a panel the tab and the label strips read (0333, and 0402's three measurements).
 *  ONE list: the Panel tab's loader, savePanel and this file all select exactly this. */
export const PANEL_COLUMNS =
  "id, org_id, job_id, name, brand, bus_amps, main_amps, spaces, numbering, dead_spaces, twin_spaces, space_pitch_in, label_width_in, label_width_in_right, photo_document_id, notes, shown_on_portal, created_by, created_at, updated_by, updated_at, removed_at, removed_by";

/** The panel a job gets when it has none. */
export const FIRST_PANEL_NAME = "Panel 1";
export const FIRST_PANEL_SPACES = 24;

export type EnsuredPanel = {
  panelId: string;
  /** True when this call made Panel 1. */
  created: boolean;
  /** Loose circuits this call moved onto the panel: how many, and which (the tab sets their panel). */
  adopted: number;
  adoptedIds: string[];
  /** The job's live panels after the call, counted to two (1 = this panel is the job's only one). */
  livePanels: number;
  /** Loose circuits still on no panel after it: a kept one on No Stab or past the end, or every
   *  loose one when the job has several panels (a person picks). */
  left: number;
  /** The panel, every column in PANEL_COLUMNS. */
  panel: JobPanel;
};

type Loose = Pick<JobCircuit, "id" | "space" | "half" | "poles" | "state" | "removed_at">;

class PanelWriteError extends Error {
  constructor(words: string, cause: unknown) {
    super(words, { cause });
    this.name = "PanelWriteError";
  }
}

/** The job's live panels, oldest first (then by id), at most two: the first, and whether it is alone. */
async function livePanels(sb: SupabaseClient, orgId: string, jobId: string): Promise<JobPanel[]> {
  const { data, error } = await sb
    .from("job_panels")
    .select(PANEL_COLUMNS)
    .eq("job_id", jobId)
    .eq("org_id", orgId)
    .is("removed_at", null)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(2);
  if (error) throw new PanelWriteError("The job's panel couldn't be read.", error);
  return (data ?? []) as unknown as JobPanel[];
}

async function looseCircuits(sb: SupabaseClient, orgId: string, jobId: string): Promise<Loose[]> {
  const { data, error } = await sb
    .from("job_circuits")
    .select("id, space, half, poles, state, removed_at")
    .eq("job_id", jobId)
    .eq("org_id", orgId)
    .is("panel_id", null);
  if (error) throw new PanelWriteError("The job's circuits couldn't be read.", error);
  return (data ?? []) as unknown as Loose[];
}

/** How many spaces a new panel needs: 24, or enough for the highest space a live circuit sits on
 *  (rounded up to even, so both columns are whole), at most 84. */
export function spacesToHold(circuits: Pick<JobCircuit, "space" | "half" | "poles" | "removed_at">[]): number {
  let top = 0;
  for (const c of circuits) {
    if (c.removed_at) continue;
    for (const s of slotsOf(c)) top = Math.max(top, s.space);
  }
  const even = top % 2 ? top + 1 : top;
  return Math.min(MAX_SPACES, Math.max(FIRST_PANEL_SPACES, even));
}

/** Would 0333's guard refuse moving this circuit onto this panel? Only a kept, live, placed one is
 *  checked: a slot past the panel's end or on a No Stab space. */
export function refusedOn(panel: Pick<JobPanel, "spaces" | "dead_spaces">, c: Loose): boolean {
  if (c.state !== "kept" || c.removed_at || c.space == null) return false;
  const dead = new Set(panel.dead_spaces ?? []);
  return slotsOf(c).some((s) => (panel.spaces != null && s.space > panel.spaces) || dead.has(s.space));
}

/** Move these loose circuits onto the panel, read back: the ids that moved. One write; if the
 *  database refuses the batch (a placement this file didn't foresee), each is tried alone and only
 *  the refused stay where they were. */
async function adopt(sb: SupabaseClient, orgId: string, jobId: string, panelId: string, ids: string[]): Promise<Set<string>> {
  const moved = new Set<string>();
  if (!ids.length) return moved;
  const batch = await sb
    .from("job_circuits")
    .update({ panel_id: panelId })
    .in("id", ids)
    .eq("job_id", jobId)
    .eq("org_id", orgId)
    .is("panel_id", null)
    .select("id");
  if (!batch.error) {
    for (const r of (batch.data ?? []) as { id: string }[]) moved.add(r.id);
    return moved;
  }
  for (const id of ids) {
    const one = await sb
      .from("job_circuits")
      .update({ panel_id: panelId })
      .eq("id", id)
      .eq("job_id", jobId)
      .eq("org_id", orgId)
      .is("panel_id", null)
      .select("id");
    if (!one.error) for (const r of (one.data ?? []) as { id: string }[]) moved.add(r.id);
  }
  return moved;
}

/**
 * The job's panel: its first live one, or Panel 1 made now. Then, when it is the job's only panel,
 * the job's loose circuits move onto it. Twice-safe: a second call finds the panel, finds nothing
 * loose, and writes nothing. Two calls racing to make Panel 1 meet the one-name-per-job index; the
 * one that loses reads the winner's panel back.
 */
export async function ensurePanelFor(sb: SupabaseClient, { orgId, jobId }: { orgId: string; jobId: string }): Promise<EnsuredPanel> {
  let panels = await livePanels(sb, orgId, jobId);
  const loose = await looseCircuits(sb, orgId, jobId);
  let created = false;
  if (!panels.length) {
    const { data, error } = await sb
      .from("job_panels")
      .insert({ org_id: orgId, job_id: jobId, name: FIRST_PANEL_NAME, spaces: spacesToHold(loose), numbering: "top_down" })
      .select(PANEL_COLUMNS)
      .maybeSingle();
    if (error && error.code !== "23505") throw new PanelWriteError("Panel 1 couldn't be added to the job.", error);
    if (data) {
      panels = [data as unknown as JobPanel];
      created = true;
    } else {
      // Someone else's call made it a moment ago (the unique name held), or the insert came back
      // empty: read what is there now, and say so if there is still nothing.
      panels = await livePanels(sb, orgId, jobId);
      if (!panels.length) throw new PanelWriteError("Panel 1 couldn't be added to the job.", error ?? new Error("the insert returned no row"));
    }
  }
  const panel = panels[0];
  // `left` counts the live ones: a circuit taken off moves with the rest (Undo puts it back on the
  // panel) but is nobody's to place.
  const live = loose.filter((c) => !c.removed_at);
  if (panels.length > 1 || !loose.length) {
    return { panelId: panel.id, created, adopted: 0, adoptedIds: [], livePanels: panels.length, left: live.length, panel };
  }
  const moved = await adopt(sb, orgId, jobId, panel.id, loose.filter((c) => !refusedOn(panel, c)).map((c) => c.id));
  return {
    panelId: panel.id,
    created,
    adopted: moved.size,
    adoptedIds: [...moved],
    livePanels: panels.length,
    left: live.filter((c) => !moved.has(c.id)).length,
    panel,
  };
}
