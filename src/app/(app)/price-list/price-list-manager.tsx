"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2, Upload, Search, AlertTriangle, Archive, ArchiveRestore, Package } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Card } from "@/components/ui/card";
import { useToast } from "@/components/toast";
import { SortFilterBar, useSortFilter } from "@/components/sort-filter-bar";
import { applyFilters, groupRows, searchRows, sortRows, type FilterChip, type SortOption } from "@/lib/sort-filter";
import { formatCurrency } from "@/lib/utils";
import { UNIT_DATALIST_ID } from "@/lib/pricing/units";
import { unitLooksShifted } from "@/lib/pricing/import-damage";
import { archivePriceItem, createPriceItem, deletePriceItem, updatePriceItem } from "./actions";
import { EditPriceItemButton } from "./edit-price-item-button";
import { ImportCsvModal } from "./import-preview";
import { PriceCell } from "./price-cell";
import { patchForEdit, rowView, undoPatch, type InlineField, type InlinePatch, type PriceItem } from "./price-list-math";

/** A table row: the item plus what the table computes from it. A type alias (not an interface)
 *  so it satisfies sortRows' Record<string, unknown> — the sort key is looked up by name. */
type Row = {
  id: string;
  code: string | null;
  description: string;
  category: string | null;
  supplier: string | null;
  unit: string;
  buy_price: number;
  markup_pct: number;
  updated_at: string | null;
  archived: boolean;
  qty_per_sqft?: number | null;
  qty_per_lf?: number | null;
  qty_min?: number | null;
  qty_round?: string | null;
  cost: number;
  pct: number;
  usesDefault: boolean;
  sell: number;
  margin: number;
  kits: string[];
  /** The group key when grouping by kit — an item in N kits appears under each. */
  kit: string;
};

const SORT_OPTIONS: SortOption[] = [
  { key: "code", label: "Code" },
  { key: "description", label: "Description" },
  { key: "category", label: "Category" },
  { key: "unit", label: "Unit" },
  { key: "cost", label: "Cost", kind: "number" },
  { key: "pct", label: "Markup", kind: "number" },
  { key: "sell", label: "Sell", kind: "number" },
  { key: "supplier", label: "Supplier" },
  { key: "updated_at", label: "Updated", kind: "date" },
];
const GROUP_OPTIONS = [
  { key: "category", label: "Category" },
  { key: "kit", label: "Kit" },
];

/**
 * THE PRICE LIST. Erik + Justin (Vivian Builders): the book must show COST and MARKUP with the
 * SELL ready for estimates, per-item units, and one sort/filter control (Andrew). Cost, MU%,
 * Margin, Sell and Unit edit IN THE CELL — click, type, Enter — and every save says "Saved · Undo"
 * through the toast (the not-annoying rule: no Save button for one number, no silent write).
 *
 * The Sell column and every quote surface now agree: both resolve markup through
 * effectiveMarkupPct (item pct → org default), where before this page used the item's raw pct
 * alone and quoted a different number than the estimate did. The book stores only cost + markup +
 * unit; sell is always derived.
 */
