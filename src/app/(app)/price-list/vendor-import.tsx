"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { FileUp, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Modal, ModalActions } from "@/components/ui/modal";
import { DropTarget } from "@/components/drop-target";
import { useToast } from "@/components/toast";
import { parseCSV } from "@/lib/csv";
import { readPdfText } from "@/lib/pdf-text";
import { canInflateRawHere, inflateRawInBrowser, readXlsx } from "@/lib/xlsx-read";
import { vendorKey, vendorKindOf } from "./item-options-math";
import { addVendorsBatch, undoVendorImport } from "./vendor-actions";
import { FoundChanges, LookupChoices } from "./vendor-choices";
import { lookUpVendors, readVendorList } from "./vendor-lookup-actions";
import {
  LOOKUP_CHUNK,
  LOOKUP_PER_TAP,
  READ_EACH_USD,
  applyPick,
  autoPick,
  changesFor,
  lookupPrice,
  type LookupAnswer,
  type LookupChoice,
} from "./vendor-lookup-math";
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
 * IMPORT A LIST (vendor import). Andrew dropped Vivian_Builders_Vendors.xlsx on the Vendors tab;
 * this is the door it lands on.
 *
 * Reading costs nothing and happens here in the browser: .xlsx through the zero-dependency reader,
 * CSV and text through parseCSV, a PDF with a text layer through readPdfText. A photo or a scanned
 * PDF is offered to Nort at a price stated before the tap (Phase 2, readVendorList). The preview is a
 * guess a person corrects: NOTHING IS SAVED UNTIL ADD, and Add is one press with an Undo that leaves
 * edited cards alone.
 *
 * LOOK UP (Phase 2, paid): each row's Look Up, and Look Up For N (30 at most per press), run five
 * names per server call with a real "12 of 29 looked up" count and a Stop. A lookup only fills the
 * row. Leaving the page stops the run: the lookups already paid for are lost, nothing half-saved is
 * left behind.
 */

export const IMPORT_ACCEPT = ".xlsx,.xls,.csv,.txt,.pdf,image/*,.heic,.heif";
const FILE_MAX = 10 * 1024 * 1024;

type Read = { ok: true; table: string[][] } | { ok: false; error: string; offer?: "photo" | "scan" };
const READ_MAX = 8 * 1024 * 1024;

