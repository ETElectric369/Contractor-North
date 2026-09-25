"use client";

import { useEffect, useRef, useState } from "react";
import { RotateCcw } from "lucide-react";
import { Modal, ModalActions } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { cn, formatDate } from "@/lib/utils";
import type { JobPanel } from "@/lib/types";
import { savePanel } from "../panel-actions";

/**
 * ADD THE PANEL, AND EVERYTHING ABOUT THE BOX (Panel plan, phase 2): its name, brand, main and bus
 * amps, how many spaces, which way the numbers run (a person reads it off the label; the app never
 * guesses), the tandem spaces, the No Stab spaces, and the photo of it from the job's Photos.
 *
 * Adding is the one tap that makes a row (Add The Panel). After that every field saves as it
 * changes, with the last change undoable here. Taking a panel off a job is the office's, and lives
 * on the tab with its own Undo.
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

const draftOf = (p: JobPanel | null): Draft => ({
  name: p?.name ?? "Main Panel",
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
  onSaved,
  onClose,
}: {
  jobId: string;
  panel: JobPanel | null;
  photos: { id: string; name: string | null; created_at: string }[];
  onSaved: (row: JobPanel) => void;
  onClose: () => void;
}) {
  const [row, setRow] = useState<JobPanel | null>(panel);
  const [d, setD] = useState<Draft>(draftOf(panel));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [undo, setUndo] = useState<{ label: string; draft: Draft; keys: (keyof Draft)[] } | null>(null);
  const alive = useRef(true);
  useEffect(() => () => void (alive.current = false), []);

  async function add() {
    setSaving(true);
    setError(null);
    const res = await savePanel(jobId, null, patchOf(d, Object.keys(d) as (keyof Draft)[]));
    if (!alive.current) return;
    setSaving(false);
    if (!res.ok) return setError(res.error);
    setRow(res.row);
    setD(draftOf(res.row));
    onSaved(res.row);
    setSaved(`Added ${res.row.name}.`);
  }

  async function saveKeys(keys: (keyof Draft)[], label: string, next: Draft = d, prev?: Draft) {
    if (!row) return; // not added yet: the Add The Panel tap writes everything at once
    const before = prev ?? draftOf(row);
    if (keys.every((k) => next[k] === before[k])) return;
    setSaving(true);
    setError(null);
    const res = await savePanel(jobId, row.id, patchOf(next, keys));
    if (!alive.current) return;
    setSaving(false);
    if (!res.ok) {
      setError(res.error);
      setD((cur) => ({ ...cur, ...pick(draftOf(row), keys) }));
      return;
    }
    setRow(res.row);
    setD((cur) => ({ ...cur, ...pick(draftOf(res.row), keys) }));
    onSaved(res.row);
    setSaved(`Saved ${label}.`);
    setUndo({ label, draft: before, keys });
  }

  async function undoLast() {
    if (!undo || !row) return;
    const u = undo;
    setUndo(null);
    setSaving(true);
    const res = await savePanel(jobId, row.id, patchOf(u.draft, u.keys));
    if (!alive.current) return;
    setSaving(false);
    if (!res.ok) return setError(res.error);
    setRow(res.row);
    setD(draftOf(res.row));
    onSaved(res.row);
    setSaved(`Put ${u.label} back.`);
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
      onClose={onClose}
      title={row ? row.name : "Add The Panel"}
      size="md"
      dirty={!row && (d.brand !== "" || d.spaces !== "" || d.main_amps !== "")}
      footer={
        row ? (
          <ModalActions onCancel={onClose} hideCancel onSave={onClose} saveLabel="Done" saving={saving} />
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
              const next: Draft = { ...d, numbering: e.target.checked ? "bottom_up" : "top_down" };
              const prev = d;
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
        <Field label="No Stab Spaces" hint="A crimped spot with no stab. Nothing can be kept there.">
          {text("dead_spaces", "the No Stab spaces", { inputMode: "numeric", placeholder: "31" })}
        </Field>
        <Field label="Panel Photo" hint={photos.length ? undefined : "Take one on the Photos tab and it shows up here."}>
          <select
            className={selectCls}
            value={d.photo_document_id}
            disabled={saving || !photos.length}
            onChange={(e) => {
              const next: Draft = { ...d, photo_document_id: e.target.value };
              const prev = d;
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
