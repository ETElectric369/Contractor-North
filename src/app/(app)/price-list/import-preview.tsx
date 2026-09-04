"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { FileSpreadsheet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label, Select } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/toast";
import { formatCurrency } from "@/lib/utils";
import { parseCSV } from "@/lib/csv";
import { PRICE_CSV_FIELDS, autoMapPriceHeaders } from "@/lib/pricing/csv-map";
import { normalizeUnit } from "@/lib/pricing/units";
import { bulkImportPriceItems, previewImportMatches, type ImportRow } from "./actions";
import { EXTRA_CSV_FIELDS, mapExtraHeaders, mappedFields, rowThroughMapping, type CsvField, type CsvMapping } from "./price-list-math";

// Header heuristics for the price fields live in src/lib/pricing/csv-map.ts (pure, tested): one
// column never feeds two fields, code is tried before cost, and unit is a mapped field. The kit
// and quantity columns are this page's own concern (price-list-math.ts).
const FIELDS: { key: CsvField; label: string }[] = [...PRICE_CSV_FIELDS.map((f) => ({ key: f.key as CsvField, label: f.label })), ...EXTRA_CSV_FIELDS];

/**
 * THE CSV IMPORTER, WITH A LOOK BEFORE THE LEAP. Until cn-v909 "Import" wrote the moment the
 * mapping looked plausible — and the mapping was guessed from headers, so a "Cost Code" sheet
 * put codes into prices for 300 rows before anyone saw a number. Now the first five rows render
 * THROUGH the mapping, in the columns the book will show them in, and the button says what the
 * write will do: "Update N, Add M" (the code is the join key since 0240) or "Import N Rows".
 */
