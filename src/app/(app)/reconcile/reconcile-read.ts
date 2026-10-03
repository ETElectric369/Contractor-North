/**
 * WHAT RECONCILE READS — ONE PLACE, TWO CALLERS (cn-v1037).
 *
 * The page draws these piles; the dock's badge counts them. If those two reached the rows two
 * different ways the badge would eventually say 3 over a page showing 2, which is the fault
 * tests/badge-economy.test.ts calls "the never-disagree doctrine". So there is ONE read, and the
 * badge calls it with no figures — it needs membership, not money.
 *
 * ── IT OWNS NOTHING ───────────────────────────────────────────────────────────────────────────
 *
 * Erik: "reconcile is the bottom fold filling in dots not controlling systems, a peace maker." This
 * module writes nothing, stores nothing, and stamps nothing. Every pile is derived at request time
 * from rows other screens own, through the functions those screens already read:
 * `resolveSupplierPapers` for who a paper belongs to, `supplierCoverage` for what the suppliers'
 * own papers cover, `suggestSupplierGroups` and `findDuplicateBills` for the matches,
 * `supplierCandidateQuestions` for the question the matcher will not answer. There is no reconcile
 * table and there must never be one: a stored "reviewed" stamp would make this screen an authority.
 *
 * NO MONEY IS ADDED UP HERE. The supplier figures arrive from `readSupplierOwed` — the same single
 * read Nort and the Suppliers card make — and the papers-on-no-account figure is that read's own
 * `notOnAnAccount`, handed down untouched so the section and /bills' "File It" door quote one pile.
 *
 * ── AND ONLY A DISAGREEMENT IS A ROW (cn-v1041) ───────────────────────────────────────────────
 *
 * `papersOnNoAccount` decides the pile through `paperDisagrees`: not on an account AND still open.
 * A purchase paid at the register has one record, so there is nothing to reconcile, and this page
 * was listing thirty-three spellings of settled card swipes with a button offering to open a
 * supplier account with each of them — the stockpile failure, on the page built to be its opposite.
 */

import { holdsTheirOwnPapers, indexSupplierIdentity, resolveSupplierPapers } from "@/lib/supplier-owed";
import {
  duplicateTicketGroups,
  isOpenDuplicateGroup,
  papersOnNoAccount,
  supplierNameWork,
  unassignedTotals,
  type NameWorkAccount,
  type NameWorkBill,
} from "@/app/(app)/bills/supplier-name-work";
import { countOpen } from "@/lib/open-counts";
import { NO_DISAGREEMENTS, type ReconcileOpenCounts } from "@/lib/reconcile-kinds";
import type { NotOnAnAccount } from "@/lib/supplier-owed";
import type { SupplierOwedRead } from "@/lib/supplier-owed-read";
import type { SupplierGapRow } from "./supplier-gap";
import type { SupplierCandidateQuestion, SupplierMergeProposal, SupplierSpelling, DuplicateBillGroup } from "@/app/(app)/bills/supplier-balance";

/** The figures the page passes and the badge does not. Named so a caller has to say which it is. */
export interface ReconcileFigures {
  /** Each account's balance from `supplierBalance`, for the "same supplier, or two?" sides. */
  owedOf: ReadonlyMap<string, number | null>;
  /** From `supplierCoverage`, so a spelling's unpaid slice matches the Suppliers card to the cent. */
  settledBySupplier: ReadonlySet<string>;
  /** From `resolveSupplierPapers`, so a paper finds its supplier the one way the app resolves one. */
  identity: ReadonlyMap<string, { accountId: string | null }>;
  /**
   * THE PAPERS-ON-NO-ACCOUNT PILE, EXACTLY AS `whatISupplierOwed` COUNTED IT. This is the figure
   * /bills' own "File It" door quotes, so the section that door lands on quotes the very same object
   * rather than totalling the pile a second way. The badge is handed nothing and draws no money.
   */
  notOnAnAccount: NotOnAnAccount;
}

