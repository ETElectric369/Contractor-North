import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Mail, Phone, MapPin, Plus } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { Card, CardContent } from "@/components/ui/card";
import { Badge, statusTone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs } from "@/components/tabs";
import { formatCurrency, formatDate } from "@/lib/utils";
import { EditCustomerButton } from "./edit-customer-button";
import { DeleteButton } from "@/components/delete-button";
import { SectionMapButton } from "@/components/section-map-button";
import { customerSectionTree } from "@/lib/nav-tree";
import { NewJobButton } from "../../schedule/new-job-button";
import { deleteCustomer } from "../actions";
import type { Customer, Job, Quote } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function CustomerDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: customer } = await supabase
    .from("customers")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (!customer) notFound();
  const c = customer as Customer;

  const [{ data: jobs }, { data: quotes }, { data: invoices }, { data: pricingLevels }] = await Promise.all([
    supabase.from("jobs").select("*").eq("customer_id", id).order("created_at", { ascending: false }),
    supabase.from("quotes").select("*").eq("customer_id", id).order("created_at", { ascending: false }),
    supabase
      .from("invoices")
      .select("id, invoice_number, status, total")
      .eq("customer_id", id)
      .order("created_at", { ascending: false }),
    supabase.from("pricing_levels").select("id, name, markup_pct").order("created_at"),
  ]);

  const empty = (label: string) => (
    <p className="px-1 py-6 text-center text-sm text-slate-400">No {label} yet.</p>
  );

  const tabs = [
    {
      id: "details",
      label: "Details",
      content: (
        <Card>
          <CardContent className="space-y-3 py-5 text-sm">
            {c.email ? (
              <a href={`mailto:${c.email}`} className="flex items-center gap-2 text-slate-600 hover:text-brand">
                <Mail className="h-4 w-4 text-slate-400" /> {c.email}
              </a>
            ) : null}
            {c.phone ? (
              <a href={`tel:${c.phone}`} className="flex items-center gap-2 text-slate-600 hover:text-brand">
                <Phone className="h-4 w-4 text-slate-400" /> {c.phone}
              </a>
            ) : null}
            {(c.address || c.city) && (
              <div className="flex items-start gap-2 text-slate-600">
                <MapPin className="mt-0.5 h-4 w-4 text-slate-400" />
                <span>
                  {c.address}
                  {c.address && <br />}
                  {[c.city, c.state, c.zip].filter(Boolean).join(", ")}
                </span>
              </div>
            )}
            {c.notes && (
              <div className="border-t border-slate-100 pt-3 text-slate-500">{c.notes}</div>
            )}
            {!c.email && !c.phone && !c.address && !c.notes && (
              <p className="text-slate-400">No contact details yet — use Edit to add them.</p>
            )}
          </CardContent>
        </Card>
      ),
    },
    {
      id: "jobs",
      label: "Jobs",
      count: jobs?.length ?? 0,
      content: (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-slate-100">
            {(jobs as Job[] | null)?.map((j) => (
              <li key={j.id}>
                <Link href={`/jobs/${j.id}`} className="flex items-center justify-between px-5 py-3 hover:bg-slate-50">
                  <div>
                    <div className="text-sm font-medium text-slate-900">{j.name}</div>
                    <div className="text-xs text-slate-400">{j.job_number}</div>
                  </div>
                  <Badge tone={statusTone(j.status)}>{j.status.replace("_", " ")}</Badge>
                </Link>
              </li>
            ))}
            {(!jobs || jobs.length === 0) && empty("jobs")}
          </ul>
        </Card>
      ),
    },
    {
      id: "quotes",
      label: "Quotes",
      count: quotes?.length ?? 0,
      content: (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-slate-100">
            {(quotes as Quote[] | null)?.map((q) => (
              <li key={q.id}>
                <Link href={`/quotes/${q.id}`} className="flex items-center justify-between px-5 py-3 hover:bg-slate-50">
                  <span className="text-sm font-medium text-slate-900">{q.quote_number}</span>
                  <span className="flex items-center gap-3">
                    <span className="text-sm">{formatCurrency(q.total)}</span>
                    <Badge tone={statusTone(q.status)}>{q.status}</Badge>
                  </span>
                </Link>
              </li>
            ))}
            {(!quotes || quotes.length === 0) && empty("quotes")}
          </ul>
        </Card>
      ),
    },
    {
      id: "invoices",
      label: "Invoices",
      count: invoices?.length ?? 0,
      content: (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-slate-100">
            {(invoices ?? []).map((iv: any) => (
              <li key={iv.id}>
                <Link href={`/billing/${iv.id}`} className="flex items-center justify-between px-5 py-3 hover:bg-slate-50">
                  <span className="text-sm font-medium text-slate-900">{iv.invoice_number}</span>
                  <span className="flex items-center gap-3">
                    <span className="text-sm">{formatCurrency(iv.total)}</span>
                    <Badge tone={statusTone(iv.status)}>{iv.status}</Badge>
                  </span>
                </Link>
              </li>
            ))}
            {(!invoices || invoices.length === 0) && empty("invoices")}
          </ul>
        </Card>
      ),
    },
  ];

  return (
    <div className="mx-auto max-w-4xl">
      <Link href="/crm" className="mb-4 inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800">
        <ArrowLeft className="h-4 w-4" /> Back to customers
      </Link>

      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold text-slate-900">{c.name}</h1>
            <Badge tone={statusTone(c.status)}>{c.status === "lead" ? "inquiry" : c.status}</Badge>
          </div>
          {c.company_name && <p className="mt-1 text-sm text-slate-500">{c.company_name}</p>}
          <Badge tone="slate" className="mt-2">{c.type}</Badge>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <SectionMapButton tree={customerSectionTree(c.id, c.name)} />
          <EditCustomerButton customer={c} pricingLevels={(pricingLevels ?? []) as any} />
          <NewJobButton customers={[{ id: c.id, name: c.name }]} defaultCustomerId={c.id} />
          <Link
            href={`/quotes/new?customer=${c.id}`}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-800 hover:bg-slate-50"
          >
            New quote
          </Link>
          <Link href={`/quotes/new?customer=${c.id}`}>
            <Button>
              <Plus className="h-4 w-4" /> New quote
            </Button>
          </Link>
          <DeleteButton
            run={deleteCustomer.bind(null, c.id)}
            confirmText={`Delete ${c.name}? This only works when no jobs, quotes, or invoices reference them.`}
            redirectTo="/crm"
          />
        </div>
      </div>

      <Tabs tabs={tabs} urlSync />
    </div>
  );
}
