"use client";

import { useState, useTransition } from "react";
import { AddLineItems, type PriceItemLite } from "@/components/add-line-items";
import { useRouter } from "next/navigation";
import { Plus, Trash2, Pencil, Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal, ModalActions } from "@/components/ui/modal";
import { Input, Label, Textarea } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Card } from "@/components/ui/card";
import { formatCurrency } from "@/lib/utils";
import { LineItemText } from "@/components/line-item-text";
import type { Quote, QuoteLineItem } from "@/lib/types";
import { addQuoteItem, updateQuoteItem, deleteQuoteItem, updateQuoteMeta } from "../actions";

/** Editable line items + totals + header details for a saved quote.
 *
 *  THE LOCKED ESTIMATE SHOWED EVERY EDITING CONTROL IT HAD (2026-09-18 sweep, the INV-069 wave).
 *
 *  The pencil, the trash, the price-list picker and the type-one row rendered at every status.
 *  On a locked estimate every one of them called an action that could only refuse — and the
 *  refusal arrived as a red line under the card AFTER the click, which is the same conversation
 *  Erik had with INV-069: press the control the screen is offering, get told the row was never
 *  yours to change. Worst of all on a kit: the loop added lines one at a time, so the first
 *  refusal came after nothing had landed, on a screen still covered in live-looking controls.
 *
 *  requireEditableQuote (quotes/actions.ts) is the rule, quoted exactly:
 *    if ((quote as any).status !== "accepted") return { ok: true };
 *    const jobId = (quote as any).job_id as string | null;
 *    if (!jobId) return { ok: true };                 // accepted but no job yet
 *    …signed contract on the job  -> refused
 *    …a milestone linked to a non-void invoice -> refused
 *  Note how narrow that is. "Accepted" alone is NOT the lock — Erik's own comment on the guard
 *  says a scope change after acceptance is a legitimate business event, and an accepted estimate
 *  with no signed contract and no drawn milestone stays fully editable. So this component will
 *  not guess from `quote.status`: gating on accepted-alone would hide controls that work, which
 *  is the same bug pointed the other way. The page does the two reads the guard does and hands
 *  the answer down as `lock`; absent it, nothing changes and the server still answers.
 *
 *  What stays editable when locked is exactly what the server still accepts: updateQuoteMeta
 *  only consults the guard `if (meta.tax_rate !== undefined)`, so the title, the scope
 *  paragraph and the notes keep their live controls, and only the tax rate becomes text. */
