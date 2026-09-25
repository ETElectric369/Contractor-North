/**
 * THE PANEL DIRECTORY, AS DATA (Panel plan, phase 5). Pure: no database, no React.
 *
 * One shape feeds every place the directory is read: the printed door card and circuit map
 * (/print/panel/<job>), the customer's live "Your Panel" (portal_job_view's `panels` block, 0335)
 * and the office's preview of it on the Customer Page tab. The shape carries ONLY what is fine for
 * a customer to read: where a circuit sits, what the door says, what it feeds, its size and type,
 * its room, and whether it is new work. Never a wire tag, a note, progress, where a line came from,
 * who changed or verified it, a part number, a supplier or a price. A suggestion nobody kept, a
 * circuit taken off, and one coming out are not on it.
 *
 * Two roads in, one rule: directoryFromRows builds it from the job's own rows (the print page and
 * the office's preview), and normalizePortalPanels builds it from the database's projection (the
 * portal). Both end in the same field-by-field objects, so a column added to job_circuits later
 * cannot reach a customer by default.
 */
import type { CircuitKind, JobCircuit, JobPanel, PanelNumbering, SpaceHalf } from "@/lib/types";
import { KIND_WORDS, countWord, doorRows, labelDiffers, slotsOf, titleWords } from "./model";

export type DirectoryCircuit = {
  space: number | null;
  half: SpaceHalf | null;
  poles: number;
  amps: number | null;
  kind: CircuitKind | null;
  room: string | null;
  /** What the door says ("Entry Lights"), else what it feeds. */
  label: string;
  /** What it feeds, only when that differs from the door label ("Kitchen And Living"). */
  feeds: string | null;
  isNew: boolean;
};

export type DirectoryPanel = {
  name: string;
  mainAmps: number | null;
  spaces: number | null;
  /** The door card's (print only; the portal gets the defaults). */
  brand: string | null;
  numbering: PanelNumbering;
  deadSpaces: number[];
  circuits: DirectoryCircuit[];
};

/** Every circuit map Save As Circuit Map files ends with this (the job's folder, "<time>-Circuit_Map.pdf"),
 *  so Read Circuits From The Plans can leave the app's own printout out of its list. */
export const CIRCUIT_MAP_FILE_SUFFIX = "-Circuit_Map.pdf";

const KINDS: readonly CircuitKind[] = ["standard", "afci", "gfci", "dual_function", "spd"];
const AMPS = new Set([10, 15, 20, 25, 30, 35, 40, 45, 50, 60, 70, 80, 90, 100, 110, 125, 150, 175, 200, 225]);

/** Is this circuit on the directory? Kept, live, and not coming out. */
export function onDirectory(c: Pick<JobCircuit, "state" | "removed_at" | "work">): boolean {
  return c.state === "kept" && !c.removed_at && c.work !== "removed";
}

/** Space order, the unplaced last; A before B; then the list's own order. */
function bySpace(a: { space: number | null; half: SpaceHalf | null; order: number }, b: { space: number | null; half: SpaceHalf | null; order: number }): number {
  if (a.space == null && b.space != null) return 1;
  if (b.space == null && a.space != null) return -1;
  if (a.space != null && b.space != null && a.space !== b.space) return a.space - b.space;
  const ha = a.half ?? "";
  const hb = b.half ?? "";
  if (ha !== hb) return ha < hb ? -1 : 1;
  return a.order - b.order;
}

function circuitOf(c: Pick<JobCircuit, "space" | "half" | "poles" | "amps" | "kind" | "room" | "panel_label" | "description" | "work">): DirectoryCircuit {
  const door = titleWords(c.panel_label);
  const feeds = titleWords(c.description);
  const label = door || feeds || `${c.poles}P ${c.amps == null ? "" : `${c.amps}A `}Circuit`.replace(/\s+/g, " ");
  return {
    space: c.space ?? null,
    half: c.half ?? null,
    poles: c.poles,
    amps: c.amps ?? null,
    kind: c.kind ?? null,
    room: titleWords(c.room) || null,
    label,
    feeds: door && feeds && labelDiffers({ panel_label: door, description: feeds }) ? feeds : null,
    isNew: c.work === "new",
  };
}

/** A panel's directory from the job's own rows (the print page, the office's preview). */
export function directoryFromRows(
  panel: Pick<JobPanel, "id" | "name" | "main_amps" | "spaces" | "brand" | "numbering" | "dead_spaces">,
  circuits: JobCircuit[],
): DirectoryPanel {
  const rows = circuits
    .filter((c) => c.panel_id === panel.id && onDirectory(c))
    .map((c) => ({ c, order: c.sort_order ?? 0 }))
    .sort((a, b) => bySpace({ space: a.c.space, half: a.c.half, order: a.order }, { space: b.c.space, half: b.c.half, order: b.order }));
  return {
    name: titleWords(panel.name) || "Main Panel",
    mainAmps: panel.main_amps ?? null,
    spaces: panel.spaces ?? null,
    brand: panel.brand?.trim() || null,
    numbering: panel.numbering === "bottom_up" ? "bottom_up" : "top_down",
    deadSpaces: [...(panel.dead_spaces ?? [])],
    circuits: rows.map((r) => circuitOf(r.c)),
  };
}

