"use server";

import { revalidatePath } from "next/cache";
import { dbError } from "@/lib/db-error";
import { reportError } from "@/lib/observe";
import { requireStaff } from "@/lib/staff-guard";
import { getOrgSettings } from "@/lib/org-settings";
import { todayStrInTz } from "@/lib/tz";
import {
  reversedPurchaseIds,
  SUPPLIER_PAY_METHODS,
  type PurchaseReversalShape,
  type SupplierActionResult,
  type SupplierPayMethod,
} from "./supplier-balance";
// sayMoney lives in payroll-math because payroll needed it first. It is pure string formatting
// with no payroll in it ("$400", not "$400.00"), and a second copy here would drift the moment one
// of them learned something about cents. One function, two ledgers.
import { sayMoney } from "@/lib/payroll-math";
// The arithmetic that turns a supplier's invoice lines into receipt lines lives on its own,
// pure and tested: it is what decides the price a customer is charged for a part, and it must be
// checkable without a database. It routes category/billable through decideReceiptLine, the one
// door every other receipt path already passes through.
import { supplierBillLines } from "./supplier-bill-lines";
import { SHELF_NEEDS_LINES, ticketShelfProblem, type ShelfPick, type TicketLineChoice } from "@/lib/shelf-plan";
import { shelveLines } from "@/lib/stock-ledger";
// What a set of invoice lines CLAIMS - both shapes, the `bill:<id>` import key older invoices carry
// and the source_ids array 0255 added. The Bills page reads claims with this same function, so the
// sentence an action writes and the sentence the card prints can never drift apart.
import { claimedIdsOfLines } from "@/lib/unbilled-work";
// "Is this purchase already on the books?" - one reading for every door (audit v994, DB1): the
// tray, the job page and this card all ask the same functions, so no door can be blind to the
// bills another door wrote.
import {
  billsCoveredByDocuments,
  namedNumbersOf,
  samePurchaseCandidates,
  samePurchaseSentence,
  type LedgerBill,
  type SamePurchaseCandidate,
  type SupplierDoc,
} from "@/lib/same-purchase";
import { indexSupplierAliases } from "@/lib/supplier-identity";
import { BUSINESS_COST_BUCKETS, isBusinessCostBucket, type BusinessCostBucket } from "@/lib/business-cost-buckets";
import { readBillStanding, standingRefusal } from "@/app/(app)/organize/paperwork-core";
import { creditWait } from "./supplier-reconcile";
import { isMissingWaitColumn } from "./supplier-papers";

/**
 * PAYING A SUPPLIER, AND SAYING WHO THE SUPPLIER IS (migration 0270).
 *
 * Erik's Bills screen opens on Unpaid: $13,040.07 across 21 bills, and $12,572.20 of that is one
 * CED account wearing five different spellings, because `bills.supplier` is free text the receipt
 * reader writes afresh on every scan. He asked whether that pile was what made his margins red.
 * It is not - job profit is cash collected minus cost, and a bill costs the job the moment it
 * exists - but the question found the hole:
 *
 *   "yes i pay them in chunks that never match the ticckets"
 *
 * There was no way to record paying a supplier at all. The only control on the page was a checkbox
 * that flips ONE bill paid (bills-receipts.tsx:320), which is the shape payroll threw out two
 * nights ago for the same reason: a tick is not an amount. So the balance is Owed = the account's
 * unpaid bills minus its live payments, and `bills.status` keeps the meaning it already has - how
 * the thing was bought, on account or settled at the register. Recording a payment does NOT flip
 * a single bill, and nothing in this file ever will.
 *
 * NOTHING IS MERGED, RENAMED OR RE-FILED WITHOUT ERIK PRESSING SOMETHING. Every action here is a
 * button he pushed. There is no backfill, no scheduled matcher, and no "we worked out what you
 * meant" - because the judgements involved are genuinely his. The sixth CED-ish name,
 * "Contractors Electrical Distributors", is a real different storefront near Sunnyvale that he
 * charged to his Truckee account number: "thats how they roll". The money rolls up to the account;
 * the ticket stays with its branch, because the price book learns from these same receipts and a
 * Sunnyvale counter price is not a Truckee counter price.
 *
 * ORG_ID IS SENT EXPLICITLY ON EVERY INSERT HERE, and that is not belt-and-braces. 0270 created
 * supplier_accounts, supplier_aliases and supplier_payments WITHOUT the `set_org_id` trigger every
 * older table got in 0004, and all three org_id columns are `not null`. An insert that leaves
 * org_id to the database fails outright on these tables. See the handoff note.
 *
 * SILENT-WRITE LAW throughout: every write comes back with `.select("id")` and a zero-row result is
 * a refusal said out loud, never a 204 that a screen reads as success.
 */

/** Cents, so a fraction of a penny can never ride along into a balance. */
const money = (n: unknown): number => Math.round((Number(n) || 0) * 100) / 100;

const text = (v: unknown): string | null => {
  const s = String(v ?? "").trim();
  return s.length ? s : null;
};

/**
 * THE KEY TWO SPELLINGS ARE THE SAME ON: the exact string, trimmed and lowercased. Deliberately
 * NOT the fuzzy key from supplier-identity - that one is for SUGGESTING what might be one account,
 * and a suggestion is a question. This is what actually moves bills, so it matches exactly what
 * `supplier_aliases` is unique on (lower(alias)) and exactly what resolveSupplierAccount matches.
 * "Link every bill with this spelling" has to mean that spelling, no more and no less, or the row
 * he read and the rows that moved are two different sets.
 */
const spellingKey = (raw: unknown): string => String(raw ?? "").trim().toLowerCase();

const isPayMethod = (v: unknown): v is SupplierPayMethod =>
  typeof v === "string" && (SUPPLIER_PAY_METHODS as readonly string[]).includes(v);

/** A unique index refused the write. The CODE is the reliable half - the message is English and
 *  the app is the thing standing between a race and a double-charged job, so it checks both. */
const isDuplicateKey = (err: unknown): boolean =>
  String((err as { code?: string } | null)?.code ?? "") === "23505" ||
  /duplicate key value/i.test(String((err as { message?: string } | null)?.message ?? ""));

/**
 * The org this staffer belongs to, or the sentence to refuse with. A profile with no org_id cannot
 * write any of the 0270 tables (org_id is not null, and RLS checks it), and "nothing happened" with
 * no reason given is the silence this app is not allowed to make.
 */
function orgOf(ctx: { orgId: string | null }): { orgId: string } | { error: string } {
  if (!ctx.orgId) {
    return {
      error: "Your sign-in isn't attached to a company yet, so there is nowhere to file this. Ask an owner to check your account.",
    };
  }
  return { orgId: ctx.orgId };
}

/** Today in the ORG's timezone. A check written at 5pm in Truckee is not tomorrow's check, which
 *  is what `current_date` on a UTC server would have called it. */
async function orgToday(supabase: any): Promise<string> {
  const { data: org } = await supabase.from("organizations").select("settings").limit(1).maybeSingle();
  return todayStrInTz(getOrgSettings(org?.settings).timezone);
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "A, B and C" - a list read the way a person says it. */
function sayList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// ACCOUNTS
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * CREATE A SUPPLIER ACCOUNT - the thing he owes money to, keyed by the number on the statement
 * (TR-34426) rather than by whatever the scanner typed that day.
 *
 * `on_account` is what decides whether a running balance exists at all: a counter he pays at the
 * register the moment he walks out has no balance to carry, and showing one would be inventing a
 * figure.
 */
export async function createSupplierAccount(input: {
  name: string;
  accountNumber?: string | null;
  branchCode?: string | null;
  onAccount?: boolean;
  note?: string | null;
}): Promise<SupplierActionResult & { accountId?: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const org = orgOf(ctx);
  if ("error" in org) return { ok: false, error: org.error };

  const name = text(input?.name);
  if (!name) return { ok: false, error: "Give the supplier a name first, like CED Truckee." };

  const made = await makeAccount(ctx.supabase, org.orgId, ctx.userId, {
    name,
    accountNumber: text(input?.accountNumber),
    branchCode: text(input?.branchCode),
    onAccount: input?.onAccount !== false,
    note: text(input?.note),
  });
  if ("error" in made) return { ok: false, error: made.error };

  revalidatePath("/bills");
  return { ok: true, accountId: made.id, message: `Added ${name}.` };
}

/**
 * Make one account, or hand back the one that already answers to that name. Shared by the plain
 * Add door and by the merge review, so a name collision means the same thing on both.
 *
 * REUSING AN EXISTING ROW IS NOT A MERGE. Nothing about the existing account changes here - not
 * its number, not its note, not one of its bills. It is the row his own name already points at,
 * and handing back a refusal instead would leave him retyping a name he has already used.
 */
async function makeAccount(
  supabase: any,
  orgId: string,
  userId: string,
  fields: { name: string; accountNumber: string | null; branchCode: string | null; onAccount: boolean; note: string | null },
): Promise<{ id: string; reused: boolean } | { error: string }> {
  const { data, error } = await supabase
    .from("supplier_accounts")
    .insert({
      org_id: orgId,
      name: fields.name,
      account_number: fields.accountNumber,
      branch_code: fields.branchCode,
      on_account: fields.onAccount,
      note: fields.note,
      created_by: userId,
    })
    .select("id");

  if (!error && data?.length) return { id: String(data[0].id), reused: false };

  if (error && isDuplicateKey(error)) {
    const { data: existing } = await supabase
      .from("supplier_accounts")
      .select("id")
      .eq("org_id", orgId)
      .eq("name", fields.name)
      .maybeSingle();
    if (existing?.id) return { id: String(existing.id), reused: true };
  }
  if (error) return { error: `That supplier didn't save, so nothing was added. ${dbError(error)}` };

  reportError("bills:makeAccount", new Error("supplier account insert wrote no rows"), { name: fields.name });
  return { error: "That supplier didn't save, so nothing was added. Try it again." };
}

/**
 * EDIT AN ACCOUNT. The account number is the one field that is genuinely load-bearing - it is how
 * a payment he sent gets matched to what CED lists when they ask about it - and it arrives wrong
 * often enough (typed off a phone photo) that a read-only field would be a dead end.
 */
export async function updateSupplierAccount(input: {
  accountId: string;
  name?: string;
  accountNumber?: string | null;
  branchCode?: string | null;
  onAccount?: boolean;
  note?: string | null;
}): Promise<SupplierActionResult> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const org = orgOf(ctx);
  if ("error" in org) return { ok: false, error: org.error };

  const accountId = String(input?.accountId ?? "");
  if (!accountId) return { ok: false, error: "Couldn't tell which supplier you meant." };

  const patch: Record<string, unknown> = {};
  if (input.name !== undefined) {
    const name = text(input.name);
    if (!name) return { ok: false, error: "A supplier needs a name." };
    patch.name = name;
  }
  if (input.accountNumber !== undefined) patch.account_number = text(input.accountNumber);
  if (input.branchCode !== undefined) patch.branch_code = text(input.branchCode);
  if (input.onAccount !== undefined) patch.on_account = !!input.onAccount;
  if (input.note !== undefined) patch.note = text(input.note);
  if (!Object.keys(patch).length) return { ok: false, error: "Nothing was changed." };

  const { data, error } = await ctx.supabase
    .from("supplier_accounts")
    .update(patch)
    .eq("id", accountId)
    .eq("org_id", org.orgId)
    .select("id");
  if (error) {
    if (isDuplicateKey(error)) {
      return { ok: false, error: "You already have another supplier with that name. Pick a different one." };
    }
    return { ok: false, error: `That didn't save, so the supplier is unchanged. ${dbError(error)}` };
  }
  if (!data?.length) return { ok: false, error: "That supplier isn't here anymore. Reload the page and try again." };

  revalidatePath("/bills");
  return { ok: true };
}

/**
 * RUNNING BALANCE, OR PAY AT THE REGISTER. This is the door the card points at when it finds a
 * register supplier carrying unpaid bills: a balance it refuses to show, and no way to say the
 * setting is simply wrong, is a dead end with a number in it.
 */
