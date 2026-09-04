"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Upload, Loader2, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/toast";
import { csvToObjects } from "@/lib/csv";
import { bulkImportKits, type KitImportRow } from "./kit-actions";

// One row per line item; the `kit` column groups rows into kits. A `code` that matches the
// price list LINKS the line to that item (0240) — its price then follows the book and the row's
// unit_price is ignored. A code the book doesn't know lands frozen with the price given, so the
// sample row carries one either way.
const TEMPLATE = `kit,category,code,description,quantity,unit,unit_price
Deck Package A,Materials,DK-COMP,Composite decking,320,sq ft,8.50
Deck Package A,Materials,,Railing,60,ft,42
Deck Package A,Labor,,Build & install,1,lot,4200
T&M Renovation,Labor,,Carpenter,8,hr,95
`;

/** Bulk-import preset kits from a spreadsheet — each row is a line item, grouped by a `kit` column.
 *  Forgiving on header names (kit name / qty / price / unit price / code / sku all map). */
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
        code: o.code || o["item code"] || o.sku || o.part || o["part number"] || o["part #"],
        description: o.description || o.item || o.name || "",
        quantity: o.quantity || o.qty,
        unit: o.unit,
        unit_price: o.unit_price || o["unit price"] || o.price,
      }));
      if (!rows.length) { toast("No rows found — the CSV needs a header row (kit, description, …).", "error"); return; }
      const res = await bulkImportKits(rows);
      if (!res.ok) { toast(res.error ?? "Import failed.", "error"); return; }
      const linked = res.linked ? ` · ${res.linked} linked to the price list` : "";
      toast(
        `Imported ${res.kits} kit${res.kits === 1 ? "" : "s"} (${res.items} item${res.items === 1 ? "" : "s"})${linked}${res.skipped ? ` · ${res.skipped} row(s) skipped` : ""}.`,
        "success",
      );
      if (res.linkPending) toast("Coded rows landed frozen — linking to the book arrives with the next update.", "info");
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
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />} Import Kits
      </Button>
      <button type="button" onClick={downloadTemplate} className="inline-flex items-center gap-1 text-xs text-slate-400 hover:text-slate-600">
        <Download className="h-3.5 w-3.5" /> Template
      </button>
    </div>
  );
}
