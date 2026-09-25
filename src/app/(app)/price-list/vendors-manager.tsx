"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Archive, ExternalLink, Mail, MapPin, Phone, Plus, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input, Label, Select } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/toast";
import { AddressAutocomplete } from "@/components/address-autocomplete";
import { formatCurrency, formatPhone } from "@/lib/utils";
import { AddVendorPrice } from "./add-vendor-price";
import {
  kindCarriesPrices,
  listedKind,
  matchesVendorFilter,
  optionName,
  vendorFilters,
  vendorKey,
  vendorKindOf,
  websiteHref,
  type ItemOption,
  type VendorCard,
  type VendorCardField,
  type VendorFilter,
  type VendorKind,
  type VendorSummary,
} from "./item-options-math";
import type { PriceItem } from "./price-list-math";
import { addVendor, archiveVendor, restoreVendor, saveVendorField } from "./vendor-actions";
import { VendorImport } from "./vendor-import";
import { KIND_CHOICES, KIND_LABEL, type ExistingVendor } from "./vendor-import-math";
import { ArchivedVendorRow, VendorPriceRow, useOptionWrites } from "./vendor-price-row";

/**
 * THE VENDORS TAB: your suppliers, subcontractors and brands, in one directory with a Kind (0341).
 * A brand or supplier can carry prices on items (Erik for Justin, 2026-09-24: "vendor means what
 * brand with its own cost and sell price"): Andersen, Milgard, Marvin. A subcontractor (Andrew's
 * list, 2026-09-25: Granite Peak Plumbing, Coldwater Drywall) is here to be reached, and is never offered
 * as a vendor on an item. This lists every vendor the org has, whether it came from a card here or
 * from an item, how to reach it, and every item it is on with its cost and sell.
 */