export async function setSupplierOnAccount(input: {
  accountId: string;
  onAccount: boolean;
}): Promise<SupplierActionResult> {
  const res = await updateSupplierAccount({ accountId: input?.accountId, onAccount: !!input?.onAccount });
  if (!res.ok) return res;
  return {
    ok: true,
    message: input?.onAccount
      ? "Set to a running balance. What is unpaid on it now adds up into what you owe them."
      : "Set to paid at the register. It stops carrying a running balance.",
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// ALIASES - the spellings
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * REMEMBER A SPELLING. An alias is how the NEXT scan lands on the right account without anybody
 * retyping anything: the reader writes "Consolidated Electrical Dist." again next Tuesday and the
 * app already knows whose that is.
 *
 * `branch_label` is the other half of the Sunnyvale answer - it keeps WHICH COUNTER a ticket came
 * from while the money rolls up to one account, so the price book can still tell two markets apart.
 */
export async function addSupplierAlias(input: {
  accountId: string;
  alias: string;
  branchLabel?: string | null;
}): Promise<SupplierActionResult & { aliasId?: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const org = orgOf(ctx);
  if ("error" in org) return { ok: false, error: org.error };

  const accountId = String(input?.accountId ?? "");
  const alias = text(input?.alias);
  if (!accountId) return { ok: false, error: "Couldn't tell which supplier you meant." };
  if (!alias) return { ok: false, error: "Type the name the way it appears on the bill." };

  const owner = await aliasOwner(ctx.supabase, org.orgId, alias);
  if (owner && owner.accountId !== accountId) {
    return { ok: false, error: aliasTakenSentence(alias, owner.name, "so it wasn't saved here") };
  }
  if (owner) return { ok: true, message: `"${alias}" was already saved for this supplier.` };

  const { data, error } = await ctx.supabase
    .from("supplier_aliases")
    .insert({ org_id: org.orgId, supplier_account_id: accountId, alias, branch_label: text(input?.branchLabel) })
    .select("id");
  if (error) {
    // The race the read above cannot close: two taps, two tabs. The unique index
    // (supplier_aliases_one_per_spelling) is the boundary; this is the sentence for it.
    if (isDuplicateKey(error)) return { ok: false, error: aliasTakenSentence(alias, "another supplier", "so it wasn't saved here") };
    return { ok: false, error: `That name didn't save. ${dbError(error)}` };
  }
  if (!data?.length) {
    reportError("bills:addSupplierAlias", new Error("alias insert wrote no rows"), { accountId, alias });
    return { ok: false, error: "That name didn't save. Try it again." };
  }

  revalidatePath("/bills");
  return { ok: true, aliasId: String(data[0].id) };
}

/**
 * NAME NO DOOR THAT IS NOT THERE (review, 2026-09-20). This sentence used to end "Take it off there
 * first, or file these bills one at a time", and NEITHER of those controls exists on any screen:
 * `removeSupplierAlias` takes a spelling off an account and `linkBillToSupplierAccount` files one
 * bill by hand, and a grep of the whole app finds no caller for either. So the one sentence he
 * reads when the app refuses to move his bills sent him hunting for two buttons that were never
 * wired, and left him at the same wall with less trust in the screen.
 *
 * Until they are wired it says where the spelling is filed and what happened to the bills, and
 * stops there. A wall you can see is not a dead end; a wall with a made-up door on it is worse
 * than both.
 */
const aliasTakenSentence = (alias: string, owner: string, whatHappened = "so these bills were left alone") =>
  `"${alias}" is already saved as a name for ${owner}, ${whatHappened}.`;

/** Who owns a spelling right now, matched the way the database matches it. A read, so a second tab
 *  can still beat it - which is why every writer below also handles the unique-index error. The
 *  row's own id comes back too, because "Not The Same" has to be able to take a spelling OFF the
 *  account it is currently saved under. */
type AliasOwner = { aliasId: string; accountId: string; name: string };

/** Every saved spelling in this shop, once. Read in one go and looked at in memory, because the
 *  merge review asks about five spellings at a time and five identical round trips for one answer
 *  is the papercut that becomes a page-load. */
async function readAliases(supabase: any, orgId: string): Promise<any[]> {
  const { data } = await supabase
    .from("supplier_aliases")
    .select("id, alias, supplier_account_id, supplier_accounts(name)")
    .eq("org_id", orgId)
    .limit(5000);
  return (data ?? []) as any[];
}

/** Matched the way the database matches it: the exact spelling, lowercased. */
function ownerOf(aliasRows: any[], alias: string): AliasOwner | null {
  const key = spellingKey(alias);
  const hit = aliasRows.find((r: any) => spellingKey(r?.alias) === key);
  if (!hit) return null;
  return {
    aliasId: String(hit.id ?? ""),
    accountId: String(hit.supplier_account_id ?? ""),
    name: String(hit.supplier_accounts?.name ?? "another supplier"),
  };
}

async function aliasOwner(supabase: any, orgId: string, alias: string): Promise<AliasOwner | null> {
  return ownerOf(await readAliases(supabase, orgId), alias);
}

/** FORGET A SPELLING. Detaching an alias changes no bill: one already filed stays filed, because
 *  the link lives on the bill's own row. This only stops the NEXT scan of that spelling from
 *  landing here on its own. */
export async function removeSupplierAlias(aliasId: string): Promise<SupplierActionResult> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const org = orgOf(ctx);
  if ("error" in org) return { ok: false, error: org.error };

  const id = String(aliasId ?? "");
  if (!id) return { ok: false, error: "Couldn't tell which name you meant." };

  const { data, error } = await ctx.supabase
    .from("supplier_aliases")
    .delete()
    .eq("id", id)
    .eq("org_id", org.orgId)
    .select("id");
  if (error) return { ok: false, error: `That didn't come off. ${dbError(error)}` };
  if (!data?.length) return { ok: false, error: "That name is already gone. Reload the page." };

  revalidatePath("/bills");
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// FILING BILLS ONTO ACCOUNTS
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * FILE ONE BILL ON ONE ACCOUNT, or take it back off (`accountId: null`). Reversible in one press,
 * which is what makes the whole wave safe: nothing here is a decision he cannot walk back.
 *
 * It does NOT touch `bills.status`, and it never will. Status says how the thing was bought; the
 * account balance says what is still owed. Two different questions, and the fastest way to rewrite
 * a man's books behind him is to answer one of them with the other.
 */
export async function linkBillToSupplierAccount(
  billId: string,
  accountId: string | null,
): Promise<SupplierActionResult> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const org = orgOf(ctx);
  if ("error" in org) return { ok: false, error: org.error };

  const id = String(billId ?? "");
  if (!id) return { ok: false, error: "Couldn't tell which bill you meant." };
  const target = accountId ? String(accountId) : null;

  if (target) {
    const found = await readAccount(ctx.supabase, org.orgId, target);
    if ("error" in found) return { ok: false, error: found.error };
  }

  const { data, error } = await ctx.supabase
    .from("bills")
    .update({ supplier_account_id: target })
    .eq("id", id)
    .eq("org_id", org.orgId)
    .select("id");
  if (error) return { ok: false, error: `That didn't save, so the bill is filed where it was. ${dbError(error)}` };
  if (!data?.length) return { ok: false, error: "That bill isn't here anymore. Reload the page and try again." };

  revalidatePath("/bills");
  return { ok: true };
}

/**
 * The account, read through RLS before anything is written against it. A bill pointing at an id
 * from another shop is exactly the cross-tenant shape 0173 was written about - and a read that
 * ERRORED is a different fact from a read that found nothing, because refusing with the wrong
 * reason is its own dead end.
 */
async function readAccount(
  supabase: any,
  orgId: string,
  accountId: string,
): Promise<{ id: string; name: string; onAccount: boolean } | { error: string }> {
  const { data, error } = await supabase
    .from("supplier_accounts")
    .select("id, name, on_account")
    .eq("id", accountId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (error) return { error: `Looking that supplier up didn't go through, so nothing changed. ${dbError(error)}` };
  if (!data) return { error: "That supplier isn't on this shop's list. Reload the page and pick it again." };
  return { id: String(data.id), name: String(data.name ?? "that supplier"), onAccount: data.on_account !== false };
}

/**
 * FILE EVERY BILL THAT CARRIES ONE SPELLING - the press that actually empties the pile. Eight bills
 * say "Consolidated Electrical Dist." and they are all the same account; doing them one at a time
 * is eight decisions where he made one.
 *
 * IT ONLY TOUCHES BILLS THAT ARE NOT FILED YET. A bill already sitting on a different account was
 * put there by a person, and quietly re-filing it is the "rewrite his books behind him" failure
 * this wave exists to avoid. Those are counted and said out loud instead, so he can move them
 * himself.
 *
 * AND IT REMEMBERS THE SPELLING. Saying "these are CED" and not writing that down means saying it
 * again next Tuesday, when the reader types the same string onto a new receipt - a dead end one
 * week wide. So the alias goes in too, and the sentence says so.
 */
export async function linkBillsBySupplierText(input: {
  supplier: string;
  accountId: string;
  branchLabel?: string | null;
}): Promise<SupplierActionResult & { linked?: number; skipped?: number }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const org = orgOf(ctx);
  if ("error" in org) return { ok: false, error: org.error };

  const spelling = text(input?.supplier);
  const accountId = String(input?.accountId ?? "");
  if (!spelling) return { ok: false, error: "Couldn't tell which supplier name you meant." };
  if (!accountId) return { ok: false, error: "Pick the supplier these belong to first." };

  const account = await readAccount(ctx.supabase, org.orgId, accountId);
  if ("error" in account) return { ok: false, error: account.error };

  const owner = await aliasOwner(ctx.supabase, org.orgId, spelling);
  if (owner && owner.accountId !== accountId) return { ok: false, error: aliasTakenSentence(spelling, owner.name) };

  const bills = await readBillsForOrg(ctx.supabase, org.orgId);
  if ("error" in bills) return { ok: false, error: bills.error };

  const moved = await fileSpelling(ctx.supabase, org.orgId, bills.rows, {
    alias: spelling,
    accountId,
    branchLabel: text(input?.branchLabel),
    aliasAlreadyThere: !!owner,
  });
  if ("error" in moved) return { ok: false, error: moved.error };

  const head = moved.linked
    ? `Filed ${plural(moved.linked, "bill", "bills")} under ${account.name}.`
    : `Nothing to file: every bill that says "${spelling}" was already on an account.`;
  const elsewhere = moved.elsewhere
    ? ` ${plural(moved.elsewhere, "bill", "bills")} with that name ${moved.elsewhere === 1 ? "is" : "are"} filed under a different supplier and ${moved.elsewhere === 1 ? "was" : "were"} left alone.`
    : "";
  const remembered = moved.aliasSaved
    ? ` From now on a receipt that says "${spelling}" belongs to ${account.name}.`
    : ` The name itself didn't save, so the next receipt that says "${spelling}" will land here unfiled again.`;

  revalidatePath("/bills");
  return { ok: true, linked: moved.linked, skipped: moved.elsewhere, message: `${head}${elsewhere}${remembered}` };
}

/**
 * ONE SPELLING, ON AN ACCOUNT OF ITS OWN - the door a lone name never had (review of cn-v963).
 *
 * Sixteen supplier spellings came off his receipts and the merge review only ever showed the ones
 * that looked like something else. Five of them looked like nothing at all - Home Depot, Goodwin's,
 * Tahoe City Lumber, the counters he pays at the till - so they were dropped on the floor: counted
 * in the amber line at the top of the card, named nowhere, with no way to file them. Money outside
 * every balance on the page and no button in sight is the dead end this wave keeps finding.
 *
 * It is the two existing doors in this file wired together, deliberately: `createSupplierAccount`
 * and `linkBillsBySupplierText` were both exported and called by NOBODY, and a third copy of
 * "make an account, then move its bills" is how two screens start disagreeing about one dollar.
 *
 * ON_ACCOUNT DEFAULTS TO FALSE, and the card says so before the press. A name with no relative
 * anywhere in his book is, on his own receipts, a till counter - and a running balance on a
 * supplier he settles as he walks out would put a figure on the card that he does not owe anyone.
 * If those bills are still marked unpaid, the account's own card says that out loud and offers to
 * turn a running balance on, which is where "unless he says otherwise" actually lives.
 *
 * IT REPORTS THE HALF THAT LANDED. The account is made first and the bills move second, so a
 * failure in between leaves a real account holding nothing. Saying "nothing happened" over that
 * would send him looking for work the app had already done.
 */
export async function fileSpellingAsItsOwnAccount(input: {
  supplier: string;
  /** Leave it off for the till counter this nearly always is. */
  onAccount?: boolean;
}): Promise<SupplierActionResult & { accountId?: string; linked?: number }> {
  const spelling = text(input?.supplier);
  if (!spelling) return { ok: false, error: "Couldn't tell which supplier name you meant. Reload the page." };
  const onAccount = input?.onAccount === true;

  const made = await createSupplierAccount({ name: spelling, onAccount });
  if (!made.ok || !made.accountId) {
    return { ok: false, error: made.error ?? "That supplier didn't save, so nothing was added." };
  }

  const kind = onAccount
    ? "with a running balance you can pay down"
    : "paid at the register, so it carries no running balance";

  const filed = await linkBillsBySupplierText({ supplier: spelling, accountId: made.accountId });
  if (!filed.ok) {
    return {
      ok: false,
      accountId: made.accountId,
      error: `${spelling} was added as a supplier ${kind}, but its bills did not move onto it, so nothing adds up there yet. ${filed.error ?? "Try filing them again."}`,
    };
  }

  revalidatePath("/bills");
  return {
    ok: true,
    accountId: made.accountId,
    linked: filed.linked,
    message: `${spelling} is a supplier of its own now, ${kind}. ${filed.message ?? ""}`.trim(),
  };
}

/**
 * Every bill in this shop, once, for the spelling work below. Read rather than filtered in the
 * query because `ilike` would read a `%` or a `_` inside a scanned supplier name as a wildcard and
 * sweep up bills he never picked.
 *
 * AND THE CEILING IS NOT ALLOWED TO BE SILENT. A capped read that came back full means there are
 * bills this page never looked at, and "filed 40 bills" while eight more sat outside the window is
 * a number he would trust and act on. So it says so and files nothing, which is the one honest
 * answer available: the alternative is a balance that is quietly short.
 */
const BILL_SCAN_LIMIT = 20000;

async function readBillsForOrg(supabase: any, orgId: string): Promise<{ rows: any[] } | { error: string }> {
  const { data, error } = await supabase
    .from("bills")
    .select("id, supplier, supplier_account_id")
    .eq("org_id", orgId)
    .limit(BILL_SCAN_LIMIT);
  if (error) return { error: `Reading your bills didn't go through, so nothing was filed. ${dbError(error)}` };
  const rows = (data ?? []) as any[];
  if (rows.length >= BILL_SCAN_LIMIT) {
    reportError("bills:readBillsForOrg", new Error("bill scan hit its ceiling"), { orgId, limit: BILL_SCAN_LIMIT });
    return {
      error: `You have more than ${BILL_SCAN_LIMIT.toLocaleString("en-US")} bills, which is more than this can file in one go, so nothing was moved. File them from the bill itself for now and tell us - this ceiling is ours to raise.`,
    };
  }
  return { rows };
}

/**
 * ONE SPELLING ONTO ONE ACCOUNT: its unfiled bills move, and the spelling is remembered. The one
 * piece of work shared by "file these bills", the merge review's Accept, and its "Not The Same".
 *
 * The alias is written AFTER the bills move, so a refused alias cannot leave him thinking nothing
 * happened when eight bills just changed hands. Its own failure is reported in the sentence rather
 * than swallowed.
 */
async function fileSpelling(
  supabase: any,
  orgId: string,
  allBills: any[],
  opts: { alias: string; accountId: string; branchLabel: string | null; aliasAlreadyThere?: boolean },
): Promise<{ linked: number; elsewhere: number; aliasSaved: boolean } | { error: string }> {
  const key = spellingKey(opts.alias);
  const matching = allBills.filter((b) => spellingKey(b?.supplier) === key);
  const unfiled = matching.filter((b) => !b.supplier_account_id).map((b) => String(b.id));
  const elsewhere = matching.filter(
    (b) => b.supplier_account_id && String(b.supplier_account_id) !== opts.accountId,
  ).length;

  let linked = 0;
  if (unfiled.length) {
    const { data, error } = await supabase
      .from("bills")
      .update({ supplier_account_id: opts.accountId })
      .in("id", unfiled)
      .eq("org_id", orgId)
      .is("supplier_account_id", null)
      .select("id");
    if (error) return { error: `Filing those didn't go through, so nothing changed. ${dbError(error)}` };
    linked = data?.length ?? 0;
    if (!linked) {
      reportError("bills:fileSpelling", new Error("bulk link wrote no rows"), {
        alias: opts.alias,
        accountId: opts.accountId,
        candidates: unfiled.length,
      });
      return { error: "Those bills didn't move. Reload the page and try again." };
    }
  }

  let aliasSaved = !!opts.aliasAlreadyThere;
  if (!aliasSaved) {
    const { error } = await supabase
      .from("supplier_aliases")
      .insert({
        org_id: orgId,
        supplier_account_id: opts.accountId,
        alias: opts.alias,
        branch_label: opts.branchLabel,
      })
      .select("id");
    aliasSaved = !error || isDuplicateKey(error);
  }

  return { linked, elsewhere, aliasSaved };
}

/**
 * THE SUPPLIER'S OWN INVOICE NUMBER, and whether this document is a STATEMENT.
 *
 * CED's portal names its PDFs `TR-34426_20260616_32136931_15165103264.pdf` - account, date,
 * invoice number, internal id - and the scanner files that whole string in `notes` as a leftover
 * filename while `bill_number` sits empty on every single bill. The documents he imported from
 * email are worse: they are statements carrying several CED invoices at once, their numbers
 * captured by OCR inside LINE DESCRIPTIONS ("Sales Tax 9.00000 (Invoice 8802-1101363)"). Three of
 * them are known to hold two invoices each.
 *
 * So `is_statement` is not a detail. It is the app admitting that this row's total is real while
 * its single invoice number is not the whole story - which is the difference between "I sent CED
 * $4,000" matching something on their books and matching nothing at all.
 */
export async function setBillSupplierInvoice(input: {
  billId: string;
  invoiceNumber?: string | null;
  isStatement?: boolean;
}): Promise<SupplierActionResult> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const org = orgOf(ctx);
  if ("error" in org) return { ok: false, error: org.error };

  const id = String(input?.billId ?? "");
  if (!id) return { ok: false, error: "Couldn't tell which bill you meant." };

  const patch: Record<string, unknown> = {};
  if (input.invoiceNumber !== undefined) patch.supplier_invoice_number = text(input.invoiceNumber);
  if (input.isStatement !== undefined) patch.is_statement = !!input.isStatement;
  if (!Object.keys(patch).length) return { ok: false, error: "Nothing was changed." };

  const { data, error } = await ctx.supabase
    .from("bills")
    .update(patch)
    .eq("id", id)
    .eq("org_id", org.orgId)
    .select("id");
  if (error) return { ok: false, error: `That didn't save, so the bill is unchanged. ${dbError(error)}` };
  if (!data?.length) return { ok: false, error: "That bill isn't here anymore. Reload the page and try again." };

  revalidatePath("/bills");
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE MERGE REVIEW - HIS ANSWER, EITHER WAY
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A proposal's id is the JSON list of the spellings it is about, because the page builds these
 * suggestions fresh on every load and there is no row anywhere to point at. "Not The Same" hands
 * the server nothing but that one string.
 *
 * WHICH IS WHY EVERY SPELLING IS CHECKED AGAINST HIS OWN UNFILED BILLS BEFORE ANYTHING IS WRITTEN.
 * The id is a message from a screen, not a fact: a made-up one buys nobody anything, because a
 * spelling that is not sitting on an unfiled bill of his has nothing to move.
 */
function spellingsInProposalId(proposalId: string): string[] {
  const raw = String(proposalId ?? "");
  if (!raw.startsWith("merge:")) return [];
  try {
    const parsed = JSON.parse(raw.slice("merge:".length));
    if (!Array.isArray(parsed)) return [];
    return parsed.map((x) => String(x ?? "").trim()).filter(Boolean);
  } catch {
    return [];
  }
}

const staleProposal = "That suggestion is out of date - those bills have moved since this page loaded. Reload and look again.";

/**
 * ACCEPT: these spellings are one account. Make it (or join the one he already has), remember
 * every spelling, and file every bill that carries one of them onto it.
 *
 * The NAME comes from his sheet, not from our guess. He may well accept the grouping and reject
 * the name we suggested for it, and supplier_accounts.name is what he will read on this card for
 * the next five years.
 *
 * NOTHING IS RENAMED, TAKEN OFF A JOB, OR DELETED. Each bill keeps the spelling it was scanned
 * with and the job it is on; only `supplier_account_id` moves. The branch label rides along with
 * the alias, so the price book can still tell a Sunnyvale counter from a Truckee one instead of
 * quietly averaging two markets.
 */
export async function acceptSupplierMerge(input: {
  proposalId: string;
  name: string;
  accountNumber: string | null;
  existingAccountId: string | null;
  spellings: { alias: string; branchLabel: string | null }[];
}): Promise<SupplierActionResult> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const org = orgOf(ctx);
  if ("error" in org) return { ok: false, error: org.error };
  const supabase = ctx.supabase;

  const name = text(input?.name);
  if (!name) return { ok: false, error: "Give the account a name you will recognise, like CED Truckee." };

  const wanted = (input?.spellings ?? []).map((s) => ({ alias: String(s?.alias ?? "").trim(), branchLabel: text(s?.branchLabel) })).filter((s) => s.alias);
  if (!wanted.length) return { ok: false, error: "There are no supplier names in that suggestion. Reload the page." };

  const bills = await readBillsForOrg(supabase, org.orgId);
  if ("error" in bills) return { ok: false, error: bills.error };

  // EVERY REFUSAL BEFORE THE FIRST WRITE. A spelling already saved under a different supplier is a
  // contradiction only he can settle, and finding it halfway through would leave him with an
  // account holding some of the bills and a sentence about why the rest stayed put.
  const existingId = input?.existingAccountId ? String(input.existingAccountId) : null;
  const aliasRows = await readAliases(supabase, org.orgId);
  for (const s of wanted) {
    const owner = ownerOf(aliasRows, s.alias);
    if (owner && owner.accountId !== existingId) return { ok: false, error: aliasTakenSentence(s.alias, owner.name) };
  }
  if (!bills.rows.some((b) => !b.supplier_account_id && wanted.some((s) => spellingKey(s.alias) === spellingKey(b.supplier)))) {
    return { ok: false, error: staleProposal };
  }

  // THE NAME IN THE SENTENCE IS THE ACCOUNT'S, NOT THE BOX'S. Joining an existing account does not
  // rename it - he pressed "file them there", not "rename it" - so a name he edited in the sheet
  // before accepting must not come back out of the server as if it had been saved.
  let accountName = name;
  let accountId = existingId;
  if (accountId) {
    const found = await readAccount(supabase, org.orgId, accountId);
    if ("error" in found) return { ok: false, error: found.error };
    accountName = found.name;
  } else {
    const made = await makeAccount(supabase, org.orgId, ctx.userId, {
      name,
      accountNumber: text(input?.accountNumber),
      branchCode: null,
      onAccount: true,
      note: null,
    });
    if ("error" in made) return { ok: false, error: made.error };
    accountId = made.id;
  }

  let linked = 0;
  const forgotten: string[] = [];
  for (const s of wanted) {
    const moved = await fileSpelling(supabase, org.orgId, bills.rows, {
      alias: s.alias,
      accountId,
      branchLabel: s.branchLabel,
    });
    // ONE SPELLING FAILING DOES NOT UNDO THE OTHERS. They are separate writes against separate
    // rows, and the account is already real - so the ones that landed are reported as landed and
    // the ones that did not are named, rather than a single "something went wrong" over the lot.
    if ("error" in moved) {
      return {
        ok: false,
        error: `${moved.error}${linked ? ` ${plural(linked, "bill", "bills")} had already been filed under ${accountName}.` : ""}`,
      };
    }
    linked += moved.linked;
    if (!moved.aliasSaved) forgotten.push(s.alias);
  }

  const tail = forgotten.length
    ? ` ${sayList(forgotten.map((f) => `"${f}"`))} didn't save as ${forgotten.length === 1 ? "a name" : "names"}, so ${forgotten.length === 1 ? "a receipt" : "receipts"} that ${forgotten.length === 1 ? "says" : "say"} that will land unfiled again.`
    : "";

  revalidatePath("/bills");
  return {
    ok: true,
    message: `${accountName} is one account now, holding ${plural(linked, "bill", "bills")}.${tail}`,
  };
}

