/**
 * A PLAYBOOK — what a contractor must end up KNOWING before he can price a job.
 *
 * Erik: "there has to be a turnkey way we can have a set of questions each person wants its
 * inspector to ask it or use as a playbook and have the inspector collect whats needed when its
 * needed and process it in a way the contractor wants, each one will be different of course and
 * drastically."
 *
 * ── THE SHIFT ───────────────────────────────────────────────────────────────────────────────
 *
 * The shipped sheet is a list of QUESTIONS. A playbook is a list of NEEDS — facts that must be
 * known — and a question is only ONE route to a fact. The others are: a sentence somebody said,
 * a number somebody measured, a photo, or a value inherited from the lead.
 *
 * That single change is what fixes the failure Erik hit at 13125 Moraine Rd. He arrived and said,
 * in one breath, that he was adding outlets and lights in a storage room being converted to living
 * space, the homeowner was permitting it for occupancy, the main panel was far and the meter panel
 * was close with two open slots. NINE FACTS, unprompted. The sheet asked him for the panel brand,
 * because a fixed list asks its list regardless of what has already been said.
 *
 * A need that is already satisfied is never asked. That is the whole product.
 *
 * ── WHO / WHAT / WHERE / WHY ────────────────────────────────────────────────────────────────
 *
 * Every job is those four, and they behave differently, which is why one shape has to carry all
 * of them:
 *
 *   WHERE  a place.    Structured — four columns since 0177. Deterministic, inheritable.
 *   WHO    a link.     Structured — an id on a lead, customer or job. Deterministic, inheritable.
 *   WHAT   the work.   SOMETIMES a pick (Chris: "New deck". Andrew: which trades he's subbing),
 *                      sometimes a paragraph (Erik's storage room, which is not a category and
 *                      never will be). This is where static-vs-dynamic actually lives.
 *   WHY    the reason. ALWAYS a sentence, and always the multiplier on everything else.
 *
 * WHY is the one the app has never asked for, and it is the one that changes every other answer.
 * "Converting storage to living space, permitted for occupancy" is not a note — it reclassifies
 * the room. It drags receptacle spacing, AFCI, smoke/CO and a rough-inspection hold point before
 * cover into a job that otherwise reads as two circuits. Priced without it, the second trip simply
 * isn't in the number.
 *
 * ── STATIC vs DYNAMIC IS DERIVED, NOT DECLARED ──────────────────────────────────────────────
 *
 * `slot` present → a typed control; cold, offline, deterministic.
 * `slot` absent  → OPEN; the model phrases it, and it renders NOTHING while empty.
 *
 * Nobody ticks a "dynamic" box. Chris's playbook is closed because he answered every need with a
 * control; Erik's is open because it contains sentences no control can hold. A closed playbook
 * never mounts an interview and never issues a fetch — which is the guarantee that a model is
 * nowhere near Chris's arithmetic.
 */

export type NeedSlot =
  | { type: "number"; unit?: string }
  /**
   * OPTIONS, PLUS A WAY TO SAY THE THING NOBODY LISTED.
   *
   * Erik: "so like you prompt me with options then a 'other' box i use often as you can see,
   * something like that" — said right after answering a three-option question of mine by ignoring
   * all three and typing a paragraph into Other. Which is the point: the options carry the common
   * case at one tap, and the box carries the job.
   *
   * This is also the fix for his standing complaint about gated questions — "it makes those gated
   * questions a wall to everything else i could possibly say in the scope." A fixed option list
   * with no exit IS a wall: every answer the author didn't foresee is unsayable, so the honest
   * ones get forced into the nearest wrong chip. `other` turns the wall into a door, and it costs
   * a tap only when the listed answers are wrong.
   *
   * With `other`, coerceNeed stops rejecting values outside `options` — see it there for why that
   * is a deliberate loosening of the tamper check and not a hole.
   */
  | { type: "select"; options: string[]; multi?: boolean; other?: boolean }
  | { type: "text"; long?: boolean }
  /**
   * FILES — plans, drawings, photos. The answer is a list of storage PATHS (so it fits the existing
   * `string[]` AnswerValue with no new shape), never URLs: a URL in an answer would be a bearer
   * token pasted into a jsonb column, and these live in a private bucket read through short-lived
   * signed links.
   *
   * Andrew (Vivian Builders, beta): "add a conditional field — 'Do you have plans already?'
   * (Yes/No). When Yes, reveal an 'Upload your plans' file-upload button (PDF, JPG, PNG, DWG),
   * optional, hidden by default, multiple files allowed, 100MB cap for large plan sets."
   *
   * The conditional half needed nothing new — that is what `when` already does. This is the half
   * that was missing.
   */
  | { type: "file"; accept?: string[]; multi?: boolean; maxMb?: number }
  /**
   * PICK MANY SCOPES FROM YOUR OWN PRICE LIST AND PRICE EACH ONE HERE. The second pricing shape —
   * see lib/playbook/scopes.ts for why it exists and why it is general rather than a deck feature.
   *
   * `codes` narrows the menu to a family (Chris's R1–R8 remodel scopes); omit it and the whole
   * price list is offered. The answer is a ScopePick[] and it maps 1:1 onto quote lines.
   */
  | { type: "scopes"; codes?: string[] };

