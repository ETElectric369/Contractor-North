"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2, Package, Pencil, Link2, BookOpen, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Card } from "@/components/ui/card";
import { Modal, ModalActions } from "@/components/ui/modal";
import { useToast } from "@/components/toast";
import { formatCurrency } from "@/lib/utils";
import { formulaSentence } from "./price-list-math";
import { measurementLabel, type MeasurementOption } from "@/lib/playbook/measurements";
import { effectiveMarkupPct, sellPrice } from "@/lib/pricing/markup";
import { UnitSelect } from "@/components/unit-select";
import { kitLineView, lineDisplayName, linkedItemOf, type KitLineRaw, type KitSizing } from "@/lib/kit-line";
import {
  createKit, updateKit, deleteKit, addKitItem, updateKitItem, deleteKitItem, linkKitItem, setItemSizing,
} from "./kit-actions";
import { ImportKitsButton } from "./import-kits-button";

/**
 * KITS, JOINED TO THE PRICE LIST (0240).
 *
 * A kit line is either LINKED to a price-list item — and then its name, unit, cost, sell (through
 * THE markup rule with the org default) and sizing rule are the ITEM's, live, read-only here — or
 * FROZEN, carrying its own values exactly as every kit did before. Quantity is always the line's.
 * "Add from Price List" makes a linked line; the hand-typed row stays for things not in the book;
 * a frozen line can be linked later with "Link to Item".
 */

/** A kit_items row as THE SHARED SELECT SHAPE hands it over (kit-line.ts). */
type KitItem = KitLineRaw & { id: string };
interface Kit { id: string; name: string; category: string | null; kit_items: KitItem[]; }
interface PriceItem {
  id: string; code: string | null; description: string; category?: string | null; supplier?: string | null;
  unit: string; buy_price: number; markup_pct: number;
  qty_per_sqft?: number | null; qty_per_lf?: number | null; qty_min?: number | null; qty_round?: string | null;
}

/** The book's sell for an item here — item markup → org default. No customer level: a kit is an
 *  org-wide template, authored for no customer in particular. */
const bookSell = (p: PriceItem, orgDefaultPct: number) =>
  sellPrice(p.buy_price, effectiveMarkupPct({ itemPct: p.markup_pct, orgDefaultPct }));

/** One search box over the book — used by "Add from Price List" and "Link to Item" alike, so the
 *  two doors can never find different things. */
function ItemSearch({ priceItems, orgDefaultPct, onPick, placeholder, autoFocus }: {
  priceItems: PriceItem[]; orgDefaultPct: number; onPick: (p: PriceItem) => void; placeholder: string; autoFocus?: boolean;
}) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const matches = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return [];
    return priceItems
      .filter((p) => [p.code, p.description, p.category, p.supplier].some((v) => (v ?? "").toLowerCase().includes(s)))
      .slice(0, 8);
  }, [q, priceItems]);
  return (
    <div className="relative">
      <Input
        placeholder={placeholder}
        value={q}
        autoFocus={autoFocus}
        onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
      />
      {open && q.trim() && (
        <ul className="absolute z-20 mt-1 max-h-56 w-full overflow-auto rounded-lg border border-slate-200 bg-white py-1 shadow-lg">
          {matches.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => { onPick(p); setQ(""); setOpen(false); }}
                className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-slate-50"
              >
                <span className="min-w-0 truncate">
                  {p.code && <span className="mr-1 font-mono text-xs text-slate-400">{p.code}</span>}
                  {p.description}
                </span>
                <span className="shrink-0 text-slate-600">{formatCurrency(bookSell(p, orgDefaultPct))} / {p.unit || "ea"}</span>
              </button>
            </li>
          ))}
          {matches.length === 0 && <li className="px-3 py-2 text-sm text-slate-400">Nothing in the book matches that.</li>}
        </ul>
      )}
    </div>
  );
}

