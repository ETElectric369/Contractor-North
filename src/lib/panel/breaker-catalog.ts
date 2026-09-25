/**
 * WHAT A BREAKER LINE IS (Panel plan, phase 3). A supplier's line ("SIEM Q2020 SP 20/20A 120/240V
 * CB"), a crew member's materials line ("20a twin breaker") or a shelf item's name, read into the
 * pole groups inside the part: a Q2020 is a TWIN of two 1P 20A; a Q21530CT is a QUAD of two 1P 15A
 * and a 2P 30A; a Q22020CT2 is TWO 2P 20A, not the quad it looks like.
 *
 * THREE ANSWERS, NEVER A FOURTH:
 *   breaker      the part is read exactly, from a code this table knows or from words that say the
 *                poles AND the amps. There is no confidence score: it is read, or it isn't.
 *   unknown      it is a breaker (a breaker code, or the word breaker / CB) but this table can't say
 *                what is inside it, or its words and its code disagree. It counts as ZERO toward what
 *                you have and is shown as "Can't Read This Breaker" in the office's view and the
 *                crew's alike. A person confirms it; the app never guesses.
 *   not_breaker  a switch, a receptacle, a load centre, wire: not counted and not shown.
 *
 * ONE READER: the Breakers card (office and crew), the Place From What Was Bought sheet and the
 * estimator's Generate From Line Items prompt all take their codes from this file.
 */
import type { CircuitKind } from "@/lib/types";
import { normalisePartNumber } from "@/lib/shelf-plan";

export type BreakerForm = "single" | "double" | "twin" | "quad";
/** One pole group inside a part: a 1P 20A, a 2P 30A. kind null = a plain breaker. */
export type BreakerSlot = { poles: number; amps: number; kind: CircuitKind | null };
export type BrandKey = "siemens" | "square_d_homeline" | "square_d_qo" | "eaton_br" | "eaton_ch" | "ge";

export type DecodedBreaker = {
  kind: "breaker";
  /** The part number as the supplier writes it ("Q21530CT"), or null for a words-only line. */
  code: string | null;
  brand: BrandKey | null;
  /** single = one 1P; double = one full-width 2P or 3P; twin = two 1P in one space; quad = four
   *  poles in two spaces (two 1P outside and a 2P inside, or two 2P). */
  form: BreakerForm;
  slots: BreakerSlot[];
  /** "Twin 1P 20A + 1P 20A", "Quad 1P 15A + 1P 15A + 2P 30A". */
  words: string;
};
export type UnknownBreaker = { kind: "unknown"; code: string | null; reason: string };
export type NotABreaker = { kind: "not_breaker"; reason: string };
export type BreakerReading = DecodedBreaker | UnknownBreaker | NotABreaker;

const STANDARD_AMPS = new Set([10, 15, 20, 25, 30, 35, 40, 45, 50, 60, 70, 80, 90, 100, 110, 125, 150, 175, 200, 225]);
const amp = (s: string): number | null => (/^0/.test(s) ? null : STANDARD_AMPS.has(Number(s)) ? Number(s) : null);

const KIND_WORD: Record<CircuitKind, string> = { standard: "", afci: "AFCI", gfci: "GFCI", dual_function: "Dual Function", spd: "SPD" };
const slotWords = (s: BreakerSlot) => `${s.poles}P ${s.amps}A${s.kind ? ` ${KIND_WORD[s.kind]}` : ""}`;
const FORM_WORD: Record<BreakerForm, string> = { single: "", double: "", twin: "Twin ", quad: "Quad " };
export function breakerWords(form: BreakerForm, slots: BreakerSlot[]): string {
  return `${FORM_WORD[form]}${slots.map(slotWords).join(" + ")}`;
}

/** Shape a reading from its pole groups. */
function made(code: string | null, brand: BrandKey | null, form: BreakerForm, slots: BreakerSlot[]): DecodedBreaker {
  return { kind: "breaker", code, brand, form, slots, words: breakerWords(form, slots) };
}
const one = (poles: number, amps: number, kind: CircuitKind | null = null): BreakerSlot => ({ poles, amps, kind });
function plain(code: string, brand: BrandKey, poles: number, amps: number, kind: CircuitKind | null = null): DecodedBreaker {
  return made(code, brand, poles === 1 ? "single" : "double", [one(poles, amps, kind)]);
}

