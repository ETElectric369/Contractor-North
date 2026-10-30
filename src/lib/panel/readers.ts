/**
 * WHAT A READER SAW, AS SUGGESTIONS (Panel plan, phase 4; honed in the panel-first wave). Pure: no
 * database, no model.
 *
 * Three things read circuits for a job and none of them decides anything: Read A Photo (the crew
 * and the office), Read Circuits From The Plans (the office), and Nort ("add a 20 amp for the
 * garage freezer").
 *
 * THE PHOTO READS SPACES, SO IT LANDS IN THEM (landRead, below). Every line it read becomes a
 * suggestion in its own space and half, dimmed on the panel until a person keeps it; a line whose
 * space already holds a kept circuit with the same words is nothing to do; one whose words differ
 * waits in that same space beside the kept one ("Photo says …", Use It). No label checks, no
 * matching by words across the panel: the space is the answer.
 *
 * The plans and Nort mostly name what a circuit FEEDS, with no space, so they keep the three-way
 * match below. Each hands this file the rows it saw, and this file answers, row by row, one of
 * three ways against the job's list:
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
import { AMP_SIZES, KINDS, MAX_SPACES } from "./input";
import { circuitName, labelKey, roomFromWords, sizeWords, slotsOf, titleWords } from "./model";
import { belongsToPanel, slotsMeet } from "./held";

export type ReaderSource = "photo" | "plan" | "nort";

/** Erik's cap on Read A Photo for the crew: three reads per job per day (a few cents each); the
 *  office isn't held to it (the company's monthly AI budget still is). Here, not in the reader, so
 *  the card can say it without pulling the model code into a page. */
export const PHOTO_READS_PER_JOB_PER_DAY = 3;
/** The one sentence a tech reads when the day's photo reads are used up. */
export const PHOTO_CAP_WORDS = `${PHOTO_READS_PER_JOB_PER_DAY} photo reads a day on this job — ask the office for more.`;
/** The office's cap on Read Circuits From The Plans: five per job per day. */
export const PLAN_READS_PER_JOB_PER_DAY = 5;
/** The one sentence when the day's plan reads are used up. */
export const PLAN_CAP_WORDS = `${PLAN_READS_PER_JOB_PER_DAY} plan reads a day on this job — the next one opens tomorrow.`;

/** "2 Of 3 Reads Left Today." */
export function readsLeftWords(left: number, limit: number): string {
  return `${left} Of ${limit} Reads Left Today.`;
}

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

/** How a reader's words are introduced in a label check. The plans and Nort say what a circuit
 *  FEEDS (Nort can also be told the door's words apart, ReadRow.door); a check only ever proposes
 *  the field the words are. (The photo raises no checks: it lands in its spaces, landRead.) */
export type Says = { says: string; shows: string };
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

export function cleanSpace(v: unknown, max = MAX_SPACES): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= max ? n : null;
}

/** "23, 24" or [23, 24] → [23, 24]: the good space numbers, sorted, once each; the rest dropped. */
export function cleanSpaceList(v: unknown, max = MAX_SPACES): number[] {
  const parts = Array.isArray(v) ? v : String(v ?? "").split(/[\s,;]+/);
  const out = new Set<number>();
  for (const p of parts) {
    const n = cleanSpace(p, max);
    if (n != null) out.add(n);
  }
  return [...out].sort((a, b) => a - b);
}