export function ImportCsvModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [headers, setHeaders] = useState<string[]>([]);
  const [dataRows, setDataRows] = useState<string[][]>([]);
  const [mapping, setMapping] = useState<CsvMapping>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [existing, setExisting] = useState<number | null>(null);

  function reset() {
    setHeaders([]); setDataRows([]); setMapping({}); setMsg(null); setExisting(null);
  }

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setMsg(null);
    file.text().then((text) => {
      const rows = parseCSV(text);
      if (rows.length < 2) { setMsg("That file has no data rows."); return; }
      const hdr = rows[0].map((h) => h.trim());
      setHeaders(hdr);
      setDataRows(rows.slice(1));
      // auto-map by header heuristics — a column claimed once is never claimed again
      setMapping(mapExtraHeaders(hdr, autoMapPriceHeaders(hdr) as CsvMapping));
    });
  }

  const preview = useMemo(() => dataRows.slice(0, 5).map((r) => rowThroughMapping(r, mapping)), [dataRows, mapping]);
  // What each row will be matched on — its code, else its description (the server's rule).
  const keys = useMemo(
    () =>
      mapping.description === undefined
        ? []
        : dataRows
            .map((r) => ({
              code: mapping.code === undefined ? "" : String(r[mapping.code!] ?? "").trim(),
              description: String(r[mapping.description!] ?? "").trim(),
            }))
            .filter((k) => k.description),
    [dataRows, mapping.code, mapping.description],
  );
  const keysSig = useMemo(() => keys.map((k) => `${k.code}|${k.description}`).join("\n"), [keys]);
  const kitCount = useMemo(
    () => (mapping.kit === undefined ? 0 : new Set(dataRows.map((r) => String(r[mapping.kit!] ?? "").trim().toLowerCase()).filter(Boolean)).size),
    [dataRows, mapping.kit],
  );

  // Ask the server how many of these rows it already has — so the button can say what it will
  // do. Debounced by the mapping itself: it re-runs only when the code/description columns change.
  useEffect(() => {
    if (!open || keys.length === 0) { setExisting(null); return; }
    let live = true;
    previewImportMatches(keys).then((res) => {
      if (!live) return;
      setExisting(res.ok ? res.existing : null);
    });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, keysSig]);

  // Distinct rows the server will see — in-file duplicates collapse (last wins), same as the write.
  const distinct = useMemo(() => {
    const seen = new Set<string>();
    for (const k of keys) seen.add(k.code ? `code:${k.code.toLowerCase()}` : `desc:${k.description.toLowerCase().replace(/\s+/g, " ")}`);
    return seen.size;
  }, [keys]);
  const label =
    existing !== null
      ? `Update ${existing}, Add ${Math.max(0, distinct - existing)}`
      : `Import ${dataRows.length} Row${dataRows.length === 1 ? "" : "s"}`;

  function runImport() {
    if (mapping.description === undefined) { setMsg("Map the Description column first."); return; }
    const rows: ImportRow[] = dataRows.map((r) => {
      const m = rowThroughMapping(r, mapping);
      return {
        code: m.code,
        description: m.description,
        category: m.category,
        supplier: m.supplier,
        unit: m.unit || null,
        buy_price: m.buy_price,
        markup_pct: m.markup_pct,
        kit: m.kit || null,
        quantity: m.quantity,
      };
    });
    const fields = mappedFields(mapping);
    start(async () => {
      const res = await bulkImportPriceItems(rows, fields);
      if (!res.ok) { setMsg(res.error ?? "Import failed."); toast(res.error ?? "Import failed.", "error"); return; }
      const parts: string[] = [];
      if (res.inserted) parts.push(`added ${res.inserted}`);
      if (res.updated) parts.push(`updated ${res.updated}`);
      if (!parts.length) parts.push("nothing changed");
      if (res.kits || res.kitLines) parts.push(`${res.kitLines ?? 0} kit line${res.kitLines === 1 ? "" : "s"}${res.kits ? ` in ${res.kits} new kit${res.kits === 1 ? "" : "s"}` : ""}`);
      if (res.skipped) parts.push(`${res.skipped} skipped`);
      const summary = parts.join(", ");
      toast(`Import done — ${summary[0].toUpperCase()}${summary.slice(1)}.`, "success");
      if (res.note) toast(res.note, "info");
      reset();
      onClose();
      router.refresh();
    });
  }

  return (
    <Modal open={open} onClose={() => { reset(); onClose(); }} title="Import Price List From CSV" size="xl">
      <div className="space-y-4">
        {msg && <div className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-700">{msg}</div>}
        {headers.length === 0 ? (
          <label className="flex cursor-pointer flex-col items-center gap-2 rounded-xl border border-dashed border-slate-300 px-6 py-10 text-center hover:bg-slate-50">
            <FileSpreadsheet className="h-8 w-8 text-slate-400" />
            <span className="text-sm font-medium text-slate-700">Choose a .CSV File</span>
            <span className="text-xs text-slate-400">e.g. your CED price list export. A “kit” column groups rows into kits.</span>
            <input type="file" accept=".csv,text/csv" className="hidden" onChange={onFile} />
          </label>
        ) : (
          <>
            <p className="text-sm text-slate-600">
              {dataRows.length} row{dataRows.length === 1 ? "" : "s"} found. Check which column feeds each field — a row with a code
              refreshes the item that already has it; one without matches by exact description; anything new is added. A
              blank cell never overwrites what the book already knows.
            </p>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {FIELDS.map((f) => (
                <div key={f.key}>
                  <Label>{f.label}{f.key === "description" ? " *" : ""}</Label>
                  <Select
                    value={mapping[f.key] ?? ""}
                    onChange={(e) =>
                      setMapping((m) => {
                        const next = { ...m };
                        if (e.target.value === "") delete next[f.key];
                        else next[f.key] = Number(e.target.value);
                        return next;
                      })
                    }
                  >
                    <option value="">— Skip —</option>
                    {headers.map((h, idx) => (
                      <option key={idx} value={idx}>{h || `Column ${idx + 1}`}</option>
                    ))}
                  </Select>
                </div>
              ))}
            </div>

            {/* THE PREVIEW — the first five rows exactly as the book will hold them. */}
            <div>
              <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">First {preview.length} rows, through this mapping</p>
              <div className="overflow-x-auto rounded-lg border border-slate-200">
                <table className="w-full min-w-[640px] text-left text-sm">
                  <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-400">
                    <tr>
                      <th className="px-3 py-2">Code</th>
                      <th className="px-3 py-2">Description</th>
                      <th className="px-3 py-2">Category</th>
                      <th className="px-3 py-2">Unit</th>
                      <th className="px-3 py-2 text-right">Cost</th>
                      <th className="px-3 py-2 text-right">MU%</th>
                      {mapping.kit !== undefined && <th className="px-3 py-2">Kit</th>}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {preview.map((p, i) => (
                      <tr key={i} className={p.description ? "" : "bg-red-50 text-red-700"}>
                        <td className="px-3 py-1.5 font-mono text-xs text-slate-500">{p.code || "—"}</td>
                        <td className="px-3 py-1.5 text-slate-900">{p.description || "(no description — this row will be skipped)"}</td>
                        <td className="px-3 py-1.5 text-slate-500">{p.category || "—"}</td>
                        <td className="px-3 py-1.5 text-slate-500">{mapping.unit === undefined ? "ea" : p.unit ? normalizeUnit(p.unit) : "—"}</td>
                        <td className="px-3 py-1.5 text-right text-slate-700">{p.buy_price === null ? "—" : formatCurrency(p.buy_price)}</td>
                        <td className="px-3 py-1.5 text-right text-slate-500">{p.markup_pct === null ? "—" : `${p.markup_pct}%`}</td>
                        {mapping.kit !== undefined && (
                          <td className="px-3 py-1.5 text-slate-500">{p.kit ? `${p.kit}${p.quantity !== null ? ` × ${p.quantity}` : ""}` : "—"}</td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-1.5 text-xs text-slate-400">
                {mapping.markup_pct === undefined
                  ? "No markup column — existing markups are left alone; new items use your default markup."
                  : "The markup column refreshes existing items' markup too — a blank cell leaves it alone."}
                {kitCount > 0 && ` ${kitCount} kit${kitCount === 1 ? "" : "s"} named in the sheet — lines are linked to their items.`}
              </p>
            </div>

            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={reset}>Back</Button>
              <Button onClick={runImport} disabled={pending || mapping.description === undefined}>
                {pending ? "Importing…" : label}
              </Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