export interface ReconcileWork {
  proposals: SupplierMergeProposal[];
  questions: SupplierCandidateQuestion[];
  loose: SupplierSpelling[];
  duplicates: DuplicateBillGroup[];
  /** How many rows of each kind still need someone. The badge is counted off this. */
  counts: ReconcileOpenCounts;
  /** The unfiled pile totalled the way the Suppliers card totals it, for the fall-back sentence. */
  unassigned: { bills: number; total: number };
  /** The papers on no supplier account: the rows, the one figure, and what is NOT in the rows. */
  notOnAccount: ReconcilePile;
  /** False when the database has not got 0271: the duplicate picker is not drawn at all. */
  supersedeReady: boolean;
  /** Which reads failed, by name. Nothing is claimed off a failed read — the page says so. */
  failed: string[];
}

/**
 * ── THE PAPERS ON NO SUPPLIER ACCOUNT, AS ONE PILE ────────────────────────────────────────────
 *
 * Erik's law: one number for one pile. /bills' "File It" door and the section it lands on used to
 * be two readings of the same papers — the door quoting `notOnAnAccount` (open papers only) and the
 * section listing every SPELLING ever scanned, settled ones included. On a live book that was
 * "$147.92 On 1 Bill" over a list of thirty-one rows. So both figures come from the one read, and
 * the rows come from the one membership test, and the two cannot drift.
 */
export interface ReconcilePile {
  /** How many papers, and how much, exactly as the one read counted them. Null for the badge. */
  figure: NotOnAnAccount | null;
  /** Papers with no supplier name on them at all. They get a row rather than vanishing. */
  unnamed: { papers: number; total: number };
  /** Unmatched papers already settled at the register, left out and accounted for in a sentence. */
  settledAtTheRegister: number;
}

const NO_PILE: ReconcilePile = { figure: null, unnamed: { papers: 0, total: 0 }, settledAtTheRegister: 0 };

const EMPTY: ReconcileWork = {
  proposals: [],
  questions: [],
  loose: [],
  duplicates: [],
  counts: NO_DISAGREEMENTS,
  unassigned: { bills: 0, total: 0 },
  notOnAccount: NO_PILE,
  supersedeReady: true,
  failed: [],
};

/** The one error shape a column the database hasn't got yet makes (page.tsx's own test, 7a6b17a8). */
function isMissingColumn(err: unknown): boolean {
  const code = String((err as { code?: string })?.code ?? "");
  const message = String((err as { message?: string })?.message ?? "");
  return code === "42703" || /does not exist/i.test(message) || /\b(superseded_by_bill_id|pricing_provisional)\b/i.test(message);
}

/**
 * EVERY BILL WITH ITS LINES, SUPERSEDED ONES INCLUDED.
 *
 * The duplicate picker is the one pile here whose read is not a thin slice: a group reads as
 * ANSWERED because one copy points at the other, so the copy he set aside has to come back. Every
 * other pile drops them.
 *
 * AND IT SURVIVES ITS OWN MIGRATION NOT BEING THERE. PostgREST rejects the WHOLE query for one
 * unknown column, so a push that lands before 0271 would take out every pile on the page rather
 * than one section. The newest columns fall off first; without them `supersedeReady` is false and
 * the picker does not render, which is the no-dead-ends rule.
 */
async function readBillsWithLines(supabase: any, orgId: string) {
  const columns = (supersede: boolean) =>
    `id, supplier, supplier_account_id, amount, status, bill_date, job_id, category, notes, supplier_invoice_number${supersede ? ", superseded_by_bill_id" : ""}, jobs(job_number, name, customers(name)), bill_line_items(description)`;
  const read = (supersede: boolean) =>
    supabase.from("bills").select(columns(supersede)).eq("org_id", orgId).order("created_at", { ascending: false }).limit(5000);
  const first = await read(true);
  if (!first?.error || !isMissingColumn(first.error)) return first;
  return read(false);
}

/**
 * THE PILES, BUILT FROM ROWS OTHER SCREENS OWN.
 *
 * `figures` is the page's; the badge passes null. The MEMBERSHIP of every pile — and so every count
 * and the badge itself — is identical either way: whether a paper is on an account is the
 * resolver's answer and whether a spelling is worth a row is `aliasKey` plus the business-cost rule,
 * and neither of those is money. What the figures buy is the MONEY on each row, and the badge draws
 * no money.
 */
