"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Badge, statusTone } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Modal, ModalActions } from "@/components/ui/modal";
import { useToast } from "@/components/toast";
import { Fold, WhyFold } from "@/components/why-fold";
import { openFoldsTo } from "@/components/fold-opener";
import { RowMoreSheet, SHEET_ROW } from "@/components/row-more-sheet";
import { formatCurrency, formatDate } from "@/lib/utils";
import { deleteDocument } from "../jobs/actions";
import { BillRowDoors } from "@/components/bill-row-doors";
import { BillPaperDoors } from "@/components/bill-paper-doors";
import type { BillPaper } from "@/lib/job-photos";
import { executeAction } from "@/lib/actions/execute";
import { NewPoButton } from "../purchasing/new-po-button";
import { FeatureOffLine } from "@/components/feature-off-line";
import { ALL_ON, featureOn, type FeatureMap } from "@/lib/features";
import { jobLabel } from "@/lib/schedule-options";
import { BUSINESS_COST_BUCKETS, bucketOf } from "@/lib/business-cost-buckets";
import { isShelfTicket } from "@/lib/shelf-plan";
import { splitReceiptBilling } from "./receipt-billing";
import { ReceiptLines, type ReceiptForBilling } from "./receipt-billing-card";
import { AlreadyBilledButton, NotBilledAfterAllButton } from "@/components/already-billed-sheet";
import type { BillAlreadyBilled } from "@/lib/already-billed";
import { isOpenBill } from "@/lib/open-counts";
import { useBillsSearch } from "./bills-search-box";

interface JobOption {
  id: string;
  job_number: string;
  name: string;
}
interface ListOption {
  id: string;
  name: string;
}
interface PoRow {
  id: string;
  po_number: string;
  vendor: string;
  status: string;
  total: number;
  jobs?: { name: string } | null;
}
interface BillLineRow {
  description: string;
  quantity: number;
  unit_price: number;
  amount: number;
  category: string | null;
}
export interface BillRow {
  id: string;
  supplier: string;
  bill_number: string | null;
  amount: number;
  status: string;
  bill_date: string | null;
  job_id: string | null;
  category: string | null;
  jobs?: { job_number: string; name: string } | null;
  line_items?: BillLineRow[];
  /**
   * THE SUPPLIER'S NUMBER ON EVERY ROW (Wave B): the typed bill number, else the number the
   * supplier printed (supplier_invoice_number), else the one readBillInvoice finds in the PDF's
   * name or the lines ("8802-1107820"). Worked out on the page; the ledger only prints it.
   */
  shownNumber?: string | null;
  /** Set aside as the duplicate of another bill (0271): still listed, never counted. */
  superseded?: boolean;
  /**
   * The receipt's per-line billing switches (0268/0272), when this bill is a live receipt on a job
   * with lines. They live in the bill's own detail now: one place per bill, no second list.
   */
  receipt?: ReceiptForBilling | null;
  /** The paper this bill was read from (lib/job-photos billPapers), opened from its row. */
  papers?: BillPaper[] | null;
}
interface DocRow {
  id: string;
  name: string;
  category: string | null;
  file_url: string | null; // null = Organize note filed to a job (no file)
  size_bytes: number | null;
  created_at: string;
  job_id: string | null;
  signedUrl: string | null;
  jobs?: { name: string } | null;
}

/**
 * ALREADY BILLED ON THE BILL'S OWN ROW (0357, Erik: "the Already Billed could connect to the bill on
 * that screen too"): the same sheet the job's Costs tab opens, from the bill he is looking at, or the
 * mark it carries with its way back. Nothing when the page offers neither.
 */
export function BillAlreadyBilledDoor({ bill, door }: { bill: Pick<BillRow, "id">; door?: BillAlreadyBilled | null }) {
  if (!door) return null;
  if (door.kind === "open") return <AlreadyBilledButton jobId={door.jobId} target={{ kind: "bill", ids: [bill.id], what: door.what }} />;
  return (
    <>
      <span className="text-xs font-medium text-slate-600">Billed By Hand On {door.invoiceNumber ?? "That Invoice"}</span>
      <NotBilledAfterAllButton jobId={door.jobId} lineId={door.lineId} ids={door.ids} what={door.what} />
    </>
  );
}

