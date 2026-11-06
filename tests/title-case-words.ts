/**
 * TITLE CASE = THE SIGNIFICANT WORDS, in both languages (Erik: Spanish cn-v1147 after the RAE's Diccionario panhispánico de
 * dudas — "Ministerio de Asuntos Sociales"; English cn-v1148 after Chicago 8.159–8.160 and Apple's style guide — "Back to
 * Schedule", "Who's on the Clock"). In a clickable or a title the function words stay lowercase, except as the first word of a
 * segment (a separator · — – / ( & starts one) and, in English, as the last word of one (Chicago capitalizes the last word; a
 * colon, semicolon, question or exclamation mark ends an English segment: "No Job: A Reminder for Me").
 *
 *   SPANISH: every preposition, article and conjunction (the RAE's rule has no length limit) — ES_FUNCTION_WORDS. A {slot} is
 *   simply not there, the way the Spanish catalogs were cased ("Poner a {name} en un Trabajo").
 *   ENGLISH: the articles (a, an, the), the coordinating conjunctions (and, but, or, nor), "as", and the prepositions of four
 *   letters or fewer (at, by, for, from, in, into, of, on, onto, over, per, to, via, vs, with) — EN_FUNCTION_WORDS. A particle
 *   is not a preposition and stays capital: Set Up, Clock Out, Take Off ("up", "out", "off", "down" are never function words),
 *   and "in", "on", "by", "over" right after the verb they make a phrasal verb with (EN_PHRASAL: Sign In, Turn On, Stand By,
 *   Roll Over), the object between allowed (Turn It On). Two particles joined stay capital ("In and Out", "On and Off"). An "A"
 *   after a head noun is a name, not an article (Phase A, Panel A, Schedule A — EN_NAME_HEADS). A value with no lowercase letter
 *   at all (SCOPE OF WORK, a document's heading) is not Title Case and is judged word by word, as before. A {slot} is a word of
 *   its own: the words around it are mid-title ("Log {hours}h on This Job"). A quoted bit is one thing and passes.
 *
 * One list and one rule for every check that judges it: tests/words-parity.test.ts (the catalogs), tests/title-case.test.ts
 * (every door in the app) and the per-screen tests that re-check their own doors (titleCaseIn / esTitleCase / enTitleCase).
 * titleCaseOf is the same rule as a transform — it lowercases what must be lowercase and never capitalizes — so a value the
 * judge passes is its own titleCaseOf; the cn-v1148 sweep was it, run over every English Title Case string in the app.
 */
export type TitleLang = "en" | "es";

/** A fragment cut by a computed hole: its first word may be mid-title (openStart — the scanner's "(tail)"), or its last may
 *  be (openEnd — the scanner's "(head)": "Billed by Hand on {inv}"). */
export type TitleOpen = { openStart?: boolean; openEnd?: boolean };

export const ES_FUNCTION_WORDS: ReadonlySet<string> = new Set(
  "a al de del el la los las un una unos unas y e o u en con por para sin como lo desde hasta sobre entre hacia según tras ante bajo contra durante mediante que ni pero".split(" "),
);

export const EN_FUNCTION_WORDS: ReadonlySet<string> = new Set(
  "a an the and but or nor as at by for from in into of on onto over per to via vs with".split(" "),
);

/** "in", "on", "by", "over" after one of these verbs is a particle (Sign In, Turn On, Stand By, Roll Over), not a preposition. */
export const EN_PHRASAL: Readonly<Record<string, ReadonlySet<string>>> = {
  in: new Set("sign log clock check punch opt cash money trade zoom fill dial lock plug tune call phone weigh bring pull step drop hand turn key type count tap buy lean break chime join swipe come".split(" ")),
  on: new Set("turn log sign carry hang catch switch power plug".split(" ")),
  by: new Set("stand stop pass come swing get".split(" ")),
  over: new Set("roll carry start hand take turn pass do go win run flip switch move tip look think".split(" ")),
};
/** The object or adverb a phrasal verb may hold between its verb and its particle: Turn It On, Sign Back In, Clock Back In Now. */
const EN_OBJECTS: ReadonlySet<string> = new Set("it them this that me us one him her these those everything something back again right".split(" "));
/** Particles that stay capital when joined ("In and Out", "On and Off", "Up and Down"). */
const EN_PARTICLES: ReadonlySet<string> = new Set("in on up out off down over by".split(" "));
/** An "A" after one of these is a name, not an article: Phase A, Panel A, Plan A, Schedule A. */
export const EN_NAME_HEADS: ReadonlySet<string> = new Set(
  "phase panel grade option column section side unit building room leg bus team class exhibit appendix zone tier series version wing lot circuit feeder bay".split(" "),
);

