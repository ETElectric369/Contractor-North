/**
 * WHAT DO I OWE, AND WHAT DID I BUY. TWO QUESTIONS, TWO FUNCTIONS, ONE PLACE EACH (8a982483).
 *
 * ── THE BUG, IN HIS WORDS ───────────────────────────────────────────────────────────────────────
 *
 *   "I'm seeing inconsistencies with the amount it's saying I owe to CED, at the bottom it says
 *    10k in open bills it at the top it says 5k but online it's saying a different number that's
 *    lower"
 *
 * Three figures for one pile of money, and he was right to stop believing the screen. They were
 * never answering the same question, and nothing on the page said so.
 *
 * ── WHY NO PREDICATE FIX COULD EVER HAVE CLOSED IT ─────────────────────────────────────────────
 *
 * cn-v1031 taught ONE reader that a ticket the supplier's own closed papers cover is settled. It
 * was the right rule and it reached one door of four, because the deeper fault is not the
 * predicate at all: THE TWO FIGURES WERE LOOKING AT DIFFERENT PAPERS.
 *
 *   · the top figure reached its papers by joining through `bills.supplier_account_id`
 *   · the bottom figure reached its papers by grouping `bills.supplier` FREE TEXT
 *
 * Measured on his book: 119 bills, 43 distinct supplier spellings, and only 50 of the 119 carry
 * `supplier_account_id` at all. So 69 papers were reachable by one figure and invisible to the
 * other. Two totals built from two different sets of paper cannot be made to agree by sharpening
 * a filter, and every attempt to do it by filter is why this has been fixed three times.
 *
 * ── SO: ONE IDENTITY, THEN TWO QUESTIONS ───────────────────────────────────────────────────────
 *
 * PART 3 first, because the other two stand on it. A paper finds its supplier by IDENTITY, never
 * by spelling: the account it is filed on, then an alias somebody created, then the account's own
 * name normalised. `supplierAccountForPaper` is the only place that decides, and a paper it cannot
 * place is NOT dropped - it keeps its typed-in name, it stays in the money, and the screen says
 * how many papers are not on an account yet with a door to put them on one.
 *
 * Then the two questions, and they are genuinely different questions:
 *
 *   (a) WHAT DO I OWE THIS SUPPLIER.  `whatISupplierOwed`
 *       A DEBT. The supplier is the truth about its own balance. Where we hold their papers the
 *       figure is theirs; where we do not it falls back to our own open tickets less what we have
 *       sent them. It never counts a ticket their own closed paper covers, never a statement
 *       beside the invoices it repeats, never a superseded copy.
 *
 *   (b) WHAT DID I BUY AND NOT SETTLE YET.  `whatIBoughtNotSettled`
 *       NOT A DEBT. Our own open tickets, every spelling, on an account or not. A purchasing
 *       figure - what has been bought on account and not yet squared - which is a useful thing to
 *       know and a dangerous thing to call "Unpaid" next to a balance.
 *
 * After this they are still two numbers, and that is correct: they answer two questions. What
 * changed is that the screen says which is which, (a) leads, and neither is built from a predicate
 * written at the door that reads it.
 *
 * ── bills.status IS NOT TOUCHED, AND CANNOT ANSWER (a) ─────────────────────────────────────────
 *
 * `bills.status` says HOW a thing was bought - on the account, or settled at the register on the
 * spot - and never whether the supplier has since been paid. Applying a supplier's open list
 * closes the SUPPLIER'S documents (`supplier_invoices.closed`) and writes no bill, which is the
 * correct asymmetry and the reason every on-account ticket read "Unpaid" forever. The fix is in
 * the reading. Nothing here writes a bill.
 *
 * Every function in this file is pure and rounds to the cent at the point it sums, the rule
 * lib/invoice-math.ts and supplier-balance.ts already hold: a card, a workbook tab and a sentence
 * Nort says have to agree to the penny or the app is arguing with itself.
 *
 * NOTHING HERE KNOWS A SUPPLIER'S NAME. Every rule is about shape - a stored id, an alias
 * somebody made, a normalised string - so it holds for a plumber's wholesaler and a deck builder's
 * lumber yard exactly as it holds for an electrical distributor.
 */

