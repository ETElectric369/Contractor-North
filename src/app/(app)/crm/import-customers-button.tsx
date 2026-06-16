"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { Label, Select } from "@/components/ui/input";
import { bulkImportCustomers, type CustomerImportRow } from "./actions";

function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++; } else inQ = false;
      } else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { row.push(cur); cur = ""; }
    else if (c === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; }
    else if (c !== "\r") cur += c;
  }
  if (cur.length || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim() !== ""));
}

/** Parse vCards (iPhone/iCloud contact exports) into import rows. */
function parseVCF(text: string): CustomerImportRow[] {
  const cards = text.split(/BEGIN:VCARD/i).slice(1);
  const unfold = (s: string) => s.replace(/\r?\n[ \t]/g, ""); // RFC line folding
  return cards
    .map((raw) => {
      const lines = unfold(raw).split(/\r?\n/);
      const get = (prefix: RegExp) => {
        const l = lines.find((x) => prefix.test(x));
        return l ? l.slice(l.indexOf(":") + 1).trim() : "";
      };
      const name = get(/^FN[:;]/i) || get(/^N[:;]/i).split(";").reverse().filter(Boolean).join(" ");
      const adr = get(/^ADR[:;]/i).split(";"); // ;;street;city;state;zip;country
      return {
        name,
        company_name: get(/^ORG[:;]/i).replace(/;+$/, ""),
        phone: get(/^TEL[:;]/i),
        email: get(/^EMAIL[:;]/i),
        address: adr[2] ?? "",
        city: adr[3] ?? "",
        state: adr[4] ?? "",
        zip: adr[5] ?? "",
      };
    })
    .filter((r) => r.name);
}

const FIELDS: { key: keyof CustomerImportRow; label: string; match: RegExp }[] = [
  { key: "name", label: "Name *", match: /^name$|full.?name|contact|first/i },
  { key: "company_name", label: "Company", match: /company|business|organization/i },
  { key: "email", label: "Email", match: /e-?mail/i },
  { key: "phone", label: "Phone", match: /phone|mobile|cell|tel/i },
  { key: "address", label: "Address", match: /address|street/i },
  { key: "city", label: "City", match: /city|town/i },
  { key: "state", label: "State", match: /state|province/i },
  { key: "zip", label: "Zip", match: /zip|postal/i },
  { key: "notes", label: "Notes", match: /note|comment|memo/i },
];

/** Import for the customer book. `csv` mode (Settings) takes a CSV with column
 *  mapping or a vCard; otherwise (CRM) it's a single-contact vCard import. */
export function ImportCustomersButton({ csv = true, label }: { csv?: boolean; label?: string }) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [headers, setHeaders] = useState<string[]>([]);
  const [dataRows, setDataRows] = useState<string[][]>([]);
  const [mapping, setMapping] = useState<Record<string, number>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function runVcfImport(rows: CustomerImportRow[]) {
    start(async () => {
      const res = await bulkImportCustomers(rows);
      setMsg(
        res.ok
          ? `Imported ${res.imported} contact${res.imported === 1 ? "" : "s"}${res.skipped ? ` (${res.skipped} duplicates skipped)` : ""}.`
          : res.error ?? "Import failed.",
      );
      setOpen(true);
      router.refresh();
    });
  }

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (fileRef.current) fileRef.current.value = "";
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result ?? "");

      // iPhone "Share Contact" / iCloud exports arrive as vCards.
      if (/^BEGIN:VCARD/im.test(text) || f.name.toLowerCase().endsWith(".vcf")) {
        const rows = parseVCF(text);
        if (!rows.length) {
          setMsg("No contacts found in that vCard file.");
          setOpen(true);
          return;
        }
        setHeaders([]);
        runVcfImport(rows);
        return;
      }

      if (!csv) {
        setMsg("That looks like a CSV — import spreadsheets from Settings → Company. Here, pick a single contact (.vcf).");
        setOpen(true);
        return;
      }
      const rows = parseCSV(text);
      if (rows.length < 2) {
        setMsg("That CSV needs a header row plus at least one data row.");
        setOpen(true);
        return;
      }
      const hdr = rows[0];
      const auto: Record<string, number> = {};
      for (const f of FIELDS) {
        const idx = hdr.findIndex((h) => f.match.test(h));
        if (idx >= 0) auto[f.key] = idx;
      }
      setHeaders(hdr);
      setDataRows(rows.slice(1));
      setMapping(auto);
      setMsg(null);
      setOpen(true);
    };
    reader.readAsText(f);
  }

  function runImport() {
    if (mapping.name === undefined) {
      setMsg("Map the Name column first.");
      return;
    }
    setMsg(null);
    start(async () => {
      const rows: CustomerImportRow[] = dataRows.map((r) => {
        const get = (k: string) => (mapping[k] !== undefined ? r[mapping[k]] ?? "" : "");
        return {
          name: get("name"),
          company_name: get("company_name"),
          email: get("email"),
          phone: get("phone"),
          address: get("address"),
          city: get("city"),
          state: get("state"),
          zip: get("zip"),
          notes: get("notes"),
        };
      });
      const res = await bulkImportCustomers(rows);
      if (!res.ok) return setMsg(res.error ?? "Import failed.");
      setMsg(`Imported ${res.imported} customer${res.imported === 1 ? "" : "s"}${res.skipped ? ` (${res.skipped} duplicates skipped)` : ""}.`);
      router.refresh();
    });
  }

  return (
    <>
      <span className="inline-flex flex-col gap-1">
        <Button
          variant="outline"
          onClick={() => fileRef.current?.click()}
          title={!csv ? "iPhone: open a contact → Share Contact → Save to Files, then pick it here" : undefined}
        >
          <Upload className="h-4 w-4" /> {label ?? (csv ? "Import contacts" : "Import a contact")}
        </Button>
        {!csv && (
          <span className="text-[11px] text-slate-400">
            iPhone: open a contact → Share → Save to Files, then pick the .vcf here.
          </span>
        )}
      </span>
      <input
        ref={fileRef}
        type="file"
        accept={csv ? ".csv,text/csv,.vcf,text/vcard" : ".vcf,text/vcard"}
        className="hidden"
        onChange={onFile}
      />

      <Modal open={open} onClose={() => setOpen(false)} title={csv ? "Import customers" : "Import a contact"}>
        <div className="space-y-4">
          {msg && <div className="rounded-lg bg-slate-100 px-3 py-2 text-sm text-slate-700">{msg}</div>}
          {headers.length > 0 && (
            <>
              <p className="text-sm text-slate-500">
                {dataRows.length} rows found. Match your CSV columns (auto-guessed — fix any that are wrong):
              </p>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                {FIELDS.map((f) => (
                  <div key={f.key}>
                    <Label>{f.label}</Label>
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
                      <option value="">— skip —</option>
                      {headers.map((h, i) => (
                        <option key={i} value={i}>{h || `Column ${i + 1}`}</option>
                      ))}
                    </Select>
                  </div>
                ))}
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setOpen(false)}>Close</Button>
                <Button onClick={runImport} disabled={pending}>
                  {pending ? "Importing…" : `Import ${dataRows.length} rows`}
                </Button>
              </div>
            </>
          )}
        </div>
      </Modal>
    </>
  );
}