// ── THE TABLE ───────────────────────────────────────────────────────────────────────────────────
// Only parts whose insides are known. A code with the right shape that isn't listed here (a Siemens
// quad this table has never seen) is "unknown", never extrapolated from the pattern.

/** Siemens twins: two 1P in one space. */
const SIEMENS_TWINS: Record<string, [number, number]> = { Q1515: [15, 15], Q1520: [15, 20], Q2020: [20, 20] };
/** Siemens CT quads: two 1P outside (the first amps) and a 2P inside (the second). */
const SIEMENS_QUADS: Record<string, { outer: number; inner: number }> = {
  Q21520CT: { outer: 15, inner: 20 },
  Q21530CT: { outer: 15, inner: 30 },
  Q22020CT: { outer: 20, inner: 20 },
  Q22050CT: { outer: 20, inner: 50 },
};
/** The CT2 trap: the same letters, but two 2-pole breakers. */
const SIEMENS_TWO_DOUBLES: Record<string, [number, number]> = { Q22020CT2: [20, 20] };

/** The quads a missing 2P can be swapped in on (model.ts breakerCheck), with the lookalike said
 *  beside the one that has one. Derived from the table above so there is one list. */
export const QUAD_SWAPS: { part: string; outer: number; inner: number; trap?: string; trapWords?: string }[] = Object.entries(SIEMENS_QUADS).map(
  ([part, q]) => {
    const trap = Object.keys(SIEMENS_TWO_DOUBLES).find((t) => t.startsWith(part));
    const [a, b] = trap ? SIEMENS_TWO_DOUBLES[trap] : [0, 0];
    return trap
      ? { part, ...q, trap, trapWords: `Not ${trap}, That Is Two 2-Pole ${a === b ? `${a}s` : `${a}A And ${b}A`}` }
      : { part, ...q };
  },
);

/** Read ONE part-number token (already upper case, no punctuation). null = not a code this table
 *  has a pattern for; an UnknownBreaker = a breaker code it can't read. */