export function VendorsManager({
  vendors,
  items,
  optionsByItem,
  knownVendors,
  defaultMarkupPct,
  cardsAvailable,
  kindsAvailable = false,
  existingVendors = [],
}: {
  vendors: VendorSummary[];
  /** Active items, for "Put It On An Item". */
  items: PriceItem[];
  optionsByItem: Record<string, ItemOption[]>;
  knownVendors: string[];
  defaultMarkupPct: number;
  /** False until migration 0296: the list still works from items, but contact details can't save. */
  cardsAvailable: boolean;
  /** False until migration 0341: no Kind, no import (every card reads as a brand). */
  kindsAvailable?: boolean;
  /** Every card and item vendor name, for an import's Already Have / Same Company? notes. */
  existingVendors?: ExistingVendor[];
}) {
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<VendorFilter>("all");
  const [addOpen, setAddOpen] = useState(false);
  // The keys the open sheet answers to, newest first. A rename pushes the new key on top, and the
  // old one keeps the sheet open until the refreshed list arrives under the new name (without it
  // the sheet would blink shut between the rename and the refresh).
  const [openKeys, setOpenKeys] = useState<string[]>([]);
  const openVendor = (name: string) => setOpenKeys([vendorKey(name)]);

  const needle = q.trim().toLowerCase();
  const chips = useMemo(() => vendorFilters(vendors), [vendors]);
  const shown = useMemo(
    () =>
      vendors
        .filter((v) => matchesVendorFilter(v, filter))
        .filter(
          (v) =>
            !needle ||
            v.name.toLowerCase().includes(needle) ||
            [v.card?.contact_name, v.card?.phone, v.card?.email, v.card?.address, v.card?.trade].some((x) => String(x ?? "").toLowerCase().includes(needle)) ||
            v.items.some((r) => [r.item.code, r.item.description].some((x) => String(x ?? "").toLowerCase().includes(needle))),
        ),
    [needle, vendors, filter],
  );
  const open = openKeys.map((k) => vendors.find((v) => v.key === k)).find(Boolean) ?? null;

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        {!addOpen && (
          <Button onClick={() => setAddOpen(true)} disabled={!cardsAvailable} aria-controls="vendor-add-form">
            <Plus className="h-4 w-4" /> Add Vendor
          </Button>
        )}
        {kindsAvailable && <VendorImport existing={existingVendors} />}
        <div className="relative sm:w-80">
          <Search className="absolute left-3 top-3 h-4 w-4 text-slate-400" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a vendor, a contact, a trade or an item…" className="pl-9" aria-label="Find a vendor" />
        </div>
      </div>
      <p className="text-xs text-slate-500">
        {kindsAvailable
          ? "Your suppliers, subcontractors and brands. Brands and suppliers can carry prices on items."
          : `${vendors.length} vendor${vendors.length === 1 ? "" : "s"}. A vendor on an item is the brand, e.g. Andersen.`}
      </p>
      {kindsAvailable && vendors.length > 0 && (
        <div className="flex flex-wrap gap-2" role="group" aria-label="Show">
          {chips.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => setFilter(c.id)}
              aria-pressed={filter === c.id}
              className={`inline-flex min-h-11 items-center gap-1 rounded-full border px-4 text-sm ${
                filter === c.id ? "border-brand bg-brand/10 font-medium text-slate-900" : "border-slate-200 bg-white text-slate-600 hover:border-brand/50"
              }`}
            >
              {c.label} <span className="text-xs text-slate-500">{c.count}</span>
            </button>
          ))}
        </div>
      )}
      {!cardsAvailable && (
        <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">
          Vendor contact details (phone, email, website) arrive with the next update. Vendors on your items and their prices
          work now: open any item on the Price List tab to add one.
        </p>
      )}

      {addOpen && <AddVendorForm kindsAvailable={kindsAvailable} onClose={() => setAddOpen(false)} onAdded={openVendor} />}

      {shown.length === 0 ? (
        <Card className="px-5 py-10 text-center">
          {needle || filter !== "all" ? (
            <p className="text-sm text-slate-500">No vendor matches that.</p>
          ) : (
            <>
              <p className="text-sm text-slate-600">No vendors yet.</p>
              <p className="mx-auto mt-1 max-w-md text-sm text-slate-500">
                {kindsAvailable
                  ? "Add your suppliers, subcontractors and brands here with their phone and email, or import the list you already keep in Excel or CSV. Brands and suppliers can carry prices: a window allowance can carry Andersen, Milgard and Marvin, each at its own price."
                  : "Add one here with its phone and email, or open any item on the Price List tab and add a vendor with its cost and sell. A window allowance can carry Andersen, Milgard and Marvin, each at its own price."}
              </p>
            </>
          )}
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {shown.map((v) => (
            <VendorTile key={v.key} vendor={v} showKind={kindsAvailable} onOpen={() => setOpenKeys([v.key])} />
          ))}
        </div>
      )}

      {open && (
        <VendorSheet
          vendor={open}
          items={items}
          optionsByItem={optionsByItem}
          knownVendors={knownVendors}
          defaultMarkupPct={defaultMarkupPct}
          cardsAvailable={cardsAvailable}
          kindsAvailable={kindsAvailable}
          onClose={() => setOpenKeys([])}
          onRenamed={(name) => setOpenKeys((ks) => [vendorKey(name), ...ks])}
        />
      )}
    </div>
  );
}

/** The kind in words, and the trade after it: "Subcontractor · Plumbing". */
function kindLine(kind: VendorKind | null, trade: string | null | undefined): string {
  return [KIND_LABEL[kind ?? "none"], trade?.trim()].filter(Boolean).join(" · ");
}

/**
 * One vendor on the list. The name and what it's on open the sheet; the phone, website and map
 * are their own links (a link can't live inside a button), each a 44px target.
 */
