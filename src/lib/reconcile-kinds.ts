/**
 * THE KINDS OF DISAGREEMENT — THE CASE SPACE, WITH TEETH ON IT (Erik, 2026-10-01).
 *
 * ── ERIK'S LAW FOR THIS PAGE, VERBATIM ────────────────────────────────────────────────────────
 *
 *   "reconcile is the bottom fold filling in dots not controlling systems, a peace maker"
 *
 * Every row on Reconcile is ONE sentence: TWO RECORDS THAT SHOULD AGREE, AND DO NOT. Not a grab
 * bag. If a thing is not that sentence it does not belong on the page, and the way to keep that
 * true a year from now is to make the sentence a TYPE: a kind cannot exist until somebody writes
 * down what the two records are, what the section is called, which anchor it carries, and — the
 * part Erik's law turns on — WHERE THE PRESS HAPPENS.
 *
 * ── WHY A TYPED EXHAUSTIVE RECORD AND NOT ONE OF THE OTHER TWO PATTERNS ───────────────────────
 *
 * This repository has three proven ways to make a rule impossible to bypass:
 *
 *   (1) A TYPED EXHAUSTIVE RECORD, so a new case will not compile. THIS ONE. The kinds of
 *       disagreement genuinely ARE a case space — a closed list of named situations, each needing
 *       its own words, its own count and its own door — which is exactly the shape a Record keyed
 *       by a union catches. Add a member to `ReconcileKind` and nothing compiles until all four
 *       are written down; add one that is answered HERE and `ReconcileOpenCounts` will not compile
 *       until the read counts it, so a kind cannot ship with no number and no badge.
 *
 *   (2) An app rule with a SQL twin. There is nothing to twin: no SQL function computes any of
 *       this, and the money figures belong to lib/supplier-owed.ts, which this page only READS.
 *
 *   (3) A bypass tripwire. There is one of those too, and it lives beside its siblings in
 *       lib/supplier-owed-one-place.test.ts: Reconcile may not compute a supplier figure itself.
 *       The two are complementary — the Record governs the SHAPE of the page, the tripwire governs
 *       where its NUMBERS come from.
 *
 * ── THE BADGE, AND WHY IT COUNTS KINDS ───────────────────────────────────────────────────────
 *
 * The badge invariant (lib/action-items/types.ts, pinned by tests/badge-economy.test.ts) says a
 * number on chrome is distinct items needing a HUMAN DECISION TODAY and that "no count may be the
 * length of an unbounded or undated set". A reconcile pile is undated and unbounded by
 * construction — twenty-six papers under five spellings wait as long as nobody sorts them — so
 * `badges["/reconcile"] = 26` would be the exact thing that invariant exists to stop.
 *
 * So the badge is a ROLLUP, the way the no-job hours line already is (action-items/
 * no-job-hours-item.ts: "every shift rides inside ONE line, however old, so the badge moves by
 * one"): it counts HOW MANY KINDS have anything open. Bounded by construction at the size of this
 * union, zero drawing nothing. Each kind's own count is plain text in its heading on the page,
 * where the deciding happens — never a dock number.
 *
 * ── AND A KIND ANSWERED SOMEWHERE ELSE CAN NEVER BADGE ───────────────────────────────────────
 *
 * Erik's law 2: Reconcile never becomes the only door to an action. A kind whose press belongs to
 * the screen that owns the record is a LINK here, and a link is not a call to act — so
 * `answeredOn` is not documentation, it is the badge's gate. `ReconcileOpenCounts` is keyed by the
 * kinds answered HERE and nothing else can get into the number.
 */

/** Every kind of disagreement Reconcile draws. One member per section. */
export type ReconcileKind =
  /** Their own open papers against our own open tickets, per supplier. READ-ONLY plus a link. */
  | "supplier-gap"
  /** The supplier's closed paper covers a bill of ours that is still open (0383). Answered on the bill. */
  | "they-call-it-paid"
  /** Several spellings that look like one account. */
  | "supplier-names"
  /** A spelling the matcher will not rule on: a typo, or a second company. A person decides. */
  | "same-supplier-or-two"
  /** A paper STILL OPEN with no supplier account at all. A settled one is not a disagreement. */
  | "not-on-an-account"
  /** The same supplier ticket filed to two jobs. */
  | "same-ticket-two-jobs";

/** The kinds a person presses a button on HERE. The badge is counted over these and no others. */
export type ReconcileAnsweredHere = Exclude<ReconcileKind, "supplier-gap" | "they-call-it-paid">;

/**
 * Where the press happens. `"here"` means Reconcile carries the control; the other shape means the
 * screen that OWNS the record carries it and Reconcile draws a link — never a second copy.
 */
export type ReconcileDoor = "here" | { screen: string; href: string };

export interface ReconcileKindDef {
  /** The section's heading, Title Case, in his words. */
  heading: string;
  /** The anchor the section carries, and the thing another page links to. */
  anchor: string;
  /** THE SENTENCE. What our record says, and what the other record says. Never a bare number. */
  ours: string;
  theirs: string;
  /** Where the button is. "here" badges; anywhere else is a link and cannot badge (law 2). */
  answeredOn: ReconcileDoor;
  /** Reading order down the page. The money reading leads; the decisions follow. */
  order: number;
}

