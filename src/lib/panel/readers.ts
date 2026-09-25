/**
 * WHAT A READER SAW, AS SUGGESTIONS (Panel plan, phase 4). Pure: no database, no model.
 *
 * Three things read circuits for a job and none of them decides anything: Read The Panel Photo
 * (the crew and the office), Read Circuits From The Plans (the office), and Nort ("add a 20 amp for
 * the garage freezer"). Each hands this file the rows it saw, and this file answers, row by row,
 * one of three ways against the job's list:
 *
 *   SAME     the circuit is already on the list, the same words and the same size: nothing is
 *            written, and the count of them is said ("2 Already On Your List").
 *   DIFFERS  the reader matched ONE circuit on the list and something about it differs: the door
 *            words ("Panel Says Mini Fridge, Your List Says Fridge"), the space, or the amps. That
 *            becomes a LABEL CHECK: a suggestion that names the circuit it is about (flag_for),
 *            carries exactly what it would change (use) and what it saw there (was). It is never
 *            kept as a circuit of its own, and it never overwrites the kept row by itself: a person
 *            taps Use What It Says, and even then only if the circuit still says `was`.
 *   NEW      nothing on the list is this circuit: a suggestion, dimmed, named by where it came
 *            from, that counts for nothing until a person keeps it.
 *
 * A reread never doubles anything: every row carries a key made of what was read (not of which
 * read it was), so the same circuit read twice, or off a second photo of the same panel, is "already
 * here", and one a person set aside with Not This stays set aside.
 *
 * The app suggests, a person decides. Every sentence here is shown as-is, in plain words.
 */
import type { CircuitKind, CircuitReadPatch, CircuitSourceRow, CircuitWork, JobCircuit, JobPanel, SpaceHalf } from "@/lib/types";
import { AMP_SIZES, KINDS } from "./input";
import { circuitName, labelKey, roomFromWords, sizeWords, slotsOf, titleWords } from "./model";

export type ReaderSource = "photo" | "plan" | "nort";

/** Erik's cap on Read The Panel Photo: three reads per job per day (a few cents each). Here, not in
 *  the reader, so the tab can say it before the tap without pulling the model code into a page. */
export const PHOTO_READS_PER_JOB_PER_DAY = 3;

/** One circuit as a reader saw it, cleaned. `said` is the words it read (the door's for a photo,
 *  the schedule's for the plans, the person's for Nort). */
export type ReadRow = {
  space: number | null;
  half: SpaceHalf | null;
  said: string | null;
  room: string | null;
  amps: number | null;
  poles: number;
  kind: CircuitKind | null;
  wire: string | null;
  work: CircuitWork;
  /** A flag the reader itself raised (a breaker whose code and words disagree). */
  check: string | null;
  /** The door label and what it feeds, when the reader was told them apart from `said` (Nort: "the
   *  door says Mini Fridge"). Absent, `said` is the door's words for a photo and what it feeds
   *  for the plans and Nort. */
  door?: string | null;
  feeds?: string | null;
  /** Anything else worth keeping with the row (the plan's sheet and circuit number). */
  extra?: Partial<CircuitSourceRow>;
};

/** What a reader writes: always a suggestion. panel_id and the document are the caller's. */
export type ReaderDraft = {
  room: string | null;
  description: string | null;
  panel_label: string | null;
  amps: number | null;
  poles: number;
  kind: CircuitKind | null;
  wire: string | null;
  space: number | null;
  half: SpaceHalf | null;
  work: CircuitWork;
  state: "suggested";
  source: ReaderSource;
  source_row: CircuitSourceRow;
  sort_order: number;
};

/** How a reader's words are introduced in a label check. */
export type Says = { says: string; shows: string };
export const PANEL_SAYS: Says = { says: "Panel Says", shows: "Panel Shows" };
export const PLANS_SAY: Says = { says: "Plans Say", shows: "Plans Show" };
export const NORT_SAYS: Says = { says: "Nort Heard", shows: "Nort Heard" };

// ── cleaning what a model or a person handed us ───────────────────────────────────────────────────

export function cleanText(v: unknown, max: number): string | null {
  if (v == null) return null;
  if (typeof v !== "string" && typeof v !== "number") return null;
  const s = String(v).replace(/\s+/g, " ").trim();
  if (!s || /^(null|none|n\/a|unknown|\?+|-+)$/i.test(s)) return null;
  return s.slice(0, max);
}