export function QuoteItemsEditor({
  quote,
  items,
  priceItems = [],
  kits = [],
  defaultMarkupPct = 0,
  levelMarkupPct = null,
  lock = null,
}: {
  quote: Quote;
  items: QuoteLineItem[];
  priceItems?: PriceItemLite[];
  kits?: { id: string; name: string; kit_items: unknown[] }[];
  defaultMarkupPct?: number;
  /** The customer's pricing-level markup. null = the customer has no level — NEVER 0, which would
   *  price them at net cost, because effectiveMarkupPct returns on ANY finite level including 0. */
  levelMarkupPct?: number | null;
  /** Non-null when requireEditableQuote would refuse a line change on this estimate. `reason` is
   *  the plain sentence shown where the editing controls were — it must say what the user CAN do
   *  (duplicate it as a revision), because a control that simply vanishes is its own dead end. */
  lock?: { reason: string } | null;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const refresh = () => router.refresh();

  // add-item state
  const [desc, setDesc] = useState("");
  const [qty, setQty] = useState(1);
  const [unit, setUnit] = useState("ea");
  const [price, setPrice] = useState(0);

  // edit-item state
  const [editId, setEditId] = useState<string | null>(null);
  const [editDesc, setEditDesc] = useState("");
  const [editQty, setEditQty] = useState(1);
  const [editUnit, setEditUnit] = useState("ea");
  const [editPrice, setEditPrice] = useState(0);

  // details modal state
  const [detailsOpen, setDetailsOpen] = useState(false);

  // THE SCOPE PARAGRAPH, ON THE PAGE. Erik, mid-estimate on Sarah Cain: "theres nowhere to add a
  // description at the top." It WAS there — behind a button labelled "Edit Details", docked to the
  // Line items card. Which is two clicks and a wrong label for the first thing the customer reads.
  // Invoices already got this right (billing/[id]/invoice-detail.tsx): its own box, always visible,
  // its own Save. He asked for the same here, so this is the same box, not a second design.
  const [descrSaved, setDescrSaved] = useState(false);
  const [title, setTitle] = useState(quote.title ?? "");
  const [description, setDescription] = useState((quote as any).description ?? "");
  const [notes, setNotes] = useState(quote.notes ?? "");
  const [taxPct, setTaxPct] = useState(Number(quote.tax_rate) * 100);
  const [validUntil, setValidUntil] = useState(quote.valid_until?.slice(0, 10) ?? "");
  const [error, setError] = useState<string | null>(null);

  function addItem() {
    if (!desc.trim()) return;
    setError(null);
    start(async () => {
      const res = await addQuoteItem(quote.id, { description: desc.trim(), quantity: qty, unit: unit.trim() || "ea", unit_price: price });
      if (!res.ok) return setError(res.error ?? "Couldn't add the item.");
      setDesc("");
      setQty(1);
      setUnit("ea");
      setPrice(0);
      refresh();
    });
  }

  function startEdit(it: QuoteLineItem) {
    setEditId(it.id);
    setEditDesc(it.description);
    setEditQty(Number(it.quantity));
    setEditUnit(it.unit ?? "ea");
    setEditPrice(Number(it.unit_price));
  }

  function saveEdit() {
    if (!editId) return;
    setError(null);
    start(async () => {
      const res = await updateQuoteItem(editId, quote.id, { description: editDesc, quantity: editQty, unit: editUnit.trim() || "ea", unit_price: editPrice });
      if (!res.ok) return setError(res.error ?? "Couldn't save the item.");
      setEditId(null);
      refresh();
    });
  }

  const descrDirty = description !== ((quote as { description?: string | null }).description ?? "");
  function saveDescr() {
    setDescrSaved(false);
    start(async () => {
      // PATCH — only `description`. updateQuoteMeta writes just the keys it's given, so saving the
      // paragraph can never blank a title or a tax rate somebody set in the modal a second ago.
      const res = await updateQuoteMeta(quote.id, { description });
      if (!res?.ok) { setError(res?.error ?? "Couldn't save the description — try again."); return; }
      setError(null);
      setDescrSaved(true);
      setTimeout(() => setDescrSaved(false), 2000);
      refresh();
    });
  }

  function saveDetails() {
    setError(null);
    start(async () => {
      // THE WHOLE MODAL WAS HOSTAGE TO ONE FIELD. updateQuoteMeta runs the accepted-quote guard
      // only `if (meta.tax_rate !== undefined)`, and this call always sent the tax rate — so on a
      // locked estimate a person fixing a TYPO in the title was refused, and the words they had
      // just typed sat in a modal that would refuse them again. When the lines are locked the
      // rate is shown as text and left out of the write, which is exactly the set of keys the
      // server still accepts.
      const res = await updateQuoteMeta(quote.id, {
        title,
        description,
        notes,
        ...(lock ? {} : { tax_rate: (taxPct || 0) / 100 }),
        valid_until: validUntil || null,
      });
      if (!res.ok) {
        setError(res.error ?? "Could not save.");
        return;
      }
      setDetailsOpen(false);
      refresh();
    });
  }

  return (
    <>
      {/* ABOVE the line items on screen, because that is exactly where it prints on the document
          the customer reads (quote-document.tsx renders DocDescription before the table). */}
      <div className="mb-4 rounded-xl border border-slate-200 bg-white p-3">
        <Label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-400">
          Description (above line items)
        </Label>
        <Textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Scope of work — shows above the line items on the estimate."
          className="min-h-[60px]"
        />
        <div className="mt-2 flex items-center gap-2">
          <Button size="sm" onClick={saveDescr} disabled={pending || !descrDirty}>
            {descrSaved ? <Check className="h-3.5 w-3.5" /> : null}
            {descrSaved ? "Saved" : "Save"}
          </Button>
          {descrDirty && !pending && <span className="text-xs text-slate-400">Unsaved</span>}
        </div>
      </div>

      <Card>
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3">
          <span className="text-sm font-semibold text-slate-900">Line items</span>
          <Button size="sm" variant="outline" onClick={() => setDetailsOpen(true)}>
            <Pencil className="h-4 w-4" /> Edit Details
          </Button>
        </div>
        {error && !detailsOpen && (
          <div className="mx-5 mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
        )}
        <ul className="divide-y divide-slate-100">
          {items.map((it) =>
            editId === it.id ? (
              <li key={it.id} className="space-y-2 bg-slate-50/80 px-5 py-3 text-sm">
                <Input value={editDesc} onChange={(e) => setEditDesc(e.target.value)} placeholder="Description" />
                <div className="flex items-center gap-2">
                  <NumberInput value={editQty} onValueChange={setEditQty} className="w-16 text-center" />
                  <Input value={editUnit} onChange={(e) => setEditUnit(e.target.value)} className="w-16 text-center" placeholder="ea" aria-label="Unit" />
                  <span className="text-slate-400">×</span>
                  <NumberInput value={editPrice} onValueChange={setEditPrice} className="flex-1 text-right" />
                  <button
                    onClick={saveEdit}
                    disabled={pending || !editDesc.trim()}
                    className="rounded-md bg-brand p-1.5 text-white hover:bg-brand-dark disabled:opacity-50"
                    aria-label="Save"
                  >
                    <Check className="h-4 w-4" />
                  </button>
                  <button
                    onClick={() => setEditId(null)}
                    className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100"
                    aria-label="Cancel"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              </li>
            ) : lock ? (
              // A LOCKED LINE IS A READING, NOT A FORM. No click-to-edit on the description
              // either: it was a full-width invisible button, which is the most convincing
              // offer on the row and the one most likely to be pressed by accident.
              <li key={it.id} className="flex items-center gap-3 px-5 py-3 text-sm">
                <div className="min-w-0 flex-1">
                  <LineItemText description={it.description} className="block font-medium text-slate-800" />
                  <div className="text-xs text-slate-400">
                    {it.quantity} {it.unit} × {formatCurrency(it.unit_price)}
                  </div>
                </div>
                <div className="shrink-0 font-medium text-slate-900">{formatCurrency(it.line_total)}</div>
              </li>
            ) : (
              <li key={it.id} className="group flex items-center gap-3 px-5 py-3 text-sm transition-colors hover:bg-slate-50">
                <button
                  type="button"
                  onClick={() => startEdit(it)}
                  disabled={pending}
                  className="min-w-0 flex-1 cursor-pointer text-left"
                  title="Edit line item"
                >
                  <LineItemText description={it.description} className="block font-medium text-slate-800" />
                  <div className="text-xs text-slate-400">
                    {it.quantity} {it.unit} × {formatCurrency(it.unit_price)}
                  </div>
                </button>
                <div className="shrink-0 font-medium text-slate-900">{formatCurrency(it.line_total)}</div>
                <button
                  onClick={() => startEdit(it)}
                  disabled={pending}
                  className="shrink-0 text-slate-500 hover:text-brand"
                  aria-label="Edit"
                  title="Edit"
                >
                  <Pencil className="h-4 w-4" />
                </button>
                <button
                  onClick={() => start(async () => { setError(null); const res = await deleteQuoteItem(it.id, quote.id); if (!res.ok) return setError(res.error ?? "Couldn't remove the item."); refresh(); })}
                  disabled={pending}
                  className="shrink-0 text-slate-500 hover:text-red-600"
                  aria-label="Remove"
                  title="Remove"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </li>
            ),
          )}
          {items.length === 0 && <li className="px-5 py-6 text-center text-sm text-slate-400">No line items yet.</li>}
        </ul>

        {lock ? (
          // WHERE THE PICKER AND THE TYPE-ONE ROW WERE. The sentence comes from the page, which
          // read the same two tables requireEditableQuote reads, so it names the actual reason
          // (a signed contract, or a draw already billed) and the way forward. A bare missing
          // form would leave someone clicking around the card looking for the Add button.
          <div className="border-t border-slate-100 bg-slate-50/60 px-5 py-4">
            <div className="text-sm font-medium text-slate-800">These line items are locked</div>
            <p className="mt-0.5 text-sm text-slate-600">{lock.reason}</p>
          </div>
        ) : (
        <div className="space-y-2 border-t border-slate-100 bg-slate-50/60 p-3">
          {/* THE SAME PICKER THE COMPOSER HAS. Adding a line to a SAVED estimate used to mean
              typing it, price and all, from memory — on the surface where you're most likely to be
              adjusting a real quote in front of a customer. */}
          <AddLineItems
            priceItems={priceItems}
            kits={kits as never}
            // THE CUSTOMER'S LEVEL, which this picker was ignoring (audit 6). /quotes/new applies
            // it; this one did not — so the same part landed at two different prices depending on
            // whether it was added while composing or after saving, on the screen you are most
            // likely to be using in front of the customer. Its vendor rows ignored it too, and the
            // org default with it, until the picker took ONE pricing input (audit v994, VP1).
            pricing={{ levelPct: levelMarkupPct ?? null, orgDefaultPct: defaultMarkupPct }}
            onAdd={(lines) =>
              start(async () => {
                setError(null);
                // Each line is its own write and any of them can be refused — a locked estimate
                // (accepted with a signed contract or a billed draw), a DB error. Throwing the
                // results away meant a kit landed half its lines, or none, and the screen just
                // re-rendered with a wrong total and no message (audit v921).
                let added = 0;
                for (const l of lines) {
                  const res = await addQuoteItem(quote.id, {
                    description: l.description,
                    quantity: l.quantity,
                    unit: l.unit,
                    unit_price: l.unit_price,
                  });
                  if (!res.ok) {
                    setError(
                      added
                        ? `Added ${added} of ${lines.length}, then stopped: ${res.error ?? "the rest couldn't be added."}`
                        : res.error ?? "Couldn't add those items.",
                    );
                    break;
                  }
                  added++;
                }
                refresh();
              })
            }
          />
          <Input
            placeholder="Or type one…"
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addItem()}
          />
          <div className="flex items-center gap-2">
            <NumberInput value={qty} onValueChange={setQty} className="w-16 text-center" placeholder="Qty" />
            <Input value={unit} onChange={(e) => setUnit(e.target.value)} className="w-16 text-center" placeholder="ea" aria-label="Unit" onKeyDown={(e) => e.key === "Enter" && addItem()} />
            <span className="text-slate-400">×</span>
            <NumberInput value={price} onValueChange={setPrice} className="flex-1 text-right" placeholder="Price" />
            <Button onClick={addItem} disabled={pending || !desc.trim()}>
              <Plus className="h-4 w-4" /> Add
            </Button>
          </div>
        </div>
        )}

        <div className="border-t border-slate-100 px-5 py-4">
          <div className="ml-auto max-w-xs space-y-1.5 text-sm">
            <div className="flex justify-between text-slate-600">
              <span>Subtotal</span>
              <span>{formatCurrency(quote.subtotal)}</span>
            </div>
            <div className="flex justify-between text-slate-600">
              <span>Tax ({(Number(quote.tax_rate) * 100).toFixed(2)}%)</span>
              <span>{formatCurrency(quote.tax)}</span>
            </div>
            <div className="flex justify-between border-t border-slate-100 pt-1.5 text-base font-semibold text-slate-900">
              <span>Total</span>
              <span>{formatCurrency(quote.total)}</span>
            </div>
          </div>
        </div>
      </Card>

      <Card className="mt-6">
        <div className="flex items-start justify-between gap-3 px-5 py-5">
          <div className="min-w-0">
            <h3 className="mb-1 text-sm font-semibold text-slate-900">Notes</h3>
            {quote.notes ? (
              <p className="whitespace-pre-wrap text-sm text-slate-600">{quote.notes}</p>
            ) : (
              <p className="text-sm text-slate-400">No notes yet — add scope, exclusions, or terms.</p>
            )}
          </div>
          {/* Edit the notes right where they live (the "Edit Details" button up top opens the same
              modal, but the notes weren't obviously editable from here). */}
          <Button size="sm" variant="outline" className="shrink-0" onClick={() => setDetailsOpen(true)}>
            <Pencil className="h-4 w-4" /> Edit
          </Button>
        </div>
      </Card>

      <Modal
        open={detailsOpen}
        onClose={() => setDetailsOpen(false)}
        title="Edit quote details"
        footer={
          <ModalActions onCancel={() => setDetailsOpen(false)} onSave={saveDetails} saving={pending} saveLabel="Save Changes" />
        }
      >
        <div className="space-y-4">
          {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
          <div>
            <Label htmlFor="qd-title">Title</Label>
            <Input id="qd-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Panel upgrade — 200A" />
          </div>
          <div>
            <Label htmlFor="qd-description">Description <span className="font-normal text-slate-400">(shows above the line items)</span></Label>
            <Textarea id="qd-description" rows={4} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Scope summary the customer reads before the line items." />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="qd-tax">Tax rate (%)</Label>
              {/* The same substitution the invoice page makes on a sent bill
                  (billing/[id]/invoice-detail.tsx): the rate as text, not an input that can
                  only be refused. The number is the one already on the estimate, not a new one. */}
              {lock ? (
                <>
                  <div id="qd-tax" className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
                    {taxPct.toFixed(2)}%
                  </div>
                  <p className="mt-1 text-xs text-slate-500">
                    Changing the rate would change the total. {lock.reason}
                  </p>
                </>
              ) : (
                <NumberInput id="qd-tax" value={taxPct} onValueChange={setTaxPct} />
              )}
            </div>
            <div>
              <Label htmlFor="qd-valid">Valid until</Label>
              <Input id="qd-valid" type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} />
            </div>
          </div>
          <div>
            <Label htmlFor="qd-notes">Notes</Label>
            <Textarea id="qd-notes" rows={6} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
        </div>
      </Modal>
    </>
  );
}
