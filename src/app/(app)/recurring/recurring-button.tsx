"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal, ModalActions } from "@/components/ui/modal";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { formatCurrency } from "@/lib/utils";
import { saveRecurring, deleteRecurring } from "./actions";

interface CustomerOpt { id: string; name: string }
interface LineItem { description: string; quantity: number; unit_price: number }

export interface RecurringValue {
  id: string;
  kind: string;
  title: string;
  frequency: string;
  next_date: string;
  customer_id: string | null;
  description: string | null;
  amount: number | null;
  category: string | null;
  vendor: string | null;
  tax_rate?: number | null;
  auto_send?: boolean | null;
  line_items?: LineItem[] | null;
}

export function RecurringButton({
  customers,
  template,
}: {
  customers: CustomerOpt[];
  template?: RecurringValue;
}) {
  const router = useRouter();
  const editing = !!template;
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState(template?.kind ?? "job");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // Recurring-invoice line items. Seed from the template's items, or a single line
  // from an older single-amount template, or one blank row for a new one.
  const [items, setItems] = useState<LineItem[]>(
    template?.line_items?.length
      ? template.line_items.map((x) => ({ description: x.description ?? "", quantity: Number(x.quantity) || 1, unit_price: Number(x.unit_price) || 0 }))
      : template?.kind === "invoice" && template?.amount
        ? [{ description: template.title ?? "", quantity: 1, unit_price: Number(template.amount) || 0 }]
        : [{ description: "", quantity: 1, unit_price: 0 }],
  );
  const itemsTotal = items.reduce((s, x) => s + (Number(x.quantity) || 1) * (Number(x.unit_price) || 0), 0);
  const setItem = (i: number, patch: Partial<LineItem>) => setItems((arr) => arr.map((x, idx) => (idx === i ? { ...x, ...patch } : x)));
  const addItem = () => setItems((arr) => [...arr, { description: "", quantity: 1, unit_price: 0 }]);
  const removeItem = (i: number) => setItems((arr) => (arr.length > 1 ? arr.filter((_, idx) => idx !== i) : arr));

  function submit(formData: FormData) {
    setError(null);
    start(async () => {
      const res = await saveRecurring(formData, template?.id);
      if (!res.ok) return setError(res.error ?? "Could not save.");
      setOpen(false);
      router.refresh();
    });
  }
  function remove() {
    if (!template) return;
    if (!confirm(`Delete the recurring "${template.title}"? It will stop generating going forward.`)) return;
    start(async () => {
      await deleteRecurring(template.id);
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <>
      {editing ? (
        <button onClick={() => setOpen(true)} className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700" title="Edit">
          <Pencil className="h-4 w-4" />
        </button>
      ) : (
        <Button onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> New recurring</Button>
      )}

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={editing ? "Edit recurring" : "New recurring"}
        footer={
          <ModalActions
            onCancel={() => setOpen(false)}
            submit
            formId="recurring-form"
            saving={pending}
            saveLabel="Save changes"
            extra={
              editing ? (
                <Button type="button" variant="outline" onClick={remove} disabled={pending} className="text-red-600">Delete</Button>
              ) : undefined
            }
          />
        }
      >
        <form id="recurring-form" action={submit} className="space-y-4">
          {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="r-kind">Type</Label>
              <Select id="r-kind" name="kind" value={kind} onChange={(e) => setKind(e.target.value)}>
                <option value="job">Recurring job</option>
                <option value="invoice">Recurring invoice</option>
                <option value="expense">Recurring expense</option>
              </Select>
            </div>
            <div>
              <Label htmlFor="r-freq">Repeats</Label>
              <Select id="r-freq" name="frequency" defaultValue={template?.frequency ?? "monthly"}>
                <option value="weekly">Weekly</option>
                <option value="biweekly">Every 2 weeks</option>
                <option value="monthly">Monthly</option>
                <option value="quarterly">Quarterly</option>
                <option value="yearly">Yearly</option>
              </Select>
            </div>
          </div>

          <div>
            <Label htmlFor="r-title">Title</Label>
            <Input id="r-title" name="title" defaultValue={template?.title ?? ""} placeholder={kind === "job" ? "e.g. Monthly maintenance — Acme" : kind === "invoice" ? "e.g. Monthly service agreement" : "e.g. Shop rent"} required />
          </div>

          <div>
            <Label htmlFor="r-next">Next date</Label>
            <Input id="r-next" name="next_date" type="date" defaultValue={template?.next_date ?? ""} required />
          </div>

          {kind === "job" ? (
            <>
              <div>
                <Label htmlFor="r-cust">Customer</Label>
                <Select id="r-cust" name="customer_id" defaultValue={template?.customer_id ?? ""}>
                  <option value="">—</option>
                  {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </Select>
              </div>
              <div>
                <Label htmlFor="r-desc">Description</Label>
                <Textarea id="r-desc" name="description" rows={2} defaultValue={template?.description ?? ""} />
              </div>
            </>
          ) : kind === "invoice" ? (
            <>
              <div>
                <Label htmlFor="r-icust">Customer</Label>
                <Select id="r-icust" name="customer_id" defaultValue={template?.customer_id ?? ""} required>
                  <option value="">—</option>
                  {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </Select>
              </div>
              <div>
                <Label>Line items</Label>
                <div className="space-y-2">
                  {items.map((it, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <Input value={it.description} onChange={(e) => setItem(i, { description: e.target.value })} placeholder="Description" className="flex-1" />
                      <Input type="number" step="1" min="0" value={it.quantity} onChange={(e) => setItem(i, { quantity: Number(e.target.value) })} className="w-14 text-center" title="Qty" />
                      <Input type="number" step="0.01" min="0" value={it.unit_price} onChange={(e) => setItem(i, { unit_price: Number(e.target.value) })} className="w-24 text-right" placeholder="Price" title="Unit price" />
                      <button type="button" onClick={() => removeItem(i)} className="shrink-0 text-slate-300 hover:text-red-600" aria-label="Remove line">
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  ))}
                </div>
                <div className="mt-1.5 flex items-center justify-between">
                  <button type="button" onClick={addItem} className="text-sm font-medium text-brand hover:underline">+ Add line</button>
                  <span className="text-sm font-semibold text-slate-900">Subtotal: {formatCurrency(itemsTotal)}</span>
                </div>
                <input type="hidden" name="line_items" value={JSON.stringify(items)} />
              </div>
              <div className="w-32">
                <Label htmlFor="r-itax">Tax (%)</Label>
                <Input id="r-itax" name="tax_pct" type="number" step="0.001" min="0" defaultValue={(template as { tax_rate?: number } | undefined)?.tax_rate ? Number((template as { tax_rate?: number }).tax_rate) * 100 : ""} placeholder="0" />
              </div>
              <label className="flex items-start gap-2 text-sm text-slate-700">
                <input type="checkbox" name="auto_send" defaultChecked={(template as { auto_send?: boolean } | undefined)?.auto_send ?? false} className="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand" />
                <span>Email it to the customer automatically each time<span className="block text-xs text-slate-500">Off = generated as a draft for you to review and send.</span></span>
              </label>
            </>
          ) : (
            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-2">
                <Label htmlFor="r-vendor">Vendor</Label>
                <Input id="r-vendor" name="vendor" defaultValue={template?.vendor ?? ""} placeholder="e.g. landlord" />
              </div>
              <div>
                <Label htmlFor="r-amt">Amount</Label>
                <Input id="r-amt" name="amount" type="number" step="0.01" min="0" defaultValue={template?.amount ?? ""} />
              </div>
              <div className="col-span-3">
                <Label htmlFor="r-cat">Category</Label>
                <Input id="r-cat" name="category" defaultValue={template?.category ?? ""} placeholder="e.g. Rent, Insurance, Software" />
              </div>
            </div>
          )}
        </form>
      </Modal>
    </>
  );
}