export function cleanAmps(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v.replace(/\s*a(mps?)?$/i, "")) : Number(v);
  return Number.isFinite(n) && (AMP_SIZES as readonly number[]).includes(n) ? n : null;
}

export function cleanPoles(v: unknown): number | null {
  const n = Number(v);
  return n === 1 || n === 2 || n === 3 ? n : null;
}

const KIND_ALIASES: Record<string, CircuitKind> = {
  standard: "standard",
  plain: "standard",
  afci: "afci",
  arc: "afci",
  "arc fault": "afci",
  gfci: "gfci",
  gfi: "gfci",
  "ground fault": "gfci",
  dual_function: "dual_function",
  "dual function": "dual_function",
  df: "dual_function",
  "afci/gfci": "dual_function",
  spd: "spd",
  "surge": "spd",
};
export function cleanKind(v: unknown): CircuitKind | null {
  const s = String(v ?? "").toLowerCase().replace(/[-_]+/g, " ").trim();
  if (!s) return null;
  if (KINDS.includes(s.replace(/ /g, "_") as CircuitKind)) return s.replace(/ /g, "_") as CircuitKind;
  return KIND_ALIASES[s] ?? null;
}

export function cleanSpace(v: unknown, max = 84): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= max ? n : null;
}

export function cleanHalf(v: unknown): SpaceHalf | null {
  const s = String(v ?? "").trim().toUpperCase();
  return s === "A" || s === "B" ? s : null;
}

export function cleanSpaceList(v: unknown, max = 84): number[] {
  const parts = Array.isArray(v) ? v : String(v ?? "").split(/[\s,;]+/);
  const out = new Set<number>();
  for (const p of parts) {
    const n = cleanSpace(p, max);
    if (n != null) out.add(n);
  }
  return [...out].sort((a, b) => a - b);
}

// ── matching one read row against the list ────────────────────────────────────────────────────────

type Existing = Pick<
  JobCircuit,
  "id" | "panel_id" | "space" | "half" | "poles" | "amps" | "kind" | "state" | "removed_at" | "room" | "description" | "panel_label" | "source" | "source_row"
>;

export type Match =
  | { kind: "same"; circuit: Existing }
  | { kind: "differs"; circuit: Existing; words: string[]; use: CircuitReadPatch; was: CircuitReadPatch }
  | { kind: "none" };

/** Words that say what kind of circuit it is but not WHICH one: "Outlets" alone matches nothing. */
const GENERIC = new Set(["outlets", "outlet", "lights", "light", "lighting", "receptacles", "receptacle", "recepts", "plugs", "circuit", "spare", "space", "new", "existing", "gfci", "gfi", "afci", "a", "b", "ckt"]);
const wordsOf = (s: string) => s.split(" ").filter(Boolean);

/** The words on the list a read row is compared with: the door label, else what it feeds. */
function listWords(c: Existing): string {
  return c.panel_label?.trim() || c.description?.trim() || "";
}

function sizeFits(r: Pick<ReadRow, "amps" | "poles">, c: Existing): boolean {
  return r.poles === c.poles && (r.amps == null || c.amps == null || r.amps === c.amps);
}

/**
 * Is this read row a circuit already on the list, one that differs, or a new one?
 *
 * By SPACE first (a photo reads spaces): the kept circuit covering that space and half. Then by
 * WORDS: the same words as a circuit's door label or what it feeds is that circuit; words that are
 * all inside ONE circuit's words (or hold all of them: "Mini Fridge" and "Fridge") are probably that
 * circuit and are checked, not guessed. Two or more candidates, or only generic words ("Outlets"),
 * match nothing: a new suggestion, and a person decides.
 */
