"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Check, ChevronDown, ChevronRight, Loader2, Pencil, Plus, ShieldCheck, Sparkles, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/toast";
import { cn } from "@/lib/utils";
import { AMP_SIZES } from "@/lib/panel/input";
import { FIRST_PANEL_NAME, FIRST_PANEL_SPACES } from "@/lib/panel/ensure-panel";
import {
  PROGRESS_WORDS,
  WORK_WORDS,
  circuitLine,
  circuitName,
  groupByRoom,
  labelDiffers,
  nextProgress,
  sizeWords,
  sourceWords,
  titleWords,
} from "@/lib/panel/model";
import { labelCheckApplied } from "@/lib/panel/readers";
import { spaceWords } from "@/lib/panel/directory";
import { belongsToPanel, suggestedWordsField } from "@/lib/panel/held";
import type { CircuitWork, JobCircuit, JobPanel, SpaceHalf } from "@/lib/types";
import {
  addCircuit,
  advanceProgress,
  bringInEstimateCircuits,
  dismissSuggestion,
  keepSuggestions,
  saveCircuit,
  setAsideSuggestions,
  takeOffCircuit,
  undoLabelCheck,
  undoTakeOff,
  applyLabelCheck,
  // Named as a door, not a hook: it is a server action, called from a tap.
  useSuggestedWords as applySuggestedWords,
  type PanelLoad,
} from "../panel-actions";
import { CircuitEditSheet } from "./circuit-edit-sheet";
import { JobPanelBreakers } from "./job-panel-breakers";
import { JobPanelDirectory } from "./job-panel-directory";
import { PanelReaders } from "./job-panel-readers";
import { PanelLineSheet } from "./panel-line-sheet";
import { PanelSetupSheet } from "./panel-setup-sheet";
import { PanelVisual, movePlan, panelVisualModel, type VisualNote } from "./panel-visual";

/**
 * THE PANEL TAB (Panel plan, phase 2; Erik 2026-09-25: "instead of a .pdf it can just be there";
 * the panel-first wave, 2026-10-30: "match the way a panel looks and is labeled").
 *
 * Top to bottom: the office's estimate bar; the panel by its name and its circuit count ("Panel 1 ·
 * 34 circuits", tabs only when a job has several, Edit Panel); the photo read; THE DOOR (panel-
 * visual: two columns facing each other, odd left, even right, filled by a tap like the schedule
 * board); the Breakers line; every circuit as a list (By Space, By Area, By Size) with the Planned /
 * Roughed / Done chip and Add A Circuit under it; what came off; the printed labels; and Add New
 * Panel, last. A job never says it has no panel: Panel 1 is made by the server with its first
 * circuit (lib/panel/ensure-panel), and until then the door shows Panel 1 waiting. A new panel is
 * only ever made by Add New Panel at the bottom; a write that made Panel 1 hands it back, and it is
 * on the tab at once.
 *
 * Laws on this screen: nothing counts until kept (suggestions are dimmed and named by where they came
 * from); no Save button (each change is written as it is made, and Take Off, Not This, Keep, Move and
 * the chip all carry Undo); nothing silent (every write's answer is shown); 44px targets (a tandem's
 * half line is half a 44px space, by the door's own scale) and nothing wider than a 375px phone;
 * every clickable in Title Case.
 */

export type PanelData = Extract<PanelLoad, { ok: true }>;

const QUICK_KEY = (jobId: string) => `cn-panel-quick-add:${jobId}`;
type Quick = { room: string; amps: string; poles: string; work: CircuitWork };
const QUICK_DEFAULT: Quick = { room: "", amps: "20", poles: "1", work: "new" };

/** What Add A Circuit carries to the next add: the room and the amps only. A 2-pole (the floor heat,
 *  the dryer) and an Existing or Reused circuit are one-offs: carried forward, the next three 120 V
 *  outlets went in as 2-poles (J-011, 2026-09-25). Every add starts on 1-pole and New. */
export function carryQuick(v: Partial<Quick> | null | undefined): Quick {
  return {
    ...QUICK_DEFAULT,
    room: typeof v?.room === "string" ? v.room : "",
    amps: typeof v?.amps === "string" && v.amps ? v.amps : QUICK_DEFAULT.amps,
  };
}

function readQuick(jobId: string): Quick {
  try {
    const raw = typeof window !== "undefined" ? window.localStorage.getItem(QUICK_KEY(jobId)) : null;
    if (!raw) return QUICK_DEFAULT;
    const v = JSON.parse(raw) as Partial<Quick>;
    return carryQuick(v);
  } catch {
    return QUICK_DEFAULT;
  }
}
function writeQuick(jobId: string, q: Quick) {
  try {
    window.localStorage.setItem(QUICK_KEY(jobId), JSON.stringify(q));
  } catch {
    /* a private window: the room and amps are simply not remembered across visits */
  }
}

/** The panel the tab draws while a job has none: Panel 1 as the server will make it (24 spaces, top
 *  down), with no id, so a fill sends no panel and the server makes the real one with the circuit. */
