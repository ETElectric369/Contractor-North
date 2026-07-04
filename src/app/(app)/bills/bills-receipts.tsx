"use client";

import { useRef, useState, useTransition } from "react";
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
import { formatCurrency, formatDate } from "@/lib/utils";
import { createBill, setBillStatus, deleteBill, addDocument, deleteDocument } from "../jobs/actions";
import { executeAction } from "@/lib/actions/execute";
import { NewPoButton } from "../purchasing/new-po-button";

const OVERHEAD_CATEGORIES = ["Fuel", "Shop supplies", "Tools", "Office", "Insurance", "Vehicle", "Other"];

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
interface BillRow {
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
}
interface DocRow {
  id: string;
  name: string;
  category: string | null;
  file_url: string;
  size_bytes: number | null;
  created_at: string;
  job_id: string | null;
  signedUrl: string | null;
  jobs?: { name: string } | null;
}

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
  // Open straight to a tab from a deep link (the quick-add "New cost" → ?tab=bills).
  const spTab = useSearchParams().get("tab");
  const [tab, setTab] = useState<"po" | "bills" | "receipts">(
    spTab === "bills" || spTab === "receipts" ? spTab : "po",
  );
  const [pending, start] = useTransition();

  // ── Bills add form ──
  const [supplier, setSupplier] = useState("");
  const [billNumber, setBillNumber] = useState("");
  const [amount, setAmount] = useState(0);
  const [status, setStatus] = useState("unpaid");
  const [billDate, setBillDate] = useState("");
  const [billJob, setBillJob] = useState("");
  const [billCategory, setBillCategory] = useState("Shop supplies");
  const [billFilter, setBillFilter] = useState<"all" | "jobs" | "overhead">("all");
  const [billError, setBillError] = useState<string | null>(null);
  const [editBill, setEditBill] = useState<BillRow | null>(null);

  const shownBills =
    billFilter === "all" ? bills : bills.filter((b) => (billFilter === "jobs" ? b.job_id : !b.job_id));
  const totalBills = shownBills.reduce((s, b) => s + Number(b.amount), 0);
  const totalPos = pos.reduce((s, p) => s + Number(p.total), 0);

  function addBill() {
    setBillError(null);
    if (!supplier.trim()) return setBillError("Supplier is required.");
    start(async () => {
      const res = await createBill({
        job_id: billJob === "__overhead" ? null : billJob || null,
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
    <div>
      <Tabs
        activeId={tab}
        onChange={(id) => setTab(id as "po" | "bills" | "receipts")}
        tabs={[
          { id: "po", label: "Purchase Orders", count: pos.length },
          { id: "bills", label: "Bills", count: bills.length },
          { id: "receipts", label: "Receipts", count: docs.length },
        ]}
      />

      {tab === "po" && (
        <Card className="p-4">
          <div className="mb-3 flex items-center justify-between">
            <span className="text-xs text-slate-500">{pos.length} POs · {formatCurrency(totalPos)} total</span>
            <NewPoButton jobs={jobs} lists={lists} />
          </div>
          {pos.length === 0 ? (
            <p className="py-4 text-center text-sm text-slate-400">No purchase orders yet. Click “New PO” to create one.</p>
          ) : (
            <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
              {pos.map((p) => (
                <li key={p.id}>
                  <Link href={`/purchasing/${p.id}`} className="flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-slate-50">
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
        </Card>
      )}

      {tab === "bills" && (
        <Card className="p-4">
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
                  <option value="">— Pick a job —</option>
                  <option value="__overhead">Overhead (no job)</option>
                  {jobs.map((j) => (
                    <option key={j.id} value={j.id}>{j.job_number} · {j.name}</option>
                  ))}
                </Select>
              </div>
              {billJob === "__overhead" && (
                <div>
                  <Label htmlFor="b-cat">Overhead category</Label>
                  <Select id="b-cat" value={billCategory} onChange={(e) => setBillCategory(e.target.value)}>
                    {["Fuel", "Shop supplies", "Tools", "Office", "Insurance", "Vehicle", "Other"].map((c) => (
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
                <Label htmlFor="b-date">Bill date</Label>
                <Input id="b-date" type="date" value={billDate} onChange={(e) => setBillDate(e.target.value)} />
              </div>
              <div>
                <Label htmlFor="b-status">Status</Label>
                <Select id="b-status" value={status} onChange={(e) => setStatus(e.target.value)}>
                  <option value="unpaid">Unpaid</option>
                  <option value="paid">Paid</option>
                </Select>
              </div>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-slate-500">{shownBills.length} bills · {formatCurrency(totalBills)} total</span>
              <Button size="sm" onClick={addBill} disabled={pending || !supplier.trim()}>
                <Plus className="h-3.5 w-3.5" /> Add Bill
              </Button>
            </div>
          </div>

          <div className="mb-3 flex gap-2">
            {([
              ["all", `All (${bills.length})`],
              ["jobs", `Job Bills (${bills.filter((b) => b.job_id).length})`],
              ["overhead", `Overhead (${bills.filter((b) => !b.job_id).length})`],
            ] as const).map(([id, label]) => (
              <button
                key={id}
                onClick={() => setBillFilter(id)}
                className={`rounded-full px-3 py-1 text-xs font-medium ${
                  billFilter === id ? "seaglass-active" : "bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50"
                }`}
              >
                <span className="relative z-10">{label}</span>
              </button>
            ))}
          </div>

          {shownBills.length === 0 ? (
            <p className="py-4 text-center text-sm text-slate-400">No bills here yet.</p>
          ) : (
            <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
              {shownBills.map((b) => (
                <li key={b.id} className="px-4 py-2.5 text-sm">
                  <div className="flex items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="font-medium text-slate-900">{b.supplier}</div>
                      <div className="text-xs text-slate-400">
                        {b.bill_number ? `#${b.bill_number} · ` : ""}
                        {b.bill_date ? `${formatDate(b.bill_date)} · ` : ""}
                        {b.jobs?.name ? <Link href={`/jobs/${b.job_id}`} className="hover:text-brand">{b.jobs.name}</Link> : `Overhead${b.category ? ` · ${b.category}` : ""}`}
                        {(b.line_items?.length ?? 0) > 0 ? ` · ${b.line_items!.length} items` : ""}
                      </div>
                    </div>
                    <span className="font-medium text-slate-800">{formatCurrency(b.amount)}</span>
                    <button
                      onClick={() => {
                        const next = b.status === "paid" ? "unpaid" : "paid";
                        start(async () => {
                          const res = await setBillStatus(b.id, next, b.job_id ?? "");
                          if (!res?.ok) { toast(res?.error ?? "Couldn't update the bill — try again.", "error"); return; }
                          toast(next === "paid" ? "Bill marked paid" : "Bill marked unpaid", "success");
                          router.refresh();
                        });
                      }}
                      title="Toggle paid/unpaid"
                    >
                      <Badge tone={b.status === "paid" ? "green" : "amber"}>{b.status}</Badge>
                    </button>
                    <button onClick={() => setEditBill(b)} className="text-slate-400 hover:text-brand" title="Edit">
                      <Pencil className="h-4 w-4" />
                    </button>
                    <button
                      onClick={() => { if (confirm(`Delete bill from "${b.supplier}"?`)) start(async () => { const res = await deleteBill(b.id, b.job_id ?? ""); if (!res?.ok) { toast(res?.error ?? "Couldn't delete the bill — try again.", "error"); return; } toast("Bill deleted", "success"); router.refresh(); }); }}
                      className="text-slate-400 hover:text-red-600"
                      title="Delete"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                  {(b.line_items?.length ?? 0) > 0 && (
                    <ul className="mt-1.5 ml-1 space-y-0.5 border-l-2 border-slate-100 pl-3">
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
                  )}
                </li>
              ))}
            </ul>
          )}

          {editBill && (
            <BillEditModal key={editBill.id} bill={editBill} jobs={jobs} onClose={() => setEditBill(null)} />
          )}
        </Card>
      )}

      {tab === "receipts" && (
        <Card className="p-4">
          <div className="mb-3 flex flex-wrap items-end gap-2 rounded-lg border border-slate-200 p-3">
            <div className="min-w-[160px] flex-1">
              <Label htmlFor="d-job">Job *</Label>
              <Select id="d-job" value={docJob} onChange={(e) => setDocJob(e.target.value)}>
                <option value="">— Pick a job —</option>
                {jobs.map((j) => (
                  <option key={j.id} value={j.id}>{j.job_number} · {j.name}</option>
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
            <Button variant="outline" onClick={() => fileRef.current?.click()} disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />} Upload
            </Button>
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
                <li key={d.id} className="flex items-center gap-3 px-4 py-2.5">
                  <FileText className="h-4 w-4 shrink-0 text-slate-400" />
                  <div className="min-w-0 flex-1">
                    {d.signedUrl ? (
                      <a href={d.signedUrl} target="_blank" rel="noopener noreferrer" className="truncate text-sm font-medium text-slate-900 hover:text-brand">{d.name}</a>
                    ) : (
                      <span className="truncate text-sm font-medium text-slate-900">{d.name}</span>
                    )}
                    <div className="text-xs text-slate-400">{formatDate(d.created_at)} · {d.jobs?.name ?? "No job"}</div>
                  </div>
                  {d.category && <Badge tone="blue">{d.category}</Badge>}
                  <button
                    onClick={() => { if (confirm(`Delete "${d.name}"?`)) start(async () => { const res = await deleteDocument(d.id, d.file_url, d.job_id ?? ""); if (!res?.ok) { toast(res?.error ?? "Couldn't delete — try again.", "error"); return; } toast("Deleted", "success"); router.refresh(); }); }}
                    className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600"
                    title="Delete"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </div>
  );
}

/** Edit a supplier bill from the central list. Routes through the unified Action
 *  Registry (executeAction → "bill.update") — the same capability the AI agent calls.
 *  Beyond the job-tab editor this also exposes job link + overhead category so an
 *  overhead bill can be corrected to a job (or vice-versa) right from here. */
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
  const [billCategory, setBillCategory] = useState(bill.category ?? "Shop supplies");
  const [error, setError] = useState<string | null>(null);

  const isOverhead = billJob === "__overhead";

  function save() {
    if (!supplier.trim()) return setError("Supplier is required.");
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
      onClose();
      router.refresh();
    });
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Edit bill"
      footer={<ModalActions onCancel={onClose} onSave={save} saving={pending} disabled={!supplier.trim()} saveLabel="Save changes" />}
    >
      <div className="space-y-3">
        {error && <p className="text-sm text-red-600">{error}</p>}
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2">
            <Label htmlFor="be-supplier">Supplier *</Label>
            <Input id="be-supplier" value={supplier} onChange={(e) => setSupplier(e.target.value)} autoFocus />
          </div>
          <div className="col-span-2">
            <Label htmlFor="be-job">Job</Label>
            <Select id="be-job" value={billJob} onChange={(e) => setBillJob(e.target.value)}>
              <option value="__overhead">Overhead (no job)</option>
              {jobs.map((j) => (
                <option key={j.id} value={j.id}>{j.job_number} · {j.name}</option>
              ))}
            </Select>
          </div>
          {isOverhead && (
            <div className="col-span-2">
              <Label htmlFor="be-cat">Overhead category</Label>
              <Select id="be-cat" value={billCategory} onChange={(e) => setBillCategory(e.target.value)}>
                {OVERHEAD_CATEGORIES.map((c) => (
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
            <Label htmlFor="be-date">Bill date</Label>
            <Input id="be-date" type="date" value={billDate} onChange={(e) => setBillDate(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="be-status">Status</Label>
            <Select id="be-status" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="unpaid">Unpaid</option>
              <option value="paid">Paid</option>
            </Select>
          </div>
        </div>
      </div>
    </Modal>
  );
}