function AddItemRow({ kitId, priceItems, orgDefaultPct, onDone }: { kitId: string; priceItems: PriceItem[]; orgDefaultPct: number; onDone: () => void }) {
  const toast = useToast();
  const [picked, setPicked] = useState<PriceItem | null>(null);
  const [desc, setDesc] = useState("");
  const [qty, setQty] = useState(1);
  const [unit, setUnit] = useState("ea");
  const [price, setPrice] = useState(0);
  const [pending, start] = useTransition();

  const canSave = picked ? true : !!desc.trim();

  function save() {
    if (!canSave) return;
    start(async () => {
      const res = picked
        ? await addKitItem({ kit_id: kitId, price_list_item_id: picked.id, quantity: qty })
        : await addKitItem({ kit_id: kitId, description: desc, quantity: qty, unit, unit_price: price });
      if (!res.ok) { toast(res.error ?? "Could not add the line.", "error"); return; }
      if (picked && !res.linked) toast("Added as a frozen line — linking to the book arrives with the next update.", "info");
      else toast(picked ? `Added ${lineDisplayName(picked)} — priced from the book.` : "Line added.", "success");
      setPicked(null); setDesc(""); setQty(1); setUnit("ea"); setPrice(0);
      onDone();
    });
  }

  return (
    <div className="space-y-2 border-t border-slate-100 pt-2">
      {priceItems.length > 0 && !picked && (
        <ItemSearch priceItems={priceItems} orgDefaultPct={orgDefaultPct} onPick={setPicked} placeholder="Add from Price List — search by code or name…" />
      )}
      {picked ? (
        <div className="grid grid-cols-12 items-center gap-2">
          <div className="col-span-8 flex min-w-0 items-center gap-2 rounded-lg border border-brand/30 bg-brand/5 px-3 py-2 text-sm">
            <BookOpen className="h-3.5 w-3.5 shrink-0 text-brand" />
            <span className="min-w-0 truncate">{lineDisplayName(picked)}</span>
            <span className="shrink-0 text-slate-500">{formatCurrency(bookSell(picked, orgDefaultPct))} / {picked.unit || "ea"}</span>
            <button type="button" onClick={() => setPicked(null)} className="ml-auto text-slate-400 hover:text-slate-700" title="Clear" aria-label="Clear picked item"><X className="h-3.5 w-3.5" /></button>
          </div>
          <div className="col-span-2"><NumberInput placeholder="Qty" value={qty} onValueChange={setQty} aria-label="Quantity" /></div>
          <div className="col-span-2"><Button size="sm" onClick={save} disabled={pending || !canSave} className="w-full"><Plus className="h-3.5 w-3.5" /> Add Line</Button></div>
        </div>
      ) : (
        <div className="grid grid-cols-12 gap-2">
          <div className="col-span-5"><Input placeholder="Or type a line not in the book" value={desc} onChange={(e) => setDesc(e.target.value)} /></div>
          <div className="col-span-2"><NumberInput placeholder="Qty" value={qty} onValueChange={setQty} aria-label="Quantity" /></div>
          <div className="col-span-1"><UnitSelect value={unit} onChange={setUnit} aria-label="Unit" /></div>
          <div className="col-span-2"><NumberInput placeholder="$" value={price} onValueChange={setPrice} aria-label="Unit price" /></div>
          <div className="col-span-2"><Button size="sm" onClick={save} disabled={pending || !canSave} className="w-full"><Plus className="h-3.5 w-3.5" /> Add Line</Button></div>
        </div>
      )}
    </div>
  );
}

