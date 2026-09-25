/**
 * WHAT A REFRESH MAY TAKE OFF AN INVOICE, AND HOW IT SAYS SO (INV-078, 2026-09-24).
 *
 * The pure half of upsertImportedItems' two promises:
 *   1. A line that is ON the invoice is never dropped because its key also sits in the invoice's
 *      tombstones (dismissed_import_keys). The tombstone is stale - the line being there is the
 *      office's answer - so it is cleared before the importer reconciles.
 *   2. Whatever the importer does remove (its source is gone: a bill deleted, a receipt line marked
 *      not billable, an entry moved to another job) is named, line by line, with its amount.
 */
import { formatCurrency } from "./utils";

type Line = { id: string; import_key: string | null; description: string | null; line_total: number | string | null };

/** Tombstoned keys that name a line still on the invoice. */
export function staleTombstones(present: readonly Pick<Line, "import_key">[], dismissed: readonly string[]): string[] {
  const onInvoice = new Set(present.map((l) => String(l.import_key ?? "")).filter(Boolean));
  return [...new Set(dismissed.map(String))].filter((k) => onInvoice.has(k));
}

/**
 * A text[] as a Postgres array literal - `{"bill:1","labor:p-1:2"}` - for guarding a write on the
 * exact value it read (`.filter(col, "eq", literal)`). Every element quoted, `"` and `\` escaped,
 * so no key can break out of the literal.
 */
export function textArrayLiteral(values: readonly string[]): string {
  return `{${values.map((v) => `"${String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`).join(",")}}`;
}

/** The lines that were on the invoice before the importer ran and are not after it. */
export function removedLines(before: readonly Line[], after: readonly Pick<Line, "id">[]): { importKey: string; description: string; amount: number }[] {
  const still = new Set(after.map((l) => String(l.id)));
  return before
    .filter((l) => l.import_key && !still.has(String(l.id)))
    .map((l) => ({ importKey: String(l.import_key), description: String(l.description ?? "").trim() || "a line", amount: Math.round(Number(l.line_total ?? 0) * 100) / 100 }));
}

/** "Removed 1 line the job no longer bills: 14-2 NM W/G 100 FT ($186.48)". Empty when nothing was. */
export function removedSentence(removed: readonly { description: string; amount: number }[]): string {
  if (!removed.length) return "";
  const n = removed.length;
  const list = removed.map((r) => `${r.description} (${formatCurrency(r.amount)})`).join(", ");
  return `Removed ${n} ${n === 1 ? "line" : "lines"} the job no longer bills: ${list}`;
}