export function decodeCode(token: string): DecodedBreaker | UnknownBreaker | null {
  const t = normalisePartNumber(token) ?? "";
  if (!t) return null;
  let m: RegExpExecArray | null;

  // ── Siemens ──
  if (SIEMENS_TWINS[t]) return made(t, "siemens", "twin", SIEMENS_TWINS[t].map((a) => one(1, a)));
  if (SIEMENS_QUADS[t]) {
    const q = SIEMENS_QUADS[t];
    return made(t, "siemens", "quad", [one(1, q.outer), one(1, q.outer), one(2, q.inner)]);
  }
  if (SIEMENS_TWO_DOUBLES[t]) return made(t, "siemens", "quad", SIEMENS_TWO_DOUBLES[t].map((a) => one(2, a)));
  if ((m = /^QSA(\d{2})(\d{2})SPD$/.exec(t)) && amp(m[1]) && amp(m[2])) {
    // The Siemens surge arrester with two 1P breakers on it (GDO #1 and #2 at Herringbone).
    return made(t, "siemens", "twin", [one(1, amp(m[1])!, "spd"), one(1, amp(m[2])!, "spd")]);
  }
  if ((m = /^QF([12])(\d{2,3})(A|AN|AP)?$/.exec(t)) && amp(m[2])) return plain(t, "siemens", Number(m[1]), amp(m[2])!, "gfci");
  if ((m = /^QPF([12])(\d{2,3})[A-Z]*$/.exec(t)) && amp(m[2])) return plain(t, "siemens", Number(m[1]), amp(m[2])!, "gfci");
  if ((m = /^QAFGF([12])(\d{2,3})[A-Z]*$/.exec(t)) && amp(m[2])) return plain(t, "siemens", Number(m[1]), amp(m[2])!, "dual_function");
  if ((m = /^QAF?([12])(\d{2,3})(AFC|AFCN|AFCP|AF)?$/.exec(t)) && amp(m[2])) return plain(t, "siemens", Number(m[1]), amp(m[2])!, "afci");
  if ((m = /^Q([12])(\d{2,3})(AFC|AFCN|AFCP)$/.exec(t)) && amp(m[2])) return plain(t, "siemens", Number(m[1]), amp(m[2])!, "afci");
  if ((m = /^Q([12])(\d{2,3})(DF|DFN|DFP)$/.exec(t)) && amp(m[2])) return plain(t, "siemens", Number(m[1]), amp(m[2])!, "dual_function");
  if ((m = /^Q([12])(\d{2,3})(GF|GFN|GFP)$/.exec(t)) && amp(m[2])) return plain(t, "siemens", Number(m[1]), amp(m[2])!, "gfci");
  if ((m = /^Q([123])(\d{2,3})$/.exec(t)) && amp(m[2])) return plain(t, "siemens", Number(m[1]), amp(m[2])!);

  // ── Square D Homeline and QO ──
  if ((m = /^(HOM|QO)T(\d{2})(\d{2})$/.exec(t)) && amp(m[2]) && amp(m[3])) {
    return made(t, m[1] === "HOM" ? "square_d_homeline" : "square_d_qo", "twin", [one(1, amp(m[2])!), one(1, amp(m[3])!)]);
  }
  if ((m = /^(HOM|QO)T2(\d{2})2(\d{2})$/.exec(t)) && amp(m[2]) && amp(m[3])) {
    // HOMT230250: a quadplex of a 2P 30A and a 2P 50A.
    return made(t, m[1] === "HOM" ? "square_d_homeline" : "square_d_qo", "quad", [one(2, amp(m[2])!), one(2, amp(m[3])!)]);
  }
  if ((m = /^(HOM|QO)T(\d{2})(\d{2})2(\d{2})$/.exec(t)) && amp(m[2]) && amp(m[3]) && amp(m[4])) {
    // HOMT2020220: two 1P 20A outside a 2P 20A.
    return made(t, m[1] === "HOM" ? "square_d_homeline" : "square_d_qo", "quad", [one(1, amp(m[2])!), one(1, amp(m[3])!), one(2, amp(m[4])!)]);
  }
  if ((m = /^(HOM|QO)([123])(\d{2,3})(P?)(GFI|CAFI|AFI|DF|DFC|PDF|PDFC)?$/.exec(t)) && amp(m[3])) {
    const suffix = m[5] ?? "";
    const kind: CircuitKind | null = /GFI/.test(suffix) ? "gfci" : /AFI/.test(suffix) ? "afci" : /DF/.test(suffix) ? "dual_function" : null;
    return plain(t, m[1] === "HOM" ? "square_d_homeline" : "square_d_qo", Number(m[2]), amp(m[3])!, kind);
  }

  // ── Eaton BR and CH ──
  if ((m = /^(BR|CH)([123])(\d{2,3})$/.exec(t)) && amp(m[3])) return plain(t, m[1] === "BR" ? "eaton_br" : "eaton_ch", Number(m[2]), amp(m[3])!);

  // ── GE: THQL1120 is 1P 20A, THQL2130 is 2P 30A (the digit after the poles is the series) ──
  if ((m = /^THQL([12])1(\d{2,3})(AF|AF2|GF|GFEP|DF)?$/.exec(t)) && amp(m[2])) {
    const s = m[3] ?? "";
    const kind: CircuitKind | null = s.startsWith("AF") ? "afci" : s.startsWith("GF") ? "gfci" : s === "DF" ? "dual_function" : null;
    return plain(t, "ge", Number(m[1]), amp(m[2])!, kind);
  }
  if ((m = /^THQP([12])(\d{2,3})$/.exec(t)) && amp(m[2])) return plain(t, "ge", Number(m[1]), amp(m[2])!);

  // A breaker-family code this table can't read: said, never guessed.
  // The prefixes are narrow on purpose: "BR2" is a bedroom on a materials line and "Q1" a quarter,
  // so a bare family letter needs three digits after it before it is read as a part.
  // QT (Siemens' older tandems, QT2020) and QP (QP120) are Siemens breakers this table doesn't list.
  if (/^(Q\d{3}|QT\d{3}|QP\d{3}|QF\d|QAF?\d|QPF\d|QAFGF|QSA\d|HOMT?\d{3}|QOT?\d{3}|BR\d{3}|BD\d{3}|CHT?\d{3}|THQ[LP]?\d)/.test(t)) {
    return { kind: "unknown", code: t, reason: `Can't Read ${t}. Confirm What Is Inside It.` };
  }
  return null;
}

// ── WORDS ───────────────────────────────────────────────────────────────────────────────────────

