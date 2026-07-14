"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Phone, Mail, Globe } from "lucide-react";
import { Input, Select } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { InquiryModal } from "./inquiry-modal";
import { ConvertMenu } from "./convert-menu";
import { markInquiryContacted, setInquiryStatus } from "./actions";
import { useToast } from "@/components/toast";
import { formatDate } from "@/lib/utils";
import type { Inquiry, LeadBucket } from "@/lib/types";
import { LEAD_BUCKETS } from "@/lib/lead-triage";

const statusTone: Record<string, "blue" | "amber" | "indigo" | "green" | "slate"> = {
  new: "blue",
  contacted: "amber",
  quoted: "indigo",
  won: "green",
  lost: "slate",
};

// The A/B/C readiness chip — colour + Chris's dot language (🟢 ready · 🟡 measure · 🔵 consult).
const BUCKET_TONE: Record<LeadBucket, "green" | "amber" | "blue"> = { A: "green", B: "amber", C: "blue" };
const BUCKET_DOT: Record<LeadBucket, string> = { A: "🟢", B: "🟡", C: "🔵" };

const STATUSES = ["new", "contacted", "quoted", "won", "lost"];

export function InquiryRow({
  inquiry,
  customers,
  focused = false,
}: {
  inquiry: Inquiry;
  customers: { id: string; name: string }[];
  /** True when My Day (or an estimate backlink) deep-linked to this exact lead —
      scroll it into view and flash a highlight so the eye lands on the right row. */
  focused?: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [followUp, setFollowUp] = useState(inquiry.next_follow_up_at ?? "");
  const toast = useToast();
  const rowRef = useRef<HTMLLIElement>(null);
  const [flash, setFlash] = useState(false);

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
      className={`flex scroll-mt-24 flex-col gap-3 px-5 py-4 transition-colors lg:flex-row lg:items-start lg:gap-4 ${
        flash ? "bg-brand/5 ring-2 ring-inset ring-brand" : ""
      }`}
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-slate-900">{inquiry.name}</span>
          {inquiry.company_name && <span className="text-xs text-slate-400">{inquiry.company_name}</span>}
          <Badge tone={statusTone[inquiry.status] ?? "slate"}>{inquiry.status}</Badge>
          {/* Triage — the A/B/C readiness bucket and the big-job site-visit gate come from
              /api/inbound/lead (Tahoe Deck); the site-visit flag ALSO lights when a customer
              taps "Request a site visit" on a public surface (publicScheduleInspection).
              Legacy/manual leads have neither and show nothing. */}
          {inquiry.lead_bucket && (
            <Badge tone={BUCKET_TONE[inquiry.lead_bucket]} title={LEAD_BUCKETS[inquiry.lead_bucket].blurb}>
              {BUCKET_DOT[inquiry.lead_bucket]} {inquiry.lead_bucket} · {LEAD_BUCKETS[inquiry.lead_bucket].label}
            </Badge>
          )}
          {inquiry.site_inspection_required && (
            <Badge tone="red" title="Needs a human site visit — triaged over the threshold, or the customer requested one (send them times via Convert → Let them pick).">
              🚩 Site visit
            </Badge>
          )}
          {inquiry.source === "public_form" && (
            <Badge tone="slate">
              <Globe className="mr-1 inline h-3 w-3" />web
            </Badge>
          )}
          {inquiry.source === "tahoe_deck" && (
            <Badge tone="slate">
              <Globe className="mr-1 inline h-3 w-3" />deck site
            </Badge>
          )}
          {/* Referral credit ("Brian at the bar") — who shared the link this lead came through. */}
          {(inquiry as any).referrer?.full_name && (
            <Badge tone="green">referred by {(inquiry as any).referrer.full_name}</Badge>
          )}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-3 text-xs text-slate-500">
          {inquiry.phone && (
            <span className="flex items-center gap-1"><Phone className="h-3 w-3" /> {inquiry.phone}</span>
          )}
          {inquiry.email && (
            <span className="flex items-center gap-1"><Mail className="h-3 w-3" /> {inquiry.email}</span>
          )}
          <span>Added {formatDate(inquiry.created_at)}</span>
          {inquiry.last_contacted_at && <span>· Contacted {formatDate(inquiry.last_contacted_at)}</span>}
          {inquiry.intake?.reason && <span className="text-slate-400">· {inquiry.intake.reason}</span>}
        </div>
        {inquiry.message && <p className="mt-1.5 text-sm text-slate-600">{inquiry.message}</p>}
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <div className="text-right">
          <label className="mb-0.5 block text-[10px] uppercase tracking-wide text-slate-400">Follow up</label>
          <div className="flex items-center gap-1">
            <Input type="date" value={followUp} onChange={(e) => setFollowUp(e.target.value)} className="h-8 w-36 text-xs" />
            {overdue && <Badge tone="red">overdue</Badge>}
          </div>
        </div>
        <div className="text-right">
          <label className="mb-0.5 block text-[10px] uppercase tracking-wide text-slate-400">Status</label>
          <Select
            value={inquiry.status}
            disabled={pending}
            className="h-8 w-32 text-xs"
            onChange={(e) => changeStatus(e.target.value)}
          >
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s.replace(/^\w/, (c) => c.toUpperCase())}
              </option>
            ))}
          </Select>
        </div>
        {/* "Lost" lives ONLY in the Status select (a deliberate two-tap pick) —
            the old one-tap "Mark lost" button duplicated it mid-cluster and
            vanished the row from a mis-tap beside Edit/Convert. */}
        <InquiryModal inquiry={inquiry} mode="edit" />
        <ConvertMenu inquiryId={inquiry.id} inquiryName={inquiry.name} customers={customers} />
      </div>
    </li>
  );
}
