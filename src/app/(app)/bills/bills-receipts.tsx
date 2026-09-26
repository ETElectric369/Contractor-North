"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { DropTarget } from "@/components/drop-target";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Plus, Trash2, Upload, Camera, Loader2, FileText, Pencil } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Badge, statusTone } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Modal, ModalActions } from "@/components/ui/modal";
import { Tabs } from "@/components/tabs";
import { useToast } from "@/components/toast";
import { CameraCapture } from "@/components/camera-capture";
import { Fold, WhyFold } from "@/components/why-fold";
import { openFoldsTo } from "@/components/fold-opener";
import { formatCurrency, formatDate } from "@/lib/utils";
import { createBill, setBillStatus, deleteBill, addDocument, deleteDocument } from "../jobs/actions";
import { executeAction } from "@/lib/actions/execute";
import { NewPoButton } from "../purchasing/new-po-button";
import { jobLabel } from "@/lib/schedule-options";
import { BUSINESS_COST_BUCKETS, bucketOf } from "@/lib/business-cost-buckets";
import { isShelfTicket } from "@/lib/shelf-plan";
import { splitReceiptBilling } from "./receipt-billing";
import { ReceiptLines, type ReceiptForBilling } from "./receipt-billing-card";

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

type LedgerTab = "po" | "bills" | "receipts";

/**
 * ALL BILLS: THE LEDGER, FOLDED (Bills plan, Wave B).
 *
 * One line on the page ("All Bills (58) · $X") that opens to the ledger. Inside, Bills comes first
 * (it opened on the empty Purchase Orders tab), each bill is ONE ROW with the supplier's number on
 * it, and a row opens to that bill's detail: how it was bought, Edit, Delete, and its lines. A
 * receipt's lines carry their billing switches right there, which is where the old 46-row "What
 * Your Customers Get Billed" box (a scroll inside a scroll on a phone) went: one bill, one place.
 *
 * Every tab's panel is in the page (the inactive ones `hidden`), so a link to a bill ("#bill-...",
 * from the search box) always has somewhere to land, and FoldOpener opens the folds around it.
 */
