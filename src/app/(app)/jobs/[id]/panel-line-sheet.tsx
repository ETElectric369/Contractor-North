"use client";

import { useState } from "react";
import { AlertTriangle } from "lucide-react";
import { Modal, ModalActions } from "@/components/ui/modal";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { normalizeCircuitPatch } from "@/lib/panel/input";
import { WORK_WORDS, slotsOf, spaceMap, titleWords } from "@/lib/panel/model";
import { circuitsOfPanel } from "@/lib/panel/held";
import type { CircuitWork, JobCircuit, JobPanel, SpaceHalf } from "@/lib/types";
import { addCircuit } from "../panel-actions";

/**
 * FILL AN OPEN LINE (the panel-first wave, P1): a tap on an open line of the door opens this sheet,
 * the way a tap on the schedule board opens a person's day. What it feeds, the amps (the common
 * sizes as chips, any other typed), the FORM of the breaker, and the work; Keep writes it with
 * Add A Circuit, on this space.
 *
 *   Single   one handle, the whole space.
 *   Tandem   two handles in this space, A over B: this tap fills one half, the other stays open.
 *   2-Pole   this space and the next one on this side (s and s+2), the same words on both.
 *   3-Pole   this space and the next two on this side.
 *
 * NEVER A SILENT SAVE: what the form would put where is checked against the door first (the model's
 * spaceMap, the same rule the door draws by). A form that would sit on a breaker already there, on
 * No Stab, or past the end of the panel is said in the model's words in the sheet, and Keep waits
 * for a form that fits. The panel label not allowing a tandem there is said, never refused (the
 * model's rule: a warning a person reads). A refused write keeps the sheet open with the reason.
 */

export type LineForm = "single" | "tandem" | "pole2" | "pole3";
export const FORM_WORDS: Record<LineForm, string> = { single: "Single", tandem: "Tandem", pole2: "2-Pole", pole3: "3-Pole" };
export const LINE_FORMS: LineForm[] = ["single", "tandem", "pole2", "pole3"];
/** The sizes most lines are: a chip each. Anything else is typed. */
export const QUICK_AMPS = [15, 20, 30, 40, 50, 60] as const;
/** A line being filled is a breaker that is (or will be) there: never Coming Out. */
export const LINE_WORKS: CircuitWork[] = ["new", "existing", "reused"];

export type LineAt = { space: number; half: SpaceHalf | null };
export type LineDraft = { space: number; half: SpaceHalf | null; poles: number };
export type LineValues = { description: string; room: string; amps: string; work: CircuitWork };

/** Where a form puts the circuit, from the line tapped. A tandem on a whole open line takes the half
 *  picked (A unless said); on a half line, that half. A 2-pole stays in the tapped half (a quad's
 *  middle), else whole. */
export function lineDraft(at: LineAt, form: LineForm, tandemHalf: SpaceHalf = "A"): LineDraft {
  switch (form) {
    case "single":
      return { space: at.space, half: null, poles: 1 };
    case "tandem":
      return { space: at.space, half: at.half ?? tandemHalf, poles: 1 };
    case "pole2":
      return { space: at.space, half: at.half, poles: 2 };
    case "pole3":
      return { space: at.space, half: null, poles: 3 };
  }
}

/** The form a tapped line starts on: a half line is a tandem's half; a whole line a single. */
export const startForm = (at: LineAt): LineForm => (at.half ? "tandem" : "single");

/** What the form covers, in a sentence ("Spaces 7 and 9, on this side."). The spaces and halves are
 *  the model's (slotsOf): a 2-pole kept in a half changes half on its next space, so one on 7B is
 *  "Spaces 7B and 9A" (a quad's centre when space 1 is at the top), never "the B halves". */
export function formWords(d: LineDraft): string {
  if (d.poles === 1) return d.half ? `The ${d.half === "A" ? "top" : "bottom"} half of space ${d.space} (${d.half}); the other half stays open.` : `One handle, the whole of space ${d.space}.`;
  const slots = slotsOf(d).map((x) => `${x.space}${x.half ?? ""}`);
  const list = slots.length === 2 ? `${slots[0]} and ${slots[1]}` : `${slots.slice(0, -1).join(", ")} and ${slots[slots.length - 1]}`;
  return `Spaces ${list}, on this side.`;
}

const NEW_ID = "__new_line__";

