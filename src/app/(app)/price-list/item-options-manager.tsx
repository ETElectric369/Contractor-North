"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Archive, ArchiveRestore, Check, Pencil, Plus, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/toast";
import { formatCurrency } from "@/lib/utils";
import { archiveItemOption, setDefaultItemOption, type OptionResult } from "./actions";
import { ItemOptionModal } from "./item-option-modal";
import { markupSourceTag, optionName, optionView, sortItemOptions, type ItemOption } from "./item-options-math";
import { rowView, type PriceItem } from "./price-list-math";

/**
 * VENDOR OPTIONS UNDER A CODE (0282).
 *
 * Andrew, for Justin Vivian: "increase drop down options for each item code / multiple vendors /
 * multiple items / ie. windows - mfg Andersen - mfg Milgard - mfg Marvin". Erik picked the shape:
 * the options go UNDER the code instead of the code appearing three times, so 830 still means one
 * line on an estimate.
 *
 * WHY THIS IS ITS OWN SURFACE AND NOT A ROW THAT OPENS INSIDE THE MAIN TABLE: the price-list table
 * is another agent's file in this build. Everything here is additive — an item with no options is
 * untouched on the Price List tab and prices exactly as it did yesterday, which is nearly all of
 * Justin's 152 + 131 + 36 rows and always will be.
 *
 * The list he sees is the WORKING SET: the items that actually have options. Searching opens the
 * rest of the book so he can put the first option on a code.
 */
