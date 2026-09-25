/**
 * THE PANEL, IN PURE CODE (Panel tab plan, phase 1). No database, no React: everything here takes
 * rows and returns rows or plain words, so the tab, the print page, the portal and Nort can all ask
 * the same question and get the same answer.
 *
 * The one electrical rule the DATABASE holds is the hard one (0333's job_panel_guard: a kept
 * circuit may not sit on a No Stab space or run off the end of the panel). Everything else here —
 * two circuits on one space, a tandem where the label doesn't allow one, what to buy — is a
 * WARNING a person reads. The app suggests; a person decides.
 *
 * Words: every sentence this file returns is shown to a person as-is, so it is plain words with
 * Title Case on the parts that read like labels ("Short One 2P 20A (Bath Floor Heat).").
 */
import type {
  CircuitKind,
  CircuitSourceRow,
  CircuitWork,
  JobCircuit,
  JobPanel,
  QuoteCircuit,
  SpaceHalf,
} from "@/lib/types";

// ── words ─────────────────────────────────────────────────────────────────────────────────────────

const NUMBER_WORDS = [
  "Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
  "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen", "Twenty",
];
/** 1 → "One", 21 → "21". */
export function countWord(n: number): string {
  return Number.isInteger(n) && n >= 0 && n < NUMBER_WORDS.length ? NUMBER_WORDS[n] : String(n);
}

export const KIND_WORDS: Record<CircuitKind, string> = {
  standard: "Standard",
  afci: "AFCI",
  gfci: "GFCI",
  dual_function: "Dual Function",
  spd: "SPD",
};

/** "2P 20A", "1P 15A AFCI". */
export function sizeWords(poles: number, amps: number | null, kind?: CircuitKind | null): string {
  const base = `${poles}P ${amps == null ? "?" : `${amps}A`}`;
  return kind && kind !== "standard" ? `${base} ${KIND_WORDS[kind]}` : base;
}

/** "kitchen outlets — right" → "Kitchen Outlets Right". Words already capitalised stay as typed
 *  (GFCI, AFCI, TV, #1). */