export function BillsReceipts({
  orgId,
  jobs,
  lists,
  pos,
  bills,
  docs,
}: {
  orgId: string;
  jobs: JobOption[];
  lists: ListOption[];
  pos: PoRow[];
  bills: BillRow[];
  docs: DocRow[];
}) {
  const router = useRouter();
  const toast = useToast();
  // Open straight to a tab from a deep link (?tab=po, ?tab=receipts), and open the fold with it.
  // WITHOUT ONE IT OPENS ON BILLS (Bills plan, Wave A).
  const spTab = useSearchParams().get("tab");
  const [tab, setTab] = useState<LedgerTab>(spTab === "po" || spTab === "receipts" ? spTab : "bills");
  const [pending, start] = useTransition();

  // ── Bills add form ──
  const [supplier, setSupplier] = useState("");
  const [billNumber, setBillNumber] = useState("");
  const [amount, setAmount] = useState(0);
  const [status, setStatus] = useState("unpaid");
  const [billDate, setBillDate] = useState("");
  const [billJob, setBillJob] = useState("");
  // No bucket is picked for him: a guessed "Shop supplies" default is how a gas receipt gets
  // filed as supplies because nobody changed the box.
  const [billCategory, setBillCategory] = useState("");
  const [billFilter, setBillFilter] = useState<"all" | "jobs" | "overhead">("all");
  const [billError, setBillError] = useState<string | null>(null);
  const [editBill, setEditBill] = useState<BillRow | null>(null);

  // A LINK TO A BILL ALWAYS LANDS ON IT. FoldOpener opens the folds around "#bill-<id>", but the row
  // is hidden on the Purchase Orders or Receipts tab and not rendered at all under a filter that
  // leaves it out. So a bill link first puts the ledger on Bills, All, then opens the row once the
  // list has re-rendered (the effect below). `n` makes the same link twice in a row land twice.
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
      setTab("bills");
      setBillFilter("all");
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
  }, []);
  useEffect(() => {
    if (landOn) openFoldsTo(landOn.id);
  }, [landOn]);

  const shownBills =
    billFilter === "all" ? bills : bills.filter((b) => (billFilter === "jobs" ? b.job_id : !b.job_id));
  // ONE RULE FOR EVERY TOTAL ON THIS LEDGER: a copy set aside as a duplicate is listed (struck
  // through) but never added, so the fold's line and the list's line always say the same money.
  const liveAmount = (list: BillRow[]) => list.filter((b) => !b.superseded).reduce((s, b) => s + (Number(b.amount) || 0), 0);
  const totalBills = liveAmount(shownBills);
  const shownSetAside = shownBills.filter((b) => b.superseded).length;
  const totalPos = pos.reduce((s, p) => s + Number(p.total), 0);
  const liveTotal = liveAmount(bills);

  function addBill() {
    setBillError(null);
    if (!supplier.trim()) return setBillError("Supplier is required.");
    // A BLANK JOB IS NOT A BUSINESS COST: no job has to be said out loud, with its bucket.
    if (!billJob) return setBillError("Pick a job, or pick Business Cost (No Job) and its bucket.");
    if (billJob === "__overhead" && !billCategory) return setBillError("Pick the bucket this business cost goes in.");
    start(async () => {
      const res = await createBill({
        job_id: billJob === "__overhead" ? null : billJob,
        supplier,
        bill_number: billNumber,
        amount,
        status,
        bill_date: billDate || null,
        notes: "",
        category: billJob === "__overhead" ? billCategory : null,
      });
      if (!res.ok) return setBillError(res.error ?? "Could not save.");
      setSupplier("");
      setBillNumber("");
      setAmount(0);
      setBillDate("");
      router.refresh();
    });
  }

  function toggleStatus(b: BillRow) {
    const next = b.status === "paid" ? "unpaid" : "paid";
    start(async () => {
      const res = await setBillStatus(b.id, next, b.job_id ?? "");
      if (!res?.ok) { toast(res?.error ?? "Couldn't update the bill — try again.", "error"); return; }
      toast(
        next === "paid"
          ? "Marked settled - it comes out of the supplier balance"
          : "Marked on account - it goes back into the supplier balance",
        "success",
      );
      router.refresh();
    });
  }

  function removeBill(b: BillRow) {
    if (!confirm(`Delete bill from "${b.supplier}"?`)) return;
    start(async () => {
      const res = await deleteBill(b.id, b.job_id ?? "");
      if (!res?.ok) { toast(res?.error ?? "Couldn't delete the bill — try again.", "error"); return; }
      toast(res.warning ?? "Bill deleted", "success");
      router.refresh();
    });
  }

  // ── Receipts upload ──
  const fileRef = useRef<HTMLInputElement>(null);
  const [docJob, setDocJob] = useState("");
  const [docCategory, setDocCategory] = useState("Receipt");
  const [busy, setBusy] = useState(false);
  const [docError, setDocError] = useState<string | null>(null);
  const [showCamera, setShowCamera] = useState(false);

  async function uploadFiles(files: File[]) {
    if (!files.length) return;
    setDocError(null);
    if (!docJob) {
      setDocError("Pick a job to attach the receipt to.");
      return;
    }
    setBusy(true);
    try {
      const supabase = createClient();
      for (const file of files) {
        if (file.size > 15 * 1024 * 1024) {
          setDocError(`${file.name} is over 15 MB.`);
          continue;
        }
        const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
        const path = `${orgId}/${docJob}/${Date.now()}-${safe}`;
        const { error: upErr } = await supabase.storage.from("documents").upload(path, file, { upsert: false });
        if (upErr) throw upErr;
        const res = await addDocument({
          job_id: docJob,
          name: file.name,
          category: docCategory,
          file_url: path,
          size_bytes: file.size,
        });
        if (!res.ok) throw new Error(res.error);
      }
      router.refresh();
    } catch (err: any) {
      setDocError(err?.message ?? "Upload failed.");
    } finally {
      setBusy(false);
    }
  }

  function onFiles(e: React.ChangeEvent<HTMLInputElement>) {
    uploadFiles(Array.from(e.target.files ?? []));
    if (fileRef.current) fileRef.current.value = "";
  }

  return (
    <Card className="mb-6 px-4 py-1">
      <Fold
        id="all-bills"
        open={!!spTab}
        summary={
          <span className="flex items-baseline justify-between gap-3">
            <span className="text-base font-semibold text-slate-900">All Bills ({bills.length})</span>
            <span className="shrink-0 text-sm tabular-nums text-slate-500">{formatCurrency(liveTotal)}</span>
          </span>
        }
      >
        {/* The old receipt card's intro, where the switches now live. */}
        <span id="receipt-billing" className="block scroll-mt-20" />
        <WhyFold>
          <p>
            Every bill, receipt, and order across every job. Open a receipt to say which of its lines the customer
            pays for: snacks and drinks start out on you, everything else starts out billed, and a box or a spool
            bought whole can bill just what this job used.
          </p>
        </WhyFold>
        <Tabs
          activeId={tab}
          onChange={(id) => setTab(id as LedgerTab)}
          tabs={[
            { id: "bills", label: "Bills", count: bills.length },
            { id: "po", label: "Purchase Orders", count: pos.length },
            { id: "receipts", label: "Receipts", count: docs.length },
          ]}
        />

        <div hidden={tab !== "bills"} className="pb-3">
          <Fold summary={<span className="text-sm font-medium text-brand">Add A Bill By Hand</span>}>
            <div className="mb-3 space-y-3 rounded-lg border border-slate-200 p-3">
              {billError && <p className="text-sm text-red-600">{billError}</p>}
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <div className="col-span-2 sm:col-span-1">
                  <Label htmlFor="b-supplier">Supplier *</Label>
                  <Input id="b-supplier" value={supplier} onChange={(e) => setSupplier(e.target.value)} placeholder="e.g. CED" />
                </div>
                <div>
                  <Label htmlFor="b-job">Job</Label>
                  <Select id="b-job" value={billJob} onChange={(e) => setBillJob(e.target.value)}>
                    <option value="">Pick A Job</option>
                    <option value="__overhead">Business Cost (No Job)</option>
                    {jobs.map((j) => (
                      <option key={j.id} value={j.id}>{jobLabel(j)}</option>
                    ))}
                  </Select>
                </div>
                {billJob === "__overhead" && (
                  <div>
                    <Label htmlFor="b-cat">Bucket</Label>
                    <Select id="b-cat" className="h-11" value={billCategory} onChange={(e) => setBillCategory(e.target.value)}>
                      <option value="">Pick A Bucket</option>
                      {BUSINESS_COST_BUCKETS.map((c) => (
                        <option key={c} value={c}>{c}</option>
                      ))}
                    </Select>
                  </div>
                )}
                <div>
                  <Label htmlFor="b-num">Bill #</Label>
                  <Input id="b-num" value={billNumber} onChange={(e) => setBillNumber(e.target.value)} />
                </div>
                <div>
                  <Label htmlFor="b-amt">Amount</Label>
                  <NumberInput id="b-amt" value={amount} onValueChange={setAmount} />
                </div>
                <div>
                  <Label htmlFor="b-date">Bill Date</Label>
                  <Input id="b-date" type="date" value={billDate} onChange={(e) => setBillDate(e.target.value)} />
                </div>
                <div>
                  <Label htmlFor="b-status">Status</Label>
                  <Select id="b-status" value={status} onChange={(e) => setStatus(e.target.value)}>
                    {/* HOW THE BILL WAS BOUGHT, not whether a payment exists: a cheque to a supplier
                        is Record A Payment on its Suppliers line. */}
                    <option value="unpaid">On Account</option>
                    <option value="paid">Settled At The Counter</option>
                  </Select>
                </div>
              </div>
              <div className="flex justify-end">
                <Button onClick={addBill} disabled={pending || !supplier.trim()}>
                  <Plus /> Add Bill
                </Button>
              </div>
            </div>
          </Fold>

          <div className="mb-2 flex flex-wrap gap-2">
            {([
              ["all", `All (${bills.length})`],
              ["jobs", `Job Bills (${bills.filter((b) => b.job_id).length})`],
              ["overhead", `Business Costs (${bills.filter((b) => !b.job_id).length})`],
            ] as const).map(([id, label]) => (
              <button
                key={id}
                type="button"
                aria-pressed={billFilter === id}
                onClick={() => setBillFilter(id)}
                className={`min-h-11 rounded-full px-4 text-sm font-medium ${
                  billFilter === id ? "seaglass-active" : "bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50"
                }`}
              >
                <span className="relative z-10">{label}</span>
              </button>
            ))}
          </div>
          <p className="mb-2 text-xs text-slate-500">
            {shownBills.length} {shownBills.length === 1 ? "bill" : "bills"}
            {shownSetAside > 0 ? ` (${shownSetAside} set aside as ${shownSetAside === 1 ? "a duplicate" : "duplicates"}, not added)` : ""} ·{" "}
            {formatCurrency(totalBills)}
          </p>

          {shownBills.length === 0 ? (
            <p className="py-4 text-center text-sm text-slate-400">No bills here yet.</p>
          ) : (
            <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
              {shownBills.map((b) => {
                const lineCount = b.line_items?.length ?? 0;
                const split = b.receipt ? splitReceiptBilling(b.receipt.amount, b.receipt.lines) : null;
                const where = b.jobs?.name ?? (b.job_id ? "Job" : isShelfTicket(b) ? "Shop Stock" : `Business Cost · ${bucketOf(b.category)}`);
                return (
                  <li key={b.id}>
                    {/* ONE ROW PER BILL; it opens to the bill's detail. `bill-<id>` is where the
                        search box and the shelf's "Put The Rest On The Shelf" land. */}
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
                          <span className={`block font-medium tabular-nums ${b.superseded ? "text-slate-400 line-through" : "text-slate-800"}`}>
                            {formatCurrency(b.amount)}
                          </span>
                          <span className="block text-xs text-slate-400">{b.status === "paid" ? "Settled" : "On Account"}</span>
                        </span>
                      </summary>

                      <div className="border-t border-slate-100 bg-slate-50/60 px-3 py-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            onClick={() => toggleStatus(b)}
                            disabled={pending}
                            /* THIS TICK AND THE SUPPLIER BALANCE ARE THE SAME DOLLAR (review, 2026-09-19).
                               Owed = bills not marked paid, minus payments recorded against the account,
                               so ticking a bill a cheque already covered takes the same dollar off twice.
                               The control stays (a counter receipt settled at the till is what it is for)
                               and its face says how the bill was bought, never "paid". */
                            aria-label="How this bill was bought: tap to switch between Settled and On Account"
                            className="flex min-h-11 items-center gap-2 rounded-lg px-2 text-xs font-medium text-slate-600 ring-1 ring-slate-200 hover:bg-white"
                          >
                            <Badge tone={statusTone(b.status)}>{b.status === "paid" ? "Settled" : "On Account"}</Badge>
                            <span>Switch</span>
                          </button>
                          <Button variant="outline" onClick={() => setEditBill(b)} disabled={pending}>
                            <Pencil /> Edit
                          </Button>
                          <Button variant="outline" className="text-red-700" onClick={() => removeBill(b)} disabled={pending}>
                            <Trash2 /> Delete
                          </Button>
                          {b.job_id && (
                            <Link href={`/jobs/${b.job_id}`} className="flex min-h-11 items-center px-2 text-sm font-medium text-brand hover:underline">
                              Open The Job
                            </Link>
                          )}
                        </div>
                        {b.receipt ? (
                          <div className="mt-2">
                            <ReceiptLines receipt={b.receipt} />
                          </div>
                        ) : lineCount > 0 ? (
                          <ul className="mt-2 ml-1 space-y-0.5 border-l-2 border-slate-100 pl-3">
                            {b.line_items!.map((li, i) => (
                              <li key={i} className="flex items-center justify-between gap-2 text-xs text-slate-500">
                                <span className="min-w-0 truncate">
                                  {li.quantity && li.quantity !== 1 ? `${li.quantity}× ` : ""}{li.description}
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
              })}
            </ul>
          )}

          {editBill && (
            <BillEditModal key={editBill.id} bill={editBill} jobs={jobs} onClose={() => setEditBill(null)} />
          )}
        </div>

        <div hidden={tab !== "po"} className="pb-3">
          <div className="mb-3 flex items-center justify-between">
            <span className="text-xs text-slate-500">{pos.length} POs · {formatCurrency(totalPos)} total</span>
            <NewPoButton jobs={jobs} lists={lists} />
          </div>
          {pos.length === 0 ? (
            <p className="py-4 text-center text-sm text-slate-400">No purchase orders yet.</p>
          ) : (
            <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
              {pos.map((p) => (
                <li key={p.id}>
                  <Link href={`/purchasing/${p.id}`} className="flex min-h-11 items-center gap-3 px-4 py-2.5 text-sm hover:bg-slate-50">
                    <div className="min-w-0 flex-1">
                      <div className="font-medium text-slate-900">{p.po_number} · {p.vendor}</div>
                      <div className="text-xs text-slate-400">{p.jobs?.name ?? "No job"}</div>
                    </div>
                    <span className="font-medium text-slate-800">{formatCurrency(p.total)}</span>
                    <Badge tone={statusTone(p.status)}>{p.status}</Badge>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div hidden={tab !== "receipts"} className="pb-3">
          <div className="mb-3 flex flex-wrap items-end gap-2 rounded-lg border border-slate-200 p-3">
            <div className="min-w-[160px] flex-1">
              <Label htmlFor="d-job">Job *</Label>
              <Select id="d-job" value={docJob} onChange={(e) => setDocJob(e.target.value)}>
                <option value="">— Pick A Job —</option>
                {jobs.map((j) => (
                  <option key={j.id} value={j.id}>{jobLabel(j)}</option>
                ))}
              </Select>
            </div>
            <div className="w-32">
              <Label htmlFor="d-cat">Type</Label>
              <Select id="d-cat" value={docCategory} onChange={(e) => setDocCategory(e.target.value)}>
                <option value="Receipt">Receipt</option>
                <option value="Bill">Bill</option>
              </Select>
            </div>
            <input ref={fileRef} type="file" multiple accept="image/*,application/pdf" className="hidden" onChange={onFiles} />
            <DropTarget onFiles={(files) => void uploadFiles(files)} accept="image/*,application/pdf" label="Drop the Bill">
              <Button variant="outline" onClick={() => fileRef.current?.click()} disabled={busy}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />} Upload
              </Button>
            </DropTarget>
            <Button variant="outline" type="button" onClick={() => setShowCamera(true)} disabled={busy}>
              <Camera className="h-4 w-4" /> Photo
            </Button>
          </div>

          {showCamera && (
            <CameraCapture
              onCapture={(file) => { setShowCamera(false); uploadFiles([file]); }}
              onClose={() => setShowCamera(false)}
            />
          )}
          {docError && <p className="mb-2 text-sm text-red-600">{docError}</p>}

          {docs.length === 0 ? (
            <p className="py-4 text-center text-sm text-slate-400">No receipts or bills uploaded yet.</p>
          ) : (
            <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
              {docs.map((d) => (
                <li key={d.id} className="flex items-center gap-3 px-4 py-1">
                  <FileText className="h-4 w-4 shrink-0 text-slate-400" />
                  <div className="min-w-0 flex-1">
                    {d.signedUrl ? (
                      <a href={d.signedUrl} target="_blank" rel="noopener noreferrer" className="block truncate text-sm font-medium text-slate-900 hover:text-brand">{d.name}</a>
                    ) : (
                      <span className="block truncate text-sm font-medium text-slate-900">{d.name}</span>
                    )}
                    <div className="text-xs text-slate-400">{formatDate(d.created_at)} · {d.jobs?.name ?? "No job"}</div>
                  </div>
                  {d.category && <Badge tone="blue">{d.category}</Badge>}
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Delete ${d.name}`}
                    title="Delete"
                    className="text-slate-400 hover:text-red-600"
                    onClick={() => { if (confirm(`Delete "${d.name}"?`)) start(async () => { const res = await deleteDocument(d.id, d.file_url, d.job_id ?? ""); if (!res?.ok) { toast(res?.error ?? "Couldn't delete — try again.", "error"); return; } toast("Deleted", "success"); router.refresh(); }); }}
                  >
                    <Trash2 />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
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
  // A business cost opens on its own bucket (an old word like "Fuel" read as Gas & Truck). A job
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