export async function readReconcileWork(
  supabase: any,
  orgId: string,
  figures: ReconcileFigures | null,
): Promise<ReconcileWork> {
  if (!orgId) return EMPTY;

  const [acctRes, aliasRes, billsRes] = await Promise.all([
    supabase.from("supplier_accounts").select("id, name, account_number, branch_code").eq("org_id", orgId).order("name", { ascending: true }).limit(500),
    supabase.from("supplier_aliases").select("alias, supplier_account_id").eq("org_id", orgId).order("alias", { ascending: true }).limit(2000),
    readBillsWithLines(supabase, orgId),
  ]);

  const failed: string[] = [];
  const rowsOf = (res: any, name: string): any[] => {
    if (res?.error) {
      failed.push(name);
      return [];
    }
    return (res?.data ?? []) as any[];
  };
  const accountRows = rowsOf(acctRes, "supplier accounts");
  const aliasRows = rowsOf(aliasRes, "supplier names");
  const billRows = rowsOf(billsRes, "bills") as NameWorkBill[];

  // WITHOUT THE BILLS OR THE NAMES THERE IS NO PILE TO DRAW, and a silent empty page would read as
  // "nothing disagrees" — a sentence the app could not stand behind. The page says it could not
  // check instead.
  if (failed.includes("bills") || failed.includes("supplier names") || failed.includes("supplier accounts")) {
    return { ...EMPTY, failed };
  }

  const live = billRows.filter((b) => !b.superseded_by_bill_id);

  // ── WHO EACH PAPER BELONGS TO ─────────────────────────────────────────────────────────────
  // The page hands over the identity `readSupplierOwed` already resolved, so the two cannot place
  // the same paper on two different suppliers. The badge has no such read, so it asks the one
  // function that decides — `resolveSupplierPapers` — which is the same thing that read asked.
  // Identity does not depend on the suppliers' own papers (only coverage does, and the badge needs
  // no coverage), so both answers are the same answer.
  const identity: ReadonlyMap<string, { accountId: string | null }> =
    figures?.identity ??
    resolveSupplierPapers(
      live.map((b) => ({ id: String(b.id), supplierAccountId: (b as any).supplier_account_id ?? null, supplier: b.supplier ?? null })),
      indexSupplierIdentity({ accounts: accountRows, aliases: aliasRows }),
    );
  const accountOf = (billId: string) => identity.get(billId)?.accountId ?? null;

  const pile = papersOnNoAccount({
    bills: live,
    accountOf,
    settledBySupplier: figures?.settledBySupplier ?? null,
  });
  const unfiled = pile.unfiled;

  const aliasesOf = new Map<string, { alias: string }[]>();
  for (const a of aliasRows) {
    const id = String(a?.supplier_account_id ?? "");
    if (!id) continue;
    aliasesOf.set(id, [...(aliasesOf.get(id) ?? []), { alias: String(a.alias ?? "") }]);
  }
  const accounts: NameWorkAccount[] = accountRows.map((a) => {
    const id = String(a.id);
    return {
      id,
      name: String(a.name ?? "").trim() || "a supplier",
      accountNumber: a.account_number ?? null,
      branchCode: a.branch_code ?? null,
      aliases: aliasesOf.get(id) ?? [],
      // `supplierBalance().owed`, handed in. Null when nobody asked for it: the badge needs no
      // balance, and a zero invented here would print "owes nothing" on a question's side.
      owed: figures ? (figures.owedOf.get(id) ?? null) : null,
    };
  });

  const { proposals, questions, loose } = supplierNameWork({ unfiled, accounts, aliasRows });
  const { groups: duplicates, ready: supersedeReady } = duplicateTicketGroups({ bills: billRows });

  return {
    proposals,
    questions,
    loose,
    duplicates,
    counts: {
      // OPEN BY CONSTRUCTION, and that is the rule rather than an omission: a proposal, a question
      // or a loose spelling exists only while its bills sit on no account, and every answer on
      // those rows files them — so the row leaves the list the moment it is answered. There is no
      // settled state to filter out.
      "supplier-names": proposals.length,
      "same-supplier-or-two": questions.length,
      // A PAPER WITH NO SUPPLIER NAME ON IT IS A ROW TOO. It is not a spelling to file, so no
      // spelling speaks for it, and it used to be in the door's figure and in no section at all —
      // the dead end /bills' File It door landed on. One row for the lot of them, counted once.
      "not-on-an-account": loose.length + (pile.unnamed.papers > 0 ? 1 : 0),
      // A duplicate group DOES have a settled state: the pick he already made keeps its row so he
      // can change his mind, and must not be counted. One rule, through the one counter.
      "same-ticket-two-jobs": supersedeReady ? countOpen(duplicates, isOpenDuplicateGroup) : 0,
    },
    unassigned: unassignedTotals(unfiled),
    notOnAccount: { figure: figures?.notOnAnAccount ?? null, unnamed: pile.unnamed, settledAtTheRegister: pile.settledAtTheRegister },
    supersedeReady,
    failed,
  };
}

