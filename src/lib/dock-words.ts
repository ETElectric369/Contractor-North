import { dict, type Lang } from "@/lib/i18n";

/**
 * THE DOCK'S WORDS IN THE PERSON'S LANGUAGE (cn-v1138). lib/dock.ts keeps its English `label` data —
 * the office reads it, the title-case test judges it, and every dock test pins it — and the catalog
 * (lib/words/shell.ts) holds a key per row a TECH can see as sh_dock_<row id> (a tile by its key:
 * sh_dock_today). Every renderer that draws a row or a tile (the rail, the phone bar, the section
 * strip and sheet, the avatar menu's rows, Search Or Ask) asks here, so the dock's data stays one
 * list and the words stay one catalog.
 *
 * A row the catalog has no key for (the office's rows) reads its own label. A row wearing its
 * whenOff words ("Bills" for "Bills & POs") or a tile reduced to one row (Sales → Customers) keeps
 * them: the catalog's English is compared to the row's label first, so the swap is never undone.
 */
export function dockLabel(row: { id: string; label: string }, lang: Lang): string {
  const key = `sh_dock_${row.id}`;
  const en = dict("en")[key];
  if (en === undefined || en !== row.label) return row.label;
  return dict(lang)[key] ?? row.label;
}

/** A tile's words: the section's key is its id in the catalog (sh_dock_jobs → Trabajos). */
export function dockTileLabel(section: { key: string; label: string }, lang: Lang): string {
  return dockLabel({ id: section.key, label: section.label }, lang);
}
