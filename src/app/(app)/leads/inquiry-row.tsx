"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Phone, Mail, Globe } from "lucide-react";
import { Input, Select } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { InquiryModal } from "./inquiry-modal";
import { ConvertMenu } from "./convert-menu";
import { deleteInquiry, markInquiryContacted, setInquiryStatus } from "./actions";
import { useToast } from "@/components/toast";
import { formatDateTime, formatDate } from "@/lib/utils";
import type { Inquiry, LeadBucket } from "@/lib/types";
import { INQUIRY_STATUSES } from "@/lib/statuses";
import { LEAD_BUCKETS } from "@/lib/lead-triage";
import { IntakeFiles } from "./intake-files";

// Named INQUIRY_STATUS_TONE (not `statusTone`) so it can't shadow the shared badge
// statusTone helper. Values cover every INQUIRY_STATUSES entry.
const INQUIRY_STATUS_TONE: Record<string, "blue" | "amber" | "indigo" | "green" | "slate"> = {
  new: "blue",
  contacted: "amber",
  quoted: "indigo",
  won: "green",
  lost: "slate",
};

// The A/B/C readiness chip — colour + Chris's dot language (🟢 ready · 🟡 measure · 🔵 consult).
const BUCKET_TONE: Record<LeadBucket, "green" | "amber" | "blue"> = { A: "green", B: "amber", C: "blue" };
const BUCKET_DOT: Record<LeadBucket, string> = { A: "🟢", B: "🟡", C: "🔵" };


/** Every file path across the lead's intake answers, in answer order. */
function intakePaths(intake: unknown): string[] {
  const answers = (intake as { intake_answers?: Record<string, unknown> } | null)?.intake_answers;
  if (!answers || typeof answers !== "object") return [];
  return Object.values(answers)
    .filter(Array.isArray)
    .flat()
    .filter((v): v is string => typeof v === "string" && v.includes("/intake/"));
}

