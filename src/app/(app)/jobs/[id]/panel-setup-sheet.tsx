"use client";

import { useEffect, useRef, useState } from "react";
import { RotateCcw } from "lucide-react";
import { Modal, ModalActions } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { useToast } from "@/components/toast";
import { cn, formatDate } from "@/lib/utils";
import type { JobCircuit, JobPanel } from "@/lib/types";
import { savePanel } from "../panel-actions";

/**
 * ADD THE PANEL, AND EVERYTHING ABOUT THE BOX (Panel plan, phase 2): its name, brand, main and bus
 * amps, how many spaces, which way the numbers run (a person reads it off the label; the app never
 * guesses), the tandem spaces, the No Stab spaces, and the photo of it from the job's Photos.
 *
 * Adding is the one tap that makes a row (Add The Panel). After that every field saves as it
 * changes, with the last change undoable here. Every way out (X, backdrop, back, Done) first writes
 * whatever is still typed, and a refused write keeps the sheet open with the reason. Each write
 * names what the editor saw, so a crewmate's newer value is shown, not overwritten. Taking a panel
 * off a job has no door yet (the database keeps it the office's for when it does).
 */

type Draft = {
  name: string;
  brand: string;
  main_amps: string;
  bus_amps: string;
  spaces: string;
  numbering: "top_down" | "bottom_up";
  twin_spaces: string;
  dead_spaces: string;
  photo_document_id: string;
  notes: string;
};

/** A new panel's name: Main Panel, or the first free one when the job already has it (the job's
 *  panel names are unique, so a second "Main Panel" would only be refused). */
export function freePanelName(taken: string[]): string {
  const have = new Set(taken.map((n) => n.trim().toLowerCase()));
  for (const n of ["Main Panel", "Sub Panel"]) if (!have.has(n.toLowerCase())) return n;
  for (let i = 2; ; i++) if (!have.has(`panel ${i}`)) return `Panel ${i}`;
}

const draftOf = (p: JobPanel | null, taken: string[] = []): Draft => ({
  name: p?.name ?? freePanelName(taken),
  brand: p?.brand ?? "",
  main_amps: p?.main_amps == null ? "" : String(p.main_amps),
  bus_amps: p?.bus_amps == null ? "" : String(p.bus_amps),
  spaces: p?.spaces == null ? "" : String(p.spaces),
  numbering: p?.numbering ?? "top_down",
  twin_spaces: (p?.twin_spaces ?? []).join(", "),
  dead_spaces: (p?.dead_spaces ?? []).join(", "),
  photo_document_id: p?.photo_document_id ?? "",
  notes: p?.notes ?? "",
});

/** The draft as a write: empty strings are "not said". */
function patchOf(d: Draft, keys: (keyof Draft)[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    const v = d[k];
    if (k === "numbering") out[k] = v;
    else if (k === "twin_spaces" || k === "dead_spaces") out[k] = v;
    else out[k] = typeof v === "string" && v.trim() === "" ? null : typeof v === "string" ? v.trim() : v;
  }
  return out;
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-slate-500">{hint}</span>}
    </label>
  );
}

const selectCls =
  "h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand";