const BREAKER_WORD = /\b(?:CB|BREAKERS?|BRKRS?|BKRS?|CKT\s*BRKR|MINIATURE\s+(?:CIRCUIT|CKT))\b/;
const LOAD_CENTRE = /\b(?:LOAD\s*CENT(?:ER|RE)|LOADCENT(?:ER|RE)|LD-?\s*CTR|MAIN\s+LUG|MLO)\b|\b\d{1,2}\s*\/\s*\d{1,2}\s*CT\b|\bPN\d{4}/;
// A disconnect, a contactor, a fuse, a time clock or a relay says poles and amps too ("AC DISCONNECT
// 60A 2P NON-FUSED"): none of them is a breaker, and counting one would cover a real shortfall.
const NOT_BREAKER =
  /\b(?:SWITCH(?:ES)?|SW|SEN|SENSOR|DIMMER|DMR|RECPT|RCPT|RECEPT|RECEPTACLES?|OUTLETS?|PLATE|PLT|FP|BOX|BOXES|WIRE|NMB?|ROMEX|TUBE|SHRINK|HOUSING|HSG|FIXT|FIXTURE|CORD|CONNECTOR|CONN|STRAP|STAPLES?|METER|DISCONNECTS?|DISC|PULL\s*-?\s*OUTS?|NON\s*-?\s*FUS(?:ED|IBLE)|FUS(?:ED|IBLE)|FUSES?|SAFETY|CONTACTORS?|RELAYS?|TIMERS?|TIME\s*CLOCKS?|SPA\s*PANEL|ENCLOSURES?|ENCL)\b/;
const KIND_OF_WORDS: [RegExp, CircuitKind][] = [
  [/\bDUAL\s*FUNCTION\b/, "dual_function"],
  [/\b(?:AFCI|AFI|CAFI|ARC\s*FAULT)\b/, "afci"],
  [/\b(?:GFCI|GFI|GROUND\s*FAULT)\b/, "gfci"],
  [/\b(?:SPD|SURGE)\b/, "spd"],
];

function kindOfWords(t: string): CircuitKind | null {
  for (const [re, k] of KIND_OF_WORDS) if (re.test(t)) return k;
  return null;
}
function polesOfWords(t: string): number | null {
  if (/\b(?:SP|1\s*-?\s*P|1\s*-?\s*POLE|SINGLE\s*-?\s*POLE)\b/.test(t)) return 1;
  if (/\b(?:DP|2\s*-?\s*P|2\s*-?\s*POLE|DOUBLE\s*-?\s*POLE|TWO\s*-?\s*POLE)\b/.test(t)) return 2;
  if (/\b(?:3\s*-?\s*P|3\s*-?\s*POLE|THREE\s*-?\s*POLE)\b/.test(t)) return 3;
  return null;
}
/** Every amp size the words name ("20/20A" names 20 twice; "120/240V" names none). */
function ampsOfWords(t: string): number[] {
  const out: number[] = [];
  const pair = /\b(\d{2,3})\s*\/\s*(\d{2,3})\s*A(?:MPS?)?\b/g;
  let m: RegExpExecArray | null;
  const stripped = t.replace(pair, (_all, a: string, b: string) => {
    if (amp(a)) out.push(amp(a)!);
    if (amp(b)) out.push(amp(b)!);
    return " ";
  });
  const single = /\b(\d{2,3})\s*A(?:MPS?)?\b/g;
  while ((m = single.exec(stripped))) if (amp(m[1])) out.push(amp(m[1])!);
  return out;
}

/** "Quad 2p - 30a - 1p-15s breaker" → the pole/amp pairs it names: [2P 30, 1P 15]. */
function pairsOfWords(t: string): { poles: number; amps: number }[] {
  const out: { poles: number; amps: number }[] = [];
  const re = /\b([123])\s*-?\s*P(?:OLE)?\s*[-–,/]?\s*(\d{2,3})\s*(?:A|AMPS?|S)?\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t))) if (amp(m[2])) out.push({ poles: Number(m[1]), amps: amp(m[2])! });
  return out;
}