import { aliasKey, normalizeSupplierName } from "@/lib/supplier-identity";

/** To the cent, at the point of summation. A local copy of supplier-balance's `r2` so this module
 *  imports nothing that imports it back: supplier-balance.ts calls `isStillOwed` below, and a
 *  cycle between the two files is the kind of thing that loads as `undefined` in one bundle and
 *  works in the other. The rule is three characters long and identical in both. */
const r2 = (n: number) => Math.round((Number.isFinite(n) ? n : 0) * 100) / 100;

const money = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

// ────────────────────────────────────────────────────────────────────────────────────────────────
// PART 3 - A PAPER FINDS ITS SUPPLIER BY IDENTITY, NEVER BY SPELLING
// ────────────────────────────────────────────────────────────────────────────────────────────────

/** How a paper was placed on an account. The screen may say this out loud; a figure he can check
 *  has to be able to explain which papers it gathered and why. */
export type SupplierIdentityHow =
  /** `bills.supplier_account_id`. Somebody filed it, by hand or at the scan. Strongest. */
  | "filed"
  /** An exact `supplier_aliases` row - which exists because a person pressed something. */
  | "alias"
  /** The account's OWN name, normalised: punctuation, legal forms and brackets set aside. */
  | "name";

export interface SupplierPaperIdentity {
  /** The account this paper belongs to, or NULL for one not on an account yet. */
  accountId: string | null;
  how: SupplierIdentityHow | null;
  /** The typed-in spelling, trimmed, exactly as he would recognise it on the row. */
  spelling: string;
  /**
   * WHERE THIS PAPER'S MONEY LIVES, always. An account id, or a spelling key, or the one group
   * below for a paper carrying no supplier name at all. Never "", because "" is how a bill used to
   * fall out of a figure with nothing on screen saying it had.
   */
  group: string;
}

/**
 * THE PAPERS WITH NO SUPPLIER NAME TYPED IN, as a group with a name of its own.
 *
 * `/bills` used to do `if (!alias) continue;` here, and that one line is a small version of this
 * whole bug: the paper left the Suppliers card's total silently while All Bills went on counting
 * it, so the two halves of one screen disagreed by exactly those rows with nothing to read about
 * it. A paper with no name is a thing he needs to go and look at, which is the opposite of a
 * reason to hide it.
 */
export const NO_SUPPLIER_NAME_GROUP = "\u0000no-supplier-name";

/** What the screen calls that group. Title Case, his words, no glossary. */
export const NO_SUPPLIER_NAME_LABEL = "No Supplier Name On The Paper";

export interface SupplierIdentityIndex {
  /** aliasKey(alias) -> account id. The exact string, which is what the database is unique on. */
  byAlias: ReadonlyMap<string, string>;
  /** normalizeSupplierName(account name) -> account id. Ambiguous keys are absent, see below. */
  byName: ReadonlyMap<string, string>;
  /** Names that two or more accounts normalise to, so a screen can say why one did not resolve. */
  ambiguousNames: ReadonlySet<string>;
}

/**
 * THE INDEX, BUILT ONCE PER READ instead of scanned per paper.
 *
 * THE NAME STEP IS EXACT, NOT FUZZY, AND THAT IS THE WHOLE JUDGEMENT IN THIS FILE.
 *
 * supplier-identity.ts draws a line it is worth keeping: `aliasKey` is exact and "decides what
 * gets written", `suggestSupplierGroups` is fuzzy and "only ever a suggestion". Deciding where a
 * dollar is counted is deciding. So the name step is EQUALITY on `normalizeSupplierName` - the
 * same string with punctuation folded, "Inc." dropped, brackets set aside and "Dist." expanded to
 * "Distributors", which are facts about the abbreviation rather than guesses about the company.
 * Nothing is scored, nothing is ranked, and initials are NOT matched: a name that merely looks
 * related stays off the account, keeps its own row, and gets the door. The suggester still offers
 * the merge, and that is where a judgement about two companies belongs - on a button he presses.
 *
 * TWO ACCOUNTS NORMALISING TO ONE KEY RESOLVE NOTHING. Picking one would silently move a supplier's
 * money onto another supplier's balance, which is worse than an unfiled row, so the key is dropped
 * and both papers show as not on an account yet - visible, counted, and answerable.
 */