export function matchRead(row: ReadRow, circuits: Existing[], panelId: string | null, says: Says): Match {
  const kept = circuits.filter(
    (c) => c.state === "kept" && !c.removed_at && (panelId == null || c.panel_id == null || c.panel_id === panelId),
  );
  const said = labelKey(row.said);

  // 1. The space.
  if (row.space != null) {
    const here = kept.filter((c) =>
      slotsOf(c).some((s) => s.space === row.space && (s.half == null || row.half == null || s.half === row.half)),
    );
    const c = here.find((x) => x.space === row.space) ?? (here.length === 1 ? here[0] : undefined);
    if (c) return compare(row, c, says, false);
  }

  // 2. The words.
  if (!said) return { kind: "none" };
  const exact = kept.filter((c) => labelKey(c.panel_label) === said || labelKey(c.description) === said);
  // With spaces on both sides and different spaces, the same words are two circuits (two "Garage").
  const placedElsewhere = (c: Existing) => row.space != null && c.space != null && c.space !== row.space;
  const exactHere = exact.filter((c) => !placedElsewhere(c));
  if (exactHere.length === 1) return compare(row, exactHere[0], says, true);
  if (exactHere.length > 1) {
    const fits = exactHere.filter((c) => sizeFits(row, c));
    return fits.length ? { kind: "same", circuit: fits[0] } : { kind: "none" };
  }
  if (exact.length) return { kind: "none" };

  const mine = wordsOf(said);
  if (!mine.some((w) => !GENERIC.has(w))) return { kind: "none" };
  const partial = kept.filter((c) => {
    if (placedElsewhere(c)) return false;
    const theirs = wordsOf(labelKey(listWords(c)));
    if (!theirs.length || !theirs.some((w) => !GENERIC.has(w))) return false;
    const inside = (a: string[], b: string[]) => a.every((w) => b.includes(w));
    return inside(mine, theirs) || inside(theirs, mine);
  });
  if (partial.length === 1 && sizeFits(row, partial[0])) return compare(row, partial[0], says, true);
  return { kind: "none" };
}

function compare(row: ReadRow, c: Existing, says: Says, byWords: boolean): Match {
  const words: string[] = [];
  const use: CircuitReadPatch = {};
  const was: CircuitReadPatch = {};
  const said = labelKey(row.said);
  const theirs = listWords(c);
  if (said && labelKey(c.panel_label) !== said && labelKey(c.description) !== said) {
    words.push(`${says.says} ${titleWords(row.said)}, Your List Says ${titleWords(theirs) || circuitName(c)}.`);
    use.panel_label = titleWords(row.said);
    was.panel_label = c.panel_label ?? null;
  }
  if (row.poles !== c.poles) {
    // The same words on a different size are a different circuit, or nobody can tell: a new
    // suggestion. A different pole count on the SAME space is said, and never applied.
    if (byWords) return { kind: "none" };
    words.push(`${says.shows} A ${row.poles}-Pole On Space ${row.space}, Your List Has ${circuitName(c)} As A ${c.poles}-Pole.`);
  } else if (row.amps != null && c.amps != null && row.amps !== c.amps) {
    words.push(`${says.shows} ${sizeWords(row.poles, row.amps)}${row.space != null ? ` On Space ${row.space}` : ""}, Your List Says ${sizeWords(c.poles, c.amps)}.`);
    use.amps = row.amps;
    was.amps = c.amps;
  }
  if (byWords && row.space != null && c.space == null) {
    words.push(`${says.shows} ${titleWords(row.said) || circuitName(c)} On Space ${row.space}${row.half ?? ""}. Your List Has No Space For It.`);
    use.space = row.space;
    use.half = row.half;
    was.space = null;
    was.half = c.half ?? null;
  }
  if (!words.length) return { kind: "same", circuit: c };
  return { kind: "differs", circuit: c, words, use, was };
}

// ── the suggestions ───────────────────────────────────────────────────────────────────────────────

/** A read row's identity: what was read, not which read it was, so a reread is "already here". */
export function readKey(source: ReaderSource, r: Pick<ReadRow, "space" | "half" | "said" | "amps" | "poles" | "extra">): string {
  const ckt = source === "plan" ? `${labelKey(r.extra?.sheet)}/${labelKey(r.extra?.ckt)}` : "";
  return `${source}:${ckt}:${r.space ?? "-"}${r.half ?? ""}:${labelKey(r.said)}:${r.poles}P${r.amps ?? "?"}`.slice(0, 380);
}
export function flagKey(source: ReaderSource, circuitId: string, use: CircuitReadPatch): string {
  return `${source}-flag:${circuitId}:${labelKey(use.panel_label)}:${use.space ?? "-"}${use.half ?? ""}:${use.amps ?? "-"}`;
}

export type ReaderOutcome = {
  drafts: ReaderDraft[];
  /** Read rows that are already on the list, the same. */
  same: number;
  /** Label checks written. */
  flagged: number;
  /** Rows (or checks) a read already brought, still here; and ones a person set aside with Not This. */
  already: number;
  setAside: number;
};

/**
 * The drafts a read writes, and what it counts. `circuits` is EVERY circuit on the job, set-aside
 * ones included (their keys keep a Not This from coming back). New rows from the photo are
 * 'existing' work (they are in the panel already); from the plans and Nort, what the row said.
 */
