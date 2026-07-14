"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2, Upload, Search, FileSpreadsheet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Modal } from "@/components/ui/modal";
import { Card } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import { formatCurrency } from "@/lib/utils";
import { createPriceItem, deletePriceItem, bulkImportPriceItems, type PriceItemInput } from "./actions";
import { EditPriceItemButton } from "./edit-price-item-button";
import { parseCSV } from "@/lib/csv";

interface PriceItem {
  id: string;
  code: string | null;
  description: string;
  category: string | null;
  supplier: string | null;
  unit: string;
  buy_price: number;
  markup_pct: number;
}

const sell = (buy: number, markup: number) => buy * (1 + (markup || 0) / 100);

const FIELDS: { key: keyof PriceItemInput; label: string; match: RegExp }[] = [
  { key: "code", label: "Item code", match: /code|item|part|sku|catalog|number|#/i },
  { key: "description", label: "Description", match: /desc|name|product|detail/i },
  { key: "category", label: "Category", match: /categ|group|class|type/i },
  { key: "supplier", label: "Supplier", match: /supplier|vendor|manufactur|brand|mfg/i },
  { key: "buy_price", label: "Buy price", match: /price|cost|buy|net|amount|each/i },
  { key: "markup_pct", label: "Markup %", match: /markup|margin/i },
];

export function PriceListManager({ items }: { items: PriceItem[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [q, setQ] = useState("");

  // add form
  const [code, setCode] = useState("");
  const [desc, setDesc] = useState("");
  const [category, setCategory] = useState("");
  const [supplier, setSupplier] = useState("");
  const [buy, setBuy] = useState(0);
  const [markup, setMarkup] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // import modal
  const [importOpen, setImportOpen] = useState(false);
  const [headers, setHeaders] = useState<string[]>([]);
  const [dataRows, setDataRows] = useState<string[][]>([]);
  const [mapping, setMapping] = useState<Record<string, number>>({});
  const [importMsg, setImportMsg] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return items;
    return items.filter((i) =>
      [i.code, i.description, i.category, i.supplier].some((v) => (v ?? "").toLowerCase().includes(t)),
    );
  }, [items, q]);

  function add() {
    setError(null);
    if (!desc.trim()) return setError("Description is required.");
    start(async () => {
      const res = await createPriceItem({ code, description: desc, category, supplier, buy_price: buy, markup_pct: markup });
      if (!res.ok) return setError(res.error ?? "Could not save.");
      setCode(""); setDesc(""); setCategory(""); setSupplier(""); setBuy(0); setMarkup(0);
      router.refresh();
    });
  }

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportMsg(null);
    file.text().then((text) => {
      const rows = parseCSV(text);
      if (rows.length < 2) { setImportMsg("That file has no data rows."); return; }
      const hdr = rows[0].map((h) => h.trim());
      setHeaders(hdr);
      setDataRows(rows.slice(1));
      // auto-map by header heuristics
      const map: Record<string, number> = {};
      for (const f of FIELDS) {
        const idx = hdr.findIndex((h) => f.match.test(h));
        if (idx >= 0) map[f.key as string] = idx;
      }
      setMapping(map);
    });
  }

  function runImport() {
    const descIdx = mapping["description"];
    if (descIdx === undefined) { setImportMsg("Map the Description column first."); return; }
    const num = (v: string) => {
      const n = parseFloat((v ?? "").replace(/[^0-9.\-]/g, ""));
      return Number.isFinite(n) ? n : 0;
    };
    const rows: PriceItemInput[] = dataRows.map((r) => ({
      code: mapping["code"] !== undefined ? r[mapping["code"]] : "",
      description: r[descIdx] ?? "",
      category: mapping["category"] !== undefined ? r[mapping["category"]] : "",
      supplier: mapping["supplier"] !== undefined ? r[mapping["supplier"]] : "",
      buy_price: mapping["buy_price"] !== undefined ? num(r[mapping["buy_price"]]) : 0,
      markup_pct: mapping["markup_pct"] !== undefined ? num(r[mapping["markup_pct"]]) : 0,
    }));
    start(async () => {
      const res = await bulkImportPriceItems(rows);
      if (!res.ok) { setImportMsg(res.error ?? "Import failed."); return; }
      setImportOpen(false);
      setHeaders([]); setDataRows([]); setMapping({});
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      {/* Add + search + import */}
      <Card className="p-4">
        {error && <p className="mb-2 text-sm text-red-600">{error}</p>}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-6">
          <div><Label htmlFor="pl-code">Code</Label><Input id="pl-code" value={code} onChange={(e) => setCode(e.target.value)} /></div>
          <div className="col-span-2"><Label htmlFor="pl-desc">Description *</Label><Input id="pl-desc" value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="e.g. 12/2 Romex (250ft)" /></div>
          <div><Label htmlFor="pl-cat">Category</Label><Input id="pl-cat" value={category} onChange={(e) => setCategory(e.target.value)} /></div>
          <div><Label htmlFor="pl-buy">Buy $</Label><NumberInput id="pl-buy" value={buy} onValueChange={setBuy} /></div>
          <div><Label htmlFor="pl-mk">Markup %</Label><NumberInput id="pl-mk" value={markup} onValueChange={setMarkup} /></div>
        </div>
        <div className="mt-3 flex items-center justify-between">
          <Button size="sm" variant="outline" onClick={() => setImportOpen(true)}>
            <Upload className="h-3.5 w-3.5" /> Import CSV
          </Button>
          <Button size="sm" onClick={add} disabled={pending || !desc.trim()}>
            <Plus className="h-3.5 w-3.5" /> Add Item
          </Button>
        </div>
      </Card>

      <div className="relative">
        <Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search price list…" className="pl-9" />
      </div>

      <Card className="overflow-hidden">
        <DataTable
          rows={filtered}
          rowKey={(i) => i.id}
          mobileCols={2}
          empty={
            <p className="px-4 py-10 text-center text-sm text-slate-400">
              {items.length === 0 ? "No items yet. Add one, or import your CED price list via CSV." : "No matches."}
            </p>
          }
          columns={[
            { header: "Code", span: 2, className: "font-mono text-xs text-slate-500", cell: (i) => i.code ?? "—" },
            { header: "Description", span: 4, className: "text-sm font-medium text-slate-900", cell: (i) => i.description },
            { header: "Category", span: 2, className: "text-sm text-slate-500", cell: (i) => i.category ?? "—" },
            { header: "Buy", span: 1, align: "right", className: "text-sm text-slate-600", cell: (i) => formatCurrency(i.buy_price) },
            { header: "MU%", span: 1, align: "right", className: "text-sm text-slate-500", cell: (i) => `${Number(i.markup_pct)}%` },
            { header: "Sell", span: 1, align: "right", className: "text-sm font-medium text-slate-900", cell: (i) => formatCurrency(sell(i.buy_price, i.markup_pct)) },
            {
              header: "",
              span: 1,
              className: "flex items-center justify-end gap-1",
              cell: (i) => (
                <>
                  <EditPriceItemButton item={i} />
                  <button
                    onClick={() => {
                      if (!confirm(`Delete "${i.description}" from the price list?`)) return;
                      start(async () => { await deletePriceItem(i.id); router.refresh(); });
                    }}
                    disabled={pending}
                    className="rounded-md p-1 text-slate-400 hover:bg-red-50 hover:text-red-600"
                    title="Delete"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </>
              ),
            },
          ]}
        />
      </Card>

      {/* CSV import modal */}
      <Modal open={importOpen} onClose={() => setImportOpen(false)} title="Import price list from CSV">
        <div className="space-y-4">
          {importMsg && <div className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-700">{importMsg}</div>}
          {headers.length === 0 ? (
            <label className="flex cursor-pointer flex-col items-center gap-2 rounded-xl border border-dashed border-slate-300 px-6 py-10 text-center hover:bg-slate-50">
              <FileSpreadsheet className="h-8 w-8 text-slate-400" />
              <span className="text-sm font-medium text-slate-700">Choose a .CSV file</span>
              <span className="text-xs text-slate-400">e.g. your CED price list export</span>
              <input type="file" accept=".csv,text/csv" className="hidden" onChange={onFile} />
            </label>
          ) : (
            <>
              <p className="text-sm text-slate-600">
                Matched {dataRows.length} rows. Confirm which CSV column maps to each field:
              </p>
              <div className="grid grid-cols-2 gap-3">
                {FIELDS.map((f) => (
                  <div key={f.key as string}>
                    <Label>{f.label}{f.key === "description" ? " *" : ""}</Label>
                    <Select
                      value={mapping[f.key as string] ?? ""}
                      onChange={(e) => setMapping((m) => ({ ...m, [f.key as string]: e.target.value === "" ? undefined : Number(e.target.value) }) as any)}
                    >
                      <option value="">— Skip —</option>
                      {headers.map((h, idx) => (
                        <option key={idx} value={idx}>{h || `Column ${idx + 1}`}</option>
                      ))}
                    </Select>
                  </div>
                ))}
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => { setHeaders([]); setDataRows([]); setMapping({}); }}>Back</Button>
                <Button onClick={runImport} disabled={pending}>{pending ? "Importing…" : `Import ${dataRows.length} Items`}</Button>
              </div>
            </>
          )}
        </div>
      </Modal>
    </div>
  );
}