export function indexSupplierIdentity(input: {
  accounts?: readonly { id?: unknown; name?: unknown }[] | null;
  aliases?: readonly { alias?: unknown; supplier_account_id?: unknown }[] | null;
}): SupplierIdentityIndex {
  const byAlias = new Map<string, string>();
  for (const a of input?.aliases ?? []) {
    const key = aliasKey(String(a?.alias ?? ""));
    const id = String(a?.supplier_account_id ?? "");
    // First one wins; `unique (org_id, lower(alias))` means there should never be a second.
    if (key && id && !byAlias.has(key)) byAlias.set(key, id);
  }

  const byName = new Map<string, string>();
  const ambiguousNames = new Set<string>();
  for (const a of input?.accounts ?? []) {
    const id = String(a?.id ?? "");
    const key = normalizeSupplierName(String(a?.name ?? ""));
    if (!id || !key) continue;
    const seen = byName.get(key);
    if (seen && seen !== id) {
      byName.delete(key);
      ambiguousNames.add(key);
      continue;
    }
    if (!ambiguousNames.has(key)) byName.set(key, id);
  }

  return { byAlias, byName, ambiguousNames };
}

/** The three fields identity is decided on. Named in this shape, camelCase, so a caller holding a
 *  raw PostgREST row has to do the mapping rather than cast past it - the lesson
 *  `InvoiceBalanceShape` was written for, where a snake_case field slipped through a cast and a
 *  part-paid invoice read as fully owed. */
export interface SupplierPaperRef {
  id: string;
  /** `bills.supplier_account_id`. */
  supplierAccountId?: string | null;
  /** `bills.supplier`, the free text the scanner wrote. */
  supplier?: string | null;
}

/**
 * WHICH SUPPLIER THIS ONE PAPER BELONGS TO. The only function in the app that decides.
 *
 * Order, strongest first, and each step is a fact somebody or something recorded rather than a
 * resemblance: the account it is filed on, an alias a person created, the account's own name.
 */
export function supplierAccountForPaper(
  paper: Pick<SupplierPaperRef, "supplierAccountId" | "supplier">,
  index: SupplierIdentityIndex | null | undefined,
): SupplierPaperIdentity {
  const spelling = String(paper?.supplier ?? "").trim();
  const filed = String(paper?.supplierAccountId ?? "").trim();
  if (filed) return { accountId: filed, how: "filed", spelling, group: filed };

  const key = aliasKey(spelling);
  const byAlias = key ? index?.byAlias.get(key) : undefined;
  if (byAlias) return { accountId: byAlias, how: "alias", spelling, group: byAlias };

  const nameKey = normalizeSupplierName(spelling);
  const byName = nameKey ? index?.byName.get(nameKey) : undefined;
  if (byName) return { accountId: byName, how: "name", spelling, group: byName };

  // Not on an account yet. It keeps its own name and its own group, and it is still money.
  return { accountId: null, how: null, spelling, group: key || NO_SUPPLIER_NAME_GROUP };
}

/** Every paper resolved in one pass: paper id -> who it belongs to. What a reader looping over a
 *  ledger actually wants, and the only thing the covering walk below will gate on. */
