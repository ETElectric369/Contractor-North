import Link from "next/link";
import { Users, Mail, Phone, Search } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { PageHeader, EmptyState } from "@/components/page-header";
import { Card } from "@/components/ui/card";
import { Badge, statusTone } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { NewCustomerButton } from "./new-customer-button";
import { ImportCustomersButton } from "./import-customers-button";
import { sanitizeSearch } from "@/lib/utils";
import type { Customer } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function CrmPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  const supabase = await createClient();

  let query = supabase
    .from("customers")
    .select("*")
    .order("created_at", { ascending: false });

  const term = sanitizeSearch(q);
  if (term) {
    query = query.or(
      `name.ilike.%${term}%,company_name.ilike.%${term}%,email.ilike.%${term}%,phone.ilike.%${term}%`,
    );
  }

  const { data } = await query;
  const customers = (data ?? []) as Customer[];

  return (
    <div>
      <PageHeader title="Contacts" description="Everyone you work with — clients and contacts, all linkable to jobs and quotes. New leads live in the Leads tab.">
        <div className="flex flex-wrap items-start gap-2">
          <NewCustomerButton />
          {/* Bulk import (CSV/vCard) — the deliberate, infrequent SEEK door for the whole
              customer book, moved here from Settings > Company (import belongs to Contacts). */}
          <ImportCustomersButton csv label="Import" />
        </div>
      </PageHeader>

      <form className="mb-4">
        <div className="relative max-w-md">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <Input
            name="q"
            defaultValue={q}
            placeholder="Search customers…"
            className="pl-9"
          />
        </div>
      </form>

      {customers.length === 0 ? (
        <EmptyState
          icon={Users}
          title={q ? "No matches" : "No customers yet"}
          description={
            q
              ? "Try a different search."
              : "Add your first customer or lead to get started."
          }
        >
          {!q && <NewCustomerButton />}
        </EmptyState>
      ) : (
        <Card className="overflow-hidden">
          <div className="hidden grid-cols-12 gap-4 border-b border-slate-100 bg-slate-50 px-5 py-3 text-xs font-semibold uppercase tracking-wide text-slate-400 md:grid">
            <div className="col-span-4">Name</div>
            <div className="col-span-3">Contact</div>
            <div className="col-span-2">Type</div>
            <div className="col-span-2">Location</div>
            <div className="col-span-1 text-right">Status</div>
          </div>
          <ul className="divide-y divide-slate-100">
            {customers.map((c) => (
              <li key={c.id}>
                <Link
                  href={`/crm/${c.id}`}
                  className="grid grid-cols-1 gap-1 px-5 py-3 hover:bg-slate-50 md:grid-cols-12 md:items-center md:gap-4"
                >
                  <div className="col-span-4">
                    <div className="font-medium text-slate-900">{c.name}</div>
                    {c.company_name && (
                      <div className="text-xs text-slate-400">{c.company_name}</div>
                    )}
                  </div>
                  <div className="col-span-3 space-y-0.5 text-sm text-slate-500">
                    {c.email && (
                      <div className="flex items-center gap-1.5">
                        <Mail className="h-3.5 w-3.5" /> {c.email}
                      </div>
                    )}
                    {c.phone && (
                      <div className="flex items-center gap-1.5">
                        <Phone className="h-3.5 w-3.5" /> {c.phone}
                      </div>
                    )}
                  </div>
                  <div className="col-span-2 text-sm capitalize text-slate-600">
                    {c.type}
                  </div>
                  <div className="col-span-2 text-sm text-slate-500">
                    {[c.city, c.state].filter(Boolean).join(", ") || "—"}
                  </div>
                  <div className="col-span-1 md:text-right">
                    <Badge tone={statusTone(c.status)}>{c.status}</Badge>
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
