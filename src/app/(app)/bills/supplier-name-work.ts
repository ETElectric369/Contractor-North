/**
 * THE SUPPLIER-NAME HOUSEKEEPING, AS ONE MODULE INSTEAD OF ONE PAGE'S MIDDLE (cn-v1037).
 *
 * ── WHY THIS FILE EXISTS ──────────────────────────────────────────────────────────────────────
 *
 * These four piles — the spellings nobody has filed, the ones that look like one account, the one
 * pair the matcher will not rule on, and the same ticket filed to two jobs — were a hundred and
 * fifty lines in the middle of /bills' page body, feeding a fold at the bottom of it. Reconcile
 * (/reconcile) is the screen that answers them now, and /bills still needs ONE of them: the
 * Suppliers card's "$X on N bills with no supplier account" line is the unfiled map totalled.
 *
 * SO IT IS EXTRACTED, NOT COPIED. Two pages computing the same pile their own way is the fault
 * 8a982483 was: one total joined through the stored column while another grouped the typed
 * spelling, and the two could never be reconciled. There is one road to these piles and this is it.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ─────────────────────────────────────────────────────────
 *
 * NO ARITHMETIC OF ITS OWN ABOUT WHAT IS OWED. `isOnAccountBill` (which is `isStillOwed` under the
 * open-counts name) decides whether a paper is still owed; `aliasKey` decides whether two spellings
 * are the same; the identity of a paper arrives as `accountOf`, which the caller gets from
 * `resolveSupplierPapers`. An account's balance arrives as `owed`, already produced by
 * `supplierBalance`. Nothing here adds up a supplier's money.
 */

import { namesABucket } from "@/lib/business-cost-buckets";
import {
  aliasKey,
  findDuplicateBills,
  readBillInvoice,
  resolveSupplierAccount,
  suggestSupplierGroups,
  type BillFingerprint,
} from "@/lib/supplier-identity";
import {
  candidateMoving,
  isOnAccountBill,
  supplierCandidateQuestions,
  type DuplicateBillGroup,
  type SupplierCandidateQuestion,
  type SupplierMergeProposal,
  type SupplierSpelling,
} from "./supplier-balance";

/** What one typed-in spelling is carrying. `unpaid` is the slice still owed. */
export interface UnfiledSpelling {
  alias: string;
  bills: number;
  total: number;
  unpaid: number;
  unpaidBills: number;
}

/** The columns these piles read off a bill. PostgREST's own shape: the caller holds those rows. */
export interface NameWorkBill {
  id: string;
  supplier?: string | null;
  /** Read only to resolve identity, and only by the caller — never as a shortcut to a figure. */
  supplier_account_id?: string | null;
  status?: string | null;
  amount?: unknown;
  job_id?: string | null;
  bill_date?: string | null;
  supplier_invoice_number?: string | null;
  superseded_by_bill_id?: string | null;
  notes?: string | null;
  jobs?: { name?: string | null } | null;
  /** Sorted or not, it is only ever counted and read for descriptions here. */
  line_items?: { description?: string | null }[] | null;
  bill_line_items?: { description?: string | null }[] | null;
}

/** An account as these piles need it. `owed` comes from `supplierBalance`, never from here. */
export interface NameWorkAccount {
  id: string;
  name: string;
  accountNumber: string | null;
  branchCode: string | null;
  aliases: readonly { alias: string }[];
  /** `supplierBalance().owed`. Null for a register supplier with no running balance. */
  owed: number | null;
}

const r2 = (n: number) => Math.round((Number.isFinite(n) ? n : 0) * 100) / 100;
const linesOf = (b: NameWorkBill) => b.line_items ?? b.bill_line_items ?? [];

/**
 * ── THE SPELLINGS NOBODY HAS FILED YET ──────────────────────────────────────────────────────
 *
 * The receipt reader writes `bills.supplier` afresh on every scan, so one real vendor arrives
 * spelled several ways, each carrying its own money. They are grouped by the EXACT spelling,
 * lowercased — `aliasKey`, which is the key `supplier_aliases` is unique on and the key
 * `supplierAccountForPaper` matches. So what he reads in a row is exactly what that row's button
 * will move. No more, no less.
 *
 * `accountOf` is the resolver's answer, never the stored column: a paper spelled with an account's
 * own name is ON that account, and offering to file it a second time would be a door to nothing.
 */