export function resolveSupplierPapers(
  papers: readonly SupplierPaperRef[] | null | undefined,
  index: SupplierIdentityIndex | null | undefined,
): Map<string, SupplierPaperIdentity> {
  const out = new Map<string, SupplierPaperIdentity>();
  for (const p of papers ?? []) {
    const id = String(p?.id ?? "");
    if (!id) continue;
    out.set(id, supplierAccountForPaper(p, index));
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// THE ONE STILL-OWED TEST
// ────────────────────────────────────────────────────────────────────────────────────────────────

/** The fields the still-owed test reads, and nothing else. */
export interface StillOwedShape {
  /** `bills.status`: 'unpaid' is on account, 'paid' is settled at the register on the spot. */
  status?: string | null;
  /** Set aside as another paper's duplicate. Either spelling of the same fact. */
  superseded?: boolean | null;
  supersededByBillId?: string | null;
  /**
   * The supplier's own books call this one settled - every document of theirs that covers it is
   * closed, and none is still open. Computed by `supplierCoverage`, never stored, never a column.
   */
  settledBySupplier?: boolean | null;
}

/**
 * IS THIS PAPER STILL OWED. The single expression, and the only one allowed in the tree - there is
 * a test that fails if any file outside this module writes it again.
 *
 * It was written three times before this (`isOpenBill`, `isOnAccountBill`, and inline on the
 * suppliers card), each knowing a different subset of the three facts, which is how the same ticket
 * could be settled on one line of a screen and owed on the next.
 *
 * THE LEAN IS DELIBERATE and it is `isOnAccountBill`'s: anything not explicitly 'paid' counts as
 * owed. A null status, a typo, a status some later migration adds should all surface as money he
 * may still owe and be argued with on screen, never quietly leave a figure and make the number he
 * is trusting too small.
 */
export function isStillOwed(paper: StillOwedShape | null | undefined): boolean {
  if (!paper) return false;
  if (paper.superseded || paper.supersededByBillId) return false;
  if (String(paper.status ?? "").toLowerCase() === "paid") return false;
  return !paper.settledBySupplier;
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// THE ONE COVERING WALK
// ────────────────────────────────────────────────────────────────────────────────────────────────

/** One document the supplier itself issued, as this walk reads it. */
export interface CoveringDocumentRef {
  id: string;
  supplierAccountId?: string | null;
  /** An applied open list closed it: the supplier says this one is settled. */
  closed?: boolean | null;
}

export interface SupplierCoverage {
  /** Every live paper at least one of its own supplier's documents covers, however. */
  covered: ReadonlySet<string>;
  /**
   * Papers every covering document of their own supplier calls CLOSED, and none calls open. These
   * are settled in the supplier's books whatever `bills.status` says, and they are the double
   * count Erik was looking at: counted once inside the supplier's closed paper and once again as
   * an unpaid ticket.
   */
  settledBySupplier: ReadonlySet<string>;
}

/**
 * WHICH PAPERS THE SUPPLIER'S OWN DOCUMENTS COVER, AND WHICH OF THOSE THEY CALL SETTLED.
 *
 * ONE WALK, replacing four: `/bills` built `coveredBillIds` itself, `supplier-papers.ts` built the
 * settled set, `owner-money.ts` built a third for the P&L card - with no alias index, so the P&L
 * and `/bills` could disagree about which ticket covered which paper on identical rows - and the
 * invoice-number parse was run twice over the same columns to feed two of them.
 *
 * A document covers a paper by being LINKED to it (the Record button, `bill_supplier_invoices`) or
 * by having its number read off the paper's own lines, and only when the paper belongs to THAT
 * document's supplier - so a number belonging to another supplier can never mark a paper covered.
 *
 * THE GATE IS IDENTITY, NOT THE STORED COLUMN, and that one change is what makes this reach. Every
 * earlier copy compared `bills.supplier_account_id` to the document's account, so a paper on no
 * account could never be found covered and never be found settled - which is 69 of his 119 papers,
 * and exactly the pile cn-v1031 could not get to.
 */
export function supplierCoverage(input: {
  documents?: readonly CoveringDocumentRef[] | null;
  /** paper id -> who it belongs to, from `resolveSupplierPapers`. */
  identity: ReadonlyMap<string, SupplierPaperIdentity>;
  /** document id -> paper ids linked to it by the Record button. */
  linked?: ReadonlyMap<string, ReadonlySet<string> | readonly string[]> | null;
  /** document id -> paper ids carrying its number on their own lines. */
  carrying?: ReadonlyMap<string, ReadonlySet<string> | readonly string[]> | null;
  /** The live papers, so a superseded or register-settled one is never called settled. */
  papers?: readonly (SupplierPaperRef & StillOwedShape)[] | null;
}): SupplierCoverage {
  const covered = new Set<string>();
  const closedCover = new Set<string>();
  const openCover = new Set<string>();

  const accountOf = (paperId: string) => input.identity.get(paperId)?.accountId ?? null;

  for (const d of input?.documents ?? []) {
    const docId = String(d?.id ?? "");
    const account = String(d?.supplierAccountId ?? "");
    if (!docId || !account) continue;
    const reach = new Set<string>();
    for (const id of input?.linked?.get(docId) ?? []) reach.add(String(id));
    for (const id of input?.carrying?.get(docId) ?? []) reach.add(String(id));
    for (const paperId of reach) {
      if (!paperId || accountOf(paperId) !== account) continue;
      covered.add(paperId);
      (d?.closed === true ? closedCover : openCover).add(paperId);
    }
  }

  const settledBySupplier = new Set<string>();
  for (const p of input?.papers ?? []) {
    const id = String(p?.id ?? "");
    if (!id) continue;
    // A duplicate set aside, or a ticket paid at the register, is not "settled by the supplier" -
    // it was never in a balance for them to settle. Saying so would put a second sentence on a row
    // that already has a true one.
    if (p?.superseded || p?.supersededByBillId) continue;
    if (String(p?.status ?? "").toLowerCase() === "paid") continue;
    if (closedCover.has(id) && !openCover.has(id)) settledBySupplier.add(id);
  }

  return { covered, settledBySupplier };
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// QUESTION (b) - WHAT DID I BUY AND NOT SETTLE YET
// ────────────────────────────────────────────────────────────────────────────────────────────────

export interface BoughtNotSettled {
  /** THE FIGURE. A purchasing figure. NOT a debt - see the label below. */
  total: number;
  papers: number;
  ids: string[];
}

/**
 * THE WORDS FOR QUESTION (b), AND THEY MATTER AS MUCH AS THE ARITHMETIC.
 *
 * The accountant's workbook already had the only honest label in the tree - "Bills North Has
 * Marked Unpaid" - which says WHOSE claim it is and does not call it a debt. Everywhere else said
 * "Unpaid" or "Owed" beside a supplier balance, and a bare "$10,000 Unpaid" over "$5,000 Owed" is
 * the screen telling a man he owes two different amounts.
 */
export const BOUGHT_NOT_SETTLED_LABEL = "Bought On Account, Not Squared Up Yet";

/**
 * QUESTION (b): WHAT DID I BUY AND NOT SETTLE YET.
 *
 * Our own open tickets, every spelling, on an account or not. What this is FOR: he has bought
 * materials on account and not yet squared them, and that is worth seeing whether or not a
 * supplier has billed him for it.
 *
 * WHAT IT DELIBERATELY IS NOT: a debt. It is built from our paperwork, not theirs. A supplier may
 * have billed one of these already, or billed it on a statement with four others, or never billed
 * it at all - which is why it is a different number from (a) and must never be labelled as if it
 * were the same one.
 *
 * WHAT IT DELIBERATELY EXCLUDES: a superseded duplicate, a ticket settled at the register, and a
 * ticket the supplier's own closed papers cover. That last one is the exclusion that was missing
 * everywhere but one component, and it is Erik's double count: the same materials counted once
 * inside the supplier's closed paper and once again here.
 */
export function whatIBoughtNotSettled(input: {
  papers?: readonly (SupplierPaperRef & StillOwedShape & { amount?: unknown })[] | null;
  /** From `supplierCoverage`. Absent means not checked, and nothing is excluded on a guess. */
  settledBySupplier?: ReadonlySet<string> | null;
}): BoughtNotSettled {
  let total = 0;
  const ids: string[] = [];
  for (const p of input?.papers ?? []) {
    const id = String(p?.id ?? "");
    if (!id) continue;
    if (!isStillOwed({ ...p, settledBySupplier: p?.settledBySupplier || input?.settledBySupplier?.has(id) }))
      continue;
    total = r2(total + money(p?.amount));
    ids.push(id);
  }
  return { total, papers: ids.length, ids };
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// QUESTION (a) - WHAT DO I OWE THIS SUPPLIER
// ────────────────────────────────────────────────────────────────────────────────────────────────

/** The words for question (a). The workbook's tab had them right first: it names whose claim the
 *  figure is, which is the one thing that makes it checkable against a portal. */
export const SUPPLIER_OWED_LABEL = "Owed To Suppliers";

/** How one line's figure was reached, so a screen or a workbook column can say it per row. */
export type SupplierOwedHow =
  /** Model B. Their own open papers. Checkable line by line against their portal. */
  | "their-own-papers"
  /** Model A. Our open tickets less what we have sent them. Right until they tell us otherwise. */
  | "my-tickets-less-payments"
  /** No account at all: our open tickets under the name the scanner typed. */
  | "my-tickets-no-account";

export interface SupplierOwedLine {
  /** The account id, or "" for a pile of papers that is not on an account yet. */
  accountId: string;
  /** What he calls them, or the spelling the scanner typed. */
  name: string;
  /** What this supplier is owed. Never negative here - a credit goes to `ahead`. */
  owed: number;
  how: SupplierOwedHow;
  /** How many of our own open tickets sit behind it (0 under model B is normal and fine). */
  papers: number;
  /** False for a vendor paid at the register, which has no running balance. */
  onAccount: boolean;
}

export interface NotOnAnAccount {
  /** How many papers are not on a supplier account yet. Zero means no badge. */
  papers: number;
  /** Their money. It IS inside `total` - see the doc comment. */
  total: number;
  /** How many distinct typed-in spellings that is, for the door's sentence. */
  spellings: number;
  /** How many of them carry no supplier name at all, which is a different errand. */
  unnamed: number;
}

export interface WhatISupplierOwed {
  /**
   * THE ONE NUMBER. What he owes his suppliers, all of them, right now. This is the figure that
   * leads the card, the figure the workbook totals, and the figure Nort says out loud, and they
   * are the same figure because they all call this function.
   */
  total: number;
  /** Supplier by supplier, biggest first. Only ones actually owed something. */
  lines: SupplierOwedLine[];
  notOnAnAccount: NotOnAnAccount;
  /**
   * Suppliers he is ahead at. A credit at one supplier does not pay another, so this is NOT
   * subtracted from `total` - it is a fact beside it, which is the same rule model B uses for
   * payments and for the same reason.
   */
  ahead: { accountId: string; name: string; credit: number }[];
  /** Accounts whose figure could not be worked out because a read failed. Named, never guessed. */
  couldNotTotal: { accountId: string; name: string }[];
}

/** One account's figure as `supplierBalance` already produced it. Passed IN rather than recomputed:
 *  that function is the one place model A and model B live, it has a test named after the
 *  $1,360.93 it exists to never produce again, and a second copy of it here would be this whole
 *  bug with a new file name. `supplier-pay-due.ts` has always done it this way. */
export interface SupplierAccountFigure {
  accountId: string;
  name: string;
  onAccount: boolean;
  /** `supplierBalance().owed`. NULL for a register supplier with no papers, or an unread balance. */
  owed: number | null;
  /** `supplierBalance().model`. */
  model: "supplier-invoices" | "bills-minus-payments";
  /** How many of our own open tickets are filed there, for the line's sentence. */
  openPapers?: number;
  /** True when one of the reads behind this figure failed, so it must not be totalled or zeroed. */
  unread?: boolean;
}

/**
 * QUESTION (a): WHAT DO I OWE MY SUPPLIERS. THE ONE-NUMBER ANSWER.
 *
 * THE SUPPLIER IS THE TRUTH ABOUT ITS OWN OPEN BALANCE. Where we hold an account's own papers the
 * figure is theirs, to the cent, checkable against their portal (model B). Where we do not, it
 * falls back to our own open tickets less what we have sent them (model A). Where there is no
 * account at all, it falls back to our own open tickets under the name the scanner typed.
 *
 * WHAT IT DELIBERATELY EXCLUDES, and this is the list the old total got wrong:
 *
 *   · A TICKET THEIR OWN CLOSED PAPER COVERS. Model B already excludes it by construction - their
 *     closed document is not in their open balance - and model A now excludes it too, through
 *     `isStillOwed`. Counting it was the live double count: his biggest single ticket sat inside a
 *     closed supplier paper AND in the unpaid pile.
 *   · A STATEMENT BESIDE THE INVOICES IT REPEATS. Under model B a statement and its invoices are
 *     the supplier's own rows and the supplier does not double-count them. Under model A a
 *     statement covered by their paper drops out through the covering walk.
 *   · A SUPERSEDED DUPLICATE, always and everywhere.
 *   · A VOIDED PAYMENT, which never came off anything (`supplierBalance` holds that rule).
 *   · A CREDIT AT ANOTHER SUPPLIER. Being ahead at one does not pay the next, so `ahead` is
 *     reported beside the total and never inside it.
 *
 * WHAT IT DOES NOT HIDE: a paper on no account is in `total`, under its own typed-in name, and
 * `notOnAnAccount` carries the count, the money and the spellings so the screen can say it in one
 * sentence with a door on it. The alternative was the old behaviour - the money quietly in a figure
 * built two different ways - and the one before that was dropping it, which is worse.
 */
export function whatISupplierOwed(input: {
  /** One per supplier account, already totalled by `supplierBalance`. */
  accounts?: readonly SupplierAccountFigure[] | null;
  /** Every live paper in the book, so the ones on no account can be gathered by identity. */
  papers?: readonly (SupplierPaperRef & StillOwedShape & { amount?: unknown })[] | null;
  /** From `resolveSupplierPapers`: who each paper belongs to. */
  identity: ReadonlyMap<string, SupplierPaperIdentity>;
  /** From `supplierCoverage`. */
  settledBySupplier?: ReadonlySet<string> | null;
}): WhatISupplierOwed {
  const lines: SupplierOwedLine[] = [];
  const ahead: WhatISupplierOwed["ahead"] = [];
  const couldNotTotal: WhatISupplierOwed["couldNotTotal"] = [];
  let total = 0;

  // ── OUR OWN OPEN TICKETS, GATHERED BY IDENTITY ────────────────────────────────────────────
  // One pass, one rule. A paper lands on the account it RESOLVES to - filed, aliased or named -
  // which is why the account pile and the loose pile can no longer be two different sets of paper.
  const openOnAccount = new Map<string, { total: number; papers: number }>();
  const loose = new Map<string, { name: string; total: number; papers: number; unnamed: boolean }>();
  for (const p of input?.papers ?? []) {
    const id = String(p?.id ?? "");
    if (!id) continue;
    const settled = p?.settledBySupplier || input?.settledBySupplier?.has(id);
    if (!isStillOwed({ ...p, settledBySupplier: settled })) continue;
    const who = input.identity.get(id) ?? supplierAccountForPaper(p, null);
    const amount = money(p?.amount);
    if (who.accountId) {
      const g = openOnAccount.get(who.accountId) ?? { total: 0, papers: 0 };
      g.total = r2(g.total + amount);
      g.papers += 1;
      openOnAccount.set(who.accountId, g);
      continue;
    }
    const g = loose.get(who.group) ?? {
      name: who.spelling || NO_SUPPLIER_NAME_LABEL,
      total: 0,
      papers: 0,
      unnamed: !who.spelling,
    };
    g.total = r2(g.total + amount);
    g.papers += 1;
    loose.set(who.group, g);
  }

  // ── THE ACCOUNTS ──────────────────────────────────────────────────────────────────────────
  for (const a of input?.accounts ?? []) {
    const accountId = String(a?.accountId ?? "");
    if (!accountId) continue;
    const name = String(a?.name ?? "");
    const open = openOnAccount.get(accountId) ?? { total: 0, papers: 0 };
    openOnAccount.delete(accountId);

    if (a?.unread) {
      couldNotTotal.push({ accountId, name });
      continue;
    }

    // A register supplier with no papers of its own has no running balance, and a zero would read
    // as "paid up" - a different sentence and not a true one. Its open tickets are still money, so
    // they are counted as what they are: our own tickets, on a supplier that keeps no balance.
    if (a?.owed === null || a?.owed === undefined) {
      if (open.total > 0.005) {
        lines.push({
          accountId,
          name,
          owed: open.total,
          how: "my-tickets-no-account",
          papers: open.papers,
          onAccount: !!a?.onAccount,
        });
        total = r2(total + open.total);
      }
      continue;
    }

    const owed = r2(Number(a.owed));
    if (owed < -0.005) {
      ahead.push({ accountId, name, credit: r2(-owed) });
      continue;
    }
    if (owed <= 0.005) continue;
    lines.push({
      accountId,
      name,
      owed,
      how: a.model === "supplier-invoices" ? "their-own-papers" : "my-tickets-less-payments",
      papers: a?.openPapers ?? open.papers,
      onAccount: !!a?.onAccount,
    });
    total = r2(total + owed);
  }

  // An account the caller did not hand us a figure for, but which papers resolved onto. Not
  // droppable: the money is real and the row has to exist for the total to be checkable.
  for (const [accountId, open] of openOnAccount) {
    if (open.total <= 0.005) continue;
    lines.push({
      accountId,
      name: "",
      owed: open.total,
      how: "my-tickets-no-account",
      papers: open.papers,
      onAccount: false,
    });
    total = r2(total + open.total);
  }

  // ── THE PAPERS NOT ON AN ACCOUNT YET ──────────────────────────────────────────────────────
  let notOnTotal = 0;
  let notOnPapers = 0;
  let unnamed = 0;
  for (const [, g] of loose) {
    if (g.total <= 0.005 && g.papers === 0) continue;
    notOnTotal = r2(notOnTotal + g.total);
    notOnPapers += g.papers;
    if (g.unnamed) unnamed += g.papers;
    lines.push({
      accountId: "",
      name: g.name,
      owed: g.total,
      how: "my-tickets-no-account",
      papers: g.papers,
      onAccount: false,
    });
    total = r2(total + g.total);
  }

  lines.sort((x, y) => y.owed - x.owed || x.name.localeCompare(y.name));

  return {
    total,
    lines,
    notOnAnAccount: {
      papers: notOnPapers,
      total: notOnTotal,
      spellings: [...loose.keys()].filter((k) => k !== NO_SUPPLIER_NAME_GROUP).length,
      unnamed,
    },
    ahead,
    couldNotTotal,
  };
}

/**
 * ONE SENTENCE ABOUT THE PAPERS THAT ARE NOT ON AN ACCOUNT YET, for the card, the workbook and
 * Nort to say the same way. Plain words, no glossary, and it never appears when there is nothing
 * to say - zero means no sentence, the same rule every badge in this app follows.
 */
export function notOnAnAccountSentence(n: NotOnAnAccount | null | undefined, formatMoney: (v: number) => string): string | null {
  if (!n || n.papers <= 0) return null;
  const papers = `${n.papers} ${n.papers === 1 ? "paper" : "papers"}`;
  const unnamed = n.unnamed > 0 ? ` ${n.unnamed} of them ${n.unnamed === 1 ? "has" : "have"} no supplier name on it at all.` : "";
  return `${formatMoney(n.total)} of this is on ${papers} that are not on a supplier account yet, counted under the name on the paper.${unnamed}`;
}
