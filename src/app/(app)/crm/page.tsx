import { Users, Mail, Phone, Search } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { PageHeader, EmptyState } from "@/components/page-header";
import { Card } from "@/components/ui/card";
import { Badge, statusTone } from "@/components/ui/badge";
import { DataTable } from "@/components/ui/data-table";
import { Input } from "@/components/ui/input";
import { NewCustomerButton } from "./new-customer-button";
import { ImportCustomersButton } from "./import-customers-button";
import { DuplicatesButton } from "./duplicates-button";
import { SortControl } from "./sort-control";
import { sanitizeSearch } from "@/lib/utils";
import { crmOrderColumn, formatCrmSort, parseCrmSort } from "@/lib/crm-order";
import type { Customer } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function CrmPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; sort?: string }>;
}) {
  const { q, sort } = await searchParams;
  const supabase = await createClient();

  // Andrew: "Sorting ABCD or otherwise." ?sort= drives the query (A→Z by name when absent); the
  // bar next to the search box writes it. Name is the tie-break under any other column so a
  // company's contacts read alphabetically inside their group instead of in insertion order.
  const spec = parseCrmSort(sort);
  const order = crmOrderColumn(spec);
  let query = supabase
    .from("customers")
    .select("*")
    .order(order.column, { ascending: order.ascending, nullsFirst: order.nullsFirst });
  if (order.column !== "name") query = query.order("name", { ascending: true });

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
        <div className="flex flex-wrap items-center gap-2">
          <NewCustomerButton />
          {/* Bulk import (CSV/vCard) — the deliberate, infrequent SEEK door for the whole
              customer book, moved here from Settings > Company (import belongs to Contacts). */}
          <ImportCustomersButton csv label="Import" />
          <DuplicatesButton />
        </div>
      </PageHeader>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <form className="w-full max-w-md">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <Input
              name="q"
              defaultValue={q}
              placeholder="Search customers…"
              className="pl-9"
            />
            {/* A GET submit rebuilds the URL from the form alone — carry the chosen order across
                so searching doesn't silently reset the list to A→Z. */}
            {sort && <input type="hidden" name="sort" value={formatCrmSort(spec)} />}
          </div>
        </form>
        <SortControl />
      </div>

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
          <DataTable<Customer>
            rows={customers}
            rowKey={(c) => c.id}
            rowHref={(c) => `/crm/${c.id}`}
            columns={[
              {
                header: "Name",
                span: 4,
                cell: (c) => (
                  <>
                    <div className="font-medium text-slate-900">{c.name}</div>
                    {c.company_name && <div className="text-xs text-slate-400">{c.company_name}</div>}
                  </>
                ),
              },
              {
                header: "Contact",
                span: 3,
                className: "space-y-0.5 text-sm text-slate-500",
                cell: (c) => (
                  <>
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
                  </>
                ),
              },
              { header: "Type", span: 2, className: "text-sm capitalize text-slate-600", cell: (c) => c.type },
              {
                header: "Location",
                span: 2,
                className: "text-sm text-slate-500",
                cell: (c) => [c.city, c.state].filter(Boolean).join(", ") || "—",
              },
              { header: "Status", span: 1, align: "right", cell: (c) => <Badge tone={statusTone(c.status)}>{c.status}</Badge> },
            ]}
          />
        </Card>
      )}
    </div>
  );
}
