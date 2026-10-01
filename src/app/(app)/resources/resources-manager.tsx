"use client";

import { useMemo, useRef, useState, useTransition, type ClipboardEvent, type MouseEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Plus, Pencil, Trash2, Search, Phone, Mail, Globe, MapPin, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { toneClasses } from "@/components/ui/badge";
import { EmptyState } from "@/components/page-header";
import { useToast } from "@/components/toast";
import { cn, formatPhone } from "@/lib/utils";
import { applySiteFill, emptyBoxes, fillSummary, looksLikeWebAddress, siteToForm, siteUrl, withoutSiteFill, type FillKey } from "@/lib/site-read/form-fill";
import { createResource, updateResource, deleteResource } from "./actions";
import { fillFromSite } from "./fill-from-site";
import { RESOURCE_CATEGORIES, SUPPLIERS_LIVE_IN_VENDORS, VENDORS_HREF, categoryChoices } from "./categories";

export interface Resource {
  id: string;
  name: string;
  category: string;
  contact_name: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  address: string | null;
  notes: string | null;
}

export const CATEGORIES = RESOURCE_CATEGORIES;

export type Form = { name: string; category: string; contact: string; phone: string; email: string; website: string; address: string; notes: string };
const EMPTY_FORM: Form = { name: "", category: "Building Department", contact: "", phone: "", email: "", website: "", address: "", notes: "" };
type FillNote = { tone: "ok" | "warn" | "error"; text: string };

/** Said before Open Vendors leaves a form that holds something typed or filled. */
export const LEAVE_FOR_VENDORS = "Open Vendors? What you typed here won't be saved.";

/** A saved contact as the form shows it. */
export function resourceForm(r: Resource): Form {
  return {
    name: r.name,
    category: r.category || "Building Department",
    contact: r.contact_name ?? "",
    phone: r.phone ?? "",
    email: r.email ?? "",
    website: r.website ?? "",
    address: r.address ?? "",
    notes: r.notes ?? "",
  };
}

/** Does the form hold work that leaving would throw away? Any box that differs from how it opened
 *  (empty for a new contact, the saved row for an edit), whether typed or filled from their site.
 *  Spaces alone are not work. */
export function formHasWork(form: Form, start: Form): boolean {
  return (Object.keys(start) as (keyof Form)[]).some((k) => form[k].trim() !== start[k].trim());
}

function withProtocol(url: string) {
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

/** `canEdit` is false for a tech: add, edit and delete are staff-only, so they don't render. */
export function ResourcesManager({ resources, canEdit }: { resources: Resource[]; canEdit: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [q, setQ] = useState("");
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [form, setForm] = useState<Form>(EMPTY_FORM);
  const [categoryTouched, setCategoryTouched] = useState(false);
  /** Boxes the site filled, marked until the person edits one or saves. */
  const [fromSite, setFromSite] = useState<Set<FillKey>>(new Set());
  const [reading, setReading] = useState(false);
  const [fillNote, setFillNote] = useState<FillNote | null>(null);
  /** Say so when the Website box holds something that can't be read, once the person has left it
   *  (or pasted), never mid-typing: otherwise the disabled Fill button is a dead end with no reason. */
  const [webHint, setWebHint] = useState(false);
  const { name, category, contact, phone, email, website, address, notes } = form;
  // Category has a default, so it is "empty" only on a new contact nobody has picked one for.
  const categoryOpen = !editingId && !categoryTouched;
  // The form as it is NOW, for a site read that lands after the person kept typing: it fills what
  // is empty then, never what was empty when the read began. `session` changes whenever the form
  // is opened, closed or switched to another contact, so a late answer never fills the wrong one.
  // `readingUrl` is the address being read now (null: none), `nextUrl` one pasted meanwhile.
  const live = useRef({ form, categoryOpen, fromSite, session: 0, readingUrl: null as string | null, nextUrl: null as string | null });
  live.current.form = form;
  live.current.categoryOpen = categoryOpen;
  live.current.fromSite = fromSite;
  /** The form as a new read sees it: boxes the last read filled (still marked, untouched) are open
   *  again, so reading another address replaces the first site's details instead of keeping them. */
  const openForm = () => withoutSiteFill(live.current.form, live.current.fromSite, EMPTY_FORM);

  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return resources;
    return resources.filter((r) =>
      [r.name, r.category, r.contact_name, r.phone, r.email, r.address, r.notes].some((v) => (v ?? "").toLowerCase().includes(t)),
    );
  }, [resources, q]);

  const groups = useMemo(() => {
    const m = new Map<string, Resource[]>();
    for (const r of filtered) {
      const k = r.category || "Other";
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(r);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [filtered]);

  /** Set one box. Editing a box the site filled takes its mark off: it's the person's now. */
  function set<K extends keyof Form>(key: K, value: Form[K]) {
    setForm((f) => ({ ...f, [key]: value }));
    if (key === "category") setCategoryTouched(true);
    setFromSite((s) => {
      if (!s.has(key as FillKey)) return s;
      const n = new Set(s);
      n.delete(key as FillKey);
      return n;
    });
  }

  function resetForm() {
    live.current.session++;
    // A read still out belongs to the form that was open: its answer is thrown away (the session
    // check), and the new form is not left "Reading Their Site…" with Save disabled waiting for it.
    live.current.readingUrl = null;
    live.current.nextUrl = null;
    setReading(false);
    setForm(EMPTY_FORM);
    setCategoryTouched(false);
    setFromSite(new Set());
    setFillNote(null);
    setWebHint(false);
  }

  function closeForm() {
    setAdding(false);
    setEditingId(null);
    setError(null);
    resetForm();
  }

  function startEdit(r: Resource) {
    setError(null);
    setAdding(false);
    setEditingId(r.id);
    resetForm();
    setForm(resourceForm(r));
  }

  /** OPEN VENDORS leaves this page, and the form with it: anything typed or filled from their site
   *  (a new contact's boxes, or an edit to one) is thrown away only when the person says so. */
  function openVendors(e: MouseEvent<HTMLAnchorElement>) {
    const row = editingId ? resources.find((r) => r.id === editingId) : null;
    const start = row ? resourceForm(row) : EMPTY_FORM;
    if (formHasWork(form, start) && !window.confirm(LEAVE_FOR_VENDORS)) e.preventDefault();
  }

  /** FILL FROM THEIR SITE: read the page, fill the EMPTY boxes, mark them. Nothing saves until Save.
   *  Everything it reads goes through `live` (never this render's state), because it outlives the
   *  render it started in: a paste calls it from a timer, and a queued address calls it again. */
  async function fillFromTheirSite(url: string) {
    if (!looksLikeWebAddress(url)) return;
    const now = live.current;
    // One read at a time. An address pasted while one is out is read NEXT (the newest wins, and
    // re-pasting the one being read cancels the queue); the one out is then thrown away, since its
    // answer is for an address no longer in the box. The spinner stays up throughout.
    if (now.readingUrl !== null) {
      now.nextUrl = siteUrl(url) === siteUrl(now.readingUrl) ? null : url;
      return;
    }
    const session = now.session;
    now.readingUrl = url;
    setReading(true);
    setFillNote(null);
    const superseded = () => session !== live.current.session || live.current.nextUrl !== null;
    try {
      const res = await fillFromSite({ url, need: emptyBoxes(openForm(), { categoryOpen: live.current.categoryOpen }) });
      if (superseded()) return;
      // The Website box was changed by hand while this read was out: its details aren't the box's.
      if (siteUrl(live.current.form.website) !== siteUrl(url)) {
        setFillNote({ tone: "warn", text: "The address changed while reading, so nothing was filled. Tap Fill From Their Site." });
        return;
      }
      if (!res.ok) {
        setFillNote({ tone: "error", text: res.error });
        return;
      }
      const found = siteToForm(res.fields);
      // The form as it is NOW, with the last read's untouched boxes open: this read's details
      // replace them whole, and the marks are this read's alone.
      const before = openForm();
      const { next, filled } = applySiteFill(before, found, { categoryOpen: live.current.categoryOpen });
      setForm(next);
      setFromSite(new Set(filled));
      setFillNote({ tone: filled.length ? "ok" : "warn", text: [fillSummary(before, found, filled), res.note].filter(Boolean).join(" ") });
    } catch {
      if (!superseded()) setFillNote({ tone: "error", text: "Couldn't read that site. Check your connection, or type the details in." });
    } finally {
      // Only this form's read may end this form's reading: a read from a form since closed or
      // switched must not end one the new form started.
      if (session === live.current.session) {
        const next = live.current.nextUrl;
        live.current.readingUrl = null;
        live.current.nextUrl = null;
        if (next) void fillFromTheirSite(next);
        else setReading(false);
      }
    }
  }

  /** A pasted web address reads the site straight away, while there is a box left to fill. */
  function onWebsitePaste(e: ClipboardEvent<HTMLInputElement>) {
    const el = e.currentTarget;
    const pasted = e.clipboardData.getData("text");
    const willBe = (el.value.slice(0, el.selectionStart ?? el.value.length) + pasted + el.value.slice(el.selectionEnd ?? el.value.length)).trim();
    if (!looksLikeWebAddress(willBe)) {
      // After the change the paste makes (which clears the hint), so it shows.
      setTimeout(() => setWebHint(true), 0);
      return;
    }
    if (emptyBoxes(openForm(), { categoryOpen: live.current.categoryOpen }).length === 0) return;
    setTimeout(() => void fillFromTheirSite(willBe), 0);
  }

  /** The mark on a box the site filled: a tinted box, and a tag by its label. */
  const marked = (k: FillKey) => (fromSite.has(k) ? "bg-blue-50 ring-1 ring-blue-300" : "");
  const siteTag = (k: FillKey) =>
    fromSite.has(k) ? <span className={cn("ml-1.5 rounded-full px-1.5 py-0.5 text-[10px] font-medium", toneClasses("blue"))}>From their site</span> : null;

  function save() {
    setError(null);
    if (!name.trim()) return setError("Name is required.");
    if (reading) return setError("Still reading their site. Save in a moment.");
    const input = { name, category, contact_name: contact, phone, email, website, address, notes };
    start(async () => {
      const res = editingId ? await updateResource(editingId, input) : await createResource(input);
      if (!res.ok) return setError(res.error ?? "Could not save.");
      closeForm();
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search contacts…" className="pl-9" />
        </div>
        {canEdit && <Button onClick={() => { if (adding) { closeForm(); } else { setEditingId(null); setError(null); resetForm(); setAdding(true); } }}><Plus className="h-3.5 w-3.5" /> Add Contact</Button>}
      </div>

      {canEdit && (adding || editingId) && (
        <Card className="space-y-3 p-4">
          <div className="text-sm font-semibold text-slate-700">{editingId ? "Edit contact" : "New contact"}</div>
          {error && <p className="text-sm text-red-600">{error}</p>}
          {/* Their website first: paste it, and the empty boxes below fill from their site. */}
          <div>
            <Label htmlFor="r-web">Website</Label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                id="r-web"
                inputMode="url"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                value={website}
                onChange={(e) => {
                  set("website", e.target.value);
                  setWebHint(false);
                }}
                onBlur={() => setWebHint(true)}
                onPaste={onWebsitePaste}
                placeholder="Paste their site, e.g. yourcounty.gov/building"
                className="h-11 min-w-0 flex-1"
              />
              <Button
                type="button"
                variant="outline"
                onClick={() => void fillFromTheirSite(website)}
                disabled={reading || !looksLikeWebAddress(website)}
                className="shrink-0"
              >
                {reading ? <Loader2 className="animate-spin" /> : <Globe />}
                {reading ? "Reading Their Site…" : "Fill From Their Site"}
              </Button>
            </div>
            {webHint && website.trim() && !looksLikeWebAddress(website) && (
              <p className="mt-1.5 text-sm text-amber-700">
                That doesn&apos;t look like a web address, so it can&apos;t be read. Paste the site&apos;s address, like yourcounty.gov/building.
              </p>
            )}
            {fillNote && (
              <p
                role="status"
                aria-live="polite"
                className={cn("mt-1.5 text-sm", fillNote.tone === "error" ? "text-red-600" : fillNote.tone === "warn" ? "text-amber-700" : "text-slate-600")}
              >
                {fillNote.text}
              </p>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <div className="col-span-2 sm:col-span-1"><Label htmlFor="r-name">Name *{siteTag("name")}</Label><Input id="r-name" value={name} onChange={(e) => set("name", e.target.value)} placeholder="e.g. County Building Department" className={marked("name")} /></div>
            <div>
              <Label htmlFor="r-cat">Category{siteTag("category")}</Label>
              {/* A category from before the list changed (Supplier / Distributor, or Nort's own word)
                  stays this contact's: shown as its current pick, never offered (categoryChoices), so a
                  save can't quietly swap it for the first one on the list. */}
              <Select id="r-cat" value={category} onChange={(e) => set("category", e.target.value)} className={marked("category")}>
                {categoryChoices(category).map((c) => (
                  <option key={c.value} value={c.value} disabled={c.disabled}>
                    {c.value}
                  </option>
                ))}
              </Select>
              {/* Staff only: this whole form is behind canEdit, so a tech never gets a door to the
                  Price List (and its prices). */}
              <p className="mt-1 text-xs text-slate-500">
                {SUPPLIERS_LIVE_IN_VENDORS}{" "}
                <Link href={VENDORS_HREF} className="inline-flex min-h-11 items-center font-medium text-brand hover:underline" onClick={openVendors}>
                  Open Vendors
                </Link>
              </p>
            </div>
            <div><Label htmlFor="r-contact">Contact person</Label><Input id="r-contact" value={contact} onChange={(e) => set("contact", e.target.value)} /></div>
            <div><Label htmlFor="r-phone">Phone{siteTag("phone")}</Label><Input id="r-phone" type="tel" inputMode="tel" value={phone} onChange={(e) => set("phone", formatPhone(e.target.value))} className={marked("phone")} /></div>
            <div><Label htmlFor="r-email">Email{siteTag("email")}</Label><Input id="r-email" type="email" value={email} onChange={(e) => set("email", e.target.value)} className={marked("email")} /></div>
            <div className="col-span-2 sm:col-span-3"><Label htmlFor="r-addr">Address{siteTag("address")}</Label><Input id="r-addr" value={address} onChange={(e) => set("address", e.target.value)} className={marked("address")} /></div>
          </div>
          <div><Label htmlFor="r-notes">Notes{siteTag("notes")}</Label><Textarea id="r-notes" rows={2} value={notes} onChange={(e) => set("notes", e.target.value)} placeholder="Hours, account #, inspection request line, etc." className={marked("notes")} /></div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={closeForm} className="sm:h-8 sm:px-3">Cancel</Button>
            <Button onClick={save} disabled={pending || reading || !name.trim()} className="sm:h-8 sm:px-3">{pending ? "Saving…" : editingId ? "Save Changes" : "Save Contact"}</Button>
          </div>
        </Card>
      )}

      {resources.length === 0 ? (
        <EmptyState
          icon={MapPin}
          title="No contacts yet"
          description={canEdit ? "Add your building department, inspectors, utilities, and permit portals." : "The office adds these."}
        />
      ) : (
        groups.map(([cat, list]) => (
          <div key={cat}>
            <div className="mb-2 flex items-center gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">{cat}</h3>
              {/* How many contacts: a total, so plain muted text, never a badge (every badge counts
                  only what's open, Erik 2026-09-27). */}
              <span className="text-xs text-slate-400">{list.length}</span>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {list.map((r) => (
                <Card key={r.id} className="p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-medium text-slate-900">{r.name}</div>
                      {r.contact_name && <div className="text-xs text-slate-400">{r.contact_name}</div>}
                    </div>
                    {canEdit && <div className="flex shrink-0 items-center gap-2">
                      <button type="button" onClick={() => startEdit(r)} className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-slate-300 hover:text-brand" title="Edit" aria-label="Edit"><Pencil className="h-4 w-4" /></button>
                      <button onClick={() => { if (confirm(`Delete ${r.name}?`)) start(async () => { const res = await deleteResource(r.id); if (!res?.ok) { toast(res?.error ?? "Couldn't delete — try again.", "error"); return; } toast("Contact deleted", "success"); router.refresh(); }); }} className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-slate-300 hover:text-red-600" title="Delete" aria-label="Delete"><Trash2 className="h-4 w-4" /></button>
                    </div>}
                  </div>
                  <div className="mt-2 space-y-1 text-sm">
                    {r.phone && <a href={`tel:${r.phone}`} className="flex items-center gap-2 text-slate-600 hover:text-brand"><Phone className="h-3.5 w-3.5 text-slate-400" /> {r.phone}</a>}
                    {r.email && <a href={`mailto:${r.email}`} className="flex items-center gap-2 text-slate-600 hover:text-brand"><Mail className="h-3.5 w-3.5 text-slate-400" /> {r.email}</a>}
                    {r.website && <a href={withProtocol(r.website)} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 truncate text-slate-600 hover:text-brand"><Globe className="h-3.5 w-3.5 shrink-0 text-slate-400" /> <span className="truncate">{r.website}</span></a>}
                    {r.address && <div className="flex items-center gap-2 text-slate-500"><MapPin className="h-3.5 w-3.5 text-slate-400" /> {r.address}</div>}
                  </div>
                  {r.notes && <div className="mt-2 whitespace-pre-wrap border-t border-slate-100 pt-2 text-xs text-slate-500">{r.notes}</div>}
                </Card>
              ))}
            </div>
          </div>
        ))
      )}
    </div>
  );
}
