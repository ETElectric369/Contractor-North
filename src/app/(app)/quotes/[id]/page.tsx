import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { Card, CardContent } from "@/components/ui/card";
import { Badge, statusTone } from "@/components/ui/badge";
import { formatDate } from "@/lib/utils";
import { StatusControl } from "./status-control";
import { QuoteItemsEditor } from "./quote-items-editor";
import { CustomerSelect } from "./customer-select";
import { DuplicateQuoteButton } from "./duplicate-quote-button";
import { EmailButton } from "@/components/email-button";
import { SectionActionsMenu } from "@/components/section-actions-menu";
import { QuoteTypeToggle } from "./quote-type-toggle";
import type { NavTree } from "@/lib/nav-tree";
import { DeleteButton } from "@/components/delete-button";
import { createJobFromQuote, deleteQuote } from "../actions";
import { createMaterialListFromQuote } from "../../materials/actions";
import { createWorkOrderFromQuote } from "../../work-orders/actions";
import { createInvoiceFromQuote } from "../../billing/actions";
import type { Quote, QuoteLineItem } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function QuoteDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: quote, error: quoteErr } = await supabase
    .from("quotes")
    .select("*, customers(*)")
    .eq("id", id)
    .maybeSingle();

  if (quoteErr) throw quoteErr; // a real failure shouldn't masquerade as 404
  if (!quote) notFound();
  const q = quote as Quote & { customers: any };

  const { data: items } = await supabase
    .from("quote_line_items")
    .select("*")
    .eq("quote_id", id)
    .order("sort_order");

  const lineItems = (items ?? []) as QuoteLineItem[];

  // Has this quote already been turned into these records? (Drives idempotent UI:
  // the map shows "View …" instead of minting a duplicate.) Plus the org's
  // customers so the attached customer can be changed inline.
  const [{ data: existingInv }, { data: existingWo }, { data: existingMl }, { data: customers }] = await Promise.all([
    supabase.from("invoices").select("id").eq("quote_id", id).limit(1).maybeSingle(),
    supabase.from("work_orders").select("id").eq("quote_id", id).limit(1).maybeSingle(),
    supabase.from("material_lists").select("id").eq("quote_id", id).limit(1).maybeSingle(),
    supabase.from("customers").select("id, name, company_name").order("name"),
  ]);

  // The quote's whole "neighborhood" — what it connects to AND what it can
  // become — as one map. Conversion nodes (with `run`) create the record then
  // open it; relationship nodes navigate.
  const quoteMap: NavTree = {
    center: { label: q.quote_number, icon: "fileText" },
    nodes: [
      ...(q.customers ? [{ id: "qm-cust", label: "Customer", icon: "users", href: `/crm/${q.customers.id}` }] : []),
      existingInv
        ? { id: "qm-inv", label: "View invoice", icon: "receipt", href: `/billing/${existingInv.id}` }
        : { id: "qm-inv", label: "Create invoice", icon: "receipt", run: createInvoiceFromQuote.bind(null, q.id), hrefPrefix: "/billing/" },
      (q as any).job_id
        ? { id: "qm-job", label: "View job", icon: "briefcase", href: `/jobs/${(q as any).job_id}` }
        : { id: "qm-job", label: "Create job", icon: "briefcase", run: createJobFromQuote.bind(null, q.id), hrefPrefix: "/jobs/" },
      ...(lineItems.length > 0
        ? [
            existingWo
              ? { id: "qm-wo", label: "View work order", icon: "clipboardCheck", href: `/work-orders/${existingWo.id}` }
              : { id: "qm-wo", label: "Create work order", icon: "clipboardCheck", run: createWorkOrderFromQuote.bind(null, q.id), hrefPrefix: "/work-orders/" },
            existingMl
              ? { id: "qm-ml", label: "View material list", icon: "boxes", href: `/materials/${existingMl.id}` }
              : { id: "qm-ml", label: "Create material list", icon: "boxes", run: createMaterialListFromQuote.bind(null, q.id), hrefPrefix: "/materials/" },
          ]
        : []),
      { id: "qm-print", label: "Print / PDF", icon: "fileSpreadsheet", href: `/print/quote/${q.id}` },
      { id: "qm-all", label: "All quotes", icon: "list", href: "/quotes" },
    ],
  };

  return (
    <div className="mx-auto max-w-3xl">
      <Link
        href="/quotes"
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800"
      >
        <ArrowLeft className="h-4 w-4" /> Back to quotes
      </Link>

      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold text-slate-900">{q.quote_number}</h1>
            <Badge tone={statusTone(q.status)}>{q.status}</Badge>
            <QuoteTypeToggle id={q.id} value={(((q as any).doc_type ?? "quote") as "estimate" | "quote")} />
          </div>
          {q.title && <p className="mt-1 text-slate-600">{q.title}</p>}
          <p className="mt-1 text-sm text-slate-400">
            Created {formatDate(q.created_at)}
            {q.valid_until ? ` · Valid until ${formatDate(q.valid_until)}` : ""}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <EmailButton id={q.id} kind="quote" />
          <DuplicateQuoteButton id={q.id} />
          <SectionActionsMenu tree={quoteMap} label="Convert / connect" />
          <StatusControl id={q.id} status={q.status} />
          <DeleteButton
            run={deleteQuote.bind(null, q.id)}
            confirmText={`Delete quote ${q.quote_number}? Its line items go with it.`}
            redirectTo="/quotes"
          />
        </div>
      </div>

      <Card className="mb-6">
        <CardContent className="py-5">
          <CustomerSelect
            quoteId={q.id}
            customer={q.customers ?? null}
            customers={(customers ?? []) as { id: string; name: string; company_name: string | null }[]}
          />
        </CardContent>
      </Card>

      <QuoteItemsEditor quote={q} items={lineItems} />
    </div>
  );
}