export function standInPanel(jobId: string): JobPanel {
  return {
    id: "",
    org_id: "",
    job_id: jobId,
    name: FIRST_PANEL_NAME,
    brand: null,
    bus_amps: null,
    main_amps: null,
    spaces: FIRST_PANEL_SPACES,
    numbering: "top_down",
    dead_spaces: [],
    twin_spaces: [],
    space_pitch_in: null,
    label_width_in: null,
    label_width_in_right: null,
    photo_document_id: null,
    notes: null,
    shown_on_portal: false,
    created_by: null,
    created_at: "",
    updated_by: null,
    updated_at: "",
    removed_at: null,
    removed_by: null,
  };
}

/** The tab's rows after a write moved loose circuits onto a panel (the server's adoptedIds onto
 *  adoptedOnto): those rows carry the panel now, the way the database does, so a second panel added
 *  later can't drop them off the door. Only a row still on no panel moves; nothing else changes. */
export function adoptRows(cs: JobCircuit[], ids: string[] | undefined, panelId: string | undefined): JobCircuit[] {
  if (!ids?.length || !panelId) return cs;
  const moved = new Set(ids);
  return cs.map((c) => (moved.has(c.id) && c.panel_id == null ? { ...c, panel_id: panelId } : c));
}

/** "34 circuits", "1 circuit", "No circuits yet". */
export function circuitCountWords(n: number): string {
  return n === 0 ? "No circuits yet" : `${n} circuit${n === 1 ? "" : "s"}`;
}

export type ListSort = "space" | "area" | "size";
const SORTS: [ListSort, string][] = [
  ["space", "By Space"],
  ["area", "By Area"],
  ["size", "By Size"],
];
export const NO_SPACE = "No Space Yet";
export const NO_AMPS = "No Amps Yet";

/**
 * The list under the door, three ways. By Area: the rooms in the order they first appear, the
 * unroomed last (groupByRoom). By Space: each panel's circuits in space order (A before B), then the
 * ones with no space yet. By Size: 1-poles before 2-poles, small amps first ("1P 20A"), then the
 * ones with no amps yet. Every circuit is in exactly one group.
 */
export function listGroups(kept: JobCircuit[], sort: ListSort, panels: Pick<JobPanel, "id" | "name">[] = []): { title: string; circuits: JobCircuit[] }[] {
  if (sort === "area") return groupByRoom(kept).map((g) => ({ title: g.room, circuits: g.circuits }));
  const bySort = (a: JobCircuit, b: JobCircuit) => (a.sort_order ?? 0) - (b.sort_order ?? 0);
  const groups = new Map<string, JobCircuit[]>();
  const put = (k: string, c: JobCircuit) => groups.set(k, [...(groups.get(k) ?? []), c]);
  if (sort === "size") {
    const sized = [...kept].sort((a, b) => a.poles - b.poles || (a.amps ?? Infinity) - (b.amps ?? Infinity) || bySort(a, b));
    for (const c of sized) put(c.amps == null ? NO_AMPS : sizeWords(c.poles, c.amps), c);
    const out = [...groups.entries()].map(([title, circuits]) => ({ title, circuits }));
    return [...out.filter((g) => g.title !== NO_AMPS), ...out.filter((g) => g.title === NO_AMPS)];
  }
  const order = new Map(panels.map((p, i) => [p.id, i]));
  const name = (id: string | null) => panels.find((p) => p.id === id)?.name ?? (panels.length === 1 ? panels[0].name : "On The Panel");
  const placed = kept
    .filter((c) => c.space != null)
    .sort(
      (a, b) =>
        (order.get(a.panel_id ?? "") ?? -1) - (order.get(b.panel_id ?? "") ?? -1) ||
        a.space! - b.space! ||
        String(a.half ?? "").localeCompare(String(b.half ?? "")) ||
        bySort(a, b),
    );
  for (const c of placed) put(name(c.panel_id), c);
  const out = [...groups.entries()].map(([title, circuits]) => ({ title, circuits }));
  const unplaced = kept.filter((c) => c.space == null).sort(bySort);
  return unplaced.length ? [...out, { title: NO_SPACE, circuits: unplaced }] : out;
}

const card = "rounded-xl border border-slate-200 bg-white p-4 shadow-sm";
const chip = (progress: JobCircuit["progress"]) =>
  progress === "done"
    ? "border-emerald-300 bg-emerald-50 text-emerald-800"
    : progress === "roughed"
      ? "border-amber-300 bg-amber-50 text-amber-800"
      : "border-slate-300 bg-white text-slate-600";

