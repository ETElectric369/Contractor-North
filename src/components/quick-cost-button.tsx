"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Wallet, Camera, Check } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Input, Label, Select } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Modal, ModalActions } from "@/components/ui/modal";
import { todayStrInTz } from "@/lib/tz";
import { getOrgSettings } from "@/lib/org-settings";
import { createBill, addDocument } from "@/app/(app)/jobs/actions";

const CATEGORIES = ["Materials", "Fuel", "Shop supplies", "Tools", "Subcontractor", "Permit", "Equipment rental", "Office", "Other"];
const MAX_PHOTO = 15 * 1024 * 1024;

const DEFAULT_TRIGGER =
  "inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50";

/**
 * THE one "add a cost" everywhere — supplier + amount + category + an optional
 * receipt photo (the camera on mobile), scoped to a job or to overhead. Wraps
 * createBill (a cost = a bill) plus addDocument for the photo, so every surface
 * logs a cost the same way.
 *
 * Drop it anywhere: pass `jobId` to pre-scope it, or `jobs` for a picker. If
 * neither `orgId` nor `jobs` is supplied (e.g. the global + menu), it self-loads
 * the org id and the job list on open. `onOpen` lets a host (a dropdown) close
 * itself when the modal opens.
 *
 * The cost is saved first; the photo is attached after. A photo that fails to
 * upload is never silently dropped — the modal stays open with a notice and a
 * one-tap retry (the cost is already safe).
 */
export function QuickCostButton({
  orgId,
  jobId,
  jobs,
  label = "Add cost",
  className,
  onOpen,
  onClose,
}: {
  orgId?: string;
  jobId?: string;
  jobs?: { id: string; label: string }[];
  label?: string;
  className?: string;
  /** Fired when the modal OPENS. Do NOT unmount this component here (it would kill
   *  the modal) — use it for side effects only. */
  onOpen?: () => void;
  /** Fired when the modal CLOSES — e.g. a host dropdown closes itself then. */
  onClose?: () => void;
}) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [supplier, setSupplier] = useState("");
  const [amount, setAmount] = useState(0);
  // Default the date to today so a cost lands on the right day in one tap — blank
  // was dropping a known value. Seeded to the browser's local day immediately,
  // then refined to the org's timezone once settings load on open.
  const [billDate, setBillDate] = useState(() => todayStrInTz(getOrgSettings(null).timezone));
  const [category, setCategory] = useState("Materials");
  const [paid, setPaid] = useState(false);
  const [job, setJob] = useState(jobId ?? "");
  const [receipt, setReceipt] = useState<File | null>(null);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [warn, setWarn] = useState<string | null>(null);
  // The cost row is saved; only the photo may still be pending (retry mode).
  const [costSaved, setCostSaved] = useState(false);
  // Self-loaded context when not passed in (global + menu use).
  const [autoOrg, setAutoOrg] = useState("");
  const [autoJobs, setAutoJobs] = useState<{ id: string; label: string }[] | null>(null);
  // The org's timezone, loaded once on first open, so the seeded cost date is the
  // org's "today" (not the device's). Falls back to the default tz until loaded.
  const orgTz = useRef<string | null>(null);

  const effectiveOrg = orgId || autoOrg;
  const pickerJobs = jobs ?? autoJobs ?? undefined;
  const targetJob = jobId ?? job;

  function reset() {
    setSupplier("");
    setAmount(0);
    setBillDate(todayStrInTz(orgTz.current ?? getOrgSettings(null).timezone));
    setCategory("Materials");
    setPaid(false);
    setJob(jobId ?? "");
    setReceipt(null);
    setError(null);
    setWarn(null);
    setCostSaved(false);
    if (fileRef.current) fileRef.current.value = "";
  }

  async function openModal() {
    reset();
    onOpen?.();
    setOpen(true);
    // Load the org's timezone once so the seeded date is the org's "today" — even
    // when orgId was passed in (job-scoped use), where the id self-load is skipped.
    if (orgTz.current == null) {
      const supabase = createClient();
      const { data } = await supabase.from("organizations").select("id, settings").limit(1).maybeSingle();
      if (!orgId && (data as any)?.id) setAutoOrg((data as any).id);
      orgTz.current = getOrgSettings((data as any)?.settings).timezone;
      setBillDate(todayStrInTz(orgTz.current));
    }
    if (!jobId && !jobs && !autoJobs) {
      const supabase = createClient();
      const { data } = await supabase
        .from("jobs")
        .select("id, job_number, name")
        .order("created_at", { ascending: false })
        .limit(200);
      if (data) setAutoJobs((data as any[]).map((j) => ({ id: j.id, label: `${j.job_number} · ${j.name}` })));
    }
  }

  function closeModal() {
    setOpen(false);
    onClose?.();
  }

  function finishOk() {
    setOpen(false);
    reset();
    onClose?.();
    router.refresh();
  }

  /** Upload the snapped receipt + file it on the job. Returns false on any failure
   *  so the caller can tell the user instead of swallowing it. */
  async function attachReceipt(forJob: string): Promise<boolean> {
    if (!receipt) return true;
    if (!effectiveOrg) return false;
    try {
      const supabase = createClient();
      const safe = (receipt.name || "receipt.jpg").replace(/[^a-zA-Z0-9._-]/g, "_");
      const path = `${effectiveOrg}/${forJob}/${Date.now()}-${safe}`;
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
        status: paid ? "paid" : "unpaid",
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
      <button type="button" className={className ?? DEFAULT_TRIGGER} onClick={openModal}>
        <Wallet className="h-4 w-4" /> {label}
      </button>
      <Modal
        open={open}
        onClose={closeModal}
        title="Add a cost"
        footer={<ModalActions onCancel={closeModal} onSave={onSave} saving={pending} saveLabel={costSaved ? "Retry photo" : "Save cost"} />}
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
          {!jobId && pickerJobs && pickerJobs.length > 0 && (
            <div>
              <Label htmlFor="qc-job">Job</Label>
              <Select id="qc-job" value={job} onChange={(e) => setJob(e.target.value)} disabled={costSaved}>
                <option value="">Overhead (no job)</option>
                {pickerJobs.map((j) => (
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
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input type="checkbox" checked={paid} onChange={(e) => setPaid(e.target.checked)} className="h-4 w-4 rounded border-slate-300" disabled={costSaved} />
            Already paid (cash / card) — skip the bill
          </label>
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