/** One condition. ALL of a need's clauses must hold for it to apply. */
export type Clause =
  | { key: string; in: string[] } // membership — matches a scalar OR any member of a multi-select
  | { key: string; known: true } // just needs any answer at all
  /**
   * The NEGATIVE, and it is what makes "derive it, or else ask it" expressible.
   *
   * Erik: "i dont necessarily want it to never ask me an outlet count, thats important and if it
   * cant be resolved from the info then its an appropriate question."
   *
   * That corrects a rule I wrote too absolutely. The law was never "never ask X" — it is DON'T ASK
   * WHAT IS ALREADY RESOLVED. A receptacle count derived from wall feet under 210.52(A) should not
   * be asked. The same count with no room dimensions on the record is a perfectly fair question,
   * and refusing to ask it just loses the number.
   *
   * So a need can be gated on another being ABSENT: ask the count only when the room wasn't
   * measured. The moment the measurements arrive it stops applying, and clearInapplicable nulls
   * what was guessed — the derived value wins, and it wins without anybody choosing.
   */
  | { key: string; unknown: true };

/**
 * The five feeders. Which of them a need serves — and it is genuinely PLURAL.
 *
 * "Is anybody pulling a permit, and for what?" feeds WHY (the reason the room is being
 * reclassified), WHEN (a rough-inspection hold point before cover — an entire second
 * mobilisation) and WHAT (AFCI, receptacle spacing, smoke/CO). A singular field would erase
 * exactly the property that makes WHY worth building: the multiplier IS a need with more than
 * one tag.
 */
export type Dimension = "who" | "what" | "where" | "when" | "why";

export interface Need {
  key: string;
  /** The cold renderer's label. Short. */
  label: string;
  /**
   * THE SENTENCE — what actually gets asked, out loud or on screen. Required.
   *
   * ET's sheet had a field labelled "Panel". That is not a question; it transmits nothing about
   * the answer wanted, which is why Erik typed `2` into it and then `2` again into the next box.
   */
  ask: string;
  /** Present = a typed control. ABSENT = open: phrased by the model, invisible until answered. */
  slot?: NeedSlot;
  /** ALL must hold. Every clause must name a need declared ABOVE this one — no cycles, one pass. */
  when?: Clause[];
  /**
   * WHERE THE ANSWER ENDS UP IN THE PRICE — one line, in his words. See lib/playbook/why.ts.
   *
   * FUEL, NEVER FURNITURE: the model reads it to know when and how to ask, and the cold renderer
   * shows it as a one-line hint under the question. This is the part that makes a playbook *his*
   * rather than ours.
   *
   * ONE LINE IS THE WHOLE DISCIPLINE. Erik, on reading his own first drafts: "anyone including
   * myself reviewing these proposed why lines is automatically confused as fuck." Everything longer
   * than a breath belongs in `note`.
   */
  why?: string;
  /**
   * THE REST OF HIS VOICE. Everything true about this question that isn't the destination — the
   * war story, the code section, the reason it must not be asked too early.
   *
   * It exists because the alternative was DELETING his words to make the line readable, and his
   * words are the entire asset. Nort reads a note like it reads a why; a human only sees it if they
   * open the question in Settings. It never appears on a job and it is never spoken in the tour.
   */
  note?: string;
  /** "Don't let me price without this." */
  hold?: boolean;
  /** A calculator may consume this → the provenance gate applies (see acceptFill). */
  measured?: boolean;
  /** Answerable from a picture. */
  photo?: boolean;

  /**
   * WHICH OF THE FIVE THIS SERVES. Plural — see Dimension.
   *
   * Not taxonomy. Three mechanical payoffs:
   *  1. THE TAG IS THE SOCKET. A `where` answer writes the four address columns; `when` writes a
   *     schedule segment; `who` writes a link. An untagged need can only ever produce prose —
   *     which is precisely the fate of every WHY this app has ever recorded.
   *  2. IT LETS A NEED BE PRE-RESOLVED INSTEAD OF ASKED. See `resolvedFrom`.
   *  3. ORDERING FOR FREE. WHERE and WHO are knowable at first contact, WHAT needs a visit, WHEN
   *     needs WHAT, and WHY gates all of them because it changes WHAT's quantities. Tags sort the
   *     ask-list; nobody has to model edges.
   */
  feeds?: Dimension[];

  /**
   * A path on the record that may ALREADY answer this — "inquiry.address", "appointment.starts_at".
   *
   * This is the actual Moraine Rd failure, stated as a field. The sheet did not ask a wrong
   * question; it asked its whole list regardless of the nine facts Erik had already said out loud.
   * A need with a resolvedFrom is checked against what is known BEFORE it is rendered, and only
   * the genuinely unresolved ones reach the screen.
   *
   * That is the entire difference between a form and an assistant, and it is one field.
   */
  resolvedFrom?: string;
}

export interface Playbook {
  needs: Need[];
}

/** A chosen-and-priced scope; see lib/playbook/scopes.ts. Structurally declared here (rather than
 *  imported) so `types.ts` stays the leaf every other playbook module hangs off. */
export interface ScopePickValue {
  code: string;
  qty: number;
  price: number;
}

export type AnswerValue = string | number | boolean | string[] | ScopePickValue[] | null;
export type Answers = Record<string, AnswerValue>;

/**
 * A value Nort proposes for a need.
 *
 * `heard` is the load-bearing field: for anything a calculator will consume, it must be the exact
 * substring of the transcript the value came from, and the number must literally appear in it.
 * That is what forbids the model computing a perimeter in its head and handing it over as if
 * somebody had measured it.
 */
export interface Fill {
  key: string;
  value: AnswerValue;
  /** The words this came from, verbatim. Required for any `measured` need. */
  heard?: string;
}