export function readerSuggestions(input: {
  source: ReaderSource;
  rows: ReadRow[];
  circuits: Existing[];
  panelId: string | null;
  says: Says;
  startSort: number;
  stamp?: Partial<CircuitSourceRow>;
}): ReaderOutcome {
  const byKey = new Map<string, boolean>();
  for (const c of input.circuits) {
    const k = c.source_row?.key;
    if (k && c.source === input.source) byKey.set(k, !!c.removed_at);
  }
  const out: ReaderOutcome = { drafts: [], same: 0, flagged: 0, already: 0, setAside: 0 };
  const times = new Map<string, number>();
  const flaggedNow = new Set<string>();
  let sort = input.startSort;
  for (const r of input.rows) {
    const m = matchRead(r, input.circuits, input.panelId, input.says);
    if (m.kind === "same") {
      out.same++;
      continue;
    }
    let key: string;
    let draft: Omit<ReaderDraft, "sort_order" | "source_row"> & { source_row: Omit<CircuitSourceRow, "key"> };
    if (m.kind === "differs") {
      key = flagKey(input.source, m.circuit.id, m.use);
      if (flaggedNow.has(key)) continue;
      flaggedNow.add(key);
      // The check is a suggestion row shaped like the circuit it is about, so the list can show it;
      // it has no space of its own (it occupies nothing, and it can never be kept as a circuit).
      draft = {
        room: m.circuit.room,
        description: m.circuit.description,
        panel_label: m.use.panel_label ?? m.circuit.panel_label,
        amps: m.use.amps ?? m.circuit.amps,
        poles: m.circuit.poles,
        kind: m.circuit.kind,
        wire: null,
        space: null,
        half: null,
        work: "existing",
        state: "suggested",
        source: input.source,
        source_row: {
          ...input.stamp,
          ...r.extra,
          said: r.said,
          check: m.words.join(" "),
          flag_for: m.circuit.id,
          use: m.use,
          was: m.was,
        },
      };
    } else {
      const base = readKey(input.source, r);
      const n = (times.get(base) ?? 0) + 1;
      times.set(base, n);
      key = n === 1 ? base : `${base}#${n}`;
      const words = titleWords(r.said) || null;
      // The door's words are the door label; the plans' and Nort's are what it feeds.
      const onDoor = input.source === "photo";
      draft = {
        room: titleWords(r.room) || roomFromWords(r.said),
        description: onDoor ? null : r.feeds !== undefined ? titleWords(r.feeds) || null : words,
        panel_label: onDoor ? words : titleWords(r.door) || null,
        amps: r.amps,
        poles: r.poles,
        kind: r.kind,
        wire: r.wire,
        space: r.space,
        half: r.space != null ? r.half : null,
        work: r.work,
        state: "suggested",
        source: input.source,
        source_row: { ...input.stamp, ...r.extra, said: r.said, check: r.check },
      };
    }
    if (byKey.has(key)) {
      if (byKey.get(key)) out.setAside++;
      else out.already++;
      continue;
    }
    byKey.set(key, false);
    if (m.kind === "differs") out.flagged++;
    out.drafts.push({ ...draft, source_row: { ...draft.source_row, key }, sort_order: sort++ });
  }
  return out;
}

/** "Read 9. 6 New Suggestions, 1 Label Check, 2 Already On Your List." */
export function readerSummary(what: string, read: number, o: ReaderOutcome): string {
  if (read === 0) return `Nothing on ${what} could be read as a circuit.`;
  const newOnes = o.drafts.length - o.flagged;
  const bits = [
    newOnes ? `${newOnes} New Suggestion${newOnes === 1 ? "" : "s"}` : null,
    o.flagged ? `${o.flagged} Label Check${o.flagged === 1 ? "" : "s"}` : null,
    o.same ? `${o.same} Already On Your List` : null,
    o.already ? `${o.already} Already Suggested` : null,
    o.setAside ? `${o.setAside} You Set Aside Before` : null,
  ].filter(Boolean);
  const tail = o.drafts.length ? " Nothing counts until you keep it." : " Nothing new to add.";
  return `Read ${read} circuit${read === 1 ? "" : "s"} off ${what}: ${bits.join(", ")}.${tail}`;
}

// ── the panel's own header ────────────────────────────────────────────────────────────────────────