/**
 * EVERY KIND, WITH ITS WORDS AND ITS DOOR. A new member of the union above does not compile until
 * it has a row here.
 */
export const RECONCILE_KINDS: Record<ReconcileKind, ReconcileKindDef> = {
  "supplier-gap": {
    heading: "What You Bought, And What They Say You Owe",
    anchor: "supplier-gap",
    ours: "Your own tickets, still bought on account and not squared up",
    theirs: "What that supplier's own papers say is still open",
    // The figures are owned by lib/supplier-owed.ts and the place you record a payment or edit an
    // account is the Suppliers card. Reconcile reads; it does not re-rule.
    answeredOn: { screen: "Suppliers", href: "/bills#suppliers" },
    order: 1,
  },
  "they-call-it-paid": {
    // ONE NUMBER PER BILL (0383): a bill is paid when its own number says so. The supplier's closed
    // paper over a bill still open here is the one place the two books disagree about a bill, and
    // the doors that settle it write the number: Mark Paid on the bill, or Record A Payment with
    // that bill's box checked. Neither press lives here.
    heading: "They Call It Paid, Your Bill Is Open",
    anchor: "they-call-it-paid",
    ours: "A bill of yours with money still open on it",
    theirs: "The supplier's own paper covering it, which they have closed",
    answeredOn: { screen: "Bills", href: "/bills" },
    order: 2,
  },
  "supplier-names": {
    heading: "Supplier Names That Look Like One Account",
    anchor: "supplier-names",
    ours: "Several spellings off your receipts, each carrying its own money",
    theirs: "One supplier account they should all be filed on",
    answeredOn: "here",
    order: 3,
  },
  "same-supplier-or-two": {
    heading: "Same Supplier, Or Two?",
    anchor: "same-supplier-or-two",
    ours: "A spelling off a receipt the matcher will not rule on",
    theirs: "An account that may be the same company, or may not",
    answeredOn: "here",
    order: 4,
  },
  "not-on-an-account": {
    // THE PILE IS PAPERS, NOT NAMES, and that word is the whole fix. Named by its spellings, the
    // section listed thirty-three register purchases already settled and already categorised and
    // offered to open a supplier account with each one, while /bills' door above it said "1 Bill".
    // A paper paid at the till has ONE record and belongs in neither.
    heading: "Papers Not On A Supplier Account Yet",
    anchor: "not-on-an-account",
    ours: "A paper still open, under the name typed on it",
    theirs: "No supplier account holding the other half of it",
    answeredOn: "here",
    order: 5,
  },
  "same-ticket-two-jobs": {
    heading: "The Same Ticket On Two Jobs",
    anchor: "same-ticket-two-jobs",
    ours: "One job's costs, carrying this ticket",
    theirs: "Another job's costs, carrying the very same ticket",
    answeredOn: "here",
    order: 6,
  },
};

/**
 * THE KINDS ANSWERED HERE, as a list. Written out rather than derived from `answeredOn` so the two
 * cannot drift silently: reconcile-kinds.test.ts asserts this list is exactly the set of kinds
 * whose door is "here", so a kind moved to another screen (or brought back) fails a test instead
 * of quietly joining or leaving the badge.
 */
export const RECONCILE_ANSWERED_HERE = [
  "supplier-names",
  "same-supplier-or-two",
  "not-on-an-account",
  "same-ticket-two-jobs",
] as const satisfies readonly ReconcileAnsweredHere[];

/**
 * HOW MANY ROWS OF EACH KIND ARE OPEN. Keyed by the kinds answered HERE, exhaustively: a new kind
 * with its door on this page will not compile until the read says how it is counted.
 */
export type ReconcileOpenCounts = Record<ReconcileAnsweredHere, number>;

/** Nothing open, anywhere. The starting point for a read, and a fresh company's answer. */
export const NO_DISAGREEMENTS: ReconcileOpenCounts = {
  "supplier-names": 0,
  "same-supplier-or-two": 0,
  "not-on-an-account": 0,
  "same-ticket-two-jobs": 0,
};

/** The kinds with anything open, in page order. A kind with nothing open draws nothing. */
export function openKindsHere(counts: ReconcileOpenCounts): ReconcileAnsweredHere[] {
  return RECONCILE_ANSWERED_HERE.filter((k) => (counts[k] ?? 0) > 0).sort(
    (a, b) => RECONCILE_KINDS[a].order - RECONCILE_KINDS[b].order,
  );
}

/**
 * THE BADGE. How many KINDS of disagreement have anything open — never how many rows, which is an
 * undated, unbounded set the badge invariant forbids on chrome. Bounded at the size of the union,
 * and zero draws nothing (the dock hides a 0 already).
 */
export function reconcileBadge(counts: ReconcileOpenCounts): number {
  return openKindsHere(counts).length;
}

/** How many rows are waiting, all kinds together. Plain text on the page, never a badge. */
export function reconcileRowsWaiting(counts: ReconcileOpenCounts): number {
  return RECONCILE_ANSWERED_HERE.reduce((n, k) => n + Math.max(0, counts[k] ?? 0), 0);
}
