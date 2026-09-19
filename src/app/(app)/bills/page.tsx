import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { claimedIdsOfLines } from "@/lib/unbilled-work";
import { getOrgSettings } from "@/lib/org-settings";
import { todayStrInTz } from "@/lib/tz";
import {
  findDuplicateBills,
  readBillInvoice,
  resolveSupplierAccount,
  suggestSupplierGroups,
  type BillFingerprint,
} from "@/lib/supplier-identity";
import { BillsReceipts } from "./bills-receipts";
import { ReceiptBillingCard, type ReceiptForBilling } from "./receipt-billing-card";
import {
  isOnAccountBill,
  type DuplicateBillGroup,
  type SupplierAccountRow,
  type SupplierBillRow,
  type SupplierMergeProposal,
  type SupplierSpelling,
} from "./supplier-balance";
import { SuppliersCard } from "./suppliers-card";
import {
  acceptSupplierMerge,
  dismissSupplierMerge,
  recordSupplierPayment,
  resolveDuplicateBill,
  setSupplierOnAccount,
  unresolveDuplicateBill,
  voidSupplierPayment,
} from "./supplier-actions";

export const dynamic = "force-dynamic";

/**
 * The bills ledger, with each receipt's lines. `billable` (0268) and the line's own id ride along
 * for the receipt-billing card: it writes one line at a time, so it needs the id, and it shows
 * what the customer is actually charged for a receipt, so it needs the flag. The ledger itself
 * ignores both. The 0270 trio - which supplier ACCOUNT this bill belongs to, the supplier's own
 * invoice number, and whether the document is a statement covering several invoices - rides along
 * for the supplier card.
 *
 * AND IT SURVIVES ITS OWN MIGRATION NOT BEING THERE. A push deploys before its migration runs, and
 * PostgREST rejects the WHOLE query for one unknown column - the exact failure that made PO-003
 * render as an empty purchase order under a $3,274 total (bug 7a6b17a8). Here the casualty would
 * be every bill on the page, so the one error shape a missing column makes walks DOWN a ladder,
 * dropping the newest columns first and the oldest last. A line that comes back with no flag reads
 * as billed, which is what the column defaults to; a bill that comes back with no account reads as
 * unfiled, which is what every bill was the day before 0270.
 */
type BillColumns = { billable: boolean; supplierAccount: boolean; supersede: boolean };

/** The one error shape a column the database hasn't got yet makes. Matched on the code first,
 *  because the message wording is PostgREST's to change; the names are the fallback for a proxy
 *  that swallows the code. */
function isMissingColumn(err: unknown): boolean {
  const code = String((err as { code?: string })?.code ?? "");
  const message = String((err as { message?: string })?.message ?? "");
  return (
    code === "42703" ||
    /does not exist/i.test(message) ||
    /\b(billable|supplier_account_id|supplier_invoice_number|is_statement|superseded_by_bill_id|pricing_provisional)\b/i.test(
      message,
    )
  );
}

async function readBills(supabase: Awaited<ReturnType<typeof createClient>>) {
  const columns = (o: BillColumns) =>
    `id, supplier, bill_number, amount, status, bill_date, job_id, category, notes${o.supplierAccount ? ", supplier_account_id, supplier_invoice_number, is_statement" : ""}${o.supersede ? ", superseded_by_bill_id, pricing_provisional" : ""}, jobs(job_number, name), bill_line_items(id, description, quantity, unit_price, amount, category${o.billable ? ", billable" : ""}, sort_order)`;
  const read = (o: BillColumns) =>
    supabase.from("bills").select(columns(o)).order("created_at", { ascending: false });

  // Newest columns fall off first. Four attempts is the worst case and it only happens on a
  // database that is behind the deploy; the normal path is one query, same as before.
  const ladder: BillColumns[] = [
    { billable: true, supplierAccount: true, supersede: true },
    { billable: true, supplierAccount: true, supersede: false },
    { billable: true, supplierAccount: false, supersede: false },
    { billable: false, supplierAccount: false, supersede: false },
  ];
  let attempt = await read(ladder[0]);
  for (let i = 1; i < ladder.length; i++) {
    if (!attempt.error || !isMissingColumn(attempt.error)) return attempt;
    attempt = await read(ladder[i]);
  }
  return attempt;
}

