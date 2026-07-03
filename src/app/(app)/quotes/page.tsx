import Link from "next/link";
import { FileText, Plus } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { PageHeader, EmptyState } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { QuotesList } from "./quotes-list";

export const dynamic = "force-dynamic";

export default async function QuotesPage({
  searchParams,
}: {
  searchParams: Promise<{ type?: string }>;
}) {
  const { type } = await searchParams;
  const filter = type === "estimate" || type === "quote" ? type : null;
  const supabase = await createClient();

  // Staff gate for the cleanup affordances (delete / dedupe) — RLS + the server
  // actions also enforce this; this just hides the buttons for crew.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { data: me } = user
    ? await supabase.from("profiles").select("role").eq("id", user.id).maybeSingle()
    : { data: null };
  const isStaff = !!me && ["owner", "admin", "office"].includes((me as { role?: string }).role ?? "");

  let query = supabase.from("quotes").select("*, customers(name, company_name)");
  if (filter) query = query.eq("doc_type", filter);
  const { data } = await query.order("created_at", { ascending: false });

  const quotes = (data ?? []) as any[];
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
            <Plus className="h-4 w-4" /> New estimate
          </Button>
        </Link>
      </PageHeader>

      {quotes.length === 0 ? (
        <EmptyState
          icon={FileText}
          title="No estimates yet"
          description="Create your first estimate — the AI can draft line items from a scope of work."
        >
          <Link href="/quotes/new">
            <Button>
              <Plus className="h-4 w-4" /> New estimate
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
