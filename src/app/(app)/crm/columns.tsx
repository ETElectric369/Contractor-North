import { Mail, Phone } from "lucide-react";
import { Badge, statusTone } from "@/components/ui/badge";
import type { Column } from "@/components/ui/data-table";
import type { Customer } from "@/lib/types";

/**
 * THE CUSTOMERS TABLE'S COLUMNS (W2-13). The Type column shows only when this company's customers
 * are not all one type: a list where every row says "residential" is a column of the same word, and
 * the width goes to the name. Either way the columns fill the 12-column grid.
 */
export function customerColumns(showType: boolean): Column<Customer>[] {
  return [
    {
      header: "Name",
      span: showType ? 4 : 6,
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
    ...(showType ? [{ header: "Type", span: 2, className: "text-sm capitalize text-slate-600", cell: (c: Customer) => c.type }] : []),
    {
      header: "Location",
      span: 2,
      className: "text-sm text-slate-500",
      cell: (c) => [c.city, c.state].filter(Boolean).join(", ") || "—",
    },
    { header: "Status", span: 1, align: "right", cell: (c) => <Badge tone={statusTone(c.status)}>{c.status}</Badge> },
  ];
}

type TypeRead = { data?: { type?: string | null }[] | null; error?: unknown };

/**
 * Do this company's customers come in more than one type? Two 1-row reads, the first and last type
 * in the enum's own order (min and max): they differ exactly when two or more types are in use. They
 * ignore the search and the sort, so the column doesn't blink while someone types. A read that failed
 * keeps the column, today's table, rather than hide something on a guess.
 */
export function customerTypesDiffer(lo: TypeRead, hi: TypeRead): boolean {
  if (lo.error || hi.error) return true;
  return (lo.data?.[0]?.type ?? null) !== (hi.data?.[0]?.type ?? null);
}
