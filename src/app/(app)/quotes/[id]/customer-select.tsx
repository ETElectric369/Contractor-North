"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { User, Pencil, Check, X } from "lucide-react";
import { EditCustomerButton } from "../../crm/[id]/edit-customer-button";
import { Select } from "@/components/ui/input";
import type { Customer } from "@/lib/types";
import { setQuoteCustomer } from "../actions";

interface CustomerLite {
  id: string;
  name: string;
  company_name: string | null;
}

/**
 * The quote's customer — readable (links to the contact) but also editable:
 * a saved quote's customer can be changed/cleared after creation. Mirrors the
 * builder's customer <Select>; persists via setQuoteCustomer.
 */
export function CustomerSelect({
  quoteId,
  customer,
  customers,
}: {
  quoteId: string;
  /** Full customer row (from customers(*)) so EditCustomerButton has all fields. */
  customer: Customer | null;
  customers: CustomerLite[];
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(customer?.id ?? "");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function save() {
    setError(null);
    start(async () => {
      const res = await setQuoteCustomer(quoteId, value || null);
      if (!res.ok) return setError(res.error ?? "Couldn't change the customer.");
      setEditing(false);
      router.refresh();
    });
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
            <option value="">— No customer —</option>
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
        {error && <p className="text-sm text-red-600">{error}</p>}
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between gap-3">
      {customer ? (
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
      ) : (
        <p className="text-sm text-slate-400">No customer attached.</p>
      )}
      <div className="flex shrink-0 items-center gap-2">
        <button
          onClick={() => setEditing(true)}
          className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-800"
          title="Change customer"
        >
          <Pencil className="h-4 w-4 shrink-0" /> Change
        </button>
        {customer && <EditCustomerButton customer={customer} />}
      </div>
    </div>
  );
}