/** The three reads an identity stands on, by the names `readSupplierOwed` reports them under. */
const IDENTITY_READS: readonly string[] = ["bills", "supplier accounts", "supplier names"];

/**
 * THE FIGURES, OUT OF THE ONE READ. `readSupplierOwed` is the single read behind both supplier
 * questions — the one Nort makes and the one the Suppliers card draws — so taking Reconcile's
 * figures out of it is what stops this screen becoming a fourth door with its own arithmetic
 * (supplier-owed-parity.test.ts: "one book, three doors, one figure").
 */
export function figuresFrom(owed: SupplierOwedRead | null): ReconcileFigures | null {
  if (!owed) return null;
  // ── A HANDED-IN IDENTITY IS ONLY WORTH HAVING IF IT SAW THE WHOLE BOOK ──────────────────────
  //
  // `readSupplierOwed` does not bail when a read under it fails: it names the failure and answers
  // with what it got. So after a lost bills read it still returns an identity map - one built over
  // ZERO bills - and because the read below PREFERS what it is handed, every correctly filed bill in
  // the book then reads as unfiled. The page drew "these spellings belong on that account" over
  // bills already on it, carrying a button that says it cannot be undone, and the dock's badge
  // disagreed with the page because the badge is handed nothing and resolves identity properly.
  //
  // Its own bills read has a column-fallback ladder this one has not, so the two really can differ.
  // Handing back nothing is not a degradation: the read then asks `resolveSupplierPapers` itself,
  // which is the same function that produced this map, and the page says what it could not read.
  if (owed.failed.some((f) => IDENTITY_READS.includes(f))) return null;
  return {
    owedOf: new Map(owed.accounts.map((a) => [a.accountId, a.unread ? null : a.owed])),
    settledBySupplier: owed.settledBySupplier,
    identity: owed.identity,
    notOnAnAccount: owed.owed.notOnAnAccount,
  };
}


/**
 * ── THE TWO RECORDS, PER SUPPLIER, STRAIGHT OUT OF THE ONE READ ───────────────────────────────
 *
 * One row per supplier WHOSE OWN PAPERS WE HOLD, because that is what makes two records exist to
 * disagree. An account we hold no papers for has one record, not two, and its figure already IS our
 * own tickets less what we have sent them - putting it here would invent a quarrel with ourselves.
 *
 * IT IS BUILT FROM `accounts`, NOT FROM `owed.lines`, AND THAT IS THE WHOLE POINT. A line on "what
 * you owe your suppliers" exists only where an account is owed MONEY: `whatISupplierOwed` sends a net
 * credit to `ahead` and drops anything at or under half a cent. So an account whose own papers are all
 * CLOSED - their book says nothing is open - had no line, got no row, and the page led with "No money
 * gap" over four of our own open tickets. That is not the quiet case; it is the loudest disagreement
 * there is, and $3,034.54 of a live book was sitting in it.
 *
 * NOTHING IS ADDED UP HERE. `theirs` is that account's own figure exactly as `supplierBalance`
 * produced it, `ours` is its own slice of `whatIBoughtNotSettled`, and an account whose figure could
 * not be worked out is left out and NAMED by `couldNotTotal` rather than compared against a guess.
 */
export function supplierGapRows(owed: SupplierOwedRead | null): SupplierGapRow[] {
  return (owed?.accounts ?? [])
    .filter((a) => a.accountId && !a.unread && holdsTheirOwnPapers(a))
    .map((a) => {
      const ours = owed?.boughtByAccount[a.accountId];
      return {
        accountId: a.accountId,
        name: a.name,
        // Their own open balance. A credit of theirs arrives here negative, which is a real reading:
        // their book says money back where ours says money out.
        theirs: a.owed ?? 0,
        ours: ours?.total ?? 0,
        oursPapers: ours?.papers ?? 0,
      };
    });
}
