import { Mail, Phone } from "lucide-react";
import { Badge, statusTone } from "@/components/ui/badge";
import type { Column } from "@/components/ui/data-table";
import type { Customer } from "@/lib/types";
import type { Lang } from "@/lib/locale";
import { say, type Words } from "@/lib/lang-words";
import { customerStatusLabel } from "@/lib/statuses";

/**
 * THE CUSTOMERS TABLE'S COLUMNS (W2-13). The Type column shows only when this company's customers
 * are not all one type: a list where every row says "residential" is a column of the same word, and
 * the width goes to the name. Either way the columns fill the 12-column grid.
 */
export function customerColumns(showType: boolean, lang: Lang = "en", t?: Words): Column<Customer>[] {
  // The headers in the reader's language (cu_col…); no translator handed in, today's English.
  const h = (key: string, en: string) => say(lang, t, key, en);
  return [
    {
      header: h("cu_colName", "Name"),
      span: showType ? 4 : 6,
      cell: (c) => (
        <>
          <div className="font-medium text-slate-900">{c.name}</div>
          {c.company_name && <div className="text-xs text-slate-400">{c.company_name}</div>}
        </>
      ),
    },
    {
      header: h("cu_colContact", "Contact"),
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
    ...(showType ? [{ header: h("cu_colType", "Type"), span: 2, className: "text-sm capitalize text-slate-600", cell: (c: Customer) => customerTypeWord(c.type, lang, t) }] : []),
    {
      header: h("cu_colLocation", "Location"),
      span: 2,
      className: "text-sm text-slate-500",
      cell: (c) => [c.city, c.state].filter(Boolean).join(", ") || "—",
    },
    { header: h("cu_colStatus", "Status"), span: 1, align: "right", cell: (c) => <Badge tone={statusTone(c.status)}>{customerStatusLabel(c.status, lang, t)}</Badge> },
  ];
}

const CUSTOMER_TYPES = ["residential", "commercial", "industrial", "contractor", "subcontractor"];

/** A customer's type as a word (lowercase, like the raw value the cell and the badge print): the raw
 *  value itself in English, byte for byte; cu_type_… for a Spanish reader whose caller handed its
 *  translator. An unknown type reads as itself. */
export function customerTypeWord(type: string | null | undefined, lang: Lang = "en", t?: Words): string {
  const raw = type ?? "";
  if (!CUSTOMER_TYPES.includes(raw)) return raw;
  return say(lang, t, `cu_type_${raw}`, raw);
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
