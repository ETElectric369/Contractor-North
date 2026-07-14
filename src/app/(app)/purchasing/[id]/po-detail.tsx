"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2, Check, PackageCheck, Pencil, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal, ModalActions } from "@/components/ui/modal";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Badge } from "@/components/ui/badge";
import { formatCurrency } from "@/lib/utils";
import type { PurchaseOrder, PurchaseOrderItem } from "@/lib/types";
import {
  addPoItem,
  updatePoItem,
  deletePoItem,
  updatePurchaseOrder,
  setPoStatus,
  receiveItem,
} from "../actions";
import { jobLabel } from "@/lib/schedule-options";

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
  const [poDesc, setPoDesc] = useState((po as any).description ?? "");

  function savePoDesc() {
    if (poDesc === ((po as any).description ?? "")) return;
    start(async () => {
      await updatePurchaseOrder(po.id, { description: poDesc });
      refresh();
    });
  }

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

      <div>
        <Label htmlFor="po-desc">Description <span className="font-normal text-slate-400">(shows above the items)</span></Label>
        <Textarea
          id="po-desc"
          rows={2}
          value={poDesc}
          onChange={(e) => setPoDesc(e.target.value)}
          onBlur={savePoDesc}
          placeholder="What this order is for…"
        />
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

  // Inline edit state — mirrors the add-item controls.
  const [editing, setEditing] = useState(false);
  const [eDesc, setEDesc] = useState(it.description ?? "");
  const [ePart, setEPart] = useState(it.part_number ?? "");
  const [eQty, setEQty] = useState(Number(it.quantity) || 1);
  const [eUnit, setEUnit] = useState(it.unit ?? "ea");
  const [eCost, setECost] = useState(Number(it.unit_cost) || 0);

  function startEdit() {
    setEDesc(it.description ?? "");
    setEPart(it.part_number ?? "");
    setEQty(Number(it.quantity) || 1);
    setEUnit(it.unit ?? "ea");
    setECost(Number(it.unit_cost) || 0);
    setEditing(true);
  }

  function saveEdit() {
    if (!eDesc.trim()) return;
    start(async () => {
      const res = await updatePoItem(it.id, poId, {
        description: eDesc,
        part_number: ePart || null,
        quantity: eQty || 1,
        unit: eUnit || "ea",
        unit_cost: eCost || 0,
      });
      if (res?.error) { alert(res.error); return; }
      setEditing(false);
      refresh();
    });
  }

  function receive() {
    const entered = Math.min(Math.max(0, recv), remaining);
    if (entered <= 0) return;
    start(async () => {
      const res = await receiveItem(it.id, poId, Number(it.received_qty) + entered);
      if (res?.error) { alert(res.error); return; }
      refresh();
    });
  }

  if (editing) {
    return (
      <li className="space-y-2 bg-slate-50/60 px-4 py-3 text-sm">
        <div className="flex gap-2">
          <Input
            placeholder="Description…"
            value={eDesc}
            onChange={(e) => setEDesc(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && saveEdit()}
            className="flex-1"
          />
          <Input placeholder="Part #" value={ePart} onChange={(e) => setEPart(e.target.value)} className="w-24 shrink-0" />
        </div>
        <div className="flex items-center gap-2">
          <NumberInput value={eQty} onValueChange={setEQty} className="w-20 text-center" placeholder="Qty" />
          <Input value={eUnit} onChange={(e) => setEUnit(e.target.value)} className="w-16 text-center" placeholder="Unit" aria-label="Unit" />
          <span className="text-slate-400">×</span>
          <NumberInput value={eCost} onValueChange={setECost} className="flex-1 text-right" placeholder="Unit cost" />
          <Button onClick={saveEdit} disabled={pending || !eDesc.trim()}>
            <Check className="h-4 w-4" /> Save
          </Button>
          <button
            type="button"
            onClick={() => setEditing(false)}
            disabled={pending}
            className="shrink-0 text-slate-400 hover:text-slate-700"
            aria-label="Cancel edit"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        {Number(it.received_qty) > 0 && (
          <p className="text-xs text-slate-400">{it.received_qty} already received — receiving history is kept.</p>
        )}
      </li>
    );
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
            className="inline-flex items-center gap-1.5 rounded-md bg-brand-light px-2 py-1 text-xs font-medium text-brand hover:bg-brand-light/70 disabled:opacity-50"
          >
            <PackageCheck className="h-4 w-4 shrink-0" /> Receive
          </button>
        </div>
      ) : null}
      <div className="shrink-0 font-medium text-slate-900">{formatCurrency(it.line_total)}</div>
      <button
        onClick={startEdit}
        disabled={pending}
        className="shrink-0 text-slate-400 hover:text-brand"
        aria-label="Edit line"
      >
        <Pencil className="h-4 w-4" />
      </button>
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

/** Edit a PO's header (vendor + linked job) — reuses the new-PO vendor Input + job Select. */
export function EditPoButton({
  poId,
  vendor: initialVendor,
  jobId: initialJobId,
  jobs,
}: {
  poId: string;
  vendor: string;
  jobId: string | null;
  jobs: { id: string; job_number: string; name: string }[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [vendor, setVendor] = useState(initialVendor ?? "");
  const [jobId, setJobId] = useState(initialJobId ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function openModal() {
    setVendor(initialVendor ?? "");
    setJobId(initialJobId ?? "");
    setError(null);
    setOpen(true);
  }

  function onSave() {
    setError(null);
    start(async () => {
      const res = await updatePurchaseOrder(poId, {
        vendor,
        job_id: jobId || null,
      });
      if (!res.ok) {
        setError(res.error ?? "Could not update PO.");
        return;
      }
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <>
      <Button variant="secondary" size="sm" onClick={openModal}>
        <Pencil className="h-4 w-4" /> Edit PO
      </Button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Edit purchase order"
        footer={
          <ModalActions
            onCancel={() => setOpen(false)}
            onSave={onSave}
            saving={pending}
            saveLabel="Save changes"
          />
        }
      >
        <div className="space-y-4">
          {error && (
            <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="edit-po-vendor">Vendor</Label>
              <Input id="edit-po-vendor" value={vendor} onChange={(e) => setVendor(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="edit-po-job">Job (optional)</Label>
              <Select id="edit-po-job" value={jobId} onChange={(e) => setJobId(e.target.value)}>
                <option value="">— None —</option>
                {jobs.map((j) => (
                  <option key={j.id} value={j.id}>
                    {jobLabel(j)}
                  </option>
                ))}
              </Select>
            </div>
          </div>
        </div>
      </Modal>
    </>
  );
}