export function titleWords(s: string | null | undefined): string {
  return String(s ?? "")
    .replace(/[—–]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .map((w) => (/^[a-z]/.test(w) ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/** The name a person knows a circuit by: its room and what it feeds ("Bath Floor Heat"), else the
 *  door label, else its size. */
export function circuitName(c: Pick<JobCircuit, "room" | "description" | "panel_label" | "amps" | "poles">): string {
  const room = titleWords(c.room);
  const feeds = titleWords(c.description);
  if (feeds) {
    if (room && !feeds.toLowerCase().startsWith(room.toLowerCase())) return `${room} ${feeds}`;
    return feeds;
  }
  const label = titleWords(c.panel_label);
  if (label) return label;
  return `${room ? `${room} ` : ""}${sizeWords(c.poles, c.amps)} Circuit`;
}

/** "20A · 1P · Kitchen Outlets Right" — the list line. */
export function circuitLine(c: Pick<JobCircuit, "room" | "description" | "panel_label" | "amps" | "poles" | "kind">): string {
  const parts = [c.amps == null ? "?A" : `${c.amps}A`, `${c.poles}P`];
  if (c.kind && c.kind !== "standard") parts.push(KIND_WORDS[c.kind]);
  const named = titleWords(c.description) || titleWords(c.panel_label) ? circuitName(c) : "Unnamed Circuit";
  return `${parts.join(" · ")} · ${named}`;
}

// ── reading the estimate's take-off ─────────────────────────────────────────────────────────────

const STANDARD_AMPS = new Set([10, 15, 20, 25, 30, 35, 40, 45, 50, 60, 70, 80, 90, 100, 110, 125, 150, 175, 200, 225]);

export type ParsedBreaker = {
  poles: number;
  amps: number | null;
  /** Said when the words and a Siemens part number in the same text disagree. */
  check: string | null;
};

/** A plain Siemens single or multi-pole code (Q115, Q120, Q230, Q2100) → its size. Twins and
 *  quads (Q2020, Q21530CT) are NOT read here: a leading zero or a non-standard size rejects them,
 *  and the full decoder is phase 3's breaker-catalog.ts. */
function siemensPlain(text: string): { poles: number; amps: number; code: string } | null {
  const m = /\bQ([123])(\d{2,3})\b/i.exec(text);
  if (!m) return null;
  if (m[2].startsWith("0")) return null;
  const amps = Number(m[2]);
  if (!STANDARD_AMPS.has(amps)) return null;
  return { poles: Number(m[1]), amps, code: m[0].toUpperCase() };
}

/**
 * "2P 30A" → {poles 2, amps 30}; "20A" → {1, 20}; "SP 15A [Q120]" → {1, 15, check "The estimate
 * says 15A, but Q120 is a 1P 20A."}. The words win and the disagreement is said: which one was the
 * mistake is a person's call (on E-017 it was the part: the circuit is lighting, a 15).
 * Returns null when there is no size in it at all.
 */
export function parseQuoteBreaker(text: string | null | undefined): ParsedBreaker | null {
  const t = String(text ?? "").trim();
  if (!t) return null;
  const words = t.replace(/\[[^\]]*\]|\([^)]*\)/g, " ");
  let poles: number | null = null;
  const p = /\b([123])\s*-?\s*(?:p|pole)\b/i.exec(words);
  if (p) poles = Number(p[1]);
  else if (/\b(?:sp|single[\s-]*pole)\b/i.test(words)) poles = 1;
  else if (/\b(?:dp|double[\s-]*pole|two[\s-]*pole)\b/i.test(words)) poles = 2;
  else if (/\b(?:three[\s-]*pole)\b/i.test(words)) poles = 3;
  const a = /\b(\d{2,3})\s*(?:a|amps?)\b/i.exec(words);
  let amps: number | null = a && STANDARD_AMPS.has(Number(a[1])) ? Number(a[1]) : null;
  const code = siemensPlain(t);
  let check: string | null = null;
  if (code) {
    if (amps == null && poles == null) return { poles: code.poles, amps: code.amps, check: null };
    if ((amps != null && amps !== code.amps) || (poles != null && poles !== code.poles)) {
      check = `The estimate says ${sizeWords(poles ?? 1, amps)}, but ${code.code} is a ${sizeWords(code.poles, code.amps)}.`;
    }
    if (amps == null) amps = code.amps;
    if (poles == null) poles = code.poles;
  }
  if (amps == null && poles == null) return null;
  return { poles: poles ?? 1, amps, check };
}

const ROOM_WORDS: [RegExp, string][] = [
  [/\bkitchen\b/i, "Kitchen"],
  [/\b(?:bath(?:room)?|powder)\b/i, "Bath"],
  [/\b(?:bed(?:room)?|primary suite)\b/i, "Bedroom"],
  [/\bliving\b/i, "Living"],
  [/\bdining\b/i, "Dining"],
  [/\blaundry\b/i, "Laundry"],
  [/\bgarage\b/i, "Garage"],
  [/\boffice\b/i, "Office"],
  [/\bbar\b/i, "Bar"],
  [/\bstair(?:s|way)?\b/i, "Stairs"],
  [/\bmud\s*(?:rm|room)\b/i, "Mud Room"],
  [/\b(?:hall(?:way)?)\b/i, "Hall"],
  [/\bbasement\b/i, "Basement"],
  [/\b(?:exterior|outside|outdoor)\b/i, "Outside"],
];
/** The one room named in the words, or null. A suggestion only: nothing is guessed from an
 *  appliance, and words that name two rooms ("Living/bedroom recepts") name neither. */
export function roomFromWords(...texts: (string | null | undefined)[]): string | null {
  const t = texts.filter(Boolean).join(" ");
  const named = ROOM_WORDS.filter(([re]) => re.test(t)).map(([, room]) => room);
  return named.length === 1 ? named[0] : null;
}

const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();

/** The row's identity for Bring In: the same row of the same estimate comes in once. */
export function sourceKey(c: QuoteCircuit): string {
  return [c.ckt, c.description, c.breaker, c.wire, c.load].map(norm).join("|").slice(0, 400);
}

/** What Bring In writes for one estimate row: a suggestion, never a kept circuit. */
export type CircuitDraft = {
  room: string | null;
  description: string | null;
  panel_label: string | null;
  amps: number | null;
  poles: number;
  kind: CircuitKind | null;
  wire: string | null;
  work: CircuitWork;
  state: "suggested";
  source: "estimate";
  source_quote_id: string;
  source_row: CircuitSourceRow;
  sort_order: number;
};

/**
 * The estimate's take-off (quotes.circuits) as suggestions for the job. The row's words are kept
 * whole in source_row ("From E-017 · Countertop GFCI receptacles"); the estimate's circuit number is
 * NOT a panel space, so no space is set. A room is filled only when the words name one.
 */
export function quoteCircuitsToSuggestions(
  quote: { id: string; quote_number: string | null; circuits: QuoteCircuit[] | null | undefined },
  startSort = 0,
): CircuitDraft[] {
  const rows = Array.isArray(quote.circuits) ? quote.circuits : [];
  const out: CircuitDraft[] = [];
  rows.forEach((c, index) => {
    const description = String(c?.description ?? "").trim() || null;
    const breaker = parseQuoteBreaker(c?.breaker);
    if (!description && !breaker) return;
    out.push({
      room: roomFromWords(c.description, c.load),
      description,
      panel_label: null,
      amps: breaker?.amps ?? null,
      poles: breaker?.poles ?? 1,
      kind: null,
      wire: String(c.wire ?? "").trim() || null,
      work: "new",
      state: "suggested",
      source: "estimate",
      source_quote_id: quote.id,
      source_row: {
        key: sourceKey(c),
        quote_number: quote.quote_number,
        index,
        ckt: c.ckt ?? null,
        description: c.description ?? null,
        wire: c.wire ?? null,
        breaker: c.breaker ?? null,
        load: c.load ?? null,
        check: breaker?.check ?? null,
      },
      sort_order: startSort + out.length,
    });
  });
  return out;
}

/** Split a Bring In into what is new and what is already on the job (kept, suggested, or set aside
 *  with Not This: a set-aside row stays set aside). */
export function newSuggestionsOnly(
  drafts: CircuitDraft[],
  existing: Pick<JobCircuit, "source_quote_id" | "source_row" | "removed_at">[],
): { fresh: CircuitDraft[]; already: number; setAside: number } {
  const have = new Map<string, boolean>();
  for (const e of existing) {
    const k = e.source_row?.key;
    if (e.source_quote_id && k) have.set(`${e.source_quote_id}|${k}`, !!e.removed_at);
  }
  const fresh: CircuitDraft[] = [];
  let already = 0;
  let setAside = 0;
  const seen = new Set<string>();
  for (const d of drafts) {
    const k = `${d.source_quote_id}|${d.source_row.key}`;
    if (have.has(k)) {
      if (have.get(k)) setAside++;
      else already++;
      continue;
    }
    if (seen.has(k)) continue;
    seen.add(k);
    fresh.push(d);
  }
  return { fresh, already, setAside };
}

/** The estimates a job's Panel tab can bring in, best first: the job's own, then the same
 *  customer's with no job yet, each only if it has circuits. */
export type EstimateCandidate = {
  id: string;
  quote_number: string | null;
  job_id: string | null;
  customer_id: string | null;
  address: string | null;
  count: number;
  created_at: string | null;
};
export function rankEstimateCandidates(
  jobId: string,
  customerId: string | null,
  quotes: { id: string; quote_number: string | null; job_id: string | null; customer_id: string | null; circuits: unknown; address?: string | null; created_at?: string | null }[],
): EstimateCandidate[] {
  const rows = quotes
    .map((q) => ({
      id: q.id,
      quote_number: q.quote_number,
      job_id: q.job_id,
      customer_id: q.customer_id,
      address: q.address ?? null,
      count: Array.isArray(q.circuits) ? (q.circuits as unknown[]).length : 0,
      created_at: q.created_at ?? null,
    }))
    .filter((q) => q.count > 0 && (q.job_id === jobId || (q.job_id == null && customerId != null && q.customer_id === customerId)));
  return rows.sort(
    (a, b) =>
      Number(b.job_id === jobId) - Number(a.job_id === jobId) || String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")),
  );
}

// ── where circuits sit ──────────────────────────────────────────────────────────────────────────

export type Slot = { space: number; half: SpaceHalf | null };

/** The spaces a circuit covers. A 1P covers its space; a 2P covers s and s+2 on the same side
 *  (odd left, even right, whichever way the numbers run), a 3P s, s+2, s+4. A half (A/B) stays in
 *  that half of each space: a quad's inner 2P at 25B covers 25B and 27B. */
export function slotsOf(c: Pick<JobCircuit, "space" | "half" | "poles">): Slot[] {
  if (c.space == null) return [];
  const poles = Math.max(1, Math.min(3, Number(c.poles) || 1));
  return Array.from({ length: poles }, (_, i) => ({ space: c.space! + 2 * i, half: c.half ?? null }));
}

export type PanelWarning = {
  kind: "collision" | "past_end" | "no_stab" | "tandem_not_allowed";
  space: number;
  circuitIds: string[];
  message: string;
};

export type SpaceCell = { A: string[]; B: string[]; full: string[] };
export type SpaceMap = { cells: Map<number, SpaceCell>; warnings: PanelWarning[]; placed: number };

type Placeable = Pick<JobCircuit, "id" | "panel_id" | "space" | "half" | "poles" | "state" | "removed_at" | "room" | "description" | "panel_label" | "amps">;

/** A circuit counts on the panel when it is kept, live, on this panel, and has a space. */
export function isPlaced(c: Placeable, panelId: string): boolean {
  return c.panel_id === panelId && c.state === "kept" && !c.removed_at && c.space != null;
}

/** Occupancy for the Positions view, and the warnings a person should read. Suggestions don't
 *  occupy anything; nothing counts until kept. */
export function spaceMap(
  panel: Pick<JobPanel, "id" | "spaces" | "dead_spaces" | "twin_spaces">,
  circuits: Placeable[],
): SpaceMap {
  const cells = new Map<number, SpaceCell>();
  const warnings: PanelWarning[] = [];
  const cell = (s: number) => {
    let c = cells.get(s);
    if (!c) cells.set(s, (c = { A: [], B: [], full: [] }));
    return c;
  };
  const dead = new Set(panel.dead_spaces ?? []);
  const twins = new Set(panel.twin_spaces ?? []);
  let placed = 0;
  for (const c of circuits) {
    if (!isPlaced(c, panel.id)) continue;
    placed++;
    const name = circuitName(c);
    for (const s of slotsOf(c)) {
      if (panel.spaces != null && s.space > panel.spaces) {
        warnings.push({ kind: "past_end", space: s.space, circuitIds: [c.id], message: `${name} runs to space ${s.space}, past the end of this ${panel.spaces}-space panel.` });
        continue;
      }
      if (dead.has(s.space)) {
        warnings.push({ kind: "no_stab", space: s.space, circuitIds: [c.id], message: `${name} is on space ${s.space}, which has No Stab.` });
      }
      if (s.half && twins.size > 0 && !twins.has(s.space)) {
        warnings.push({
          kind: "tandem_not_allowed",
          space: s.space,
          circuitIds: [c.id],
          message: `${name} is a tandem on space ${s.space}, and the panel label doesn't allow tandems there.`,
        });
      }
      const k = cell(s.space);
      if (s.half) k[s.half].push(c.id);
      else k.full.push(c.id);
    }
  }
  for (const [space, k] of [...cells.entries()].sort((a, b) => a[0] - b[0])) {
    const clash = (ids: string[]) => {
      const uniq = [...new Set(ids)];
      if (uniq.length < 2) return;
      const names = uniq.map((id) => circuitName(circuits.find((c) => c.id === id)!));
      warnings.push({ kind: "collision", space, circuitIds: uniq, message: `Space ${space} has ${names.join(" and ")} on it.` });
    };
    // A full-width breaker takes both halves, so anything else on the space collides with it; two
    // tandem halves (A and B) share a space legally.
    if (k.full.length) clash([...k.full, ...k.A, ...k.B]);
    else {
      clash(k.A);
      clash(k.B);
    }
  }
  return { cells, warnings: dedupeWarnings(warnings), placed };
}

function dedupeWarnings(ws: PanelWarning[]): PanelWarning[] {
  const seen = new Set<string>();
  return ws.filter((w) => {
    const k = `${w.kind}|${w.space}|${[...w.circuitIds].sort().join(",")}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** The door as it hangs: odd spaces down the left, even down the right, row by row, top of the
 *  box first. Space 1 is at the top unless the panel says its numbers run bottom up. */
export function doorRows(panel: Pick<JobPanel, "spaces" | "numbering">, extra: number[] = []): { left: number; right: number }[] {
  const top = Math.max(panel.spaces ?? 0, ...extra.map((s) => (s % 2 ? s + 1 : s)), 2);
  const rows: { left: number; right: number }[] = [];
  for (let s = 1; s <= top; s += 2) rows.push({ left: s, right: s + 1 });
  return panel.numbering === "bottom_up" ? rows.reverse() : rows;
}

/** Is there a pair of tandem-rated spaces (s and s+2, same side) with nothing on them, so a quad
 *  could go in? Unknown spaces or no tandem spaces on the label → no. */
export function quadSpaceFree(panel: Pick<JobPanel, "id" | "spaces" | "dead_spaces" | "twin_spaces">, map: SpaceMap): boolean {
  if (panel.spaces == null) return false;
  const twins = new Set(panel.twin_spaces ?? []);
  const dead = new Set(panel.dead_spaces ?? []);
  const empty = (s: number) => {
    const k = map.cells.get(s);
    return !k || (k.A.length === 0 && k.B.length === 0 && k.full.length === 0);
  };
  for (let s = 1; s + 2 <= panel.spaces; s++) {
    if (twins.has(s) && twins.has(s + 2) && !dead.has(s) && !dead.has(s + 2) && empty(s) && empty(s + 2)) return true;
  }
  return false;
}

// ── the list ────────────────────────────────────────────────────────────────────────────────────

export const NO_ROOM = "No Room Yet";

/** Rooms in the order they first appear (by sort order), with the unroomed last. */
export function groupByRoom<T extends Pick<JobCircuit, "room" | "sort_order">>(circuits: T[]): { room: string; circuits: T[] }[] {
  const sorted = [...circuits].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
  const groups = new Map<string, T[]>();
  for (const c of sorted) {
    const room = titleWords(c.room) || NO_ROOM;
    const key = room.toLowerCase();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(c);
  }
  const out = [...groups.entries()].map(([, cs]) => ({ room: titleWords(cs[0].room) || NO_ROOM, circuits: cs }));
  return [...out.filter((g) => g.room !== NO_ROOM), ...out.filter((g) => g.room === NO_ROOM)];
}

const LABEL_NOISE = /\b(and|the|ckt|circuit|cir)\b|[+&/.,#\-—–()]/g;
const squash = (s: string | null | undefined) => norm(s).replace(LABEL_NOISE, " ").replace(/\s+/g, " ").trim();

/** Does the door say something other than what the circuit feeds? ("Entry Lights" on the circuit
 *  that feeds "Kitchen And Living".) Case, punctuation and "and"/"+" never count as different. */
export function labelDiffers(c: Pick<JobCircuit, "panel_label" | "description">): boolean {
  const a = squash(c.panel_label);
  const b = squash(c.description);
  return !!a && !!b && a !== b;
}

/** The plain-words flag for the edit sheet. */
export function labelDiffersWords(c: Pick<JobCircuit, "panel_label" | "description">): string | null {
  if (!labelDiffers(c)) return null;
  return `The door says ${titleWords(c.panel_label)}, but it feeds ${titleWords(c.description)}.`;
}

// ── what to buy ────────────────────────────────────────────────────────────────────────────────

export type PoleGroup = { poles: number; amps: number; kind: CircuitKind | null };
export type NeedLine = PoleGroup & { count: number; circuits: { id: string; name: string }[] };
export type Need = { lines: NeedLine[]; unsized: { id: string; name: string }[]; alreadyIn: { existing: number; reused: number } };

const live = (c: Pick<JobCircuit, "state" | "removed_at">) => c.state === "kept" && !c.removed_at;

/**
 * The breakers the new work needs: kept, live circuits whose work is NEW, counted by poles, amps
 * and type. Existing and reused circuits already have a breaker; a new circuit with no amps yet is
 * listed on its own so it is never silently left out of the count.
 */
export function breakerNeed(
  circuits: Pick<JobCircuit, "id" | "state" | "removed_at" | "work" | "poles" | "amps" | "kind" | "room" | "description" | "panel_label" | "sort_order">[],
): Need {
  const lines = new Map<string, NeedLine>();
  const unsized: { id: string; name: string }[] = [];
  const alreadyIn = { existing: 0, reused: 0 };
  const sorted = [...circuits].filter(live).sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
  for (const c of sorted) {
    if (c.work === "existing") alreadyIn.existing++;
    if (c.work === "reused") alreadyIn.reused++;
    if (c.work !== "new") continue;
    const name = circuitName(c);
    if (c.amps == null) {
      unsized.push({ id: c.id, name });
      continue;
    }
    const kind = c.kind === "standard" ? null : c.kind;
    const k = `${c.poles}|${c.amps}|${kind ?? ""}`;
    const line = lines.get(k) ?? { poles: c.poles, amps: c.amps, kind, count: 0, circuits: [] };
    line.count++;
    line.circuits.push({ id: c.id, name });
    lines.set(k, line);
  }
  const ordered = [...lines.values()].sort((a, b) => a.poles - b.poles || a.amps - b.amps || String(a.kind ?? "").localeCompare(String(b.kind ?? "")));
  return { lines: ordered, unsized, alreadyIn };
}

/** "Need 2 x 1P 15A, 15 x 1P 20A, 1 x 2P 20A, 1 x 2P 30A." */
export function needSentence(need: Need): string {
  if (!need.lines.length) return need.unsized.length ? "" : "No new breakers needed.";
  return `Need ${need.lines.map((l) => `${l.count} x ${sizeWords(l.poles, l.amps, l.kind)}`).join(", ")}.`;
}

/** A breaker you have (bought, or on the list): its form and the pole groups inside it. A Q2020 is
 *  a twin of two 1P 20A; a Q21530CT is a quad of two 1P 15A and a 2P 30A. */
export type HaveItem = {
  label?: string;
  qty: number;
  form: "single" | "twin" | "quad" | "double";
  slots: PoleGroup[];
};

/** Can a breaker of this type serve a circuit that needs that type? A dual-function breaker serves
 *  an AFCI, a GFCI or a plain circuit; an AFCI or GFCI breaker also serves a plain one. */
function serves(have: CircuitKind | null, need: CircuitKind | null): boolean {
  const h = have ?? "standard";
  const n = need ?? "standard";
  if (h === n) return true;
  if (h === "dual_function") return n === "afci" || n === "gfci" || n === "standard";
  if (n === "standard") return h === "afci" || h === "gfci";
  return false;
}

export type Shortfall = PoleGroup & { count: number; circuits: { id: string; name: string }[] };
export type Spare = PoleGroup & { count: number };
export type Swap = {
  /** Give up one of these… */
  give: { form: "twin"; poles: 1; amps: number; label?: string };
  /** …for this quad, which covers the same two 1-poles AND the missing 2-pole. */
  get: { part: string; outer: number; inner: number };
  covers: PoleGroup;
  /** Said beside the option, because the lookalike part is a different breaker. */
  warning: string | null;
  words: string;
};
export type BreakerCheck = {
  ok: boolean;
  short: Shortfall[];
  spare: Spare[];
  swaps: Swap[];
  /** Each sentence as it is shown: "Short One 2P 20A (Bath Floor Heat)." then "One 1P 20A Spare." */
  lines: string[];
  verdict: string;
};

/** The Siemens CT quads that trade a twin for a twin-plus-2-pole: outer 1P amps, inner 2P amps.
 *  Phase 3's breaker-catalog.ts owns the full table; this is the part of it the swap needs. */
const QUADS: { outer: number; inner: number; part: string; trap?: string; trapWords?: string }[] = [
  { outer: 20, inner: 20, part: "Q22020CT", trap: "Q22020CT2", trapWords: "Not Q22020CT2, That Is Two 2-Pole 20s" },
  { outer: 15, inner: 20, part: "Q21520CT" },
  { outer: 15, inner: 30, part: "Q21530CT" },
];

/**
 * Need against Have, in plain words. Specific types (dual function, AFCI, GFCI, SPD) are matched
 * first so a plain need never uses up the only AFCI. The quad swap is offered only when a
 * tandem-rated pair of spaces is free (quadSpaceFree), and never silently: it is an option beside
 * the shortfall, not a change to the count.
 */
export function breakerCheck(need: Need, have: HaveItem[], opts: { quadSpaceFree?: boolean } = {}): BreakerCheck {
  // Every pole group you have, one entry per breaker-worth.
  const pool: (PoleGroup & { used: boolean; from: HaveItem })[] = [];
  for (const h of have) {
    const qty = Math.max(0, Math.floor(Number(h.qty) || 0));
    for (let i = 0; i < qty; i++) for (const s of h.slots) pool.push({ ...s, kind: s.kind === "standard" ? null : s.kind, used: false, from: h });
  }
  const specificity = (k: CircuitKind | null) => (k === "dual_function" ? 0 : k === "afci" || k === "gfci" ? 1 : k === "spd" ? 2 : 3);
  const lines = [...need.lines].sort((a, b) => specificity(a.kind) - specificity(b.kind));
  const short: Shortfall[] = [];
  for (const l of lines) {
    let covered = 0;
    // Exact type first, then anything that serves it.
    for (const pass of [true, false]) {
      for (const p of pool) {
        if (covered >= l.count) break;
        if (p.used || p.poles !== l.poles || p.amps !== l.amps) continue;
        if (pass ? (p.kind ?? null) !== (l.kind ?? null) : !serves(p.kind, l.kind)) continue;
        p.used = true;
        covered++;
      }
    }
    if (covered < l.count) {
      short.push({ poles: l.poles, amps: l.amps, kind: l.kind, count: l.count - covered, circuits: l.circuits.slice(covered) });
    }
  }
  const spareMap = new Map<string, Spare>();
  for (const p of pool) {
    if (p.used) continue;
    const k = `${p.poles}|${p.amps}|${p.kind ?? ""}`;
    const s = spareMap.get(k) ?? { poles: p.poles, amps: p.amps, kind: p.kind, count: 0 };
    s.count++;
    spareMap.set(k, s);
  }
  const spare = [...spareMap.values()].sort((a, b) => a.poles - b.poles || a.amps - b.amps);
  short.sort((a, b) => a.poles - b.poles || a.amps - b.amps);

  const swaps: Swap[] = [];
  if (opts.quadSpaceFree) {
    for (const s of short) {
      if (s.poles !== 2 || s.kind) continue;
      for (const q of QUADS.filter((x) => x.inner === s.amps)) {
        const twin = have.find((h) => h.form === "twin" && h.qty > 0 && h.slots.length === 2 && h.slots.every((x) => x.poles === 1 && x.amps === q.outer && !x.kind));
        if (!twin) continue;
        swaps.push({
          give: { form: "twin", poles: 1, amps: q.outer, label: twin.label },
          get: { part: q.part, outer: q.outer, inner: q.inner },
          covers: { poles: 2, amps: s.amps, kind: null },
          warning: q.trapWords ?? null,
          words: `Or Swap One ${twin.label ?? `Twin 1P ${q.outer}A`} For A ${q.part}: the same two 1P ${q.outer}A plus the 2P ${q.inner}A, in a tandem space.`,
        });
      }
    }
  }

  const out: string[] = [];
  for (const s of short) {
    const names = s.circuits.map((c) => c.name).filter(Boolean);
    out.push(`Short ${countWord(s.count)} ${sizeWords(s.poles, s.amps, s.kind)}${names.length ? ` (${names.join(", ")})` : ""}.`);
  }
  for (const s of spare) out.push(`${countWord(s.count)} ${sizeWords(s.poles, s.amps, s.kind)} Spare.`);
  if (need.unsized.length) {
    out.push(`${countWord(need.unsized.length)} New ${need.unsized.length === 1 ? "Circuit Has" : "Circuits Have"} No Amps Yet (${need.unsized.map((u) => u.name).join(", ")}).`);
  }
  const ok = short.length === 0 && need.unsized.length === 0;
  const verdict = out.length ? out.join(" ") : need.lines.length ? "You Have Every Breaker The New Work Needs." : "No New Breakers Needed.";
  return { ok, short, spare, swaps, lines: out, verdict };
}

// ── the progress chip ────────────────────────────────────────────────────────────────────────────

export const PROGRESS_ORDER = ["planned", "roughed", "done"] as const;
export const PROGRESS_WORDS: Record<(typeof PROGRESS_ORDER)[number], string> = { planned: "Planned", roughed: "Roughed", done: "Done" };
/** One tap: Planned → Roughed → Done → Planned (with Undo on every step). */
export function nextProgress(p: (typeof PROGRESS_ORDER)[number]): (typeof PROGRESS_ORDER)[number] {
  const i = PROGRESS_ORDER.indexOf(p);
  return PROGRESS_ORDER[(i + 1) % PROGRESS_ORDER.length];
}

export const WORK_WORDS: Record<CircuitWork, string> = { new: "New", existing: "Existing", reused: "Reused", removed: "Coming Out" };
