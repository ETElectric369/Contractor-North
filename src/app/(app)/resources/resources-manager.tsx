"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, Pencil, Trash2, Search, Phone, Mail, Globe, MapPin } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/components/toast";
import { createResource, updateResource, deleteResource } from "./actions";

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

export const CATEGORIES = [
  "Building Department",
  "Inspector",
  "Permit Portal",
  "Utility",
  "Supplier / Distributor",
  "Engineer",
  "Fire / AHJ",
  "Other",
];

function withProtocol(url: string) {
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

export function ResourcesManager({ resources }: { resources: Resource[] }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [q, setQ] = useState("");
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [category, setCategory] = useState("Building Department");
  const [contact, setContact] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [website, setWebsite] = useState("");
  const [address, setAddress] = useState("");
  const [notes, setNotes] = useState("");

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

  function resetForm() {
    setName(""); setCategory("Building Department"); setContact(""); setPhone(""); setEmail(""); setWebsite(""); setAddress(""); setNotes("");
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
    setName(r.name);
    setCategory(r.category || "Building Department");
    setContact(r.contact_name ?? "");
    setPhone(r.phone ?? "");
    setEmail(r.email ?? "");
    setWebsite(r.website ?? "");
    setAddress(r.address ?? "");
    setNotes(r.notes ?? "");
  }

  function save() {
    setError(null);
    if (!name.trim()) return setError("Name is required.");
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
        <Button size="sm" onClick={() => { if (adding) { closeForm(); } else { setEditingId(null); setError(null); resetForm(); setAdding(true); } }}><Plus className="h-3.5 w-3.5" /> Add Contact</Button>
      </div>

      {(adding || editingId) && (
        <Card className="space-y-3 p-4">
          <div className="text-sm font-semibold text-slate-700">{editingId ? "Edit contact" : "New contact"}</div>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <div className="col-span-2 sm:col-span-1"><Label htmlFor="r-name">Name *</Label><Input id="r-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Washoe County Building" /></div>
            <div><Label htmlFor="r-cat">Category</Label><Select id="r-cat" value={category} onChange={(e) => setCategory(e.target.value)}>{CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}</Select></div>
            <div><Label htmlFor="r-contact">Contact person</Label><Input id="r-contact" value={contact} onChange={(e) => setContact(e.target.value)} /></div>
            <div><Label htmlFor="r-phone">Phone</Label><Input id="r-phone" value={phone} onChange={(e) => setPhone(e.target.value)} /></div>
            <div><Label htmlFor="r-email">Email</Label><Input id="r-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></div>
            <div className="col-span-2"><Label htmlFor="r-web">Website / portal</Label><Input id="r-web" value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="e.g. washoecounty.gov/building" /></div>
            <div className="col-span-2 sm:col-span-1"><Label htmlFor="r-addr">Address</Label><Input id="r-addr" value={address} onChange={(e) => setAddress(e.target.value)} /></div>
          </div>
          <div><Label htmlFor="r-notes">Notes</Label><Textarea id="r-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Hours, account #, inspection request line, etc." /></div>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="outline" onClick={closeForm}>Cancel</Button>
            <Button size="sm" onClick={save} disabled={pending || !name.trim()}>{pending ? "Saving…" : editingId ? "Save Changes" : "Save Contact"}</Button>
          </div>
        </Card>
      )}

      {resources.length === 0 ? (
        <p className="py-10 text-center text-sm text-slate-400">
          No contacts yet. Add your building department, inspectors, utilities (e.g. NV Energy), and permit portals.
        </p>
      ) : (
        groups.map(([cat, list]) => (
          <div key={cat}>
            <div className="mb-2 flex items-center gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">{cat}</h3>
              <Badge tone="slate">{list.length}</Badge>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {list.map((r) => (
                <Card key={r.id} className="p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-medium text-slate-900">{r.name}</div>
                      {r.contact_name && <div className="text-xs text-slate-400">{r.contact_name}</div>}
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <button onClick={() => startEdit(r)} className="text-slate-300 hover:text-brand" title="Edit"><Pencil className="h-4 w-4" /></button>
                      <button onClick={() => { if (confirm(`Delete ${r.name}?`)) start(async () => { const res = await deleteResource(r.id); if (!res?.ok) { toast(res?.error ?? "Couldn't delete — try again.", "error"); return; } toast("Contact deleted", "success"); router.refresh(); }); }} className="text-slate-300 hover:text-red-600" title="Delete"><Trash2 className="h-4 w-4" /></button>
                    </div>
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
