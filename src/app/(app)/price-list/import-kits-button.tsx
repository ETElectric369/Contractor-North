"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Upload, Loader2, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/toast";
import { csvToObjects } from "@/lib/csv";
import { bulkImportKits, type KitImportRow } from "./kit-actions";

// One row per line item; the `kit` column groups rows into kits.
const TEMPLATE = `kit,category,description,quantity,unit,unit_price
Deck Package A,Materials,Composite decking,320,sqft,8.50
Deck Package A,Materials,Railing,60,lf,42
Deck Package A,Labor,Build & install,1,job,4200
T&M Renovation,Labor,Carpenter,8,hr,95
`;

/** Bulk-import preset kits from a spreadsheet — each row is a line item, grouped by a `kit` column.
 *  Forgiving on header names (kit name / qty / price / unit price all map). */
export function ImportKitsButton() {
  const router = useRouter();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (fileRef.current) fileRef.current.value = "";
    if (!file) return;
    setBusy(true);
    try {
      const objs = csvToObjects(await file.text());
      const rows: KitImportRow[] = objs.map((o) => ({
        kit: o.kit || o["kit name"] || o.name || "",
        category: o.category,
        description: o.description || o.item || "",
        quantity: o.quantity || o.qty,
        unit: o.unit,
        unit_price: o.unit_price || o["unit price"] || o.price,
      }));
      if (!rows.length) { toast("No rows found — the CSV needs a header row (kit, description, …)."); return; }
      const res = await bulkImportKits(rows);
      if (!res.ok) { toast(res.error ?? "Import failed."); return; }
      toast(`Imported ${res.kits} kit${res.kits === 1 ? "" : "s"} (${res.items} item${res.items === 1 ? "" : "s"})${res.skipped ? ` · ${res.skipped} row(s) skipped` : ""}.`);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  function downloadTemplate() {
    const a = document.createElement("a");
    a.href = "data:text/csv;charset=utf-8," + encodeURIComponent(TEMPLATE);
    a.download = "kits-template.csv";
    a.click();
  }

  return (
    <div className="flex items-center gap-2">
      <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden" onChange={onFile} />
      <Button size="sm" variant="outline" onClick={() => fileRef.current?.click()} disabled={busy}>
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />} Import kits (CSV)
      </Button>
      <button type="button" onClick={downloadTemplate} className="inline-flex items-center gap-1 text-xs text-slate-400 hover:text-slate-600">
        <Download className="h-3.5 w-3.5" /> template
      </button>
    </div>
  );
}
