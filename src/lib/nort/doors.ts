/**
 * THE DOORS ON THE SCREEN — the boxes Nort may TYPE INTO for the person (field feedback 10-13,
 * rung 2; Erik 2026-10-14: "if Nort is flipping screens for me he should be able to enter text
 * into the box directly for me and record measurements where they are supposed to be recorded,
 * you know Jarvis style").
 *
 * A door is a box on the page the person is looking at, named the way a spot is named (the same
 * alphabet as `data-tour` and element ids, so one name finds the box to ring AND the handler to
 * call). Filling it goes THROUGH THE PAGE'S OWN STATE — the same setter a keystroke runs — so the
 * page's autosave writes it exactly as a typed value, the person watches it land, and nothing is
 * written behind the screen's back (fill-vs-execute: Nort fills up to the save button; the sheet's
 * autosave is the save; nothing here is money).
 *
 * PROVIDERS, NOT ENTRIES. A page registers ONE function that returns its doors as they stand right
 * now (fresh closures every call), so a task added a second ago has its doors the moment Nort asks,
 * and nothing is re-registered on every render. Unmount unregisters. The chat reads the list each
 * turn and tells the model what is on the screen; the driver reads one door by name to perform a
 * step. A door that is not there is SAID, never silently skipped.
 */

/** What a fill or an add did, in words the status line and the next turn's context can carry. */
export type DoorResult = { ok: true; landed: string } | { ok: false; why: string };

export type NortDoor = {
  /** What the box is, for the model: "Note on the task 'Panel swap'". */
  label: string;
  /** Put words (or a number, parsed) into the box. Absent = not a box Nort can type into. */
  fill?: (value: string) => DoorResult;
  /** Add a row (a measurement) from named fields. Absent = not an add-row door. */
  add?: (fields: Record<string, string>) => DoorResult;
  /** The fields `add` takes, in order, for the prompt (e.g. ["label", "value", "unit"]). */
  fields?: string[];
  /** What the box holds right now, so the model knows what a fill lands beside or replaces. */
  now?: string;
  /** A pick box's choices, whole (never cut by the label's cap). */
  options?: string[];
};

export type DoorProvider = () => Record<string, NortDoor>;

/** One line per door, as the model sees it. */
export type DoorListing = { name: string; label: string; can: ("fill" | "add")[]; fields?: string[]; now?: string; options?: string[] };
/** How much of a box's current value the model is shown. */
export const NOW_MAX = 60;
export const OPTIONS_MAX = 12;
export const OPTION_MAX = 40;

/** The most doors one turn tells the model about (a sheet with 15 tasks × 5 doors is already 75). */
export const MAX_DOORS = 80;
/** A door's name: the spot alphabet (lib/assistant-protocol SCREEN_ANCHOR_RE, kept apart so this file stays dependency-free). */
export const DOOR_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,79}$/i;

const providers = new Set<DoorProvider>();

/** Register a page's doors. Returns the unregister, for the effect's cleanup. */
export function registerNortDoors(provider: DoorProvider): () => void {
  providers.add(provider);
  return () => {
    providers.delete(provider);
  };
}

/** The doors on the screen right now, by name (a later provider's name wins over an earlier one's). */
export function currentDoors(): Record<string, NortDoor> {
  const out: Record<string, NortDoor> = {};
  for (const p of providers) {
    let doors: Record<string, NortDoor>;
    try {
      doors = p();
    } catch {
      continue; // a page mid-unmount is not a broken turn
    }
    for (const [name, door] of Object.entries(doors)) if (DOOR_NAME_RE.test(name) && door) out[name] = door;
  }
  return out;
}

/** One door by name, or null when no page on the screen has it. */
export function nortDoor(name: string): NortDoor | null {
  if (!DOOR_NAME_RE.test(name)) return null;
  const doors = currentDoors();
  return Object.hasOwn(doors, name) ? doors[name] : null;
}

/** The list the chat sends with a turn: name, what it is, what it takes — capped, never a handler. */
export function listNortDoors(): DoorListing[] {
  const out: DoorListing[] = [];
  for (const [name, d] of Object.entries(currentDoors())) {
    const can: ("fill" | "add")[] = [];
    if (d.fill) can.push("fill");
    if (d.add) can.push("add");
    if (!can.length) continue;
    const row: DoorListing = { name, label: String(d.label ?? "").replace(/\s+/g, " ").trim().slice(0, 80), can };
    if (d.add && d.fields?.length) row.fields = d.fields.slice(0, 8);
    const now = typeof d.now === "string" ? d.now.replace(/\s+/g, " ").trim().slice(0, NOW_MAX) : "";
    if (now) row.now = now;
    if (d.options?.length) row.options = d.options.filter((o) => typeof o === "string" && o.trim()).slice(0, OPTIONS_MAX).map((o) => o.replace(/\s+/g, " ").trim().slice(0, OPTION_MAX));
    out.push(row);
    if (out.length >= MAX_DOORS) break;
  }
  return out;
}

/** Tests only: forget every provider. */
export function _resetNortDoors(): void {
  providers.clear();
}
