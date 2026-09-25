"use client";

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, RotateCcw, ShieldCheck } from "lucide-react";
import { Modal, ModalActions } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { formatDate } from "@/lib/utils";
import { AMP_SIZES } from "@/lib/panel/input";
import { KIND_WORDS, PROGRESS_WORDS, WORK_WORDS, circuitName, labelDiffersWords } from "@/lib/panel/model";
import type { CircuitKind, CircuitProgress, CircuitWork, JobCircuit, JobPanel } from "@/lib/types";
import { markVerified, saveCircuit } from "../panel-actions";

/**
 * ONE CIRCUIT, EVERY FIELD, NO SAVE BUTTON (Panel plan, phase 2). Each field saves when it changes
 * (a text field when you leave it), the row that comes back is what the sheet shows, and the last
 * change can be undone from the sheet itself (the not-annoying law: no save game, an undo trail).
 * The crew and the office get the same sheet: nothing on a circuit carries a price.
 *
 * A suggestion's sheet is how "Change" works: fix what the estimate got wrong, then Keep (or Not
 * This). Nothing counts until kept.
 */

type Patch = Record<string, unknown>;
type Undo = { label: string; patch: Patch } | null;

/** A 44px choice pill: the sheet's segmented control, sized for a thumb. */
function Choice<T extends string>({
  options,
  value,
  onPick,
  label,
  disabled,
  stretch = false,
}: {
  options: { id: T; label: string }[];
  value: T | null;
  onPick: (v: T) => void;
  label: string;
  disabled?: boolean;
  /** One row, each option an equal share (a short set like Whole / A / B). */
  stretch?: boolean;
}) {
  return (
    <div role="radiogroup" aria-label={label} className={cn("flex gap-1.5", stretch ? "flex-nowrap" : "flex-wrap")}>
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={value === o.id}
          disabled={disabled}
          onClick={() => value !== o.id && onPick(o.id)}
          className={cn(
            "min-h-[44px] rounded-lg border px-3 text-sm font-medium transition-colors disabled:opacity-50",
            stretch && "min-w-0 flex-1 px-1",
            value === o.id
              ? "border-[rgb(var(--glass-ink))] bg-[rgb(var(--glass-tint))]/20 text-[rgb(var(--glass-ink))]"
              : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
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

export function CircuitEditSheet({
  circuit,
  panels,
  people,
  onSaved,
  onClose,
  onKeep,
  onNotThis,
  onTakeOff,
}: {
  circuit: JobCircuit;
  panels: JobPanel[];
  people: Record<string, string>;
  onSaved: (row: JobCircuit) => void;
  onClose: () => void;
  onKeep: (c: JobCircuit) => void;
  onNotThis: (c: JobCircuit) => void;
  onTakeOff: (c: JobCircuit) => void;
}) {
  const [row, setRow] = useState(circuit);
  const [text, setText] = useState({
    panel_label: circuit.panel_label ?? "",
    description: circuit.description ?? "",
    room: circuit.room ?? "",
    wire: circuit.wire ?? "",
    wire_tag: circuit.wire_tag ?? "",
    space: circuit.space == null ? "" : String(circuit.space),
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [undo, setUndo] = useState<Undo>(null);
  const alive = useRef(true);
  useEffect(() => () => void (alive.current = false), []);

  // The row the list holds may move under us (the chip, Keep): follow it.
  useEffect(() => setRow(circuit), [circuit]);

  async function apply(patch: Patch, label: string, prev: Patch) {
    setSaving(true);
    setError(null);
    const res = await saveCircuit(row.id, patch);
    if (!alive.current) return;
    setSaving(false);
    if (!res.ok) {
      setError(res.error);
      // The field shows what the database holds, not what was refused.
      setText((t) => ({ ...t, ...textOf(row, Object.keys(patch)) }));
      return;
    }
    setRow(res.row);
    onSaved(res.row);
    setSaved(`Saved ${label}.`);
    setUndo({ label, patch: prev });
  }

  async function undoLast() {
    if (!undo) return;
    const u = undo;
    setUndo(null);
    setSaving(true);
    const res = await saveCircuit(row.id, u.patch);
    if (!alive.current) return;
    setSaving(false);
    if (!res.ok) return setError(res.error);
    setRow(res.row);
    setText((t) => ({ ...t, ...textOf(res.row, Object.keys(u.patch)) }));
    onSaved(res.row);
    setSaved(`Put ${u.label} back.`);
  }

  function blurText(k: keyof typeof text, label: string) {
    const v = text[k].trim();
    const cur = k === "space" ? (row.space == null ? "" : String(row.space)) : String((row as unknown as Record<string, unknown>)[k] ?? "");
    if (v === cur) return;
    const prev = { [k]: (row as unknown as Record<string, unknown>)[k] ?? null };
    void apply({ [k]: v === "" ? null : k === "space" ? Number(v) : v }, label, prev);
  }

  async function toggleVerified() {
    setSaving(true);
    setError(null);
    const res = await markVerified(row.id, !row.verified);
    if (!alive.current) return;
    setSaving(false);
    if (!res.ok) return setError(res.error);
    setRow(res.row);
    onSaved(res.row);
    setSaved(res.row.verified ? "Marked Verified On Site." : "Took the verified mark off.");
    setUndo(null);
  }

  const suggested = row.state === "suggested";
  const flag = labelDiffersWords({ panel_label: text.panel_label || null, description: text.description || null });
  const from = row.source_row?.quote_number ? `From ${row.source_row.quote_number}` : null;

  return (
    <Modal
      open
      onClose={onClose}
      title={circuitName(row)}
      size="md"
      footer={
        <ModalActions
          onCancel={onClose}
          cancelLabel="Close"
          hideCancel={!suggested}
          onSave={() => (suggested ? onKeep(row) : onClose())}
          saveLabel={suggested ? "Keep" : "Done"}
          saving={saving}
          extra={
            suggested ? (
              <Button type="button" variant="ghost" onClick={() => onNotThis(row)} disabled={saving}>
                Not This
              </Button>
            ) : (
              <Button type="button" variant="outline" className="text-red-700" onClick={() => onTakeOff(row)} disabled={saving}>
                Take Off
              </Button>
            )
          }
        />
      }
    >
      <div className="space-y-4">
        {suggested && (
          <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-600">
            A suggestion{from ? ` ${from.replace("From", "from")}` : ""}. Fix what it got wrong, then Keep. Nothing counts until you keep it.
            {row.source_row?.load && <span className="mt-1 block text-xs text-slate-500">The estimate said: {row.source_row.load}</span>}
            {row.source_row?.check && (
              <span className="mt-1 flex items-start gap-1 text-xs font-medium text-amber-800">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {row.source_row.check}
              </span>
            )}
          </div>
        )}

        {(saved || error) && (
          <div
            role="status"
            className={cn(
              "flex items-center justify-between gap-2 rounded-lg px-3 py-1 text-sm",
              error ? "bg-red-50 text-red-800" : "bg-emerald-50 text-emerald-800",
            )}
          >
            <span className="py-2">{error ?? saved}</span>
            {!error && undo && (
              <button
                type="button"
                onClick={undoLast}
                className="inline-flex min-h-[44px] shrink-0 items-center gap-1 rounded-md px-3 text-sm font-semibold hover:bg-emerald-100"
              >
                <RotateCcw className="h-4 w-4" /> Undo
              </button>
            )}
          </div>
        )}

        <Field label="What It Feeds">
          <Input
            className="h-11"
            value={text.description}
            placeholder="Kitchen And Living"
            onChange={(e) => setText((t) => ({ ...t, description: e.target.value }))}
            onBlur={() => blurText("description", "What It Feeds")}
          />
        </Field>
        <Field label="Door Label" hint="What the panel door says for it.">
          <Input
            className="h-11"
            value={text.panel_label}
            placeholder="Entry Lights"
            onChange={(e) => setText((t) => ({ ...t, panel_label: e.target.value }))}
            onBlur={() => blurText("panel_label", "Door Label")}
          />
        </Field>
        {flag && (
          <p className="flex items-start gap-1.5 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {flag}
          </p>
        )}
        <Field label="Room">
          <Input
            className="h-11"
            value={text.room}
            placeholder="Kitchen"
            onChange={(e) => setText((t) => ({ ...t, room: e.target.value }))}
            onBlur={() => blurText("room", "Room")}
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Amps">
            <select
              className={selectCls}
              value={row.amps ?? ""}
              onChange={(e) => void apply({ amps: e.target.value === "" ? null : Number(e.target.value) }, "Amps", { amps: row.amps })}
              disabled={saving}
            >
              <option value="">Not Said</option>
              {AMP_SIZES.map((a) => (
                <option key={a} value={a}>
                  {a}A
                </option>
              ))}
            </select>
          </Field>
          <Field label="Poles">
            <select
              className={selectCls}
              value={row.poles}
              onChange={(e) => void apply({ poles: Number(e.target.value) }, "Poles", { poles: row.poles })}
              disabled={saving}
            >
              <option value={1}>1P</option>
              <option value={2}>2P</option>
              <option value={3}>3P</option>
            </select>
          </Field>
        </div>

        <Field label="Type">
          <select
            className={selectCls}
            value={row.kind ?? ""}
            onChange={(e) => void apply({ kind: e.target.value || null }, "Type", { kind: row.kind })}
            disabled={saving}
          >
            <option value="">Not Said</option>
            {(Object.keys(KIND_WORDS) as CircuitKind[]).map((k) => (
              <option key={k} value={k}>
                {KIND_WORDS[k]}
              </option>
            ))}
          </select>
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Wire">
            <Input
              className="h-11"
              value={text.wire}
              placeholder="12/2"
              onChange={(e) => setText((t) => ({ ...t, wire: e.target.value }))}
              onBlur={() => blurText("wire", "Wire")}
            />
          </Field>
          <Field label="Wire Tag">
            <Input
              className="h-11"
              value={text.wire_tag}
              placeholder="DWDS"
              onChange={(e) => setText((t) => ({ ...t, wire_tag: e.target.value }))}
              onBlur={() => blurText("wire_tag", "Wire Tag")}
            />
          </Field>
        </div>

        {panels.length > 1 && (
          <Field label="Panel">
            <select
              className={selectCls}
              value={row.panel_id ?? ""}
              onChange={(e) => void apply({ panel_id: e.target.value || null }, "Panel", { panel_id: row.panel_id })}
              disabled={saving}
            >
              <option value="">No Panel Yet</option>
              {panels.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
        )}

        <div className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-3">
          <Field label="Space" hint={row.poles > 1 && row.space ? `A ${row.poles}P here covers ${Array.from({ length: row.poles }, (_, i) => row.space! + 2 * i).join(" and ")}.` : undefined}>
            <Input
              className="h-11"
              inputMode="numeric"
              value={text.space}
              placeholder="7"
              onChange={(e) => setText((t) => ({ ...t, space: e.target.value.replace(/[^0-9]/g, "") }))}
              onBlur={() => blurText("space", "Space")}
            />
          </Field>
          <div>
            <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">Half</span>
            <Choice
              stretch
              label="Half"
              options={[
                { id: "full", label: "Whole" },
                { id: "A", label: "A" },
                { id: "B", label: "B" },
              ]}
              value={row.half ?? "full"}
              disabled={saving || row.space == null}
              onPick={(v) => void apply({ half: v === "full" ? null : v }, "Half", { half: row.half })}
            />
          </div>
        </div>

        <div>
          <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">Work</span>
          <Choice
            label="Work"
            options={(Object.keys(WORK_WORDS) as CircuitWork[]).map((w) => ({ id: w, label: WORK_WORDS[w] }))}
            value={row.work}
            disabled={saving}
            onPick={(v) => void apply({ work: v }, "Work", { work: row.work })}
          />
        </div>

        {!suggested && (
          <div>
            <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">Progress</span>
            <Choice
              label="Progress"
              options={(Object.keys(PROGRESS_WORDS) as CircuitProgress[]).map((p) => ({ id: p, label: PROGRESS_WORDS[p] }))}
              value={row.progress}
              disabled={saving}
              onPick={(v) => void apply({ progress: v }, "Progress", { progress: row.progress })}
            />
          </div>
        )}

        {!suggested && (
          <button
            type="button"
            onClick={toggleVerified}
            disabled={saving}
            aria-pressed={row.verified}
            className={cn(
              "flex min-h-[44px] w-full items-center gap-2 rounded-lg border px-3 text-left text-sm font-medium disabled:opacity-50",
              row.verified ? "border-emerald-300 bg-emerald-50 text-emerald-800" : "border-slate-300 bg-white text-slate-700",
            )}
          >
            <ShieldCheck className="h-4 w-4 shrink-0" />
            {row.verified
              ? `Verified On Site${row.verified_by && people[row.verified_by] ? ` By ${people[row.verified_by]}` : ""}${row.verified_at ? `, ${formatDate(row.verified_at)}` : ""}`
              : "Verified On Site"}
          </button>
        )}
      </div>
    </Modal>
  );
}

/** The text fields' strings as the row holds them, for putting a refused or undone edit back. */
function textOf(row: JobCircuit, keys: string[]): Partial<Record<string, string>> {
  const out: Partial<Record<string, string>> = {};
  for (const k of keys) {
    if (!["panel_label", "description", "room", "wire", "wire_tag", "space"].includes(k)) continue;
    const v = (row as unknown as Record<string, unknown>)[k];
    out[k] = v == null ? "" : String(v);
  }
  return out;
}