export function unfiledSpellings(input: {
  /** Live bills — the caller has already dropped the superseded ones. */
  bills: readonly NameWorkBill[];
  /** From `resolveSupplierPapers`: which account a paper belongs to, or null. */
  accountOf: (billId: string) => string | null;
  /** From `supplierCoverage`. Absent means not checked, and nothing is treated as settled. */
  settledBySupplier?: ReadonlySet<string> | null;
}): Map<string, UnfiledSpelling> {
  const unfiled = new Map<string, UnfiledSpelling>();
  for (const b of input.bills ?? []) {
    const id = String(b?.id ?? "");
    if (!id) continue;
    if (input.accountOf(id)) continue;
    const alias = String(b.supplier ?? "").trim();
    // A bill with no supplier name at all is not a SPELLING to file — there is nothing to type on
    // a button. It is still money, and `whatISupplierOwed` counts and names it under "No Supplier
    // Name On The Paper"; this list is the one about names.
    if (!alias) continue;
    // Nor is a business cost saved with no Where: Add By Hand puts the bucket's own name in the
    // supplier field ("Fuel"), and offering to give "Fuel" its own supplier account would be a door
    // to nothing. Only a settled one, though: anything still owed stays in the count, so no unpaid
    // dollar drops out of the amber line.
    if (!b.job_id && namesABucket(alias) && !isOnAccountBill({ status: String(b.status ?? "") })) continue;
    const key = aliasKey(alias);
    const g = unfiled.get(key) ?? { alias, bills: 0, total: 0, unpaid: 0, unpaidBills: 0 };
    const amount = Number(b.amount) || 0;
    g.bills += 1;
    g.total = r2(g.total + amount);
    if (isOnAccountBill({ status: String(b.status ?? ""), settledBySupplier: input.settledBySupplier?.has(id) })) {
      g.unpaid = r2(g.unpaid + amount);
      g.unpaidBills += 1;
    }
    unfiled.set(key, g);
  }
  return unfiled;
}

/**
 * WHAT THE SUPPLIERS CARD SAYS OUT LOUD: until a spelling is on an account its money belongs to no
 * balance on that card, and All Bills is still counting it. Both figures are about the same bills,
 * and both are about what is still OWED — a count that quietly included receipts already paid at
 * the register would make one sentence out of two different piles.
 */
export function unassignedTotals(unfiled: ReadonlyMap<string, UnfiledSpelling>): { bills: number; total: number } {
  const groups = [...unfiled.values()];
  return {
    bills: groups.reduce((n, g) => n + g.unpaidBills, 0),
    total: r2(groups.reduce((s, g) => s + g.unpaid, 0)),
  };
}

export interface SupplierNameWork {
  /** "These spellings are one account" — Accept And File Them There / Not The Same. */
  proposals: SupplierMergeProposal[];
  /** "I cannot tell" — Join Them Onto One Account / Keep Them Separate. */
  questions: SupplierCandidateQuestion[];
  /** Everything left, each with the one door it needs: Give It Its Own Account. */
  loose: SupplierSpelling[];
}

/**
 * ── WHICH SPELLINGS LOOK LIKE ONE ACCOUNT, WHICH ONE PAIR NOBODY BUT HIM CAN RULE ON, AND WHAT
 *    IS LEFT ───────────────────────────────────────────────────────────────────────────────────
 *
 * Suggestions, and only suggestions: nothing is merged, renamed or re-filed until he presses
 * something. The names of the accounts he already has go into the same read, so a receipt scanned
 * next Tuesday is offered to the account he built instead of proposing a second one.
 *
 * THE THREE PILES ARE ONE UNIT AND MUST BE BUILT TOGETHER. `loose` is the unfiled map minus
 * whatever a proposal or a question already speaks for — split them across two screens and the same
 * spelling appears twice with two buttons doing one thing.
 *
 * A LONE SPELLING WITH NO RELATIVE IS NOT PROPOSED: on a proposal card, Accept would make it an
 * account of its own and so would "Not The Same". It falls through to `loose`, which gives it one
 * row and one button.
 */