/**
 * A directory as the customer's page gets it: 0335 sends no brand, numbering or No Stab spaces, so
 * normalizePortalPanels fills the defaults. The office's preview ("What Andrew Sees") goes through
 * this, so it shows exactly that, not the print page's fuller heading.
 */
export function asPortalDirectory(d: DirectoryPanel): DirectoryPanel {
  return { ...d, brand: null, numbering: "top_down", deadSpaces: [] };
}

/** The circuits on no panel yet, for the printed map (a list can be made before anyone looks in the box). */
export function unpanelledFromRows(circuits: JobCircuit[], panelIds: string[]): DirectoryCircuit[] {
  const ids = new Set(panelIds);
  return circuits
    .filter((c) => onDirectory(c) && (!c.panel_id || !ids.has(c.panel_id)))
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
    .map((c) => ({ ...circuitOf(c), space: null, half: null }));
}

// ── the portal's road in ────────────────────────────────────────────────────────────────────────

const int = (v: unknown, lo: number, hi: number): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isInteger(n) && n >= lo && n <= hi ? n : null;
};
const text = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

/**
 * What portal_job_view's `panels` block (0335) may put on the customer's page, field by field.
 * Anything else the block ever carries is dropped here; anything malformed is dropped, never
 * guessed at. The words go through the same rules as the office's rows (titleWords, labelDiffers).
 */
export function normalizePortalPanels(raw: unknown): DirectoryPanel[] {
  if (!Array.isArray(raw)) return [];
  const out: DirectoryPanel[] = [];
  for (const p of raw) {
    if (!p || typeof p !== "object") continue;
    const r = p as Record<string, unknown>;
    const circuits: DirectoryCircuit[] = [];
    const list = Array.isArray(r.circuits) ? r.circuits : [];
    for (const x of list) {
      if (!x || typeof x !== "object") continue;
      const c = x as Record<string, unknown>;
      const space = int(c.space, 1, 84);
      const amps = int(c.amps, 1, 400);
      // The database's `label` is what the door says (else what it feeds); `feeds` rides only when
      // it differs. Read back through the office's own rule, so both roads say the same thing.
      circuits.push(
        circuitOf({
          space,
          half: space != null && (c.half === "A" || c.half === "B") ? (c.half as SpaceHalf) : null,
          poles: int(c.poles, 1, 3) ?? 1,
          amps: amps != null && AMPS.has(amps) ? amps : null,
          kind: KINDS.includes(c.kind as CircuitKind) ? (c.kind as CircuitKind) : null,
          room: text(c.room, 80),
          panel_label: text(c.label, 200),
          description: text(c.feeds, 200),
          work: c.is_new === true ? "new" : "existing",
        }),
      );
    }
    out.push({
      name: titleWords(text(r.name, 60)) || "Main Panel",
      mainAmps: int(r.main_amps, 30, 1200),
      spaces: int(r.spaces, 1, 84),
      brand: null,
      numbering: "top_down",
      deadSpaces: [],
      circuits,
    });
  }
  return out;
}

// ── words ───────────────────────────────────────────────────────────────────────────────────────

/** Where it sits, as the door reads: "7", "25B", "25/27" (a 2P), "—" when not placed yet. */
export function spaceWords(c: Pick<DirectoryCircuit, "space" | "half" | "poles">): string {
  if (c.space == null) return "—";
  const slots = slotsOf({ space: c.space, half: c.half, poles: c.poles });
  return slots.map((s) => `${s.space}${s.half ?? ""}`).join("/");
}

/** "15A", "2P 30A", with the type: "15A AFCI". */
export function sizeLine(c: Pick<DirectoryCircuit, "poles" | "amps" | "kind">): string {
  // No amps yet reads in words, the way the map's own group says it ("Size Not Set"), never "?A".
  const amps = c.amps == null ? "Size Not Set" : `${c.amps}A`;
  const base = c.poles > 1 ? `${c.poles}P${c.amps == null ? ", " : " "}${amps}` : amps;
  return c.kind && c.kind !== "standard" ? `${base} ${KIND_WORDS[c.kind]}` : base;
}

/** "7 · Entry Lights · feeds Kitchen And Living · 15A": one line, as the customer reads it. */
export function directoryLine(c: DirectoryCircuit): string {
  return [spaceWords(c), c.label, c.feeds ? `feeds ${c.feeds}` : null, sizeLine(c)].filter(Boolean).join(" · ");
}

/** "Main Panel · 200A Main · 40 Spaces". */
export function panelHeading(p: Pick<DirectoryPanel, "name" | "mainAmps" | "spaces" | "brand">): string {
  return [p.name, p.brand, p.mainAmps ? `${p.mainAmps}A Main` : null, p.spaces ? `${p.spaces} Spaces` : null].filter(Boolean).join(" · ");
}

// ── the door card ───────────────────────────────────────────────────────────────────────────────

export type DoorOccupant = { circuit: DirectoryCircuit; half: SpaceHalf | null; first: boolean; partner: number | null };
export type DoorCell = { space: number; noStab: boolean; occupants: DoorOccupant[] };

