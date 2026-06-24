"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Upload, Check, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal, ModalActions } from "@/components/ui/modal";
import { importCrew, type CrewImportRow, type CrewImportResult } from "./actions";

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

function parseCsv(text: string): CrewImportRow[] {
  const lines = text.trim().split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const headers = splitLine(lines[0]).map((h) => h.trim().toLowerCase());
  const at = (re: RegExp) => headers.findIndex((h) => re.test(h));
  const iName = at(/name/), iEmail = at(/e-?mail/), iPhone = at(/phone|cell|mobile/), iRole = at(/role/);
  return lines
    .slice(1)
    .map(splitLine)
    .map((c) => ({
      full_name: (c[iName] ?? "").trim(),
      email: (c[iEmail] ?? "").trim(),
      phone: iPhone >= 0 ? (c[iPhone] ?? "").trim() : "",
      role: iRole >= 0 ? (c[iRole] ?? "").trim().toLowerCase() : "tech",
    }))
    // drop blank rows + any row flagged to skip (e.g. the owner who signs up themselves)
    .filter((r) => r.full_name && r.email.includes("@") && !/skip/i.test(r.role));
}

/** Bulk-add the crew from a roster CSV (Name, Email, Phone, Role). Each password is
 *  the employee's phone digits; the result list shows the login + password to hand out. */
export function CrewImportButton() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<CrewImportRow[]>([]);
  const [results, setResults] = useState<CrewImportResult[] | null>(null);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [requireReset, setRequireReset] = useState(true);

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
      const res = await importCrew(rows, requireReset);
      if (!res.ok) return setError(res.error ?? "Import failed.");
      setResults(res.results ?? []);
      router.refresh();
    });
  }

  const created = results?.filter((r) => r.status === "created") ?? [];
  const failed = results?.filter((r) => r.status === "failed") ?? [];

  return (
    <>
      <Button variant="outline" onClick={() => { reset(); setOpen(true); }}>
        <Upload className="h-4 w-4" /> Import crew (CSV)
      </Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Import crew"
        footer={
          results ? (
            <ModalActions onCancel={() => setOpen(false)} cancelLabel="Done" />
          ) : (
            <ModalActions onCancel={() => setOpen(false)} onSave={run} saving={pending} saveLabel={rows.length ? `Add ${rows.length} employees` : "Add employees"} disabled={!rows.length} />
          )
        }
      >
        {!results ? (
          <div className="space-y-4">
            <p className="text-sm text-slate-600">
              Upload a CSV with <span className="font-medium">Name, Email, Phone, Role</span> columns. Each person&apos;s password is
              set to their <span className="font-medium">phone digits</span> (no spaces/symbols) — the office hands those out.
            </p>
            <input type="file" accept=".csv,text/csv" onChange={onFile} className="block w-full text-sm text-slate-600 file:mr-3 file:rounded-lg file:border-0 file:bg-brand file:px-3 file:py-2 file:text-sm file:font-medium file:text-white" />
            {rows.length > 0 && (
              <div className="rounded-lg border border-slate-200">
                <div className="border-b border-slate-100 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-500">{rows.length} to add</div>
                <ul className="max-h-48 divide-y divide-slate-100 overflow-y-auto text-sm">
                  {rows.map((r, i) => (
                    <li key={i} className="flex items-center justify-between px-3 py-1.5">
                      <span className="font-medium text-slate-800">{r.full_name}</span>
                      <span className="text-xs text-slate-400">{r.email} · {r.role}{r.phone ? "" : " · no phone (temp pwd)"}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <label className="flex items-start gap-2 text-sm text-slate-700">
              <input type="checkbox" checked={requireReset} onChange={(e) => setRequireReset(e.target.checked)} className="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand" />
              <span>Require a password reset on first login <span className="text-slate-400">— they sign in with the phone/temp password once, then set their own.</span></span>
            </label>
            {error && <p className="text-sm text-red-600">{error}</p>}
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm font-medium text-green-700">
              <Check className="h-4 w-4" /> Added {created.length}{failed.length ? ` · ${failed.length} skipped` : ""}
            </div>
            <p className="text-xs text-slate-500">Give each person their login + password (their phone number).{requireReset ? " They'll set their own password the first time they sign in." : " They install the app and clock in."}</p>
            <div className="rounded-lg border border-slate-200">
              <ul className="max-h-64 divide-y divide-slate-100 overflow-y-auto text-sm">
                {created.map((r, i) => (
                  <li key={i} className="px-3 py-2">
                    <div className="font-medium text-slate-800">{r.name}</div>
                    <div className="text-xs text-slate-500">{r.email} · password: <span className="font-mono font-semibold text-slate-700">{r.password}</span></div>
                  </li>
                ))}
                {failed.map((r, i) => (
                  <li key={"f" + i} className="flex items-start gap-1.5 px-3 py-2 text-xs text-amber-700">
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