export function supplierNameWork(input: {
  unfiled: ReadonlyMap<string, UnfiledSpelling>;
  accounts: readonly NameWorkAccount[];
  /** `supplier_aliases` rows, for the spelling already saved as a name for an account. */
  aliasRows: readonly { alias?: string | null; supplier_account_id?: string | null }[];
}): SupplierNameWork {
  const unfiled = input.unfiled;
  const accounts = input.accounts ?? [];

  const accountKeyToId = new Map<string, string>();
  for (const a of accounts) {
    accountKeyToId.set(aliasKey(a.name), a.id);
    for (const al of a.aliases ?? []) accountKeyToId.set(aliasKey(al.alias), a.id);
  }

  const identity = suggestSupplierGroups([
    ...[...unfiled.values()].map((g) => g.alias),
    ...accounts.flatMap((a) => [a.name, ...(a.aliases ?? []).map((x) => x.alias)]),
  ]);

  const proposals: SupplierMergeProposal[] = [];
  for (const group of identity.groups) {
    const members = group.members.map((m) => ({ m, key: aliasKey(m) }));
    const mine = members.filter((x) => unfiled.has(x.key));
    if (!mine.length) continue; // nothing left to file: this group is already an account
    // A group can touch more than one account he already has. Joining two existing accounts is a
    // question this wave has no door for, so the row offers the one it can answer — and it picks by
    // NAME, not by whatever order the matcher returned, so the same pile proposes the same thing
    // every time the page loads.
    const existing =
      members
        .map((x) => accountKeyToId.get(x.key))
        .filter((id): id is string => !!id)
        .map((id) => accounts.find((a) => a.id === id))
        .filter((a): a is NameWorkAccount => !!a)
        .sort((a, b) => a.name.localeCompare(b.name))[0] ?? null;
    if (mine.length < 2 && !existing) continue; // see above: both buttons would do the same thing
    const spellings: SupplierSpelling[] = mine.map((x) => {
      const g = unfiled.get(x.key) as UnfiledSpelling;
      return { alias: g.alias, bills: g.bills, total: g.total, unpaid: g.unpaid };
    });
    proposals.push({
      // THE ID IS THE SPELLINGS, as JSON. "Not The Same" hands the server nothing but this one
      // string, so the string has to carry what it is about — and JSON rather than a separator
      // because a supplier name is free text a scanner wrote and will eventually contain whatever
      // character we picked. The action re-checks every spelling against his own unfiled bills
      // before it writes anything, so a made-up id buys nobody anything.
      id: `merge:${JSON.stringify(spellings.map((s) => s.alias))}`,
      suggestedName: existing?.name ?? group.suggestedName,
      accountNumber: existing?.accountNumber ?? null,
      branchCode: existing?.branchCode ?? null,
      spellings,
      existingAccountId: existing?.id ?? null,
      existingAccountName: existing?.name ?? null,
      because: group.reasons[0] ?? null,
    });
  }

  // A spelling that already IS a saved name for an account, whose bills were never filed onto it.
  // That happens every time a receipt is scanned after the account was made, which makes it the
  // most ordinary case there is — so it gets its own one-press row instead of waiting for the fuzzy
  // matcher to have an opinion about it.
  const proposedKeys = new Set(proposals.flatMap((p) => p.spellings.map((s) => aliasKey(s.alias))));
  for (const [key, g] of unfiled) {
    if (proposedKeys.has(key)) continue;
    const accountId = resolveSupplierAccount(g.alias, (input.aliasRows ?? []) as any[]);
    const account = accountId ? (accounts.find((a) => a.id === accountId) ?? null) : null;
    if (!account) continue;
    proposals.push({
      id: `merge:${JSON.stringify([g.alias])}`,
      suggestedName: account.name,
      accountNumber: account.accountNumber,
      branchCode: account.branchCode,
      spellings: [{ alias: g.alias, bills: g.bills, total: g.total, unpaid: g.unpaid }],
      existingAccountId: account.id,
      existingAccountName: account.name,
      because: `"${g.alias}" is already saved as a name for ${account.name}. These bills were scanned after that and never landed on it.`,
    });
  }

  // ── THE ONE QUESTION ONLY HE CAN ANSWER ───────────────────────────────────────────────────
  // `suggestSupplierGroups` returns `{ groups, candidates }`. A candidate is a pair that comes out
  // close enough to notice and not close enough to propose: one of them is a different first word
  // on the same initials, which may be a typo or may be a second company near another branch. The
  // machine will not decide that. It is NOT rendered as a proposal — a proposal says "these are the
  // same, press Accept"; this says "I cannot tell", and carries both doors.
  //
  // THE RULE ITSELF IS PURE AND LIVES IN supplier-balance.ts WITH A TEST AROUND IT, because the
  // part that matters is not the loop, it is which side a press is allowed to touch.
  const questions = supplierCandidateQuestions(identity.candidates, {
    unfiled,
    accounts: new Map(
      [...accountKeyToId].flatMap(([key, id]) => {
        const account = accounts.find((a) => a.id === id);
        if (!account) return [];
        return [[key, { id: account.id, name: account.name, owed: account.owed }] as const];
      }),
    ),
  });

  // ── EVERY OTHER SPELLING, WITH THE DOOR IT NEVER HAD ──────────────────────────────────────
  // A SPELLING THAT ALREADY HAS A DOOR DOES NOT GET A SECOND ONE. "Keep Them Separate" up there and
  // "Give It Its Own Account" down here are the same write wearing two sentences, and two buttons
  // doing one thing is the trap the proposals avoid by not offering "Not The Same" on a group of
  // one. (A spelling can be in a proposal AND in a question — "are these four one account?" and "is
  // that fifth one theirs too?" are two different questions — and that is fine, because those two
  // rows offer genuinely different outcomes.)
  const spokenFor = new Set([
    ...proposals.flatMap((p) => p.spellings.map((s) => aliasKey(s.alias))),
    ...questions.flatMap((q) => candidateMoving(q).map((s) => aliasKey(s.spelling))),
  ]);
  const loose: SupplierSpelling[] = [...unfiled.values()]
    .filter((g) => !spokenFor.has(aliasKey(g.alias)))
    .map((g) => ({ alias: g.alias, bills: g.bills, total: g.total, unpaid: g.unpaid }))
    // Biggest money first: what he still owes, then what it cost him, then by name so the list does
    // not shuffle itself between loads.
    .sort((x, y) => y.unpaid - x.unpaid || y.total - x.total || x.alias.localeCompare(y.alias));

  return { proposals, questions, loose };
}

