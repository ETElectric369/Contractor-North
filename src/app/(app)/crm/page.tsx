import { Users, Search } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { PageHeader, EmptyState } from "@/components/page-header";
import { Card } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import { Input } from "@/components/ui/input";
import { NewCustomerButton } from "./new-customer-button";
import { ImportCustomersButton } from "./import-customers-button";
import { DuplicatesButton } from "./duplicates-button";
import { SortControl } from "./sort-control";
import { customerColumns, customerTypesDiffer } from "./columns";
import { sanitizeSearch } from "@/lib/utils";
import { crmOrderColumn, formatCrmSort, parseCrmSort } from "@/lib/crm-order";
import type { Customer } from "@/lib/types";

export const dynamic = "force-dynamic";

/** PostgREST's own max-rows ceiling, stated here so the page can SAY when it hits it. */
const CRM_PAGE_LIMIT = 1000;

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
    // The columns this table renders, not the whole row (PROJECTION LAW, audit v921) — the
    // detail page reads the rest when you open somebody.
    .select("id, name, company_name, email, phone, type, city, state, status")
    // PostgREST stops at 1,000 rows whether or not anyone asks it to. Asking makes the ceiling
    // OURS: the list is A→Z, so the silent cut took the END of the alphabet off Contacts with
    // nothing on screen saying so. Same number of rows as before, plus a line when it's reached.
    .limit(CRM_PAGE_LIMIT)
    .order(order.column, { ascending: order.ascending, nullsFirst: order.nullsFirst });
  if (order.column !== "name") query = query.order("name", { ascending: true });

  const term = sanitizeSearch(q);
  if (term) {
    query = query.or(
      `name.ilike.%${term}%,company_name.ilike.%${term}%,email.ilike.%${term}%,phone.ilike.%${term}%`,
    );
  }

  // THE TYPE COLUMN ONLY WHEN THE TYPES DIFFER (W2-13): the first and last type in the enum's order,
  // one row each, beside the list and ignoring its search and sort (RLS scopes them to the company).
  // min ≠ max exactly when two or more types are in use.
  const typeEnd = (ascending: boolean) => supabase.from("customers").select("type").order("type", { ascending }).limit(1);
  const [{ data }, lo, hi] = await Promise.all([query, typeEnd(true), typeEnd(false)]);
  const customers = (data ?? []) as Customer[];
  const mixed = customerTypesDiffer(lo, hi);

  return (
    <div>
      {/* CUSTOMERS, UNDER SALES (W1-07): the Contacts tile folded into Sales as its Customers row,
          so the page wears the row's name. The description names no Leads tab: that tab is hidden
          with Leads off, and a customer is a customer whichever switches are on. */}
      <PageHeader title="Customers" description="Everyone you work for, linked to their jobs, estimates and invoices.">
        <div className="flex flex-wrap items-center gap-2">
          <NewCustomerButton />
          {/* Bulk import (CSV/vCard) — the deliberate, infrequent SEEK door for the whole
              customer book, moved here from Settings > Company (import belongs to Customers). */}
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

      {customers.length >= CRM_PAGE_LIMIT && (
        // NOTHING SILENT: past this many contacts the list is cut, and the cut end is the end of
        // whatever order you picked. Say so, and name the way through it.
        <p className="mb-3 text-sm text-amber-700">
          Showing the first {CRM_PAGE_LIMIT.toLocaleString()} customers — search to narrow the list.
        </p>
      )}

      {customers.length === 0 ? (
        <EmptyState
          icon={Users}
          title={q ? "No matches" : "No customers yet"}
          description={
            q
              ? "Try a different search."
              : "Add your first customer to get started."
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
            columns={customerColumns(mixed)}
          />
        </Card>
      )}
    </div>
  );
}
