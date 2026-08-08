/**
 * READ A SOURCE, PROPOSE ITEMS, LET HIM TICK. One pipeline, whatever the source is.
 *
 * Erik, after I offered to read a home-inspection PDF and hand back a tick-list:
 * "yes and that approach seems like it would work for more than just reading a pdf."
 *
 * He's right, and it's the more valuable framing — the PDF is one adapter, not the feature. The
 * app ALREADY ships every ingest this needs: `organize/actions.ts` sends images and PDFs to the
 * model as content blocks, and `hearIntoPlaybook` sends a spoken paragraph. What was missing is a
 * SHAPE they all produce, so the surface that reviews them doesn't care where they came from.
 *
 *   a home-inspection report   → the defects that are yours
 *   a photo of a panel         → what's in it
 *   a photo of a whiteboard    → the punch list somebody wrote at the job
 *   a customer's email         → what they actually asked for
 *   a spoken paragraph         → the same, out loud (this one already exists)
 *   a supplier quote           → the line items to bring in
 *
 * ── THE LAW THAT MAKES THIS SAFE ────────────────────────────────────────────────────────────
 *
 * EVERY PROPOSAL CARRIES WHERE IT CAME FROM, verbatim. This is the provenance gate that already
 * governs spoken fills (`Fill.heard`), applied to reading: a model that can point at page 18 and
 * quote "LOOSE OUTLET / LIVING ROOM" is reporting; one that can't is inventing. The `from` field
 * is not decoration — it is the thing a human checks in two seconds, and it is what makes a
 * tick-list reviewable instead of a wall of plausible sentences.
 *
 * NOTHING COMMITS ON ITS OWN. A proposal is an offer. The same law as everywhere else in this
 * app: filling is not executing, and the human's hand is never overwritten.
 */

/** Where a proposal came from — the half a human checks. */
export interface Provenance {
  /** Human-locatable: "page 18", "item 5.1.1", "photo 2", "0:42", "paragraph 3". */
  where: string;
  /** The source's OWN words. Never a paraphrase — a paraphrase can't be checked. */
  quote: string;
}

export type ProposalKind =
  /** A piece of work — becomes a scope pick / an estimate line. */
  | "scope"
  /** An answer to one of the playbook's questions. Carries `key`. */
  | "answer"
  /** Worth knowing, prices nothing. Goes to the notes. */
  | "note";

export interface Proposal {
  /** Stable within one read, so ticking survives a re-render. */
  id: string;
  kind: ProposalKind;
  /** What it says, in one line, for the tick-list. */
  text: string;
  /** For `answer` proposals — the playbook need this fills. */
  key?: string;
  from: Provenance;
  /**
   * THE SAME THING, SAID TWICE BY THE SOURCE. Sara Cain's report lists "LIGHT DID NOT TURN ON /
   * MULTIPLE LOCATIONS" as item 5.1.1 on page 18 AND as 8.1.1 on page 32, in two different
   * sections. Estimating straight off the report bills that twice. Set to the id it duplicates so
   * the surface can show it beside its twin. It is a PROMPT TO CHECK, never a suppression — see
   * defaultTicked for what real data did to the stronger version of this idea.
   */
  duplicateOf?: string;
}

const clean = (v: unknown, max: number): string => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

const norm = (v: string): string => v.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

/**
 * FINGERPRINT THE SOURCE'S WORDS, NOT OURS.
 *
 * First cut hashed the model's one-line `text`, and against the real Sara Cain report it caught
 * NOTHING — the same defect filed as 5.1.1 and 8.1.1 came back worded two different ways, because
 * a paraphrase is free to vary and did. The QUOTE cannot: it is the document repeating itself,
 * which is the actual signal. Fall back to the text only when a quote is too short to mean
 * anything on its own ("CRACKED TRIM" appears under several unrelated items).
 */
const fingerprint = (p: { kind: string; text: string; from: { quote: string } }): string => {
  const q = norm(p.from.quote);
  return `${p.kind}:${q.length >= 25 ? q : norm(p.text)}`;
};

/**
 * Validate what the model returned. A proposal WITHOUT provenance is dropped, not shown — the
 * whole reason a tick-list is trustworthy is that every row can be checked against the source, and
 * one unattributed row poisons the rest.
 */
