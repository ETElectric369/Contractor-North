"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Phone, Mail, CheckCircle2, Globe } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { InquiryModal } from "./inquiry-modal";
import { ConvertMenu } from "./convert-menu";
import { markInquiryContacted, setInquiryStatus } from "./actions";
import { useToast } from "@/components/toast";
import { formatDate } from "@/lib/utils";
import type { Inquiry } from "@/lib/types";

const statusTone: Record<string, "blue" | "amber" | "indigo" | "green" | "slate"> = {
  new: "blue",
  contacted: "amber",
  quoted: "indigo",
  won: "green",
  lost: "slate",
};

const STATUSES = ["new", "contacted", "quoted", "won", "lost"];

export function InquiryRow({
  inquiry,
  customers,
}: {
  inquiry: Inquiry;
  customers: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [followUp, setFollowUp] = useState(inquiry.next_follow_up_at ?? "");
  const toast = useToast();

  const overdue =
    inquiry.next_follow_up_at && new Date(inquiry.next_follow_up_at) < new Date(new Date().toDateString());

  function contacted() {
    start(async () => {
      const res = await markInquiryContacted(inquiry.id, followUp || null);
      if (!res?.ok) { toast(res?.error ?? "Couldn't mark contacted — try again.", "error"); return; }
      toast("Marked contacted", "success");
      router.refresh();
    });
  }

  function changeStatus(status: string) {
    start(async () => {
      const res = await setInquiryStatus(inquiry.id, status);
      if (!res?.ok) { toast(res?.error ?? "Couldn't update status — try again.", "error"); return; }
      // The list filters lost leads out, so the row vanishes — say it worked.
      if (status === "lost") toast("Marked lost", "success");
      router.refresh();
    });
  }

  return (
    <li className="flex flex-col gap-3 px-5 py-4 lg:flex-row lg:items-start lg:gap-4">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-slate-900">{inquiry.name}</span>
          {inquiry.company_name && <span className="text-xs text-slate-400">{inquiry.company_name}</span>}
          <Badge tone={statusTone[inquiry.status] ?? "slate"}>{inquiry.status}</Badge>
          {inquiry.source === "public_form" && (
            <Badge tone="slate">
              <Globe className="mr-1 inline h-3 w-3" />web
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
        <Button size="sm" variant="outline" onClick={contacted} disabled={pending}>
          <CheckCircle2 className="h-4 w-4" /> Contacted
        </Button>
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
