"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { FileUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Modal, ModalActions } from "@/components/ui/modal";
import { DropTarget } from "@/components/drop-target";
import { useToast } from "@/components/toast";
import { parseCSV } from "@/lib/csv";
import { readPdfText } from "@/lib/pdf-text";
import { canInflateRawHere, inflateRawInBrowser, readXlsx } from "@/lib/xlsx-read";
import { vendorKindOf } from "./item-options-math";
import { addVendorsBatch, undoVendorImport } from "./vendor-actions";
import {
  KIND_CHOICES,
  buildPreview,
  isBlocked,
  notesFor,
  previewHeading,
  rowsFromTable,
  rowsToAdd,
  tableFromLines,
  type ExistingVendor,
  type PreviewRow,
  type RowNote,
} from "./vendor-import-math";

/**
 * IMPORT A LIST (vendor import, Phase 1, free). Andrew dropped Vivian_Builders_Vendors.xlsx on the
 * Vendors tab; this is the door it lands on.
 *
 * Reading costs nothing and happens here in the browser: .xlsx through the zero-dependency reader,
 * CSV and text through parseCSV, a PDF with a text layer through readPdfText. A photo or a scanned
 * PDF says plainly that Nort reading it is coming next. The preview is a guess a person corrects:
 * NOTHING IS SAVED UNTIL ADD, and Add is one press with an Undo that leaves edited cards alone.
 */

export const IMPORT_ACCEPT = ".xlsx,.xls,.csv,.txt,.pdf,image/*,.heic,.heif";
const FILE_MAX = 10 * 1024 * 1024;

type Read = { ok: true; table: string[][] } | { ok: false; error: string };

/** A file → rows of cells, or the sentence naming why not. */
async function readList(file: File): Promise<Read> {
  const name = file.name || "That file";
  const lower = name.toLowerCase();
  const type = (file.type || "").toLowerCase();
  if (file.size > FILE_MAX) return { ok: false, error: `${name} is over 10 MB. Save just the vendor list as .xlsx or CSV and drop that.` };
  if (type.startsWith("image/") || /\.(heic|heif|jpe?g|png|gif|webp)$/.test(lower)) {
    return { ok: false, error: `${name} is a photo. Reading a photo of a list with Nort is Coming Next. For now, save the list as Excel or CSV, or add vendors one at a time.` };
  }
  if (/\.xlsx?$/.test(lower) || type.includes("spreadsheetml") || type === "application/vnd.ms-excel") {
    if (/\.xlsx$/.test(lower) && !canInflateRawHere()) return { ok: false, error: `This device can't open .xlsx. Save ${name} as CSV and drop that.` };
    const res = await readXlsx(new Uint8Array(await file.arrayBuffer()), inflateRawInBrowser, name);
    return res.ok ? { ok: true, table: res.rows } : res;
  }
  if (/\.pdf$/.test(lower) || type === "application/pdf") {
    const res = await readPdfText(await file.arrayBuffer(), name);
    if (!res.ok) {
      return /no text in it/.test(res.error)
        ? { ok: false, error: `${name} has no text in it, so it's probably a scan. Reading scans with Nort is Coming Next. For now, save the list as Excel or CSV.` }
        : res;
    }
    return { ok: true, table: tableFromLines(res.text) };
  }
  if (/\.(csv|txt|tsv)$/.test(lower) || type.startsWith("text/")) {
    const text = await file.text();
    const table = text.includes("\t") ? text.split(/\r?\n/).map((l) => l.split("\t")).filter((r) => r.some((c) => c.trim())) : parseCSV(text);
    return { ok: true, table };
  }
  return { ok: false, error: `${name} isn't a kind of list this can read. Save it as .xlsx or CSV and drop it again.` };
}