export function cleanHalf(v: unknown): SpaceHalf | null {
  const s = String(v ?? "").trim().toUpperCase();
  return s === "A" || s === "B" ? s : null;
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

  const sameWords = (c: Existing) => !!said && (labelKey(c.panel_label) === said || labelKey(c.description) === said);
  const mine = wordsOf(said);
  const specific = mine.some((w) => !GENERIC.has(w));
  /** Words all inside one circuit's words, or holding all of them ("Mini Fridge" and "Fridge"). */
  const nearWords = (c: Existing) => {
    if (!specific) return false;
    const theirs = wordsOf(labelKey(listWords(c)));
    if (!theirs.length || !theirs.some((w) => !GENERIC.has(w))) return false;
    const inside = (a: string[], b: string[]) => a.every((w) => b.includes(w));
    return inside(mine, theirs) || inside(theirs, mine);
  };

  // 1. The space.
  if (row.space != null) {
    // The panel's one rule for "the same handle position" (lib/panel/held slotsMeet).
    const at = { space: row.space, half: row.half };
    const here = kept.filter((c) => slotsOf(c).some((s) => slotsMeet(s, at)));
    const top = here.filter((x) => x.space === row.space);
    const pool = top.length ? top : here;
    if (pool.length === 1) return compare(row, pool[0], says, false);
    if (pool.length > 1) {
      // Several circuits on the space (a tandem's two halves, read with no half): only the words can
      // say which one this is, and never the first one found. The same words are that circuit; one
      // circuit whose words are near is checked; anything else is a new suggestion a person decides.
      const exactHere = pool.filter(sameWords);
      if (exactHere.length === 1) return compare(row, exactHere[0], says, false);
      if (exactHere.length > 1) return { kind: "same", circuit: exactHere[0] };
      const near = pool.filter(nearWords);
      if (near.length === 1) return compare(row, near[0], says, false);
      return { kind: "none" };
    }
  }

  // 2. The words.
  if (!said) return { kind: "none" };
  const exact = kept.filter(sameWords);
  // With spaces on both sides and different spaces, the same words are two circuits (two "Garage").
  const placedElsewhere = (c: Existing) => row.space != null && c.space != null && c.space !== row.space;
  const exactHere = exact.filter((c) => !placedElsewhere(c));
  if (exactHere.length === 1) return compare(row, exactHere[0], says, true);
  if (exactHere.length > 1) {
    const fits = exactHere.filter((c) => sizeFits(row, c));
    return fits.length ? { kind: "same", circuit: fits[0] } : { kind: "none" };
  }
  if (exact.length) return { kind: "none" };

  if (!specific) return { kind: "none" };
  const partial = kept.filter((c) => !placedElsewhere(c) && nearWords(c));
  if (partial.length === 1 && sizeFits(row, partial[0])) return compare(row, partial[0], says, true);
  return { kind: "none" };
}

