"use client";

import { useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Archive, ArchiveRestore, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/toast";
import { formatCurrency } from "@/lib/utils";
import { UNIT_DATALIST_ID } from "@/lib/pricing/units";
import { callOrLost } from "@/lib/lost-signal";
import {
  archiveItemOption,
  setDefaultItemOption,
  setItemOptionSell,
  updateItemOption,
  type OptionResult,
} from "./actions";
import { markupSourceTag, optionView, showPct, type ItemOption, type OptionFieldsInput } from "./item-options-math";
import { PriceCell } from "./price-cell";
import type { PriceItem } from "./price-list-math";

/**
 * ONE VENDOR ON ONE ITEM: its cost, its markup and its sell, each editable in place, the way the
 * Price List's own cells are (click, type, Enter; every save says "Saved · Undo"). Used by the
 * item's sheet (every vendor on this item) and the vendor's sheet (every item this vendor is on),
 * so the two can never show one price two ways.
 *
 * Sell is never stored. Typing a Cost keeps the markup, so the sell follows. Typing a Sell sets
 * this vendor's own markup (setItemOptionSell). Typing a Markup sets it, and clearing it hands the
 * vendor back to the item's markup, then your default: the same ladder the estimate climbs.
 */

type Undo = { label: string; onClick: () => void };

/** Every option write the two sheets make, reported the same way: the refusal sentence on
 *  failure, the note on success, an Undo that writes back what was there. Nothing silent. */
export function useOptionWrites() {
  const router = useRouter();
  const toast = useToast();
  const [, startRefresh] = useTransition();
  const [busy, setBusy] = useState<Set<string>>(new Set());

  const mark = (key: string, on: boolean) =>
    setBusy((s) => {
      const n = new Set(s);
      if (on) n.add(key);
      else n.delete(key);
      return n;
    });

  async function run(key: string, fn: () => Promise<OptionResult>, okMsg: string, undo?: Undo | ((res: OptionResult) => Undo | undefined)) {
    mark(key, true);
    // A dropped signal REJECTS rather than answering (audit v994 SI2): without this the row stayed
    // busy forever (PriceCell refuses to open) and nothing was said. A lost answer can hide a
    // write that landed, so the list is refreshed to show which.
    const res = await callOrLost(fn);
    mark(key, false);
    if (!res.ok) {
      toast(res.error ?? "Couldn't save that.", "error");
      if ("lost" in res) startRefresh(() => router.refresh());
      return res;
    }
    const u = typeof undo === "function" ? undo(res) : undo;
    toast(res.note ? `${okMsg} · ${res.note}` : okMsg, "success", u);
    startRefresh(() => router.refresh());
    return res;
  }

  const saveField = (o: ItemOption, fields: OptionFieldsInput, back: OptionFieldsInput) =>
    run(o.id, () => updateItemOption({ ...fields, optionId: o.id }), "Saved", {
      label: "Undo",
      onClick: () => void run(o.id, () => updateItemOption({ ...back, optionId: o.id }), "Undone"),
    });

  const markupText = (v: number | null) => (v === null || v === undefined ? "" : String(v));

  return {
    busy,
    run,
    saveCost: (o: ItemOption, raw: string) => saveField(o, { buyPrice: raw }, { buyPrice: String(o.buy_price) }),
    saveMarkup: (o: ItemOption, raw: string) => saveField(o, { markupPct: raw }, { markupPct: markupText(o.markup_pct) }),
    saveText: (o: ItemOption, field: "vendor" | "label" | "partNumber" | "unit", raw: string) => {
      const before = field === "vendor" ? o.vendor : field === "label" ? o.label : field === "partNumber" ? o.part_number : o.unit;
      return saveField(o, { [field]: raw }, { [field]: before ?? "" });
    },
    saveSell: (o: ItemOption, raw: string) =>
      run(o.id, () => setItemOptionSell({ optionId: o.id, sell: raw }), "Saved", (res) => {
        const prev = (res as { previousMarkupPct?: number | null }).previousMarkupPct;
        return {
          label: "Undo",
          onClick: () => void run(o.id, () => updateItemOption({ optionId: o.id, markupPct: markupText(prev ?? null) }), "Undone"),
        };
      }),
    makeDefault: (itemId: string, optionId: string | null, previousId: string | null) =>
      run(optionId ?? itemId, () => setDefaultItemOption({ itemId, optionId }), "Saved", {
        label: "Undo",
        onClick: () => void run(optionId ?? itemId, () => setDefaultItemOption({ itemId, optionId: previousId }), "Undone"),
      }),
    setArchived: (o: ItemOption, archived: boolean) =>
      run(o.id, () => archiveItemOption(o.id, archived), archived ? "Archived" : "Restored", {
        label: "Undo",
        onClick: () => void run(o.id, () => archiveItemOption(o.id, !archived), "Undone"),
      }),
  };
}

export type OptionWrites = ReturnType<typeof useOptionWrites>;

/** The Default marker: the one this item prices at when nobody picks. */
export function DefaultBadge() {
  return (
    <span className="rounded-full bg-brand px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white">Default</span>
  );
}

/**
 * The three numbers, editable. `heading` is what the row is ABOUT: the vendor's name on an
 * item's sheet, the item's name on a vendor's sheet.
 */
export function VendorPriceRow({
  item,
  option,
  defaultMarkupPct,
  writes,
  heading,
  currentDefaultId,
  showDetails = false,
}: {
  item: PriceItem;
  option: ItemOption;
  defaultMarkupPct: number;
  writes: OptionWrites;
  heading: ReactNode;
  /** The option this item prices at right now (null = its own price), for Make Default's Undo. */
  currentDefaultId: string | null;
  /** On the item's sheet: product line, part number and unit, editable in place too. */
  showDetails?: boolean;
}) {
  const v = optionView(option, item, defaultMarkupPct);
  const working = writes.busy.has(option.id);
  const pctStated = option.markup_pct !== null && option.markup_pct !== undefined;

  return (
    <li className={`px-4 py-3 ${option.is_default ? "bg-brand-light/30" : ""}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex min-w-0 flex-wrap items-center gap-2">
          {heading}
          {option.is_default && <DefaultBadge />}
        </span>
        <span className="flex items-center gap-1">
          {!option.is_default && (
            <Button
              size="md"
              variant="ghost"
              className="px-3"
              disabled={working}
              onClick={() => void writes.makeDefault(item.id, option.id, currentDefaultId)}
              title="Estimates use this vendor's price when nobody picks one"
            >
              <Check className="h-4 w-4" /> Make Default
            </Button>
          )}
          <Button size="md" variant="ghost" className="px-3" disabled={working} onClick={() => void writes.setArchived(option, true)}>
            <Archive className="h-4 w-4" /> Archive
          </Button>
        </span>
      </div>

      <div className="mt-2 grid grid-cols-3 gap-2">
        <div>
          <p className="text-[11px] font-medium uppercase tracking-wide text-slate-400">Cost</p>
          <PriceCell
            kind="money"
            align="left"
            value={String(v.cost)}
            display={<span className="text-slate-700">{formatCurrency(v.cost)}</span>}
            onCommit={(raw) => void writes.saveCost(option, raw)}
            saving={working}
            title="What this vendor's one costs you"
          />
        </div>
        <div>
          <p className="text-[11px] font-medium uppercase tracking-wide text-slate-400">Markup</p>
          <PriceCell
            kind="pct"
            align="left"
            // Blank while it falls through, so typing the same number still SETS it on this vendor.
            value={pctStated ? showPct(v.pct) : ""}
            display={
              <span className="text-slate-600">
                {showPct(v.pct)}%
                {v.source !== "option" && (
                  <span className="ml-1 text-[10px] font-normal uppercase tracking-wide text-slate-400">{markupSourceTag(v.source)}</span>
                )}
              </span>
            }
            onCommit={(raw) => void writes.saveMarkup(option, raw)}
            saving={working}
            title={pctStated ? "Markup on this vendor. Clear it to use the item's own." : "Using the item's markup, then your default. Type one to set this vendor's own."}
          />
        </div>
        <div>
          <p className="text-[11px] font-medium uppercase tracking-wide text-slate-400">Sell</p>
          <PriceCell
            kind="money"
            align="left"
            value={v.sell.toFixed(2)}
            display={
              <span className="font-semibold text-slate-900">
                {formatCurrency(v.sell)}
                <span className="ml-1 text-xs font-normal text-slate-500">/{v.unit}</span>
              </span>
            }
            onCommit={(raw) => void writes.saveSell(option, raw)}
            saving={working}
            title="Sell. Typing one sets this vendor's markup."
          />
        </div>
      </div>

      {showDetails && (
        <div className="mt-1 grid grid-cols-3 gap-2 text-xs">
          <div>
            <p className="text-[11px] font-medium uppercase tracking-wide text-slate-400">Product Line</p>
            <PriceCell
              kind="text"
              align="left"
              value={option.label ?? ""}
              display={<span className={option.label ? "text-slate-600" : "text-slate-300"}>{option.label || "None"}</span>}
              onCommit={(raw) => void writes.saveText(option, "label", raw)}
              saving={working}
              title="The line or model, when the brand alone isn't the answer: 400 Series"
            />
          </div>
          <div>
            <p className="text-[11px] font-medium uppercase tracking-wide text-slate-400">Part #</p>
            <PriceCell
              kind="text"
              align="left"
              value={option.part_number ?? ""}
              display={<span className={option.part_number ? "font-mono text-slate-600" : "text-slate-300"}>{option.part_number || "None"}</span>}
              onCommit={(raw) => void writes.saveText(option, "partNumber", raw)}
              saving={working}
              title="Part number"
            />
          </div>
          <div>
            <p className="text-[11px] font-medium uppercase tracking-wide text-slate-400">Unit</p>
            <PriceCell
              kind="text"
              align="left"
              list={UNIT_DATALIST_ID}
              value={option.unit ?? ""}
              display={<span className={option.unit ? "text-slate-600" : "text-slate-400"}>{option.unit || `Same as item (${item.unit || "ea"})`}</span>}
              onCommit={(raw) => void writes.saveText(option, "unit", raw)}
              saving={working}
              title="Blank means the item's own unit"
            />
          </div>
        </div>
      )}
    </li>
  );
}

/** An archived vendor row: name, what it sold at, and the way back. */
export function ArchivedVendorRow({
  label,
  sell,
  unit,
  busy,
  onRestore,
}: {
  label: ReactNode;
  sell: number;
  unit: string;
  busy: boolean;
  onRestore: () => void;
}) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-2">
      <span className="text-sm text-slate-500">
        {label} · {formatCurrency(sell)} per {unit}
      </span>
      <Button size="md" variant="ghost" className="px-3" disabled={busy} onClick={onRestore}>
        <ArchiveRestore className="h-4 w-4" /> Restore
      </Button>
    </li>
  );
}