/** What kind of row it is, in one small word before its name: a purchase order, or a file. */
function Kind({ children }: { children: string }) {
  return <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500">{children}</span>;
}

/**
 * ALL BILLS: ONE SEARCHABLE LIST (W1-32; it had Bills, Purchase Orders and Receipts tabs, and All /
 * Job Bills / Business Costs chips over the bills).
 *
 * One line on the page, leading with what is OPEN ("All Bills · 9 Unpaid $X", never a total count),
 * that opens to every bill (each ONE ROW with the supplier's number, opening to its detail: how it
 * was bought, Edit, Delete, and its lines with their billing switches), every purchase order (a PO
 * chip; they count in job cost whatever the switch says, so they are always listed) and every
 * receipt file no bill holds yet (a File chip; Delete behind its ⋯). The search box at the top of the
 * page filters it in place (bills-search-box). New PO is on the list's ⋯ while Purchase Orders is on.
 *
 * Every row is in the page, so a link to a bill ("#bill-...") always has somewhere to land and
 * FoldOpener opens the folds around it; a typed filter that would hide it is cleared first.
 * /purchasing lands here as ?tab=po: the list open, the orders first.
 */
export function BillsReceipts({
  // Unused since the Receipts upload went (Wave 0); kept so the page's call doesn't change.
  orgId: _orgId,
  jobs,
  lists,
  pos,
  bills,
  docs,
  readFailed = false,
  papersNote = null,
  switches = { features: ALL_ON, isOwner: false },
  alreadyBilled = {},
}: {
  orgId: string;
  jobs: JobOption[];
  lists: ListOption[];
  pos: PoRow[];
  bills: BillRow[];
  /** The receipt files no bill holds yet (the page decides; every file when it couldn't tell). */
  docs: DocRow[];
  /** The bills read failed (audit v1018, class 2): said, never "No bills here yet" and $0.00. */
  readFailed?: boolean;
  /** Said above the bills when the page couldn't read which receipt made which bill: every row then
   *  draws no Receipt door, and a bill that has one must not look like one that never had any. */
  papersNote?: string | null;
  /** The switch board (0352). Purchase Orders off: New PO goes, and the orders are still listed,
   *  under the Off line. Shop Stock off: a receipt line isn't offered to stock. Absent = all on. */
  switches?: { features: FeatureMap; isOwner: boolean };
  /** ALREADY BILLED on a bill's own row (0357), by bill id (lib/already-billed billAlreadyBilledDoors):
   *  Already Billed where its job's sheet could hold it, or Billed By Hand On INV-x with Not Billed
   *  After All. A bill with no entry has neither. */
  alreadyBilled?: Record<string, BillAlreadyBilled>;
}) {
  const poOn = featureOn(switches.features, "purchase_orders");
  const router = useRouter();
  const toast = useToast();
  const { query, setQuery, keys } = useBillsSearch();
  // A deep link says what leads: ?tab=po (from /purchasing) puts the orders first, ?tab=receipts
  // the files. The list opens with it. Without one, bills lead.
  const spTab = useSearchParams().get("tab");
  const lead: "po" | "files" | null = spTab === "po" ? "po" : spTab === "receipts" ? "files" : null;
  const [pending, start] = useTransition();
  const [editBill, setEditBill] = useState<BillRow | null>(null);

  // A LINK TO A BILL ALWAYS LANDS ON IT. FoldOpener opens the folds around "#bill-<id>"; a typed
  // filter that leaves it out would leave nothing to land on, so a bill link clears the filter first
  // and opens the row once the list has re-rendered (the effect below). `n` makes the same link twice
  // in a row land twice.
  const [landOn, setLandOn] = useState<{ id: string; n: number } | null>(null);
  useEffect(() => {
    const idOf = (hash: string) => {
      try {
        return decodeURIComponent(hash.replace(/^#/, ""));
      } catch {
        return hash.replace(/^#/, "");
      }
    };
    const land = (hash: string) => {
      const id = idOf(hash);
      if (!id.startsWith("bill-")) return;
      setQuery("");
      setLandOn((prev) => ({ id, n: (prev?.n ?? 0) + 1 }));
    };
    land(window.location.hash);
    const onHash = () => land(window.location.hash);
    const onClick = (e: MouseEvent) => {
      const a = (e.target as HTMLElement | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a) return;
      const url = new URL(a.href, window.location.href);
      if (url.pathname === window.location.pathname && url.hash) land(url.hash);
    };
    window.addEventListener("hashchange", onHash);
    document.addEventListener("click", onClick);
    return () => {
      window.removeEventListener("hashchange", onHash);
      document.removeEventListener("click", onClick);
    };
  }, [setQuery]);
  useEffect(() => {
    if (landOn) openFoldsTo(landOn.id);
  }, [landOn]);
  // Typing in the search box opens the list, so what it kept is there to see.
  useEffect(() => {
    if (!keys) return;
    const fold = document.getElementById("all-bills");
    if (fold instanceof HTMLDetailsElement && !fold.open) fold.open = true;
  }, [keys]);
  // Landing from /purchasing: the list open, and in view.
  useEffect(() => {
    if (lead === "po") openFoldsTo("all-bills");
  }, [lead]);

  const kept = (key: string) => !keys || keys.has(key);
  const shownBills = bills.filter((b) => kept(`bill:${b.id}`));
  const shownPos = pos.filter((p) => kept(`po:${p.id}`));
  const shownDocs = docs.filter((d) => kept(`file:${d.id}`));
  const shownCount = shownBills.length + shownPos.length + shownDocs.length;
  const allCount = bills.length + pos.length + docs.length;
  // WHAT IS OPEN LEADS THE LINE: the bills still owed (a copy set aside as a duplicate is listed,
  // struck through, and never counted), never how many rows the list holds.
  const unpaid = bills.filter((b) => isOpenBill(b));
  const unpaidTotal = unpaid.reduce((s, b) => s + (Number(b.amount) || 0), 0);

  const billRows = shownBills.map((b) => {
    const lineCount = b.line_items?.length ?? 0;
    const split = b.receipt ? splitReceiptBilling(b.receipt.amount, b.receipt.lines) : null;
    const where = b.jobs?.name ?? (b.job_id ? "Job" : isShelfTicket(b) ? "Shop Stock" : `Business Cost · ${bucketOf(b.category)}`);
    return (
      <li key={`bill-${b.id}`}>
        {/* ONE ROW PER BILL; it opens to the bill's detail. `bill-<id>` is where the search box, a
            supplier's Open In All Bills and the stock's Put The Rest In Stock land. */}
        <details id={`bill-${b.id}`} className="scroll-mt-20">
          <summary className="flex min-h-11 cursor-pointer list-none items-center gap-3 px-3 py-2 text-sm hover:bg-slate-50 [&::-webkit-details-marker]:hidden">
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium text-slate-900">
                {b.supplier}
                {b.shownNumber ? <span className="font-normal text-slate-500"> #{b.shownNumber}</span> : null}
              </span>
              <span className="block truncate text-xs text-slate-400">
                {b.bill_date ? `${formatDate(b.bill_date)} · ` : ""}
                {where}
                {lineCount > 0 ? ` · ${lineCount} ${lineCount === 1 ? "line" : "lines"}` : ""}
                {b.superseded ? " · set aside as a duplicate" : ""}
              </span>
              {split && split.notBilledCount > 0 && (
                <span className="block text-xs font-medium text-amber-700">
                  {split.notBilledCount} {split.notBilledCount === 1 ? "line" : "lines"} not billed to the customer
                </span>
              )}
              {split && split.partBilledCount > 0 && (
                <span className="block text-xs font-medium text-sky-700">
                  {split.partBilledCount} {split.partBilledCount === 1 ? "line bills" : "lines bill"} only what this job used
                </span>
              )}
            </span>
            <span className="shrink-0 text-right">
              <span className={`block font-medium tabular-nums ${b.superseded ? "text-slate-400 line-through" : "text-slate-800"}`}>{formatCurrency(b.amount)}</span>
              <span className="block text-xs text-slate-400">{b.status === "paid" ? "Settled" : "On Account"}</span>
            </span>
          </summary>

          <div className="border-t border-slate-100 bg-slate-50/60 px-3 py-2">
            <div className="flex flex-wrap items-center gap-2">
              {/* THIS TICK AND THE SUPPLIER BALANCE ARE THE SAME DOLLAR (review, 2026-09-19): the
                  three doors are BillRowDoors, one copy with the job's Costs tab. */}
              {/* The receipt it was read from, with the bill instead of in a job's Photos. */}
              <BillPaperDoors papers={b.papers} />
              <BillRowDoors bill={b} onEdit={() => setEditBill(b)} disabled={pending} />
              <BillAlreadyBilledDoor bill={b} door={alreadyBilled[b.id]} />
              {b.job_id && (
                <Link href={`/jobs/${b.job_id}`} className="flex min-h-11 items-center px-2 text-sm font-medium text-brand hover:underline">
                  Open The Job
                </Link>
              )}
            </div>
            {b.receipt ? (
              <div className="mt-2">
                <ReceiptLines receipt={b.receipt} shopStock={featureOn(switches.features, "shop_stock")} />
              </div>
            ) : lineCount > 0 ? (
              <ul className="mt-2 ml-1 space-y-0.5 border-l-2 border-slate-100 pl-3">
                {b.line_items!.map((li, i) => (
                  <li key={i} className="flex items-center justify-between gap-2 text-xs text-slate-500">
                    <span className="min-w-0 truncate">
                      {li.quantity && li.quantity !== 1 ? `${li.quantity}× ` : ""}
                      {li.description}
                      {li.category ? <span className="ml-1 text-slate-400">· {li.category}</span> : null}
                    </span>
                    <span className="shrink-0 tabular-nums">{formatCurrency(li.amount)}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </details>
      </li>
    );
  });

  // Every order, whatever the switch: an open PO counts in the job's cost, so it is never hidden.
  const poRows = shownPos.map((p) => (
    <li key={`po-${p.id}`} id={`po-${p.id}`} className="scroll-mt-20">
      <Link href={`/purchasing/${p.id}`} className="flex min-h-11 items-center gap-3 px-3 py-2 text-sm hover:bg-slate-50">
        <Kind>PO</Kind>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium text-slate-900">
            {p.po_number} · {p.vendor || "No vendor"}
          </span>
          <span className="block truncate text-xs text-slate-400">{p.jobs?.name ?? "No job"}</span>
        </span>
        <span className="shrink-0 text-right">
          <span className="block font-medium tabular-nums text-slate-800">{formatCurrency(p.total)}</span>
          <Badge tone={statusTone(p.status)}>{p.status}</Badge>
        </span>
      </Link>
    </li>
  ));

  // A receipt file no bill holds yet: open it, and Delete is behind its ⋯ (asked first).
  const fileRows = shownDocs.map((d) => (
    <li key={`file-${d.id}`} id={`file-${d.id}`} className="flex items-center gap-3 px-3 py-1 text-sm">
      <Kind>File</Kind>
      <div className="min-w-0 flex-1">
        {d.signedUrl ? (
          <a href={d.signedUrl} target="_blank" rel="noopener noreferrer" className="flex min-h-11 items-center truncate font-medium text-slate-900 hover:text-brand">
            {d.name}
          </a>
        ) : (
          <span className="block truncate py-2 font-medium text-slate-900">{d.name}</span>
        )}
        <div className="-mt-2 pb-1 text-xs text-slate-400">
          {formatDate(d.created_at)} · {d.jobs?.name ?? "No job"}
        </div>
      </div>
      {d.category && <Badge tone="blue">{d.category}</Badge>}
      <RowMoreSheet title={d.name} subline={d.jobs?.name ?? null}>
        {({ close }) => (
          <button
            type="button"
            className={SHEET_ROW}
            disabled={pending}
            onClick={() => {
              if (!confirm(`Delete "${d.name}"?`)) return;
              start(async () => {
                const res = await deleteDocument(d.id, d.file_url, d.job_id ?? "");
                if (!res?.ok) {
                  toast(res?.error ?? "Couldn't delete it. Try again.", "error");
                  return;
                }
                close();
                toast("Deleted.", "success");
                router.refresh();
              });
            }}
          >
            Delete
          </button>
        )}
      </RowMoreSheet>
    </li>
  ));

  const rows = lead === "po" ? [...poRows, ...billRows, ...fileRows] : lead === "files" ? [...fileRows, ...billRows, ...poRows] : [...billRows, ...poRows, ...fileRows];

  return (
    <Card className="mb-6 px-4 py-1">
      <Fold
        id="all-bills"
        open={!!lead}
        summary={
          <span className="text-base font-semibold text-slate-900">
            All Bills
            <span className={`font-normal ${!readFailed && unpaid.length ? "text-amber-800" : "text-slate-500"}`}>
              {readFailed ? " · Couldn't Read" : unpaid.length ? ` · ${unpaid.length} Unpaid ${formatCurrency(unpaidTotal)}` : " · Nothing Unpaid"}
            </span>
          </span>
        }
      >
        {/* The old receipt card's intro, where the switches now live. */}
        <span id="receipt-billing" className="block scroll-mt-20" />
        <div className="flex items-start justify-between gap-2">
          <WhyFold>
            <p>
              Every bill and purchase order across every job, and every receipt file no bill holds yet. Open a receipt to say
              which of its lines the customer pays for: snacks and drinks start out on you, everything else starts out billed,
              and a box or a spool bought whole can bill just what this job used. The search box at the top of the page
              narrows this list.
            </p>
          </WhyFold>
          {/* THE LIST'S ⋯: New PO, while Purchase Orders is on. A plain panel, so the New PO sheet it
              opens stays mounted. */}
          {poOn && (
            <details className="relative shrink-0">
              <summary
                aria-label="More For All Bills"
                title="More"
                className="flex h-11 w-11 cursor-pointer list-none items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 [&::-webkit-details-marker]:hidden"
              >
                <MoreHorizontal className="h-5 w-5" />
              </summary>
              <div className="absolute right-0 z-20 mt-1 rounded-lg border border-slate-200 bg-white p-2 shadow-lg">
                <NewPoButton jobs={jobs} lists={lists} />
              </div>
            </details>
          )}
        </div>

        {pos.length > 0 && <FeatureOffLine feature="purchase_orders" features={switches.features} isOwner={switches.isOwner} className="mb-2" />}
        {keys && !readFailed && (
          <p className="mb-2 flex flex-wrap items-center gap-x-2 text-xs text-slate-500">
            {shownCount} of {allCount} {shownCount === 1 ? "matches" : "match"} &ldquo;{query.trim()}&rdquo;.
            <button type="button" onClick={() => setQuery("")} className="inline-flex min-h-11 items-center text-sm font-medium text-brand hover:underline">
              Show Everything
            </button>
          </p>
        )}
        {!readFailed && papersNote && <p className="mb-2 text-sm text-slate-500">{papersNote}</p>}

        <div className="pb-3">
          {readFailed ? (
            <p className="py-4 text-center text-sm text-amber-800" role="alert">
              Couldn&apos;t read your bills just now. Reload to try again.
            </p>
          ) : rows.length === 0 ? (
            <p className="py-4 text-center text-sm text-slate-400">
              {keys ? `Nothing in All Bills matches “${query.trim()}”.` : "No bills yet. Add one with Snap Or Note at the top of this page."}
            </p>
          ) : (
            <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">{rows}</ul>
          )}
        </div>

        {editBill && <BillEditModal key={editBill.id} bill={editBill} jobs={jobs} onClose={() => setEditBill(null)} />}
      </Fold>
    </Card>
  );
}

/** Edit a supplier bill from the central list. Routes through the unified Action
 *  Registry (executeAction → "bill.update") — the same capability the AI agent calls.
 *  Beyond the job-tab editor this also exposes job link + business-cost bucket so a
 *  business cost can be corrected to a job (or vice-versa) right from here. */
function BillEditModal({
  bill,
  jobs,
  onClose,
}: {
  bill: BillRow;
  jobs: JobOption[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [supplier, setSupplier] = useState(bill.supplier);
  const [billNumber, setBillNumber] = useState(bill.bill_number ?? "");
  const [amount, setAmount] = useState(Number(bill.amount));
  const [status, setStatus] = useState(bill.status);
  const [billDate, setBillDate] = useState(bill.bill_date ?? "");
  const [billJob, setBillJob] = useState(bill.job_id ?? "__overhead");
  // A business cost opens on its own bucket (an old word like "Vehicle", or "Gas & Truck", read as Auto). A job
  // bill's category is a paper kind ("Receipt"), not a bucket, so moving one off its job starts
  // with no bucket and asks for one.
  const [billCategory, setBillCategory] = useState<string>(bill.job_id ? "" : bucketOf(bill.category));
  const [error, setError] = useState<string | null>(null);
  /** What updateBill said about an invoice that bills this receipt. Holds the modal open. */
  const [billedNote, setBilledNote] = useState<string | null>(null);

  const isOverhead = billJob === "__overhead";

  function save() {
    if (!supplier.trim()) return setError("Supplier is required.");
    if (isOverhead && !billCategory) return setError("Pick the bucket this business cost goes in.");
    setError(null);
    start(async () => {
      const res = await executeAction("bill.update", {
        id: bill.id,
        supplier,
        bill_number: billNumber,
        amount,
        status,
        bill_date: billDate || null,
        job_id: isOverhead ? null : billJob,
        category: isOverhead ? billCategory : null,
      });
      if (!res.ok) return setError(res.error ?? "Could not save.");
      // THE SAME SENTENCE THE JOB PAGE HOLDS OPEN (review of the fix wave, 2026-09-20). A re-price
      // on a receipt a live invoice is billing leaves the invoice on its old figure on purpose -
      // the customer was told a number - so the two now describe one purchase at two prices, and
      // that has to be said. This is the main door for editing a receipt, and it was closing clean
      // on exactly that save. `warning` comes back through executeAction verbatim.
      if (res.warning) {
        setBilledNote(res.warning);
        router.refresh();
        return;
      }
      onClose();
      router.refresh();
    });
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Edit Bill"
      footer={<ModalActions onCancel={onClose} onSave={save} saving={pending} disabled={!supplier.trim()} saveLabel="Save Changes" />}
    >
      <div className="space-y-3">
        {billedNote && (
          <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm leading-relaxed text-amber-800">
            <div className="font-semibold">Saved. One thing to know:</div>
            <div className="mt-1">{billedNote}</div>
            <Button variant="outline" size="sm" onClick={onClose} className="mt-2 h-11">
              Got It
            </Button>
          </div>
        )}
        {error && <p className="text-sm text-red-600">{error}</p>}
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2">
            <Label htmlFor="be-supplier">Supplier *</Label>
            <Input id="be-supplier" value={supplier} onChange={(e) => setSupplier(e.target.value)} autoFocus />
          </div>
          <div className="col-span-2">
            <Label htmlFor="be-job">Job</Label>
            <Select id="be-job" value={billJob} onChange={(e) => setBillJob(e.target.value)}>
              <option value="__overhead">Business Cost (No Job)</option>
              {jobs.map((j) => (
                <option key={j.id} value={j.id}>{jobLabel(j)}</option>
              ))}
            </Select>
          </div>
          {isOverhead && (
            <div className="col-span-2">
              <Label htmlFor="be-cat">Bucket</Label>
              <Select id="be-cat" className="h-11" value={billCategory} onChange={(e) => setBillCategory(e.target.value)}>
                <option value="">Pick A Bucket</option>
                {BUSINESS_COST_BUCKETS.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </Select>
            </div>
          )}
          <div>
            <Label htmlFor="be-num">Bill #</Label>
            <Input id="be-num" value={billNumber} onChange={(e) => setBillNumber(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="be-amt">Amount</Label>
            <NumberInput id="be-amt" value={amount} onValueChange={setAmount} />
          </div>
          <div>
            <Label htmlFor="be-date">Bill Date</Label>
            <Input id="be-date" type="date" value={billDate} onChange={(e) => setBillDate(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="be-status">Status</Label>
            <Select id="be-status" value={status} onChange={(e) => setStatus(e.target.value)}>
              {/* The same two words as the add form and the badge: one vocabulary for one
                  column, or the screen teaches him two different meanings for one tick. */}
              <option value="unpaid">On Account</option>
              <option value="paid">Settled At The Counter</option>
            </Select>
          </div>
        </div>
      </div>
    </Modal>
  );
}