function compare(row: ReadRow, c: Existing, says: Says, byWords: boolean): Match {
  const words: string[] = [];
  const use: CircuitReadPatch = {};
  const was: CircuitReadPatch = {};
  const matchesList = (v: string) => labelKey(c.panel_label) === v || labelKey(c.description) === v;
  // The plans and Nort say what a circuit FEEDS: a difference there is proposed for what it feeds,
  // never written onto the door. The door label only when the words were the door's (Nort told
  // "the door says Mini Fridge"), checked against the list's own door label.
  const feedsText = row.feeds !== undefined ? row.feeds : row.door ? null : row.said;
  const feeds = labelKey(feedsText);
  if (feeds && !matchesList(feeds)) {
    words.push(`${says.says} It Feeds ${titleWords(feedsText)}, Your List Says ${titleWords(c.description) || titleWords(c.panel_label) || circuitName(c)}.`);
    use.description = titleWords(feedsText);
    was.description = c.description ?? null;
  }
  const door = labelKey(row.door);
  if (door && door !== labelKey(c.panel_label)) {
    words.push(
      `${says.says} The Door Says ${titleWords(row.door)}, ${c.panel_label?.trim() ? `Your List's Door Label Says ${titleWords(c.panel_label)}` : "Your List Has No Door Label"}.`,
    );
    use.panel_label = titleWords(row.door);
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
  const feeds = use.description !== undefined ? `:f=${labelKey(use.description)}` : "";
  return `${source}-flag:${circuitId}:${labelKey(use.panel_label)}:${use.space ?? "-"}${use.half ?? ""}:${use.amps ?? "-"}${feeds}`;
}

/** Is a label check's change already on the circuit it names (Use It was tapped, and nobody has
 *  changed those fields since)? Then putting the check back would ask to make a change already made. */
export function labelCheckApplied(target: Pick<JobCircuit, "panel_label" | "description" | "space" | "half" | "amps"> | null | undefined, use: CircuitReadPatch | null | undefined): boolean {
  if (!target || !use) return false;
  const keys = (["panel_label", "description", "space", "half", "amps"] as const).filter((k) => k in use);
  if (!keys.length) return false;
  return keys.every((k) => {
    const want = use[k] ?? null;
    const now = target[k] ?? null;
    return typeof want === "string" || typeof now === "string" ? labelKey(String(want ?? "")) === labelKey(String(now ?? "")) : want === now;
  });
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
 * The drafts the plans or Nort write, and what they count. `circuits` is EVERY circuit on the job,
 * set-aside ones included (their keys keep a Not This from coming back). New rows are the work the
 * row said. (The photo doesn't come through here: landRead.)
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
        description: m.use.description ?? m.circuit.description,
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
      // The plans' and Nort's words are what it feeds; the door label only when told apart.
      draft = {
        room: titleWords(r.room) || roomFromWords(r.said),
        description: r.feeds !== undefined ? titleWords(r.feeds) || null : words,
        panel_label: titleWords(r.door) || null,
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

// ── the photo: a read lands in its spaces ────────────────────────────────────────────────────────

/** A circuit a photo's read is laid against: one on the panel read — kept, waiting, or set aside. */
export type OnPanel = Pick<JobCircuit, "id" | "panel_id" | "space" | "half" | "poles" | "state" | "removed_at" | "panel_label" | "description">;

/** Why a read line was not written: the panel already says it (same), a suggestion with those words
 *  already waits there (waiting), a person set that one aside before (skipped-before), the read said
 *  it twice (twice), or it had no space to land in (no-space). */
export type LandSkipWhy = "same" | "waiting" | "skipped-before" | "twice" | "no-space";
export type Landing = { toWrite: ReaderDraft[]; skipped: { row: ReadRow; why: LandSkipWhy }[] };

/** The same words, by the label rule (case, spacing, punctuation and "and"/"+" never differ): the
 *  door's words, else what it feeds. */
const sameWordsAs = (key: string, c: Pick<JobCircuit, "panel_label" | "description">) => labelKey(c.panel_label) === key || labelKey(c.description) === key;

/** Do the two meet on the door — any slot of one on any slot of the other (slotsOf: a 2-pole on 9
 *  holds 11 too; a full-width handle, or a line read with no half, meets both halves)? The panel's
 *  one rule for "held" (lib/panel/held slotsMeet), the same the tab draws "Photo says" by. */
const meets = (a: Pick<JobCircuit, "space" | "half" | "poles">, b: Pick<JobCircuit, "space" | "half" | "poles">) =>
  slotsOf(a).some((x) => slotsOf(b).some((y) => slotsMeet(x, y)));

/**
 * WHERE A PHOTO'S READ LANDS — the one rule (pure; pinned in readers.test.ts). `circuits` is every
 * circuit on the job (taken-off and set-aside ones too); only the ones that belong to `panelId`
 * count — on it, or on no panel yet when the job has one live panel (`livePanels`; lib/panel/held
 * belongsToPanel, the rule the tab draws by). With no panel at all (`panelId` null) the loose ones
 * are the panel. Each line the photo read, by its space and half:
 *
 *   · a KEPT circuit it meets on the door (lib/panel/held's rule) with the same words → nothing to
 *     do, not written (same);
 *   · a suggestion with the same words already waiting on that exact space and half → not written
 *     twice (waiting); one a person set aside there (Skip / Not This) stays aside (skipped-before);
 *   · anything else is WRITTEN, a suggestion in that space and half: on an empty space a dimmed
 *     line to keep; beside a kept circuit whose words differ, "Photo says …" with Use It.
 *
 * A line with no words says only that a breaker is there: written on an empty space, nothing to do
 * where something already sits. A line with no space can't land and is named (no-space), never
 * dropped quietly. Re-reading the same photo writes nothing new.
 */
export function landRead(
  read: ReadRow[],
  circuits: OnPanel[],
  o: { panelId: string | null; livePanels?: number | null; stamp?: Partial<CircuitSourceRow> } = { panelId: null },
): Landing {
  const panelId = o.panelId;
  const mine = circuits.filter((c) => (panelId == null ? c.panel_id == null : belongsToPanel(c, { id: panelId }, o.livePanels)));
  const kept = mine.filter((c) => c.state === "kept" && !c.removed_at);
  const pending = mine.filter((c) => c.state === "suggested");
  const out: Landing = { toWrite: [], skipped: [] };
  const seen = new Set<string>();
  for (const r of read) {
    if (r.space == null) {
      out.skipped.push({ row: r, why: "no-space" });
      continue;
    }
    const space = r.space;
    const half = r.half ?? null;
    const key = labelKey(r.said);
    const once = `${space}${half ?? ""}:${key}`;
    if (seen.has(once)) {
      out.skipped.push({ row: r, why: "twice" });
      continue;
    }
    seen.add(once);
    const exact = (c: OnPanel) => c.space === space && (c.half ?? null) === half;
    const there = kept.some((c) => meets(c, r) && (!key || sameWordsAs(key, c)));
    if (there) {
      out.skipped.push({ row: r, why: "same" });
      continue;
    }
    const before = pending.filter((c) => exact(c) && (!key || sameWordsAs(key, c)));
    if (before.length) {
      out.skipped.push({ row: r, why: before.some((c) => !c.removed_at) ? "waiting" : "skipped-before" });
      continue;
    }
    out.toWrite.push({
      room: titleWords(r.room) || roomFromWords(r.said),
      description: null,
      // The photo reads the door: its words are the door label.
      panel_label: titleWords(r.said) || null,
      amps: r.amps,
      poles: r.poles,
      kind: r.kind,
      wire: null,
      space,
      half,
      work: r.work,
      state: "suggested",
      source: "photo",
      source_row: { ...o.stamp, said: r.said, check: r.check, key: readKey("photo", r) },
      sort_order: out.toWrite.length,
    });
  }
  return out;
}

/** "Read 34 lines, 18 new — Keep All or tap each one. 16 already match the panel." The one sentence
 *  of state under Read A Photo. */
export function landedWords(read: number, l: Landing): string {
  if (read === 0) return "Nothing readable in that photo — try one straight on with the door open.";
  const n = l.toWrite.length;
  const count = (why: LandSkipWhy) => l.skipped.filter((s) => s.why === why).length;
  const same = count("same");
  const waiting = count("waiting");
  const before = count("skipped-before");
  const rest = [
    same ? `${same} already ${same === 1 ? "matches" : "match"} the panel` : null,
    waiting ? `${waiting} already waiting` : null,
    before ? `${before} you skipped before` : null,
  ].filter(Boolean) as string[];
  const lines = `${read} line${read === 1 ? "" : "s"}`;
  if (n === 0) return rest.length ? `Read ${lines} — nothing new: ${rest.join(", ")}.` : `Read ${lines} — none of them had a space to land in.`;
  return `Read ${lines}${n === read ? "" : `, ${n} new`} — Keep All or tap each one.${rest.length ? ` ${rest.join(", ")}.` : ""}`;
}

// ── the panel itself ──────────────────────────────────────────────────────────────────────────────

/** What a photo's read said about the panel itself: its brand, its main, how many spaces, and the
 *  spaces where the bus has no stab (No Stab: the panel's dead_spaces). */
export type HeaderSaid = { brand?: string | null; main_amps?: number | null; spaces?: number | null; dead_spaces?: number[] | null };

/** What Use It writes on the panel, and what the panel said when the line was drawn (savePanel's
 *  `seen`: a crewmate's newer value is never overwritten). */
export type PanelFacts = {
  words: string;
  patch: { brand?: string; main_amps?: number; spaces?: number; dead_spaces?: number[] };
  seen: { brand?: string | null; main_amps?: number | null; spaces?: number | null; dead_spaces?: number[] };
};

const mainAmps = (v: unknown): number | null => {
  const n = Number(v);
  return v != null && Number.isInteger(n) && n >= 30 && n <= 1200 ? n : null;
};

/**
 * "The photo says Siemens, 24 spaces, 200 A main, 2 No Stab spaces (23, 24)." — the read's facts
 * about the panel, ONE line, only what differs from the panel (null when nothing does, or there is
 * no panel to use it on). No Stab spaces the panel doesn't mark yet are ADDED to the ones it does
 * (a read never takes one off), and only ones on the panel. Nothing is written by being read: Use It
 * is savePanel with `patch` and `seen`.
 */
export function panelFacts(
  panel: (Pick<JobPanel, "brand" | "main_amps" | "spaces"> & Partial<Pick<JobPanel, "dead_spaces">>) | null,
  said: HeaderSaid | null | undefined,
): PanelFacts | null {
  if (!panel || !said) return null;
  const out: PanelFacts = { words: "", patch: {}, seen: {} };
  const parts: string[] = [];
  const brand = cleanText(said.brand, 60);
  if (brand && brand.toLowerCase() !== (panel.brand ?? "").trim().toLowerCase()) {
    out.patch.brand = brand;
    out.seen.brand = panel.brand ?? null;
    parts.push(brand);
  }
  const spaces = cleanSpace(said.spaces);
  if (spaces != null && spaces !== panel.spaces) {
    out.patch.spaces = spaces;
    out.seen.spaces = panel.spaces ?? null;
    parts.push(`${spaces} spaces`);
  }
  const main = mainAmps(said.main_amps);
  if (main != null && main !== panel.main_amps) {
    out.patch.main_amps = main;
    out.seen.main_amps = panel.main_amps ?? null;
    parts.push(`${main} A main`);
  }
  // NO STAB: only spaces the panel has (the spaces it will say, if this line changes them too).
  const top = out.patch.spaces ?? panel.spaces ?? null;
  const have = [...(panel.dead_spaces ?? [])].sort((a, b) => a - b);
  const fresh = cleanSpaceList(said.dead_spaces ?? []).filter((s) => !have.includes(s) && (top == null || s <= top));
  if (fresh.length) {
    out.patch.dead_spaces = [...new Set([...have, ...fresh])].sort((a, b) => a - b);
    out.seen.dead_spaces = have;
    parts.push(`${fresh.length} No Stab space${fresh.length === 1 ? "" : "s"} (${fresh.join(", ")})`);
  }
  if (!parts.length) return null;
  out.words = `The photo says ${parts.join(", ")}.`;
  return out;
}

// The inspection's own panel answer (brand, amps, the one-box condition) is read on the inspection
// itself since cn-v1141: the Panel tab's "About The Panel" hints that carried it were retired at
// Erik's ask in the panel-first wave, and their reader (inspectionSaid) went with them.
