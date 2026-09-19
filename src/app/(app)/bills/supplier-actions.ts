"use server";

import { revalidatePath } from "next/cache";
import { dbError } from "@/lib/db-error";
import { reportError } from "@/lib/observe";
import { requireStaff } from "@/lib/staff-guard";
import { getOrgSettings } from "@/lib/org-settings";
import { todayStrInTz } from "@/lib/tz";
import { SUPPLIER_PAY_METHODS, type SupplierActionResult, type SupplierPayMethod } from "./supplier-balance";
// sayMoney lives in payroll-math because payroll needed it first. It is pure string formatting
// with no payroll in it ("$400", not "$400.00"), and a second copy here would drift the moment one
// of them learned something about cents. One function, two ledgers.
import { sayMoney } from "@/lib/payroll-math";

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

const isDuplicateKey = (err: unknown): boolean =>
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
    return { ok: false, error: aliasTakenSentence(alias, owner.name) };
  }
  if (owner) return { ok: true, message: `"${alias}" was already saved for this supplier.` };

  const { data, error } = await ctx.supabase
    .from("supplier_aliases")
    .insert({ org_id: org.orgId, supplier_account_id: accountId, alias, branch_label: text(input?.branchLabel) })
    .select("id");
  if (error) {
    // The race the read above cannot close: two taps, two tabs. The unique index
    // (supplier_aliases_one_per_spelling) is the boundary; this is the sentence for it.
    if (isDuplicateKey(error)) return { ok: false, error: aliasTakenSentence(alias, "another supplier") };
    return { ok: false, error: `That name didn't save. ${dbError(error)}` };
  }
  if (!data?.length) {
    reportError("bills:addSupplierAlias", new Error("alias insert wrote no rows"), { accountId, alias });
    return { ok: false, error: "That name didn't save. Try it again." };
  }

  revalidatePath("/bills");
  return { ok: true, aliasId: String(data[0].id) };
}

const aliasTakenSentence = (alias: string, owner: string) =>
  `"${alias}" is already saved as a name for ${owner}. Take it off there first, or file these bills one at a time.`;

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

  const keptOn = (keeper as any).jobs?.name ?? "no job";
  const droppedOn = sayList([...new Set((moved as any[]).map((m) => m.jobs?.name ?? "no job"))]);
  const amount = sayMoney(money((keeper as any).amount));

  revalidatePath("/bills");
  if ((keeper as any).job_id) revalidatePath(`/jobs/${(keeper as any).job_id}`);
  for (const m of moved as any[]) if (m.job_id) revalidatePath(`/jobs/${m.job_id}`);

  return {
    ok: true,
    message: `Kept the ${amount} ticket on ${keptOn}. The copy on ${droppedOn} stops counting against that job and stays on your bills list.`,
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
  return {
    ok: true,
    message: `Voided the ${sayMoney(amount)} payment to ${name}. It stays on the list and goes back onto what you owe.`,
  };
}
