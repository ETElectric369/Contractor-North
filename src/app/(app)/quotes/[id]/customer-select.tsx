"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { User, Pencil, Check, X, Sprout } from "lucide-react";
import { EditCustomerButton } from "../../crm/[id]/edit-customer-button";
import { Input, Label, Select } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import type { Customer } from "@/lib/types";
import { setQuoteCustomer } from "../actions";
import { createCustomer } from "../../crm/actions";

interface CustomerLite {
  id: string;
  name: string;
  company_name: string | null;
}

/** The lead this estimate came from. A lead is a PERSON WHO HASN'T BOUGHT ANYTHING YET — not a
 *  half-made customer — so it gets its own prop and its own words. */
interface LeadLite {
  id: string;
  name: string | null;
  company_name?: string | null;
  email?: string | null;
  phone?: string | null;
}

/**
 * The quote's customer — readable (links to the contact) but also editable:
 * a saved quote's customer can be changed/cleared after creation. Mirrors the
 * builder's customer <Select>; persists via setQuoteCustomer.
 */
export function CustomerSelect({
  quoteId,
  customer,
  lead = null,
  customers,
}: {
  quoteId: string;
  /** Full customer row (from customers(*)) so EditCustomerButton has all fields. */
  customer: Customer | null;
  /** The lead on quotes.inquiry_id, when there is one. An estimate can sit on a lead alone —
   *  the printed document already coalesces the bill-to block onto it — and this card must say
   *  so instead of reporting a customer-shaped hole. */
  lead?: LeadLite | null;
  customers: CustomerLite[];
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(customer?.id ?? "");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // MAKING ONE FROM HERE. Erik, on the Sarah Cain estimate: "it says sarah cain punch list and no
  // address and i cant even edit it anywhere." The address on a quote comes from the attached
  // customer — quotes.address/city/state/zip are never rendered — and this picker could only
  // choose someone who already existed. First estimate for a new customer was therefore a dead
  // end: no record to pick, no way to make one without leaving the quote and losing your place.
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newAddr, setNewAddr] = useState("");

  function createAndAttach() {
    if (!newName.trim()) return setError("Name is required.");
    setError(null);
    start(async () => {
      const fd = new FormData();
      fd.set("name", newName.trim());
      if (newAddr.trim()) fd.set("address", newAddr.trim());
      const made = await createCustomer(fd);
      if (!made.ok || !made.id) return setError(made.error ?? "Couldn't create the customer.");
      // ATTACH IN THE SAME BREATH. A created-but-unattached customer is the same dead end one
      // step further along, and it's the step somebody walks away from.
      const res = await setQuoteCustomer(quoteId, made.id);
      if (!res.ok) return setError(res.error ?? "Created them, but couldn't attach — pick them from the list.");
      setCreating(false);
      setEditing(false);
      setNewName("");
      setNewAddr("");
      router.refresh();
    });
  }

  function save() {
    setError(null);
    start(async () => {
      const res = await setQuoteCustomer(quoteId, value || null);
      if (!res.ok) return setError(res.error ?? "Couldn't change the customer.");
      setEditing(false);
      router.refresh();
    });
  }

  if (creating) {
    return (
      <div className="space-y-2">
        <div>
          <Label htmlFor="qc-name">Name</Label>
          <Input id="qc-name" autoComplete="name" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Customer name" />
        </div>
        <div>
          <Label htmlFor="qc-addr">Address</Label>
          {/* The one field that made him stuck — it is what prints on the estimate. */}
          <Input id="qc-addr" autoComplete="street-address" value={newAddr} onChange={(e) => setNewAddr(e.target.value)} placeholder="Job address" />
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={createAndAttach} disabled={pending}>Create &amp; attach</Button>
          <Button size="sm" variant="outline" onClick={() => { setCreating(false); setError(null); }} disabled={pending}>Cancel</Button>
        </div>
        <p className="text-xs text-slate-400">Phone, email and the rest can go in from the contact afterwards.</p>
        {error && <p className="text-sm text-red-600">{error}</p>}
      </div>
    );
  }

  if (editing) {
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Select
            value={value}
            onChange={(e) => setValue(e.target.value)}
            disabled={pending}
            aria-label="Customer"
          >
            {/* Say what "none" MEANS when a lead is holding the document — clearing the customer
                doesn't blank the estimate, it leaves it made out to the lead. */}
            <option value="">{lead?.name?.trim() ? `— No customer — leave it with the lead ${lead.name.trim()} —` : "— No customer —"}</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.company_name ? ` (${c.company_name})` : ""}
              </option>
            ))}
          </Select>
          <button
            onClick={save}
            disabled={pending}
            className="shrink-0 rounded-md bg-[rgb(var(--glass-ink))] p-1.5 text-white hover:bg-[rgb(var(--glass-ink))]/90 disabled:opacity-50"
            aria-label="Save customer"
          >
            <Check className="h-4 w-4" />
          </button>
          <button
            onClick={() => {
              setValue(customer?.id ?? "");
              setEditing(false);
              setError(null);
            }}
            disabled={pending}
            className="shrink-0 rounded-md p-1.5 text-slate-400 hover:bg-slate-100"
            aria-label="Cancel"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <button
          onClick={() => { setCreating(true); setError(null); }}
          className="text-xs font-medium text-brand underline-offset-2 hover:underline"
        >
          + New Customer
        </button>
        {error && <p className="text-sm text-red-600">{error}</p>}
      </div>
    );
  }

  // THE TWO ARE NOT THE SAME PERSON-SHAPED THING. A customer is somebody who has bought; a lead
  // is somebody who asked. An estimate is normally written for the second kind, and the win is
  // what mints the first — once. So this card names which one it is holding rather than measuring
  // a lead against a customer-shaped hole and reporting it empty.
  const leadName = lead?.name?.trim() || null;
  return (
    <div className="flex items-start justify-between gap-3">
      {customer ? (
        <div>
          <p className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-400">Customer</p>
          <Link href={`/crm/${customer.id}`} className="flex items-center gap-3 hover:text-brand">
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-slate-100">
              <User className="h-4 w-4 text-slate-500" />
            </div>
            <div>
              <div className="text-sm font-medium text-slate-900">{customer.name}</div>
              <div className="text-xs text-slate-400">
                {customer.email ?? customer.phone ?? customer.company_name ?? ""}
              </div>
            </div>
          </Link>
          {leadName && (
            <p className="mt-1.5 text-xs text-slate-400">Started from the lead {leadName}.</p>
          )}
        </div>
      ) : leadName ? (
        <div>
          <p className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-400">Lead — not a customer yet</p>
          <Link href={`/leads?focus=${lead?.id ?? ""}`} className="flex items-center gap-3 hover:text-brand">
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-amber-50">
              <Sprout className="h-4 w-4 text-amber-600" />
            </div>
            <div>
              <div className="text-sm font-medium text-slate-900">{leadName}</div>
              <div className="text-xs text-slate-400">
                {lead?.email ?? lead?.phone ?? lead?.company_name ?? ""}
              </div>
            </div>
          </Link>
          <p className="mt-1.5 text-xs text-slate-500">
            This estimate is made out to them. They become a customer when you win the work — there&apos;s nothing to
            do here now.
          </p>
        </div>
      ) : (
        <div>
          <p className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-400">Prepared for</p>
          <p className="text-sm text-slate-400">Nobody attached yet — it prints without a name until you pick someone.</p>
        </div>
      )}
      <div className="flex shrink-0 items-center gap-2">
        <button
          onClick={() => setEditing(true)}
          className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-800"
          title={customer ? "Change the customer on this estimate" : "Attach a customer"}
        >
          <Pencil className="h-4 w-4 shrink-0" /> {customer ? "Change" : "Attach Customer"}
        </button>
        {customer && <EditCustomerButton customer={customer} />}
      </div>
    </div>
  );
}
