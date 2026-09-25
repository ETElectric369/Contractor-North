"use client";

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, RotateCcw, ShieldCheck } from "lucide-react";
import { Modal, ModalActions } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/toast";
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
 *
 * NOTHING TYPED IS LOST ON THE WAY OUT. A text field saves when it is left, but a tap on the X, the
 * backdrop, back, Keep, Done or Take Off may not leave it first (an iOS button tap doesn't take
 * focus). So every way out first writes what is still typed, and only closes once it is saved; a
 * refused write keeps the sheet open with the reason on it. Writes run one at a time, in order, and
 * each names what the editor saw, so a crewmate's newer value is shown, never overwritten. A write
 * that answers after the sheet has gone still reaches the list (and a failure still reaches a toast).
 */

type Patch = Record<string, unknown>;
/** One write: what changes, what the editor saw for those fields (the undo), and its name. */
type Change = { patch: Patch; prev: Patch; label: string };
type Undo = { label: string; patch: Patch; seen: Patch } | null;
const TEXT_KEYS = ["description", "panel_label", "room", "wire", "wire_tag", "space"] as const;
type TextKey = (typeof TEXT_KEYS)[number];

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
  const toast = useToast();
  const [row, setRowState] = useState(circuit);
  const [text, setTextState] = useState(() => textOf(circuit, TEXT_KEYS as unknown as string[]) as Record<TextKey, string>);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [undo, setUndo] = useState<Undo>(null);
  const alive = useRef(true);
  useEffect(() => () => void (alive.current = false), []);
  // The latest row and text, for writes queued behind another one and for the way out.
  const rowRef = useRef(circuit);
  const textRef = useRef(text);
  const setRow = (r: JobCircuit) => {
    rowRef.current = r;
    setRowState(r);
  };
  const setText = (f: (t: Record<TextKey, string>) => Record<TextKey, string>) => {
    textRef.current = f(textRef.current);
    setTextState(textRef.current);
  };
  const queue = useRef<Promise<boolean>>(Promise.resolve(true));
  const pending = useRef(0);
  const lastFailed = useRef(false);

  // The row the list holds may move under us (the chip, Keep): follow it.
  useEffect(() => {
    rowRef.current = circuit;
    setRowState(circuit);
  }, [circuit]);

  /** Write one change against the row as it is now. True when it saved. */
  async function write(c: Change, asUndo = false): Promise<boolean> {
    if (alive.current) {
      setSaving(true);
      setError(null);
    }
    let res: Awaited<ReturnType<typeof saveCircuit>>;
    try {
      res = await saveCircuit(rowRef.current.id, c.patch, c.prev);
    } catch {
      res = { ok: false, error: "That didn't save. Check your connection and try again." };
    }
    lastFailed.current = !res.ok;
    if (!res.ok) {
      const current = "current" in res ? res.current : undefined;
      if (current) onSaved(current); // the list shows what is there now
      if (!alive.current) {
        toast(`${circuitName(rowRef.current)}: ${res.error}`, "error");
        return false;
      }
      setSaving(false);
      setError(res.error);
      if (current) setRow(current);
      // The field shows what the database holds, not what was refused.
      const src = current ?? rowRef.current;
      setText((t) => ({ ...t, ...(textOf(src, Object.keys(c.patch)) as Partial<Record<TextKey, string>>) }));
      return false;
    }
    // The parent's list is still there when the sheet has gone: the saved row always reaches it.
    onSaved(res.row);
    if (!alive.current) return true;
    setSaving(false);
    setRow(res.row);
    // The field shows what was stored (the database tidies spaces), so leaving it again sends nothing.
    setText((t) => ({ ...t, ...(textOf(res.row, Object.keys(c.patch)) as Partial<Record<TextKey, string>>) }));
    if (asUndo) {
      setSaved(`Put ${c.label} back.`);
      setUndo(null);
    } else {
      setSaved(`Saved ${c.label}.`);
      const after: Patch = {};
      for (const k of Object.keys(c.prev)) after[k] = (res.row as unknown as Record<string, unknown>)[k] ?? null;
      setUndo({ label: c.label, patch: c.prev, seen: after });
    }
    return true;
  }

  /** Run writes one at a time, each built when its turn comes (so it compares against the latest row). */
  function enqueue(build: () => Change | null, asUndo = false): Promise<boolean> {
    pending.current++;
    const p = queue.current
      .then(() => {
        const c = build();
        return c ? write(c, asUndo) : true;
      })
      .finally(() => void pending.current--);
    queue.current = p.catch(() => false);
    return p;
  }

  /** A pick (amps, poles, type, panel, half, work, progress): the value, what it was, its name. */
  function apply(patch: Patch, label: string) {
    void enqueue(() => {
      const r = rowRef.current as unknown as Record<string, unknown>;
      const prev: Patch = {};
      for (const k of Object.keys(patch)) prev[k] = r[k] ?? null;
      return { patch, prev, label };
    });
  }

  function undoLast() {
    if (!undo) return;
    const u = undo;
    setUndo(null);
    void enqueue(() => ({ patch: u.patch, prev: u.seen, label: u.label }), true);
  }

  /** What a text field holds that the row doesn't, as a write (null when they agree). */
  function textChange(k: TextKey, label: string): Change | null {
    const v = textRef.current[k].trim();
    const r = rowRef.current;
    const cur = k === "space" ? (r.space == null ? "" : String(r.space)) : String((r as unknown as Record<string, unknown>)[k] ?? "");
    if (v === cur) return null;
    // Clearing the space clears the half with it, so the undo puts both back (7B stays 7B).
    const prev: Patch = k === "space" ? { space: r.space, half: r.half } : { [k]: (r as unknown as Record<string, unknown>)[k] ?? null };
    return { patch: { [k]: v === "" ? null : k === "space" ? Number(v) : v }, prev, label };
  }

  function blurText(k: TextKey, label: string) {
    void enqueue(() => textChange(k, label));
  }

  const TEXT_LABELS: Record<TextKey, string> = {
    description: "What It Feeds",
    panel_label: "Door Label",
    room: "Room",
    wire: "Wire",
    wire_tag: "Wire Tag",
    space: "Space",
  };

  /** Every way out: write whatever is still typed, then go. A refused write keeps the sheet open. */
  async function thenLeave(go: (latest: JobCircuit) => void) {
    // A write still on its way when the tap came: if it is refused, stay and show why.
    const hadPending = pending.current > 0;
    for (const k of TEXT_KEYS) {
      const ok = await enqueue(() => textChange(k, TEXT_LABELS[k]));
      if (!ok) return;
    }
    if (hadPending && lastFailed.current) return;
    go(rowRef.current);
  }
  const leave = () => void thenLeave(() => onClose());

  function toggleVerified() {
    void (queue.current = queue.current.then(async () => {
      if (!alive.current) return true;
      setSaving(true);
      setError(null);
      try {
        const res = await markVerified(rowRef.current.id, !rowRef.current.verified);
        if (!res.ok) {
          if (alive.current) {
            setSaving(false);
            setError(res.error);
          }
          return false;
        }
        onSaved(res.row);
        if (!alive.current) return true;
        setSaving(false);
        setRow(res.row);
        setSaved(res.row.verified ? "Marked Verified On Site." : "Took the verified mark off.");
        setUndo(null);
        return true;
      } catch {
        if (alive.current) {
          setSaving(false);
          setError("That didn't save. Check your connection and try again.");
        }
        return false;
      }
    }));
  }

  const suggested = row.state === "suggested";
  const flag = labelDiffersWords({ panel_label: text.panel_label || null, description: text.description || null });
  const from = row.source_row?.quote_number ? `From ${row.source_row.quote_number}` : null;

  return (
    <Modal
      open
      onClose={leave}
      title={circuitName(row)}
      size="md"
      footer={
        <ModalActions
          onCancel={leave}
          cancelLabel="Close"
          hideCancel={!suggested}
          onSave={() => void thenLeave((latest) => (suggested ? onKeep(latest) : onClose()))}
          saveLabel={suggested ? "Keep" : "Done"}
          saving={saving}
          extra={
            suggested ? (
              <Button type="button" variant="ghost" onClick={() => void thenLeave((latest) => onNotThis(latest))} disabled={saving}>
                Not This
              </Button>
            ) : (
              <Button type="button" variant="outline" className="text-red-700" onClick={() => void thenLeave((latest) => onTakeOff(latest))} disabled={saving}>
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
              onChange={(e) => apply({ amps: e.target.value === "" ? null : Number(e.target.value) }, "Amps")}
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
              onChange={(e) => apply({ poles: Number(e.target.value) }, "Poles")}
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
            onChange={(e) => apply({ kind: e.target.value || null }, "Type")}
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

        {/* With one panel the circuit is on it; the picker shows when there is a choice, or when this
            circuit is on no panel yet (so it can always be put on one). */}
        {(panels.length > 1 || (panels.length > 0 && row.panel_id == null)) && (
          <Field label="Panel">
            <select
              className={selectCls}
              value={row.panel_id ?? ""}
              onChange={(e) => apply({ panel_id: e.target.value || null }, "Panel")}
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
              onPick={(v) => apply({ half: v === "full" ? null : v }, "Half")}
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
            onPick={(v) => apply({ work: v }, "Work")}
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
              onPick={(v) => apply({ progress: v }, "Progress")}
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
function textOf(row: JobCircuit, keys: readonly string[]): Partial<Record<string, string>> {
  const out: Partial<Record<string, string>> = {};
  for (const k of keys) {
    if (!["panel_label", "description", "room", "wire", "wire_tag", "space"].includes(k)) continue;
    const v = (row as unknown as Record<string, unknown>)[k];
    out[k] = v == null ? "" : String(v);
  }
  return out;
}