export function JobPanel({ jobId, initial }: { jobId: string; initial: PanelData }) {
  const toast = useToast();
  const staff = initial.staff;
  const [panels, setPanels] = useState<JobPanel[]>(initial.panels);
  const [circuits, setCircuits] = useState<JobCircuit[]>(initial.circuits);
  const [estimates, setEstimates] = useState(initial.estimates);
  const [activePanelId, setActivePanelId] = useState<string | null>(initial.panels[0]?.id ?? null);
  const [sort, setSort] = useState<ListSort>("area");
  const [editing, setEditing] = useState<string | null>(null);
  // Tap first, never drag: an open line opens the line sheet; Move in a circuit's sheet, then a tap
  // on the line it goes to.
  const [filling, setFilling] = useState<{ space: number; half: SpaceHalf | null } | null>(null);
  const [moving, setMoving] = useState<JobCircuit | null>(null);
  const [panelSheet, setPanelSheet] = useState<"new" | string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [showOff, setShowOff] = useState(false);
  const [quick, setQuick] = useState<Quick>(QUICK_DEFAULT);
  const [feeds, setFeeds] = useState("");
  useEffect(() => setQuick(readQuick(jobId)), [jobId]);

  const upsert = useCallback((rows: JobCircuit[]) => {
    setCircuits((cs) => {
      const next = [...cs];
      for (const r of rows) {
        const i = next.findIndex((c) => c.id === r.id);
        if (i >= 0) next[i] = r;
        else next.push(r);
      }
      return next;
    });
  }, []);
  /** The loose circuits a write moved onto a panel (the server's adoptedIds): the rows say so now. */
  const adopted = useCallback((ids: string[] | undefined, panelId: string | undefined) => {
    if (!ids?.length || !panelId) return;
    setCircuits((cs) => adoptRows(cs, ids, panelId));
  }, []);

  const live = circuits.filter((c) => !c.removed_at);
  const suggested = live.filter((c) => c.state === "suggested").sort((a, b) => a.sort_order - b.sort_order);
  const kept = live.filter((c) => c.state === "kept");
  // What came off, circuits only: a label check that was used or set aside is not a circuit anyone
  // took off, so it is listed on its own line in plain words below, with its own Undo.
  const takenOff = circuits.filter((c) => c.removed_at && !c.source_row?.flag_for);
  const checksDone = circuits.filter((c) => c.removed_at && c.source_row?.flag_for);
  const activePanel = panels.find((p) => p.id === activePanelId) ?? panels[0] ?? null;
  // The panel the heading names and the door draws: the job's, or Panel 1 waiting for its first circuit.
  const standIn = useMemo(() => standInPanel(jobId), [jobId]);
  const shown = activePanel ?? standIn;
  // The job's only panel (or Panel 1 waiting) draws and counts the circuits on no panel yet: the
  // server puts them on it. ONE rule decides it everywhere (lib/panel/held belongsToPanel).
  const livePanels = panels.length;
  const model = useMemo(() => panelVisualModel(shown, circuits, { livePanels }), [shown, circuits, livePanels]);
  const onDoor = new Set([...model.dimmed, ...model.noted].map((c) => c.id));
  const noted = new Set(model.noted.map((c) => c.id));
  // The suggestions the door can't draw go in the list under it, among their area's circuits: the
  // estimate's, the plans' and Nort's (no space yet), their label checks, one past the end or on No Stab.
  const listed = suggested.filter((c) => !onDoor.has(c.id));
  // A label check (a reader's "Panel Says Mini Fridge, Your List Says Fridge") is never kept as a
  // circuit of its own, and a read naming a breaker that is already there is Use It or Skip: Keep All
  // leaves both for their own doors.
  const keepable = suggested.filter((c) => !c.source_row?.flag_for && !noted.has(c.id));
  // The heading counts what is THIS panel's by the door's own rule: never a circuit left on a panel
  // that was taken off, or one on another panel.
  const onShown = kept.filter((c) => belongsToPanel(c, shown, livePanels));
  // The list under the door: the kept circuits, and the suggestions the door can't draw among them.
  const groups = useMemo(() => listGroups([...kept, ...listed], sort, panels), [kept, listed, sort, panels]);
  const rooms = useMemo(() => [...new Set(kept.map((c) => titleWords(c.room)).filter(Boolean))].sort(), [kept]);
  const editingRow = circuits.find((c) => c.id === editing) ?? null;
  const movingRow = moving ? (circuits.find((c) => c.id === moving.id && !c.removed_at) ?? null) : null;
  // An estimate is offered while Bring In would still bring something (offerEstimates): a copy
  // whose rows are already here, or one whose every row is here or set aside, offers nothing.
  const offers = estimates.filter((e) => e.fresh > 0);
  const adding = useRef(false);

  /** Run one write; show its answer; hand back the result. */
  async function run<T extends { ok: boolean }>(key: string, fn: () => Promise<T>): Promise<T | null> {
    setBusy(key);
    try {
      const r = await fn();
      if (!r.ok) {
        toast((r as unknown as { error: string }).error, "error");
        // Someone changed it first: show the row as it is now, never the stale one.
        const current = (r as unknown as { current?: JobCircuit }).current;
        if (current) upsert([current]);
      }
      return r;
    } catch {
      toast("That didn't save. Check your connection and try again.", "error");
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function bringIn(quoteId: string, label: string) {
    const r = await run(`bring:${quoteId}`, () => bringInEstimateCircuits(jobId, quoteId));
    if (!r || !r.ok) return;
    if (r.panel) panelSaved(r.panel);
    adopted(r.adoptedIds, r.adoptedOnto);
    upsert(r.rows);
    setEstimates(r.estimates);
    if (!r.added) {
      toast(r.message || `Nothing new from ${label}.`, "info", undefined, { sticky: true });
      return;
    }
    // A wrong Bring In is one tap to take back, not twelve Not This taps.
    const ids = r.rows.map((x) => x.id);
    toast(r.message || `Brought in from ${label}.`, "info", {
      label: "Undo",
      onClick: async () => {
        const u = await run("unbring", () => setAsideSuggestions(jobId, ids, true));
        if (!u || !u.ok) return;
        upsert(u.rows);
        toast(`Set aside the ${u.rows.length} from ${label}.`, "success", {
          label: "Undo",
          onClick: async () => {
            const b = await run("rebring", () => setAsideSuggestions(jobId, ids, false));
            if (b && b.ok) upsert(b.rows);
          },
        });
      },
    });
  }

  async function keep(ids: string[], words: string) {
    const r = await run(`keep:${ids.join(",")}`, () => keepSuggestions(jobId, ids));
    if (!r || !r.ok) return;
    if (r.panel) panelSaved(r.panel);
    adopted(r.adoptedIds, r.adoptedOnto);
    upsert(r.rows);
    setEditing(null);
    const keptIds = r.rows.map((x) => x.id);
    if (r.rows.length) {
      toast(words, "success", {
        label: "Undo",
        onClick: async () => {
          const u = await run("unkeep", () => keepSuggestions(jobId, keptIds, false));
          if (u && u.ok) upsert(u.rows);
        },
      });
    }
    if (r.skipped.length) {
      const names = r.skipped
        .map((s) => {
          const c = circuits.find((x) => x.id === s.id);
          return `${c ? circuitName(c) : "A circuit"}: ${s.error}`;
        })
        .join(" ");
      toast(`${r.skipped.length} couldn't be kept. ${names}`, "info", undefined, { sticky: true });
    }
  }

  async function remove(c: JobCircuit, how: "notThis" | "takeOff") {
    const r = await run(`rm:${c.id}`, () => (how === "notThis" ? dismissSuggestion(c.id) : takeOffCircuit(c.id)));
    if (!r || !r.ok) return;
    upsert([r.row]);
    setEditing(null);
    toast(how === "notThis" ? `Set aside ${circuitName(c)}.` : `Took off ${circuitName(c)}.`, "success", {
      label: "Undo",
      onClick: () => void putBack(r.row),
    });
  }

  async function putBack(c: JobCircuit) {
    const r = await run(`back:${c.id}`, () => undoTakeOff(c.id));
    if (r && r.ok) {
      upsert([r.row]);
      toast(`Put back ${circuitName(r.row)}.`, "success");
    }
  }

  /** Use What It Says: the check's change goes onto the circuit it names, only while that circuit
   *  still says what the reader saw beside it. Undo puts both back the same careful way. */
  async function applyCheck(c: JobCircuit) {
    const r = await run(`check:${c.id}`, () => applyLabelCheck(c.id));
    if (!r || !r.ok) return;
    upsert([r.circuit, r.check]);
    toast(r.words, "success", {
      label: "Undo",
      onClick: () => void undoCheck(c),
    });
  }

  /** The Undo of Use It, from the toast or from Taken Off Or Set Aside: the circuit goes back to
   *  what it said (only if it still says what the check put there) and the check waits again. */
  async function undoCheck(c: JobCircuit) {
    const u = await run(`check:${c.id}`, () => undoLabelCheck(c.id));
    if (!u || !u.ok) return;
    upsert([u.circuit, u.check]);
    toast(u.words, "success");
  }

  /** A panel added or changed from anywhere on the tab (the setup sheet, or a read's Use). */
  function panelSaved(row: JobPanel, placed?: { adopted: JobCircuit[]; notAdopted: string[] }) {
    setPanels((ps) => (ps.some((p) => p.id === row.id) ? ps.map((p) => (p.id === row.id ? row : p)) : [...ps, row]));
    // The first panel took the circuits already on the list: the door shows them now.
    if (placed?.adopted.length) upsert(placed.adopted);
    if (placed?.notAdopted.length) {
      toast(`${placed.notAdopted.length} couldn't go on ${row.name}. ${placed.notAdopted.join(" ")}`, "info", undefined, { sticky: true });
    }
    if (!activePanelId) setActivePanelId(row.id);
  }

  async function tapChip(c: JobCircuit) {
    const r = await run(`chip:${c.id}`, () => advanceProgress(c.id, c.progress));
    if (!r || !r.ok) return;
    upsert([r.row]);
    const from = c.progress;
    toast(`${circuitName(c)}: ${PROGRESS_WORDS[r.row.progress]}.`, "success", {
      label: "Undo",
      onClick: async () => {
        // Only if it still says what this tap made it: a crewmate's later tap is never rolled back.
        const u = await run(`chip:${c.id}`, () => saveCircuit(c.id, { progress: from }, { progress: r.row.progress }));
        if (u && u.ok) upsert([u.row]);
      },
    });
  }

  async function quickAdd(e: React.FormEvent) {
    e.preventDefault();
    // The keyboard's Go submits the form even while the button is disabled: one add at a time, or
    // a double press with a glove on makes two identical circuits.
    if (adding.current || busy !== null) return;
    adding.current = true;
    const q = { ...quick, room: titleWords(quick.room) };
    const r = await run("add", () =>
      addCircuit(jobId, {
        room: q.room || null,
        description: feeds.trim() || null,
        amps: q.amps ? Number(q.amps) : null,
        poles: Number(q.poles) || 1,
        work: q.work,
        panel_id: activePanelId,
      }),
    ).finally(() => {
      adding.current = false;
    });
    if (!r || !r.ok) return;
    if (r.panel) panelSaved(r.panel);
    adopted(r.adoptedIds, r.adoptedOnto);
    upsert([r.row]);
    const next = carryQuick(q);
    setQuick(next);
    writeQuick(jobId, next);
    setFeeds("");
    toast(`Added ${circuitLine(r.row)}.`, "success", {
      label: "Undo",
      onClick: async () => {
        const u = await run(`rm:${r.row.id}`, () => takeOffCircuit(r.row.id));
        if (u && u.ok) upsert([u.row]);
      },
    });
  }

  /** The line sheet kept a circuit on the door (and maybe made Panel 1 with it). */
  function lineAdded(row: JobCircuit, made?: JobPanel, moved?: { ids: string[]; panelId: string }) {
    if (made) panelSaved(made);
    adopted(moved?.ids, moved?.panelId);
    upsert([row]);
    toast(`Added ${circuitLine(row)} on space ${row.space ?? "?"}${row.half ?? ""}.`, "success", {
      label: "Undo",
      onClick: async () => {
        const u = await run(`rm:${row.id}`, () => takeOffCircuit(row.id));
        if (u && u.ok) upsert([u.row]);
      },
    });
  }

  /** MOVE, the board's tap-tap: the circuit picked with Move in its sheet goes to the line tapped
   *  now. A line that is taken (or No Stab, or one that runs it off the end) says so and nothing
   *  moves; the move itself is one saveCircuit that names where it was, with Undo. */
  async function moveTo(space: number, half: SpaceHalf | null) {
    const c = movingRow;
    if (!c) {
      setMoving(null);
      return;
    }
    const plan = movePlan(shown, circuits, c, { space, half }, { livePanels });
    if (!plan.ok) {
      toast(plan.words, "info");
      return;
    }
    const from: Record<string, unknown> = { space: c.space, half: c.half };
    const to: Record<string, unknown> = { space: plan.space, half: plan.half };
    // A circuit on no panel (or on another) lands on the panel the door shows.
    if (shown.id && c.panel_id !== shown.id) {
      from.panel_id = c.panel_id;
      to.panel_id = shown.id;
    }
    const r = await run(`move:${c.id}`, () => saveCircuit(c.id, to, from));
    if (!r || !r.ok) return;
    setMoving(null);
    upsert([r.row]);
    toast(`Moved ${circuitName(c)} to space ${plan.space}${plan.half ?? ""}.`, "success", {
      label: "Undo",
      onClick: async () => {
        const now: Record<string, unknown> = {};
        for (const k of Object.keys(from)) now[k] = (r.row as unknown as Record<string, unknown>)[k] ?? null;
        const u = await run(`move:${c.id}`, () => saveCircuit(c.id, from, now));
        if (u && u.ok) upsert([u.row]);
      },
    });
  }

  /** Use It under a kept line: a read's other name for that breaker goes onto THE circuit the line
   *  was drawn under, only while it still says what the line showed (a crewmate's newer words are
   *  never overwritten); a label check goes the careful way it always has. Undo puts both back. */
  async function takeReadWords(n: VisualNote) {
    const s = n.suggestion;
    const field = suggestedWordsField(s);
    const seen = field ? (n.target[field] ?? null) : null;
    const r = await run(`use:${s.id}`, () => applySuggestedWords(jobId, { suggestedId: s.id, targetId: n.target.id, seen }));
    if (!r || !r.ok) return;
    upsert([r.circuit, r.suggestion]);
    toast(r.words, "success", {
      label: "Undo",
      onClick: async () => {
        if (r.was !== r.circuit[r.field]) {
          const u = await run(`use:${s.id}`, () => saveCircuit(r.circuit.id, { [r.field]: r.was }, { [r.field]: r.circuit[r.field] }));
          if (!u || !u.ok) return;
          upsert([u.row]);
        }
        const b = await run(`back:${s.id}`, () => undoTakeOff(s.id));
        if (b && b.ok) upsert([b.row]);
      },
    });
  }
  const onNote = (n: VisualNote) => void (n.kind === "check" ? applyCheck(n.suggestion) : takeReadWords(n));

  /** A suggestion the door can't draw (the estimate's and the plans' and Nort's have no space yet;
   *  a label check is about a circuit with none), in the list among the circuits of its area:
   *  dimmed, named by where it came from, counted by nothing until kept. */
  const suggestionRow = (c: JobCircuit) => {
    const from = sourceWords(c);
    const aboutId = c.source_row?.flag_for ?? null;
    const about = aboutId ? (circuits.find((x) => x.id === aboutId) ?? null) : null;
    const canUse = !!aboutId && Object.keys(c.source_row?.use ?? {}).length > 0;
    return (
      <li key={c.id} data-suggested="" className="my-1 rounded-lg border border-dashed border-slate-300 bg-slate-50 p-3">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-slate-500">
          <span className="font-medium text-slate-600">{aboutId ? `Label Check: ${about ? circuitName(about) : "A Circuit On Your List"}` : circuitLine(c)}</span>
          {from && <span className="rounded-full bg-white px-2 py-0.5 text-[11px] font-semibold text-slate-500 ring-1 ring-slate-200">{from}</span>}
          {!aboutId && c.space != null && (
            <span className="text-[11px]">
              Space {c.space}
              {c.half ?? ""}
            </span>
          )}
          {c.source === "plan" && c.source_row?.ckt && <span className="text-[11px]">Plans: Ckt {c.source_row.ckt}</span>}
        </div>
        {c.source_row?.load && <div className="mt-0.5 text-xs text-slate-400">{c.source_row.load}</div>}
        {c.source_row?.check && (
          <div className="mt-1 flex items-start gap-1 text-xs font-medium text-amber-800">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {c.source_row.check}
          </div>
        )}
        {aboutId ? (
          <div className="mt-2 grid grid-cols-3 gap-2">
            <Button onClick={() => applyCheck(c)} disabled={busy !== null || !canUse || !about}>
              {busy === `check:${c.id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Use It
            </Button>
            <Button variant="outline" onClick={() => about && setEditing(about.id)} disabled={busy !== null || !about}>
              Open It
            </Button>
            <Button variant="ghost" onClick={() => remove(c, "notThis")} disabled={busy !== null}>
              Not This
            </Button>
          </div>
        ) : (
          <div className="mt-2 grid grid-cols-3 gap-2">
            <Button onClick={() => keep([c.id], `Kept ${circuitName(c)}.`)} disabled={busy !== null}>
              Keep
            </Button>
            <Button variant="outline" onClick={() => setEditing(c.id)} disabled={busy !== null}>
              Change
            </Button>
            <Button variant="ghost" onClick={() => remove(c, "notThis")} disabled={busy !== null}>
              Not This
            </Button>
          </div>
        )}
      </li>
    );
  };

  return (
    <div className="space-y-4">
      {/* THE SUGGESTION BAR: the office's Bring In, one per estimate that has circuits not here yet. */}
      {staff &&
        offers.map((e) => (
          <div key={e.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-[rgb(var(--glass-ink))]/30 bg-[rgb(var(--glass-tint))]/10 p-3">
            <Sparkles className="h-5 w-5 shrink-0 text-[rgb(var(--glass-ink))]" />
            <div className="min-w-0 flex-1 text-sm">
              <div className="font-semibold text-slate-900">
                {e.quote_number ?? "The Estimate"} Has {e.count} Circuit{e.count === 1 ? "" : "s"}
                {e.onJob ? `. ${e.onJob} ${e.onJob === 1 ? "Is" : "Are"} Here${e.alsoFrom ? ` From ${e.alsoFrom}` : ""}` : ""}
              </div>
              {e.address && <div className="truncate text-xs text-slate-500">{e.address}</div>}
            </div>
            <Button onClick={() => bringIn(e.id, e.quote_number ?? "the estimate")} disabled={busy !== null}>
              {busy === `bring:${e.id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Bring Them In
            </Button>
          </div>
        ))}

      {/* THE PANEL BY ITS NAME: "Panel 1 · 34 circuits", the panels as tabs only when there are
          several, and Edit Panel. A job with no panel yet shows Panel 1 waiting; its first circuit
          makes it (never a word about having no panel over a list of circuits). */}
      <section className={card} aria-label="The Panel">
        {panels.length > 1 && (
          <div className="mb-3 flex flex-wrap gap-2" role="tablist" aria-label="Panels">
            {panels.map((p) => (
              <button
                key={p.id}
                type="button"
                role="tab"
                aria-selected={p.id === shown.id}
                onClick={() => {
                  setActivePanelId(p.id);
                  setMoving(null);
                }}
                className={cn(
                  "min-h-[44px] rounded-lg border px-3 text-sm font-medium",
                  p.id === shown.id ? "border-[rgb(var(--glass-ink))] bg-[rgb(var(--glass-tint))]/20 text-[rgb(var(--glass-ink))]" : "border-slate-300 text-slate-700",
                )}
              >
                {p.name}
              </button>
            ))}
          </div>
        )}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="flex items-center gap-2 text-base font-semibold text-slate-900">
              <Zap className="h-4 w-4 text-[rgb(var(--glass-ink))]" /> {shown.name}
            </h3>
            <p className="mt-0.5 text-sm text-slate-500">{circuitCountWords(onShown.length)}</p>
          </div>
          {activePanel && (
            <Button variant="outline" onClick={() => setPanelSheet(activePanel.id)}>
              <Pencil className="h-4 w-4" /> Edit Panel
            </Button>
          )}
        </div>
        {!activePanel && <p className="mt-2 text-sm text-slate-500">Tap an open space on the door to add the first circuit there.</p>}
      </section>

      {/* THE READERS (phase 4): the photo read, right above the door it fills. Suggestions only. */}
      <PanelReaders
        jobId={jobId}
        staff={staff}
        orgId={initial.orgId}
        photos={initial.photos}
        plans={initial.plans}
        photoReadsLeft={initial.photoReadsLeft}
        planReadsLeft={initial.planReadsLeft}
        panel={activePanel}
        onRows={upsert}
        onPanel={panelSaved}
        onAdopted={(ids, panelId) => adopted(ids, panelId)}
      />

      {/* KEEP ALL, above the door: every suggestion that can be kept as a circuit, on the door or in
          the list below it. A label check, or a read naming a breaker already there (Use It / Skip
          under its line), has its own doors. */}
      {keepable.length > 1 && (
        <Button className="w-full" onClick={() => keep(keepable.map((c) => c.id), `Kept ${keepable.length} circuits.`)} disabled={busy !== null}>
          <Check className="h-4 w-4" /> Keep All ({keepable.length})
        </Button>
      )}

      {/* THE DOOR (the panel-first wave): two columns of breakers facing each other, odd left, even
          right, a tandem's two lines A over B, a 2-pole's words on both its lines. Tap an open line
          to fill it, a filled one to change it; Move, then tap where it goes. */}
      <PanelVisual
        panel={shown}
        circuits={circuits}
        livePanels={livePanels}
        busy={busy}
        moving={movingRow}
        onOpen={(id) => setEditing(id)}
        onFill={(space, half) => setFilling({ space, half })}
        onKeep={(s) => keep([s.id], `Kept ${circuitName(s)}.`)}
        onUse={onNote}
        onSkip={(s) => remove(s, "notThis")}
        onMoveTo={(space, half) => void moveTo(space, half)}
        onCancelMove={() => setMoving(null)}
      />

      {/* THE BREAKERS (phase 3): what the new circuits need against what came on the tickets. It
          reads the live list, so a Keep or a Take Off changes the count at once. */}
      <JobPanelBreakers jobId={jobId} circuits={circuits} panel={activePanel} onRows={upsert} onAddPanel={() => setPanelSheet("new")} />

      {/* EVERY CIRCUIT AS A LIST, under the door: By Space, By Area (the rooms, the default) or By
          Size, each with its New / Existing word and the Planned / Roughed / Done chip. */}
      <section className={card} aria-label="Circuits">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-base font-semibold text-slate-900">Circuits</h3>
          <div className="grid grid-cols-3 gap-1 rounded-lg bg-slate-100 p-1" role="tablist" aria-label="Sort">
            {SORTS.map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={sort === id}
                onClick={() => setSort(id)}
                className={cn("min-h-[44px] rounded-md px-2 text-xs font-medium", sort === id ? "bg-white text-slate-900 shadow-sm" : "text-slate-500")}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        {listed.length > 0 && (
          <p className="mt-1 text-sm text-slate-500">
            {listed.length} suggested, dimmed below. Nothing counts until you keep it.
          </p>
        )}
          {kept.length + listed.length === 0 ? (
            <p className="mt-2 text-sm text-slate-500">
              {suggested.length ? "Keep the dimmed lines on the door, or add circuits below." : "No circuits yet. Tap a space on the door, or add them below as you walk the panel."}
            </p>
          ) : (
            <div className="mt-2 divide-y divide-slate-100">
              {groups.map((g) => (
                <div key={g.title} className="py-2">
                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                    {g.title} · {g.circuits.filter((c) => c.state === "kept").length}
                  </div>
                  <ul>
                    {g.circuits.map((c) => (c.state === "suggested" ? suggestionRow(c) : (
                      <li key={c.id} className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => setEditing(c.id)}
                          className="flex min-h-[44px] min-w-0 flex-1 flex-col items-start justify-center py-1 text-left"
                        >
                          <span className="line-clamp-2 w-full break-words text-sm font-medium text-slate-900">{circuitLine(c)}</span>
                          <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-slate-500">
                            <span className={cn("font-semibold", c.work === "new" ? "text-[rgb(var(--glass-ink))]" : "text-slate-500")}>{WORK_WORDS[c.work]}</span>
                            {c.space != null && <span>Space {spaceWords(c)}</span>}
                            {labelDiffers(c) && <span className="text-amber-700">Door Says {titleWords(c.panel_label)}</span>}
                            {c.verified && (
                              <span className="inline-flex items-center gap-0.5 text-emerald-700">
                                <ShieldCheck className="h-3 w-3" /> Verified
                              </span>
                            )}
                          </span>
                        </button>
                        <button
                          type="button"
                          onClick={() => tapChip(c)}
                          disabled={busy !== null}
                          aria-label={`${PROGRESS_WORDS[c.progress]}. Tap for ${PROGRESS_WORDS[nextProgress(c.progress)]}.`}
                          className={cn("min-h-[44px] min-w-[5.5rem] shrink-0 rounded-full border px-3 text-xs font-semibold disabled:opacity-50", chip(c.progress))}
                        >
                          {busy === `chip:${c.id}` ? <Loader2 className="mx-auto h-4 w-4 animate-spin" /> : PROGRESS_WORDS[c.progress]}
                        </button>
                      </li>
                    )))}
                  </ul>
                </div>
              ))}
            </div>
          )}
      </section>

      {/* ADD A CIRCUIT: remembers the room and amps you used last, so sixteen twenties go in as
          sixteen lines of "what it feeds" and a tap. Poles and New/Existing reset to 1-pole and New. */}
      <form onSubmit={quickAdd} className={card} aria-label="Add A Circuit">
        <h3 className="text-base font-semibold text-slate-900">Add A Circuit</h3>
        <div className="mt-2 grid grid-cols-[minmax(0,1fr)_5.5rem_4.5rem] gap-2">
          <label className="min-w-0">
            <span className="sr-only">Room</span>
            <Input className="h-11" list={`panel-rooms-${jobId}`} placeholder="Room" value={quick.room} onChange={(e) => setQuick((q) => ({ ...q, room: e.target.value }))} />
            <datalist id={`panel-rooms-${jobId}`}>
              {rooms.map((r) => (
                <option key={r} value={r} />
              ))}
            </datalist>
          </label>
          <label>
            <span className="sr-only">Amps</span>
            <select
              className="h-11 w-full rounded-lg border border-slate-300 bg-white px-2 text-sm"
              value={quick.amps}
              onChange={(e) => setQuick((q) => ({ ...q, amps: e.target.value }))}
            >
              <option value="">Amps?</option>
              {AMP_SIZES.map((a) => (
                <option key={a} value={a}>
                  {a}A
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="sr-only">Poles</span>
            <select
              className="h-11 w-full rounded-lg border border-slate-300 bg-white px-2 text-sm"
              value={quick.poles}
              onChange={(e) => setQuick((q) => ({ ...q, poles: e.target.value }))}
            >
              <option value="1">1P</option>
              <option value="2">2P</option>
              <option value="3">3P</option>
            </select>
          </label>
        </div>
        <label className="mt-2 block">
          <span className="sr-only">What It Feeds</span>
          <Input className="h-11" placeholder="What It Feeds (Outlets Right)" value={feeds} onChange={(e) => setFeeds(e.target.value)} />
        </label>
        <div className="mt-2 grid grid-cols-[minmax(0,1fr)_auto] gap-2">
          <label>
            <span className="sr-only">Work</span>
            <select
              className="h-11 w-full rounded-lg border border-slate-300 bg-white px-2 text-sm"
              value={quick.work}
              onChange={(e) => setQuick((q) => ({ ...q, work: e.target.value as CircuitWork }))}
            >
              {(Object.keys(WORK_WORDS) as CircuitWork[]).map((w) => (
                <option key={w} value={w}>
                  {WORK_WORDS[w]}
                </option>
              ))}
            </select>
          </label>
          <Button type="submit" disabled={busy !== null}>
            {busy === "add" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Add Circuit
          </Button>
        </div>
      </form>

      {/* WHAT CAME OFF: Take Off and Not This are never the end of a circuit. A label check that was
          used or set aside is said as what it was, never drawn as a circuit someone took off. */}
      {takenOff.length + checksDone.length > 0 && (
        <section className={card} aria-label="Taken Off">
          <button type="button" onClick={() => setShowOff((v) => !v)} className="flex min-h-[44px] w-full items-center justify-between text-left text-sm font-semibold text-slate-700">
            <span>Taken Off Or Set Aside ({takenOff.length + checksDone.length})</span>
            {showOff ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </button>
          {showOff && (
            <ul className="divide-y divide-slate-100">
              {takenOff.map((c) => (
                <li key={c.id} className="flex items-center justify-between gap-2 py-1">
                  <span className="min-w-0 truncate text-sm text-slate-500">
                    {circuitLine(c)}
                    {c.state === "suggested" ? " · Set Aside" : ""}
                  </span>
                  <Button variant="outline" onClick={() => putBack(c)} disabled={busy !== null}>
                    Put Back
                  </Button>
                </li>
              ))}
              {checksDone.map((c) => {
                const about = circuits.find((x) => x.id === c.source_row?.flag_for) ?? null;
                const used = labelCheckApplied(about, c.source_row?.use);
                const name = about ? circuitName(about) : "A Circuit On Your List";
                return (
                  <li key={c.id} className="flex items-center justify-between gap-2 py-1">
                    <span className="min-w-0 text-sm text-slate-500">
                      <span className="block truncate">
                        {used ? "Label Check Used" : "Label Check Set Aside"}: {name}
                      </span>
                      {c.source_row?.check && <span className="block text-xs text-slate-400">{c.source_row.check}</span>}
                    </span>
                    {used ? (
                      <Button variant="outline" onClick={() => undoCheck(c)} disabled={busy !== null}>
                        {busy === `check:${c.id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Undo It
                      </Button>
                    ) : (
                      <Button variant="outline" onClick={() => putBack(c)} disabled={busy !== null}>
                        Put Back
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}

      {/* THE PRINTED LABELS (phase 5; the panel-first wave's Print door): for everyone, and Save As
          Circuit Map for the office. */}
      <JobPanelDirectory jobId={jobId} staff={staff} circuits={circuits} panel={activePanel} livePanels={livePanels} />

      {/* ADD NEW PANEL, LAST: the one door that makes a panel (a sub panel, a second box). A job's
          Panel 1 is made by the server with its first circuit, never here beside it. */}
      <Button variant="outline" className="w-full" onClick={() => setPanelSheet("new")} disabled={busy !== null}>
        <Plus className="h-4 w-4" /> Add New Panel
      </Button>

      {editingRow && (
        <CircuitEditSheet
          circuit={editingRow}
          panels={panels}
          people={initial.people}
          onSaved={(row) => upsert([row])}
          onClose={() => setEditing(null)}
          onKeep={(c) => keep([c.id], `Kept ${circuitName(c)}.`)}
          onNotThis={(c) => remove(c, "notThis")}
          onTakeOff={(c) => remove(c, "takeOff")}
          onMove={(c) => {
            setEditing(null);
            setMoving(c);
          }}
        />
      )}
      {filling && (
        <PanelLineSheet
          jobId={jobId}
          panel={shown}
          circuits={circuits}
          at={filling}
          livePanels={livePanels}
          rooms={rooms}
          onAdded={lineAdded}
          onClose={() => setFilling(null)}
        />
      )}
      {panelSheet && (
        <PanelSetupSheet
          jobId={jobId}
          panel={panelSheet === "new" ? null : panels.find((p) => p.id === panelSheet) ?? null}
          photos={initial.photos}
          takenNames={panels.filter((p) => p.id !== panelSheet).map((p) => p.name)}
          onSaved={(row, placed) => {
            panelSaved(row, placed);
            if (panelSheet === "new") {
              setActivePanelId(row.id);
              setPanelSheet(row.id);
            }
          }}
          onClose={() => setPanelSheet(null)}
        />
      )}
    </div>
  );
}