/** A file → rows of cells, or the sentence naming why not. */
async function readList(file: File): Promise<Read> {
  const name = file.name || "That file";
  const lower = name.toLowerCase();
  const type = (file.type || "").toLowerCase();
  if (file.size > FILE_MAX) return { ok: false, error: `${name} is over 10 MB. Save just the vendor list as .xlsx or CSV and drop that.` };
  if (type.startsWith("image/") || /\.(heic|heif|jpe?g|png|gif|webp)$/.test(lower)) {
    if (/heic|heif/.test(type) || /\.(heic|heif)$/.test(lower)) {
      return { ok: false, error: `${name} is a HEIC photo, which can't be read yet. Take a screenshot of it and drop that.` };
    }
    if (file.size > READ_MAX) return { ok: false, error: `${name} is over 8 MB, too big to read. Take a screenshot of the list and drop that.` };
    return { ok: false, error: "", offer: "photo" };
  }
  if (/\.xlsx?$/.test(lower) || type.includes("spreadsheetml") || type === "application/vnd.ms-excel") {
    if (/\.xlsx$/.test(lower) && !canInflateRawHere()) return { ok: false, error: `This device can't open .xlsx. Save ${name} as CSV and drop that.` };
    const res = await readXlsx(new Uint8Array(await file.arrayBuffer()), inflateRawInBrowser, name);
    return res.ok ? { ok: true, table: res.rows } : res;
  }
  if (/\.pdf$/.test(lower) || type === "application/pdf") {
    const res = await readPdfText(await file.arrayBuffer(), name);
    if (!res.ok) {
      if (!/no text in it/.test(res.error)) return res;
      if (file.size > READ_MAX) return { ok: false, error: `${name} has no text in it and is over 8 MB, too big to read. Save the list as Excel or CSV.` };
      return { ok: false, error: "", offer: "scan" };
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
  const [preview, setPreview] = useState<{ file: string; rows: PreviewRow[]; headerSkipped: boolean; overCap: number; note?: string } | null>(null);
  /** A photo or a scanned PDF, waiting for a person to say yes to the stated price. */
  const [offer, setOffer] = useState<{ file: File; kind: "photo" | "scan" } | null>(null);

  function open(fileName: string, table: string[][], note?: string) {
    const { rows, headerSkipped, overCap } = rowsFromTable(table);
    if (!rows.length) return setError(`No names were found in ${fileName}. The names need to be in a column, one per row.`);
    setPreview({ file: fileName, rows: buildPreview(rows, existing), headerSkipped, overCap, note });
  }

  async function onFiles(files: File[]) {
    const file = files[0];
    if (!file) return;
    setError(null);
    setOffer(null);
    setReading(true);
    try {
      const read = await readList(file);
      if (!read.ok) {
        if (read.offer) return setOffer({ file, kind: read.offer });
        return setError(read.error);
      }
      open(file.name, read.table);
    } catch (e) {
      setError(`${file.name} couldn't be read (${(e as Error)?.message ?? "unknown error"}). Save it as CSV and try again.`);
    } finally {
      setReading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  /** The paid read, only after the tap that stated its price. */
  async function readWithNort() {
    if (!offer || reading) return;
    const { file } = offer;
    setError(null);
    setReading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await readVendorList(fd);
      if (!res.ok) return setError(res.error);
      setOffer(null);
      open(file.name, res.table, res.note);
    } catch {
      setError(`${file.name} couldn't be sent to be read. Check the connection and try again.`);
    } finally {
      setReading(false);
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
        Excel, CSV, text, PDF or a photo. Nothing is saved until you press Add.
      </span>
      {offer && (
        <div role="group" aria-label="Read With Nort" className="space-y-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700">
          <p>
            {offer.kind === "photo"
              ? `${offer.file.name} is a photo. Nort can read the names off it for about $${READ_EACH_USD.toFixed(2)}.`
              : `${offer.file.name} has no text in it, so it's probably a scan. Nort can read it for about $${READ_EACH_USD.toFixed(2)} a page.`}{" "}
            It counts toward your monthly AI allowance, and nothing is saved until you press Add.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void readWithNort()} disabled={reading}>
              {reading ? "Reading…" : "Read With Nort"}
            </Button>
            <Button variant="ghost" onClick={() => setOffer(null)} disabled={reading}>
              Cancel
            </Button>
          </div>
        </div>
      )}
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
          note={preview.note}
          existing={existing}
          onClose={() => setPreview(null)}
        />
      )}
    </div>
  );
}

/** A row's lookup: running, answered (for the name it was run with), or refused. */
type LookState =
  | { status: "running" }
  | { status: "done"; answer: LookupAnswer; asName: string; auto: boolean; hidden: boolean };

const rowValues = (r: PreviewRow) => ({ phone: r.phone, email: r.email, website: r.website, address: r.address });

/** A pick of `choice` for this row: the fields it would fill start ticked, typed ones don't. */
function pickFor(r: PreviewRow, choice: LookupChoice): NonNullable<PreviewRow["pick"]> {
  return { choice, take: changesFor(rowValues(r), choice).filter((c) => c.take).map((c) => c.field) };
}

function ImportPreview({
  fileName,
  initial,
  headerSkipped,
  overCap,
  note,
  existing,
  onClose,
}: {
  fileName: string;
  initial: PreviewRow[];
  headerSkipped: boolean;
  overCap: number;
  note?: string;
  existing: ExistingVendor[];
  onClose: () => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const [, startRefresh] = useTransition();
  const [rows, setRows] = useState<PreviewRow[]>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [looks, setLooks] = useState<Record<string, LookState>>({});
  const [run, setRun] = useState<{ done: number; total: number; stopping: boolean } | null>(null);
  const [lookError, setLookError] = useState<string | null>(null);
  const stopRef = useRef(false);
  // Closing the preview (or leaving the page) stops a run: no chunk is started for a screen that's gone.
  useEffect(
    () => () => {
      stopRef.current = true;
    },
    [],
  );

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

  // WHAT LOOK UP FOR N WOULD LOOK UP: ticked rows that can be added and haven't been looked up.
  const waiting = rows.filter((r) => r.ticked && vendorKey(r.name) && !isBlocked(notes.get(r.id) ?? []) && !looks[r.id]);
  const nextBatch = Math.min(waiting.length, LOOKUP_PER_TAP);

  /** Look these rows up, five names per server call, stopping when asked or when the screen closes. */
  async function lookUp(targets: PreviewRow[]) {
    if (!targets.length || run) return;
    stopRef.current = false;
    setLookError(null);
    let done = 0;
    setRun({ done, total: targets.length, stopping: false });
    for (let i = 0; i < targets.length; i += LOOKUP_CHUNK) {
      if (stopRef.current) break;
      const chunk = targets.slice(i, i + LOOKUP_CHUNK);
      setLooks((ls) => ({ ...ls, ...Object.fromEntries(chunk.map((r) => [r.id, { status: "running" } as LookState])) }));
      let res: Awaited<ReturnType<typeof lookUpVendors>>;
      try {
        res = await lookUpVendors({ names: chunk.map((r) => ({ name: r.name.trim(), isPerson: r.is_person })) });
      } catch {
        res = { ok: false, error: "The lookup didn't answer. Check the connection and try again." };
      }
      if (!res.ok) {
        const why = res.error;
        setLooks((ls) => {
          const next = { ...ls };
          for (const r of chunk) delete next[r.id];
          return next;
        });
        setLookError(why);
        break;
      }
      const answers = new Map(chunk.map((r, j) => [r.id, { answer: res.results[j]?.answer, asName: r.name.trim(), isPerson: r.is_person }]));
      setLooks((ls) => {
        const next = { ...ls };
        for (const [id, a] of answers) {
          if (!a.answer) delete next[id];
          else next[id] = { status: "done", answer: a.answer, asName: a.asName, auto: !!autoPick(a.answer, a.isPerson), hidden: false };
        }
        return next;
      });
      // THE ONLY PICK MADE FOR A PERSON: exactly one choice came back, for a company's name. It is on
      // screen, marked as picked for them, with None Of These beside it.
      setRows((rs) =>
        rs.map((r) => {
          const a = answers.get(r.id);
          const only = a?.answer ? autoPick(a.answer, a.isPerson) : null;
          return only && !r.pick ? { ...r, pick: pickFor(r, only) } : r;
        }),
      );
      done += chunk.length;
      setRun((cur) => (cur ? { ...cur, done } : cur));
    }
    setRun(null);
  }

  function choose(r: PreviewRow, choice: LookupChoice) {
    patch(r.id, { pick: pickFor(r, choice) });
    setLooks((ls) => {
      const cur = ls[r.id];
      return cur?.status === "done" ? { ...ls, [r.id]: { ...cur, auto: false } } : ls;
    });
  }
  function none(r: PreviewRow) {
    patch(r.id, { pick: null });
    setLooks((ls) => {
      const cur = ls[r.id];
      return cur?.status === "done" ? { ...ls, [r.id]: { ...cur, auto: false, hidden: true } } : ls;
    });
  }
  function reopen(id: string) {
    setLooks((ls) => {
      const cur = ls[id];
      return cur?.status === "done" ? { ...ls, [id]: { ...cur, hidden: false } } : ls;
    });
  }

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
          {note ? `${note} ` : ""}
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
        {/* LOOK UP FOR N: the price is on the button before the tap. */}
        <div className="space-y-1 rounded-lg border border-slate-200 bg-white px-3 py-2">
          {run ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium text-slate-800" role="status" aria-live="polite">
                {run.done} of {run.total} looked up{run.stopping ? ", stopping after these…" : "…"}
              </span>
              <Button
                variant="outline"
                disabled={run.stopping}
                onClick={() => {
                  stopRef.current = true;
                  setRun((cur) => (cur ? { ...cur, stopping: true } : cur));
                }}
              >
                Stop
              </Button>
            </div>
          ) : (
            <>
              <Button variant="outline" disabled={nextBatch === 0} onClick={() => void lookUp(waiting.slice(0, LOOKUP_PER_TAP))}>
                <Search className="h-4 w-4" /> {nextBatch === 0 ? "Nothing To Look Up" : `Look Up Contact Info For ${nextBatch}`}
              </Button>
              <p className="text-xs text-slate-500">
                {nextBatch > 0
                  ? `Nort searches the web for each name: ${lookupPrice(nextBatch)}. Counts toward your monthly AI allowance.${waiting.length > LOOKUP_PER_TAP ? ` ${LOOKUP_PER_TAP} at a time; press again for the rest.` : ""} Picking one only fills the row.`
                  : "Every ticked name has been looked up, or none is ticked."}
              </p>
            </>
          )}
          {lookError && (
            <p role="alert" className="text-sm text-red-700">
              {lookError}
            </p>
          )}
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
                    {(() => {
                      const v = applyPick(rowValues(r), r.pick);
                      const bits = [r.contact_name, v.phone, v.email, v.website, v.address].filter(Boolean);
                      return bits.length ? <p className="truncate text-xs text-slate-500">{bits.join(" · ")}</p> : null;
                    })()}
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
                    <RowLookup
                      row={r}
                      look={looks[r.id]}
                      busy={!!run}
                      blocked={blocked}
                      onLookUp={() => void lookUp([r])}
                      onPick={(c) => choose(r, c)}
                      onNone={() => none(r)}
                      onReopen={() => reopen(r.id)}
                      onTake={(take) => r.pick && patch(r.id, { pick: { ...r.pick, take } })}
                    />
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

/** One row's Look Up: the button with its price, then what came back, then what the pick fills. */
function RowLookup({
  row: r,
  look,
  busy,
  blocked,
  onLookUp,
  onPick,
  onNone,
  onReopen,
  onTake,
}: {
  row: PreviewRow;
  look: LookState | undefined;
  busy: boolean;
  blocked: boolean;
  onLookUp: () => void;
  onPick: (c: LookupChoice) => void;
  onNone: () => void;
  onReopen: () => void;
  onTake: (take: NonNullable<PreviewRow["pick"]>["take"]) => void;
}) {
  if (!look) {
    if (blocked || !vendorKey(r.name)) return null;
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" onClick={onLookUp} disabled={busy} aria-label={`Look Up ${r.name}, ${lookupPrice(1)}`}>
          <Search className="h-4 w-4" /> Look Up
        </Button>
        <span className="text-xs text-slate-500">{lookupPrice(1)}</span>
      </div>
    );
  }
  if (look.status === "running") {
    return (
      <p className="text-xs text-slate-500" role="status">
        Looking up {r.name.trim() || "this one"}…
      </p>
    );
  }
  const renamed = vendorKey(look.asName) !== vendorKey(r.name);
  return (
    <div className="space-y-2">
      {renamed && <p className="text-xs text-amber-800">Looked up as &apos;{look.asName}&apos;, before the name was changed.</p>}
      {look.hidden ? (
        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
          <span>{look.answer.found ? "None of the choices were used." : "Left blank."}</span>
          {look.answer.found && (
            <Button variant="ghost" onClick={onReopen}>
              Show Choices Again
            </Button>
          )}
        </div>
      ) : (
        <LookupChoices
          name={look.asName}
          answer={look.answer}
          isPerson={r.is_person}
          pickedId={r.pick?.choice.id ?? null}
          autoPicked={look.auto}
          onPick={onPick}
          onNone={onNone}
        />
      )}
      {r.pick && (
        <div className="rounded-lg border border-slate-200 px-3 py-2">
          <p className="text-xs font-medium text-slate-700">What It Fills In (Saved Only When You Press Add)</p>
          <FoundChanges
            changes={changesFor({ phone: r.phone, email: r.email, website: r.website, address: r.address }, r.pick.choice)}
            take={r.pick.take}
            onToggle={(field, on) => onTake(on ? [...new Set([...(r.pick?.take ?? []), field])] : (r.pick?.take ?? []).filter((f) => f !== field))}
          />
        </div>
      )}
    </div>
  );
}
