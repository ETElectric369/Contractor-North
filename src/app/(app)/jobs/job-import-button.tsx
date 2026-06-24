"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Upload, Check, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal, ModalActions } from "@/components/ui/modal";
import { importJobs, type JobImportRow, type JobImportResult } from "./actions";

function splitLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (const ch of line) {
    if (ch === '"') q = !q;
    else if (ch === "," && !q) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

function num(s: string): number {
  const n = Number((s || "").replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function parseCsv(text: string): JobImportRow[] {
  const lines = text.trim().split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const headers = splitLine(lines[0]).map((h) => h.trim().toLowerCase());
  const at = (re: RegExp) => headers.findIndex((h) => re.test(h));
  const iCust = at(/customer|client/), iJob = at(/job|name|project/), iVal = at(/value|amount|contract|price|total/),
    iStatus = at(/status|stage/), iAddr = at(/address|street/), iCity = at(/city/), iState = at(/state/),
    iZip = at(/zip|postal/), iEmail = at(/e-?mail/), iPhone = at(/phone|cell|mobile/);
  const v = (c: string[], i: number) => (i >= 0 ? (c[i] ?? "").trim() : "");
  return lines
    .slice(1)
    .map(splitLine)
    .map((c) => ({
      customer: v(c, iCust),
      job_name: v(c, iJob),
      value: num(v(c, iVal)),
      status: v(c, iStatus).toLowerCase().replace(/\s+/g, "_"),
      address: v(c, iAddr),
      city: v(c, iCity),
      state: v(c, iState),
      zip: v(c, iZip),
      email: v(c, iEmail),
      phone: v(c, iPhone),
    }))
    .filter((r) => r.customer || r.job_name);
}

const fmt = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

/** Bulk-import in-progress jobs from a CSV (Customer, Job Name, Value, Status, Address…). */
export function JobImportButton() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<JobImportRow[]>([]);
  const [results, setResults] = useState<JobImportResult[] | null>(null);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setRows([]);
    setResults(null);
    setError(null);
  }

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    f.text().then((t) => {
      setRows(parseCsv(t));
      setResults(null);
      setError(null);
    });
  }

  function run() {
    if (!rows.length) return;
    setError(null);
    start(async () => {
      const res = await importJobs(rows);
      if (!res.ok) return setError(res.error ?? "Import failed.");
      setResults(res.results ?? []);
      router.refresh();
    });
  }

  const created = results?.filter((r) => r.status === "created") ?? [];
  const failed = results?.filter((r) => r.status === "failed") ?? [];
  const total = rows.reduce((s, r) => s + (r.value ?? 0), 0);

  return (
    <>
      <Button variant="outline" onClick={() => { reset(); setOpen(true); }}>
        <Upload className="h-4 w-4" /> Import jobs
      </Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Import jobs"
        footer={
          results ? (
            <ModalActions onCancel={() => setOpen(false)} cancelLabel="Done" />
          ) : (
            <ModalActions onCancel={() => setOpen(false)} onSave={run} saving={pending} saveLabel={rows.length ? `Import ${rows.length} jobs` : "Import jobs"} disabled={!rows.length} />
          )
        }
      >
        {!results ? (
          <div className="space-y-4">
            <p className="text-sm text-slate-600">
              Upload a CSV with <span className="font-medium">Customer, Job Name, Value, Status, Address, City, State, Zip, Email, Phone</span>.
              Each row creates (or reuses) the customer, the job, and records the value as the contract.
            </p>
            <input type="file" accept=".csv,text/csv" onChange={onFile} className="block w-full text-sm text-slate-600 file:mr-3 file:rounded-lg file:border-0 file:bg-brand file:px-3 file:py-2 file:text-sm file:font-medium file:text-white" />
            {rows.length > 0 && (
              <div className="rounded-lg border border-slate-200">
                <div className="flex items-center justify-between border-b border-slate-100 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  <span>{rows.length} jobs</span>
                  <span>{fmt(total)} total</span>
                </div>
                <ul className="max-h-48 divide-y divide-slate-100 overflow-y-auto text-sm">
                  {rows.map((r, i) => (
                    <li key={i} className="flex items-center justify-between gap-2 px-3 py-1.5">
                      <span className="truncate font-medium text-slate-800">{r.job_name || r.customer}</span>
                      <span className="shrink-0 text-xs text-slate-400">{r.customer}{r.value ? ` · ${fmt(r.value)}` : ""}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {error && <p className="text-sm text-red-600">{error}</p>}
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm font-medium text-green-700">
              <Check className="h-4 w-4" /> Imported {created.length}{failed.length ? ` · ${failed.length} failed` : ""}
            </div>
            <div className="rounded-lg border border-slate-200">
              <ul className="max-h-64 divide-y divide-slate-100 overflow-y-auto text-sm">
                {created.map((r, i) => (
                  <li key={i} className="px-3 py-1.5 text-slate-700">{r.name}</li>
                ))}
                {failed.map((r, i) => (
                  <li key={"f" + i} className="flex items-start gap-1.5 px-3 py-1.5 text-xs text-amber-700">
                    <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {r.name} — {r.reason}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}