export function coerceProposals(raw: unknown): Proposal[] {
  const list = (raw as { items?: unknown } | null)?.items ?? raw;
  if (!Array.isArray(list)) return [];
  const out: Proposal[] = [];
  const byPrint = new Map<string, string>();

  for (const r of list) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const text = clean(o.text, 300);
    const where = clean((o.from as Record<string, unknown> | undefined)?.where ?? o.where, 80);
    const quote = clean((o.from as Record<string, unknown> | undefined)?.quote ?? o.quote, 400);
    // NO PROVENANCE, NO ROW. Not a warning, not a flag — gone.
    if (!text || !where || !quote) continue;

    const kind: ProposalKind = o.kind === "answer" ? "answer" : o.kind === "note" ? "note" : "scope";
    const id = `p${out.length + 1}`;
    const print = fingerprint({ kind, text, from: { quote } });
    const first = byPrint.get(print);
    if (!first) byPrint.set(print, id);

    out.push({
      id,
      kind,
      text,
      ...(kind === "answer" && clean(o.key, 60) ? { key: clean(o.key, 60) } : {}),
      from: { where, quote },
      ...(first ? { duplicateOf: first } : {}),
    });
    if (out.length >= 120) break;
  }
  return out;
}

/**
 * EVERYTHING STARTS TICKED, INCLUDING A SUSPECTED DUPLICATE.
 *
 * The first version unticked duplicates automatically, and running it against the real 49-page
 * report showed why that is the wrong default: of five folds, THREE were wrong. Home-inspection
 * reports reuse boilerplate — "Contact flooring contractor to restretch carpet." is word-for-word
 * identical under the upstairs carpet AND the primary bedroom carpet, which are two real jobs in
 * two rooms. Same for three separate doors that all "may need adjustment to latch properly".
 *
 * So the match is a QUESTION, not a verdict. And the two failure directions are not equal: a
 * double-billed line gets spotted when he reads his own estimate; a line silently unticked is work
 * that vanishes and gets discovered when it isn't done. Never silently drop what the source said —
 * flag it, show both locations, and let him untick the one that's really a repeat.
 */
export const defaultTicked = (ps: Proposal[]): Set<string> => new Set(ps.map((p) => p.id));

export const duplicateCount = (ps: Proposal[]): number => ps.filter((p) => p.duplicateOf).length;

/**
 * WHAT NORT IS ASKED TO DO WITH A SOURCE. Deliberately narrow: pull out what's THERE, attribute
 * every line, and never price anything — pricing is the contractor's, and a model that guesses a
 * number here would be laundering a guess through a document.
 */
export const READ_SYSTEM =
  "You are reading a source a contractor attached to a job — an inspection report, a photo of a " +
  "panel or a whiteboard, an email, a supplier quote — and pulling out the items that might " +
  "become work.\n\n" +
  "RETURN ONLY JSON: { \"items\": [ { \"kind\", \"text\", \"key\", \"from\": { \"where\", \"quote\" } } ] }\n\n" +
  "  kind   'scope' = a piece of work someone could be paid to do.\n" +
  "         'answer' = it answers one of the questions listed below; put that question's key in " +
  "`key`.\n" +
  "         'note' = worth knowing, prices nothing (an access code, a hazard, a constraint).\n" +
  "  text   ONE line, in plain trade words. What it is and where in the building.\n" +
  "  from   where: how a person finds it — \"page 18, item 5.1.1\", \"photo 2\", \"0:42\".\n" +
  "         quote: the source's OWN WORDS for it. Never your paraphrase.\n\n" +
  "THE RULES, AND THE FIRST ONE IS THE WHOLE JOB:\n" +
  "- EVERY ITEM MUST CARRY A REAL `where` AND A REAL `quote`. If you cannot point at where it came " +
  "from and quote it, DO NOT RETURN IT. An item you cannot attribute is one you invented, and it " +
  "will be dropped anyway.\n" +
  "- NEVER PRICE ANYTHING. No dollar amounts, no hours, no quantities you weren't given. The " +
  "contractor prices his own work; your job is to find the work.\n" +
  "- LIST A THING TWICE IF THE SOURCE DOES. Reports repeat the same defect across sections. Return " +
  "both with their own locations — the duplicate gets folded downstream, and that is a decision " +
  "for the person, not for you.\n" +
  "- DO NOT FILTER BY TRADE. Return everything you find. Which items are his is his call, and a " +
  "guess about scope is how a real item goes missing.\n" +
  "- Say nothing about what the source does not contain.";
