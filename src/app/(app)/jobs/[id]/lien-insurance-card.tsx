"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ShieldAlert, FileWarning, ScrollText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal, ModalActions } from "@/components/ui/modal";
import { Input, Label } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Card, CardContent } from "@/components/ui/card";
import { formatDate } from "@/lib/utils";
import { lienStatus } from "@/lib/lien-math";
import { upsertLienRecord, upsertInsuranceClaim, type LienInput, type InsuranceInput } from "../lien-actions";

type LienRow = Record<string, any> | null;
type InsRow = Record<string, any> | null;
type Defaults = { ownerName?: string; ownerAddress?: string; estimatedAmount?: number };

/** Contractor-protection on a job (Phase 4 spine): lien-rights deadline tracking + the
 *  CA Preliminary Notice, plus insurance-claim capture. The recordable lien itself is
 *  done offline (notarize + record at the county) — CN tracks the clock. */
export function LienInsuranceCard({
  jobId,
  lien,
  insurance,
  defaults,
}: {
  jobId: string;
  lien: LienRow;
  insurance: InsRow;
  defaults: Defaults;
}) {
  const router = useRouter();
  const [editLien, setEditLien] = useState(false);
  const [editIns, setEditIns] = useState(false);

  const s = lienStatus({
    firstFurnishedDate: lien?.first_furnished_date,
    completionDate: lien?.completion_date,
    prelimSentAt: lien?.prelim_sent_at,
    lienRecordedAt: lien?.lien_recorded_at,
    nocRecorded: lien?.noc_recorded,
    isSubcontractor: !!lien?.gc_name,
  });

  // formatDate now renders date-only values as a stable wall date (no zone shift),
  // so the old local-noon hack is gone — this just guards null.
  const fd = (v?: string | null) => (v ? formatDate(v) : "");

  // §8200(e): a direct contractor owes a Preliminary Notice only to a construction lender,
  // if any. A sub (has a GC above it) always owes one; a direct contractor with no lender
  // owes none — so don't surface a mandatory deadline that doesn't apply.
  const prelimRequired = !!lien?.gc_name || !!lien?.lender_name;

  function deadlineLine(label: string, deadline: string | null, daysLeft: number | null, done: boolean, urgent: boolean, doneLabel: string) {
    if (done) return <span className="text-emerald-600">{doneLabel}</span>;
    if (deadline == null) return <span className="text-slate-400">{label}: add a date</span>;
    const tone = daysLeft != null && daysLeft < 0 ? "text-red-600 font-medium" : urgent ? "text-amber-600 font-medium" : "text-slate-600";
    const note = daysLeft != null && daysLeft < 0 ? `${Math.abs(daysLeft)}d past due` : `${daysLeft}d left`;
    return <span className={tone}>{label} by {fd(deadline)} · {note}</span>;
  }

  return (
    <Card>
      <CardContent className="py-4">
        <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-slate-800">
          <ShieldAlert className="h-4 w-4" /> Lien protection &amp; insurance
        </div>

        {/* Lien tracking */}
        <div className="rounded-lg border border-slate-100 p-3">
          <div className="flex items-center justify-between">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">Mechanics lien rights</div>
            <button onClick={() => setEditLien(true)} className="text-xs font-medium text-brand hover:underline">
              {lien ? "Edit" : "Track lien rights"}
            </button>
          </div>
          {lien ? (
            <div className="mt-1.5 space-y-0.5 text-sm">
              <div>
                {prelimRequired
                  ? deadlineLine("Preliminary notice", s.prelimDeadline, s.prelimDaysLeft, s.prelimDone, s.prelimUrgent, `Prelim notice served ${fd(lien.prelim_sent_at)}`)
                  : <span className="text-slate-400">No preliminary notice required (direct contractor, no construction lender).</span>}
              </div>
              <div>{deadlineLine("Record lien", s.lienDeadline, s.lienDaysLeft, s.lienDone, s.lienUrgent, `Lien recorded ${fd(lien.lien_recorded_at)}`)}</div>
              {!s.lienDone && (
                <div className="text-xs text-slate-400">
                  {lien.noc_recorded
                    ? "Notice of Completion recorded — shortened window applied."
                    : "Shortens to 60 days (30 if you're a sub) if the owner records a Notice of Completion. Verify."}
                </div>
              )}
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <a href={`/print/prelim-notice/${jobId}`} target="_blank" rel="noopener" className="inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline">
                  <ScrollText className="h-3.5 w-3.5" /> Preliminary Notice
                </a>
              </div>
            </div>
          ) : (
            <p className="mt-1 text-xs text-slate-500">Track the 20-day Preliminary Notice and 90-day lien deadlines so you never lose lien rights.</p>
          )}
        </div>

        {/* Insurance claim */}
        <div className="mt-3 rounded-lg border border-slate-100 p-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">
              <FileWarning className="h-3.5 w-3.5" /> Insurance claim
            </div>
            <button onClick={() => setEditIns(true)} className="text-xs font-medium text-brand hover:underline">
              {insurance ? "Edit" : "Add claim"}
            </button>
          </div>
          {insurance ? (
            <div className="mt-1.5 text-sm text-slate-700">
              {[insurance.carrier, insurance.claim_number ? `Claim ${insurance.claim_number}` : null, insurance.adjuster_name].filter(Boolean).join(" · ")}
              {insurance.date_of_loss ? <span className="text-slate-400"> · Loss {fd(insurance.date_of_loss)}</span> : null}
            </div>
          ) : (
            <p className="mt-1 text-xs text-slate-500">For insurance-funded work — track the carrier, claim #, and adjuster.</p>
          )}
        </div>
      </CardContent>

      {editLien && <LienEditor jobId={jobId} lien={lien} defaults={defaults} onClose={() => setEditLien(false)} onSaved={() => { setEditLien(false); router.refresh(); }} />}
      {editIns && <InsuranceEditor jobId={jobId} insurance={insurance} onClose={() => setEditIns(false)} onSaved={() => { setEditIns(false); router.refresh(); }} />}
    </Card>
  );
}