const HOLE = "\u0001";
/** A period after one of these closes an abbreviation, not a segment ("Paid vs. Owed", "Sq. Ft."). */
const EN_ABBREVIATIONS: ReadonlySet<string> = new Set("vs no st sq ft in inc dist jr sr mr mrs ms dr ave blvd rd ct apt ste".split(" "));
const SEPARATOR = /^[·—–&\/|+]+$/;

type Word = { ti: number; at: number; piece: string; core: string; lower: string; segStart: boolean; segEnd: boolean; hole: boolean };

/** The words of a value, each with its place: the token it sits in, whether it opens or closes a segment, whether it is a
 *  hole (a quoted bit, or in English a {slot}). */
function tokenize(s: string, lang: TitleLang, open: TitleOpen): { out: string[]; words: Word[]; holes: string[] } {
  const holes: string[] = [];
  const masked = s.replace(/“[^”]*”|"[^"]*"|‘[^’]*’|\{\w+\}/g, (m) => `${HOLE}${holes.push(m) - 1}${HOLE}`);
  const out = masked.split(/(\s+)/);
  const words: Word[] = [];
  let segStart = !open.openStart;
  const closeLast = () => {
    if (words.length) words[words.length - 1].segEnd = true;
  };
  for (let ti = 0; ti < out.length; ti++) {
    const tok = out[ti];
    if (!tok || /^\s+$/.test(tok)) continue;
    if (SEPARATOR.test(tok)) {
      segStart = true;
      closeLast();
      continue;
    }
    const pieces = tok.split("/");
    let at = 0; // where this piece begins inside its token
    for (let p = 0; p < pieces.length; p++) {
      const piece = pieces[p];
      if (p > 0) at += pieces[p - 1].length + 1;
      // "Sí/No": a "/" inside a word splits two words, and the second starts a segment of its own.
      if (p > 0) {
        segStart = true;
        closeLast();
      }
      if (!piece) continue;
      if (/^\.\p{L}/u.test(piece)) {
        // ".vcf": a file's extension is a name, not a word — it passes, and it counts as a word ("Import a .vcf").
        words.push({ ti, at, piece, core: piece, lower: piece.toLowerCase(), segStart, segEnd: false, hole: true });
        segStart = false;
        continue;
      }
      if (/^[(¿¡]/.test(piece)) {
        segStart = true;
        closeLast();
      }
      const lead = piece.match(/^[^\p{L}\p{N}\u0001]*/u)![0];
      const core = piece.slice(lead.length).replace(/[^\p{L}\p{N}\u0001]+$/u, "");
      if (!core) {
        // a colon or question mark standing alone ("{n}: For Your Accountant") ends an English segment too
        if (lang === "en" && /[:;?!.]/.test(piece)) {
          segStart = true;
          closeLast();
        }
        continue;
      }
      const hole = core.includes(HOLE);
      // A Spanish {slot} is simply not there (the rule its catalogs were cased by): neither a word nor a boundary.
      if (hole && lang === "es" && holes[Number(core.replace(/\u0001/g, ""))]?.startsWith("{")) continue;
      const trail = piece.slice(lead.length + core.length);
      const segEnd = lang === "en" && (/[:;?!]/.test(trail) || (trail.startsWith(".") && !EN_ABBREVIATIONS.has(core.toLowerCase())));
      words.push({ ti, at: at + lead.length, piece, core, lower: core.toLowerCase(), segStart, segEnd, hole });
      segStart = segEnd;
    }
  }
  if (words.length && !open.openEnd) words[words.length - 1].segEnd = true;
  return { out, words, holes };
}

/** Whether words[k] is a function word that the rule governs — in English, one that is not a particle, a name's "A" or half
 *  of "In and Out". */
function isFunctionWord(words: readonly Word[], k: number, lang: TitleLang): boolean {
  const w = words[k];
  if (w.hole) return false;
  if (lang === "es") return ES_FUNCTION_WORDS.has(w.lower);
  if (!EN_FUNCTION_WORDS.has(w.lower)) return false;
  const nb = (i: number) => (i >= 0 && i < words.length && !words[i].hole ? words[i] : null);
  const at = (i: number) => nb(i)?.lower ?? "";
  // A function word written in capitals beside a word in capitals is part of a shouted phrase (a bank's "ONLINE TRANSFER TO
  // CHK", a province "Toronto, ON M4W"), not a title's function word.
  const shout = (x: Word | null) => !!x && x.core.length > 1 && /\p{L}/u.test(x.core) && x.core === x.core.toUpperCase();
  const shoutPrev = shout(w.segStart ? null : nb(k - 1));
  const shoutNext = shout(w.segEnd ? null : nb(k + 1));
  // a one-letter "A" is an article beside one word in capitals ("Not a PO", "for a Q22020CT") and a shout only between two
  if (w.core === w.core.toUpperCase() && (w.core.length > 1 ? shoutPrev || shoutNext : shoutPrev && shoutNext)) return false;
  // "A" after a number is a unit (15 A), not an article.
  if ((w.lower === "a" || w.lower === "an") && /^\p{N}/u.test(nb(k - 1)?.core ?? "")) return false;
  const prev = w.segStart ? "" : at(k - 1);
  const prev2 = w.segStart || (k > 0 && words[k - 1].segStart) ? "" : at(k - 2);
  const next = w.segEnd ? "" : at(k + 1);
  const next2 = w.segEnd || (k + 1 < words.length && words[k + 1].segEnd) ? "" : at(k + 2);
  if (EN_PHRASAL[w.lower]?.has(prev)) return false;
  if (EN_OBJECTS.has(prev) && EN_PHRASAL[w.lower]?.has(prev2)) return false;
  if ((w.lower === "a" || w.lower === "an") && EN_NAME_HEADS.has(prev)) return false;
  if (EN_PARTICLES.has(w.lower)) {
    if ((next === "and" || next === "or") && EN_PARTICLES.has(next2)) return false;
    if ((prev === "and" || prev === "or") && EN_PARTICLES.has(prev2)) return false;
  }
  return true;
}

/** The first word that breaks the rule — or null when every word keeps it. */
export function titleCaseOffender(s: string, lang: TitleLang = "en", open: TitleOpen = {}): string | null {
  const shout = lang === "en" && !/\p{Ll}/u.test(s); // a heading in capitals (SCOPE OF WORK) is not Title Case: word by word
  const { words } = tokenize(s, lang, open);
  for (let k = 0; k < words.length; k++) {
    const w = words[k];
    if (w.hole) continue;
    const lower = /^\p{Ll}/u.test(w.core);
    if (!shout && isFunctionWord(words, k, lang)) {
      if (open.openStart && k === 0) continue; // a tail's first word: the scanner cannot tell whether it is mid-title
      if (w.segStart || (lang === "en" && w.segEnd)) {
        if (lower) return w.piece;
        continue;
      }
      if (!lower) return w.piece;
      continue;
    }
    if (lower) return w.piece;
  }
  return null;
}

/** Whether a value keeps the rule in its language. */
export const titleCaseIn = (s: string, lang: TitleLang = "en", open: TitleOpen = {}): boolean => titleCaseOffender(s, lang, open) === null;

/** The Spanish rule alone, for a test that checks only its Spanish words. */
export const esTitleCase = (s: string): boolean => titleCaseIn(s, "es");
/** The English rule alone. */
export const enTitleCase = (s: string): boolean => titleCaseIn(s, "en");

/** The rule as a transform: the function words that must be lowercase, made lowercase; nothing is ever capitalized, a
 *  quoted bit and a {slot} are kept as they are, and a heading in capitals is returned unchanged. */
export function titleCaseOf(s: string, lang: TitleLang = "en", open: TitleOpen = {}): string {
  if (lang === "en" && !/\p{Ll}/u.test(s)) return s;
  const { out, words, holes } = tokenize(s, lang, open);
  for (let k = 0; k < words.length; k++) {
    const w = words[k];
    if (w.hole || !isFunctionWord(words, k, lang)) continue;
    if (w.segStart || (lang === "en" && w.segEnd)) continue;
    // A fragment that opens after a hole and starts with "A": the hole may be a number and the "A" its unit ("{amps} A
    // Breaker"); the judge takes either case there, and the transform leaves it.
    if (open.openStart && k === 0 && (w.lower === "a" || w.lower === "an")) continue;
    if (w.core === w.lower) continue;
    out[w.ti] = out[w.ti].slice(0, w.at) + w.lower + out[w.ti].slice(w.at + w.core.length);
  }
  return out.join("").replace(/\u0001(\d+)\u0001/g, (_, n) => holes[Number(n)]);
}
