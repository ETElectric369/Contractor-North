import * as React from "react";
import Link from "next/link";

// col-span-N must exist as WHOLE literal strings or Tailwind's scanner purges them —
// a computed `col-span-${n}` would vanish from the build. This map keeps all 12 present.
const SPAN: Record<number, string> = {
  1: "col-span-1", 2: "col-span-2", 3: "col-span-3", 4: "col-span-4",
  5: "col-span-5", 6: "col-span-6", 7: "col-span-7", 8: "col-span-8",
  9: "col-span-9", 10: "col-span-10", 11: "col-span-11", 12: "col-span-12",
};

export type Column<T> = {
  /** Header label — shown in the desktop header row, hidden on the mobile stack. */
  header: React.ReactNode;
  /** Desktop grid width, 1..12 (the total across all columns should be 12). */
  span: number;
  /** Right-align the header + cell (money, badges). */
  align?: "right";
  /** Extra cell classes, e.g. "font-mono text-xs" or a colour. */
  className?: string;
  /** The cell body for one row — arbitrary content (nested links, badges, an edit button). */
  cell: (row: T) => React.ReactNode;
};

/**
 * THE list-page table: a desktop 12-column grid with an uppercase header strip that
 * collapses to a stacked card on mobile — the idiom ~9 index pages (crm, payments,
 * permits, work-orders, tax-report…) each hand-rolled. RowList is the single-line
 * cousin; reach for this when a page needs real COLUMNS. Wrap it in a
 * <Card className="overflow-hidden">.
 *
 * - rowHref → return a URL to make the whole row a tap-through Link; return null for a
 *   plain row (rows that carry their OWN inner links or an edit button, so the row itself
 *   isn't a single navigation target).
 * - mobileCols → how many columns the stack uses on a phone (1 = full stack, 2 = pairs).
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  rowHref,
  mobileCols = 1,
  empty,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => React.Key;
  rowHref?: (row: T) => string | null;
  mobileCols?: 1 | 2;
  empty?: React.ReactNode;
}) {
  if (!rows.length) return <>{empty ?? null}</>;
  const mobileGrid = mobileCols === 2 ? "grid-cols-2" : "grid-cols-1";
  const rowGrid = `grid ${mobileGrid} gap-2 px-5 py-3 md:grid-cols-12 md:items-center md:gap-4`;

  const cellsFor = (row: T) =>
    columns.map((c, i) => (
      <div
        key={i}
        className={`${SPAN[c.span]}${c.align === "right" ? " text-right" : ""}${c.className ? ` ${c.className}` : ""}`}
      >
        {c.cell(row)}
      </div>
    ));

  return (
    <>
      <div className="hidden grid-cols-12 gap-4 border-b border-slate-100 bg-slate-50 px-5 py-3 text-xs font-semibold uppercase tracking-wide text-slate-400 md:grid">
        {columns.map((c, i) => (
          <div key={i} className={`${SPAN[c.span]}${c.align === "right" ? " text-right" : ""}`}>
            {c.header}
          </div>
        ))}
      </div>
      <ul className="divide-y divide-slate-100">
        {rows.map((row) => {
          const href = rowHref?.(row) ?? null;
          return (
            <li key={rowKey(row)} className={href ? undefined : rowGrid}>
              {href ? (
                <Link href={href} className={`${rowGrid} hover:bg-slate-50`}>
                  {cellsFor(row)}
                </Link>
              ) : (
                cellsFor(row)
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}
