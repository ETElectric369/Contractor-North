"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Wallet, Camera, Check } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Input, Label, Select } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Modal, ModalActions } from "@/components/ui/modal";
import { createBill, addDocument } from "@/app/(app)/jobs/actions";

const CATEGORIES = ["Materials", "Fuel", "Shop supplies", "Tools", "Subcontractor", "Permit", "Equipment rental", "Office", "Other"];
const MAX_PHOTO = 15 * 1024 * 1024;

const DEFAULT_TRIGGER =
  "inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50";

/**
 * THE one "add a cost" everywhere — supplier + amount + category + an optional
 * receipt photo (the camera on mobile), scoped to a job or to overhead. Wraps
 * createBill (a cost = a bill) plus addDocument for the photo, so every surface
 * logs a cost the same way. Drop it anywhere; pass `jobId` to pre-scope it, or
 * `jobs` to show a picker, and `className` to match the surrounding buttons.
 *
 * The cost is saved first; the photo is attached after. If the photo fails to
 * upload we never silently drop it — the modal stays open with a notice and a
 * one-tap retry (the cost is already safe).
 */
export function QuickCostButton({
  orgId,
  jobId,
  jobs,
  label = "Add cost",
  className,
}: {
  orgId: string;
  jobId?: string;
  jobs?: { id: string; label: string }[];
  label?: string;
  className?: string;
}) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [supplier, setSupplier] = useState("");
  const [amount, setAmount] = useState(0);
  const [billDate, setBillDate] = useState("");
  const [category, setCategory] = useState("Materials");
  const [job, setJob] = useState(jobId ?? "");
  const [receipt, setReceipt] = useState<File | null>(null);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [warn, setWarn] = useState<string | null>(null);
  // The cost row is saved; only the photo may still be pending (retry mode).
  const [costSaved, setCostSaved] = useState(false);

  const targetJob = jobId ?? job;

  function reset() {
    setSupplier("");
    setAmount(0);
    setBillDate("");
    setCategory("Materials");
    setJob(jobId ?? "");
    setReceipt(null);
    setError(null);
    setWarn(null);
    setCostSaved(false);
    if (fileRef.current) fileRef.current.value = "";
  }

  function finishOk() {
    setOpen(false);
    reset();
    router.refresh();
  }

  /** Upload the snapped receipt + file it on the job. Returns false on any failure
   *  so the caller can tell the user instead of swallowing it. */
  async function attachReceipt(forJob: string): Promise<boolean> {
    if (!receipt) return true;
    if (!orgId) return false;
    try {
      const supabase = createClient();
      const safe = (receipt.name || "receipt.jpg").replace(/[^a-zA-Z0-9._-]/g, "_");
      const path = `${orgId}/${forJob}/${Date.now()}-${safe}`;
      const { error: upErr } = await supabase.storage.from("documents").upload(path, receipt, { upsert: false });
      if (upErr) return false;
      const res = await addDocument({ job_id: forJob, name: receipt.name || "Receipt", category: "Receipt", file_url: path, size_bytes: receipt.size });
      return res.ok;
    } catch {
      return false;
    }
  }

  function onSave() {
    setError(null);
    setWarn(null);
    // Retry mode: the cost already saved last time; only the photo needs a retry.
    if (costSaved) {
      if (!receipt || !targetJob) return finishOk();
      start(async () => {
        if (await attachReceipt(targetJob)) finishOk();
        else setWarn("Still couldn't upload the photo — you can add it later from the job's Receipts.");
      });
      return;
    }
    if (!supplier.trim()) return setError("Who was it paid to? (supplier)");
    start(async () => {
      const res = await createBill({
        job_id: targetJob || null,
        supplier: supplier.trim(),
        bill_number: "",
        amount,
        status: "unpaid",
        bill_date: billDate || null,
        notes: "",
        category,
      });
      if (!res.ok) return setError(res.error ?? "Couldn't save the cost.");
      setCostSaved(true);
      // Attach the photo (best-effort) — but if it fails, TELL the user; the cost is
      // already safe, so the Save button becomes a one-tap photo retry.
      if (receipt && targetJob) {
        if (!(await attachReceipt(targetJob))) {
          setWarn("Cost saved ✓ — but the receipt photo didn't upload. Tap “Retry photo”, or close and add it from the job's Receipts.");
          return;
        }
      }
      finishOk();
    });
  }

  return (
    <>
      <button type="button" className={className ?? DEFAULT_TRIGGER} onClick={() => { reset(); setOpen(true); }}>
        <Wallet className="h-4 w-4" /> {label}
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Add a cost"
        footer={<ModalActions onCancel={() => setOpen(false)} onSave={onSave} saving={pending} saveLabel={costSaved ? "Retry photo" : "Save cost"} />}
      >
        <div className="space-y-4">
          <div>
            <Label htmlFor="qc-supplier">Paid to / supplier *</Label>
            <Input id="qc-supplier" value={supplier} onChange={(e) => setSupplier(e.target.value)} placeholder="e.g. CED, Home Depot" autoFocus disabled={costSaved} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="qc-amt">Amount</Label>
              <NumberInput id="qc-amt" value={amount} onValueChange={setAmount} />
            </div>
            <div>
              <Label htmlFor="qc-date">Date</Label>
              <Input id="qc-date" type="date" value={billDate} onChange={(e) => setBillDate(e.target.value)} />
            </div>
          </div>
          {!jobId && jobs && jobs.length > 0 && (
            <div>
              <Label htmlFor="qc-job">Job</Label>
              <Select id="qc-job" value={job} onChange={(e) => setJob(e.target.value)} disabled={costSaved}>
                <option value="">Overhead (no job)</option>
                {jobs.map((j) => (
                  <option key={j.id} value={j.id}>{j.label}</option>
                ))}
              </Select>
            </div>
          )}
          <div>
            <Label htmlFor="qc-cat">Category</Label>
            <Select id="qc-cat" value={category} onChange={(e) => setCategory(e.target.value)}>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </Select>
          </div>
          <div>
            <Label>Receipt photo</Label>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              capture="environment"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0] ?? null;
                // Block oversized photos at selection so they can't be silently
                // dropped on save — phone cameras routinely exceed 15 MB.
                if (f && f.size > MAX_PHOTO) {
                  setError("That photo is over 15 MB — take or pick a smaller one.");
                  setReceipt(null);
                  if (fileRef.current) fileRef.current.value = "";
                  return;
                }
                setError(null);
                setReceipt(f);
              }}
            />
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-slate-300 px-3 py-3 text-sm text-slate-600 hover:bg-slate-50"
            >
              {receipt ? (
                <><Check className="h-4 w-4 text-green-600" /> <span className="truncate">{receipt.name || "Photo attached"}</span></>
              ) : (
                <><Camera className="h-4 w-4" /> Snap / attach receipt</>
              )}
            </button>
            {receipt && !targetJob && <p className="mt-1 text-xs text-amber-600">Pick a job to file the receipt photo with it.</p>}
          </div>
          {warn && <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-700">{warn}</p>}
          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>
      </Modal>
    </>
  );
}