/** A words-only line that is plainly a breaker, read from what it says. */
function fromWords(t: string): DecodedBreaker | UnknownBreaker {
  const kind = kindOfWords(t);
  if (/\bQUAD(?:PLEX)?\b/.test(t)) {
    const pairs = pairsOfWords(t);
    const ones = pairs.filter((p) => p.poles === 1);
    const twos = pairs.filter((p) => p.poles === 2);
    if (pairs.length === 2 && ones.length === 1 && twos.length === 1) {
      return made(null, null, "quad", [one(1, ones[0].amps), one(1, ones[0].amps), one(2, twos[0].amps)]);
    }
    return { kind: "unknown", code: null, reason: "A Quad, But The Words Don't Say Which Poles And Amps Are Inside. Confirm." };
  }
  const amps = ampsOfWords(t);
  if (/\b(?:TWIN|TANDEM|DUPLEX)\b/.test(t)) {
    if (amps.length === 1) return made(null, null, "twin", [one(1, amps[0], kind), one(1, amps[0], kind)]);
    if (amps.length === 2) return made(null, null, "twin", [one(1, amps[0], kind), one(1, amps[1], kind)]);
    return { kind: "unknown", code: null, reason: "A Twin, But The Words Don't Say Its Amps. Confirm." };
  }
  // "SP 20/20A" with no code is a twin said another way.
  if (amps.length === 2 && /\b\d{2}\s*\/\s*\d{2}\s*A/.test(t) && polesOfWords(t) === 1) {
    return made(null, null, "twin", [one(1, amps[0], kind), one(1, amps[1], kind)]);
  }
  const poles = polesOfWords(t);
  const uniq = [...new Set(amps)];
  if (poles == null && uniq.length === 0) return { kind: "unknown", code: null, reason: "Doesn't Say Its Poles Or Amps. Confirm What It Is." };
  if (poles == null) return { kind: "unknown", code: null, reason: `Says ${uniq[0]}A But Not How Many Poles. Confirm.` };
  if (uniq.length === 0) return { kind: "unknown", code: null, reason: `Says ${poles}P But Not Its Amps. Confirm.` };
  if (uniq.length > 1) return { kind: "unknown", code: null, reason: `Names More Than One Size (${uniq.map((a) => `${a}A`).join(", ")}). Confirm.` };
  return made(null, null, poles === 1 ? "single" : "double", [one(poles, uniq[0], kind)]);
}

/** Do the words on the line disagree with what the code says is inside? (E-017's "SP 15A [Q120]".) */
function wordsDisagree(t: string, d: DecodedBreaker): string | null {
  const text = d.code ? t.replace(new RegExp(`\\b${d.code}\\b`, "g"), " ") : t;
  const sizes = new Set(d.slots.map((s) => s.amps));
  const bad = ampsOfWords(text).filter((a) => !sizes.has(a));
  const poles = polesOfWords(text);
  if (bad.length) return `The Words Say ${bad[0]}A, But ${d.code} Is ${d.words}. Confirm Which.`;
  if ((d.form === "single" || d.form === "double") && poles != null && poles !== d.slots[0].poles) {
    return `The Words Say ${poles}P, But ${d.code} Is ${d.words}. Confirm Which.`;
  }
  return null;
}

/**
 * Read one line (a bill line's description, a materials line's part number and description, a
 * shelf item's name) into a breaker, an unknown breaker, or not a breaker.
 */