function EditKitModal({ kit, onClose }: { kit: Kit; onClose: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const [name, setName] = useState(kit.name);
  const [category, setCategory] = useState(kit.category ?? "");
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function save() {
    if (!name.trim()) return;
    setErr(null);
    start(async () => {
      const res = await updateKit(kit.id, { name, category });
      if (!res.ok) { setErr(res.error ?? "Could not save kit."); toast(res.error ?? "Could not save kit.", "error"); return; }
      toast("Kit saved.", "success");
      router.refresh();
      onClose();
    });
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Edit Kit"
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

/** "Link to Item" — turn a frozen line into a linked one. The line keeps its frozen values until
 *  the link is made; the pick is the write. */
function LinkItemModal({ item, priceItems, orgDefaultPct, onClose }: { item: KitItem; priceItems: PriceItem[]; orgDefaultPct: number; onClose: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  function pick(p: PriceItem) {
    setErr(null);
    start(async () => {
      const res = await linkKitItem(item.id, p.id);
      if (!res.ok) { setErr(res.error ?? "Could not link."); toast(res.error ?? "Could not link.", "error"); return; }
      toast(`Linked to ${lineDisplayName(p)} — it prices from the book now.`, "success");
      router.refresh();
      onClose();
    });
  }
  return (
    <Modal open onClose={onClose} title="Link to Item" size="md" footer={<ModalActions onCancel={onClose} onSave={onClose} saveLabel="Done" hideCancel />}>
      <div className="space-y-3">
        <p className="text-sm text-slate-600">
          <span className="font-medium text-slate-900">{item.description}</span> is a frozen line — it keeps the price it was
          typed with. Link it to a price-list item and it takes the item&rsquo;s name, unit, cost and markup from then on.
        </p>
        <ItemSearch priceItems={priceItems} orgDefaultPct={orgDefaultPct} onPick={pick} placeholder="Search the price list…" autoFocus />
        {pending && <p className="text-xs text-slate-400">Linking…</p>}
        {err && <p className="text-sm text-red-600">{err}</p>}
      </div>
    </Modal>
  );
}

function SizingFields({ sizing, onChange, idPrefix, measurements = [] }: { sizing: SizingDraft; onChange: (s: SizingDraft) => void; idPrefix: string; measurements?: MeasurementOption[] }) {
  const sq = Number(sizing.perSqft) || 0;
  const lf = Number(sizing.perLf) || 0;
  const per = Number(sizing.qtyPer) || 0;
  const mode = sizing.sizedBy && per > 0 ? `m:${sizing.sizedBy}` : sq > 0 ? "sqft" : lf > 0 ? "lf" : "fixed";
  return (
    <>
      <p className="mt-2 text-xs font-medium text-slate-700">{formulaSentence({ ...sizing, measurementLabel: measurementLabel(sizing.sizedBy, measurements) })}</p>
      {/* ONE choice first; the numbers appear only for a rule that needs them (a strap is a fixed count). */}
      <div className="mt-2 grid grid-cols-2 gap-2">
        <div className="col-span-2">
          <Label htmlFor={`${idPrefix}-mode`}>How It&rsquo;s Counted</Label>
          <Select
            id={`${idPrefix}-mode`}
            value={mode}
            onChange={(e) => {
              const m = e.target.value;
              if (m.startsWith("m:")) {
                onChange({ ...sizing, sizedBy: m.slice(2), qtyPer: per || 1, perSqft: "", perLf: "" });
                return;
              }
              onChange({ ...sizing, sizedBy: "", qtyPer: "", perSqft: m === "sqft" ? sq || 1 : "", perLf: m === "lf" ? lf || 1 : "" });
            }}
          >
            <option value="fixed">Fixed Quantity — typed on the estimate</option>
            <option value="sqft">Per Sq Ft of the Job</option>
            <option value="lf">Per Linear Ft of the Job</option>
            {measurements.filter((m) => !m.builtIn).map((m) => (
              <option key={m.key} value={`m:${m.key}`}>
                Per {m.label}{m.unit ? ` (${m.unit})` : ""}
              </option>
            ))}
          </Select>
        </div>
        {mode.startsWith("m:") && (
          <div><Label htmlFor={`${idPrefix}-per`}>How many per {measurementLabel(sizing.sizedBy, measurements)}</Label><NumberInput id={`${idPrefix}-per`} placeholder="e.g. 1" value={per} onValueChange={(n) => onChange({ ...sizing, qtyPer: n })} /></div>
        )}
        {mode === "sqft" && (
          <div><Label htmlFor={`${idPrefix}-sqft`}>How many per sq ft</Label><NumberInput id={`${idPrefix}-sqft`} placeholder="e.g. 1" value={sq} onValueChange={(n) => onChange({ ...sizing, perSqft: n })} /></div>
        )}
        {mode === "lf" && (
          <div><Label htmlFor={`${idPrefix}-lf`}>How many per linear ft</Label><NumberInput id={`${idPrefix}-lf`} placeholder="e.g. 3" value={lf} onValueChange={(n) => onChange({ ...sizing, perLf: n })} /></div>
        )}
        {mode !== "fixed" && (
          <>
            <div><Label htmlFor={`${idPrefix}-min`}>Never fewer than</Label><NumberInput id={`${idPrefix}-min`} placeholder="—" value={sizing.qtyMin === "" ? 0 : sizing.qtyMin} onValueChange={(n) => onChange({ ...sizing, qtyMin: n })} /></div>
            <div>
              <Label htmlFor={`${idPrefix}-round`}>Round</Label>
              <Select id={`${idPrefix}-round`} value={sizing.rounding} onChange={(e) => onChange({ ...sizing, rounding: e.target.value })}>
                <option value="up">Round up (whole units)</option>
                <option value="nearest">Nearest</option>
                <option value="none">Exact — no rounding</option>
              </Select>
            </div>
          </>
        )}
      </div>
    </>
  );
}

type SizingDraft = { perSqft: number | ""; perLf: number | ""; qtyMin: number | ""; rounding: string; sizedBy: string; qtyPer: number | "" };
const draftOf = (s: KitSizing): SizingDraft => ({
  perSqft: s.qty_per_sqft ?? "", perLf: s.qty_per_lf ?? "", qtyMin: s.qty_min ?? "", rounding: s.qty_round ?? "up",
  sizedBy: s.sized_by ?? "", qtyPer: s.qty_per ?? "",
});
const sizingOfDraft = (d: SizingDraft): KitSizing => ({
  sized_by: d.sizedBy || null,
  qty_per: !d.sizedBy || d.qtyPer === "" || d.qtyPer === 0 ? null : Number(d.qtyPer),
  qty_per_sqft: d.perSqft === "" || d.perSqft === 0 ? null : Number(d.perSqft),
  qty_per_lf: d.perLf === "" || d.perLf === 0 ? null : Number(d.perLf),
  qty_min: d.qtyMin === "" || d.qtyMin === 0 ? null : Number(d.qtyMin),
  qty_round: d.rounding || null,
});
/** The same rule? A NULL rounding behaves as "up" (0240's column comment), so the two read equal. */
const sameSizing = (a: KitSizing, b: KitSizing) =>
  (a.sized_by ?? null) === (b.sized_by ?? null) &&
  (a.qty_per ?? null) === (b.qty_per ?? null) &&
  (a.qty_per_sqft ?? null) === (b.qty_per_sqft ?? null) &&
  (a.qty_per_lf ?? null) === (b.qty_per_lf ?? null) &&
  (a.qty_min ?? null) === (b.qty_min ?? null) &&
  (a.qty_round ?? "up") === (b.qty_round ?? "up");

function EditItemModal({ item, orgDefaultPct, measurements = [], onClose }: { item: KitItem; orgDefaultPct: number; measurements?: MeasurementOption[]; onClose: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const view = kitLineView(item, { orgDefaultPct });
  const linkedItem = linkedItemOf(item);
  const [desc, setDesc] = useState(item.description);
  const [qty, setQty] = useState(Number(item.quantity) || 0);
  const [unit, setUnit] = useState(item.unit || "ea");
  const [price, setPrice] = useState(Number(item.unit_price) || 0);
  // SIZING (0166/0240). "" means no coefficient — a flat quantity. On a linked line these are the
  // ITEM's numbers and save onto the item; on a frozen line they stay on the line.
  const [sizing, setSizing] = useState<SizingDraft>(() => draftOf(view.sizing));
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const canSave = view.linked ? true : !!desc.trim();

  function save() {
    if (!canSave) return;
    setErr(null);
    start(async () => {
      if (view.linked && linkedItem) {
        const q = await updateKitItem(item.id, { quantity: qty });
        if (!q.ok) { setErr(q.error ?? "Could not save."); toast(q.error ?? "Could not save the quantity.", "error"); return; }
        // The sizing rule is the ITEM's — write it only when it actually changed, so a plain
        // quantity edit never touches the book (and every other kit that shares the item).
        const nextSizing = sizingOfDraft(sizing);
        if (sameSizing(nextSizing, view.sizing)) {
          toast("Quantity saved.", "success");
        } else {
          const s = await setItemSizing(linkedItem.id, nextSizing);
          if (!s.ok) { setErr(s.error ?? "Could not save sizing."); toast(`Quantity saved, but the sizing didn't: ${s.error}`, "error"); return; }
          toast("Saved — the sizing rule lives on the item now.", "success");
        }
      } else {
        const s = sizingOfDraft(sizing);
        const res = await updateKitItem(item.id, { description: desc, quantity: qty, unit, unit_price: price, ...s });
        if (!res.ok) { setErr(res.error ?? "Could not save line."); toast(res.error ?? "Could not save the line.", "error"); return; }
        toast("Line saved.", "success");
      }
      router.refresh();
      onClose();
    });
  }

  function unlink() {
    if (!confirm("Unlink this line from the price list? It keeps today's name and price, frozen, and stops following the book.")) return;
    start(async () => {
      const res = await linkKitItem(item.id, null);
      if (!res.ok) { toast(res.error ?? "Could not unlink.", "error"); return; }
      toast("Unlinked — the line is frozen at today's values.", "info");
      router.refresh();
      onClose();
    });
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Edit Line Item"
      size="md"
      footer={<ModalActions onCancel={onClose} onSave={save} saving={pending} disabled={!canSave} />}
    >
      <div className="space-y-3">
        {view.linked ? (
          <div className="rounded-lg border border-brand/30 bg-brand/5 p-3 text-sm">
            <div className="flex items-center gap-2">
              <BookOpen className="h-4 w-4 shrink-0 text-brand" />
              <span className="font-medium text-slate-900">{view.description}</span>
            </div>
            <p className="mt-1 text-xs text-slate-600">
              {formatCurrency(view.unit_price)} / {view.unit}
              {view.cost != null && <span className="text-slate-400"> · cost {formatCurrency(view.cost)}</span>}
              {view.supplier && <span className="text-slate-400"> · {view.supplier}</span>}
            </p>
            <p className="mt-1 text-xs text-slate-500">Priced from the book — edit the item in the Price List to change its name, unit or price.</p>
            <button type="button" onClick={unlink} disabled={pending} className="mt-2 text-xs text-slate-400 underline-offset-2 hover:text-red-600 hover:underline">
              Unlink — Freeze at Today&rsquo;s Price
            </button>
          </div>
        ) : (
          <div><Label htmlFor="ei-desc">Description</Label><Input id="ei-desc" value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Description" /></div>
        )}
        <div className="grid grid-cols-3 gap-2">
          <div><Label htmlFor="ei-qty">Qty</Label><NumberInput id="ei-qty" placeholder="Qty" value={qty} onValueChange={setQty} /></div>
          {!view.linked && (
            <>
              <div><Label htmlFor="ei-unit">Unit</Label><UnitSelect id="ei-unit" value={unit} onChange={setUnit} /></div>
              <div><Label htmlFor="ei-price">Unit price</Label><NumberInput id="ei-price" placeholder="$" value={price} onValueChange={setPrice} /></div>
            </>
          )}
        </div>

        {/* SIZE THIS LINE FROM THE JOB (0166) — the link between a walk-through and an estimate.
            A line that knows it needs so-much per square foot fills its own quantity in from the
            measurements, instead of somebody working it out on a phone. Left blank, the line keeps
            its flat quantity, which is how every existing kit already behaves. On a LINKED line the
            rule belongs to the ITEM (0240) — every kit that lists it sizes the same way. */}
        <details className="rounded-lg border border-slate-200 p-3">
          <summary className="cursor-pointer text-sm font-medium text-slate-700">
            Item Formula
            {(sizing.perSqft !== "" || sizing.perLf !== "" || (!!sizing.sizedBy && sizing.qtyPer !== "")) && <span className="ml-2 text-xs font-normal text-brand">on</span>}
          </summary>
          <p className="mt-2 text-xs text-slate-500">
            {view.linked
              ? "This rule is saved on the price-list item, so every kit that uses it sizes the same way."
              : "Leave blank for a fixed quantity. Fill one in and this line works out its own quantity from the measurements taken on the walk-through."}
          </p>
          <SizingFields sizing={sizing} onChange={setSizing} idPrefix="ei" measurements={measurements} />
        </details>

        {err && <p className="text-sm text-red-600">{err}</p>}
      </div>
    </Modal>
  );
}

export function KitsManager({ kits, priceItems, defaultMarkupPct = 0, measurements = [] }: { kits: Kit[]; priceItems: PriceItem[]; defaultMarkupPct?: number; measurements?: MeasurementOption[] }) {
  const router = useRouter();
  const toast = useToast();
  const [name, setName] = useState("");
  const [category, setCategory] = useState("");
  const [editingKit, setEditingKit] = useState<Kit | null>(null);
  const [editingItem, setEditingItem] = useState<KitItem | null>(null);
  const [linkingItem, setLinkingItem] = useState<KitItem | null>(null);
  const [pending, start] = useTransition();

  function create() {
    if (!name.trim()) return;
    start(async () => {
      const res = await createKit({ name, category });
      if (!res.ok) { toast(res.error ?? "Could not add the kit.", "error"); return; }
      toast(`Kit "${name.trim()}" added.`, "success");
      setName(""); setCategory("");
      router.refresh();
    });
  }

  function removeKit(k: Kit) {
    if (!confirm(`Delete the "${k.name}" kit and all its items?`)) return;
    start(async () => {
      const res = await deleteKit(k.id);
      if (!res.ok) { toast(res.error ?? "Could not delete the kit.", "error"); return; }
      toast(`Deleted "${k.name}".`, "info");
      router.refresh();
    });
  }

  function removeLine(it: KitItem) {
    if (!confirm("Remove this line item?")) return;
    start(async () => {
      const res = await deleteKitItem(it.id);
      if (!res.ok) { toast(res.error ?? "Could not remove the line.", "error"); return; }
      toast("Line removed.", "info");
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
          <Button size="sm" onClick={create} disabled={pending || !name.trim()}><Plus className="h-3.5 w-3.5" /> Add Kit</Button>
        </div>
      </Card>

      {kits.length === 0 ? (
        <p className="py-8 text-center text-sm text-slate-400">No kits yet. Create one and add the materials + labor you use for a common job.</p>
      ) : (
        <div className="space-y-4">
          {kits.map((k) => {
            const views = k.kit_items.map((it) => ({ it, v: kitLineView(it, { orgDefaultPct: defaultMarkupPct }) }));
            const total = views.reduce((s, { it, v }) => s + (Number(it.quantity) || 0) * v.unit_price, 0);
            const linkedCount = views.filter(({ v }) => v.linked).length;
            return (
              <Card key={k.id} className="overflow-hidden">
                <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
                  <div className="flex items-center gap-2">
                    <Package className="h-4 w-4 text-brand" />
                    <span className="text-sm font-semibold text-slate-900">{k.name}</span>
                    {k.category && <span className="text-xs text-slate-400">· {k.category}</span>}
                    {linkedCount > 0 && (
                      <span className="text-xs text-slate-400" title="Lines priced live from the price list">
                        · {linkedCount} of {k.kit_items.length} from the book
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-medium text-slate-700">{formatCurrency(total)}</span>
                    <button onClick={() => setEditingKit(k)} className="text-slate-400 hover:text-brand" title="Edit Kit"><Pencil className="h-4 w-4" /></button>
                    <button onClick={() => removeKit(k)} className="text-slate-400 hover:text-red-600" title="Delete Kit"><Trash2 className="h-4 w-4" /></button>
                  </div>
                </div>
                <div className="space-y-2 p-4">
                  {views.length > 0 && (
                    <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
                      {views.map(({ it, v }) => {
                        const qty = Number(it.quantity) || 0;
                        const sized =
                          (v.sizing.qty_per_sqft ?? 0) > 0 ||
                          (v.sizing.qty_per_lf ?? 0) > 0 ||
                          (!!v.sizing.sized_by && (Number(v.sizing.qty_per) || 0) > 0); // 0241 per-measurement (audit v921)
                        return (
                          <li key={it.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                            <span className="flex min-w-0 flex-1 items-center gap-1.5">
                              {v.linked && <BookOpen className="h-3.5 w-3.5 shrink-0 text-brand" aria-label="Priced from the book" />}
                              <span className="truncate">{v.description}</span>
                              {sized && <span className="shrink-0 rounded bg-slate-100 px-1 text-[10px] uppercase tracking-wide text-slate-500" title="Sizes itself from the job's measurements">sized</span>}
                            </span>
                            <span className="text-slate-500">{qty} {v.unit} × {formatCurrency(v.unit_price)}</span>
                            <span className="w-20 text-right font-medium text-slate-800">{formatCurrency(qty * v.unit_price)}</span>
                            {!v.linked && priceItems.length > 0 && (
                              <button onClick={() => setLinkingItem(it)} className="text-slate-400 hover:text-brand" title="Link to Item"><Link2 className="h-3.5 w-3.5" /></button>
                            )}
                            <button onClick={() => setEditingItem(it)} className="text-slate-400 hover:text-brand" title="Edit Line"><Pencil className="h-3.5 w-3.5" /></button>
                            <button onClick={() => removeLine(it)} className="text-slate-400 hover:text-red-600" title="Remove"><Trash2 className="h-3.5 w-3.5" /></button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                  {linkedCount > 0 && (
                    <p className="text-[11px] text-slate-400">
                      <BookOpen className="mr-1 inline h-3 w-3 text-brand" />
                      Lines marked with the book icon are priced from the Price List — edit the item to change them. Quantity is the kit&rsquo;s.
                    </p>
                  )}
                  <AddItemRow kitId={k.id} priceItems={priceItems} orgDefaultPct={defaultMarkupPct} onDone={() => router.refresh()} />
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {editingKit && <EditKitModal kit={editingKit} onClose={() => setEditingKit(null)} />}
      {editingItem && <EditItemModal item={editingItem} orgDefaultPct={defaultMarkupPct} measurements={measurements} onClose={() => setEditingItem(null)} />}
      {linkingItem && <LinkItemModal item={linkingItem} priceItems={priceItems} orgDefaultPct={defaultMarkupPct} onClose={() => setLinkingItem(null)} />}
    </div>
  );
}
