"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Plus, Trash2, Upload, Camera, Loader2, FileText } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Badge, statusTone } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { CameraCapture } from "@/components/camera-capture";
import { formatCurrency, formatDate } from "@/lib/utils";
import { createBill, setBillStatus, deleteBill, addDocument, deleteDocument } from "../jobs/actions";
import { NewPoButton } from "../purchasing/new-po-button";

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
  const [tab, setTab] = useState<"po" | "bills" | "receipts">("po");
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

  const tabBtn = (id: typeof tab, label: string) => (
    <button
      onClick={() => setTab(id)}
      className={`flex-1 rounded-md px-3 py-1.5 font-medium ${tab === id ? "bg-white text-slate-900 shadow-sm" : "text-slate-500"}`}
    >
      {label}
    </button>
  );

  return (
    <div>
      <div className="mb-4 flex gap-1 rounded-lg bg-slate-100 p-1 text-sm">
        {tabBtn("po", `Purchase Orders (${pos.length})`)}
        {tabBtn("bills", `Bills (${bills.length})`)}
        {tabBtn("receipts", `Receipts (${docs.length})`)}
      </div>

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
                <Plus className="h-3.5 w-3.5" /> Add bill
              </Button>
            </div>
          </div>

          <div className="mb-3 flex gap-2">
            {([
              ["all", `All (${bills.length})`],
              ["jobs", `Job bills (${bills.filter((b) => b.job_id).length})`],
              ["overhead", `Overhead (${bills.filter((b) => !b.job_id).length})`],
            ] as const).map(([id, label]) => (
              <button
                key={id}
                onClick={() => setBillFilter(id)}
                className={`rounded-full px-3 py-1 text-xs font-medium ${
                  billFilter === id ? "bg-brand text-white" : "bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {shownBills.length === 0 ? (
            <p className="py-4 text-center text-sm text-slate-400">No bills here yet.</p>
          ) : (
            <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
              {shownBills.map((b) => (
                <li key={b.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                  <div className="min-w-0 flex-1">
                    <div className="font-medium text-slate-900">{b.supplier}</div>
                    <div className="text-xs text-slate-400">
                      {b.bill_number ? `#${b.bill_number} · ` : ""}
                      {b.bill_date ? `${formatDate(b.bill_date)} · ` : ""}
                      {b.jobs?.name ?? `Overhead${b.category ? ` · ${b.category}` : ""}`}
                    </div>
                  </div>
                  <span className="font-medium text-slate-800">{formatCurrency(b.amount)}</span>
                  <button
                    onClick={() => start(async () => { await setBillStatus(b.id, b.status === "paid" ? "unpaid" : "paid", b.job_id ?? ""); router.refresh(); })}
                    title="Toggle paid/unpaid"
                  >
                    <Badge tone={b.status === "paid" ? "green" : "amber"}>{b.status}</Badge>
                  </button>
                  <button
                    onClick={() => start(async () => { await deleteBill(b.id, b.job_id ?? ""); router.refresh(); })}
                    className="text-slate-400 hover:text-red-600"
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
                    onClick={() => { if (confirm(`Delete "${d.name}"?`)) start(async () => { await deleteDocument(d.id, d.file_url, d.job_id ?? ""); router.refresh(); }); }}
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
