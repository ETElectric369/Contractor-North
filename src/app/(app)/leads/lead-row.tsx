"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Phone, Mail, CheckCircle2, FileText, Briefcase } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ConvertButton } from "@/components/convert-button";
import { formatDate } from "@/lib/utils";
import { markContacted, createJobForCustomer } from "@/app/(app)/crm/actions";
import type { Customer } from "@/lib/types";

export function LeadRow({ lead }: { lead: Customer }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [followUp, setFollowUp] = useState(lead.next_follow_up_at ?? "");

  const overdue =
    lead.next_follow_up_at && new Date(lead.next_follow_up_at) < new Date(new Date().toDateString());

  function contacted() {
    start(async () => {
      await markContacted(lead.id, followUp || null);
      router.refresh();
    });
  }

  return (
    <li className="flex flex-col gap-3 px-5 py-4 lg:flex-row lg:items-center lg:gap-4">
      <div className="min-w-0 flex-1">
        <Link href={`/crm/${lead.id}`} className="font-medium text-slate-900 hover:text-brand">
          {lead.name}
        </Link>
        {lead.company_name && (
          <span className="ml-2 text-xs text-slate-400">{lead.company_name}</span>
        )}
        <div className="mt-0.5 flex flex-wrap items-center gap-3 text-xs text-slate-500">
          {lead.phone && (
            <span className="flex items-center gap-1">
              <Phone className="h-3 w-3" /> {lead.phone}
            </span>
          )}
          {lead.email && (
            <span className="flex items-center gap-1">
              <Mail className="h-3 w-3" /> {lead.email}
            </span>
          )}
          <span>Added {formatDate(lead.created_at)}</span>
          {lead.last_contacted_at && (
            <span>· Last contacted {formatDate(lead.last_contacted_at)}</span>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2">
        <div className="text-right">
          <label className="mb-0.5 block text-[10px] uppercase tracking-wide text-slate-400">
            Follow up
          </label>
          <div className="flex items-center gap-1">
            <Input
              type="date"
              value={followUp}
              onChange={(e) => setFollowUp(e.target.value)}
              className="h-8 w-36 text-xs"
            />
            {overdue && <Badge tone="red">overdue</Badge>}
          </div>
        </div>
        <Button size="sm" variant="outline" onClick={contacted} disabled={pending}>
          <CheckCircle2 className="h-3.5 w-3.5" /> Contacted
        </Button>
        <Link href={`/quotes/new?customer=${lead.id}`}>
          <Button size="sm" variant="outline">
            <FileText className="h-3.5 w-3.5" /> Quote
          </Button>
        </Link>
        <ConvertButton
          label="Job"
          run={createJobForCustomer.bind(null, lead.id)}
          hrefPrefix="/jobs/"
        />
      </div>
    </li>
  );
}