/** A v4 UUID for the batch, also on a browser without crypto.randomUUID (iOS before 15.4). */
function newBatchId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function VendorImport({ existing, disabled }: { existing: ExistingVendor[]; disabled?: boolean }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ file: string; rows: PreviewRow[]; headerSkipped: boolean; overCap: number } | null>(null);

  async function onFiles(files: File[]) {
    const file = files[0];
    if (!file) return;
    setError(null);
    setReading(true);
    try {
      const read = await readList(file);
      if (!read.ok) return setError(read.error);
      const { rows, headerSkipped, overCap } = rowsFromTable(read.table);
      if (!rows.length) return setError(`No names were found in ${file.name}. The names need to be in a column, one per row.`);
      setPreview({ file: file.name, rows: buildPreview(rows, existing), headerSkipped, overCap });
    } catch (e) {
      setError(`${file.name} couldn't be read (${(e as Error)?.message ?? "unknown error"}). Save it as CSV and try again.`);
    } finally {
      setReading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <DropTarget onFiles={(f) => void onFiles(f)} accept={IMPORT_ACCEPT} multiple={false} disabled={disabled} label="Drop A Vendor List Here (Excel, CSV, PDF Or Photo)">
        <div className="flex flex-col gap-1">
          <Button variant="outline" onClick={() => fileRef.current?.click()} disabled={disabled || reading} aria-describedby="vendor-import-hint">
            <FileUp className="h-4 w-4" /> {reading ? "Reading…" : "Import A List"}
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept={IMPORT_ACCEPT}
            className="hidden"
            onChange={(e) => void onFiles(Array.from(e.target.files ?? []))}
          />
        </div>
      </DropTarget>
      <span id="vendor-import-hint" className="sr-only">
        Excel, CSV, text or PDF. Nothing is saved until you press Add.
      </span>
      {error && (
        <p role="alert" className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {error}
        </p>
      )}
      {preview && (
        <ImportPreview
          fileName={preview.file}
          initial={preview.rows}
          headerSkipped={preview.headerSkipped}
          overCap={preview.overCap}
          existing={existing}
          onClose={() => setPreview(null)}
        />
      )}
    </div>
  );
}