export default async function BillsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { data: profile } = await supabase
    .from("profiles")
    .select("org_id")
    .eq("id", user?.id ?? "")
    .maybeSingle();
  const orgId = profile?.org_id ?? "";

  // EVERYTHING THIS PAGE NEEDS, IN ONE BREATH. The supplier reads (0270) join the existing five
  // rather than hanging off them, because a serial hop added to a page read is the phone-lag class
  // all over again (audit v921: the app was awaiting a ~31-query badge before every page). None of
  // them depends on the others, and a database without 0270 answers them with an error and a null
  // - which reads here as "no accounts yet", exactly the state Erik is in today.
  const [
    { data: pos },
    { data: bills },
    { data: docRows },
    { data: jobs },
    { data: lists },
    { data: accountRows, error: accountsErr },
    { data: aliasRows },
    { data: paymentRows },
    { data: orgRow },
  ] = await Promise.all([
    supabase
      .from("purchase_orders")
      .select("id, po_number, vendor, status, total, jobs(name)")
      .order("created_at", { ascending: false }),
    readBills(supabase),
    supabase
      .from("documents")
      .select("id, name, category, file_url, size_bytes, created_at, job_id, jobs(name)")
      .in("category", ["Receipt", "Bill"])
      .order("created_at", { ascending: false }),
    supabase.from("jobs").select("id, job_number, name").order("created_at", { ascending: false }).limit(100),
    supabase.from("material_lists").select("id, name").order("created_at", { ascending: false }).limit(100),
    supabase
      .from("supplier_accounts")
      .select("id, name, account_number, branch_code, on_account, note")
      .order("name", { ascending: true })
      .limit(500),
    supabase
      .from("supplier_aliases")
      .select("id, supplier_account_id, alias, branch_label")
      .order("alias", { ascending: true })
      .limit(2000),
    // VOIDED PAYMENTS COME BACK TOO. They stop counting and they stay on the screen - that is the
    // whole difference between voiding and deleting, and a list that hid them would leave a
    // balance that moved with nothing on the page to explain it.
    supabase
      .from("supplier_payments")
      .select("id, supplier_account_id, amount, paid_on, method, reference, note, voided_at")
      .order("paid_on", { ascending: false })
      .limit(2000),
    // THE ORG'S TODAY, never the browser's day. It dates a payment and it ages a bill, and a
    // check written at 5pm in Truckee is not tomorrow's check.
    supabase.from("organizations").select("settings").limit(1).maybeSingle(),
  ]);
  const today = todayStrInTz(getOrgSettings((orgRow as { settings?: unknown } | null)?.settings).timezone);

  // Sort each bill's embedded line items by sort_order for display.
  const billsWithLines = (bills ?? []).map((b: any) => ({
    ...b,
    line_items: [...(b.bill_line_items ?? [])].sort((a: any, c: any) => (a.sort_order ?? 0) - (c.sort_order ?? 0)),
  }));

  // ── THE RECEIPTS WHOSE LINES ARE STILL A DECISION (0268) ────────────────────────────────────
  // Only bills ON A JOB, and only bills that were actually itemised. An overhead receipt never
  // reaches a customer, so "billed to the customer" is a question it does not have; a bill typed
  // in by hand has no lines to switch. Both would be noise in a card that exists to answer one
  // question: what of this receipt does the homeowner pay for?
  /**
   * A SET-ASIDE DUPLICATE MUST NOT BE OFFERED FOR BILLING (review of cn-v963). `liveBills` is
   * hoisted here from further down the file because this was the first place that needed it and did
   * not have it: receiptBills was built off every bill, so the copy Erik had just marked as the
   * duplicate kept its eight line items, kept its card, and could have its lines imported onto an
   * invoice - charging the homeowner for one CED ticket twice, through the very screen built to
   * stop that happening.
   */
  const liveBills = (billsWithLines as any[]).filter((b) => !b.superseded_by_bill_id);
  const receiptBills = liveBills.filter((b: any) => b.job_id && (b.line_items?.length ?? 0) > 0);
  const receiptJobIds = Array.from(new Set(receiptBills.map((b: any) => String(b.job_id))));

  /**
   * Which of those receipts an invoice already holds. The importer skips a bill that is already
   * claimed, forever after, so a switch on a claimed line could not move a single dollar — and a
   * live control that cannot do anything is the dead end this wave is here to delete. One read
   * covers every job on the page, and it looks at BOTH claim shapes: the `bill:<id>` import key
   * older invoices carry and the `source_ids` array 0255 added. A claim read that fails (0255 not
   * applied yet, a refused query) leaves the map empty, which leaves the switches live: a flip
   * that turns out to be a no-op is a far smaller wrong than a receipt Erik cannot correct.
   */
  // The claimant's STATUS travels with its number, because "already billed" is two different
  // situations wearing one word (review of this wave, 2026-09-18). A receipt claimed by a bill the
  // customer is holding really is settled: the only way to take something off it is a credit. A
  // receipt claimed by a DRAFT is not settled at all — that invoice's lines are still editable, so
  // telling him it is locked would be the same false wall this wave exists to tear down, built one
  // page over.
  const billedOn = new Map<string, { label: string; status: string }>();
  const readClaims = async () => {
    if (!receiptJobIds.length) return;
    const { data: claimRows } = await supabase
      .from("invoice_items")
      .select("import_key, source_ids, invoices!inner(invoice_number, status, created_at, job_id)")
      .in("invoices.job_id", receiptJobIds)
      .neq("invoices.status", "void")
      .limit(5000);
    // Earliest invoice wins a contested bill, so the sentence on the card is stable no matter what
    // order PostgREST hands the rows back.
    const oldestFirst = [...((claimRows ?? []) as any[])].sort((a, b) =>
      String(a.invoices?.created_at ?? "").localeCompare(String(b.invoices?.created_at ?? "")),
    );
    for (const row of oldestFirst) {
      const label = row.invoices?.invoice_number || "an earlier invoice";
      const status = String(row.invoices?.status ?? "");
      for (const id of claimedIdsOfLines([{ import_key: row.import_key, source_ids: row.source_ids }])) {
        if (!billedOn.has(id)) billedOn.set(id, { label, status });
      }
    }
  };

  // Sign the receipt/bill document URLs — ONE round trip for the whole page (audit v921).
  // This was createSignedUrl per row inside a map: every photographed receipt was its own JWT
  // mint + HTTPS hop, and this list has no ceiling, so the fan-out grew with the shoebox.
  // documents.file_url is nullable (Organize notes have no file) — a null path throws a
  // TypeError that storage-js rethrows, crashing the RSC render, so fileless rows never go in.
  const paths = Array.from(new Set((docRows ?? []).map((d: any) => d.file_url).filter(Boolean))) as string[];
  const signed = new Map<string, string>();
  const signPaths = async () => {
    if (!paths.length) return;
    try {
      const { data } = await supabase.storage.from("documents").createSignedUrls(paths, 3600);
      for (const s of data ?? []) if (s.path && s.signedUrl) signed.set(s.path, s.signedUrl);
    } catch {
      // A signing failure drops the LINKS, never the page — the rows still list what's on file.
    }
  };
  // The claim read and the signing both depend on the first wave's rows and on nothing else, so
  // they ride together. Adding a second serial hop to this page was the phone-lag class all over
  // again (audit v921) and it is not worth one sentence on a card.
  await Promise.all([signPaths(), readClaims()]);
  const docs = (docRows ?? []).map((d: any) => ({ ...d, signedUrl: (d.file_url && signed.get(d.file_url)) || null }));

  const receiptsForBilling: ReceiptForBilling[] = receiptBills.map((b: any) => ({
    id: String(b.id),
    supplier: b.supplier ?? "Receipt",
    bill_date: b.bill_date ?? null,
    job_id: b.job_id ?? null,
    job_name: b.jobs?.name ?? null,
    amount: Number(b.amount) || 0,
    billedOn: billedOn.get(String(b.id)) ?? null,
    lines: (b.line_items ?? []).map((l: any) => ({
      id: String(l.id),
      description: String(l.description ?? ""),
      quantity: Number(l.quantity) || 0,
      amount: Number(l.amount) || 0,
      category: l.category ?? null,
      // A row written before 0268 ran comes back without the column at all. Reading a missing
      // flag as "not billed" would take money off invoices nobody asked to change, so the
      // absence means billed — the same direction the column's own default takes.
      billable: l.billable !== false,
    })),
  }));

  // ── WHAT HE OWES HIS SUPPLIERS (migration 0270) ─────────────────────────────────────────────
  //
  // Owed = an account's UNPAID bills minus its live payments. The same Earned-minus-Paid shape
  // payroll settled on two nights ago, for the reason he gave for both:
  //
  //   "yes i pay them in chunks that never match the ticckets"
  //
  // THE ARITHMETIC IS NOT DONE HERE. supplierBalance() is a pure function with a test around it and
  // the card calls it on the rows this page hands over. A second copy of a money rule on a page is
  // how two screens end up disagreeing about the same dollar (the 24%-vs-82% budget bug, audit
  // v800), so this file's whole job is to hand over rows, spelled and totalled once.
  const spellingKey = (raw: unknown) => String(raw ?? "").trim().toLowerCase();

  const supplierPayments = ((paymentRows ?? []) as any[]).map((r) => ({
    id: String(r.id),
    accountId: String(r.supplier_account_id ?? ""),
    amount: Number(r.amount) || 0,
    paidOn: String(r.paid_on ?? ""),
    method: String(r.method ?? "other"),
    reference: r.reference ?? null,
    note: r.note ?? null,
    // A VOIDED PAYMENT IS A FACT, NOT AN ABSENCE. It stays on the list, crossed out, and stops
    // counting - void, never delete, like every other money row in this app.
    voided: !!r.voided_at,
  }));

  const toBillRow = (b: any): SupplierBillRow => ({
    id: String(b.id),
    supplier: String(b.supplier ?? ""),
    billDate: b.bill_date ?? null,
    amount: Number(b.amount) || 0,
    status: String(b.status ?? ""),
    jobId: b.job_id ?? null,
    jobName: b.jobs?.name ?? null,
    // THE NUMBER IS ALREADY IN THE DATA, AND NOTHING WAS READING IT HERE (review, 2026-09-19).
    // `supplier_invoice_number` is a column nothing in the tree writes yet, so it is null on all
    // 21 bills and these rows would have shown no invoice number for the life of the feature -
    // while the duplicate finder further down was reading it perfectly well out of the very same
    // bills. readBillInvoice recovers it from the CED portal filename sitting in `notes`
    // (TR-34426_20260616_32136931_...) or from the numbers OCR captured inside line text
    // ("(Invoice 8802-1101363)"). Persisting it is a later job; reading it costs nothing.
    ...(() => {
      const stored = b.supplier_invoice_number ?? null;
      if (stored) return { invoiceNumber: stored, isStatement: !!b.is_statement };
      const reading = readBillInvoice({
        notes: b.notes ?? null,
        lineDescriptions: (b.line_items ?? []).map((l: any) => l.description),
      });
      return {
        invoiceNumber: reading.invoiceNumber,
        // A document carrying more than one invoice number IS a statement, whatever the column says
        // - which is what arrived in his email import.
        isStatement: !!b.is_statement || reading.isStatement,
      };
    })(),
  });

  // A SUPERSEDED BILL STOPS COUNTING (0271). It keeps its rows and its history and it still shows
  // in the ledger below; it just never lands in a balance, because the bill that replaced it
  // already has. Counting both is the duplicate problem wearing a different hat.

  const aliasesOf = new Map<string, { alias: string; branchLabel: string | null }[]>();
  for (const a of (aliasRows ?? []) as any[]) {
    const key = String(a.supplier_account_id ?? "");
    if (!key) continue;
    aliasesOf.set(key, [
      ...(aliasesOf.get(key) ?? []),
      { alias: String(a.alias ?? ""), branchLabel: a.branch_label ?? null },
    ]);
  }

  const billsOf = new Map<string, SupplierBillRow[]>();
  for (const b of liveBills) {
    const key = String(b.supplier_account_id ?? "");
    if (!key) continue;
    billsOf.set(key, [...(billsOf.get(key) ?? []), toBillRow(b)]);
  }

  const supplierAccounts: SupplierAccountRow[] = ((accountRows ?? []) as any[]).map((a) => {
    const id = String(a.id);
    return {
      id,
      name: String(a.name ?? ""),
      accountNumber: a.account_number ?? null,
      branchCode: a.branch_code ?? null,
      onAccount: a.on_account !== false,
      note: a.note ?? null,
      aliases: aliasesOf.get(id) ?? [],
      bills: billsOf.get(id) ?? [],
      payments: supplierPayments.filter((p) => p.accountId === id),
    };
  });

  // ── THE SPELLINGS NOBODY HAS FILED YET ──────────────────────────────────────────────────────
  //
  // Sixteen distinct supplier strings for about nine real vendors, because the receipt reader
  // writes `bills.supplier` afresh on every scan. CED alone is five of them, holding $12,572.20
  // between them. They are grouped by the EXACT spelling, lowercased - the same key
  // supplier_aliases is unique on and the same key resolveSupplierAccount matches - so what he
  // reads in a row is exactly what that row's button will move. No more, no less.
  type UnfiledSpelling = { alias: string; bills: number; total: number; unpaid: number; unpaidBills: number };
  const unfiled = new Map<string, UnfiledSpelling>();
  for (const b of liveBills) {
    if (b.supplier_account_id) continue;
    const alias = String(b.supplier ?? "").trim();
    // A bill with no supplier name at all is not a spelling to file. It stays in the ledger below
    // exactly as it reads today, rather than becoming a nameless row in a card about names.
    if (!alias) continue;
    const key = spellingKey(alias);
    const g = unfiled.get(key) ?? { alias, bills: 0, total: 0, unpaid: 0, unpaidBills: 0 };
    const amount = Number(b.amount) || 0;
    g.bills += 1;
    g.total = Math.round((g.total + amount) * 100) / 100;
    if (isOnAccountBill({ status: String(b.status ?? "") })) {
      g.unpaid = Math.round((g.unpaid + amount) * 100) / 100;
      g.unpaidBills += 1;
    }
    unfiled.set(key, g);
  }

  // Every dollar on this page is accounted for somewhere. Until a spelling is on an account its
  // money belongs to no balance on the card, and the Unpaid tab further down is still counting it
  // - saying that out loud is the only thing that keeps the two halves of one screen from arguing.
  //
  // BOTH FIGURES ARE ABOUT THE SAME BILLS. The card reads this as "$X across N bills is not on a
  // supplier account yet, so it is not in the total above", and the total above is what he OWES -
  // so a count that quietly included receipts he already paid at the register would make one
  // sentence out of two different piles.
  const unassigned = {
    bills: [...unfiled.values()].reduce((n, g) => n + g.unpaidBills, 0),
    total: Math.round([...unfiled.values()].reduce((s, g) => s + g.unpaid, 0) * 100) / 100,
  };

  // ── WHICH SPELLINGS LOOK LIKE ONE ACCOUNT ───────────────────────────────────────────────────
  //
  // Suggestions, and only suggestions: nothing is merged, renamed or re-filed until he presses
  // something. The names of the accounts he already has go into the same read, so a CED receipt
  // scanned next Tuesday is offered to the CED account instead of proposing a second one.
  //
  // A LONE SPELLING WITH NO RELATIVE IS NOT PROPOSED. On that card, Accept would make it an account
  // of its own - and so would "Not The Same", which sets it aside as a supplier of its own. Two
  // buttons doing the same thing is worse than no button: he would press one and learn nothing
  // about what the app thinks. Those bills keep behaving exactly as they do today, their money is
  // named in the unassigned line above, and a door to file one spelling by hand is the handoff
  // this wave leaves open.
  const accountKeyToId = new Map<string, string>();
  for (const a of supplierAccounts) {
    accountKeyToId.set(spellingKey(a.name), a.id);
    for (const al of a.aliases) accountKeyToId.set(spellingKey(al.alias), a.id);
  }
  const identity = suggestSupplierGroups([
    ...[...unfiled.values()].map((g) => g.alias),
    ...supplierAccounts.flatMap((a) => [a.name, ...a.aliases.map((x) => x.alias)]),
  ]);

  const proposals: SupplierMergeProposal[] = [];
  for (const group of identity.groups) {
    const members = group.members.map((m) => ({ m, key: spellingKey(m) }));
    const mine = members.filter((x) => unfiled.has(x.key));
    if (!mine.length) continue; // nothing left to file: this group is already an account
    // A group can touch more than one account he already has (two accounts whose names look
    // alike). Joining two existing accounts is a question this wave has no door for, so the row
    // offers the one it can answer - and it picks by NAME, not by whatever order the matcher
    // happened to return, so the same pile proposes the same thing every time he loads the page.
    const existing =
      members
        .map((x) => accountKeyToId.get(x.key))
        .filter((id): id is string => !!id)
        .map((id) => supplierAccounts.find((a) => a.id === id))
        .filter((a): a is SupplierAccountRow => !!a)
        .sort((a, b) => a.name.localeCompare(b.name))[0] ?? null;
    if (mine.length < 2 && !existing) continue; // see above: both buttons would do the same thing
    const spellings: SupplierSpelling[] = mine.map((x) => {
      const g = unfiled.get(x.key) as UnfiledSpelling;
      return { alias: g.alias, bills: g.bills, total: g.total, unpaid: g.unpaid };
    });
    proposals.push({
      // THE ID IS THE SPELLINGS, as JSON. "Not The Same" hands the server nothing but this one
      // string, so the string has to carry what it is about - and JSON rather than a separator
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
  // most ordinary case there is - so it gets its own one-press row instead of waiting for the
  // fuzzy matcher to have an opinion about it.
  const proposedKeys = new Set(proposals.flatMap((p) => p.spellings.map((s) => spellingKey(s.alias))));
  for (const [key, g] of unfiled) {
    if (proposedKeys.has(key)) continue;
    const accountId = resolveSupplierAccount(g.alias, (aliasRows ?? []) as any[]);
    const account = accountId ? supplierAccounts.find((a) => a.id === accountId) ?? null : null;
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

  // ── THE SAME TICKET, FILED TO TWO JOBS ──────────────────────────────────────────────────────
  //
  // An identical CED ticket - $95.27, eight lines, line for line to the penny - is filed to BOTH
  // "13631 Northwoods" (07-29, from the portal PDF) and "85 Whitney Place" (08-28, from a file he
  // saved as "85 Whit.pdf"). One of those jobs is carrying a cost that is not its own, and its
  // profit is wrong by exactly that much. WHICH COPY IS THE REAL ONE IS ERIK'S KNOWLEDGE: he was
  // on those jobs. The page only asks.
  //
  // Built from whatever matched, never hard-coded to that one bill - and offered only when the
  // database actually has 0271's `superseded_by_bill_id`, which is where the answer gets written.
  // Without that column the picker could only refuse, and a control that can only refuse must not
  // render at all.
  const supersedeReady = (billsWithLines as any[]).every((b) => "superseded_by_bill_id" in b);
  const billById = new Map((billsWithLines as any[]).map((b) => [String(b.id), b]));
  const fingerprints: BillFingerprint[] = (billsWithLines as any[]).map((b) => {
    const reading = readBillInvoice({
      notes: b.notes ?? null,
      lineDescriptions: (b.line_items ?? []).map((l: any) => l.description),
    });
    return {
      id: String(b.id),
      supplier: String(b.supplier ?? ""),
      amount: Number(b.amount) || 0,
      billDate: b.bill_date ?? null,
      jobLabel: b.jobs?.name ?? null,
      lineCount: (b.line_items ?? []).length,
      invoiceNumber: b.supplier_invoice_number ?? reading.invoiceNumber,
    };
  });
  const duplicates: DuplicateBillGroup[] = supersedeReady
    ? findDuplicateBills(fingerprints).map((d) => {
        const ids = d.bills.map((b) => String(b.id));
        const copies = ids.map((id) => {
          const row = billById.get(id);
          return {
            billId: id,
            jobId: row?.job_id ?? null,
            jobName: row?.jobs?.name ?? null,
            billDate: row?.bill_date ?? null,
            supplier: String(row?.supplier ?? ""),
            // Where it came from, in the importer's own words: the CED portal filename, or
            // "85 Whit.pdf". On two tickets identical to the penny it is the one thing that tells
            // them apart on sight.
            source: String(row?.notes ?? "").split(/\r?\n/)[0] || null,
          };
        });
        // Already sorted out? The copy he set aside points at the copy he kept.
        const supersededCopy = copies.find((c) => billById.get(c.billId)?.superseded_by_bill_id);
        const keptBillId = supersededCopy
          ? String(billById.get(supersededCopy.billId)?.superseded_by_bill_id ?? "")
          : "";
        return {
          // BOTH BILL IDS RIDE IN THE ID, because Undo is handed nothing else.
          id: `dup:${JSON.stringify([...ids].sort())}`,
          amount: d.amount,
          lineCount: Number(d.bills[0]?.lineCount ?? 0),
          copies,
          resolution: keptBillId && ids.includes(keptBillId) ? { keptBillId } : null,
        };
      })
    : [];

  return (
    <div>
      <PageHeader
        title="Bills & purchasing"
        description="Purchase orders, supplier bills, and receipts across every job."
      />

      {/* WHO HE OWES COMES FIRST. It is the question this screen opens on - $13,040.07 unpaid, and
          every dollar of it one CED account wearing five spellings. A card that answers it below
          the fold is a card he has to go looking for.

          IT IS NOT RENDERED AT ALL when the accounts read came back an error, which on this page
          means one thing: a deploy that landed ahead of its migration. An empty supplier card
          whose every button can only refuse is the dead end this wave exists to delete, so for
          those few minutes the page is exactly the page it was yesterday. */}
      {!accountsErr && (
        <SuppliersCard
          accounts={supplierAccounts}
          today={today}
          unassigned={unassigned}
          proposals={proposals}
          duplicates={duplicates}
          actions={{
            acceptMerge: acceptSupplierMerge,
            dismissMerge: dismissSupplierMerge,
            resolveDuplicate: resolveDuplicateBill,
            unresolveDuplicate: unresolveDuplicateBill,
            recordPayment: recordSupplierPayment,
            voidPayment: voidSupplierPayment,
            setOnAccount: setSupplierOnAccount,
          }}
        />
      )}

      <ReceiptBillingCard receipts={receiptsForBilling} />

      <BillsReceipts
        orgId={orgId}
        jobs={jobs ?? []}
        lists={lists ?? []}
        pos={(pos ?? []) as any}
        bills={billsWithLines as any}
        docs={docs as any}
      />
    </div>
  );
}
