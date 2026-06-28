"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2, Check, PackageCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Badge, statusTone } from "@/components/ui/badge";
import { formatCurrency } from "@/lib/utils";
import type { PurchaseOrder, PurchaseOrderItem } from "@/lib/types";
import { addPoItem, deletePoItem, setPoStatus, receiveItem } from "../actions";

interface PriceItemLite { id: string; code: string | null; description: string; unit: string; buy_price: number; }

export function PoDetail({
  po,
  items,
  priceItems = [],
}: {
  po: PurchaseOrder;
  items: PurchaseOrderItem[];
  priceItems?: PriceItemLite[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();

  const [desc, setDesc] = useState("");
  const [part, setPart] = useState("");
  const [qty, setQty] = useState(1);
  const [unit, setUnit] = useState("ea");
  const [cost, setCost] = useState(0);
  const [plQuery, setPlQuery] = useState("");
  const [plOpen, setPlOpen] = useState(false);

  const plMatches = plQuery.trim()
    ? priceItems.filter((p) => [p.code, p.description].some((v) => (v ?? "").toLowerCase().includes(plQuery.trim().toLowerCase()))).slice(0, 6)
    : [];
  function addFromPrice(p: PriceItemLite) {
    start(async () => {
      await addPoItem(po.id, {
        description: p.description,
        part_number: p.code || null,
        quantity: 1,
        unit: p.unit || "ea",
        unit_cost: Number(p.buy_price) || 0,
      });
      setPlQuery("");
      setPlOpen(false);
      refresh();
    });
  }

  const canReceive = po.status === "sent" || po.status === "partial";

  function refresh() {
    router.refresh();
  }

  function add() {
    if (!desc.trim()) return;
    start(async () => {
      await addPoItem(po.id, {
        description: desc,
        part_number: part || null,
        quantity: qty || 1,
        unit: unit || "ea",
        unit_cost: cost || 0,
      });
      setDesc("");
      setPart("");
      setQty(1);
      setUnit("ea");
      setCost(0);
      refresh();
    });
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm text-slate-500">Status</span>
        <Select
          value={po.status}
          className="w-40"
          disabled={pending}
          onChange={(e) =>
            start(async () => {
              await setPoStatus(po.id, e.target.value);
              refresh();
            })
          }
        >
          <option value="draft">Draft</option>
          <option value="sent">Sent / Ordered</option>
          <option value="partial">Partial</option>
          <option value="received">Received</option>
          <option value="cancelled">Cancelled</option>
        </Select>
        {canReceive && (
          <span className="text-xs text-slate-400">
            Use “Receive” on each line as material arrives.
          </span>
        )}
      </div>

      {priceItems.length > 0 && (
        <div className="relative">
          <Input
            placeholder="Add from Price List — search CED parts…"
            value={plQuery}
            onChange={(e) => { setPlQuery(e.target.value); setPlOpen(true); }}
            onFocus={() => setPlOpen(true)}
            onBlur={() => setTimeout(() => setPlOpen(false), 150)}
          />
          {plOpen && plMatches.length > 0 && (
            <ul className="absolute z-20 mt-1 max-h-60 w-full overflow-auto rounded-lg border border-slate-200 bg-white py-1 shadow-lg">
              {plMatches.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => addFromPrice(p)}
                    className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-slate-50"
                  >
                    <span className="min-w-0 truncate">
                      {p.code && <span className="mr-1 font-mono text-xs text-slate-400">{p.code}</span>}
                      {p.description}
                    </span>
                    <span className="shrink-0 text-slate-600">{formatCurrency(p.buy_price)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="rounded-xl border border-slate-200 bg-white">
        <ul className="divide-y divide-slate-100">
          {items.map((it) => (
            <PoLine
              key={it.id}
              it={it}
              poId={po.id}
              canReceive={canReceive}
              pending={pending}
              start={start}
              refresh={refresh}
            />
          ))}
          {items.length === 0 && (
            <li className="px-4 py-6 text-center text-slate-400">No items yet — add one below.</li>
          )}
        </ul>
        {/* Add item */}
        <div className="space-y-2 border-t border-slate-100 bg-slate-50/60 p-3">
          <div className="flex gap-2">
            <Input placeholder="Add an item…" value={desc} onChange={(e) => setDesc(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} className="flex-1" />
            <Input placeholder="Part #" value={part} onChange={(e) => setPart(e.target.value)} className="w-24 shrink-0" />
          </div>
          <div className="flex items-center gap-2">
            <NumberInput value={qty} onValueChange={setQty} className="w-20 text-center" placeholder="Qty" />
            <span className="text-slate-400">×</span>
            <NumberInput value={cost} onValueChange={setCost} className="flex-1 text-right" placeholder="Unit cost" />
            <Button onClick={add} disabled={pending || !desc.trim()}>
              <Plus className="h-4 w-4" /> Add
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function PoLine({
  it,
  poId,
  canReceive,
  pending,
  start,
  refresh,
}: {
  it: PurchaseOrderItem;
  poId: string;
  canReceive: boolean;
  pending: boolean;
  start: (cb: () => void) => void;
  refresh: () => void;
}) {
  const remaining = Math.max(0, Number(it.quantity) - Number(it.received_qty));
  const fully = Number(it.received_qty) >= Number(it.quantity);
  const [recv, setRecv] = useState(remaining);

  function receive() {
    const entered = Math.min(Math.max(0, recv), remaining);
    if (entered <= 0) return;
    start(async () => {
      const res = await receiveItem(it.id, poId, Number(it.received_qty) + entered);
      if (res?.error) { alert(res.error); return; }
      refresh();
    });
  }

  return (
    <li className="flex items-center gap-3 px-4 py-3 text-sm">
      <div className="min-w-0 flex-1">
        <div className="font-medium text-slate-800">{it.description}</div>
        <div className="text-xs text-slate-400">
          {it.part_number ? `#${it.part_number} · ` : ""}
          {it.quantity} {it.unit} × {formatCurrency(it.unit_cost)}
          {!fully && Number(it.received_qty) > 0 ? ` · ${it.received_qty} received` : ""}
        </div>
      </div>
      {fully ? (
        <Badge tone="green" className="shrink-0 gap-1">
          <Check className="h-3 w-3" /> {it.received_qty}
        </Badge>
      ) : canReceive ? (
        <div className="flex shrink-0 items-center gap-1">
          <NumberInput
            value={recv}
            onValueChange={setRecv}
            min={0}
            max={remaining}
            className="w-16 text-center"
            aria-label="Quantity to receive"
          />
          <button
            onClick={receive}
            disabled={pending || recv <= 0}
            className="inline-flex items-center gap-1 rounded-md bg-brand-light px-2 py-1 text-xs font-medium text-brand hover:bg-brand-light/70 disabled:opacity-50"
          >
            <PackageCheck className="h-3.5 w-3.5" /> Receive
          </button>
        </div>
      ) : null}
      <div className="shrink-0 font-medium text-slate-900">{formatCurrency(it.line_total)}</div>
      <button
        onClick={() => {
          if (!confirm("Remove this line?")) return;
          start(async () => {
            const res = await deletePoItem(it.id, poId);
            if (res?.error) { alert(res.error); return; }
            refresh();
          });
        }}
        disabled={pending}
        className="shrink-0 text-slate-400 hover:text-red-600"
        aria-label="Remove"
      >
        <Trash2 className="h-4 w-4" />
      </button>
    </li>
  );
}