export interface DuplicateTicketWork {
  groups: DuplicateBillGroup[];
  /**
   * False when the database has not got 0271's `superseded_by_bill_id` — which is where a pick gets
   * written. Without it the picker could only refuse, and a control that can only refuse must not
   * render at all, so the caller draws nothing.
   */
  ready: boolean;
}

/**
 * ── THE SAME TICKET, FILED TO TWO JOBS ──────────────────────────────────────────────────────
 *
 * Two receipts that match line for line to the penny mean one of those jobs is carrying a cost that
 * is not its own, and its profit is wrong by exactly that much. WHICH COPY IS THE REAL ONE IS HIS
 * KNOWLEDGE — he was on those jobs. The page only asks.
 *
 * Built from whatever matched (`findDuplicateBills`), never hard-coded to a bill, and it needs the
 * SUPERSEDED rows too: the copy he already set aside is what makes a group read as answered.
 */
export function duplicateTicketGroups(input: {
  /** Every bill, INCLUDING the superseded ones, each with its line items and notes. */
  bills: readonly NameWorkBill[];
}): DuplicateTicketWork {
  const bills = input.bills ?? [];
  const ready = bills.every((b) => "superseded_by_bill_id" in (b as object));
  if (!ready) return { groups: [], ready: false };

  const billById = new Map(bills.map((b) => [String(b.id), b]));
  const fingerprints: BillFingerprint[] = bills.map((b) => {
    const reading = readBillInvoice({
      notes: b.notes ?? null,
      lineDescriptions: linesOf(b).map((l) => l.description ?? null),
    });
    return {
      id: String(b.id),
      supplier: String(b.supplier ?? ""),
      amount: Number(b.amount) || 0,
      billDate: b.bill_date ?? null,
      jobLabel: b.jobs?.name ?? null,
      lineCount: linesOf(b).length,
      invoiceNumber: b.supplier_invoice_number ?? reading.invoiceNumber,
    };
  });

  const groups = findDuplicateBills(fingerprints).map((d) => {
    const ids = d.bills.map((b) => String(b.id));
    const copies = ids.map((id) => {
      const row = billById.get(id);
      return {
        billId: id,
        jobId: row?.job_id ?? null,
        jobName: row?.jobs?.name ?? null,
        billDate: row?.bill_date ?? null,
        supplier: String(row?.supplier ?? ""),
        // Where it came from, in the importer's own words: the portal filename, or whatever he
        // saved the file as. On two tickets identical to the penny it is the one thing that tells
        // them apart on sight.
        source: String(row?.notes ?? "").split(/\r?\n/)[0] || null,
      };
    });
    // Already sorted out? The copy he set aside points at the copy he kept.
    const supersededCopy = copies.find((c) => billById.get(c.billId)?.superseded_by_bill_id);
    const keptBillId = supersededCopy ? String(billById.get(supersededCopy.billId)?.superseded_by_bill_id ?? "") : "";
    return {
      // BOTH BILL IDS RIDE IN THE ID, because Undo is handed nothing else.
      id: `dup:${JSON.stringify([...ids].sort())}`,
      amount: d.amount,
      lineCount: Number(d.bills[0]?.lineCount ?? 0),
      copies,
      resolution: keptBillId && ids.includes(keptBillId) ? { keptBillId } : null,
    };
  });
  return { groups, ready: true };
}

/**
 * A DUPLICATE GROUP STILL NEEDING SOMEONE: one he has not picked a job for yet. A group he HAS
 * answered keeps its row (so he can change his mind) and is not counted — every badge counts only
 * what is open.
 */
export const isOpenDuplicateGroup = (g: { resolution?: { keptBillId: string } | null }): boolean => !g?.resolution;