/**
 * The door as it hangs, row by row: odd spaces down the left, even down the right, top of the box
 * first (flipped when the numbers run bottom up). A 2P shows on both its spaces ("With 27"), a twin
 * splits its space A/B, a No Stab space says so. The same geometry as the tab's Positions view
 * (doorRows, slotsOf), so the card and the screen agree.
 */
export function doorCard(p: Pick<DirectoryPanel, "spaces" | "numbering" | "deadSpaces" | "circuits">): { left: DoorCell; right: DoorCell }[] {
  const cells = new Map<number, DoorOccupant[]>();
  for (const c of p.circuits) {
    if (c.space == null) continue;
    const slots = slotsOf({ space: c.space, half: c.half, poles: c.poles });
    slots.forEach((s, i) => {
      const list = cells.get(s.space) ?? [];
      list.push({ circuit: c, half: s.half, first: i === 0, partner: slots.length > 1 ? (i === 0 ? slots[1].space : c.space) : null });
      cells.set(s.space, list);
    });
  }
  for (const list of cells.values()) list.sort((a, b) => (a.half ?? "").localeCompare(b.half ?? ""));
  const dead = new Set(p.deadSpaces);
  const cell = (space: number): DoorCell => ({ space, noStab: dead.has(space), occupants: cells.get(space) ?? [] });
  return doorRows({ spaces: p.spaces, numbering: p.numbering }, [...cells.keys()]).map((r) => ({ left: cell(r.left), right: cell(r.right) }));
}

// ── the circuit map (the schedule page) ───────────────────────────────────────────────────────

export type ScheduleGroup = { key: string; title: string; sub: string; circuits: DirectoryCircuit[] };

/**
 * The circuit map's sections, the way tonight's hand-built map read (15 A single-pole, 20 A
 * single-pole, the 240-volt two-poles): grouped by size, never by a guess at what a size is for.
 * Single-pole by amps, then two-pole (240-volt), then three-pole, then anything not sized yet.
 * Inside a group, by room in the order rooms first appear, then the list's order.
 */
export function scheduleGroups(circuits: DirectoryCircuit[]): ScheduleGroup[] {
  const groups = new Map<string, ScheduleGroup>();
  const keyOf = (c: DirectoryCircuit) => (c.amps == null ? "z" : c.poles === 1 ? `1-${String(c.amps).padStart(3, "0")}` : `${c.poles}`);
  for (const c of circuits) {
    const k = keyOf(c);
    let g = groups.get(k);
    if (!g) {
      const title =
        c.amps == null ? "Size Not Set" : c.poles === 1 ? `${c.amps} A Circuits` : c.poles === 2 ? "240-Volt Circuits" : "Three-Pole Circuits";
      g = { key: k, title, sub: "", circuits: [] };
      groups.set(k, g);
    }
    g.circuits.push(c);
  }
  const out = [...groups.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  for (const g of out) {
    const n = g.circuits.length;
    const count = `${n} Circuit${n === 1 ? "" : "s"}`;
    g.sub = g.key.startsWith("1-") ? `Single-Pole · ${count}` : g.key === "2" ? `Two-Pole · ${count}` : g.key === "3" ? `Three-Pole · ${count}` : count;
    // Rooms together, in the order each room first appears.
    const rooms: string[] = [];
    for (const c of g.circuits) {
      const r = (c.room ?? "").toLowerCase();
      if (!rooms.includes(r)) rooms.push(r);
    }
    g.circuits = rooms.flatMap((r) => g.circuits.filter((c) => (c.room ?? "").toLowerCase() === r));
  }
  return out;
}

/** The chips across the top of the map: "22 Circuits", then one per group ("3 · 15 A"). */
export function scheduleChips(groups: ScheduleGroup[]): { n: number; words: string }[] {
  const total = groups.reduce((s, g) => s + g.circuits.length, 0);
  return [
    { n: total, words: total === 1 ? "Circuit" : "Circuits" },
    ...groups.map((g) => ({
      n: g.circuits.length,
      words: g.key.startsWith("1-") ? `${g.circuits[0].amps} A` : g.key === "2" ? "240-Volt" : g.key === "3" ? "Three-Pole" : "Size Not Set",
    })),
  ];
}

/** "Two circuits already in the panel stay in service (One 15 A And One 20 A)." — or null. */
export function existingNote(circuits: DirectoryCircuit[]): string | null {
  const old = circuits.filter((c) => !c.isNew);
  if (!old.length) return null;
  const sizes = new Map<string, number>();
  for (const c of old) {
    const k = c.amps == null ? "size not set" : c.poles > 1 ? `${c.amps} A ${c.poles}-pole` : `${c.amps} A`;
    sizes.set(k, (sizes.get(k) ?? 0) + 1);
  }
  const parts = [...sizes.entries()].map(([k, n]) => `${countWord(n).toLowerCase()} ${k}`);
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0];
  const n = old.length;
  return `${countWord(n)} circuit${n === 1 ? " was" : "s were"} already in the panel and ${n === 1 ? "stays" : "stay"} in service (${list}).`;
}