/** What stops the form here (the model's words, and the one thing to do), and what is only said. */
export function lineProblems(
  panel: JobPanel,
  circuits: JobCircuit[],
  d: LineDraft,
  v: Pick<LineValues, "description" | "room" | "amps">,
  opts: { livePanels?: number | null } = {},
): { block: string | null; warn: string | null } {
  // The panel's kept circuits by the one rule (lib/panel/held): a loose one is on the job's only panel.
  const kept = circuitsOfPanel(
    panel,
    circuits.filter((c) => !c.removed_at && c.state === "kept" && c.work !== "removed"),
    opts.livePanels,
  );
  const amps = Number(v.amps);
  const candidate = {
    id: NEW_ID,
    panel_id: panel.id,
    space: d.space,
    half: d.half,
    poles: d.poles,
    state: "kept" as const,
    removed_at: null,
    room: titleWords(v.room) || null,
    description: v.description.trim() || null,
    panel_label: null,
    amps: Number.isFinite(amps) && v.amps.trim() !== "" ? amps : null,
  };
  const ws = spaceMap(panel, [...kept, candidate]).warnings.filter((w) => w.circuitIds.includes(NEW_ID));
  const hard = ws.find((w) => w.kind !== "tandem_not_allowed");
  const soft = ws.find((w) => w.kind === "tandem_not_allowed");
  return { block: hard ? `${hard.message} Pick another form.` : null, warn: soft ? soft.message : null };
}

/** The Add A Circuit write for this line. The panel is the drawn one (null on a stand-in Panel 1:
 *  the server makes the real Panel 1 with it). */
export function linePayload(panel: Pick<JobPanel, "id">, v: LineValues, d: LineDraft): Record<string, unknown> {
  const a = v.amps.trim();
  return {
    description: v.description.trim() || null,
    room: titleWords(v.room) || null,
    amps: a === "" ? null : Number.isFinite(Number(a)) ? Number(a) : a,
    poles: d.poles,
    space: d.space,
    half: d.half,
    work: v.work,
    panel_id: panel.id || null,
  };
}

export type SendLineResult = { ok: true; row: JobCircuit; panel?: JobPanel; adopted?: { ids: string[]; panelId: string } } | { ok: false; error: string };

/** Keep: the fields checked the way the server checks them (the same words, before the trip), the
 *  door checked, then Add A Circuit. */
export async function sendLine(
  jobId: string,
  panel: JobPanel,
  circuits: JobCircuit[],
  v: LineValues,
  d: LineDraft,
  opts: { livePanels?: number | null } = {},
): Promise<SendLineResult> {
  const payload = linePayload(panel, v, d);
  const ok = normalizeCircuitPatch(payload);
  if (!ok.ok) return ok;
  const p = lineProblems(panel, circuits, d, v, opts);
  if (p.block) return { ok: false, error: p.block };
  try {
    const r = await addCircuit(jobId, payload);
    if (!r.ok) return { ok: false, error: r.error };
    return {
      ok: true,
      row: r.row,
      ...(r.panel ? { panel: r.panel } : {}),
      ...(r.adoptedIds?.length && r.adoptedOnto ? { adopted: { ids: r.adoptedIds, panelId: r.adoptedOnto } } : {}),
    };
  } catch {
    return { ok: false, error: "That didn't save. Check your connection and try again." };
  }
}