export type HeaderField = "brand" | "main_amps" | "spaces" | "dead_spaces";
export type HeaderSaid = { brand?: string | null; main_amps?: number | null; spaces?: number | null; dead_spaces?: number[] | null };
export type HeaderSuggestion = {
  field: HeaderField;
  /** What Use would write: for No Stab, the panel's spaces plus the new ones. */
  value: string | number | number[];
  words: string;
  from: string;
};

/**
 * What a reader said about the panel itself that the panel doesn't say yet (or says differently):
 * one line per field, each with its own Use. Nothing is written by being read. `panel` null means
 * the job has no panel yet: every field said is offered.
 */
export function headerSuggestions(panel: Pick<JobPanel, "brand" | "main_amps" | "spaces" | "dead_spaces"> | null, said: HeaderSaid, from: string): HeaderSuggestion[] {
  const out: HeaderSuggestion[] = [];
  const brand = cleanText(said.brand, 60);
  if (brand && brand.toLowerCase() !== (panel?.brand ?? "").trim().toLowerCase()) {
    out.push({ field: "brand", value: brand, words: `Brand: ${brand}${panel?.brand ? ` (Yours Says ${panel.brand})` : ""}`, from });
  }
  const main = said.main_amps != null && Number.isInteger(Number(said.main_amps)) && Number(said.main_amps) >= 30 && Number(said.main_amps) <= 1200 ? Number(said.main_amps) : null;
  if (main != null && main !== panel?.main_amps) {
    out.push({ field: "main_amps", value: main, words: `Main: ${main}A${panel?.main_amps ? ` (Yours Says ${panel.main_amps}A)` : ""}`, from });
  }
  const spaces = cleanSpace(said.spaces);
  if (spaces != null && spaces !== panel?.spaces) {
    out.push({ field: "spaces", value: spaces, words: `Spaces: ${spaces}${panel?.spaces ? ` (Yours Says ${panel.spaces})` : ""}`, from });
  }
  const dead = cleanSpaceList(said.dead_spaces ?? []);
  const have = new Set(panel?.dead_spaces ?? []);
  const fresh = dead.filter((s) => !have.has(s) && (spaces == null || s <= spaces));
  if (fresh.length) {
    out.push({
      field: "dead_spaces",
      value: [...new Set([...(panel?.dead_spaces ?? []), ...fresh])].sort((a, b) => a - b),
      words: `No Stab: Space${fresh.length === 1 ? "" : "s"} ${fresh.join(", ")}`,
      from,
    });
  }
  return out;
}

const BRANDS: [RegExp, string][] = [
  [/\bsiemens\b/i, "Siemens"],
  [/\bsquare\s*d\b|\bhomeline\b/i, "Square D"],
  [/\beaton\b|\bcutler[\s-]*hammer\b/i, "Eaton"],
  [/\bge\b|\bgeneral electric\b/i, "GE"],
  [/\bmurray\b/i, "Murray"],
  [/\bzinsco\b/i, "Zinsco"],
  [/\bfederal pacific\b|\bfpe\b/i, "Federal Pacific"],
  [/\bchallenger\b/i, "Challenger"],
  [/\bwestinghouse\b/i, "Westinghouse"],
  [/\bleviton\b/i, "Leviton"],
];

/**
 * THE WALK-THROUGH'S ANSWERS (the inspector's panel_brand, panel_amps and the one-box
 * panel_condition, "Siemens, 200A, two slots open") as header suggestions. The one box is read for a
 * brand it names and an amps figure only; the words themselves are shown whole, never parsed further.
 */
export function walkthroughSaid(answers: Record<string, unknown>[]): { said: HeaderSaid; words: string | null } {
  const said: HeaderSaid = {};
  let words: string | null = null;
  for (const a of answers) {
    const cond = cleanText(a?.panel_condition, 300);
    const brand = cleanText(a?.panel_brand, 60);
    const amps = Number(a?.panel_amps);
    if (said.brand == null && brand) said.brand = brand;
    if (said.main_amps == null && Number.isInteger(amps) && amps >= 30 && amps <= 1200) said.main_amps = amps;
    if (cond && words == null) {
      words = cond;
      if (said.brand == null) said.brand = BRANDS.find(([re]) => re.test(cond))?.[1] ?? null;
      const m = /\b(\d{2,4})\s*(?:a|amps?)\b/i.exec(cond);
      if (said.main_amps == null && m && Number(m[1]) >= 30 && Number(m[1]) <= 1200) said.main_amps = Number(m[1]);
    }
  }
  return { said, words };
}
