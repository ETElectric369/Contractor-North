"use client";

import { parseCSV } from "@/lib/csv";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Upload, Check, AlertCircle, Link2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal, ModalActions } from "@/components/ui/modal";
import { importCrew, type CrewImportRow, type CrewImportResult } from "./actions";
import { CREW_IMPORT_WORDS } from "./crew-setup-link";

/**
 * THE ONE PARSER (cn-v700). This file carried a private `splitLine` doing `if (ch === '"') q = !q`
 * — the exact rule cn-v696 removed from lib/csv.ts, because an inch mark (`4" RND LS`, `2x6x12'`)
 * flipped quote mode mid-field and swallowed the rest of the line. csv.ts's own header claims to
 * be "the one parser the CSV imports share so they can't diverge on quoting edge cases"; it was
 * true of three importers out of five, and the fix made the two halves disagree about what a
 * quote means. It also handles a quoted field containing newlines, which line-splitting cannot.
 */
function parseCsv(text: string): CrewImportRow[] {
  const rows = parseCSV(text);
  if (rows.length < 2) return [];
  const headers = rows[0].map((h) => h.trim().toLowerCase());
  const at = (re: RegExp) => headers.findIndex((h) => re.test(h));
  const iName = at(/name/), iEmail = at(/e-?mail/), iPhone = at(/phone|cell|mobile/), iRole = at(/role/);
  // A `language` column (cn-v1138): "es", "español", "espanol" or "spanish" is Spanish, anything
  // else English (the action reads the word; a roster without the column leaves the default).
  const iLang = at(/^(language|idioma|lang)$/);
  return rows
    .slice(1)
    .map((c) => ({
      full_name: (c[iName] ?? "").trim(),
      email: (c[iEmail] ?? "").trim(),
      phone: iPhone >= 0 ? (c[iPhone] ?? "").trim() : "",
      role: iRole >= 0 ? (c[iRole] ?? "").trim().toLowerCase() : "tech",
      ...(iLang >= 0 ? { language: (c[iLang] ?? "").trim() } : {}),
    }))
    // drop blank rows + any row flagged to skip (e.g. the owner who signs up themselves)
    .filter((r) => r.full_name && r.email.includes("@") && !/skip/i.test(r.role));
}

/** One created person's link, copied to the clipboard on a tap. The link is also printed so it can
 *  be selected where the clipboard is not available (an older native shell, a locked-down browser)
 *  — and the button SAYS when that is the case (no clipboard, or a refused write), never nothing. */
function CopyLinkButton({ link }: { link: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const copy = () => {
    const clipboard = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
    if (!clipboard?.writeText) {
      setState("failed");
      return;
    }
    clipboard
      .writeText(link)
      .then(() => {
        setState("copied");
        setTimeout(() => setState("idle"), 2000);
      })
      .catch(() => setState("failed"));
  };
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Button type="button" variant="outline" size="sm" onClick={copy}>
        <Link2 className="h-3.5 w-3.5" /> {state === "copied" ? "Copied" : "Copy Link"}
      </Button>
      {state === "failed" && (
        <span role="status" className="text-xs text-rose-700">
          Couldn&apos;t copy — select the link.
        </span>
      )}
    </span>
  );
}

/**
 * THE IMPORT'S ANSWER (cn-v1134): one row per person. A created person's row holds their one-time
 * link and Copy Link; a created person with no link, or a failed row, says why in words. No row ever
 * shows a password: the login was made with one nobody sees, and the link opens Set A Password.
 */
export function CrewImportResults({ results }: { results: CrewImportResult[] }) {
  const created = results.filter((r) => r.status === "created");
  const failed = results.filter((r) => r.status === "failed");
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-sm font-medium text-green-700">
        <Check className="h-4 w-4" /> Added {created.length}{failed.length ? ` · ${failed.length} skipped` : ""}
      </div>
      {created.length > 0 && (
        <>
          <p className="text-sm text-slate-700">{CREW_IMPORT_WORDS.handOut}</p>
          <p className="text-xs text-slate-500">{CREW_IMPORT_WORDS.onceAndSoon}</p>
        </>
      )}
      <div className="rounded-lg border border-slate-200">
        <ul className="max-h-64 divide-y divide-slate-100 overflow-y-auto text-sm">
          {created.map((r, i) => (
            <li key={i} className="px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-medium text-slate-800">{r.name}</div>
                  <div className="truncate text-xs text-slate-500">{r.email}</div>
                </div>
                {r.setupLink && <CopyLinkButton link={r.setupLink} />}
              </div>
              {r.setupLink ? (
                <div className="mt-1 break-all font-mono text-[11px] text-slate-500" data-setup-link>
                  {r.setupLink}
                </div>
              ) : (
                <div className="mt-1 text-xs text-amber-700">{r.reason}</div>
              )}
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
  );
}

/** Bulk-add the crew from a roster CSV (Name, Email, Phone, Role). Each person gets a one-time
 *  link that opens Set A Password; the import emails nobody and shows no password. */
export function CrewImportButton() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<CrewImportRow[]>([]);
  const [results, setResults] = useState<CrewImportResult[] | null>(null);
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
      const res = await importCrew(rows);
      if (!res.ok) return setError(res.error ?? "Import failed.");
      setResults(res.results ?? []);
      router.refresh();
    });
  }

  return (
    <>
      <Button variant="outline" onClick={() => { reset(); setOpen(true); }}>
        <Upload className="h-4 w-4" /> Import Crew (CSV)
      </Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Import Crew"
        footer={
          results ? (
            <ModalActions onCancel={() => setOpen(false)} cancelLabel="Done" />
          ) : (
            <ModalActions onCancel={() => setOpen(false)} onSave={run} saving={pending} saveLabel={rows.length ? `Add ${rows.length} Employees` : "Add Employees"} disabled={!rows.length} />
          )
        }
      >
        {!results ? (
          <div className="space-y-4">
            <p className="text-sm text-slate-600">{CREW_IMPORT_WORDS.before}</p>
            <input type="file" accept=".csv,text/csv" onChange={onFile} className="block w-full text-sm text-slate-600 file:mr-3 file:rounded-lg file:border-0 file:bg-brand file:px-3 file:py-2 file:text-sm file:font-medium file:text-white" />
            {rows.length > 0 && (
              <div className="rounded-lg border border-slate-200">
                <div className="border-b border-slate-100 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-500">{rows.length} to add</div>
                <ul className="max-h-48 divide-y divide-slate-100 overflow-y-auto text-sm">
                  {rows.map((r, i) => (
                    <li key={i} className="flex items-center justify-between px-3 py-1.5">
                      <span className="font-medium text-slate-800">{r.full_name}</span>
                      <span className="text-xs text-slate-400">{r.email} · {r.role}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {error && <p className="text-sm text-red-600">{error}</p>}
          </div>
        ) : (
          <CrewImportResults results={results} />
        )}
      </Modal>
    </>
  );
}
