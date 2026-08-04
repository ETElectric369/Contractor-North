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
  | { type: "select"; options: string[]; multi?: boolean }
  | { type: "text"; long?: boolean };

/** One condition. ALL of a need's clauses must hold for it to apply. */
export type Clause =
  | { key: string; in: string[] } // membership — matches a scalar OR any member of a multi-select
  | { key: string; known: true }; // just needs any answer at all

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
   * The contractor's own reason, in his own words. FUEL, NEVER FURNITURE — it is what the model
   * reads to know when and how to ask, and what the cold renderer shows as a one-line hint. This
   * is the part that makes a playbook *his* rather than ours.
   */
  why?: string;
  /** "Don't let me price without this." */
  hold?: boolean;
  /** A calculator may consume this → the provenance gate applies (see acceptFill). */
  measured?: boolean;
  /** Answerable from a picture. */
  photo?: boolean;
}

export interface Playbook {
  needs: Need[];
}

export type AnswerValue = string | number | boolean | string[] | null;
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
