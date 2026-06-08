import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Mail, Phone, MapPin, FileText, Plus } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { Card, CardContent } from "@/components/ui/card";
import { Badge, statusTone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatCurrency, formatDate } from "@/lib/utils";
import { EditCustomerButton } from "./edit-customer-button";
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

  const [{ data: jobs }, { data: quotes }] = await Promise.all([
    supabase
      .from("jobs")
      .select("*")
      .eq("customer_id", id)
      .order("created_at", { ascending: false }),
    supabase
      .from("quotes")
      .select("*")
      .eq("customer_id", id)
      .order("created_at", { ascending: false }),
  ]);

  return (
    <div className="mx-auto max-w-4xl">
      <Link
        href="/crm"
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800"
      >
        <ArrowLeft className="h-4 w-4" /> Back to CRM
      </Link>

      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold text-slate-900">{c.name}</h1>
            <Badge tone={statusTone(c.status)}>{c.status}</Badge>
          </div>
          {c.company_name && (
            <p className="mt-1 text-sm text-slate-500">{c.company_name}</p>
          )}
          <Badge tone="slate" className="mt-2">
            {c.type}
          </Badge>
        </div>
        <div className="flex items-center gap-2">
          <EditCustomerButton customer={c} />
          <Link href={`/quotes/new?customer=${c.id}`}>
            <Button>
              <Plus className="h-4 w-4" /> New quote
            </Button>
          </Link>
        </div>
      </div>

      <div className="grid gap-6 md:grid-cols-3">
        <Card className="md:col-span-1">
          <CardContent className="space-y-3 py-5 text-sm">
            <h3 className="font-semibold text-slate-900">Contact</h3>
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
              <div className="border-t border-slate-100 pt-3 text-slate-500">
                {c.notes}
              </div>
            )}
          </CardContent>
        </Card>

        <div className="space-y-6 md:col-span-2">
          <Card>
            <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3">
              <h3 className="text-sm font-semibold text-slate-900">
                Quotes ({quotes?.length ?? 0})
              </h3>
            </div>
            <ul className="divide-y divide-slate-100">
              {(quotes as Quote[] | null)?.map((q) => (
                <li key={q.id}>
                  <Link
                    href={`/quotes/${q.id}`}
                    className="flex items-center justify-between px-5 py-3 hover:bg-slate-50"
                  >
                    <div className="flex items-center gap-2">
                      <FileText className="h-4 w-4 text-slate-400" />
                      <span className="text-sm font-medium text-slate-900">
                        {q.quote_number}
                      </span>
                      <span className="text-xs text-slate-400">
                        {formatDate(q.created_at)}
                      </span>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="text-sm font-medium">{formatCurrency(q.total)}</span>
                      <Badge tone={statusTone(q.status)}>{q.status}</Badge>
                    </div>
                  </Link>
                </li>
              ))}
              {(!quotes || quotes.length === 0) && (
                <li className="px-5 py-6 text-center text-sm text-slate-400">
                  No quotes yet.
                </li>
              )}
            </ul>
          </Card>

          <Card>
            <div className="border-b border-slate-100 px-5 py-3">
              <h3 className="text-sm font-semibold text-slate-900">
                Jobs ({jobs?.length ?? 0})
              </h3>
            </div>
            <ul className="divide-y divide-slate-100">
              {(jobs as Job[] | null)?.map((j) => (
                <li key={j.id} className="flex items-center justify-between px-5 py-3">
                  <div>
                    <div className="text-sm font-medium text-slate-900">{j.name}</div>
                    <div className="text-xs text-slate-400">{j.job_number}</div>
                  </div>
                  <Badge tone={statusTone(j.status)}>
                    {j.status.replace("_", " ")}
                  </Badge>
                </li>
              ))}
              {(!jobs || jobs.length === 0) && (
                <li className="px-5 py-6 text-center text-sm text-slate-400">
                  No jobs yet.
                </li>
              )}
            </ul>
          </Card>
        </div>
      </div>
    </div>
  );
}