function VendorTile({ vendor: v, showKind, onOpen }: { vendor: VendorSummary; showKind: boolean; onOpen: () => void }) {
  const card = v.card;
  const tel = card?.phone ? card.phone.replace(/[^\d+]/g, "") : "";
  const web = websiteHref(card?.website);
  return (
    <div className="rounded-xl border border-slate-200 bg-white shadow-sm hover:border-brand/50">
      <button type="button" onClick={onOpen} className="block w-full px-4 pt-3 pb-2 text-left">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span className="font-semibold text-slate-900">{v.name}</span>
          <span className="text-xs text-slate-500">
            On {v.items.length} item{v.items.length === 1 ? "" : "s"}
            {v.defaults ? ` · default on ${v.defaults}` : ""}
          </span>
        </div>
        {showKind && <p className="mt-0.5 text-xs font-medium text-slate-600">{kindLine(listedKind(v), card?.trade)}</p>}
        <ContactLine card={card} />
        {v.items.length > 0 && (
          <p className="mt-1 truncate text-xs text-slate-500">
            {v.items
              .slice(0, 3)
              .map((r) => `${r.item.code ? `${r.item.code} ` : ""}${r.item.description} ${formatCurrency(r.sell)}`)
              .join(" · ")}
            {v.items.length > 3 ? ` · +${v.items.length - 3} more` : ""}
          </p>
        )}
      </button>
      {(tel || web || card?.address) && (
        <div className="flex flex-wrap gap-1 px-2 pb-2">
          {tel && (
            <a href={`tel:${tel}`} className="inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2 text-sm text-slate-700 hover:bg-slate-50">
              <Phone className="h-4 w-4" /> {formatPhone(card?.phone) || card?.phone}
            </a>
          )}
          {web && (
            <a href={web} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2 text-sm text-slate-700 hover:bg-slate-50">
              <ExternalLink className="h-4 w-4" /> Website
            </a>
          )}
          {card?.address && (
            <a
              href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(card.address)}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2 text-sm text-slate-700 hover:bg-slate-50"
            >
              <MapPin className="h-4 w-4" /> View On Map
            </a>
          )}
        </div>
      )}
    </div>
  );
}

/** Contact person, email, as plain text on the card (phone, website and map are links below). */
function ContactLine({ card }: { card: VendorCard | null }) {
  if (!card) return <p className="mt-0.5 text-xs text-slate-400">No contact details yet</p>;
  const bits = [card.contact_name, card.email].filter(Boolean);
  const any = bits.length || card.phone || card.website || card.address;
  if (!any) return <p className="mt-0.5 text-xs text-slate-400">No contact details yet</p>;
  return bits.length ? <p className="mt-0.5 truncate text-xs text-slate-600">{bits.join(" · ")}</p> : null;
}

/* ── ADD VENDOR ─────────────────────────────────────────────────────────────────────────────── */

const FIELDS: { key: VendorCardField; label: string; placeholder?: string; type?: string; inputMode?: "tel" | "email" | "url" }[] = [
  { key: "name", label: "Vendor *", placeholder: "e.g. Andersen or Granite Peak Plumbing" },
  { key: "contact_name", label: "Contact Person", placeholder: "your rep" },
  { key: "phone", label: "Phone", type: "tel", inputMode: "tel" },
  { key: "email", label: "Email", type: "email", inputMode: "email" },
  { key: "website", label: "Website", inputMode: "url", placeholder: "andersenwindows.com" },
  { key: "address", label: "Address", placeholder: "the dealer, showroom or office" },
];

