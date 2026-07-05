"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2, Package, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Card } from "@/components/ui/card";
import { Modal, ModalActions } from "@/components/ui/modal";
import { formatCurrency } from "@/lib/utils";
import { createKit, updateKit, deleteKit, addKitItem, updateKitItem, deleteKitItem } from "./kit-actions";
import { ImportKitsButton } from "./import-kits-button";

interface KitItem { id: string; description: string; quantity: number; unit: string; unit_price: number; }
interface Kit { id: string; name: string; category: string | null; kit_items: KitItem[]; }
interface PriceItem { id: string; code: string | null; description: string; category?: string | null; unit: string; buy_price: number; markup_pct: number; }

const sellPrice = (buy: number, markup: number) => buy * (1 + (markup || 0) / 100);

function AddItemRow({ kitId, priceItems, onDone }: { kitId: string; priceItems: PriceItem[]; onDone: () => void }) {
  const [desc, setDesc] = useState("");
  const [qty, setQty] = useState(1);
  const [unit, setUnit] = useState("ea");
  const [price, setPrice] = useState(0);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();

  const matches = q.trim()
    ? priceItems.filter((p) => [p.code, p.description].some((v) => (v ?? "").toLowerCase().includes(q.trim().toLowerCase()))).slice(0, 6)
    : [];

  function pick(p: PriceItem) {
    setDesc(p.code ? `${p.code} — ${p.description}` : p.description);
    setUnit(p.unit || "ea");
    setPrice(Number(sellPrice(p.buy_price, p.markup_pct).toFixed(2)));
    setQ("");
    setOpen(false);
  }

  function save() {
    if (!desc.trim()) return;
    start(async () => {
      await addKitItem({ kit_id: kitId, description: desc, quantity: qty, unit, unit_price: price });
      setDesc(""); setQty(1); setUnit("ea"); setPrice(0);
      onDone();
    });
  }

  return (
    <div className="space-y-2 border-t border-slate-100 pt-2">
      {priceItems.length > 0 && (
        <div className="relative">
          <Input placeholder="Search price list to add…" value={q} onChange={(e) => { setQ(e.target.value); setOpen(true); }} onBlur={() => setTimeout(() => setOpen(false), 150)} />
          {open && matches.length > 0 && (
            <ul className="absolute z-20 mt-1 max-h-48 w-full overflow-auto rounded-lg border border-slate-200 bg-white py-1 shadow-lg">
              {matches.map((p) => (
                <li key={p.id}>
                  <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => pick(p)} className="flex w-full justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-slate-50">
                    <span className="truncate">{p.description}</span>
                    <span className="text-slate-600">{formatCurrency(sellPrice(p.buy_price, p.markup_pct))}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <div className="grid grid-cols-12 gap-2">
        <div className="col-span-6"><Input placeholder="Description" value={desc} onChange={(e) => setDesc(e.target.value)} /></div>
        <div className="col-span-2"><NumberInput placeholder="Qty" value={qty} onValueChange={setQty} /></div>
        <div className="col-span-2"><NumberInput placeholder="$" value={price} onValueChange={setPrice} /></div>
        <div className="col-span-2"><Button size="sm" onClick={save} disabled={pending || !desc.trim()} className="w-full"><Plus className="h-3.5 w-3.5" /></Button></div>
      </div>
    </div>
  );
}

function EditKitModal({ kit, onClose }: { kit: Kit; onClose: () => void }) {
  const router = useRouter();
  const [name, setName] = useState(kit.name);
  const [category, setCategory] = useState(kit.category ?? "");
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function save() {
    if (!name.trim()) return;
    setErr(null);
    start(async () => {
      const res = await updateKit(kit.id, { name, category });
      if (!res.ok) { setErr(res.error ?? "Could not save kit."); return; }
      router.refresh();
      onClose();
    });
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Edit kit"
      size="md"
      footer={<ModalActions onCancel={onClose} onSave={save} saving={pending} disabled={!name.trim()} />}
    >
      <div className="space-y-3">
        <div><Label htmlFor="ek-name">Kit name</Label><Input id="ek-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. 200A panel upgrade" /></div>
        <div><Label htmlFor="ek-cat">Category</Label><Input id="ek-cat" value={category} onChange={(e) => setCategory(e.target.value)} /></div>
        {err && <p className="text-sm text-red-600">{err}</p>}
      </div>
    </Modal>
  );
}

function EditItemModal({ item, onClose }: { item: KitItem; onClose: () => void }) {
  const router = useRouter();
  const [desc, setDesc] = useState(item.description);
  const [qty, setQty] = useState(Number(item.quantity));
  const [unit, setUnit] = useState(item.unit);
  const [price, setPrice] = useState(Number(item.unit_price));
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function save() {
    if (!desc.trim()) return;
    setErr(null);
    start(async () => {
      const res = await updateKitItem(item.id, { description: desc, quantity: qty, unit, unit_price: price });
      if (!res.ok) { setErr(res.error ?? "Could not save line."); return; }
      router.refresh();
      onClose();
    });
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Edit line item"
      size="md"
      footer={<ModalActions onCancel={onClose} onSave={save} saving={pending} disabled={!desc.trim()} />}
    >
      <div className="space-y-3">
        <div><Label htmlFor="ei-desc">Description</Label><Input id="ei-desc" value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Description" /></div>
        <div className="grid grid-cols-3 gap-2">
          <div><Label htmlFor="ei-qty">Qty</Label><NumberInput id="ei-qty" placeholder="Qty" value={qty} onValueChange={setQty} /></div>
          <div><Label htmlFor="ei-unit">Unit</Label><Input id="ei-unit" value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="ea" /></div>
          <div><Label htmlFor="ei-price">Unit price</Label><NumberInput id="ei-price" placeholder="$" value={price} onValueChange={setPrice} /></div>
        </div>
        {err && <p className="text-sm text-red-600">{err}</p>}
      </div>
    </Modal>
  );
}

export function KitsManager({ kits, priceItems }: { kits: Kit[]; priceItems: PriceItem[] }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [category, setCategory] = useState("");
  const [editingKit, setEditingKit] = useState<Kit | null>(null);
  const [editingItem, setEditingItem] = useState<KitItem | null>(null);
  const [pending, start] = useTransition();

  function create() {
    if (!name.trim()) return;
    start(async () => {
      await createKit({ name, category });
      setName(""); setCategory("");
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <div className="mb-3 flex items-center justify-between">
          <span className="text-sm font-medium text-slate-500">Build a kit by hand, or import a spreadsheet of presets.</span>
          <ImportKitsButton />
        </div>
        <div className="flex items-end gap-2">
          <div className="flex-1"><Label htmlFor="k-name">New kit name</Label><Input id="k-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. 200A panel upgrade" /></div>
          <div className="w-40"><Label htmlFor="k-cat">Category</Label><Input id="k-cat" value={category} onChange={(e) => setCategory(e.target.value)} /></div>
          <Button size="sm" onClick={create} disabled={pending || !name.trim()}><Plus className="h-3.5 w-3.5" /> Create</Button>
        </div>
      </Card>

      {kits.length === 0 ? (
        <p className="py-8 text-center text-sm text-slate-400">No kits yet. Create one and add the materials + labor you use for a common job.</p>
      ) : (
        <div className="space-y-4">
          {kits.map((k) => {
            const total = k.kit_items.reduce((s, i) => s + Number(i.quantity) * Number(i.unit_price), 0);
            return (
              <Card key={k.id} className="overflow-hidden">
                <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
                  <div className="flex items-center gap-2">
                    <Package className="h-4 w-4 text-brand" />
                    <span className="text-sm font-semibold text-slate-900">{k.name}</span>
                    {k.category && <span className="text-xs text-slate-400">· {k.category}</span>}
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-medium text-slate-700">{formatCurrency(total)}</span>
                    <button onClick={() => setEditingKit(k)} className="text-slate-400 hover:text-brand" title="Edit kit"><Pencil className="h-4 w-4" /></button>
                    <button onClick={() => { if (confirm(`Delete the "${k.name}" kit and all its items?`)) start(async () => { await deleteKit(k.id); router.refresh(); }); }} className="text-slate-400 hover:text-red-600" title="Delete kit"><Trash2 className="h-4 w-4" /></button>
                  </div>
                </div>
                <div className="space-y-2 p-4">
                  {k.kit_items.length > 0 && (
                    <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
                      {k.kit_items.map((it) => (
                        <li key={it.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                          <span className="flex-1">{it.description}</span>
                          <span className="text-slate-500">{Number(it.quantity)} {it.unit} × {formatCurrency(it.unit_price)}</span>
                          <span className="w-20 text-right font-medium text-slate-800">{formatCurrency(Number(it.quantity) * Number(it.unit_price))}</span>
                          <button onClick={() => setEditingItem(it)} className="text-slate-400 hover:text-brand" title="Edit line"><Pencil className="h-3.5 w-3.5" /></button>
                          <button onClick={() => { if (confirm("Remove this line item?")) start(async () => { await deleteKitItem(it.id); router.refresh(); }); }} className="text-slate-400 hover:text-red-600" title="Remove"><Trash2 className="h-3.5 w-3.5" /></button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <AddItemRow kitId={k.id} priceItems={priceItems} onDone={() => router.refresh()} />
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {editingKit && <EditKitModal kit={editingKit} onClose={() => setEditingKit(null)} />}
      {editingItem && <EditItemModal item={editingItem} onClose={() => setEditingItem(null)} />}
    </div>
  );
}
