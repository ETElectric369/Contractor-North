"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Archive, ExternalLink, Mail, MapPin, Phone, Plus, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/toast";
import { formatCurrency, formatPhone } from "@/lib/utils";
import { AddVendorPrice } from "./add-vendor-price";
import {
  optionName,
  vendorKey,
  websiteHref,
  type ItemOption,
  type VendorCard,
  type VendorCardField,
  type VendorSummary,
} from "./item-options-math";
import type { PriceItem } from "./price-list-math";
import { addVendor, archiveVendor, restoreVendor, saveVendorField } from "./vendor-actions";
import { ArchivedVendorRow, VendorPriceRow, useOptionWrites } from "./vendor-price-row";

/**
 * THE VENDORS TAB. A vendor is the brand (Erik for Justin, 2026-09-24: "vendor means what brand
 * with its own cost and sell price"): Andersen, Milgard, Marvin. This lists every vendor the org
 * has, whether it came from a card here or from an item, how to reach it, and every item it is on
 * with its cost and sell. Add Vendor takes the contact details; the prices go on items.
 */
export function VendorsManager({
  vendors,
  items,
  optionsByItem,
  knownVendors,
  defaultMarkupPct,
  cardsAvailable,
}: {
  vendors: VendorSummary[];
  /** Active items, for "Put It On An Item". */
  items: PriceItem[];
  optionsByItem: Record<string, ItemOption[]>;
  knownVendors: string[];
  defaultMarkupPct: number;
  /** False until migration 0296: the list still works from items, but contact details can't save. */
  cardsAvailable: boolean;
}) {
  const [q, setQ] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  // The keys the open sheet answers to, newest first. A rename pushes the new key on top, and the
  // old one keeps the sheet open until the refreshed list arrives under the new name (without it
  // the sheet would blink shut between the rename and the refresh).
  const [openKeys, setOpenKeys] = useState<string[]>([]);
  const openVendor = (name: string) => setOpenKeys([vendorKey(name)]);

  const needle = q.trim().toLowerCase();
  const shown = useMemo(
    () =>
      needle
        ? vendors.filter(
            (v) =>
              v.name.toLowerCase().includes(needle) ||
              [v.card?.contact_name, v.card?.phone, v.card?.email, v.card?.address].some((x) => String(x ?? "").toLowerCase().includes(needle)) ||
              v.items.some((r) => [r.item.code, r.item.description].some((x) => String(x ?? "").toLowerCase().includes(needle))),
          )
        : vendors,
    [needle, vendors],
  );
  const open = openKeys.map((k) => vendors.find((v) => v.key === k)).find(Boolean) ?? null;

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        {!addOpen && (
          <Button onClick={() => setAddOpen(true)} disabled={!cardsAvailable} aria-controls="vendor-add-form">
            <Plus className="h-4 w-4" /> Add Vendor
          </Button>
        )}
        <div className="relative sm:w-80">
          <Search className="absolute left-3 top-3 h-4 w-4 text-slate-400" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a vendor, a contact or an item…" className="pl-9" aria-label="Find a vendor" />
        </div>
        <p className="text-xs text-slate-500 sm:ml-1">
          {vendors.length} vendor{vendors.length === 1 ? "" : "s"}. A vendor is the brand, e.g. Andersen.
        </p>
      </div>
      {!cardsAvailable && (
        <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">
          Vendor contact details (phone, email, website) arrive with the next update. Vendors on your items and their prices
          work now: open any item on the Price List tab to add one.
        </p>
      )}

      {addOpen && <AddVendorForm onClose={() => setAddOpen(false)} onAdded={openVendor} />}

      {shown.length === 0 ? (
        <Card className="px-5 py-10 text-center">
          {needle ? (
            <p className="text-sm text-slate-500">No vendor matches that.</p>
          ) : (
            <>
              <p className="text-sm text-slate-600">No vendors yet.</p>
              <p className="mx-auto mt-1 max-w-md text-sm text-slate-500">
                Add one here with its phone and email, or open any item on the Price List tab and add a vendor with its cost
                and sell. A window allowance can carry Andersen, Milgard and Marvin, each at its own price.
              </p>
            </>
          )}
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {shown.map((v) => (
            <button
              key={v.key}
              type="button"
              onClick={() => setOpenKeys([v.key])}
              className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-left shadow-sm hover:border-brand/50"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-semibold text-slate-900">{v.name}</span>
                <span className="text-xs text-slate-500">
                  On {v.items.length} item{v.items.length === 1 ? "" : "s"}
                  {v.defaults ? ` · default on ${v.defaults}` : ""}
                </span>
              </div>
              <ContactLine card={v.card} />
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
          onClose={() => setOpenKeys([])}
          onRenamed={(name) => setOpenKeys((ks) => [vendorKey(name), ...ks])}
        />
      )}
    </div>
  );
}

/** Phone, email, website, address, as plain text on the card (the card itself is the button). */
function ContactLine({ card }: { card: VendorCard | null }) {
  if (!card) return <p className="mt-0.5 text-xs text-slate-400">No contact details yet</p>;
  const bits = [card.contact_name, card.phone ? formatPhone(card.phone) || card.phone : null, card.email, card.website].filter(Boolean);
  return <p className="mt-0.5 truncate text-xs text-slate-600">{bits.length ? bits.join(" · ") : "No contact details yet"}</p>;
}

/* ── ADD VENDOR ─────────────────────────────────────────────────────────────────────────────── */

const FIELDS: { key: VendorCardField; label: string; placeholder?: string; type?: string; inputMode?: "tel" | "email" | "url" }[] = [
  { key: "name", label: "Vendor *", placeholder: "the brand, e.g. Andersen" },
  { key: "contact_name", label: "Contact Person", placeholder: "your rep" },
  { key: "phone", label: "Phone", type: "tel", inputMode: "tel" },
  { key: "email", label: "Email", type: "email", inputMode: "email" },
  { key: "website", label: "Website", inputMode: "url", placeholder: "andersenwindows.com" },
  { key: "address", label: "Address", placeholder: "the dealer or showroom" },
];

function AddVendorForm({ onClose, onAdded }: { onClose: () => void; onAdded: (name: string) => void }) {
  const router = useRouter();
  const toast = useToast();
  const [, startRefresh] = useTransition();
  const [vals, setVals] = useState<Partial<Record<VendorCardField, string>>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function save() {
    if (saving) return;
    setError(null);
    if (!String(vals.name ?? "").trim()) return setError("Name the vendor: the brand, e.g. Andersen.");
    setSaving(true);
    const res = await addVendor(vals);
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
        {FIELDS.map((f) => (
          <div key={f.key}>
            <Label htmlFor={`nv-${f.key}`}>{f.label}</Label>
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
          </div>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
        <span className="mr-auto text-xs text-slate-500">Prices go on items: after adding, put it on an item from its page here.</span>
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
  onClose,
  onRenamed,
}: {
  vendor: VendorSummary;
  items: PriceItem[];
  optionsByItem: Record<string, ItemOption[]>;
  knownVendors: string[];
  defaultMarkupPct: number;
  cardsAvailable: boolean;
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
  function saveField(field: VendorCardField, raw: string, current: string | null): Promise<void> {
    const value = raw.trim();
    if (value === (current ?? "").trim()) return Promise.resolve();
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
        await saveOneField(field, value);
      } finally {
        mark(false);
      }
    });
    saveQueue.current = run.catch(() => undefined);
    return run;
  }

  async function saveOneField(field: VendorCardField, value: string) {
    const res = await saveVendorField({ name: nameRef.current, field, value });
    if (!res.ok) return toast(res.error ?? "Couldn't save that.", "error");
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

  return (
    <Modal open onClose={onClose} title={vendor.name} size="xl">
      <div className="space-y-5">
        {/* HOW TO REACH THEM. Each box saves when you leave it; the toast has Undo. */}
        <section>
          <h3 className="text-sm font-semibold text-slate-900">Contact</h3>
          {!cardsAvailable && <p className="text-xs text-slate-500">Contact details arrive with the next update.</p>}
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
                  <MapPin className="h-4 w-4" /> Map
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
          {picked ? (
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
