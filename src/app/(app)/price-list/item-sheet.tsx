"use client";

import { useState } from "react";
import { AlertTriangle, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { formatCurrency } from "@/lib/utils";
import { AddVendorPrice } from "./add-vendor-price";
import { optionName, optionView, showPct, sortItemOptions, type ItemOption } from "./item-options-math";
import { costLooksLikeCode, rowView, type PriceItem } from "./price-list-math";
import { ArchivedVendorRow, DefaultBadge, VendorPriceRow, useOptionWrites } from "./vendor-price-row";

/**
 * ONE ITEM, OPENED: ITS VENDORS, EACH WITH ITS OWN COST AND SELL.
 *
 * Erik for Justin (Vivian Builders), 2026-09-24: "vendor means what brand with its own cost and
 * sell price". So 830 "Windows (Materials) (Allowance)" opens to Andersen, Milgard and Marvin,
 * each with a Cost and a Sell that edit in place, one marked Default (what an estimate uses when
 * nobody picks), Add Vendor right there, and Archive with Undo.
 *
 * The item's own price stays a row, first: it is what the item quotes at until a vendor is the
 * default, and it can be picked back. An item with no vendors prices exactly as it always did.
 */
export function ItemSheet({
  item,
  options,
  defaultMarkupPct,
  knownVendors,
  onClose,
}: {
  item: PriceItem;
  /** This item's options, archived included (they stay findable). */
  options: ItemOption[];
  defaultMarkupPct: number;
  knownVendors: string[];
  onClose: () => void;
}) {
  const writes = useOptionWrites();
  const [archivedOpen, setArchivedOpen] = useState(false);
  const active = sortItemOptions(options.filter((o) => !o.archived));
  const archived = sortItemOptions(options.filter((o) => o.archived));
  const chosen = active.find((o) => o.is_default) ?? null;
  const own = rowView(item, defaultMarkupPct);
  const looksLikeCode = costLooksLikeCode(item);

  return (
    <Modal open onClose={onClose} title={item.code ? `${item.code} · ${item.description}` : item.description} size="xl">
      <div className="space-y-4">
        <div>
          <h3 className="text-sm font-semibold text-slate-900">Vendors</h3>
          <p className="text-xs text-slate-500">
            A vendor here is the brand or supplier, e.g. Andersen. Each one has its own cost and sell. The default is what an estimate uses
            when nobody picks; the others are there to pick from.
          </p>
        </div>

        <ul className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200">
          {/* THE ITEM'S OWN PRICE, ALWAYS FIRST. What this code has always meant, and the default
              until a vendor is made one. Edited on the Price List row itself. */}
          <li className={`px-4 py-3 ${!chosen ? "bg-brand-light/30" : ""}`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-slate-800">No Vendor: The Item&rsquo;s Own Price</span>
                {!chosen && <DefaultBadge />}
              </span>
              {chosen && (
                <Button
                  size="md"
                  variant="ghost"
                  className="px-3"
                  disabled={writes.busy.has(item.id)}
                  onClick={() => void writes.makeDefault(item.id, null, chosen.id)}
                >
                  <Check className="h-4 w-4" /> Use The Item&rsquo;s Price
                </Button>
              )}
            </div>
            <p className="mt-1 text-sm text-slate-600">
              Cost {formatCurrency(own.cost)} · {showPct(own.pct)}% markup{own.usesDefault ? " (your default)" : ""} · Sell{" "}
              <span className="font-semibold text-slate-900">{formatCurrency(own.sell)}</span>
              <span className="text-xs text-slate-500"> /{item.unit || "ea"}</span>
            </p>
            {looksLikeCode && (
              <p className="mt-1 flex items-start gap-1.5 text-xs text-amber-700">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                This cost is the same as the item number ({item.code}), so it is probably not a real price yet.
              </p>
            )}
          </li>

          {active.map((o) => (
            <VendorPriceRow
              key={o.id}
              item={item}
              option={o}
              defaultMarkupPct={defaultMarkupPct}
              writes={writes}
              currentDefaultId={chosen?.id ?? null}
              showDetails
              heading={<span className="font-medium text-slate-900">{optionName(o)}</span>}
            />
          ))}
        </ul>

        <AddVendorPrice
          item={item}
          knownVendors={knownVendors.filter((n) => !active.some((o) => o.vendor.trim().toLowerCase() === n.trim().toLowerCase() && !o.label))}
          defaultMarkupPct={defaultMarkupPct}
          hasDefault={!!chosen}
          run={writes.run}
        />

        {/* ARCHIVED IS NOT GONE: a price used on a quote last month stays findable, with a way back. */}
        {archived.length > 0 && (
          <div>
            <button
              onClick={() => setArchivedOpen((v) => !v)}
              className="min-h-11 text-xs font-medium text-slate-500 hover:text-slate-800"
            >
              {archivedOpen ? "Hide" : "Show"} Archived Vendors ({archived.length})
            </button>
            {archivedOpen && (
              <ul className="space-y-1">
                {archived.map((o) => {
                  const v = optionView(o, item, defaultMarkupPct);
                  return (
                    <ArchivedVendorRow
                      key={o.id}
                      label={optionName(o)}
                      sell={v.sell}
                      unit={v.unit}
                      busy={writes.busy.has(o.id)}
                      onRestore={() => void writes.setArchived(o, false)}
                    />
                  );
                })}
              </ul>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