export function PriceListManager({
  items,
  defaultMarkupPct = 0,
  kitsByItem = {},
  sizingAvailable = false,
}: {
  items: PriceItem[];
  /** Settings → default_markup_pct: the last rung of THE markup rule. */
  defaultMarkupPct?: number;
  /** itemId → names of the kits that link to it (0240 price_list_item_id). */
  kitsByItem?: Record<string, string[]>;
  /** True when the 0240 sizing columns came back from the DB — gates the sizing fields. */
  sizingAvailable?: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [, startRefresh] = useTransition();
  // Local copy of the rows so an inline edit shows instantly; re-synced whenever the server hands
  // down fresh items (router.refresh after every write).
  const [local, setLocal] = useState<PriceItem[]>(items);
  useEffect(() => setLocal(items), [items]);
  const [saving, setSaving] = useState<Set<string>>(new Set());
  const [q, setQ] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const { prefs, update } = useSortFilter("price-list", { sort: { key: "description", dir: "asc" }, group: null, chips: [] });

  // add form
  const [code, setCode] = useState("");
  const [desc, setDesc] = useState("");
  const [category, setCategory] = useState("");
  const [unit, setUnit] = useState("ea");
  const [buy, setBuy] = useState(0);
  const [markup, setMarkup] = useState(0);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rows: Row[] = useMemo(
    () =>
      local.map((i) => {
        const v = rowView(i, defaultMarkupPct);
        return {
          ...i,
          updated_at: i.updated_at ?? null,
          archived: Boolean(i.archived),
          cost: v.cost,
          pct: v.pct,
          usesDefault: v.usesDefault,
          sell: v.sell,
          margin: v.margin,
          kits: kitsByItem[i.id] ?? [],
          kit: "",
        };
      }),
    [local, defaultMarkupPct, kitsByItem],
  );

  const active = useMemo(() => rows.filter((r) => !r.archived), [rows]);
  const archivedRows = useMemo(() => rows.filter((r) => r.archived), [rows]);
  // ROWS AN OLD IMPORT SHIFTED — see lib/pricing/import-damage.ts. Same predicate the Settings
  // count uses, so the number he was told and the rows he is shown can never disagree.
  const shifted = useMemo(() => active.filter((r) => unitLooksShifted(r.unit)), [active]);

  const chips: FilterChip<Row>[] = useMemo(
    () => [
      { key: "unpriced", label: "Unpriced", test: (r) => r.cost <= 0 },
      // Item pct 0 AND org default 0 — the row will quote at cost.
      { key: "nomarkup", label: "No Markup", test: (r) => r.pct <= 0 },
      { key: "nocategory", label: "No Category", test: (r) => !r.category },
      { key: "shifted", label: "Shifted", test: (r) => unitLooksShifted(r.unit) },
      { key: "archived", label: "Archived", test: (r) => r.archived },
    ],
    [],
  );
  const activeChips = useMemo(() => new Set(prefs.chips), [prefs.chips]);
  const showArchived = activeChips.has("archived");

  const { groups, shown, base } = useMemo(() => {
    const base = showArchived ? archivedRows : active;
    const searched = searchRows(base, q, ["code", "description", "category", "supplier"]);
    const filtered = applyFilters(searched, chips, activeChips);
    const sorted = sortRows(filtered, prefs.sort, SORT_OPTIONS);
    // Group by kit: an item in N kits appears under each; unlinked items under one heading.
    const expanded =
      prefs.group === "kit" ? sorted.flatMap((r) => (r.kits.length ? r.kits.map((k) => ({ ...r, kit: k })) : [{ ...r, kit: "" }])) : sorted;
    const groups = groupRows(expanded, prefs.group, prefs.group === "kit" ? "Not in a kit" : "No category");
    return { groups, shown: filtered.length, base };
  }, [active, archivedRows, showArchived, q, chips, activeChips, prefs.sort, prefs.group]);

  const chipDefs = chips.map((c) => ({
    key: c.key,
    label: c.label,
    count: c.key === "archived" ? archivedRows.length : active.filter(c.test).length,
  }));

  /* ── writes ─────────────────────────────────────────────────────────────────────────────── */

  function markSaving(id: string, on: boolean) {
    setSaving((s) => {
      const n = new Set(s);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });
  }
  const applyLocal = (id: string, patch: Partial<PriceItem>) =>
    setLocal((prev) => prev.map((i) => (i.id === id ? { ...i, ...patch } : i)));

  /** Write a patch, optimistic, and report — "Saved · Undo" where Undo writes `before` back. */
  async function writePatch(id: string, patch: InlinePatch, before: InlinePatch, message: string, undoable: boolean) {
    markSaving(id, true);
    applyLocal(id, patch);
    const res = await updatePriceItem(id, patch);
    markSaving(id, false);
    if (!res.ok) {
      applyLocal(id, before);
      toast(res.error ?? "Couldn't save.", "error");
      return;
    }
    toast(message, "success", undoable ? { label: "Undo", onClick: () => void writePatch(id, before, patch, "Undone", false) } : undefined);
    startRefresh(() => router.refresh());
  }

  function saveInline(item: PriceItem, field: InlineField, raw: string) {
    const r = patchForEdit(field, raw, item);
    if ("error" in r) return toast(r.error, "error");
    if (Object.keys(r.patch).length === 0) return;
    void writePatch(item.id, r.patch, undoPatch(r.patch, item), "Saved", true);
  }

  async function setArchived(item: PriceItem, archived: boolean, undoable = true) {
    markSaving(item.id, true);
    applyLocal(item.id, { archived });
    const res = await archivePriceItem(item.id, archived);
    markSaving(item.id, false);
    if (!res.ok) {
      applyLocal(item.id, { archived: !archived });
      toast(res.error ?? "Couldn't change that.", "error");
      return;
    }
    toast(
      archived ? "Archived" : "Restored",
      "success",
      undoable ? { label: "Undo", onClick: () => void setArchived(item, !archived, false) } : undefined,
    );
    startRefresh(() => router.refresh());
  }

  async function remove(item: PriceItem & { kits?: string[] }) {
    // A linked kit line survives the delete (FK is ON DELETE SET NULL) but freezes at its snapshot —
    // say so before the click, not after.
    const inKits = item.kits?.length
      ? ` It is in ${item.kits.length} kit${item.kits.length === 1 ? "" : "s"} (${item.kits.slice(0, 3).join(", ")}${item.kits.length > 3 ? "…" : ""}) — those lines will freeze at today's price.`
      : "";
    if (!confirm(`Delete "${item.description}" for good? Archive keeps it findable — delete does not.${inKits}`)) return;
    markSaving(item.id, true);
    const res = await deletePriceItem(item.id);
    markSaving(item.id, false);
    if (!res.ok) return toast(res.error ?? "Couldn't delete.", "error");
    setLocal((prev) => prev.filter((i) => i.id !== item.id));
    toast("Deleted", "success");
    startRefresh(() => router.refresh());
  }

  async function add() {
    setError(null);
    if (!desc.trim()) return setError("Description is required.");
    setAdding(true);
    const res = await createPriceItem({ code, description: desc, category, unit, buy_price: buy, markup_pct: markup });
    setAdding(false);
    if (!res.ok) { setError(res.error ?? "Could not save."); toast(res.error ?? "Could not save.", "error"); return; }
    setCode(""); setDesc(""); setCategory(""); setUnit("ea"); setBuy(0); setMarkup(0);
    toast("Added", "success");
    startRefresh(() => router.refresh());
  }

  /* ── render ─────────────────────────────────────────────────────────────────────────────── */

  const th = "px-3 py-3 text-left";
  const thR = "px-3 py-3 text-right";
  const td = "px-3 py-1.5 align-middle";

  return (
    <div className="space-y-4">
      {/* Add + import */}
      <Card className="p-4">
        {error && <p className="mb-2 text-sm text-red-600">{error}</p>}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-7">
          <div><Label htmlFor="pl-code">Code</Label><Input id="pl-code" value={code} onChange={(e) => setCode(e.target.value)} /></div>
          <div className="col-span-2"><Label htmlFor="pl-desc">Description *</Label><Input id="pl-desc" value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="e.g. how you'd say it at the supply house" onKeyDown={(e) => { if (e.key === "Enter") void add(); }} /></div>
          <div><Label htmlFor="pl-cat">Category</Label><Input id="pl-cat" value={category} onChange={(e) => setCategory(e.target.value)} /></div>
          <div><Label htmlFor="pl-unit">Unit</Label><Input id="pl-unit" value={unit} list={UNIT_DATALIST_ID} onChange={(e) => setUnit(e.target.value)} placeholder="ea" /></div>
          <div><Label htmlFor="pl-buy">Cost $</Label><NumberInput id="pl-buy" value={buy} onValueChange={setBuy} /></div>
          <div><Label htmlFor="pl-mk">Markup %</Label><NumberInput id="pl-mk" value={markup} onValueChange={setMarkup} placeholder={defaultMarkupPct > 0 ? `default ${defaultMarkupPct}` : undefined} /></div>
        </div>
        <div className="mt-3 flex items-center justify-between">
          <Button size="sm" variant="outline" onClick={() => setImportOpen(true)}>
            <Upload className="h-3.5 w-3.5" /> Import CSV
          </Button>
          <Button size="sm" onClick={() => void add()} disabled={adding || !desc.trim()}>
            <Plus className="h-3.5 w-3.5" /> Add Item
          </Button>
        </div>
      </Card>

      {/* THE BOOK TELLING YOU IT IS WRONG. Until cn-v696 the shared CSV parser read an inch mark
          (`4" RND LS`) as an opening quote, swallowed the comma after it, and shifted every
          following column one to the left — so a net price landed in `unit` and something else
          landed in the price. Nothing is repaired automatically: the right value is a PRICE, and a
          guessed price on a customer's estimate is worse than a flagged one. The Unit and Cost
          cells edit inline now, so the fix is two clicks on the row itself. */}
      {shifted.length > 0 && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3">
          <div className="flex items-start gap-2 text-sm text-red-900">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <span className="font-medium">
                {shifted.length} item{shifted.length === 1 ? "" : "s"} came in from a CSV with the columns shifted
              </span>{" "}
              — the price is sitting in the unit field, so {shifted.length === 1 ? "it quotes" : "they quote"} at whatever
              landed in the cost column. Click the unit to set it back (<span className="font-mono text-xs">ea</span>) and
              click the cost to type the real one. Imports parse inch marks correctly now.
              <div className="mt-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => update({ chips: activeChips.has("shifted") ? prefs.chips.filter((c) => c !== "shifted") : [...prefs.chips, "shifted"] })}
                >
                  {activeChips.has("shifted") ? "Show the Whole List" : `Show Just These ${shifted.length}`}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Search + the one sort/filter control */}
      <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
        <div className="relative lg:w-80">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search code, description, category, supplier…" className="pl-9" />
        </div>
        <SortFilterBar sortOptions={SORT_OPTIONS} groupOptions={GROUP_OPTIONS} chips={chipDefs} prefs={prefs} onChange={update} className="lg:flex-1" />
      </div>

      <Card className="overflow-hidden">
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2 text-xs text-slate-500">
          <span>
            {shown} of {base.length} {showArchived ? "archived" : ""} item{base.length === 1 ? "" : "s"}
            {defaultMarkupPct > 0 && (
              <span className="ml-2 text-slate-400">· default markup {defaultMarkupPct}% fills in where an item has none</span>
            )}
          </span>
          <span className="hidden text-slate-400 sm:inline">Click a unit, cost, markup, margin or sell to change it · Enter saves · Esc cancels</span>
        </div>
        {shown === 0 ? (
          <p className="px-4 py-10 text-center text-sm text-slate-400">
            {items.length === 0 ? "No items yet. Add one, or import your CED price list via CSV." : showArchived && archivedRows.length === 0 ? "Nothing archived." : "No matches."}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1080px] text-sm">
              <thead className="bg-slate-50 text-xs font-semibold uppercase tracking-wide text-slate-400">
                <tr>
                  <th className={`${th} w-[9%]`}>Code</th>
                  <th className={`${th} w-[24%]`}>Description</th>
                  <th className={`${th} w-[9%]`}>Category</th>
                  <th className={`${th} w-[7%]`}>Unit</th>
                  <th className={`${thR} w-[8%]`}>Cost</th>
                  <th className={`${thR} w-[8%]`}>MU%</th>
                  <th className={`${thR} w-[7%]`}>Margin</th>
                  <th className={`${thR} w-[8%]`}>Sell</th>
                  <th className={`${th} w-[9%]`}>Supplier</th>
                  <th className={`${th} w-[7%]`}>Kits</th>
                  <th className={`${thR} w-[4%]`}></th>
                </tr>
              </thead>
              {groups.map((g, gi) => (
                <tbody key={`${g.label}-${gi}`} className="divide-y divide-slate-100 border-t border-slate-100">
                  {g.label && (
                    <tr className="bg-slate-50/70">
                      <td colSpan={11} className="px-3 py-1.5 text-xs font-semibold text-slate-600">
                        {prefs.group === "kit" && g.label !== "Not in a kit" && <Package className="mr-1 inline h-3.5 w-3.5 text-slate-400" />}
                        {g.label} <span className="font-normal text-slate-400">· {g.rows.length}</span>
                      </td>
                    </tr>
                  )}
                  {g.rows.map((r) => {
                    const isShifted = unitLooksShifted(r.unit);
                    const busy = saving.has(r.id);
                    return (
                      <tr key={prefs.group === "kit" ? `${r.id}:${r.kit}` : r.id} className={`hover:bg-slate-50/60 ${r.archived ? "text-slate-400" : ""}`}>
                        <td className={`${td} font-mono text-xs text-slate-500`}>{r.code ?? "—"}</td>
                        <td className={`${td} font-medium text-slate-900`}>{r.description}</td>
                        <td className={`${td} text-slate-500`}>{r.category ?? "—"}</td>
                        <td className={td}>
                          <PriceCell
                            kind="text"
                            align="left"
                            list={UNIT_DATALIST_ID}
                            value={r.unit}
                            display={<span className={isShifted ? "font-mono text-xs text-red-700" : "text-slate-600"}>{r.unit}</span>}
                            onCommit={(raw) => saveInline(r, "unit", raw)}
                            saving={busy}
                            disabled={r.archived}
                            title="Unit"
                          />
                        </td>
                        <td className={td}>
                          <PriceCell
                            kind="money"
                            value={r.cost.toFixed(2)}
                            display={<span className={isShifted ? "text-red-700" : "text-slate-700"}>{formatCurrency(r.cost)}</span>}
                            onCommit={(raw) => saveInline(r, "cost", raw)}
                            saving={busy}
                            disabled={r.archived}
                            title="Cost"
                          />
                        </td>
                        <td className={td}>
                          <PriceCell
                            kind="pct"
                            // Blank while the org default fills in, so typing the default's own number
                            // still SETS it on the item (a commit needs the text to differ).
                            value={r.usesDefault ? "" : String(r.pct)}
                            display={
                              <span className="text-slate-600">
                                {r.pct}%
                                {r.usesDefault && <span className="ml-1 text-[10px] font-normal uppercase tracking-wide text-slate-400">default</span>}
                              </span>
                            }
                            onCommit={(raw) => saveInline(r, "markup", raw)}
                            saving={busy}
                            disabled={r.archived}
                            title={r.usesDefault ? "Markup — using the org default; type one to set this item's own" : "Markup %"}
                          />
                        </td>
                        <td className={td}>
                          <PriceCell
                            kind="pct"
                            value={String(r.margin)}
                            display={<span className="text-slate-500">{r.margin}%</span>}
                            onCommit={(raw) => saveInline(r, "margin", raw)}
                            saving={busy}
                            disabled={r.archived}
                            title="Margin % (profit over sell)"
                          />
                        </td>
                        <td className={td}>
                          <PriceCell
                            kind="money"
                            value={r.sell.toFixed(2)}
                            display={<span className="font-medium text-slate-900">{formatCurrency(r.sell)}</span>}
                            onCommit={(raw) => saveInline(r, "sell", raw)}
                            saving={busy}
                            disabled={r.archived}
                            title="Sell — typing one sets the markup"
                          />
                        </td>
                        <td className={`${td} truncate text-slate-500`} title={r.supplier ?? undefined}>{r.supplier ?? "—"}</td>
                        <td className={td}>
                          {r.kits.length === 0 ? (
                            <span className="text-slate-300">—</span>
                          ) : (
                            <span className="flex flex-wrap gap-1">
                              {r.kits.slice(0, 2).map((k) => (
                                <span key={k} className="max-w-[7rem] truncate rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600" title={k}>
                                  {k}
                                </span>
                              ))}
                              {r.kits.length > 2 && (
                                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-500" title={r.kits.slice(2).join(", ")}>
                                  +{r.kits.length - 2}
                                </span>
                              )}
                            </span>
                          )}
                        </td>
                        <td className={`${td} whitespace-nowrap text-right`}>
                          <span className="inline-flex items-center gap-0.5">
                            {r.archived ? (
                              <button
                                onClick={() => void setArchived(r, false)}
                                disabled={busy}
                                className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                                title="Restore"
                              >
                                <ArchiveRestore className="h-4 w-4" />
                              </button>
                            ) : (
                              <>
                                <EditPriceItemButton item={r} sizingAvailable={sizingAvailable} />
                                <button
                                  onClick={() => void setArchived(r, true)}
                                  disabled={busy}
                                  className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                                  title="Archive"
                                >
                                  <Archive className="h-4 w-4" />
                                </button>
                              </>
                            )}
                            <button
                              onClick={() => void remove(r)}
                              disabled={busy}
                              className="rounded-md p-1 text-slate-400 hover:bg-red-50 hover:text-red-600"
                              title="Delete"
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              ))}
            </table>
          </div>
        )}
      </Card>

      <ImportCsvModal open={importOpen} onClose={() => setImportOpen(false)} />
    </div>
  );
}