export function PanelSetupSheet({
  jobId,
  panel,
  photos,
  takenNames = [],
  onSaved,
  onClose,
}: {
  jobId: string;
  panel: JobPanel | null;
  photos: { id: string; name: string | null; created_at: string }[];
  /** The job's other panels' names, so a new one starts with a free name. */
  takenNames?: string[];
  /** placed: on Add The Panel, the circuits already on the list that the job's first panel took. */
  onSaved: (row: JobPanel, placed?: { adopted: JobCircuit[]; notAdopted: string[] }) => void;
  onClose: () => void;
}) {
  const toast = useToast();
  const [row, setRowState] = useState<JobPanel | null>(panel);
  const [d, setDState] = useState<Draft>(() => draftOf(panel, takenNames));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [undo, setUndo] = useState<{ label: string; draft: Draft; keys: (keyof Draft)[]; seen: Record<string, unknown> } | null>(null);
  const alive = useRef(true);
  useEffect(() => () => void (alive.current = false), []);
  // The latest row and draft, for writes queued behind another one and for the way out.
  const rowRef = useRef<JobPanel | null>(panel);
  const dRef = useRef<Draft>(d);
  const setRow = (r: JobPanel) => {
    rowRef.current = r;
    setRowState(r);
  };
  const setD = (f: Draft | ((cur: Draft) => Draft)) => {
    dRef.current = typeof f === "function" ? f(dRef.current) : f;
    setDState(dRef.current);
  };
  const queue = useRef<Promise<boolean>>(Promise.resolve(true));

  /** What the editor saw for these fields, as the database holds them. */
  const seenOf = (r: JobPanel, keys: (keyof Draft)[]) =>
    Object.fromEntries(keys.map((k) => [k, (r as unknown as Record<string, unknown>)[k] ?? null])) as Record<string, unknown>;

  function enqueue(job: () => Promise<boolean>): Promise<boolean> {
    const p = queue.current.then(job);
    queue.current = p.catch(() => false);
    return p;
  }

  async function add() {
    setSaving(true);
    setError(null);
    let res: Awaited<ReturnType<typeof savePanel>>;
    try {
      res = await savePanel(jobId, null, patchOf(dRef.current, Object.keys(dRef.current) as (keyof Draft)[]));
    } catch {
      res = { ok: false, error: "The panel didn't save. Check your connection and try again." };
    }
    if (!res.ok) {
      if (alive.current) {
        setSaving(false);
        setError(res.error);
      } else toast(res.error, "error");
      return;
    }
    onSaved(res.row, { adopted: res.adopted, notAdopted: res.notAdopted });
    if (!alive.current) return;
    setSaving(false);
    setRow(res.row);
    setD(draftOf(res.row));
    setSaved(res.adopted.length ? `Added ${res.row.name}. The ${res.adopted.length} circuit${res.adopted.length === 1 ? "" : "s"} on the list ${res.adopted.length === 1 ? "is" : "are"} on it.` : `Added ${res.row.name}.`);
  }

  /** Save the fields that differ from the row, one write at a time. True when saved (or nothing to save). */
  function saveKeys(keys: (keyof Draft)[], label: string, next?: Draft, prev?: Draft): Promise<boolean> {
    return enqueue(async () => {
      const r = rowRef.current;
      if (!r) return true; // not added yet: the Add The Panel tap writes everything at once
      const want = next ?? dRef.current;
      const before = prev ?? draftOf(r);
      if (keys.every((k) => want[k] === before[k])) return true;
      if (alive.current) {
        setSaving(true);
        setError(null);
      }
      const seen = seenOf(r, keys);
      let res: Awaited<ReturnType<typeof savePanel>>;
      try {
        res = await savePanel(jobId, r.id, patchOf(want, keys), seen);
      } catch {
        res = { ok: false, error: "The panel didn't save. Check your connection and try again." };
      }
      if (!res.ok) {
        const current = "current" in res ? res.current : undefined;
        if (current) onSaved(current);
        if (!alive.current) {
          toast(`${r.name}: ${res.error}`, "error");
          return false;
        }
        setSaving(false);
        setError(res.error);
        if (current) setRow(current);
        setD((cur) => ({ ...cur, ...pick(draftOf(current ?? r), keys) }));
        return false;
      }
      onSaved(res.row);
      if (!alive.current) return true;
      setSaving(false);
      setRow(res.row);
      setD((cur) => ({ ...cur, ...pick(draftOf(res.row), keys) }));
      setSaved(`Saved ${label}.`);
      setUndo({ label, draft: before, keys, seen: seenOf(res.row, keys) });
      return true;
    });
  }

  function undoLast() {
    const u = undo;
    if (!u || !rowRef.current) return;
    setUndo(null);
    void enqueue(async () => {
      const r = rowRef.current!;
      setSaving(true);
      let res: Awaited<ReturnType<typeof savePanel>>;
      try {
        res = await savePanel(jobId, r.id, patchOf(u.draft, u.keys), u.seen);
      } catch {
        res = { ok: false, error: "The panel didn't save. Check your connection and try again." };
      }
      if (!res.ok) {
        const current = "current" in res ? res.current : undefined;
        if (current) onSaved(current);
        if (!alive.current) return false;
        setSaving(false);
        setError(res.error);
        if (current) {
          setRow(current);
          setD(draftOf(current));
        }
        return false;
      }
      onSaved(res.row);
      if (!alive.current) return true;
      setSaving(false);
      setRow(res.row);
      setD(draftOf(res.row));
      setSaved(`Put ${u.label} back.`);
      return true;
    });
  }

  const TYPED: [keyof Draft, string][] = [
    ["name", "the name"],
    ["brand", "the brand"],
    ["main_amps", "the main"],
    ["bus_amps", "the bus"],
    ["spaces", "the spaces"],
    ["twin_spaces", "the tandem spaces"],
    ["dead_spaces", "the No Stab spaces"],
    ["notes", "the notes"],
  ];
  /** Every way out of an added panel: write what is still typed, then go. Refused: stay and say why. */
  async function leave() {
    if (rowRef.current) {
      for (const [k, label] of TYPED) if (!(await saveKeys([k], label))) return;
    }
    onClose();
  }

  const text = (k: keyof Draft, label: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <Input
      className="h-11"
      value={d[k]}
      onChange={(e) => setD((cur) => ({ ...cur, [k]: e.target.value }))}
      onBlur={() => void saveKeys([k], label)}
      {...props}
    />
  );

  return (
    <Modal
      open
      onClose={() => void leave()}
      title={row ? row.name : "Add The Panel"}
      size="md"
      dirty={!row && (d.brand !== "" || d.spaces !== "" || d.main_amps !== "")}
      footer={
        row ? (
          <ModalActions onCancel={() => void leave()} hideCancel onSave={() => void leave()} saveLabel="Done" saving={saving} />
        ) : (
          <ModalActions onCancel={onClose} onSave={add} saveLabel="Add The Panel" saving={saving} />
        )
      }
    >
      <div className="space-y-4">
        {(saved || error) && (
          <div role="status" className={cn("flex items-center justify-between gap-2 rounded-lg px-3 py-1 text-sm", error ? "bg-red-50 text-red-800" : "bg-emerald-50 text-emerald-800")}>
            <span className="py-2">{error ?? saved}</span>
            {!error && undo && (
              <Button type="button" variant="ghost" onClick={undoLast} className="shrink-0">
                <RotateCcw className="h-4 w-4" /> Undo
              </Button>
            )}
          </div>
        )}
        <Field label="Name">{text("name", "the name", { placeholder: "Main Panel" })}</Field>
        <Field label="Brand">{text("brand", "the brand", { placeholder: "Siemens" })}</Field>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Main">{text("main_amps", "the main", { inputMode: "numeric", placeholder: "125" })}</Field>
          <Field label="Bus">{text("bus_amps", "the bus", { inputMode: "numeric", placeholder: "125" })}</Field>
          <Field label="Spaces">{text("spaces", "the spaces", { inputMode: "numeric", placeholder: "32" })}</Field>
        </div>
        <label className="flex min-h-[44px] items-center gap-3 rounded-lg border border-slate-300 px-3 text-sm text-slate-800">
          <input
            type="checkbox"
            className="h-5 w-5"
            checked={d.numbering === "bottom_up"}
            onChange={(e) => {
              const next: Draft = { ...dRef.current, numbering: e.target.checked ? "bottom_up" : "top_down" };
              const prev = rowRef.current ? draftOf(rowRef.current) : dRef.current;
              setD(next);
              void saveKeys(["numbering"], "the numbering", next, prev);
            }}
          />
          Numbering Runs Bottom Up
          <span className="text-xs text-slate-500">(space 1 is at the bottom)</span>
        </label>
        <Field label="Tandem Spaces" hint="The spaces the panel label allows twins and quads in, like 25, 27.">
          {text("twin_spaces", "the tandem spaces", { inputMode: "numeric", placeholder: "25, 27" })}
        </Field>
        <Field label="No Stab Spaces" hint="A crimped spot with no stab. Nothing can be kept there, so a space with a circuit on it is refused until the circuit moves.">
          {text("dead_spaces", "the No Stab spaces", { inputMode: "numeric", placeholder: "31" })}
        </Field>
        <Field label="Panel Photo" hint={photos.length ? undefined : "Take one on the Photos tab and it shows up here."}>
          <select
            className={selectCls}
            value={d.photo_document_id}
            disabled={saving || !photos.length}
            onChange={(e) => {
              const next: Draft = { ...dRef.current, photo_document_id: e.target.value };
              const prev = rowRef.current ? draftOf(rowRef.current) : dRef.current;
              setD(next);
              void saveKeys(["photo_document_id"], "the photo", next, prev);
            }}
          >
            <option value="">No Photo Yet</option>
            {photos.map((p) => (
              <option key={p.id} value={p.id}>
                {(p.name ?? "Photo").slice(0, 40)} · {formatDate(p.created_at)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Notes" hint="For the office and the crew. Never on the customer's page.">
          <Textarea
            value={d.notes}
            onChange={(e) => setD((cur) => ({ ...cur, notes: e.target.value }))}
            onBlur={() => void saveKeys(["notes"], "the notes")}
          />
        </Field>
      </div>
    </Modal>
  );
}

function pick(d: Draft, keys: (keyof Draft)[]): Partial<Draft> {
  const out: Partial<Draft> = {};
  for (const k of keys) (out as Record<string, unknown>)[k] = d[k];
  return out;
}