export function ItemOptionsManager({
  items,
  optionsByItem,
  defaultMarkupPct = 0,
}: {
  /** Active (non-archived) price-list items. */
  items: PriceItem[];
  /** itemId → its options, archived ones included (they stay findable, they never evaporate). */
  optionsByItem: Record<string, ItemOption[]>;
  defaultMarkupPct?: number;
}) {
  const router = useRouter();
  const toast = useToast();
  const [, startRefresh] = useTransition();
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [showArchived, setShowArchived] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState<PriceItem | null>(null);
  const [editing, setEditing] = useState<{ item: PriceItem; option: ItemOption } | null>(null);

  const needle = q.trim().toLowerCase();

  const withOptions = useMemo(
    () => items.filter((i) => (optionsByItem[i.id]?.length ?? 0) > 0),
    [items, optionsByItem],
  );

  const { shown, hits } = useMemo(() => {
    if (!needle) return { shown: withOptions, hits: withOptions.length };
    const matched = items.filter((i) =>
      [i.code, i.description, i.category, i.supplier].some((v) => String(v ?? "").toLowerCase().includes(needle)),
    );
    // The ones that already carry options float to the top: when he searches "window" he means
    // the code he has been working on, not the first alphabetical match.
    const ranked = [...matched].sort(
      (a, b) => Number((optionsByItem[b.id]?.length ?? 0) > 0) - Number((optionsByItem[a.id]?.length ?? 0) > 0),
    );
    return { shown: ranked.slice(0, 25), hits: ranked.length };
  }, [needle, items, withOptions, optionsByItem]);

  /* ── writes ─────────────────────────────────────────────────────────────────────────────── */

  function mark(key: string, on: boolean) {
    setBusy((s) => {
      const n = new Set(s);
      if (on) n.add(key);
      else n.delete(key);
      return n;
    });
  }

  /** Every option write reports: the refusal sentence on failure, the result plus whatever the
   *  action had to say out loud (`note`) on success. Nothing here ever finishes quietly. */
  async function run(
    key: string,
    fn: () => Promise<OptionResult>,
    okMsg: string,
    undo?: { label: string; onClick: () => void },
  ) {
    mark(key, true);
    const res = await fn();
    mark(key, false);
    if (!res.ok) return toast(res.error ?? "Couldn't save that.", "error");
    toast(res.note ? `${okMsg} · ${res.note}` : okMsg, "success", undo);
    startRefresh(() => router.refresh());
  }

  function pickDefault(item: PriceItem, optionId: string | null, previousId: string | null) {
    const key = optionId ?? item.id;
    void run(key, () => setDefaultItemOption({ itemId: item.id, optionId }), "Saved", {
      label: "Undo",
      onClick: () =>
        void run(key, () => setDefaultItemOption({ itemId: item.id, optionId: previousId }), "Undone"),
    });
  }

  function setOptionArchived(o: ItemOption, archived: boolean) {
    void run(o.id, () => archiveItemOption(o.id, archived), archived ? "Archived" : "Restored", {
      label: "Undo",
      onClick: () => void run(o.id, () => archiveItemOption(o.id, !archived), "Undone"),
    });
  }

  /* ── render ─────────────────────────────────────────────────────────────────────────────── */

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative sm:w-96">
          <Search className="absolute left-3 top-3 h-4 w-4 text-slate-400" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Find an item by code or description…"
            className="pl-9"
            aria-label="Find an item"
          />
        </div>
        <p className="text-xs text-slate-500 sm:ml-1">
          {needle
            ? `${hits} item${hits === 1 ? "" : "s"} match${hits === 1 ? "es" : ""}${hits > 25 ? ", showing the first 25" : ""}`
            : `${withOptions.length} item${withOptions.length === 1 ? "" : "s"} with options. Search to add one to any other.`}
        </p>
      </div>

      {shown.length === 0 && (
        <Card className="px-5 py-10 text-center">
          {needle ? (
            <p className="text-sm text-slate-500">
              Nothing matches that. Try the code on its own, or a word from the description.
            </p>
          ) : (
            <>
              <p className="text-sm text-slate-600">Nothing in your price list has vendor options yet.</p>
              <p className="mx-auto mt-1 max-w-md text-sm text-slate-500">
                Search above for the code you want and add them on it. Justin&rsquo;s 830 Windows, for example, can carry
                Andersen, Milgard and Marvin without ever becoming three rows.
              </p>
            </>
          )}
        </Card>
      )}

      {shown.map((item) => {
        const all = optionsByItem[item.id] ?? [];
        const active = sortItemOptions(all.filter((o) => !o.archived));
        const archived = all.filter((o) => o.archived);
        const chosen = active.find((o) => o.is_default) ?? null;
        const iv = rowView(item, defaultMarkupPct);
        const archivedOpen = showArchived.has(item.id);

        return (
          <Card key={item.id} className="overflow-hidden">
            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 px-4 py-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-baseline gap-2">
                  {item.code && <span className="font-mono text-xs text-slate-500">{item.code}</span>}
                  <span className="font-medium text-slate-900">{item.description}</span>
                </div>
                <p className="mt-0.5 text-xs text-slate-500">
                  {active.length === 0
                    ? "No options yet"
                    : `${active.length} option${active.length === 1 ? "" : "s"}`}
                  {chosen ? ` · pricing at ${optionName(chosen)}` : " · pricing at its own number"}
                </p>
              </div>
              <Button size="md" variant={active.length ? "outline" : "primary"} onClick={() => setAdding(item)}>
                <Plus className="h-4 w-4" /> Add An Option
              </Button>
            </div>

            <ul className="divide-y divide-slate-100">
              {/* THE ALLOWANCE, ALWAYS FIRST. The item's own price is what 830 has always meant and
                  it is the default until somebody picks a maker — so it is a row here, not a
                  footnote, and it can be picked back. */}
              <li className={`px-4 py-3 ${!chosen ? "bg-brand-light/30" : ""}`}>
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-slate-800">The Item&rsquo;s Own Price</span>
                    {!chosen && <DefaultBadge />}
                  </span>
                  <span className="font-semibold text-slate-900">
                    {formatCurrency(iv.sell)}
                    <span className="ml-1 text-xs font-normal text-slate-500">per {item.unit || "ea"}</span>
                  </span>
                </div>
                <p className="mt-0.5 text-xs text-slate-500">
                  Cost {formatCurrency(iv.cost)} · {iv.pct}% markup
                  {iv.usesDefault ? " (your default)" : ""}
                </p>
                {chosen && (
                  <div className="mt-2">
                    <Button
                      size="md"
                      variant="ghost"
                      className="px-3"
                      disabled={busy.has(item.id)}
                      onClick={() => pickDefault(item, null, chosen.id)}
                    >
                      <Check className="h-4 w-4" /> Use The Item&rsquo;s Price
                    </Button>
                  </div>
                )}
              </li>

              {active.map((o) => {
                const v = optionView(o, item, defaultMarkupPct);
                const working = busy.has(o.id);
                return (
                  <li key={o.id} className={`px-4 py-3 ${o.is_default ? "bg-brand-light/30" : ""}`}>
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-slate-900">{v.name}</span>
                        {o.is_default && <DefaultBadge />}
                      </span>
                      <span className="font-semibold text-slate-900">
                        {formatCurrency(v.sell)}
                        <span className="ml-1 text-xs font-normal text-slate-500">per {v.unit}</span>
                      </span>
                    </div>
                    <p className="mt-0.5 text-xs text-slate-500">
                      {o.part_number && <span className="font-mono">{o.part_number} · </span>}
                      Cost {formatCurrency(v.cost)} · {v.pct}% markup ({markupSourceTag(v.source)})
                    </p>
                    <div className="mt-2 flex flex-wrap items-center gap-1">
                      {!o.is_default && (
                        <Button
                          size="md"
                          variant="ghost"
                          className="px-3"
                          disabled={working}
                          onClick={() => pickDefault(item, o.id, chosen?.id ?? null)}
                        >
                          <Check className="h-4 w-4" /> Use This One
                        </Button>
                      )}
                      <Button
                        size="md"
                        variant="ghost"
                        className="px-3"
                        disabled={working}
                        onClick={() => setEditing({ item, option: o })}
                      >
                        <Pencil className="h-4 w-4" /> Edit
                      </Button>
                      <Button
                        size="md"
                        variant="ghost"
                        className="px-3"
                        disabled={working}
                        onClick={() => setOptionArchived(o, true)}
                      >
                        <Archive className="h-4 w-4" /> Archive
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>

            {/* ARCHIVED IS NOT GONE. A price that went on a quote last month has to stay
                findable, and anything put away has to have a way back. */}
            {archived.length > 0 && (
              <div className="border-t border-slate-100 bg-slate-50/60 px-4 py-2">
                <button
                  onClick={() =>
                    setShowArchived((s) => {
                      const n = new Set(s);
                      if (n.has(item.id)) n.delete(item.id);
                      else n.add(item.id);
                      return n;
                    })
                  }
                  className="min-h-11 text-xs font-medium text-slate-500 hover:text-slate-800"
                >
                  {archivedOpen ? "Hide" : "Show"} Archived ({archived.length})
                </button>
                {archivedOpen && (
                  <ul className="space-y-1 pb-2">
                    {sortItemOptions(archived).map((o) => {
                      const v = optionView(o, item, defaultMarkupPct);
                      return (
                        <li key={o.id} className="flex flex-wrap items-center justify-between gap-2">
                          <span className="text-sm text-slate-500">
                            {v.name} · {formatCurrency(v.sell)} per {v.unit}
                          </span>
                          <Button
                            size="md"
                            variant="ghost"
                            className="px-3"
                            disabled={busy.has(o.id)}
                            onClick={() => setOptionArchived(o, false)}
                          >
                            <ArchiveRestore className="h-4 w-4" /> Restore
                          </Button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            )}
          </Card>
        );
      })}

      {adding && (
        <ItemOptionModal
          open
          onClose={() => setAdding(null)}
          item={adding}
          optionCount={(optionsByItem[adding.id] ?? []).length}
          defaultMarkupPct={defaultMarkupPct}
          onSaved={(res, what) => {
            toast(res.note ? `Added ${what} · ${res.note}` : `Added ${what}`, "success");
            startRefresh(() => router.refresh());
          }}
        />
      )}
      {editing && (
        <ItemOptionModal
          open
          onClose={() => setEditing(null)}
          item={editing.item}
          option={editing.option}
          optionCount={(optionsByItem[editing.item.id] ?? []).length}
          defaultMarkupPct={defaultMarkupPct}
          onSaved={(res) => {
            toast(res.note ? `Saved · ${res.note}` : "Saved", "success");
            startRefresh(() => router.refresh());
          }}
        />
      )}
    </div>
  );
}

/** The one marker on the page that says "this is what the item prices at right now". */
function DefaultBadge() {
  return (
    <span className="rounded-full bg-brand px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white">
      Default
    </span>
  );
}