function ImportPreview({
  fileName,
  initial,
  headerSkipped,
  overCap,
  existing,
  onClose,
}: {
  fileName: string;
  initial: PreviewRow[];
  headerSkipped: boolean;
  overCap: number;
  existing: ExistingVendor[];
  onClose: () => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const [, startRefresh] = useTransition();
  const [rows, setRows] = useState<PreviewRow[]>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Notes follow the NAMES (and the person flag), not the ticks or kinds, so ticking a box never
  // re-runs the matcher over the whole list.
  const noteKey = rows.map((r) => `${r.id}\u0000${r.name}\u0000${r.is_person ? 1 : 0}\u0000${r.copies}`).join("\u0001");
  const notes = useMemo(() => {
    const out = new Map<string, RowNote[]>();
    for (const r of rows) out.set(r.id, notesFor(r, rows, existing));
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteKey, existing]);

  const toAdd = rowsToAdd(rows, existing);
  const n = toAdd.length;
  const heading = previewHeading(initial.length, fileName, headerSkipped, overCap);
  const patch = (id: string, p: Partial<PreviewRow>) => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...p } : r)));
  const tickAll = (on: boolean) => setRows((rs) => rs.map((r) => ({ ...r, ticked: on && !isBlocked(notes.get(r.id) ?? []) })));

  async function add() {
    if (saving || n === 0) return;
    setSaving(true);
    setError(null);
    const batchId = newBatchId();
    const res = await addVendorsBatch(toAdd, batchId);
    setSaving(false);
    if (!res.ok) {
      const why = (res.refused ?? []).map((r) => `${r.name}: ${r.why}`).join(" ");
      return setError([res.error ?? "Couldn't add those vendors.", why].filter(Boolean).join(" "));
    }
    const done = (res.added ?? 0) + (res.restored?.length ?? 0);
    const restored = (res.restored ?? []).map((r) => ({ id: r.id, stamp: r.stamp }));
    toast(`Added ${done} vendor${done === 1 ? "" : "s"}.${res.note ? ` ${res.note}` : ""}`, "success", {
      label: "Undo",
      onClick: async () => {
        const back = await undoVendorImport({ batchId, restored });
        if (!back.ok) return toast(back.error ?? "Couldn't undo that import.", "error");
        toast(back.note ?? "Undone", back.leftAlone?.length ? "info" : "success", undefined, back.leftAlone?.length ? { sticky: true } : undefined);
        startRefresh(() => router.refresh());
      },
    });
    if (res.refused?.length) {
      toast(`Not added: ${res.refused.map((r) => `${r.name} (${r.why})`).join("; ")}`, "info", undefined, { sticky: true });
    }
    onClose();
    startRefresh(() => router.refresh());
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={heading.title}
      size="xl"
      dirty
      footer={
        <ModalActions
          onCancel={onClose}
          onSave={() => void add()}
          saving={saving}
          disabled={n === 0}
          saveLabel={n === 0 ? "Nothing Ticked" : `Add ${n} Vendor${n === 1 ? "" : "s"}`}
        />
      }
    >
      <div className="space-y-3">
        <p className="text-sm text-slate-600">
          {heading.detail ? `${heading.detail} ` : ""}
          <strong className="font-semibold text-slate-900">Nothing is saved until you press Add.</strong> The kinds are guesses from the names: change any
          that are wrong.
        </p>
        {error && (
          <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button variant="ghost" onClick={() => tickAll(true)}>
            Tick All
          </Button>
          <Button variant="ghost" onClick={() => tickAll(false)}>
            Untick All
          </Button>
        </div>
        <ul className="space-y-2">
          {rows.map((r) => {
            const rowNotes = notes.get(r.id) ?? [];
            const blocked = isBlocked(rowNotes);
            return (
              <li key={r.id} className={`rounded-xl border px-3 py-2 ${r.ticked && !blocked ? "border-slate-200 bg-white" : "border-slate-100 bg-slate-50"}`}>
                <div className="flex items-start gap-2">
                  <label className="flex min-h-11 min-w-11 shrink-0 cursor-pointer items-center justify-center" title={blocked ? "Can't Be Added" : "Add This One"}>
                    <input
                      type="checkbox"
                      className="h-5 w-5"
                      checked={r.ticked && !blocked}
                      disabled={blocked}
                      onChange={(e) => patch(r.id, { ticked: e.target.checked })}
                      aria-label={`Add ${r.name || "this row"}`}
                    />
                  </label>
                  <div className="min-w-0 flex-1 space-y-2">
                    <Input value={r.name} onChange={(e) => patch(r.id, { name: e.target.value })} aria-label="Vendor Name" autoComplete="off" />
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
                      <div>
                        <Select
                          className="h-11"
                          value={r.kind ?? ""}
                          onChange={(e) => patch(r.id, { kind: vendorKindOf(e.target.value) ?? null, kindGuessed: false })}
                          aria-label={`Kind for ${r.name}`}
                        >
                          {KIND_CHOICES.map((k) => (
                            <option key={k.value} value={k.value}>
                              {k.label}
                            </option>
                          ))}
                        </Select>
                        {r.kindGuessed && <span className="mt-0.5 block text-xs text-slate-500">Guessed From The Name</span>}
                      </div>
                      <Input
                        className="h-11"
                        value={r.trade ?? ""}
                        placeholder="Trade, e.g. Plumbing"
                        maxLength={60}
                        onChange={(e) => patch(r.id, { trade: e.target.value })}
                        aria-label={`Trade for ${r.name}`}
                        autoComplete="off"
                      />
                      <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm text-slate-700">
                        <input type="checkbox" className="h-5 w-5" checked={r.is_person} onChange={(e) => patch(r.id, { is_person: e.target.checked })} />
                        A Person
                      </label>
                    </div>
                    {(r.phone || r.email || r.website || r.contact_name || r.address) && (
                      <p className="truncate text-xs text-slate-500">
                        {[r.contact_name, r.phone, r.email, r.website, r.address].filter(Boolean).join(" · ")}
                      </p>
                    )}
                    {rowNotes.length > 0 && (
                      <ul className="space-y-0.5">
                        {rowNotes.map((note) => (
                          <li
                            key={note.kind}
                            className={`text-xs ${note.kind === "already" || note.kind === "too-long" || note.kind === "same-company" ? "text-amber-800" : "text-slate-600"}`}
                          >
                            {note.text}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </Modal>
  );
}