/**
 * NOT THE SAME: these spellings are separate suppliers, and they must stop being offered as one.
 *
 * A DISMISSAL HAS TO STICK, and the only way to make one stick in this schema is to make it TRUE:
 * each spelling becomes an account of its own, holding its own bills, with its own name. The
 * suggestion never comes back because there is nothing left unfiled for it to be about, and the
 * card's own words for this press are exactly what happens - "They stay separate suppliers".
 *
 * NOTHING IS MERGED AND NOTHING IS LOST. Every account is named the spelling he was looking at,
 * every bill keeps its job and its scanned name, and each balance is visible on the card the
 * moment the page comes back. There is no hidden "set aside" list for him to lose track of.
 *
 * (What this does NOT have is a way back: the day he changes his mind there is no door on this
 * card that joins two accounts he already has. That door is a handoff, not a silence - the
 * accounts and their money are in plain sight either way.)
 */
export async function dismissSupplierMerge(proposalId: string): Promise<SupplierActionResult> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const org = orgOf(ctx);
  if ("error" in org) return { ok: false, error: org.error };
  const supabase = ctx.supabase;

  const spellings = spellingsInProposalId(proposalId);
  if (!spellings.length) return { ok: false, error: "Couldn't tell which suggestion you meant. Reload the page." };

  const bills = await readBillsForOrg(supabase, org.orgId);
  if ("error" in bills) return { ok: false, error: bills.error };

  const live = spellings.filter((alias) =>
    bills.rows.some((b) => !b.supplier_account_id && spellingKey(b.supplier) === spellingKey(alias)),
  );
  if (!live.length) return { ok: false, error: staleProposal };

  const aliasRows = await readAliases(supabase, org.orgId);
  const kept: string[] = [];
  const takenOff: string[] = [];
  for (const alias of live) {
    const owner = ownerOf(aliasRows, alias);

    // THE SPELLING IS ALREADY SAVED UNDER SOMEBODY. That is precisely what he is pressing "no" to
    // on this row - the card is offering to file these bills onto that account BECAUSE the name is
    // saved there. Leaving the name where it is would file them there anyway, which is the same
    // thing Accept does, and two buttons that do one thing teach him nothing. So the name comes
    // off that account first. Its own bills, already filed, do not move: the link lives on the
    // bill's row, and only the NEXT scan of this spelling is changed by this.
    //
    // The one case where nothing comes off: the account it is saved under IS this spelling, which
    // means it already is a supplier of its own and there is nothing to keep apart.
    const alreadyItsOwn = !!owner && spellingKey(owner.name) === spellingKey(alias);
    if (owner && !alreadyItsOwn) {
      // THE ONLY DELETE IN THIS WAVE, AND IT WAS NOT CHECKING ITS ROWS (review, 2026-09-19). A
      // zero-row delete is a 204: an RLS refusal or a stale aliasId came back as success, and two
      // sentences downstream then told Erik the spelling had been taken off an account it was still
      // attached to. The silent-write law, at the one write that can quietly put a supplier's money
      // back where he just moved it from.
      const { data: detached, error: detachErr } = await supabase
        .from("supplier_aliases")
        .delete()
        .eq("id", owner.aliasId)
        .eq("org_id", org.orgId)
        .select("id");
      if (detachErr || !detached?.length) {
        if (!detachErr) {
          reportError("supplier:detachAlias:zero-rows", new Error("alias delete matched no row"), {
            aliasId: owner.aliasId,
            alias,
            account: owner.name,
          });
        }
        return {
          ok: false,
          // WHAT ALREADY LANDED GETS NAMED (review, 2026-09-19). This loop runs one spelling at a
          // time, so a failure on the third had been reporting "nothing was changed" over two
          // spellings that really had moved - sending him to look for work the app had already
          // done. Same shape acceptSupplierMerge uses when it stops halfway.
          error:
            `Taking "${alias}" off ${owner.name} didn't go through${detachErr ? `. ${dbError(detachErr)}` : ", so it is still filed there."}` +
            (takenOff.length ? ` Already done: took ${sayList(takenOff)}.` : " Nothing was changed."),
        };
      }
      takenOff.push(`"${alias}" off ${owner.name}`);
    }

    let accountId = alreadyItsOwn ? owner.accountId : null;
    if (!accountId) {
      const made = await makeAccount(supabase, org.orgId, ctx.userId, {
        name: alias,
        accountNumber: null,
        branchCode: null,
        onAccount: true,
        note: null,
      });
      if ("error" in made) return { ok: false, error: made.error };
      accountId = made.id;
    }

    const moved = await fileSpelling(supabase, org.orgId, bills.rows, {
      alias,
      accountId,
      branchLabel: null,
      aliasAlreadyThere: alreadyItsOwn,
    });
    if ("error" in moved) return { ok: false, error: moved.error };
    kept.push(alreadyItsOwn ? owner.name : alias);
  }

  const detached = takenOff.length ? ` Took ${sayList(takenOff)}.` : "";

  revalidatePath("/bills");
  return {
    ok: true,
    message:
      (kept.length === 1
        ? `Kept apart: ${kept[0]} is a supplier of its own now, with its own balance.`
        : `Kept apart: ${sayList(kept)} are separate suppliers now, each with its own balance.`) + detached,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE SAME TICKET, FILED TWICE
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** A duplicate group's id carries both bill ids, because Undo is handed nothing else. */
function billIdsInGroupId(groupId: string): string[] {
  const raw = String(groupId ?? "");
  if (!raw.startsWith("dup:")) return [];
  try {
    const parsed = JSON.parse(raw.slice("dup:".length));
    if (!Array.isArray(parsed)) return [];
    return parsed.map((x) => String(x ?? "").trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * HE PICKS WHICH JOB KEEPS THE TICKET.
 *
 * An identical CED ticket - $95.27, eight lines, line for line to the penny - is filed to BOTH
 * "13631 Northwoods" and "85 Whitney Place", so one of those jobs is carrying a cost that is not
 * its own and its profit is wrong by exactly that much. Which copy is real is ERIK'S KNOWLEDGE: he
 * was on those jobs. The app only ever asked.
 *
 * NOTHING IS DELETED. The other copy is marked superseded by the one he kept (0271), which is the
 * column built for exactly this: "a superseded bill keeps its lines and its history and stops
 * counting, so the same purchase is never counted twice". Both rows stay in the bills list, where
 * he can still open, edit or remove either one himself.
 */
export async function resolveDuplicateBill(input: {
  groupId: string;
  keepBillId: string;
  duplicateBillIds: string[];
}): Promise<SupplierActionResult> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const org = orgOf(ctx);
  if ("error" in org) return { ok: false, error: org.error };
  const supabase = ctx.supabase;

  const keepBillId = String(input?.keepBillId ?? "");
  const inGroup = billIdsInGroupId(input?.groupId);
  const losers = (input?.duplicateBillIds ?? [])
    .map((x) => String(x ?? ""))
    .filter((id) => id && id !== keepBillId && (!inGroup.length || inGroup.includes(id)));
  if (!keepBillId || !losers.length) return { ok: false, error: "Couldn't tell which copy you picked. Reload the page." };
  if (inGroup.length && !inGroup.includes(keepBillId)) {
    return { ok: false, error: "That copy isn't part of this pair. Reload the page and pick again." };
  }

  // The kept copy is read first: superseding a bill onto an id that is not this shop's would point
  // a row at a row nobody here can see.
  const { data: keeper, error: keeperErr } = await supabase
    .from("bills")
    .select("id, amount, job_id, jobs(name)")
    .eq("id", keepBillId)
    .eq("org_id", org.orgId)
    .maybeSingle();
  if (keeperErr) return { ok: false, error: `Looking that bill up didn't go through, so nothing changed. ${dbError(keeperErr)}` };
  if (!keeper) return { ok: false, error: "That bill isn't here anymore. Reload the page." };

  const { data: moved, error } = await supabase
    .from("bills")
    .update({ superseded_by_bill_id: keepBillId })
    .in("id", losers)
    .eq("org_id", org.orgId)
    .is("superseded_by_bill_id", null)
    .select("id, job_id, jobs(name)");
  if (error) return { ok: false, error: `That didn't save, so both copies still count. ${dbError(error)}` };
  if (!moved?.length) return { ok: false, error: "Someone else just sorted that one out. Reload the page." };

  const movedIds = (moved as any[]).map((m) => String(m.id));

  /**
   * THE CLAIM FOLLOWS THE COST (review, 2026-09-20). 0277 made `bill_supplier_invoices` the
   * sentence "this purchase is already covered", and from this write on the copy that counts is
   * the keeper. Left sitting on the copy he set aside, that link names a bill every cost reader in
   * the app deliberately ignores: the reconcile card stops asking for an invoice nothing carries,
   * and Record It As A Bill refuses with the set-aside copy's job in the refusal - with no way
   * forward, because 0277 is unique on the invoice so a corrective link could never be written.
   *
   * It is safe against both indexes: unique on the INVOICE alone means at most one row exists per
   * supplier invoice, so the keeper cannot already be holding a row this one would collide with.
   *
   * ZERO ROWS IS NORMAL HERE, not a refusal - most duplicate pairs are two phone photographs with
   * no supplier document behind either of them. Only an error is worth saying, and even then the
   * supersede has landed and the money is already right, so it is a sentence and not a failure.
   *
   * PUT BACK DOES NOT CARRY IT HOME AGAIN, and that is deliberate rather than forgotten: which
   * copy the supplier's invoice was tied to before is written down nowhere, and after an undo both
   * copies count anyway, so the tie is sitting on a real live bill either way and not a dollar
   * moves. Guessing it back would be the app inventing a fact nobody wrote.
   */
  const { error: relinkErr } = await supabase
    .from("bill_supplier_invoices")
    .update({ bill_id: keepBillId })
    .in("bill_id", movedIds)
    .eq("org_id", org.orgId)
    .select("id");
  if (relinkErr) reportError("bills:resolveDuplicate.relink", relinkErr, { keepBillId, losers: movedIds });

  /**
   * AND A COPY HE SETS ASIDE MAY ALREADY BE ON A CUSTOMER'S BILL (review, 2026-09-20).
   *
   * Both of his $95.27 CED copies are: 8ce93d0a rides on INV-050 (paid, 13631 Northwoods) and
   * 31b489e4 on INV-061 (paid, 85 Whitney Place), eight lines each. Setting one aside is still the
   * right move and the COST should stop counting - but what he CHARGED for it does not stop, so
   * the job keeps $119.09 of revenue for a $95.27 purchase the app now calls a duplicate, and its
   * margin moves by both numbers with nothing on any screen accounting for it.
   *
   * The receipt card two components over already says this sentence on a claimed receipt. It
   * cannot say it here: after this write that card no longer renders the bill at all. So the
   * action that moves the money is the last place left to say it out loud.
   *
   * It reads the claim exactly the way the Bills page builds `billedOn` - by the LOSING copies'
   * jobs, both claim shapes, skipping voided invoices - so the two agree word for word. A read
   * that fails leaves the sentence off and nothing else changes, which is yesterday's behaviour
   * rather than a refusal over a supersede that has already landed.
   */
  const claimants = new Map<string, string>();
  const lostJobIds = [...new Set((moved as any[]).map((m) => m.job_id).filter(Boolean))].map(String);
  if (lostJobIds.length) {
    const lost = new Set(movedIds);
    const { data: claimRows, error: claimErr } = await supabase
      .from("invoice_items")
      .select("import_key, source_ids, invoices!inner(invoice_number, status, job_id)")
      .in("invoices.job_id", lostJobIds)
      .neq("invoices.status", "void")
      .limit(5000);
    if (claimErr) reportError("bills:resolveDuplicate.claims", claimErr, { billIds: movedIds });
    for (const r of (claimRows ?? []) as any[]) {
      const claims = claimedIdsOfLines([{ import_key: r.import_key, source_ids: r.source_ids }]);
      if (!claims.some((id) => lost.has(id))) continue;
      const label = String(r.invoices?.invoice_number || "an invoice");
      if (!claimants.has(label)) claimants.set(label, String(r.invoices?.status ?? ""));
    }
  }
  // A DRAFT IS NOT A BILL HE SENT. Its lines are still his to edit, so the way back is the invoice
  // itself; on one that has gone out the only way back is a credit. Same split the receipt card
  // and the invoice page both make, in the same words.
  const sent = [...claimants].filter(([, status]) => status !== "draft").map(([label]) => label);
  const drafts = [...claimants].filter(([, status]) => status === "draft").map(([label]) => label);
  // A group can hold more than two copies, so the sentence has to count them. "That copy is" over
  // three set-aside tickets reads like a different, smaller fact than the one that happened.
  const thatCopy = movedIds.length > 1 ? "Those copies are" : "That copy is";
  const alsoBilled =
    (sent.length
      ? ` ${thatCopy} already billed to the customer on ${sayList(sent)}: the cost stops counting, but what you charged for it does not. To give that back, use Credit / Refund in the Actions menu on the invoice.`
      : "") +
    (drafts.length
      ? ` ${thatCopy} on ${sayList(drafts)}, still a draft, so take its lines off there if you do not want to charge for it.`
      : "");

  const keptOn = (keeper as any).jobs?.name ?? "no job";
  const droppedOn = sayList([...new Set((moved as any[]).map((m) => m.jobs?.name ?? "no job"))]);
  const amount = sayMoney(money((keeper as any).amount));

  revalidatePath("/bills");
  if ((keeper as any).job_id) revalidatePath(`/jobs/${(keeper as any).job_id}`);
  for (const m of moved as any[]) if (m.job_id) revalidatePath(`/jobs/${m.job_id}`);

  return {
    ok: true,
    message:
      `Kept the ${amount} ticket on ${keptOn}. The copy on ${droppedOn} stops counting against that job and stays on your bills list.` +
      alsoBilled +
      (relinkErr
        ? " The supplier's own invoice is still tied to the copy you set aside, so that list may keep asking for it."
        : ""),
  };
}

/** PUT IT BACK. A pick on a phone can be a mis-tap, and a $95.27 decision that cannot be undone is
 *  a one-way door on a page full of money. Both copies count again, exactly as before. */
export async function unresolveDuplicateBill(groupId: string): Promise<SupplierActionResult> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const org = orgOf(ctx);
  if ("error" in org) return { ok: false, error: org.error };

  const ids = billIdsInGroupId(groupId);
  if (!ids.length) return { ok: false, error: "Couldn't tell which pair you meant. Reload the page." };

  const { data, error } = await ctx.supabase
    .from("bills")
    .update({ superseded_by_bill_id: null })
    .in("id", ids)
    .in("superseded_by_bill_id", ids)
    .eq("org_id", org.orgId)
    .select("id, job_id");
  if (error) return { ok: false, error: `That didn't go back. ${dbError(error)}` };
  if (!data?.length) return { ok: false, error: "That pair is already back the way it was. Reload the page." };

  revalidatePath("/bills");
  for (const row of data as any[]) if (row.job_id) revalidatePath(`/jobs/${row.job_id}`);
  return { ok: true, message: "Put back. Both copies count again, the way they did before." };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// MONEY OUT
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * RECORD A CHUNK SENT TO A SUPPLIER. An AMOUNT, not a tick:
 *
 *   "yes i pay them in chunks that never match the ticckets"
 *
 * It lands on the ACCOUNT, never on a bill, and it flips no bill's status. Owed is then the
 * account's unpaid bills minus its live payments, and a $4,000 cheque against $5,570.56 of tickets
 * says exactly what it should: $1,570.56 to go. A "Mark Paid" tick could only ever have said one
 * ticket is square, which is a thing he has never once done.
 */
export async function recordSupplierPayment(input: {
  accountId: string;
  amount: number | string;
  paidOn?: string | null;
  method?: string | null;
  reference?: string | null;
  note?: string | null;
}): Promise<SupplierActionResult> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const org = orgOf(ctx);
  if ("error" in org) return { ok: false, error: org.error };
  const supabase = ctx.supabase;

  const accountId = String(input?.accountId ?? "");
  if (!accountId) return { ok: false, error: "Pick which supplier this went to first." };

  const amount = money(input?.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, error: "Type how much you sent them. A payment has to be more than $0." };
  }
  // numeric(12,2) tops out at ten digits before the point. A number bigger than that is a typo, and
  // "numeric field overflow" is not a sentence anybody can act on.
  if (amount > 99_999_999.99) return { ok: false, error: "That amount is bigger than this field can hold. Check the number." };

  const method: SupplierPayMethod = isPayMethod(input?.method) ? input.method : "check";

  let paidOn = String(input?.paidOn ?? "").trim();
  if (paidOn && !/^\d{4}-\d{2}-\d{2}$/.test(paidOn)) {
    return { ok: false, error: "That date didn't read right. Use the date picker." };
  }
  if (!paidOn) paidOn = await orgToday(supabase);

  const account = await readAccount(supabase, org.orgId, accountId);
  if ("error" in account) return { ok: false, error: account.error };

  const { data: inserted, error: insErr } = await supabase
    .from("supplier_payments")
    .insert({
      org_id: org.orgId,
      supplier_account_id: accountId,
      amount,
      paid_on: paidOn,
      method,
      reference: text(input?.reference),
      note: text(input?.note),
      created_by: ctx.userId,
    })
    .select("id");
  if (insErr) return { ok: false, error: `That payment didn't save, so nothing was recorded. ${dbError(insErr)}` };
  if (!inserted?.length) {
    reportError("bills:recordSupplierPayment", new Error("supplier payment insert wrote no rows"), {
      accountId,
      amount,
      paidOn,
    });
    return { ok: false, error: "That payment didn't save, so nothing was recorded. Try it again." };
  }

  // PAYING A PAY-AT-THE-REGISTER SUPPLIER IS NOT AN ERROR, it is a fact worth stating. Those carry
  // no running balance by design, so a payment recorded against one would otherwise drop out of
  // sight with no explanation - the silent half of a dead end.
  const offAccount = account.onAccount
    ? ""
    : ` ${account.name} is set to pay at the register, so this is recorded but there is no running balance for it to come off.`;

  revalidatePath("/bills");
  // My Day's "Pay CED $X By Oct 10" reads this payment (supplier-pay-due.ts): paying clears it.
  revalidatePath("/planner");
  return {
    ok: true,
    paymentId: String(inserted[0].id),
    message: `Recorded ${sayMoney(amount)} to ${account.name}.${offAccount}`,
  };
}

/**
 * UNDO A PAYMENT. Voided, never deleted - the undo-trail law, and the same shape every other money
 * row in this app takes: the row stays on the screen, crossed out, and stops counting. A deleted
 * payment is a balance that changed with nothing on the page to explain it.
 */
export async function voidSupplierPayment(paymentId: string): Promise<SupplierActionResult> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const org = orgOf(ctx);
  if ("error" in org) return { ok: false, error: org.error };
  const supabase = ctx.supabase;

  const id = String(paymentId ?? "");
  if (!id) return { ok: false, error: "Couldn't tell which payment you meant." };

  const { data: row } = await supabase
    .from("supplier_payments")
    .select("id, amount, voided_at, supplier_accounts(name)")
    .eq("id", id)
    .eq("org_id", org.orgId)
    .maybeSingle();
  if (!row) return { ok: false, error: "That payment isn't here anymore. Reload the page." };
  if ((row as { voided_at?: string | null }).voided_at) {
    return { ok: false, error: "That payment is already voided, so there is nothing to undo." };
  }

  // `.is("voided_at", null)` claims the void, so a second tap on a slow connection reports the
  // truth instead of a second success.
  const { data, error } = await supabase
    .from("supplier_payments")
    .update({ voided_at: new Date().toISOString() })
    .eq("id", id)
    .eq("org_id", org.orgId)
    .is("voided_at", null)
    .select("id");
  if (error) return { ok: false, error: `That void didn't go through, so the payment still stands. ${dbError(error)}` };
  if (!data?.length) return { ok: false, error: "Someone else just voided that payment. Reload the page." };

  const amount = money((row as { amount?: unknown }).amount);
  const name = (row as { supplier_accounts?: { name?: string } | null }).supplier_accounts?.name ?? "that supplier";

  revalidatePath("/bills");
  revalidatePath("/planner"); // a voided payment puts My Day's Pay By line back
  return {
    ok: true,
    message: `Voided the ${sayMoney(amount)} payment to ${name}. It stays on the list and goes back onto what you owe.`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// IS THIS PURCHASE ALREADY IN HIS BOOKS? (audit v994, DB1)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * THE BILLS A SUPPLIER DOCUMENT MAY ALREADY BE, read the way the /bills page reads them.
 *
 * The page lists a document under Purchases Not In Your Books with Same Purchase: Tie Them beside
 * each candidate, and these actions refuse or accept on the SAME candidates, recomputed here from
 * the database: a client's say-so never ties anything. `null` is a read that failed, which is
 * never "no bill": the caller refuses instead of writing.
 */
async function samePurchaseFor(
  supabase: any,
  orgId: string,
  doc: SupplierDoc,
): Promise<{ candidates: SamePurchaseCandidate[] } | null> {
  const [billsRes, docsRes, linksRes, aliasRes] = await Promise.all([
    supabase
      .from("bills")
      .select("id, supplier, supplier_account_id, bill_number, supplier_invoice_number, amount, bill_date, job_id, is_statement, notes, jobs(job_number, name), bill_line_items(description)")
      .eq("org_id", orgId)
      .is("superseded_by_bill_id", null)
      .limit(5000),
    supabase.from("supplier_invoices").select("id, invoice_number, supplier_account_id, job_id, total, invoice_date").eq("org_id", orgId).limit(5000),
    supabase.from("bill_supplier_invoices").select("bill_id, supplier_invoice_id").eq("org_id", orgId).limit(5000),
    supabase.from("supplier_aliases").select("alias, supplier_account_id").eq("org_id", orgId).limit(5000),
  ]);
  if (billsRes?.error || docsRes?.error || linksRes?.error) return null;
  const bills: LedgerBill[] = ((billsRes?.data ?? []) as any[]).map((b) => {
    const named = namedNumbersOf(b);
    return { ...b, is_statement: !!b.is_statement || named.isStatement, named_numbers: named.numbers };
  });
  const aliases = indexSupplierAliases(aliasRes?.error ? [] : (aliasRes?.data ?? []));
  const covered = billsCoveredByDocuments(bills, (docsRes?.data ?? []) as SupplierDoc[], (linksRes?.data ?? []) as any[], aliases);
  return { candidates: samePurchaseCandidates(doc, bills, covered, aliases) };
}

/**
 * SAME PURCHASE: TIE THEM. The supplier's own document and a bill already in his books are one
 * purchase; a person says so, and this writes the link (bill_supplier_invoices, 0273/0277) and
 * nothing else. No money moves and no bill is written: the cost was already on the job.
 *
 * The CED counter ticket is why this exists. It carries a sales-order number (8802-SO-257555) and
 * CED's invoice for the same breakers carries 8802-11xxxxx, so no number check can ever join them,
 * and the only way out the card offered was Record It As A Bill: a second $323.71 on J-011 and a
 * second import onto Andrew's invoice. The bill must be one this document is actually offered
 * (samePurchaseFor, recomputed here): the same number, or the same account, job, and a total and
 * date within a few dollars and days.
 */
export async function tieSupplierInvoiceToBill(input: { invoiceId: string; billId: string }): Promise<SupplierActionResult> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const org = orgOf(ctx);
  if ("error" in org) return { ok: false, error: org.error };
  const invoiceId = String(input?.invoiceId ?? "");
  const billId = String(input?.billId ?? "");
  if (!invoiceId || !billId) return { ok: false, error: "Couldn't tell which invoice and bill you meant. Nothing was tied." };

  const { data: inv, error: readErr } = await ctx.supabase
    .from("supplier_invoices")
    .select("id, invoice_number, kind, invoice_date, job_id, supplier_account_id, total")
    .eq("id", invoiceId)
    .eq("org_id", org.orgId)
    .maybeSingle();
  if (readErr) return { ok: false, error: `Couldn't read that invoice just now, so nothing was tied. ${dbError(readErr)}` };
  if (!inv) return { ok: false, error: "That invoice isn't here anymore. Reload the page." };
  const number = text((inv as any).invoice_number) ?? "That invoice";
  if (String((inv as any).kind ?? "invoice") !== "invoice")
    return { ok: false, error: `${number} isn't a purchase, so there is no bill to tie it to. Nothing was tied.` };

  const found = await samePurchaseFor(ctx.supabase, org.orgId, inv as SupplierDoc);
  if (!found) return { ok: false, error: `Couldn't check your bills just now, so ${number} was not tied. Try again.` };
  const hit = found.candidates.find((c) => c.billId === billId);
  if (!hit)
    return {
      ok: false,
      error: `That bill isn't one ${number} could be: not the same number, or not the same account, job, total and date. Nothing was tied.`,
    };

  const { data: joined, error: joinErr } = await ctx.supabase
    .from("bill_supplier_invoices")
    .insert({ org_id: org.orgId, bill_id: billId, supplier_invoice_id: invoiceId })
    .select("id");
  if (joinErr && isDuplicateKey(joinErr)) {
    // 0277: this document is already covered. Say by which bill rather than guessing.
    const { data: existing } = await ctx.supabase
      .from("bill_supplier_invoices")
      .select("bill_id")
      .eq("org_id", org.orgId)
      .eq("supplier_invoice_id", invoiceId)
      .limit(1);
    const on = String((existing?.[0] as { bill_id?: string } | undefined)?.bill_id ?? "");
    revalidatePath("/bills");
    return on === billId
      ? { ok: true, message: `${number} was already tied to that bill. Nothing changed.` }
      : { ok: false, error: `${number} is already tied to a different bill, so it was left alone. Reload the page to see which.` };
  }
  if (joinErr) return { ok: false, error: `That didn't save, so ${number} is not tied. ${dbError(joinErr)}` };
  if (!joined?.length) return { ok: false, error: `That didn't save, so ${number} is not tied. Try it again.` };

  revalidatePath("/bills");
  if (hit.jobId) revalidatePath(`/jobs/${hit.jobId}`);
  return {
    ok: true,
    message: `${number} is tied to ${hit.label}. It was already in your books, so nothing was charged twice, and it stops asking.`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE SUPPLIER'S OWN INVOICES - putting one on a job
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * WHICH JOB A SUPPLIER INVOICE BELONGS TO, ANSWERED BY THE PERSON WHO WAS THERE.
 *
 * CED prints a JOB NAME on every invoice and it is very nearly his own: 13631 NORTHWOODS, 85
 * WHITNEY PLACE, 13683 HILLSIDE. Very nearly is not the same as exactly, and the gap is where a
 * machine would put money on the wrong job. The same road comes back as "5659 RHODESIA", "561
 * RHODESIA", "5661 RHODESIA" and "5659 RODESSIA", and he has FIVE separate jobs on it. "235 TIMBER
 * CREEK" matches two. "STOCK" matches none and never should - he has been telling his supplier
 * what is shop stock for months, and it is not a job at all.
 *
 * So the app ranks and the man decides, and this is the write that records his answer.
 *
 * IT WAS THE MISSING HALF OF THE WHOLE FEATURE (review, 2026-09-19). The card that asks the
 * question was built, the ranking that orders the choices was built and tested, and the page gated
 * all of it behind `!!actions.setInvoiceJob` - which nothing implemented and nothing passed, so
 * every one of those screens was unreachable in every state of the data. Two waves running have
 * now shipped a feature that compiled and was never called.
 */
export async function setSupplierInvoiceJob(input: {
  invoiceId: string;
  jobId: string;
}): Promise<SupplierActionResult> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const org = orgOf(ctx);
  if ("error" in org) return { ok: false, error: org.error };

  const invoiceId = String(input?.invoiceId ?? "");
  const jobId = String(input?.jobId ?? "");
  if (!invoiceId) return { ok: false, error: "Couldn't tell which invoice you meant." };
  if (!jobId) return { ok: false, error: "Pick a job first." };

  // The job has to be HIS. A job id is a uuid a client hands us, and the one thing worse than an
  // invoice on no job is an invoice on another company's job (the tenant-isolation law: a rule at
  // one read path is a convention, a check here is a boundary).
  const { data: job } = await ctx.supabase
    .from("jobs")
    .select("id, name, job_number")
    .eq("id", jobId)
    .eq("org_id", org.orgId)
    .maybeSingle();
  if (!job) return { ok: false, error: "That job isn't here anymore. Reload the page." };

  const { data, error } = await ctx.supabase
    .from("supplier_invoices")
    .update({ job_id: jobId })
    .eq("id", invoiceId)
    .eq("org_id", org.orgId)
    .select("id, invoice_number, supplier_account_id, total, invoice_date");
  if (error) return { ok: false, error: `That didn't save, so the invoice still has no job. ${dbError(error)}` };
  // Silent-write law: a zero-row update is a 204, and an invoice silently left unassigned is money
  // sitting on no job while the screen says it landed.
  if (!data?.length) return { ok: false, error: "That invoice isn't here anymore. Reload the page." };

  const number = (data[0] as { invoice_number?: string }).invoice_number ?? "That invoice";
  const label = (job as { job_number?: string | null; name?: string | null }).name
    ?? (job as { job_number?: string | null }).job_number
    ?? "that job";

  /**
   * "ITS COST COUNTS THERE" WAS NOT TRUE (review, 2026-09-19). Filing a supplier invoice to a job
   * writes one column on `supplier_invoices`, and nothing anywhere adds that table into a job's
   * cost, its margin or its unbilled work - only `bills` do. He would file $301.81 onto a job,
   * read a sentence saying the cost had landed, open the job and find every figure unchanged.
   *
   * What makes the cost land is the bill, so the sentence now says which step is next - and only
   * when there IS a next step, because a document that already has a bill against it shows no
   * button and copy must never point at a control that is not on the screen.
   */
  // A SET-ASIDE COPY IS NOT "IN YOUR BOOKS" (review, 2026-09-20). Every cost reader in the app
  // ignores a superseded bill (0271), so a link pointing at one would have this sentence tell him
  // the cost had landed while the job carried none of it. resolveDuplicateBill now moves the link
  // onto the keeper, which is the real fix; this filter is what makes the guard true for any link
  // written before that, and for any copy set aside by hand.
  const { data: billLinks } = await ctx.supabase
    .from("bill_supplier_invoices")
    .select("bill_id, bills(superseded_by_bill_id)")
    .eq("org_id", org.orgId)
    .eq("supplier_invoice_id", invoiceId)
    .limit(5);
  // Read back and judged here rather than filtered in the query: one row, at most, comes back
  // (0277 is unique on the invoice), and a set-aside copy is a fact about the bill the link names,
  // not about the link. A missing embed reads as "no live bill", which is the safe lean - it
  // offers him the next step instead of telling him a cost has landed.
  const hasLiveBill = ((billLinks ?? []) as any[]).some((r) => r?.bills && !r.bills.superseded_by_bill_id);

  // ALREADY ON THE BOOKS, BY ANOTHER NAME (audit v994, DB1). A bill on this job that carries this
  // number, or a counter ticket on this account for the same money a few days apart, may be this
  // very purchase. Said now, so "Record It As A Bill is next" is never the only thing he hears
  // about a purchase that is already on the job. A read that fails says only the next step.
  let maybe: SamePurchaseCandidate | null = null;
  if (!hasLiveBill) {
    try {
      const row = data[0] as any;
      const found = await samePurchaseFor(ctx.supabase, org.orgId, {
        id: invoiceId,
        invoice_number: row.invoice_number ?? null,
        supplier_account_id: row.supplier_account_id ?? null,
        job_id: jobId,
        total: row.total ?? null,
        invoice_date: row.invoice_date ?? null,
      });
      maybe = found?.candidates[0] ?? null;
    } catch (e) {
      reportError("bills:setInvoiceJob.samePurchase", e, { invoiceId });
    }
  }

  revalidatePath("/bills");
  return {
    ok: true,
    // A BILL CARRYING THIS NUMBER IS NOT A QUESTION (review of audit v994's fix). /bills counts
    // that bill as covering the invoice (billsCarryingNumber), so the invoice is never listed under
    // Purchases Not In Your Books and neither Tie nor Different Purchase is on the screen. Say
    // what is already true and name no button; the two buttons are only for a near match.
    message: hasLiveBill
      ? `${number} is on ${label} now, and its bill is already in your books.`
      : maybe?.exact
        ? `${number} is on ${label} now, and a bill already carries its number: ${maybe.label}.`
        : maybe
          ? `${number} is on ${label} now. ${samePurchaseSentence(maybe)} If it is, press Same Purchase: Tie Them on it down in Purchases Not In Your Books; if not, Different Purchase: Record It Anyway puts the cost on the job.`
          : `${number} is on ${label} now. Record It As A Bill, down in Purchases Not In Your Books, is what puts the cost on the job.`,
  };
}

/**
 * THE SUPPLIER'S OWN INVOICE, WRITTEN INTO HIS BOOKS AS A BILL (2026-09-19).
 *
 * He asked me to do this by hand:
 *
 *   "since you have all the files could you please upload that final bill for 223.29"
 *
 * He had to ask because `recordAsBill` was typed on the card, rendered if it was passed, and
 * nothing anywhere implemented it or passed it - the same failure as `setInvoiceJob` one wave
 * earlier, on the same card. Eleven more CED invoices are sitting in that list, including the
 * $523.47 on TTP56 he is about to bill, and every one of them was a message to me.
 *
 * A BILL FROM A SUPPLIER INVOICE IS NOT A SCAN. Everything else in `bills` arrived as a photograph
 * read by a language model. This arrives from the supplier's own file: their number, their date,
 * their line prices, their totals. So `pricing_provisional` is false on purpose - these ARE the
 * prices his account pays, and they are the antidote to the Sunnyvale counter preview that 0271
 * had to fence off.
 *
 * THE EXTENSION IS THE PRICE (0274, found doing his TTP 106 bill by hand two hours ago). CED
 * prints a one-gang decora plate as "50.00" with a C beside it - fifty dollars per HUNDRED - and
 * 93 of the 227 lines on his invoices are priced per hundred or per thousand. `bill_line_items`
 * has nowhere to put that letter and every money path in the app reads the EXTENSION, so the
 * conversion happens here, once: a line's unit price is what its own extension divided by its own
 * quantity says it is. No divisor is chosen, no letter is trusted, nothing is inferred.
 *
 * WHAT IT REFUSES, AND WHY EACH REFUSAL IS ITS OWN SENTENCE. A statement stands for the invoices
 * inside it and billing it charges the job for them twice (his $3,034.54 was exactly this). A
 * credit memo is money coming back. A service charge is interest on the account, not a job cost.
 * The card only ever offers this on a plain invoice, but a refusal that says which of those it hit
 * is how he learns the shape of his own paperwork instead of pressing a dead button.
 */
export async function recordSupplierInvoiceAsBill(input: {
  invoiceId: string;
  /** A person looked at "maybe already on the books" and said it is a different purchase. */
  differentPurchase?: boolean;
  /**
   * RECORD TO SHELF (Shop Stock, Phase 2): a person's answer for every line of the document, by
   * its place in supplierBillLines' order (a count, or Not Stock). With it the bill has no job
   * and is the shelf's (on_shelf), whatever job CED or a person put on the document, and every
   * counted line becomes a roll in the same press. Without it, this is Record It As A Bill.
   */
  toShelf?: TicketLineChoice[] | null;
  /**
   * BUSINESS COST (Bills plan, Wave A): a person says this paper is the company's own, in one of
   * the six buckets. The bill has no job and carries the bucket as its category, exactly the shape
   * Add Business Cost writes. Anything that is not one of the six is refused, never guessed at.
   */
  businessCost?: string | null;
  /**
   * THE CARD'S DIFFERENT PURCHASE, NARROWED TO WHAT HE SAW (review of Wave A). The bills the card
   * showed as "maybe already in your books" when he pressed a job anyway: those, and only those,
   * are set aside. The check still runs, so a bill the card never drew (a third candidate, one
   * that landed after the page loaded, one on the other job he picked) still refuses. Present means
   * the card door, and the refusal is worded for the card's own buttons.
   */
  notSameAs?: string[] | null;
  /**
   * The job he pressed (fileSupplierPaper). The bill takes its job off the paper row, so if another
   * tap moved the paper in between, this refuses rather than record on a job he never pressed.
   */
  expectJobId?: string | null;
}): Promise<SupplierActionResult> {
  const toShelf = Array.isArray(input?.toShelf) ? input.toShelf : null;
  const cardDoor = Array.isArray(input?.notSameAs);
  const notSameAs = new Set((cardDoor ? (input.notSameAs as unknown[]) : []).map((id) => String(id ?? "")).filter(Boolean));
  const wantsBucket = input?.businessCost != null && String(input.businessCost).trim() !== "";
  if (wantsBucket && !isBusinessCostBucket(input.businessCost))
    return { ok: false, error: `Pick one of the six business-cost buckets: ${BUSINESS_COST_BUCKETS.join(", ")}. Nothing was written.` };
  const bucket: BusinessCostBucket | null = wantsBucket && !toShelf ? (input.businessCost as BusinessCostBucket) : null;
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const org = orgOf(ctx);
  if ("error" in org) return { ok: false, error: org.error };

  const invoiceId = String(input?.invoiceId ?? "");
  if (!invoiceId) return { ok: false, error: "Couldn't tell which invoice you meant." };

  // Waiting On A Credit's stamp (0346) rides along; a database without it answers the same read
  // again without the column, and nothing there is waiting (readSupplierDocuments does the same).
  const invColumns =
    "id, invoice_number, kind, invoice_date, job_id, supplier_account_id, tax, shipping, total, open_balance, closed, supplier_accounts(name), jobs(name, job_number)";
  const readInvoice = (cols: string) =>
    ctx.supabase.from("supplier_invoices").select(cols).eq("id", invoiceId).eq("org_id", org.orgId).maybeSingle();
  let { data: inv, error: readErr } = await readInvoice(`${invColumns}, waiting_credit_since`);
  if (readErr && isMissingWaitColumn(readErr)) ({ data: inv, error: readErr } = await readInvoice(invColumns));
  if (readErr) return { ok: false, error: `Couldn't read that invoice just now, so nothing was written. ${dbError(readErr)}` };
  if (!inv) return { ok: false, error: "That invoice isn't here anymore. Reload the page." };

  const row = inv as {
    invoice_number?: string | null;
    kind?: string | null;
    invoice_date?: string | null;
    job_id?: string | null;
    supplier_account_id?: string | null;
    tax?: unknown;
    shipping?: unknown;
    total?: unknown;
    open_balance?: unknown;
    closed?: boolean | null;
    waiting_credit_since?: string | null;
    supplier_accounts?: { name?: string | null } | null;
    jobs?: { name?: string | null; job_number?: string | null } | null;
  };
  const number = text(row.invoice_number) ?? "That invoice";

  const kind = String(row.kind ?? "invoice");
  if (kind !== "invoice") {
    const why: Record<string, string> = {
      statement: `${number} is a statement. It stands for the invoices inside it, so billing it would charge the job for those purchases a second time. Record them one at a time instead.`,
      credit_memo: `${number} is a credit memo. It takes money back off the account rather than putting a cost on a job, so there is nothing here to bill.`,
      service_charge: `${number} is a late-payment charge from the supplier, not something you bought for a job. It belongs to the account, not to a job's costs.`,
    };
    return { ok: false, error: why[kind] ?? `${number} isn't an invoice, so it can't become a bill.` };
  }

  /**
   * WAITING ON A CREDIT IS A PERSON'S DECISION, HONORED BY THE WRITE (audit v1018, class 4). /bills
   * folds a waiting paper with Stop Waiting as its only door, but the job's Costs tab used to offer
   * Record It As A Bill on it, and nothing here asked: one tap put a cost the supplier is taking
   * back onto the customer's job. A list is a screen and this is a write, so it refuses while the
   * wait runs. After CREDIT_WAIT_DAYS the paper is a card again by itself, and records as any card.
   * The stamp is read with the paper itself; the org's today only when there is one.
   */
  const wait = row.waiting_credit_since ? creditWait({ waitingCreditSince: row.waiting_credit_since }, await orgToday(ctx.supabase)) : null;
  if (wait && !wait.overdue) {
    return { ok: false, error: `${number} is waiting on a credit; press Stop Waiting on Bills first.` };
  }

  // No job is refused BELOW the "already in your books?" checks: a purchase already on the books
  // is answered with the tie, which needs no job, rather than sent off to pick one first.
  const jobId = text(row.job_id);
  if (input?.expectJobId !== undefined && !toShelf && !bucket && jobId !== text(input.expectJobId)) {
    return { ok: false, error: `${number} was moved to another job just now, from another screen or tap. Nothing was written. Reload the page to see where it is.` };
  }

  const accountId = text(row.supplier_account_id);
  const accountName = text(row.supplier_accounts?.name);
  // A bill has to say who it is from: `bills.supplier` is what the account groups on, what the
  // price book records as the last supplier, and what the customer reads on the "Supplies & tax"
  // line of their invoice. A bill named "Supplier" is worse than no bill.
  if (!accountId || !accountName) {
    return { ok: false, error: `${number} isn't filed under a supplier account yet, so a bill from it would have no supplier name on it.` };
  }

  const total = money(row.total);
  if (!(total > 0)) return { ok: false, error: `There is no amount on ${number}, so there is nothing to record.` };

  const openBalance = row.open_balance == null ? total : money(row.open_balance);
  const partlyPaid = !row.closed && openBalance > 0 && Math.round(openBalance * 100) !== Math.round(total * 100);

  const jobLabel = text(row.jobs?.name) ?? text(row.jobs?.job_number) ?? "its job";

  // ALREADY IN THE BOOKS, TWO WAYS. A link is the certain one. A bill carrying this invoice number
  // without a link is the same purchase filed by hand or by an earlier scan - and the answer to
  // that is the link it is missing, not a second bill for the same money.
  const { data: linked, error: linkedErr } = await ctx.supabase
    .from("bill_supplier_invoices")
    .select("bill_id, bills(job_id, jobs(name))")
    .eq("org_id", org.orgId)
    .eq("supplier_invoice_id", invoiceId)
    .limit(1);
  // A FAILED READ IS NOT "NO BILL" (review, 2026-09-20). This read is the one thing standing
  // between a genuine second tap and a second bill for the same money, and its error was being
  // dropped on the floor: a refused query read as "nothing found" and walked straight into the
  // insert. 0277's index would catch it and roll back, but a job's cost should not depend on the
  // rollback path being right.
  if (linkedErr) {
    return { ok: false, error: `Couldn't check whether ${number} is already in your books, so nothing was written. ${dbError(linkedErr)}` };
  }
  if (linked?.length) {
    // THE BILL'S JOB, NOT THE INVOICE'S. They are usually the same and the case where they differ
    // is exactly the one he needs told: the cost is sitting on a job he is not looking at.
    const on = text((linked[0] as any)?.bills?.jobs?.name);
    return {
      ok: false,
      error: on
        ? `${number} is already recorded as a bill, on ${on}.`
        : `${number} is already recorded as a bill.`,
    };
  }

  /**
   * AND THE RETURN HE SENT BACK (2026-09-19). The list this button sits on now hides an invoice a
   * credit memo has reversed, but a list is a screen and this is a write: 8802-1107230 is five
   * light almond receptacles that went back to the counter, and recording it would put $225.47 of
   * merchandise he does not have onto a customer's job. The rule is read from the account's own
   * documents with the same function the list and the balance use, and since that function stopped
   * pairing by array position (review, 2026-09-20) it gives all three the same answer whatever
   * order the rows arrive in.
   */
  // NEWEST FIRST, THE WAY THE PAGE READS THEM (review, 2026-09-20). The rule itself no longer
  // depends on the order it is handed - two purchases at one total with one credit memo between
  // them are now BOTH left billable rather than paired by array position - but a query with no
  // ORDER BY hands back whatever the planner felt like, and a list and a button that read the same
  // rows in different orders is a difference waiting to become a wrong job cost again.
  const { data: siblings } = await ctx.supabase
    .from("supplier_invoices")
    .select("id, kind, total, open_balance, closed")
    .eq("org_id", org.orgId)
    .eq("supplier_account_id", accountId)
    .order("invoice_date", { ascending: false });
  // Mapped, not cast: PostgREST says `open_balance` and the rule reads `openBalance`, and a cast
  // would compile while quietly reading every part-paid invoice as fully owed. `kind` rides along
  // so a statement or a late-payment charge can never spend a credit memo that belongs to a real
  // invoice - only an invoice is a purchase, and the wrapper around several of them is not.
  const siblingBalances: PurchaseReversalShape[] = ((siblings ?? []) as any[]).map((r) => ({
    id: String(r?.id ?? ""),
    kind: String(r?.kind ?? "invoice"),
    total: Number(r?.total) || 0,
    openBalance: r?.open_balance == null ? null : Number(r.open_balance),
    closed: !!r?.closed,
  }));
  if (reversedPurchaseIds(siblingBalances).has(invoiceId)) {
    return {
      ok: false,
      error: `${number} was taken straight back off the account by a credit memo for the same amount, so there is nothing on it you kept. Recording it would charge ${jobLabel} for merchandise you returned.`,
    };
  }

  /**
   * ALREADY IN HIS BOOKS UNDER ANOTHER DOOR'S NUMBER (audit v994, DB1).
   *
   * This used to look for a bill with this number in supplier_invoice_number only, the column this
   * button writes, and never in bill_number, the column the tray and the job page write. So a CED
   * ticket filed from the tray as 8802-1109000 was invisible here, and CED's own PDF of the same
   * number made a second $400 bill on the same job. And a counter ticket carries a sales-order
   * number (8802-SO-...) that CED's invoice never prints, so no number could ever find it.
   *
   * Now the one reading every door uses (samePurchaseFor): a live bill carrying this number in
   * either column, or on this account and job within a few dollars and days. Any of those and
   * nothing is written: the card offers Same Purchase: Tie Them against each, and a person who
   * says it is a different purchase comes back with differentPurchase. Set-aside copies (0271)
   * are never offered: every cost reader ignores them.
   */
  if (!input?.differentPurchase) {
    const foundAll = await samePurchaseFor(ctx.supabase, org.orgId, {
      id: invoiceId,
      invoice_number: text(row.invoice_number),
      supplier_account_id: accountId,
      job_id: toShelf || bucket ? null : jobId,
      total: row.total as any,
      invoice_date: text(row.invoice_date),
    });
    if (!foundAll) return { ok: false, error: `Couldn't check whether ${number} is already in your books, so nothing was written. Try again.` };
    // The ones he already looked at on the card and pressed past are his answer; any other is news.
    const found = { candidates: foundAll.candidates.filter((c) => !notSameAs.has(c.billId)) };
    const first = found.candidates[0];
    if (first) {
      const more = found.candidates.length > 1 ? ` ${found.candidates.length - 1} more bill${found.candidates.length === 2 ? "" : "s"} could be it too; each is listed on the card.` : "";
      // The card has no Record It Anyway button: after this refusal it redraws with a Same Purchase:
      // Tie Them for each, and pressing the job again is the card's "different purchase".
      const how = cardDoor
        ? "The card now shows it. If it is the same purchase, press Same Purchase: Tie Them. If it is not, press your answer again."
        : "If it is the same purchase, press Same Purchase: Tie Them. If it is not, press Different Purchase: Record It Anyway.";
      return {
        ok: false,
        error: `${samePurchaseSentence(first)}${more} ${how} Nothing was written.`,
      };
    }
  }

  if (!jobId && !toShelf && !bucket) return { ok: false, error: `Say which job ${number} belongs to first, then record it.` };

  // ── THE LINES ───────────────────────────────────────────────────────────────────────────────
  const { data: lineRows, error: lineErr } = await ctx.supabase
    .from("supplier_invoice_lines")
    .select("description, part_number, quantity, unit_price, extension, sort_order")
    .eq("org_id", org.orgId)
    .eq("supplier_invoice_id", invoiceId)
    .order("sort_order");
  if (lineErr) {
    // A FAILED READ IS NOT AN EMPTY INVOICE. Writing the bill anyway would file it as an opaque
    // lump and quietly lose the line prices the supplier's own file is holding right here.
    return { ok: false, error: `Couldn't read that invoice's lines just now, so nothing was written. ${dbError(lineErr)}` };
  }

  // THE LINES HAVE TO BE THE BILL, OR SAY SO. `bills.amount` is the supplier's own total and is
  // never adjusted to match a sum - it is the figure they will chase him for. When the lines come
  // to LESS, the invoice importer already carries the difference in its supplies-and-tax row, and
  // the sentence below names it rather than letting it show up as an unexplained few dollars. When
  // they come to MORE, something was read wrong and itemising would overcharge his customer, so
  // the bill goes in the way a hand-entered one always has: as one honest amount.
  const { lines, lineSum, overshoot, shortfall } = supplierBillLines((lineRows ?? []) as any[], {
    invoiceNumber: number,
    tax: row.tax,
    shipping: row.shipping,
    total,
  });

  // THE SHELF NEEDS THE LINES (Shop Stock, Phase 2): a roll IS a line, so a document that can't be
  // itemised can't go on the shelf, and every line needs a person's answer before anything is
  // written. Asked here, before the bill, so a refusal writes nothing.
  if (toShelf) {
    if (overshoot)
      return {
        ok: false,
        error: `${number}'s lines come to ${sayMoney(lineSum)}, more than the ${sayMoney(total)} ${accountName} is charging, so it can't be itemised onto the shelf. Nothing was written.`,
      };
    if (!lines.length) return { ok: false, error: `${number} has no lines on file. ${SHELF_NEEDS_LINES}` };
    const shelfProblem = ticketShelfProblem(lines, total, toShelf);
    if (shelfProblem) return { ok: false, error: `${shelfProblem} Nothing was written.` };
  }

  const { data: billRows, error: billErr } = await ctx.supabase
    .from("bills")
    .insert({
      org_id: org.orgId,
      // A document recorded to the shelf is the shelf's, never a job's (0303's check says so too).
      // A business cost is the company's own: no job, whatever job the paper itself names.
      job_id: toShelf || bucket ? null : jobId,
      ...(toShelf ? { on_shelf: true } : {}),
      supplier: accountName,
      supplier_account_id: accountId,
      supplier_invoice_number: number,
      bill_number: number,
      amount: total,
      // ONLY THE SUPPLIER CAN SAY WHETHER IT IS PAID, which is the whole reason supplier_invoices
      // exists (0273). `closed` is their answer, read out of their own portal.
      status: row.closed ? "paid" : "unpaid",
      bill_date: text(row.invoice_date),
      category: toShelf ? "Shop Stock" : bucket ?? "Invoice",
      // WHAT THE SUPPLIER SAYS IS STILL OWED, when it is not simply all of it. `bills.status` has
      // two states and a part-paid invoice is neither: recorded as unpaid it shows at full value
      // on his Unpaid filter while the card directly above says the supplier is owed ten dollars
      // on that same document (review, 2026-09-19). The status stays the supplier's own verdict;
      // the figure that contradicts it is written down rather than left off the screen.
      notes: partlyPaid
        ? `Recorded from ${accountName} invoice ${number}, the supplier's own document. They show ${sayMoney(openBalance)} of it still open.`
        : `Recorded from ${accountName} invoice ${number}, the supplier's own document.`,
      created_by: ctx.userId,
      // Their file, their contract prices. Not a counter preview (0271).
      pricing_provisional: false,
      is_statement: false,
    })
    .select("id");
  if (billErr) {
    // 0276's unique index is what actually stops two taps making two bills; the read above is only
    // the fast path. When the index fires, the answer is not a database error - it is that the
    // thing he asked for has already happened.
    if (isDuplicateKey(billErr)) {
      revalidatePath("/bills");
      return { ok: false, error: `${number} is already recorded as a bill. Reload the page and you'll see it.` };
    }
    return { ok: false, error: `That didn't save, so ${number} is still not in your books. ${dbError(billErr)}` };
  }
  if (!billRows?.length) {
    reportError("bills:recordAsBill", new Error("bill insert wrote no rows"), { invoiceId, number });
    return { ok: false, error: `That didn't save, so ${number} is still not in your books. Try it again.` };
  }
  const billId = String(billRows[0].id);

  /**
   * THE CLAIM GOES DOWN BEFORE THE LINES DO (review, 2026-09-19). 0277 makes this row unique on
   * the supplier invoice, so it is the statement "this purchase is covered" and only one caller
   * can make it. Writing it FIRST means the tap that loses a race owns a bill with nothing hanging
   * off it, which can be taken straight back out; writing it last would leave orphaned line items
   * behind on every loss.
   */
  let lineNote = "";
  const { data: joined, error: joinErr } = await ctx.supabase
    .from("bill_supplier_invoices")
    .insert({ org_id: org.orgId, bill_id: billId, supplier_invoice_id: invoiceId })
    .select("id");
  let tied = !joinErr && !!joined?.length;
  if (joinErr && isDuplicateKey(joinErr)) {
    /**
     * SOMEBODY ELSE GOT THERE - BUT FIND OUT WHOSE BILL WON BEFORE TAKING ANYTHING BACK
     * (review, 2026-09-20). This used to delete "the bill it just wrote" and never look at the
     * result, which is the only write in this file that asks for `.select("id")` and then ignores
     * the answer. Two things were wrong with that. `bill_supplier_invoices.bill_id` is
     * `on delete cascade` (0273), so the delete takes the winning claim with it - and in the one
     * race this branch can actually lose, the other tap took the join-only path above and tied the
     * invoice to THE BILL THIS CALL JUST WROTE (0276 permits no second live bill with this
     * number). Deleting it would cascade away a tie the other screen was already told about, and
     * leave the invoice with no live bill at all. And a rollback that removed no rows is a
     * refusal, not a success: the second bill would still be sitting in Bills, doubling the job's
     * cost, with a sentence on screen saying it had been taken back out.
     */
    const { data: winner, error: winnerErr } = await ctx.supabase
      .from("bill_supplier_invoices")
      .select("bill_id")
      .eq("org_id", org.orgId)
      .eq("supplier_invoice_id", invoiceId)
      .limit(1);
    const winningBillId = String((winner?.[0] as { bill_id?: string } | undefined)?.bill_id ?? "");
    // AN UNKNOWN WINNER LEANS TO TAKING IT BACK OUT. If the read fails there is still certainly a
    // claim on this invoice - that is what the unique index just said - and the two wrongs are not
    // the same size: a bill left behind doubles a job's cost silently and forever, while one taken
    // back out shows up again on Purchases Not In Your Books with a button on it. The sentence
    // below says which of the two happened rather than guessing at a tidy one.
    if (winnerErr || winningBillId !== billId) {
      // A different bill carries it. This one is a cost the job never incurred, so it goes back out.
      const { data: removed, error: delErr } = await ctx.supabase
        .from("bills")
        .delete()
        .eq("org_id", org.orgId)
        .eq("id", billId)
        .select("id");
      revalidatePath("/bills");
      if (delErr || !removed?.length) {
        reportError("bills:recordAsBill.rollback", delErr ?? new Error("rollback delete removed no rows"), { billId, invoiceId });
        return {
          ok: false,
          error: `${number} was already recorded as a bill, and the second one this just wrote is still sitting in Bills at ${sayMoney(total)}. Delete it there, or ${jobLabel} carries the cost twice.`,
        };
      }
      return {
        ok: false,
        error: winnerErr
          ? `${number} is already recorded as a bill somewhere, so this second copy was taken back out. Reload the page, and if it still shows under Purchases Not In Your Books, record it again.`
          : `${number} is already recorded as a bill. Reload the page and you'll see it.`,
      };
    }
    // THE WINNING CLAIM IS THIS BILL'S OWN, so there is nothing to take back: the other tap tied
    // the invoice to this very bill. Falling through finishes the job - the lines, the revalidates
    // and the sentence below all still run - instead of deleting a bill that is now the right one.
    tied = true;
  }
  // The bill is real and the cost is on the job whether or not the tie-line landed. Without it the
  // reconcile card will go on asking for this invoice, which is a nuisance and a wrong number on a
  // screen, so it gets its own sentence rather than a shrug.
  if (!tied) {
    reportError("bills:recordAsBill.link", joinErr ?? new Error("bill_supplier_invoices insert wrote no rows"), { billId, invoiceId });
    lineNote += " The bill is on the job, but it didn't get tied to the supplier's invoice, so this list may still ask for it.";
  }

  if (overshoot) {
    lineNote = ` Its lines came to ${sayMoney(lineSum)}, more than the ${sayMoney(total)} the supplier is charging, so it went in as one amount rather than itemised.${lineNote}`;
  } else if (lines.length) {
    const { data: wrote, error: writeErr } = await ctx.supabase
      .from("bill_line_items")
      .insert(lines.map((l, i) => ({ org_id: org.orgId, bill_id: billId, ...l, sort_order: i })))
      .select("id");
    // THE COST IS RIGHT EITHER WAY, so a line failure never throws the bill away - it is said out
    // loud instead, because a bill that silently lost its itemisation bills the customer one lump
    // labelled "Materials" and nobody would know why. The sentence stops at what is true: there
    // is no control anywhere in the app for adding a line to a bill, and telling him to open it
    // and add them would be a door that does not exist.
    // NO RESTAMP HERE, AND WHY (Shop Stock, 0304's other half): these lines belong to the bill
    // written a moment ago, and a roll is keyed to a line id that did not exist until this insert,
    // so no roll can be on it yet. Record To Shelf puts its rolls on in shelveRecordedBill below.
    if (writeErr || !wrote?.length) {
      reportError("bills:recordAsBill.lines", writeErr ?? new Error("bill line insert wrote no rows"), { billId, lines: lines.length });
      lineNote = ` Its lines didn't save, so the ${sayMoney(total)} is in as one amount. The cost is right; the invoice will bill it as a single line.${lineNote}`;
    } else if (shortfall >= 0.01) {
      // THIS ARM WAS UNREACHABLE IN THE CASE IT WAS WRITTEN FOR (review). It hung off the end of an
      // if/else chain whose first arm ran whenever there were any lines at all, so a receipt with
      // a line the reader missed - the only way a shortfall happens - said nothing, and the money
      // rode into the invoice's supplies row with no warning at all.
      lineNote = ` ${sayMoney(shortfall)} of it isn't on a line, so it rides in the supplies and tax row when you invoice.${lineNote}`;
    }
  } else if (shortfall >= 0.01) {
    lineNote = ` None of it is on a line, so the whole ${sayMoney(total)} bills as one amount.${lineNote}`;
  }

  if (toShelf) return shelveRecordedBill(ctx.supabase, org.orgId, billId, number, total, toShelf, lineNote, !!row.closed);

  revalidatePath("/bills");
  revalidatePath("/planner");
  if (bucket) {
    return {
      ok: true,
      billId,
      message: `${number} is a business cost now, under ${bucket}: ${sayMoney(total)}${row.closed ? ", which the supplier already shows as paid" : ""}.${lineNote}`,
    };
  }
  revalidatePath(`/jobs/${jobId}`);
  return {
    ok: true,
    billId,
    message: `${number} is a bill on ${jobLabel} now: ${sayMoney(total)}${row.closed ? ", which the supplier already shows as paid" : ""}.${lineNote}`,
  };
}

/**
 * THE SECOND HALF OF RECORD TO SHELF: the bill and its lines are written; every line a person
 * counted becomes a roll (shelveLines, one transaction). If the lines didn't all land or the shelf
 * refuses, the bill comes back out - a shelf ticket with no rolls on it is money in no place - and
 * the sentence says the document is still not in the books.
 */
async function shelveRecordedBill(
  supabase: any,
  orgId: string,
  billId: string,
  number: string,
  total: number,
  choices: TicketLineChoice[],
  lineNote: string,
  closed: boolean,
): Promise<SupplierActionResult> {
  const takeBack = async (why: string): Promise<SupplierActionResult> => {
    const { data: removed, error: delErr } = await supabase.from("bills").delete().eq("org_id", orgId).eq("id", billId).select("id");
    revalidatePath("/bills");
    if (delErr || !removed?.length) {
      reportError("bills:recordToShelf.rollback", delErr ?? new Error("rollback delete removed no rows"), { billId, number });
      return { ok: false, error: `${why} The bill this just wrote for ${number} is still in Bills at ${sayMoney(total)} with nothing on the shelf; delete it there and try again.` };
    }
    return { ok: false, error: `${why} ${number} is still not in your books.` };
  };
  const { data: written, error: writtenErr } = await supabase
    .from("bill_line_items")
    .select("id, sort_order")
    .eq("bill_id", billId)
    .eq("org_id", orgId)
    .order("sort_order");
  if (writtenErr) return takeBack(`Couldn't read ${number}'s lines back, so nothing went on the shelf.`);
  const idAt = new Map(((written ?? []) as { id: string; sort_order: number }[]).map((w) => [Number(w.sort_order), String(w.id)]));
  const picks: ShelfPick[] = [];
  for (const c of choices) {
    if (c.notStock) continue;
    const lineId = idAt.get(Number(c.index));
    if (!lineId) return takeBack(`${number}'s lines didn't all save, so nothing went on the shelf.`);
    picks.push({
      lineId,
      pieces: Number(c.pieces),
      used: 0,
      unit: c.unit,
      bought: c.bought ?? null,
      itemId: c.itemId ?? null,
      newItemName: c.newItemName ?? null,
      keyPart: c.keyPart ?? null,
    });
  }
  const shelved = await shelveLines(supabase, orgId, billId, picks);
  if (!shelved.ok) return takeBack(shelved.error);
  revalidatePath("/bills");
  revalidatePath("/inventory");
  const notStock = choices.filter((c) => c.notStock).length;
  return {
    ok: true,
    message:
      `${number} is on the shop shelf now: ${sayMoney(total)}${closed ? ", which the supplier already shows as paid" : ""}. ` +
      `${shelved.lots.map((l) => `${l.pieces} ${l.unit} (${sayMoney(l.cost)})`).join(", ")} on the shelf.` +
      (notStock ? ` ${notStock === 1 ? "1 line" : `${notStock} lines`} marked Not Stock stay on the ticket as Tools & Supplies.` : "") +
      lineNote,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// "HEY YOU, HERE'S A BILL, WHAT'S IT FOR?" - the card's one tap (Bills plan, Wave A, 2026-09-25)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * ONE TAP: PUT THE PAPER ON A JOB AND RECORD IT, or record it as a business cost.
 *
 * Before this, CED's 8802-1107820 ("85 WHITNEY", $187.64) took about eight taps across two lists
 * on /bills: pick J-028 in Invoices With No Job, press File It, scroll to Purchases Not In Your
 * Books, find the row again, Record It As A Bill. The card on My Day asks the one question and the
 * answer does both halves, by calling the two actions that already do each half and already say
 * what they did (setSupplierInvoiceJob, then recordSupplierInvoiceAsBill). No third copy of either
 * write.
 *
 * THE JOB COMES BACK OFF IF THE RECORD FAILS. A paper left on a job with no bill is the half-done
 * state this card exists to end, and the sentence would be a lie ("nothing changed"). So when the
 * record refuses (maybe already in your books, a failed read, a lost race) the job this call put on
 * is taken back off, guarded on still being the job it put on, and the sentence says so.
 *
 * The person decided: `jobId` is the button he pressed. Nothing here picks a job.
 */
export async function fileSupplierPaper(input: {
  invoiceId: string;
  jobId?: string | null;
  businessCost?: string | null;
  /**
   * The bills the card showed as "maybe already in your books" when he pressed an answer anyway.
   * Only these are set aside; any other candidate still refuses (recordSupplierInvoiceAsBill).
   */
  notSameAs?: string[] | null;
}): Promise<SupplierActionResult> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const org = orgOf(ctx);
  if ("error" in org) return { ok: false, error: org.error };

  const invoiceId = String(input?.invoiceId ?? "");
  const jobId = text(input?.jobId);
  const bucket = text(input?.businessCost);
  if (!invoiceId) return { ok: false, error: "Couldn't tell which paper you meant. Nothing was filed." };
  if (!jobId === !bucket) return { ok: false, error: "Pick a job for it, or Business Cost. Nothing was filed." };

  const { data: inv, error: readErr } = await ctx.supabase
    .from("supplier_invoices")
    .select("id, invoice_number, kind, job_id")
    .eq("id", invoiceId)
    .eq("org_id", org.orgId)
    .maybeSingle();
  if (readErr) return { ok: false, error: `Couldn't read that paper just now, so nothing was filed. ${dbError(readErr)}` };
  if (!inv) return { ok: false, error: "That paper isn't here anymore. Reload the page." };
  const number = text((inv as any).invoice_number) ?? "That paper";
  // Asked BEFORE the job goes on: a statement, a credit memo or interest can't become a bill, and
  // putting one on a job first would leave it there after the record refused.
  if (String((inv as any).kind ?? "invoice") !== "invoice")
    return { ok: false, error: `${number} isn't a purchase, so there is no bill to record from it. Nothing was filed.` };
  const jobBefore = text((inv as any).job_id);
  const notSameAs = Array.isArray(input?.notSameAs) ? input.notSameAs.map((id) => String(id ?? "")).filter(Boolean) : [];

  if (bucket) {
    const rec = await recordSupplierInvoiceAsBill({ invoiceId, businessCost: bucket, notSameAs });
    if (!rec.ok) return { ok: false, error: rec.error };
    return { ...rec, undo: rec.billId ? { invoiceId, billId: rec.billId, jobSetTo: null, jobBefore } : undefined };
  }

  let jobSetTo: string | null = null;
  if (jobBefore !== jobId) {
    const set = await setSupplierInvoiceJob({ invoiceId, jobId: jobId! });
    if (!set.ok) return { ok: false, error: set.error };
    jobSetTo = jobId;
  }

  /**
   * TAKE BACK THE JOB THIS TAP PUT ON, and say truly where the paper is. Guarded on still being
   * the job it put on: when another tap moved it since, that tap's job is left alone and the
   * sentence says so rather than claiming a put-back that did not happen.
   */
  const putBack = async (said: string): Promise<SupplierActionResult> => {
    if (!jobSetTo) return { ok: false, error: said };
    const { data: back, error: backErr } = await ctx.supabase
      .from("supplier_invoices")
      .update({ job_id: jobBefore })
      .eq("id", invoiceId)
      .eq("org_id", org.orgId)
      .eq("job_id", jobSetTo)
      .select("id");
    revalidatePath("/bills");
    revalidatePath("/planner");
    if (!backErr && back?.length) return { ok: false, error: `${said} The job was taken back off it, so nothing changed.` };
    // Nothing came back off. Either the put-back failed, or another tap moved the paper since and
    // the guard rightly left it alone: read where it is now, so the sentence is the true one.
    const { data: now } = backErr
      ? { data: null }
      : await ctx.supabase.from("supplier_invoices").select("job_id").eq("id", invoiceId).eq("org_id", org.orgId).maybeSingle();
    const nowJob = now ? text((now as { job_id?: string | null }).job_id) : jobSetTo;
    if (nowJob !== jobSetTo)
      return { ok: false, error: `${said} Someone moved ${number} to another job in the meantime, so it was left where they put it. Reload the page to see it.` };
    reportError("bills:fileSupplierPaper.rollback", backErr ?? new Error("job rollback wrote no rows"), { invoiceId, jobSetTo });
    return {
      ok: false,
      error: `${said} ${number} is still on that job with no bill, though: taking the job back off didn't save. Its card stays until it is recorded.`,
    };
  };

  let rec: SupplierActionResult;
  try {
    // The job he pressed rides along: the bill takes its job off the paper, and a paper another tap
    // moved in between is refused, never recorded on a job he did not press.
    rec = await recordSupplierInvoiceAsBill({ invoiceId, notSameAs, expectJobId: jobId });
  } catch (e) {
    reportError("bills:fileSupplierPaper.record", e, { invoiceId, jobSetTo });
    // A THROW IS NOT A REFUSAL: the bill may have been written before it. The job comes off only
    // when no bill is tied to the paper; a bill that did land keeps its paper on its job.
    const { data: tied, error: tiedErr } = await ctx.supabase
      .from("bill_supplier_invoices")
      .select("bill_id")
      .eq("org_id", org.orgId)
      .eq("supplier_invoice_id", invoiceId)
      .limit(1);
    if (tiedErr) return { ok: false, error: `Something went wrong recording ${number}. Reload the page to see whether it was filed.` };
    if (tied?.length) {
      revalidatePath("/bills");
      revalidatePath("/planner");
      return { ok: false, error: `Something went wrong partway, but ${number} did land in your books. Reload the page to see it.` };
    }
    return putBack(`Something went wrong recording ${number}, so no bill was written.`);
  }
  if (!rec.ok) return putBack(rec.error ?? `${number} didn't record.`);
  return { ...rec, undo: rec.billId ? { invoiceId, billId: rec.billId, jobSetTo, jobBefore } : undefined };
}

/**
 * UNDO THE ONE TAP: the bill it wrote comes back out, and the job it put on comes back off.
 *
 * ONLY WHILE NO CUSTOMER INVOICE HAS CLAIMED THE BILL. Once INV-078 bills it, taking it out would
 * leave Andrew's invoice charging for a receipt that no longer exists; the claim is read first so
 * the sentence can name the invoice, and 0278's guard_billed_bill refuses the delete anyway if a
 * claim lands in between. A copy set aside against it, or a line on the shop shelf, refuses the
 * same way the Bills page's Delete does (standingRefusal).
 */
export async function undoFileSupplierPaper(input: {
  invoiceId: string;
  billId: string;
  jobSetTo?: string | null;
  jobBefore?: string | null;
}): Promise<SupplierActionResult> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const org = orgOf(ctx);
  if ("error" in org) return { ok: false, error: org.error };
  const invoiceId = String(input?.invoiceId ?? "");
  const billId = String(input?.billId ?? "");
  const jobSetTo = text(input?.jobSetTo);
  const jobBefore = text(input?.jobBefore);
  if (!invoiceId || !billId) return { ok: false, error: "Couldn't tell what to undo. Nothing was changed." };

  // The bill has to be the one this paper's tap wrote: a client's say-so deletes nothing.
  const [{ data: link, error: linkErr }, { data: bill, error: billErr }] = await Promise.all([
    ctx.supabase.from("bill_supplier_invoices").select("bill_id").eq("org_id", org.orgId).eq("supplier_invoice_id", invoiceId).limit(1),
    ctx.supabase.from("bills").select("id, supplier_invoice_number, job_id").eq("id", billId).eq("org_id", org.orgId).maybeSingle(),
  ]);
  if (linkErr || billErr) return { ok: false, error: `Couldn't check that bill just now, so nothing was undone. ${dbError(linkErr ?? billErr)}` };
  if (!bill) return { ok: false, error: "That bill isn't here anymore, so there is nothing to undo." };
  const number = text((bill as any).supplier_invoice_number) ?? "That paper";
  if (String((link?.[0] as { bill_id?: string } | undefined)?.bill_id ?? "") !== billId)
    return { ok: false, error: `${number} isn't tied to that bill anymore, so Undo left both alone.` };

  const { data: claims, error: claimErr } = await ctx.supabase
    .from("invoice_items")
    .select("import_key, source_ids, invoices!inner(invoice_number, status)")
    .or(`import_key.eq.bill:${billId},source_ids.cs.{${billId}}`)
    .neq("invoices.status", "void")
    .limit(5);
  if (claimErr) return { ok: false, error: `Couldn't check whether an invoice bills ${number}, so nothing was undone. ${dbError(claimErr)}` };
  const holder = ((claims ?? []) as any[]).find((c) => claimedIdsOfLines([c]).includes(billId));
  if (holder) {
    const on = text(holder?.invoices?.invoice_number) ?? "An invoice";
    return {
      ok: false,
      error: `${on} already bills ${number}, so Undo can't take it back. Take its materials lines off ${on} first, or leave it: the cost is on the right job.`,
    };
  }

  const standing = await readBillStanding(ctx.supabase, org.orgId, billId);
  if (standing && "error" in standing) return { ok: false, error: standing.error };
  if (standing) {
    const no = standingRefusal(standing, "press Undo again", "Nothing was undone.");
    if (no) return { ok: false, error: no };
  }

  const { data: gone, error: delErr } = await ctx.supabase.from("bills").delete().eq("id", billId).eq("org_id", org.orgId).select("id");
  // 0278's guard raises its own sentence ("INV-078 already bills this receipt..."): handed back.
  if (delErr) return { ok: false, error: `Undo didn't go through. ${dbError(delErr)}` };
  if (!gone?.length) return { ok: false, error: `Undo didn't go through: ${number}'s bill is still in your books. Reload the page.` };

  const billJob = text((bill as any).job_id);
  revalidatePath("/bills");
  revalidatePath("/planner");
  if (billJob) revalidatePath(`/jobs/${billJob}`);

  if (jobSetTo) {
    // THE JOB IT GOES BACK TO IS CHECKED, NOT TRUSTED (review of Wave A). `jobBefore` arrives from
    // the browser, and nothing below this line (no trigger, an RLS policy on the paper's own org,
    // an FK to any job) would stop a doctored Undo pointing his paper at another org's job.
    if (jobBefore) {
      const { data: ours, error: oursErr } = await ctx.supabase.from("jobs").select("id").eq("id", jobBefore).eq("org_id", org.orgId).maybeSingle();
      if (oursErr || !ours) {
        if (oursErr) reportError("bills:undoFileSupplierPaper.jobBefore", oursErr, { invoiceId, jobBefore });
        return { ok: true, message: `${number}'s bill is gone, but the paper is still on the job it was put on: ${oursErr ? "couldn't check" : "couldn't find"} the job it was on before. Its card is back so you can pick again.` };
      }
    }
    const { data: back, error: backErr } = await ctx.supabase
      .from("supplier_invoices")
      .update({ job_id: jobBefore })
      .eq("id", invoiceId)
      .eq("org_id", org.orgId)
      .eq("job_id", jobSetTo)
      .select("id");
    if (backErr || !back?.length) {
      reportError("bills:undoFileSupplierPaper.job", backErr ?? new Error("job put-back wrote no rows"), { invoiceId, jobSetTo });
      return { ok: true, message: `${number}'s bill is gone, but the paper is still on that job. Its card is back so you can pick again.` };
    }
  }
  const jobWords = !jobSetTo ? "" : jobBefore ? " and the paper is back on the job it was on" : " and the paper is on no job again";
  return { ok: true, message: `Undone: ${number}'s bill is gone${jobWords}. Its card is back.` };
}

/** Record To Shelf: Record It As A Bill with a person's answer for every line (Shop Stock, Phase 2). */
export async function recordSupplierInvoiceToShelf(input: {
  invoiceId: string;
  differentPurchase?: boolean;
  /** The card door: the "maybe the same purchase" bills it showed (recordSupplierInvoiceAsBill). */
  notSameAs?: string[] | null;
  toShelf: TicketLineChoice[];
}): Promise<SupplierActionResult> {
  if (!Array.isArray(input?.toShelf)) return { ok: false, error: "Say for every line how many go on the shelf, or tap Not Stock." };
  return recordSupplierInvoiceAsBill({
    invoiceId: input.invoiceId,
    differentPurchase: input.differentPurchase,
    ...(Array.isArray(input?.notSameAs) ? { notSameAs: input.notSameAs } : {}),
    toShelf: input.toShelf,
  });
}

export type SupplierShelfLine = {
  key: string;
  description: string;
  quantity: number;
  unitPrice: number | null;
  amount: number;
  category: string | null;
  partNumber: string | null;
};

/**
 * THE LINES RECORD TO SHELF WILL COUNT, in exactly the order the bill will hold them
 * (supplierBillLines, the same call the record makes). Office only; the item picker is loaded
 * separately and carries no cost.
 */
export async function supplierInvoiceShelfLines(
  invoiceId: string,
): Promise<{ ok: true; lines: SupplierShelfLine[]; total: number } | { ok: false; error: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error ?? "This is office-only." };
  const org = orgOf(ctx);
  if ("error" in org) return { ok: false, error: org.error };
  const { data: inv, error: invErr } = await ctx.supabase
    .from("supplier_invoices")
    .select("id, invoice_number, kind, tax, shipping, total")
    .eq("id", String(invoiceId ?? ""))
    .eq("org_id", org.orgId)
    .maybeSingle();
  if (invErr) return { ok: false, error: dbError(invErr) };
  if (!inv) return { ok: false, error: "That document isn't here anymore. Reload the page." };
  const row = inv as { invoice_number?: string | null; kind?: string | null; tax?: unknown; shipping?: unknown; total?: unknown };
  if (String(row.kind ?? "invoice") !== "invoice") return { ok: false, error: "Only an invoice can go on the shelf." };
  const { data: lineRows, error: lineErr } = await ctx.supabase
    .from("supplier_invoice_lines")
    .select("description, part_number, quantity, unit_price, extension, sort_order")
    .eq("org_id", org.orgId)
    .eq("supplier_invoice_id", String(invoiceId))
    .order("sort_order");
  if (lineErr) return { ok: false, error: dbError(lineErr) };
  const total = money(row.total);
  const built = supplierBillLines((lineRows ?? []) as any[], { invoiceNumber: text(row.invoice_number) ?? "", tax: row.tax, shipping: row.shipping, total });
  if (built.overshoot) return { ok: false, error: "Its lines come to more than its total, so it can't be itemised onto the shelf." };
  if (!built.lines.length) return { ok: false, error: `This document has no lines on file. ${SHELF_NEEDS_LINES}` };
  return {
    ok: true,
    total,
    lines: built.lines.map((l, i) => ({
      key: String(i),
      description: l.description,
      quantity: l.quantity,
      unitPrice: l.unit_price,
      amount: l.amount,
      category: l.category,
      partNumber: built.parts[i] ?? null,
    })),
  };
}
