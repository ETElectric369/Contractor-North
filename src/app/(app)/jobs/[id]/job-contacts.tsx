"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Plus, Trash2, HardHat } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label, Select } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { useToast } from "@/components/toast";
import { linkJobContact, unlinkJobContact } from "./job-contacts-actions";

export type LinkedContact = { id: string; role: string; customer_id: string; name: string; phone: string | null };
export type ContactOption = { id: string; name: string; type: string | null };

const ROLES = ["Subcontractor", "Supplier", "Inspector", "Engineer / Architect", "General Contractor", "Other"];

export function JobContacts({
  jobId,
  contacts,
  options,
}: {
  jobId: string;
  contacts: LinkedContact[];
  options: ContactOption[];
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [customerId, setCustomerId] = useState("");
  const [role, setRole] = useState("Subcontractor");

  function add() {
    setError(null);
    if (!customerId) return setError("Pick a contact.");
    start(async () => {
      const res = await linkJobContact(jobId, customerId, role);
      if (!res.ok) return setError(res.error ?? "Could not link.");
      setCustomerId("");
      setRole("Subcontractor");
      setAdding(false);
      toast("Contact linked", "success");
      router.refresh();
    });
  }

  return (
    <Card className="p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-semibold text-slate-700">
          <HardHat className="h-4 w-4 text-slate-400" /> Subs &amp; contacts
        </div>
        <Button size="sm" variant="outline" onClick={() => setAdding((a) => !a)}>
          <Plus className="h-3.5 w-3.5" /> Add
        </Button>
      </div>

      {adding && (
        <div className="mb-3 space-y-2 rounded-lg border border-slate-200 bg-slate-50/60 p-3">
          {error && <p className="text-sm text-red-600">{error}</p>}
          <div className="grid grid-cols-2 gap-2">
            <div className="col-span-2 sm:col-span-1">
              <Label htmlFor="jc-cust">Contact</Label>
              <Select id="jc-cust" value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
                <option value="">— pick a contact —</option>
                {options.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                    {o.type === "subcontractor" ? " (sub)" : ""}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label htmlFor="jc-role">Role</Label>
              <Select id="jc-role" value={role} onChange={(e) => setRole(e.target.value)}>
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </Select>
            </div>
          </div>
          <p className="text-[11px] text-slate-400">Add a contact to the book first (Contacts → New customer → type Subcontractor), then link them here.</p>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="outline" onClick={() => setAdding(false)}>Cancel</Button>
            <Button size="sm" onClick={add} disabled={pending || !customerId}>{pending ? "Linking…" : "Link"}</Button>
          </div>
        </div>
      )}

      {contacts.length === 0 ? (
        <p className="py-3 text-center text-xs text-slate-400">No subs or extra contacts on this job yet.</p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {contacts.map((c) => (
            <li key={c.id} className="flex items-center justify-between gap-2 py-2">
              <div className="min-w-0">
                <Link href={`/crm/${c.customer_id}`} className="font-medium text-slate-800 hover:text-brand">
                  {c.name}
                </Link>
                <span className="ml-2 rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                  {c.role}
                </span>
                {c.phone && <span className="ml-2 text-xs text-slate-400">{c.phone}</span>}
              </div>
              <button
                onClick={() => start(async () => { const res = await unlinkJobContact(c.id, jobId); if (!res?.ok) { toast(res?.error ?? "Couldn't remove contact — try again.", "error"); return; } toast("Contact removed", "success"); router.refresh(); })}
                className="text-slate-300 hover:text-red-600"
                title="Remove"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