function LienEditor({ jobId, lien, defaults, onClose, onSaved }: { jobId: string; lien: LienRow; defaults: Defaults; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState<LienInput>({
    first_furnished_date: lien?.first_furnished_date ?? "",
    completion_date: lien?.completion_date ?? "",
    owner_name: lien?.owner_name ?? defaults.ownerName ?? "",
    owner_address: lien?.owner_address ?? defaults.ownerAddress ?? "",
    hired_by_name: lien?.hired_by_name ?? defaults.ownerName ?? "",
    gc_name: lien?.gc_name ?? "",
    gc_address: lien?.gc_address ?? "",
    lender_name: lien?.lender_name ?? "",
    lender_address: lien?.lender_address ?? "",
    estimated_amount: lien?.estimated_amount ?? defaults.estimatedAmount ?? 0,
    noc_recorded: lien?.noc_recorded ?? false,
    prelim_sent_at: lien?.prelim_sent_at ?? "",
    lien_recorded_at: lien?.lien_recorded_at ?? "",
    notes: lien?.notes ?? "",
  });
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<LienInput>) => setF({ ...f, ...patch });
  function save() {
    setError(null);
    start(async () => {
      const res = await upsertLienRecord(jobId, f);
      if (!res.ok) return setError(res.error ?? "Could not save.");
      onSaved();
    });
  }
  return (
    <Modal open onClose={() => !pending && onClose()} title="Lien rights tracking" footer={<ModalActions onCancel={onClose} onSave={save} saving={pending} saveLabel="Save" />}>
      <div className="space-y-3">
        {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">CN tracks deadlines and generates the Preliminary Notice. Recording the lien itself is done at the county. Not legal advice.</p>
        <div className="grid grid-cols-2 gap-3">
          <div><Label htmlFor="l-ff">First work date</Label><Input id="l-ff" type="date" value={f.first_furnished_date ?? ""} onChange={(e) => set({ first_furnished_date: e.target.value })} /></div>
          <div><Label htmlFor="l-comp">Completion date</Label><Input id="l-comp" type="date" value={f.completion_date ?? ""} onChange={(e) => set({ completion_date: e.target.value })} /></div>
        </div>
        <div><Label htmlFor="l-own">Property owner</Label><Input id="l-own" value={f.owner_name ?? ""} onChange={(e) => set({ owner_name: e.target.value })} placeholder="Owner / reputed owner" /></div>
        <div><Label htmlFor="l-owna">Owner address</Label><Input id="l-owna" value={f.owner_address ?? ""} onChange={(e) => set({ owner_address: e.target.value })} /></div>
        <div><Label htmlFor="l-hired">Who hired you (contracted for the work)</Label><Input id="l-hired" value={f.hired_by_name ?? ""} onChange={(e) => set({ hired_by_name: e.target.value })} placeholder="Owner, GC, or whoever signed your contract" /></div>
        <div className="grid grid-cols-2 gap-3">
          <div><Label htmlFor="l-gc">Direct/GC (if sub)</Label><Input id="l-gc" value={f.gc_name ?? ""} onChange={(e) => set({ gc_name: e.target.value })} /></div>
          <div><Label htmlFor="l-est">Estimated $</Label><NumberInput id="l-est" value={Number(f.estimated_amount) || 0} onValueChange={(n) => set({ estimated_amount: n })} /></div>
        </div>
        {f.gc_name ? (
          <div><Label htmlFor="l-gca">GC address (you must serve them)</Label><Input id="l-gca" value={f.gc_address ?? ""} onChange={(e) => set({ gc_address: e.target.value })} /></div>
        ) : null}
        <div className="grid grid-cols-2 gap-3">
          <div><Label htmlFor="l-len">Lender (if any)</Label><Input id="l-len" value={f.lender_name ?? ""} onChange={(e) => set({ lender_name: e.target.value })} /></div>
          <div><Label htmlFor="l-lena">Lender address</Label><Input id="l-lena" value={f.lender_address ?? ""} onChange={(e) => set({ lender_address: e.target.value })} /></div>
        </div>
        <label className="flex items-start gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={!!f.noc_recorded} onChange={(e) => set({ noc_recorded: e.target.checked })} className="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand" />
          <span>Owner recorded a Notice of Completion / Cessation<span className="block text-xs text-slate-500">Shortens the lien deadline to 60 days (30 if you&apos;re a subcontractor).</span></span>
        </label>
        <div className="grid grid-cols-2 gap-3">
          <div><Label htmlFor="l-ps">Prelim served on</Label><Input id="l-ps" type="date" value={f.prelim_sent_at ?? ""} onChange={(e) => set({ prelim_sent_at: e.target.value })} /></div>
          <div><Label htmlFor="l-lr">Lien recorded on</Label><Input id="l-lr" type="date" value={f.lien_recorded_at ?? ""} onChange={(e) => set({ lien_recorded_at: e.target.value })} /></div>
        </div>
      </div>
    </Modal>
  );
}

function InsuranceEditor({ jobId, insurance, onClose, onSaved }: { jobId: string; insurance: InsRow; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState<InsuranceInput>({
    carrier: insurance?.carrier ?? "",
    claim_number: insurance?.claim_number ?? "",
    policy_number: insurance?.policy_number ?? "",
    adjuster_name: insurance?.adjuster_name ?? "",
    adjuster_phone: insurance?.adjuster_phone ?? "",
    date_of_loss: insurance?.date_of_loss ?? "",
    notes: insurance?.notes ?? "",
  });
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<InsuranceInput>) => setF({ ...f, ...patch });
  function save() {
    setError(null);
    start(async () => {
      const res = await upsertInsuranceClaim(jobId, f);
      if (!res.ok) return setError(res.error ?? "Could not save.");
      onSaved();
    });
  }
  return (
    <Modal open onClose={() => !pending && onClose()} title="Insurance claim" footer={<ModalActions onCancel={onClose} onSave={save} saving={pending} saveLabel="Save" />}>
      <div className="space-y-3">
        {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
        <div className="grid grid-cols-2 gap-3">
          <div><Label htmlFor="i-car">Carrier</Label><Input id="i-car" value={f.carrier ?? ""} onChange={(e) => set({ carrier: e.target.value })} /></div>
          <div><Label htmlFor="i-claim">Claim #</Label><Input id="i-claim" value={f.claim_number ?? ""} onChange={(e) => set({ claim_number: e.target.value })} /></div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div><Label htmlFor="i-pol">Policy #</Label><Input id="i-pol" value={f.policy_number ?? ""} onChange={(e) => set({ policy_number: e.target.value })} /></div>
          <div><Label htmlFor="i-loss">Date of loss</Label><Input id="i-loss" type="date" value={f.date_of_loss ?? ""} onChange={(e) => set({ date_of_loss: e.target.value })} /></div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div><Label htmlFor="i-adj">Adjuster</Label><Input id="i-adj" value={f.adjuster_name ?? ""} onChange={(e) => set({ adjuster_name: e.target.value })} /></div>
          <div><Label htmlFor="i-adjp">Adjuster phone</Label><Input id="i-adjp" value={f.adjuster_phone ?? ""} onChange={(e) => set({ adjuster_phone: e.target.value })} /></div>
        </div>
      </div>
    </Modal>
  );
}