export function decodeBreaker(...texts: (string | null | undefined)[]): BreakerReading {
  const raw = texts.filter((x) => x != null && String(x).trim()).join(" ");
  const t = raw.toUpperCase().replace(/[‘’“”"]/g, " ");
  if (!t.trim()) return { kind: "not_breaker", reason: "Nothing to read." };
  if (LOAD_CENTRE.test(t)) return { kind: "not_breaker", reason: "A Load Centre, Not A Breaker." };

  const tokens = t.split(/[^A-Z0-9-]+/).flatMap((w) => [w, w.replace(/-/g, "")]).filter(Boolean);
  const read = new Map<string, DecodedBreaker>();
  const unread = new Map<string, UnknownBreaker>();
  for (const tok of tokens) {
    const r = decodeCode(tok);
    if (!r) continue;
    if (r.kind === "breaker") read.set(r.code!, r);
    else unread.set(r.code!, r);
  }
  const breakerWord = BREAKER_WORD.test(t);
  if (!read.size && !unread.size) {
    if (!breakerWord && NOT_BREAKER.test(t)) return { kind: "not_breaker", reason: "Not A Breaker." };
    // Words only: a breaker when it says so, or says poles and amps with nothing else in the way.
    const saysSize = polesOfWords(t) != null && ampsOfWords(t).length > 0;
    if (!breakerWord && !(saysSize && !NOT_BREAKER.test(t)) && !/\b(?:TWIN|TANDEM|QUAD)\b.*\b\d{2}\s*A|\b\d{2}\s*A.*\b(?:TWIN|TANDEM|QUAD)\b/.test(t)) {
      return { kind: "not_breaker", reason: "Not A Breaker." };
    }
    return fromWords(t);
  }
  if (read.size + unread.size > 1) {
    const codes = [...read.keys(), ...unread.keys()];
    return { kind: "unknown", code: null, reason: `Names More Than One Part (${codes.join(", ")}). Confirm Which Came.` };
  }
  if (unread.size) return [...unread.values()][0];
  const d = [...read.values()][0];
  const disagree = wordsDisagree(t, d);
  if (disagree) return { kind: "unknown", code: d.code, reason: disagree };
  return d;
}

// ── WHAT TO ORDER ───────────────────────────────────────────────────────────────────────────────

/**
 * Which family a panel's brand words point to. Only words that NAME the family decide it: a
 * Homeline and a QO are both "Square D", a BR and a CH are both "Eaton" (or Cutler-Hammer), and
 * their breakers don't fit each other's panels. A bare "Square D" or "Eaton" is null here, so the
 * card falls back to what this job's tickets brought (familyOf) or orders by words and a person picks.
 */
export function brandOf(text: string | null | undefined): BrandKey | null {
  const t = String(text ?? "").toUpperCase();
  if (/\bSIEM(?:ENS)?\b|\bITE\b|\bMURRAY\b/.test(t)) return "siemens";
  if (/\bHOMELINE\b|\bHOM\b/.test(t)) return "square_d_homeline";
  if (/\bQO\b/.test(t)) return "square_d_qo";
  if (/\bBR\b/.test(t)) return "eaton_br";
  if (/\bCH\b/.test(t)) return "eaton_ch";
  if (/\bGE\b|\bGENERAL\s+ELECTRIC\b/.test(t)) return "ge";
  return null;
}

/** The plain single part to order for a missing pole group, in the panel's family: a 2P 20A is a
 *  Q220 in a Siemens box, a HOM220 in a Homeline. Only plain breakers: a GFCI or AFCI part number
 *  depends on the panel's neutral type, so those are ordered by their words and a person picks. */
export function partFor(slot: BreakerSlot, brand: BrandKey | null): string | null {
  if (slot.kind || !brand) return null;
  const n = `${slot.poles}${slot.amps}`;
  const code =
    brand === "siemens" ? `Q${n}` : brand === "square_d_homeline" ? `HOM${n}` : brand === "square_d_qo" ? `QO${n}` : brand === "eaton_br" ? `BR${n}` : brand === "eaton_ch" ? `CH${n}` : null;
  if (!code) return null;
  // Only a code this table reads back as exactly that breaker.
  const back = decodeCode(code);
  return back?.kind === "breaker" && back.slots.length === 1 && back.slots[0].poles === slot.poles && back.slots[0].amps === slot.amps && !back.slots[0].kind ? code : null;
}

/**
 * THE CODE TABLE THE ESTIMATOR'S PROMPT CARRIES (Generate From Line Items), written from the table
 * above so the prompt and the Breakers card can never disagree about what a Q2020 is.
 */
export function promptCodeTable(): string {
  const twins = Object.entries(SIEMENS_TWINS).map(([c, [a, b]]) => `${c} = twin (1-pole ${a}A + 1-pole ${b}A)`);
  const quads = Object.entries(SIEMENS_QUADS).map(([c, q]) => `${c} = quad (two 1-pole ${q.outer}A plus one 2P ${q.inner}A)`);
  const traps = Object.entries(SIEMENS_TWO_DOUBLES).map(([c, [a, b]]) => `${c} is NOT a quad with 1-poles, it is two 2P breakers (2P ${a}A + 2P ${b}A)`);
  return (
    "Breaker part numbers (read the size from the part, never guess it): " +
    "Siemens Q1xx = 1-pole xx amps (Q115 = 1P 15A, Q120 = 1P 20A), Q2xx = 2-pole (Q220 = 2P 20A, Q230 = 2P 30A, Q250 = 2P 50A, Q2100 = 2P 100A), QF = GFCI, QA/QAF = AFCI; " +
    `${twins.join(", ")}; ${quads.join(", ")}; ${traps.join("; ")}. ` +
    "Square D: HOM120 / QO120 = 1P 20A, HOM230 = 2P 30A, HOMT1515 = twin (two 1P 15A), HOMT230250 = two 2P breakers (2P 30A + 2P 50A). " +
    "Eaton: BR120 / CH120 = 1P 20A. GE: THQL1120 = 1P 20A, THQL2130 = 2P 30A. " +
    "A load centre (PN1632L1125C, 12/24CT 125A) is not a breaker. " +
    "A twin or quad is several circuits in one part: count each pole group as its own circuit. "
  );
}