/** A 44px choice pill, the sheet's segmented control. */
function Pills<T extends string | number>({
  options,
  value,
  onPick,
  label,
  disabled,
}: {
  options: { id: T; label: string }[];
  value: T | null;
  onPick: (v: T) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-1.5">
      {options.map((o) => (
        <button
          key={String(o.id)}
          type="button"
          role="radio"
          aria-checked={value === o.id}
          disabled={disabled}
          onClick={() => onPick(o.id)}
          className={cn(
            "min-h-[44px] min-w-[44px] rounded-lg border px-3 text-sm font-medium disabled:opacity-50",
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

const label = "mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500";

export function PanelLineSheet({
  jobId,
  panel,
  circuits,
  at,
  livePanels = null,
  rooms = [],
  initial,
  onAdded,
  onClose,
}: {
  jobId: string;
  /** The panel drawn (a stand-in Panel 1 has no id: the server makes the real one). */
  panel: JobPanel;
  circuits: JobCircuit[];
  /** The open line tapped. */
  at: LineAt;
  /** How many live panels the job has (lib/panel/held belongsToPanel: which loose circuits are here). */
  livePanels?: number | null;
  /** The job's rooms, offered as the Room field is typed. */
  rooms?: string[];
  /** What the sheet starts with (a test, or a sheet opened again). */
  initial?: Partial<LineValues & { form: LineForm; tandemHalf: SpaceHalf }>;
  /** The circuit as saved, Panel 1 when this add made it, and the loose circuits it moved onto it. */
  onAdded: (row: JobCircuit, panel?: JobPanel, adopted?: { ids: string[]; panelId: string }) => void;
  onClose: () => void;
}) {
  const [v, setV] = useState<LineValues>({
    description: initial?.description ?? "",
    room: initial?.room ?? "",
    amps: initial?.amps ?? "20",
    work: initial?.work ?? "new",
  });
  const [form, setForm] = useState<LineForm>(initial?.form ?? startForm(at));
  const [tandemHalf, setTandemHalf] = useState<SpaceHalf>(initial?.tandemHalf ?? "A");
  const [other, setOther] = useState(() => v.amps !== "" && !(QUICK_AMPS as readonly number[]).includes(Number(v.amps)));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const d = lineDraft(at, form, tandemHalf);
  const problems = lineProblems(panel, circuits, d, v, { livePanels });

  async function keep() {
    if (saving) return;
    setSaving(true);
    setError(null);
    const r = await sendLine(jobId, panel, circuits, v, d, { livePanels });
    setSaving(false);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    onAdded(r.row, r.panel, r.adopted);
    onClose();
  }

  const set = (patch: Partial<LineValues>) => {
    setError(null);
    setV((cur) => ({ ...cur, ...patch }));
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`Space ${at.space}${at.half ?? ""}`}
      size="md"
      holdOpen={saving}
      dirty={v.description.trim() !== "" || v.room.trim() !== ""}
      footer={<ModalActions onCancel={onClose} onSave={() => void keep()} saveLabel="Keep" saving={saving} disabled={!!problems.block} />}
    >
      <div className="space-y-4">
        <label className="block">
          <span className={label}>What It Feeds</span>
          <Input className="h-11" value={v.description} placeholder="Dryer" onChange={(e) => set({ description: e.target.value })} />
        </label>
        <label className="block">
          <span className={label}>Room</span>
          <Input className="h-11" list={`line-rooms-${jobId}`} value={v.room} placeholder="Laundry" onChange={(e) => set({ room: e.target.value })} />
          <datalist id={`line-rooms-${jobId}`}>
            {rooms.map((r) => (
              <option key={r} value={r} />
            ))}
          </datalist>
        </label>

        <div>
          <span className={label}>Amps</span>
          <Pills
            label="Amps"
            options={[...QUICK_AMPS.map((a) => ({ id: String(a), label: String(a) })), { id: "other", label: "Other" }]}
            value={other ? "other" : v.amps}
            disabled={saving}
            onPick={(id) => {
              if (id === "other") {
                setOther(true);
                set({ amps: "" });
              } else {
                setOther(false);
                set({ amps: id });
              }
            }}
          />
          {other && (
            <Input
              className="mt-2 h-11"
              inputMode="numeric"
              aria-label="Other Amps"
              value={v.amps}
              placeholder="100"
              onChange={(e) => set({ amps: e.target.value.replace(/[^0-9]/g, "") })}
            />
          )}
        </div>

        <div>
          <span className={label}>Form</span>
          <Pills label="Form" options={LINE_FORMS.map((f) => ({ id: f, label: FORM_WORDS[f] }))} value={form} disabled={saving} onPick={(f) => {
              setError(null);
              setForm(f);
            }}
          />
          {form === "tandem" && !at.half && (
            <div className="mt-2">
              <Pills
                label="Which Half"
                options={[
                  { id: "A" as SpaceHalf, label: "Top (A)" },
                  { id: "B" as SpaceHalf, label: "Bottom (B)" },
                ]}
                value={tandemHalf}
                disabled={saving}
                onPick={(h) => setTandemHalf(h)}
              />
            </div>
          )}
          <p className="mt-1 text-xs text-slate-500">{formWords(d)}</p>
        </div>

        <div>
          <span className={label}>Work</span>
          <Pills label="Work" options={LINE_WORKS.map((w) => ({ id: w, label: WORK_WORDS[w] }))} value={v.work} disabled={saving} onPick={(w) => set({ work: w })} />
        </div>

        {problems.block && (
          <p role="alert" className="flex items-start gap-1.5 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {problems.block}
          </p>
        )}
        {!problems.block && problems.warn && (
          <p className="flex items-start gap-1.5 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {problems.warn}
          </p>
        )}
        {error && error !== problems.block && (
          <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
