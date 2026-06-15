import Link from "next/link";
import { FileText, Plus } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { PageHeader, EmptyState } from "@/components/page-header";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge, statusTone } from "@/components/ui/badge";
import { formatCurrency, formatDate } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function QuotesPage({
  searchParams,
}: {
  searchParams: Promise<{ type?: string }>;
}) {
  const { type } = await searchParams;
  const filter = type === "estimate" || type === "quote" ? type : null;
  const supabase = await createClient();
  let query = supabase.from("quotes").select("*, customers(name, company_name)");
  if (filter) query = query.eq("doc_type", filter);
  const { data } = await query.order("created_at", { ascending: false });

  const quotes = data ?? [];
  const heading = filter === "estimate" ? "Estimates" : filter === "quote" ? "Quotes" : "Quotes & estimates";

  return (
    <div>
      <PageHeader title={heading} description="Fixed-price quotes and time-&-materials estimates — toggle the type on any one.">
        <Link href="/quotes/new">
          <Button>
            <Plus className="h-4 w-4" /> New quote
          </Button>
        </Link>
      </PageHeader>

      {quotes.length === 0 ? (
        <EmptyState
          icon={FileText}
          title="No quotes yet"
          description="Create your first quote — the AI can draft line items from a scope of work."
        >
          <Link href="/quotes/new">
            <Button>
              <Plus className="h-4 w-4" /> New quote
            </Button>
          </Link>
        </EmptyState>
      ) : (
        <Card className="overflow-hidden">
          <div className="hidden grid-cols-12 gap-4 border-b border-slate-100 bg-slate-50 px-5 py-3 text-xs font-semibold uppercase tracking-wide text-slate-400 md:grid">
            <div className="col-span-2">Quote #</div>
            <div className="col-span-4">Customer</div>
            <div className="col-span-2">Date</div>
            <div className="col-span-2 text-right">Total</div>
            <div className="col-span-2 text-right">Status</div>
          </div>
          <ul className="divide-y divide-slate-100">
            {quotes.map((q: any) => (
              <li key={q.id}>
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
                    {q.title && (
                      <span className="block text-xs text-slate-400">{q.title}</span>
                    )}
                  </div>
                  <div className="col-span-2 text-sm text-slate-500">
                    {formatDate(q.created_at)}
                  </div>
                  <div className="col-span-2 text-right text-sm font-medium text-slate-900">
                    {formatCurrency(q.total)}
                  </div>
                  <div className="col-span-2 text-right">
                    <Badge tone={statusTone(q.status)}>{q.status}</Badge>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
