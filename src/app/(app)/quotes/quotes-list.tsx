"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Trash2, Copy, Check } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge, statusTone } from "@/components/ui/badge";
import { useToast } from "@/components/toast";
import { formatCurrency, formatDate } from "@/lib/utils";
import { deleteQuote, resolveDuplicateDrafts } from "./actions";

type QuoteRow = {
  id: string;
  quote_number: string | null;
  title: string | null;
  status: string | null;
  doc_type: string | null;
  total: number | null;
  created_at: string;
  customer_id: string | null;
  job_id: string | null;
  customers?: { name?: string | null; company_name?: string | null } | null;
};

/** A cluster of 2+ DRAFT quotes for one customer at the same rounded total —
 *  the strong duplicate signal (the E-009/E-010/E-011 400A case). */
type DupCluster = {
  key: string;
  customerName: string;
  total: number | null;
  drafts: QuoteRow[];
};

export function QuotesList({
  quotes,
  clusters,
  isStaff,
}: {
  quotes: QuoteRow[];
  clusters: DupCluster[];
  isStaff: boolean;
}) {
  return (
    <>
      {isStaff && clusters.length > 0 && (
        <DuplicatesCard clusters={clusters} />
      )}

      <Card className="overflow-hidden">
        <div className="hidden grid-cols-12 gap-4 border-b border-slate-100 bg-slate-50 px-5 py-3 text-xs font-semibold uppercase tracking-wide text-slate-400 md:grid">
          <div className="col-span-2">Estimate #</div>
          <div className="col-span-4">Customer</div>
          <div className="col-span-2">Date</div>
          <div className="col-span-2 text-right">Total</div>
          <div className="col-span-2 text-right">Status</div>
        </div>
        <ul className="divide-y divide-slate-100">
          {quotes.map((q) => (
            <QuoteRowItem key={q.id} q={q} isStaff={isStaff} />
          ))}
        </ul>
      </Card>
    </>
  );
}

function QuoteRowItem({ q, isStaff }: { q: QuoteRow; isStaff: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const isDraft = (q.status ?? "") === "draft";

  function onDelete(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (!confirm("Delete this draft?")) return;
    start(async () => {
      const res = await deleteQuote(q.id);
      if (!res.ok) return toast(res.error ?? "Couldn't delete the draft.", "error");
      toast("Draft deleted.", "success");
      router.refresh();
    });
  }

  return (
    <li className="relative">
      <Link
        href={`/quotes/${q.id}`}
        className="grid grid-cols-2 gap-2 px-5 py-3 hover:bg-slate-50 md:grid-cols-12 md:items-center md:gap-4"
      >
        <div className="col-span-2 font-medium text-slate-900">
          {q.quote_number}
          <span className="ml-2 align-middle rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
            {(q.doc_type ?? "quote") === "estimate" ? "Est" : "Quote"}
          </span>
        </div>
        <div className="col-span-4 text-sm text-slate-600">
          {q.customers?.name ?? "—"}
          {q.title && <span className="block text-xs text-slate-400">{q.title}</span>}
        </div>
        <div className="col-span-2 text-sm text-slate-500">{formatDate(q.created_at)}</div>
        <div className="col-span-2 text-right text-sm font-medium text-slate-900">
          {formatCurrency(q.total)}
        </div>
        {/* Leave room on the right for the draft trash affordance so it never
            overlaps the status badge. */}
        <div className="col-span-2 flex items-center justify-end gap-2 pr-8 md:pr-8">
          <Badge tone={statusTone(q.status ?? "")}>{q.status}</Badge>
        </div>
      </Link>
      {/* Per-draft delete — only drafts (sent/accepted keep the guarded menu on
          the quote page). Confirm-gated, toasts, refreshes. */}
      {isStaff && isDraft && (
        <button
          type="button"
          onClick={onDelete}
          disabled={pending}
          aria-label="Delete this draft"
          title="Delete this draft"
          className="absolute right-4 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-slate-400 transition-colors hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      )}
    </li>
  );
}

function DuplicatesCard({ clusters }: { clusters: DupCluster[] }) {
  return (
    <Card className="mb-4 overflow-hidden border-amber-200 bg-amber-50/60">
      <div className="flex items-center gap-2 border-b border-amber-100 px-4 py-2.5">
        <Copy className="h-4 w-4 text-amber-600" />
        <h2 className="text-sm font-semibold text-amber-900">
          Possible duplicates
        </h2>
        <span className="text-xs text-amber-700">
          {clusters.length} {clusters.length === 1 ? "group" : "groups"}
        </span>
      </div>
      <ul className="divide-y divide-amber-100">
        {clusters.map((c) => (
          <DupClusterRow key={c.key} cluster={c} />
        ))}
      </ul>
    </Card>
  );
}

function DupClusterRow({ cluster }: { cluster: DupCluster }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();

  // Prefer keeping a draft pinned to a job (job_id not null) — that's the one
  // wired into real work; the rest are stray copies.
  const pinned = cluster.drafts.find((d) => d.job_id != null);

  function keepAndClean(keepId: string) {
    const keep = cluster.drafts.find((d) => d.id === keepId);
    const losers = cluster.drafts.filter((d) => d.id !== keepId);
    if (!keep || losers.length === 0) return;
    if (
      !confirm(
        `Keep ${keep.quote_number ?? "this draft"} and delete the other ${losers.length}?`,
      )
    )
      return;
    start(async () => {
      const res = await resolveDuplicateDrafts(
        keepId,
        losers.map((d) => d.id),
      );
      if (!res.ok)
        return toast(res.error ?? "Couldn't clean up the duplicates.", "error");
      toast(
        `Kept ${keep.quote_number ?? "the draft"}, deleted ${res.deleted ?? losers.length}.`,
        "success",
      );
      router.refresh();
    });
  }

  return (
    <li className="px-4 py-3">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <span className="text-sm font-medium text-slate-800">{cluster.customerName}</span>
        <span className="text-sm font-semibold text-slate-900">
          {formatCurrency(cluster.total)}
        </span>
      </div>
      <ul className="space-y-1.5">
        {cluster.drafts.map((d) => {
          const isPinned = pinned?.id === d.id;
          return (
            <li
              key={d.id}
              className="flex items-center gap-2 text-xs text-slate-600"
            >
              <Link
                href={`/quotes/${d.id}`}
                className="min-w-0 flex-1 truncate hover:text-slate-900 hover:underline"
              >
                <span className="font-medium text-slate-800">{d.quote_number}</span>
                {d.title ? ` · ${d.title}` : ""} · {formatDate(d.created_at)}
                {isPinned && (
                  <span className="ml-1.5 rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-700">
                    on a job
                  </span>
                )}
              </Link>
              <button
                type="button"
                onClick={() => keepAndClean(d.id)}
                disabled={pending}
                className="shrink-0 inline-flex items-center gap-1 rounded-md border border-emerald-200 bg-white px-2 py-1 text-[11px] font-medium text-emerald-700 transition-colors hover:bg-emerald-50 disabled:opacity-50"
                title="Keep this one, delete the rest"
              >
                <Check className="h-3 w-3" /> Keep this
              </button>
            </li>
          );
        })}
      </ul>
      {pinned && (
        <p className="mt-1.5 text-[11px] text-amber-700">
          {pinned.quote_number} is on a job — keeping that one is usually right.
        </p>
      )}
    </li>
  );
}