function AddVendorForm({ kindsAvailable, onClose, onAdded }: { kindsAvailable: boolean; onClose: () => void; onAdded: (name: string) => void }) {
  const router = useRouter();
  const toast = useToast();
  const [, startRefresh] = useTransition();
  const [vals, setVals] = useState<Partial<Record<VendorCardField, string>>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function save() {
    if (saving) return;
    setError(null);
    if (!String(vals.name ?? "").trim()) return setError("Name the vendor, e.g. Andersen or Granite Peak Plumbing.");
    setSaving(true);
    // Kind and trade only go once the database has them (0341); before, they aren't offered.
    const { kind, trade, ...rest } = vals;
    const res = await addVendor(kindsAvailable ? { ...rest, kind: kind ?? "", trade: trade ?? "" } : rest);
    setSaving(false);
    if (!res.ok) return setError(res.error ?? "Couldn't add that vendor.");
    const name = res.name ?? String(vals.name).trim();
    toast(res.note ? `Added ${name} · ${res.note}` : `Added ${name}`, "success");
    setVals({});
    onClose();
    onAdded(name);
    startRefresh(() => router.refresh());
  }

  return (
    <Card id="vendor-add-form" className="p-4" role="group" aria-label="New Vendor">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-slate-900">New Vendor</h3>
        <Button variant="ghost" onClick={onClose}>
          <X className="h-4 w-4" /> Close
        </Button>
      </div>
      {error && <p className="mb-2 text-sm text-red-600">{error}</p>}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {kindsAvailable && (
          <>
            <div>
              <Label htmlFor="nv-kind">Kind</Label>
              <Select id="nv-kind" className="h-11" value={vals.kind ?? ""} onChange={(e) => setVals((v) => ({ ...v, kind: e.target.value }))}>
                {KIND_CHOICES.map((k) => (
                  <option key={k.value} value={k.value}>
                    {k.label}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label htmlFor="nv-trade">Trade</Label>
              <Input
                id="nv-trade"
                autoComplete="off"
                maxLength={60}
                value={vals.trade ?? ""}
                placeholder="e.g. Plumbing or Windows"
                onChange={(e) => setVals((v) => ({ ...v, trade: e.target.value }))}
              />
            </div>
          </>
        )}
        {FIELDS.map((f) => (
          <div key={f.key}>
            <Label htmlFor={`nv-${f.key}`}>{f.label}</Label>
            {f.key === "address" ? (
              <AddressAutocomplete
                id="nv-address"
                placeholder={f.placeholder}
                onTextChange={(text) => setVals((v) => (v.address === text ? v : { ...v, address: text }))}
                onResolved={(p) => {
                  if (p.formatted) setVals((v) => ({ ...v, address: p.formatted }));
                }}
              />
            ) : (
              <Input
                id={`nv-${f.key}`}
                type={f.type ?? "text"}
                inputMode={f.inputMode}
                // The vendor's details, not yours: keep the browser from filling in your own.
                autoComplete="off"
                value={vals[f.key] ?? ""}
                placeholder={f.placeholder}
                onChange={(e) => setVals((v) => ({ ...v, [f.key]: f.key === "phone" ? formatPhone(e.target.value) : e.target.value }))}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.nativeEvent.isComposing) void save();
                }}
              />
            )}
          </div>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
        {/* Said only for a kind that carries prices: a brand or a supplier. */}
        {(() => {
          const k = kindsAvailable ? vendorKindOf(vals.kind) : "brand";
          return k === "brand" || k === "supplier";
        })() ? (
          <span className="mr-auto text-xs text-slate-500">Prices go on items: after adding, put it on an item from its page here.</span>
        ) : (
          <span className="mr-auto" />
        )}
        <Button onClick={() => void save()} disabled={saving || !String(vals.name ?? "").trim()}>
          <Plus className="h-4 w-4" /> {saving ? "Adding…" : "Add Vendor"}
        </Button>
      </div>
    </Card>
  );
}

/* ── ONE VENDOR, OPENED ─────────────────────────────────────────────────────────────────────── */

function VendorSheet({
  vendor,
  items,
  optionsByItem,
  knownVendors,
  defaultMarkupPct,
  cardsAvailable,
  kindsAvailable,
  onClose,
  onRenamed,
}: {
  vendor: VendorSummary;
  items: PriceItem[];
  optionsByItem: Record<string, ItemOption[]>;
  knownVendors: string[];
  defaultMarkupPct: number;
  cardsAvailable: boolean;
  kindsAvailable: boolean;
  onClose: () => void;
  onRenamed: (name: string) => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const [, startRefresh] = useTransition();
  const writes = useOptionWrites();
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [pick, setPick] = useState("");
  const [picked, setPicked] = useState<PriceItem | null>(null);
  const [busy, setBusy] = useState(false);
  /** Which contact boxes are mid-save. Only THAT box waits: disabling the whole form on a blur
   *  disabled the box the person had just tabbed into, and whatever they typed next was lost. */
  const [savingFields, setSavingFields] = useState<Set<VendorCardField>>(() => new Set());
  /** One save at a time, in the order the boxes were left. The first detail on a vendor with no
   *  card INSERTS the card; two of those racing is the second one refused as a duplicate. */
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  /** The vendor's name as the server last answered it, so a save queued behind a rename finds the
   *  card under its new name. */
  const nameRef = useRef(vendor.name);
  useEffect(() => {
    nameRef.current = vendor.name;
  }, [vendor.name]);

  const onItemIds = new Set(vendor.items.map((r) => r.item.id));
  const needle = pick.trim().toLowerCase();
  const candidates = needle
    ? items
        .filter((i) => !onItemIds.has(i.id))
        .filter((i) => [i.code, i.description, i.category].some((x) => String(x ?? "").toLowerCase().includes(needle)))
        .slice(0, 8)
    : [];

  /** One contact detail, saved on its own the moment it's left (no Save button), with Undo. */
  /** Resolves true when it saved (or there was nothing to save), false when it was refused. */
  function saveField(field: VendorCardField, raw: string, current: string | null): Promise<boolean> {
    const value = raw.trim();
    if (value === (current ?? "").trim()) return Promise.resolve(true);
    const mark = (on: boolean) =>
      setSavingFields((prev) => {
        const next = new Set(prev);
        if (on) next.add(field);
        else next.delete(field);
        return next;
      });
    mark(true);
    const run = saveQueue.current.then(async () => {
      try {
        return await saveOneField(field, value);
      } finally {
        mark(false);
      }
    });
    saveQueue.current = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function saveOneField(field: VendorCardField, value: string): Promise<boolean> {
    const res = await saveVendorField({ name: nameRef.current, field, value });
    if (!res.ok) {
      toast(res.error ?? "Couldn't save that.", "error");
      return false;
    }
    const nameNow = res.name ?? nameRef.current;
    nameRef.current = nameNow;
    if (field === "name") onRenamed(nameNow);
    toast(res.note ? `Saved · ${res.note}` : "Saved", "success", {
      label: "Undo",
      onClick: async () => {
        const back = await saveVendorField({ name: nameRef.current, field, value: res.previous ?? "" });
        if (!back.ok) return toast(back.error ?? "Couldn't undo that.", "error");
        if (field === "name" && back.name) {
          nameRef.current = back.name;
          onRenamed(back.name);
        }
        toast("Undone", "success");
        startRefresh(() => router.refresh());
      },
    });
    startRefresh(() => router.refresh());
    return true;
  }

  async function archiveAll() {
    setBusy(true);
    // Let any contact detail still saving land first, so the archive sees the finished card.
    await saveQueue.current;
    const res = await archiveVendor(nameRef.current);
    setBusy(false);
    if (!res.ok) return toast(res.error ?? "Couldn't archive that vendor.", "error");
    const undo = res.undo;
    toast(res.note ? `Archived ${vendor.name} · ${res.note}` : `Archived ${vendor.name}`, "success", undo
      ? {
          label: "Undo",
          onClick: async () => {
            const back = await restoreVendor(undo);
            if (!back.ok) return toast(back.error ?? "Couldn't bring it back.", "error");
            toast(back.note ? `Restored · ${back.note}` : "Restored", "success");
            startRefresh(() => router.refresh());
          },
        }
      : undefined);
    onClose();
    startRefresh(() => router.refresh());
  }

  const card = vendor.card;
  const tel = card?.phone ? card.phone.replace(/[^\d+]/g, "") : "";
  const web = websiteHref(card?.website);
  const kind = listedKind(vendor);
  // A SUBCONTRACTOR NEVER CARRIES PRICES (0341): no "Put It On An Item" for one. It can only
  // become one while it's on no item (saveVendorField refuses otherwise), so this never hides
  // prices that exist.
  const pricesHere = kindCarriesPrices(kind);

  return (
    <Modal open onClose={onClose} title={vendor.name} size="xl">
      <div className="space-y-5">
        {/* HOW TO REACH THEM. Each box saves when you leave it; the toast has Undo. */}
        <section>
          <h3 className="text-sm font-semibold text-slate-900">Contact</h3>
          {!cardsAvailable && <p className="text-xs text-slate-500">Contact details arrive with the next update.</p>}
          {kindsAvailable && (
            <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div key={`${vendor.key}:kind:${card?.kind ?? ""}`}>
                <Label htmlFor="vs-kind">Kind</Label>
                <Select
                  id="vs-kind"
                  className="h-11"
                  defaultValue={card ? (card.kind ?? "") : "brand"}
                  disabled={savingFields.has("kind")}
                  onChange={(e) => {
                    // A refused change (a vendor with prices can't become a subcontractor) puts the
                    // box back to what is saved, so the screen never shows a kind that isn't.
                    const box = e.currentTarget;
                    const saved = card ? (card.kind ?? "") : "brand";
                    void saveField("kind", box.value, card ? (card.kind ?? null) : "brand").then((ok) => {
                      if (!ok) box.value = saved;
                    });
                  }}
                >
                  {KIND_CHOICES.map((k) => (
                    <option key={k.value} value={k.value}>
                      {k.label}
                    </option>
                  ))}
                </Select>
              </div>
              <div key={`${vendor.key}:trade:${card?.trade ?? ""}`}>
                <Label htmlFor="vs-trade">Trade</Label>
                <Input
                  id="vs-trade"
                  autoComplete="off"
                  maxLength={60}
                  defaultValue={card?.trade ?? ""}
                  placeholder="e.g. Plumbing or Windows"
                  disabled={savingFields.has("trade")}
                  onBlur={(e) => void saveField("trade", e.currentTarget.value, card?.trade ?? null)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.nativeEvent.isComposing) e.currentTarget.blur();
                  }}
                />
              </div>
            </div>
          )}
          <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
            {FIELDS.map((f) => {
              const current = f.key === "name" ? vendor.name : ((card?.[f.key] as string | null | undefined) ?? null);
              return (
                <div key={`${vendor.key}:${f.key}:${current ?? ""}`}>
                  <Label htmlFor={`vs-${f.key}`}>{f.key === "name" ? "Vendor" : f.label}</Label>
                  <Input
                    id={`vs-${f.key}`}
                    type={f.type ?? "text"}
                    inputMode={f.inputMode}
                    autoComplete="off"
                    defaultValue={current ?? ""}
                    placeholder={f.placeholder}
                    disabled={savingFields.has(f.key) || (!cardsAvailable && f.key !== "name")}
                    onChange={
                      f.key === "phone"
                        ? (e) => {
                            e.currentTarget.value = formatPhone(e.currentTarget.value);
                          }
                        : undefined
                    }
                    onBlur={(e) => void saveField(f.key, e.currentTarget.value, current)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.nativeEvent.isComposing) e.currentTarget.blur();
                    }}
                  />
                </div>
              );
            })}
          </div>
          {(tel || card?.email || web || card?.address) && (
            <div className="mt-2 flex flex-wrap gap-2">
              {tel && (
                <a href={`tel:${tel}`} className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-slate-200 px-3 text-sm text-slate-700 hover:border-brand">
                  <Phone className="h-4 w-4" /> Call
                </a>
              )}
              {card?.email && (
                <a href={`mailto:${card.email}`} className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-slate-200 px-3 text-sm text-slate-700 hover:border-brand">
                  <Mail className="h-4 w-4" /> Email
                </a>
              )}
              {web && (
                <a href={web} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-slate-200 px-3 text-sm text-slate-700 hover:border-brand">
                  <ExternalLink className="h-4 w-4" /> Website
                </a>
              )}
              {card?.address && (
                <a
                  href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(card.address)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-slate-200 px-3 text-sm text-slate-700 hover:border-brand"
                >
                  <MapPin className="h-4 w-4" /> View On Map
                </a>
              )}
            </div>
          )}
        </section>

        {/* EVERY ITEM THIS VENDOR IS ON, cost and sell editable in place. */}
        <section>
          <h3 className="text-sm font-semibold text-slate-900">
            Items ({vendor.items.length})
          </h3>
          {vendor.items.length === 0 ? (
            <p className="mt-1 text-sm text-slate-500">Not on any item yet. Put it on one below.</p>
          ) : (
            <ul className="mt-2 divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200">
              {vendor.items.map((r) => {
                const current = (optionsByItem[r.item.id] ?? []).find((o) => o.is_default && !o.archived) ?? null;
                return (
                  <VendorPriceRow
                    key={r.option.id}
                    item={r.item}
                    option={r.option}
                    defaultMarkupPct={defaultMarkupPct}
                    writes={writes}
                    currentDefaultId={current?.id ?? null}
                    heading={
                      <span className="min-w-0">
                        {r.item.code && <span className="mr-1 font-mono text-xs text-slate-500">{r.item.code}</span>}
                        <span className="font-medium text-slate-900">{r.item.description}</span>
                        {r.option.label && <span className="ml-1 text-sm text-slate-500">({optionName(r.option)})</span>}
                      </span>
                    }
                  />
                );
              })}
            </ul>
          )}
        </section>

        {/* PUT IT ON ANOTHER ITEM: find the item, type the cost (and the sell, if you know it). */}
        <section>
          <h3 className="text-sm font-semibold text-slate-900">Put It On An Item</h3>
          {!pricesHere ? (
            <p className="mt-1 text-sm text-slate-500">
              {vendor.name} is a subcontractor, and subcontractors don&apos;t carry prices on items. Change its Kind to Supplier or Brand to price items with it.
            </p>
          ) : picked ? (
            <div className="mt-2 space-y-2">
              <div className="flex items-center justify-between gap-2 text-sm">
                <span>
                  {picked.code && <span className="mr-1 font-mono text-xs text-slate-500">{picked.code}</span>}
                  <span className="font-medium text-slate-900">{picked.description}</span>
                </span>
                <Button variant="ghost" onClick={() => setPicked(null)}>
                  <X className="h-4 w-4" /> Another Item
                </Button>
              </div>
              <AddVendorPrice
                item={picked}
                vendor={vendor.name}
                knownVendors={knownVendors}
                defaultMarkupPct={defaultMarkupPct}
                hasDefault={(optionsByItem[picked.id] ?? []).some((o) => o.is_default && !o.archived)}
                run={writes.run}
                onDone={() => {
                  setPicked(null);
                  setPick("");
                }}
              />
            </div>
          ) : (
            <div className="relative mt-2">
              <Search className="absolute left-3 top-3 h-4 w-4 text-slate-400" />
              <Input value={pick} onChange={(e) => setPick(e.target.value)} placeholder="Find an item by code or description…" className="pl-9" aria-label="Find an item" />
              {candidates.length > 0 && (
                <ul className="mt-1 divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white">
                  {candidates.map((i) => (
                    <li key={i.id}>
                      <button type="button" onClick={() => setPicked(i)} className="flex min-h-11 w-full items-center gap-2 px-3 text-left text-sm hover:bg-slate-50">
                        {i.code && <span className="font-mono text-xs text-slate-500">{i.code}</span>}
                        <span className="truncate">{i.description}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {needle && candidates.length === 0 && <p className="mt-1 text-xs text-slate-500">No item matches that, or {vendor.name} is already on it.</p>}
            </div>
          )}
        </section>

        {vendor.archivedItems.length > 0 && (
          <section>
            <button onClick={() => setArchivedOpen((v) => !v)} className="min-h-11 text-xs font-medium text-slate-500 hover:text-slate-800">
              {archivedOpen ? "Hide" : "Show"} Archived ({vendor.archivedItems.length})
            </button>
            {archivedOpen && (
              <ul className="space-y-1">
                {vendor.archivedItems.map((r) => (
                  <ArchivedVendorRow
                    key={r.option.id}
                    label={`${r.item.code ? `${r.item.code} ` : ""}${r.item.description}`}
                    sell={r.sell}
                    unit={r.unit}
                    busy={writes.busy.has(r.option.id)}
                    onRestore={() => void writes.setArchived(r.option, false)}
                  />
                ))}
              </ul>
            )}
          </section>
        )}

        <div className="flex justify-end border-t border-slate-100 pt-3">
          <Button variant="outline" disabled={busy} onClick={() => void archiveAll()}>
            <Archive className="h-4 w-4" /> Archive {vendor.name}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
