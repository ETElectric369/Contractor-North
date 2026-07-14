import Link from "next/link";
import { isStaffRole } from "@/lib/actions/perms";
import { FileText, Plus, X } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { PageHeader, EmptyState } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { QUOTE_STATUSES, QUOTE_STATUS_PRIORITY, type QuoteStatus } from "@/lib/statuses";
import { QuotesList } from "./quotes-list";

export const dynamic = "force-dynamic";

export default async function QuotesPage({
  searchParams,
}: {
  searchParams: Promise<{ type?: string; status?: string }>;
}) {
  const { type, status } = await searchParams;
  const filter = type === "estimate" || type === "quote" ? type : null;
  // ?status= filter, validated against the spine (a stale link falls back to the full view).
  const statusFilter = (QUOTE_STATUSES as readonly string[]).includes(status ?? "")
    ? (status as QuoteStatus)
    : null;
  const supabase = await createClient();

  // Staff gate for the cleanup affordances (delete / dedupe) — RLS + the server
  // actions also enforce this; this just hides the buttons for crew.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { data: me } = user
    ? await supabase.from("profiles").select("role").eq("id", user.id).maybeSingle()
    : { data: null };
  const isStaff = !!me && isStaffRole((me as { role?: string }).role ?? "");

  // inquiry:inquiry_id — so a deferred-customer estimate (customer_id null until accepted) still
  // shows WHO it's for (the lead's name) instead of a blank dash.
  let query = supabase.from("quotes").select("*, customers(name, company_name), inquiry:inquiry_id(name)");
  if (filter) query = query.eq("doc_type", filter);
  if (statusFilter) query = query.eq("status", statusFilter);
  const { data } = await query.order("created_at", { ascending: false });

  const quotes = (data ?? []) as any[];
  // Default view: settled paperwork files away. Stable-sort by lifecycle weight (mirrors the
  // jobs list) so an accepted estimate that already became a job — or a declined/expired one —
  // sinks below the live pipeline instead of cluttering it. Newest-first within each band.
  if (!statusFilter) {
    quotes.sort(
      (a, b) =>
        (QUOTE_STATUS_PRIORITY[a.status as QuoteStatus] ?? 9) -
        (QUOTE_STATUS_PRIORITY[b.status as QuoteStatus] ?? 9),
    );
  }
  const heading = filter === "quote" ? "Quotes" : "Estimates";

  // Duplicate detector: 2+ DRAFT quotes sharing customer_id AND rounded total is
  // a strong "saved twice" signal (the E-009/E-010/E-011 400A case). Cluster
  // them so the office can keep one and sweep the rest in a tap. Never nag when
  // there are none — the card is hidden entirely.
  const clusters = buildDuplicateClusters(quotes);

  return (
    <div>
      <PageHeader title={heading} description="Estimates are time-&-materials by default — switch any one to a fixed-price quote.">
        <Link href="/quotes/new">
          <Button>
            <Plus className="h-4 w-4" /> New Estimate
          </Button>
        </Link>
      </PageHeader>

      {statusFilter && (
        <div className="mb-4">
          <Link
            href="/quotes"
            className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-1 text-sm text-slate-600 hover:bg-slate-50"
          >
            Filtered: <span className="font-medium capitalize">{statusFilter}</span>
            <X className="h-3.5 w-3.5 text-slate-400" />
          </Link>
        </div>
      )}

      {quotes.length === 0 ? (
        <EmptyState
          icon={FileText}
          title="No estimates yet"
          description="Create your first estimate — the AI can draft line items from a scope of work."
        >
          <Link href="/quotes/new">
            <Button>
              <Plus className="h-4 w-4" /> New Estimate
            </Button>
          </Link>
        </EmptyState>
      ) : (
        <QuotesList quotes={quotes} clusters={clusters} isStaff={isStaff} />
      )}
    </div>
  );
}

/** Group DRAFT quotes by (customer_id, rounded total). Any bucket with 2+
 *  members is a possible-duplicate cluster. Unattached-customer drafts
 *  (customer_id null) are never clustered — no customer to match on. */
function buildDuplicateClusters(quotes: any[]) {
  const buckets = new Map<string, any[]>();
  for (const q of quotes) {
    if ((q.status ?? "") !== "draft") continue;
    if (q.customer_id == null) continue;
    const cents = Math.round(Number(q.total ?? 0) * 100);
    const key = `${q.customer_id}:${cents}`;
    const arr = buckets.get(key);
    if (arr) arr.push(q);
    else buckets.set(key, [q]);
  }

  const clusters: {
    key: string;
    customerName: string;
    total: number | null;
    drafts: any[];
  }[] = [];
  for (const [key, drafts] of buckets) {
    if (drafts.length < 2) continue;
    clusters.push({
      key,
      customerName: drafts[0].customers?.name ?? "Unknown customer",
      total: drafts[0].total ?? 0,
      drafts,
    });
  }
  return clusters;
}