export function InquiryRow({
  inquiry,
  customers,
  focused = false,
  inspections = null,
}: {
  inquiry: Inquiry;
  customers: { id: string; name: string }[];
  /** True when My Day (or an estimate backlink) deep-linked to this exact lead —
      scroll it into view and flash a highlight so the eye lands on the right row. */
  focused?: boolean;
  /** Walk-throughs on this lead. A lead with a completed inspection is CORRECTLY still open —
   *  inspection is exempt from converting, so it can still become an estimate — but the row used
   *  to look identical to one nobody had touched. This is what it takes to tell them apart. */
  inspections?: { done: number; upcoming: number } | null;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [followUp, setFollowUp] = useState(inquiry.next_follow_up_at ?? "");
  const toast = useToast();
  const rowRef = useRef<HTMLLIElement>(null);
  const [flash, setFlash] = useState(false);
  // Option B (approved by Erik AND Andrew off the layout mock): two lines per lead, the one-tap
  // verbs ON the row, and everything heavier — the message, the files, follow-up date, status,
  // edit — behind this one toggle. The old row stacked all of it full-width below lg, so three
  // leads filled a phone screen.
  const [open, setOpen] = useState(false);

  useEffect(() => {
    // On un-focus (e.g. a same-route nav to /leads that keeps this row mounted) clear the ring —
    // otherwise the cleanup cancels the pending setFlash(false) and the highlight sticks on.
    if (!focused || !rowRef.current) { setFlash(false); return; }
    rowRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
    setFlash(true);
    const t = setTimeout(() => setFlash(false), 2200);
    return () => clearTimeout(t);
  }, [focused]);

  const overdue =
    inquiry.next_follow_up_at && new Date(inquiry.next_follow_up_at) < new Date(new Date().toDateString());

  // The Status dropdown is the ONE lead-state control (the old standalone "Contacted"
  // button was redundant with it and crowded the row). Picking "Contacted" still does the
  // full stamp — last_contacted_at + the follow-up date — via markInquiryContacted; every
  // other status is a plain set.
  function changeStatus(status: string) {
    start(async () => {
      const res =
        status === "contacted"
          ? await markInquiryContacted(inquiry.id, followUp || null)
          : await setInquiryStatus(inquiry.id, status);
      if (!res?.ok) { toast(res?.error ?? "Couldn't update status — try again.", "error"); return; }
      if (status === "contacted") toast("Marked contacted", "success");
      // The list filters lost leads out, so the row vanishes — say it worked.
      if (status === "lost") toast("Marked lost", "success");
      router.refresh();
    });
  }

  return (
    <li
      ref={rowRef}
      id={`lead-${inquiry.id}`}
      className={`flex scroll-mt-24 flex-col gap-1 px-4 py-2.5 transition-colors ${
        flash ? "bg-brand/5 ring-2 ring-inset ring-brand" : ""
      }`}
    >
      {/* ── LINE 1: who, what state, when. The time sits hard right — fresh leads are triaged by
          recency, and it reads as a column down the board. ── */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-semibold text-slate-900">{inquiry.name}</span>
        {inquiry.company_name && <span className="text-xs text-slate-400">{inquiry.company_name}</span>}
        <Badge tone={INQUIRY_STATUS_TONE[inquiry.status] ?? "slate"}>{inquiry.status}</Badge>
        {/* Staying open after an inspection is deliberate (an inspected lead can still become an
            estimate); the badge is what stops the row reading as untouched. A count, not a
            status: what it says is true and stays true. */}
        {!!inspections?.done && (
          <Badge tone="green">{inspections.done === 1 ? "inspected" : `inspected ×${inspections.done}`}</Badge>
        )}
        {!inspections?.done && !!inspections?.upcoming && <Badge tone="blue">inspection booked</Badge>}
        {inquiry.lead_bucket && (
          <Badge tone={BUCKET_TONE[inquiry.lead_bucket]} title={LEAD_BUCKETS[inquiry.lead_bucket].blurb}>
            {BUCKET_DOT[inquiry.lead_bucket]} {inquiry.lead_bucket}
          </Badge>
        )}
        {inquiry.site_inspection_required && (
          <Badge tone="red" title="Needs a human site visit — triaged over the threshold, or the customer requested one (send them times via Convert → Let them pick).">
            🚩 Site visit
          </Badge>
        )}
        {["public_form", "intake"].includes(String(inquiry.source)) && (
          <Badge tone="slate"><Globe className="mr-1 inline h-3 w-3" />web</Badge>
        )}
        {(inquiry.source === "tahoe_deck" || inquiry.source === "deck_configurator") && (
          <Badge tone="slate"><Globe className="mr-1 inline h-3 w-3" />deck site</Badge>
        )}
        {(inquiry as any).referrer?.full_name && (
          <Badge tone="green">referred by {(inquiry as any).referrer.full_name}</Badge>
        )}
        {overdue && <Badge tone="red">follow-up overdue</Badge>}
        <span className="ml-auto whitespace-nowrap font-mono text-xs tabular-nums text-slate-400" title={`Added ${formatDateTime(inquiry.created_at)}`}>
          {formatDateTime(inquiry.created_at)}
        </span>
      </div>

      {/* ── LINE 2: how to reach them, and the verbs. Call is one tap (tel:), the pipeline verbs
          are the ConvertMenu's own buttons, and ⋯ opens everything else. ── */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-slate-500">
        {inquiry.phone && (
          <a href={`tel:${inquiry.phone}`} className="flex items-center gap-1 font-medium text-brand hover:underline">
            <Phone className="h-3 w-3" /> {inquiry.phone}
          </a>
        )}
        {inquiry.email && (
          <span className="hidden items-center gap-1 sm:flex"><Mail className="h-3 w-3" /> {inquiry.email}</span>
        )}
        {inquiry.last_contacted_at && <span>contacted {formatDate(inquiry.last_contacted_at)}</span>}
        {inquiry.intake?.reason && <span className="hidden text-slate-400 md:inline">{inquiry.intake.reason}</span>}
        <span className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
          <ConvertMenu inquiryId={inquiry.id} inquiryName={inquiry.name} customers={customers} />
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-label={open ? "Hide details" : "Show details — message, files, follow-up, status"}
            className="rounded-lg border border-slate-200 px-2 py-1 text-xs font-semibold text-slate-500 hover:bg-slate-50"
          >
            {open ? "Less" : "⋯"}
          </button>
        </span>
      </div>

      {/* The message rides collapsed as ONE clamped line — the single biggest source of the old
          row's height. The full text, the customer's files and the workflow controls all live one
          tap away, on the row, without a navigation. */}
      {!open && inquiry.message && (
        <p className="line-clamp-1 text-xs text-slate-500">{inquiry.message}</p>
      )}

      {open && (
        <div className="mt-1 space-y-3 rounded-lg bg-slate-50/70 p-3">
          {inquiry.message && <p className="whitespace-pre-wrap text-sm text-slate-600">{inquiry.message}</p>}
          <IntakeFiles inquiryId={inquiry.id} paths={intakePaths(inquiry.intake)} />
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label className="mb-0.5 block text-[10px] uppercase tracking-wide text-slate-400">Follow up</label>
              <Input type="date" value={followUp} onChange={(e) => setFollowUp(e.target.value)} className="h-8 w-40 text-xs" />
            </div>
            <div>
              <label className="mb-0.5 block text-[10px] uppercase tracking-wide text-slate-400">Status</label>
              {/* "Lost" lives ONLY here (a deliberate two-tap pick) — the old one-tap "Mark lost"
                  button vanished the row from a mis-tap beside Edit/Convert. */}
              <Select
                value={inquiry.status}
                disabled={pending}
                className="h-8 w-36 text-xs"
                onChange={(e) => changeStatus(e.target.value)}
              >
                {INQUIRY_STATUSES.map((st) => (
                  <option key={st} value={st}>
                    {st.replace(/^\w/, (c) => c.toUpperCase())}
                  </option>
                ))}
              </Select>
            </div>
            <InquiryModal inquiry={inquiry} mode="edit" />
            {/* DELETE, inside the ⋯ panel — Erik: "add a way to delete a lead entry… or a Delete
                option inside the row's ⋯ menu." Behind the door and behind a confirm, per the nav
                doctrine: destructive never sits beside the verbs you tap at 60mph. Note the split
                of meanings — LOST is a two-tap status for a lead that said no (it keeps the
                record); delete is for tests and junk, and it keeps nothing. */}
            <button
              type="button"
              disabled={pending}
              onClick={() => {
                if (!confirm(`Delete "${inquiry.name}" completely? A lead that said no should be marked Lost instead — delete keeps nothing.`)) return;
                start(async () => {
                  const r = await deleteInquiry(inquiry.id);
                  if (!r.ok) toast(r.error ?? "Couldn't delete that.", "error");
                  else router.refresh();
                });
              }}
              className="ml-auto self-end rounded-lg px-2 py-1.5 text-xs font-medium text-rose-600 hover:bg-rose-50"
            >
              Delete lead
            </button>
          </div>
        </div>
      )}
    </li>
  );
}
