"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2, Sparkles, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { formatCurrency } from "@/lib/utils";
import {
  saveQuote,
  generateQuoteDraft,
  type DraftLineItem,
} from "../actions";

interface CustomerOption {
  id: string;
  name: string;
  company_name: string | null;
  level_markup?: number | null;
}
interface PriceItemLite {
  id: string;
  code: string | null;
  description: string;
  category?: string | null;
  unit: string;
  buy_price: number;
  markup_pct: number;
}
interface TaxRateLite {
  id: string;
  name: string;
  rate: number;
  is_default: boolean;
}
interface KitLite {
  id: string;
  name: string;
  kit_items: { description: string; quantity: number; unit: string; unit_price: number }[];
}

const blankItem = (): DraftLineItem => ({
  description: "",
  quantity: 1,
  unit: "ea",
  unit_price: 0,
});

const sellPrice = (buy: number, markup: number) => buy * (1 + (markup || 0) / 100);

export function QuoteBuilder({
  customers,
  preselected,
  jobId,
  priceItems = [],
  taxRates = [],
  kits = [],
  quoteExpiryDays = 30,
}: {
  customers: CustomerOption[];
  preselected?: string;
  /** When launched from a job, the quote attaches to it. */
  jobId?: string;
  priceItems?: PriceItemLite[];
  taxRates?: TaxRateLite[];
  kits?: KitLite[];
  quoteExpiryDays?: number;
}) {
  const router = useRouter();
  const defaultRate = taxRates.find((t) => t.is_default);
  const [customerId, setCustomerId] = useState(preselected ?? "");
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [taxRate, setTaxRate] = useState(defaultRate ? Number(defaultRate.rate) / 100 : 0);
  const [taxChoice, setTaxChoice] = useState(defaultRate ? defaultRate.id : "");
  const [validUntil, setValidUntil] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() + (quoteExpiryDays || 30));
    return d.toISOString().slice(0, 10);
  });
  const [items, setItems] = useState<DraftLineItem[]>([blankItem()]);
  const [plQuery, setPlQuery] = useState("");
  const [plOpen, setPlOpen] = useState(false);

  // Resolve the markup to use: the selected customer's pricing-level markup
  // overrides the item's own default markup.
  const selectedCust = customers.find((c) => c.id === customerId);
  const levelMarkup = selectedCust?.level_markup;
  const markupFor = (p: PriceItemLite) => (levelMarkup != null ? levelMarkup : p.markup_pct);

  const plMatches = plQuery.trim()
    ? priceItems
        .filter((p) =>
          [p.code, p.description, p.category].some((v) =>
            (v ?? "").toLowerCase().includes(plQuery.trim().toLowerCase()),
          ),
        )
        .slice(0, 8)
    : [];

  function addFromPrice(p: PriceItemLite) {
    const real = items.filter((i) => i.description.trim());
    setItems([
      ...real,
      {
        description: p.code ? `${p.code} — ${p.description}` : p.description,
        quantity: 1,
        unit: p.unit || "ea",
        unit_price: Number(sellPrice(p.buy_price, markupFor(p)).toFixed(2)),
      },
    ]);
    setPlQuery("");
    setPlOpen(false);
  }

  function addKit(kitId: string) {
    const k = kits.find((x) => x.id === kitId);
    if (!k) return;
    const real = items.filter((i) => i.description.trim());
    const kitLines: DraftLineItem[] = (k.kit_items ?? []).map((it) => ({
      description: it.description,
      quantity: Number(it.quantity) || 1,
      unit: it.unit || "ea",
      unit_price: Number(it.unit_price) || 0,
    }));
    setItems([...real, ...kitLines]);
  }

  const [scope, setScope] = useState("");
  const [aiError, setAiError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [generating, startGenerate] = useTransition();
  const [saving, startSave] = useTransition();

  const subtotal = items.reduce((s, i) => s + i.quantity * i.unit_price, 0);
  const tax = subtotal * (taxRate || 0);
  const total = subtotal + tax;

  function updateItem(idx: number, patch: Partial<DraftLineItem>) {
    setItems((prev) =>
      prev.map((it, i) => (i === idx ? { ...it, ...patch } : it)),
    );
  }

  function onGenerate() {
    setAiError(null);
    startGenerate(async () => {
      const res = await generateQuoteDraft(scope);
      if (!res.ok) {
        setAiError(res.error);
        return;
      }
      // Replace empty rows; append to existing real rows.
      const real = items.filter((i) => i.description.trim());
      setItems([...real, ...res.items]);
    });
  }

  function onSave() {
    setSaveError(null);
    const cleaned = items.filter((i) => i.description.trim());
    if (cleaned.length === 0) {
      setSaveError("Add at least one line item.");
      return;
    }
    startSave(async () => {
      const res = await saveQuote({
        customer_id: customerId || null,
        job_id: jobId || null,
        title,
        notes,
        tax_rate: taxRate,
        valid_until: validUntil || null,
        items: cleaned,
      });
      if (!res.ok) {
        setSaveError(res.error ?? "Could not save the quote.");
        return;
      }
      router.push(`/quotes/${res.id}`);
    });
  }

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="space-y-6 lg:col-span-2">
        {/* AI drafting */}
        <Card className="border-brand/30 bg-brand-light/40">
          <CardContent className="space-y-3 py-5">
            <div className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-brand" />
              <h3 className="text-sm font-semibold text-slate-900">
                Draft with AI
              </h3>
            </div>
            <Textarea
              rows={3}
              placeholder="Describe the work, e.g. 'Upgrade 100A panel to 200A, add 4 new 20A circuits, install whole-home surge protector, residential.'"
              value={scope}
              onChange={(e) => setScope(e.target.value)}
            />
            {aiError && <p className="text-sm text-red-600">{aiError}</p>}
            <Button variant="primary" onClick={onGenerate} disabled={generating}>
              {generating ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" /> Generating…
                </>
              ) : (
                <>
                  <Sparkles className="h-4 w-4" /> Generate line items
                </>
              )}
            </Button>
          </CardContent>
        </Card>

        {/* Line items */}
        <Card>
          <CardContent className="py-5">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-900">Line items</h3>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setItems((p) => [...p, blankItem()])}
              >
                <Plus className="h-3.5 w-3.5" /> Add
              </Button>
            </div>

            {priceItems.length > 0 && (
              <div className="relative mb-3">
                <Input
                  placeholder="Add from Price List — search items…"
                  value={plQuery}
                  onChange={(e) => { setPlQuery(e.target.value); setPlOpen(true); }}
                  onFocus={() => setPlOpen(true)}
                  onBlur={() => setTimeout(() => setPlOpen(false), 150)}
                />
                {plOpen && plMatches.length > 0 && (
                  <ul className="absolute z-20 mt-1 max-h-60 w-full overflow-auto rounded-lg border border-slate-200 bg-white py-1 shadow-lg">
                    {plMatches.map((p) => (
                      <li key={p.id}>
                        <button
                          type="button"
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => addFromPrice(p)}
                          className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-slate-50"
                        >
                          <span className="min-w-0 truncate">
                            {p.code && <span className="mr-1 font-mono text-xs text-slate-400">{p.code}</span>}
                            {p.description}
                          </span>
                          <span className="shrink-0 text-slate-600">{formatCurrency(sellPrice(p.buy_price, markupFor(p)))}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {kits.length > 0 && (
              <div className="mb-3">
                <Select value="" onChange={(e) => { if (e.target.value) { addKit(e.target.value); e.target.value = ""; } }}>
                  <option value="">+ Add a kit…</option>
                  {kits.map((k) => (
                    <option key={k.id} value={k.id}>{k.name}</option>
                  ))}
                </Select>
              </div>
            )}

            <div className="space-y-2">
              {items.map((it, idx) => (
                <div
                  key={idx}
                  className="grid grid-cols-12 items-start gap-2 rounded-lg border border-slate-100 p-2"
                >
                  <div className="col-span-12 sm:col-span-5">
                    <Input
                      placeholder="Description"
                      value={it.description}
                      onChange={(e) =>
                        updateItem(idx, { description: e.target.value })
                      }
                    />
                  </div>
                  <div className="col-span-3 sm:col-span-2">
                    <NumberInput
                      placeholder="Qty"
                      value={it.quantity}
                      onValueChange={(n) => updateItem(idx, { quantity: n })}
                    />
                  </div>
                  <div className="col-span-3 sm:col-span-1">
                    <Input
                      placeholder="ea"
                      value={it.unit}
                      onChange={(e) => updateItem(idx, { unit: e.target.value })}
                    />
                  </div>
                  <div className="col-span-4 sm:col-span-2">
                    <NumberInput
                      placeholder="Unit $"
                      value={it.unit_price}
                      onValueChange={(n) => updateItem(idx, { unit_price: n })}
                    />
                  </div>
                  <div className="col-span-2 flex items-center justify-end gap-1 sm:col-span-2">
                    <span className="text-sm font-medium text-slate-700">
                      {formatCurrency(it.quantity * it.unit_price)}
                    </span>
                    <button
                      onClick={() =>
                        setItems((p) => p.filter((_, i) => i !== idx))
                      }
                      className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600"
                      aria-label="Remove line"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Sidebar: details + totals */}
      <div className="space-y-6">
        <Card>
          <CardContent className="space-y-4 py-5">
            <div>
              <Label htmlFor="customer">Customer</Label>
              <Select
                id="customer"
                value={customerId}
                onChange={(e) => setCustomerId(e.target.value)}
              >
                <option value="">— Select customer —</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {c.company_name ? ` (${c.company_name})` : ""}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label htmlFor="title">Title</Label>
              <Input
                id="title"
                placeholder="e.g. Panel upgrade"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="tax">Tax rate</Label>
                {taxRates.length > 0 ? (
                  <Select
                    id="tax"
                    value={taxChoice}
                    onChange={(e) => {
                      const id = e.target.value;
                      setTaxChoice(id);
                      const r = taxRates.find((t) => t.id === id);
                      setTaxRate(r ? Number(r.rate) / 100 : 0);
                    }}
                  >
                    <option value="">No tax</option>
                    {taxRates.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name} ({Number(t.rate)}%)
                      </option>
                    ))}
                  </Select>
                ) : (
                  <Input
                    id="tax"
                    type="number"
                    step="any"
                    placeholder="8.25"
                    onChange={(e) => setTaxRate((Number(e.target.value) || 0) / 100)}
                  />
                )}
              </div>
              <div>
                <Label htmlFor="valid">Valid until</Label>
                <Input
                  id="valid"
                  type="date"
                  value={validUntil}
                  onChange={(e) => setValidUntil(e.target.value)}
                />
              </div>
            </div>
            <div>
              <Label htmlFor="notes">Notes</Label>
              <Textarea
                id="notes"
                rows={3}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="space-y-2 py-5 text-sm">
            <div className="flex justify-between text-slate-600">
              <span>Subtotal</span>
              <span>{formatCurrency(subtotal)}</span>
            </div>
            <div className="flex justify-between text-slate-600">
              <span>Tax</span>
              <span>{formatCurrency(tax)}</span>
            </div>
            <div className="flex justify-between border-t border-slate-100 pt-2 text-base font-semibold text-slate-900">
              <span>Total</span>
              <span>{formatCurrency(total)}</span>
            </div>
            {saveError && (
              <p className="pt-2 text-sm text-red-600">{saveError}</p>
            )}
            <Button className="mt-2 w-full" onClick={onSave} disabled={saving}>
              {saving ? "Saving…" : "Save estimate"}
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
