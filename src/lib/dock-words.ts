import { dict, type Lang } from "@/lib/i18n";

/**
 * THE DOCK'S WORDS IN THE PERSON'S LANGUAGE (cn-v1138; the office's rows too since cn-v1139).
 * lib/dock.ts keeps its English `label` data — the office reads it, the title-case test judges it,
 * and every dock test pins it — and the catalog (lib/words/shell.ts) holds a key per tile and row
 * as sh_dock_<row id> (a tile by its key: sh_dock_today). Every renderer that draws a row or a tile
 * (the rail, the phone bar, the section strip and sheet, the avatar menu's rows, Search Or Ask)
 * asks here, so the dock's data stays one list and the words stay one catalog.
 *
 * THE VARIANT RULE. A row wearing its whenOff words ("Bills" for "Bills & POs") reads
 * sh_dock_<id>_off; a tile reduced to one row (Sales → Customers) reads sh_dock_<tile>_only. The
 * keys are tried in that order and the first whose ENGLISH equals the label the row is wearing
 * wins, so a swap visibleDock made is never undone and a row handed other words keeps them. A row
 * the catalog has no key for (a test's stand-in) reads its own label.
 */
const VARIANTS = ["", "_off", "_only"] as const;

export function dockLabel(row: { id: string; label: string }, lang: Lang): string {
  const en = dict("en");
  for (const v of VARIANTS) {
    const key = `sh_dock_${row.id}${v}`;
    if (en[key] !== undefined && en[key] === row.label) return dict(lang)[key] ?? row.label;
  }
  return row.label;
}

/** A tile's words: the section's key is its id in the catalog (sh_dock_jobs → Trabajos). */
export function dockTileLabel(section: { key: string; label: string }, lang: Lang): string {
  return dockLabel({ id: section.key, label: section.label }, lang);
}
