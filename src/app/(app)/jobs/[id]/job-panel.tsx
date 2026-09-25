"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Check, ChevronDown, ChevronRight, LayoutGrid, List, Loader2, Pencil, Plus, ShieldCheck, Sparkles, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/toast";
import { cn } from "@/lib/utils";
import { AMP_SIZES } from "@/lib/panel/input";
import {
  PROGRESS_WORDS,
  WORK_WORDS,
  circuitLine,
  circuitName,
  doorRows,
  groupByRoom,
  labelDiffers,
  nextProgress,
  spaceMap,
  titleWords,
} from "@/lib/panel/model";
import type { CircuitWork, JobCircuit, JobPanel } from "@/lib/types";
import {
  addCircuit,
  advanceProgress,
  bringInEstimateCircuits,
  dismissSuggestion,
  keepSuggestions,
  saveCircuit,
  setAsideSuggestions,
  takeOffCircuit,
  undoTakeOff,
  type PanelLoad,
} from "../panel-actions";
import { CircuitEditSheet } from "./circuit-edit-sheet";
import { JobPanelBreakers } from "./job-panel-breakers";
import { PanelSetupSheet } from "./panel-setup-sheet";

/**
 * THE PANEL TAB (Panel plan, phase 2; Erik 2026-09-25: "instead of a .pdf it can just be there").
 *
 * The job's own circuit list, worked by the crew at the panel and by the office at the desk: the
 * estimate's take-off comes in as suggestions (the office's Bring In), a person keeps, changes or
 * sets each aside, adds the rest with Add A Circuit, taps the chip from Planned to Roughed to Done,
 * and, once spaces are filled in, flips to Positions to see the door as it hangs.
 *
 * Laws on this screen: nothing counts until kept (suggestions are dimmed and named by where they came
 * from); no Save button (each change is written as it is made, and Take Off, Not This, Keep and the
 * chip all carry Undo); nothing silent (every write's answer is shown); 44px targets and nothing
 * wider than a 375px phone; every clickable in Title Case.
 */

export type PanelData = Extract<PanelLoad, { ok: true }>;

const QUICK_KEY = (jobId: string) => `cn-panel-quick-add:${jobId}`;
type Quick = { room: string; amps: string; poles: string; work: CircuitWork };
const QUICK_DEFAULT: Quick = { room: "", amps: "20", poles: "1", work: "new" };

function readQuick(jobId: string): Quick {
  try {
    const raw = typeof window !== "undefined" ? window.localStorage.getItem(QUICK_KEY(jobId)) : null;
    if (!raw) return QUICK_DEFAULT;
    const v = JSON.parse(raw) as Partial<Quick>;
    return { ...QUICK_DEFAULT, ...v, work: (["new", "existing", "reused", "removed"] as CircuitWork[]).includes(v.work as CircuitWork) ? (v.work as CircuitWork) : "new" };
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
  const [view, setView] = useState<"list" | "positions">("list");
  const [editing, setEditing] = useState<string | null>(null);
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

  const live = circuits.filter((c) => !c.removed_at);
  const suggested = live.filter((c) => c.state === "suggested").sort((a, b) => a.sort_order - b.sort_order);
  const kept = live.filter((c) => c.state === "kept");
  const takenOff = circuits.filter((c) => c.removed_at);
  const activePanel = panels.find((p) => p.id === activePanelId) ?? null;
  const placedHere = activePanel ? kept.filter((c) => c.panel_id === activePanel.id && c.space != null) : [];
  const groups = useMemo(() => groupByRoom(kept), [kept]);
  const rooms = useMemo(() => [...new Set(kept.map((c) => titleWords(c.room)).filter(Boolean))].sort(), [kept]);
  const editingRow = circuits.find((c) => c.id === editing) ?? null;
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
    upsert([r.row]);
    setQuick(q);
    writeQuick(jobId, q);
    setFeeds("");
    toast(`Added ${circuitLine(r.row)}.`, "success", {
      label: "Undo",
      onClick: async () => {
        const u = await run(`rm:${r.row.id}`, () => takeOffCircuit(r.row.id));
        if (u && u.ok) upsert([u.row]);
      },
    });
  }

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

      {/* SUGGESTIONS: dimmed, named by where they came from, and counted by nothing until kept. */}
      {suggested.length > 0 && (
        <section className={card} aria-label="Suggestions">
          <h3 className="text-base font-semibold text-slate-900">Suggestions</h3>
          <p className="mt-0.5 text-sm text-slate-500">Nothing counts until you keep it.</p>
          <ul className="mt-3 space-y-2">
            {suggested.map((c) => (
              <li key={c.id} className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-3">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-slate-500">
                  <span className="font-medium text-slate-600">{circuitLine(c)}</span>
                  {c.source_row?.quote_number && (
                    <span className="rounded-full bg-white px-2 py-0.5 text-[11px] font-semibold text-slate-500 ring-1 ring-slate-200">
                      From {c.source_row.quote_number}
                    </span>
                  )}
                </div>
                {c.source_row?.load && <div className="mt-0.5 text-xs text-slate-400">{c.source_row.load}</div>}
                {c.source_row?.check && (
                  <div className="mt-1 flex items-start gap-1 text-xs font-medium text-amber-800">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {c.source_row.check}
                  </div>
                )}
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
              </li>
            ))}
          </ul>
          {suggested.length > 1 && (
            <Button className="mt-3 w-full" onClick={() => keep(suggested.map((c) => c.id), `Kept ${suggested.length} circuits.`)} disabled={busy !== null}>
              <Check className="h-4 w-4" /> Keep All ({suggested.length})
            </Button>
          )}
        </section>
      )}

      {/* THE PANEL: the box itself, and the switch to see its door. */}
      <section className={card} aria-label="The Panel">
        {panels.length === 0 ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <h3 className="flex items-center gap-2 text-base font-semibold text-slate-900">
                <Zap className="h-4 w-4 text-[rgb(var(--glass-ink))]" /> No Panel Yet
              </h3>
              <p className="mt-0.5 text-sm text-slate-500">Add it to set spaces and see the door. Circuits can go on the list first.</p>
            </div>
            <Button variant="outline" onClick={() => setPanelSheet("new")}>
              <Plus className="h-4 w-4" /> Add The Panel
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            {panels.length > 1 && (
              <div className="flex flex-wrap gap-2" role="tablist" aria-label="Panels">
                {panels.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    role="tab"
                    aria-selected={p.id === activePanelId}
                    onClick={() => setActivePanelId(p.id)}
                    className={cn(
                      "min-h-[44px] rounded-lg border px-3 text-sm font-medium",
                      p.id === activePanelId ? "border-[rgb(var(--glass-ink))] bg-[rgb(var(--glass-tint))]/20 text-[rgb(var(--glass-ink))]" : "border-slate-300 text-slate-700",
                    )}
                  >
                    {p.name}
                  </button>
                ))}
              </div>
            )}
            {activePanel && (
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="flex items-center gap-2 text-base font-semibold text-slate-900">
                    <Zap className="h-4 w-4 text-[rgb(var(--glass-ink))]" /> {activePanel.name}
                  </h3>
                  <p className="mt-0.5 text-sm text-slate-500">
                    {[
                      activePanel.brand,
                      activePanel.main_amps ? `${activePanel.main_amps}A Main` : null,
                      activePanel.spaces ? `${activePanel.spaces} Spaces` : "Spaces Not Set",
                      activePanel.numbering === "bottom_up" ? "Space 1 At The Bottom" : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" onClick={() => setPanelSheet(activePanel.id)}>
                    <Pencil className="h-4 w-4" /> Edit Panel
                  </Button>
                  <Button variant="ghost" onClick={() => setPanelSheet("new")}>
                    <Plus className="h-4 w-4" /> Add Another Panel
                  </Button>
                </div>
              </div>
            )}
            {placedHere.length > 0 && (
              <div className="grid grid-cols-2 gap-1 rounded-lg bg-slate-100 p-1" role="tablist" aria-label="View">
                {(
                  [
                    ["list", "List", List],
                    ["positions", "Positions", LayoutGrid],
                  ] as const
                ).map(([id, label, Icon]) => (
                  <button
                    key={id}
                    type="button"
                    role="tab"
                    aria-selected={view === id}
                    onClick={() => setView(id)}
                    className={cn(
                      "flex min-h-[44px] items-center justify-center gap-2 rounded-md text-sm font-medium",
                      view === id ? "bg-white text-slate-900 shadow-sm" : "text-slate-500",
                    )}
                  >
                    <Icon className="h-4 w-4" /> {label}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </section>

      {view === "positions" && activePanel && placedHere.length > 0 ? (
        <PanelDoor panel={activePanel} circuits={kept} onOpen={(id) => setEditing(id)} />
      ) : (
        <section className={card} aria-label="Circuits">
          <h3 className="text-base font-semibold text-slate-900">
            Circuits <span className="text-sm font-normal text-slate-500">· {kept.length}</span>
          </h3>
          {kept.length === 0 ? (
            <p className="mt-2 text-sm text-slate-500">
              {suggested.length ? "Keep the suggestions above, or add circuits below." : "No circuits yet. Add them below as you walk the panel."}
            </p>
          ) : (
            <div className="mt-2 divide-y divide-slate-100">
              {groups.map((g) => (
                <div key={g.room} className="py-2">
                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                    {g.room} · {g.circuits.length}
                  </div>
                  <ul>
                    {g.circuits.map((c) => (
                      <li key={c.id} className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => setEditing(c.id)}
                          className="flex min-h-[44px] min-w-0 flex-1 flex-col items-start justify-center py-1 text-left"
                        >
                          <span className="line-clamp-2 w-full break-words text-sm font-medium text-slate-900">{circuitLine(c)}</span>
                          <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-slate-500">
                            <span className={cn("font-semibold", c.work === "new" ? "text-[rgb(var(--glass-ink))]" : "text-slate-500")}>{WORK_WORDS[c.work]}</span>
                            {c.space != null && (
                              <span>
                                Space {c.space}
                                {c.half ?? ""}
                                {c.poles > 1 ? `-${c.space + 2 * (c.poles - 1)}${c.half ?? ""}` : ""}
                              </span>
                            )}
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
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* ADD A CIRCUIT: remembers the room, amps, poles and work you used last, so sixteen twenties go
          in as sixteen lines of "what it feeds" and a tap. */}
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

      {/* THE BREAKERS CARD (phase 3): what the new circuits need against what came on the tickets.
          It reads the live list, so a Keep or a Take Off changes the count at once. */}
      <JobPanelBreakers jobId={jobId} circuits={circuits} panel={activePanel} onRows={upsert} onAddPanel={() => setPanelSheet("new")} />

      {/* WHAT CAME OFF: Take Off and Not This are never the end of a circuit. */}
      {takenOff.length > 0 && (
        <section className={card} aria-label="Taken Off">
          <button type="button" onClick={() => setShowOff((v) => !v)} className="flex min-h-[44px] w-full items-center justify-between text-left text-sm font-semibold text-slate-700">
            <span>Taken Off Or Set Aside ({takenOff.length})</span>
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
            </ul>
          )}
        </section>
      )}

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
        />
      )}
      {panelSheet && (
        <PanelSetupSheet
          jobId={jobId}
          panel={panelSheet === "new" ? null : panels.find((p) => p.id === panelSheet) ?? null}
          photos={initial.photos}
          takenNames={panels.filter((p) => p.id !== panelSheet).map((p) => p.name)}
          onSaved={(row, placed) => {
            setPanels((ps) => (ps.some((p) => p.id === row.id) ? ps.map((p) => (p.id === row.id ? row : p)) : [...ps, row]));
            // The first panel took the circuits already on the list: the door shows them now.
            if (placed?.adopted.length) upsert(placed.adopted);
            if (placed?.notAdopted.length) {
              toast(`${placed.notAdopted.length} couldn't go on ${row.name}. ${placed.notAdopted.join(" ")}`, "info", undefined, { sticky: true });
            }
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

/**
 * THE DOOR AS IT HANGS: odd spaces down the left, even down the right, top of the box first (flipped
 * when the numbers run bottom up). A twin splits its space A/B; a 2P shows on both its spaces; a No
 * Stab space is grey. Warnings (two on one space, a tandem the label doesn't allow) are said above
 * it, in plain words; they never stop anything.
 */
export function PanelDoor({ panel, circuits, onOpen }: { panel: JobPanel; circuits: JobCircuit[]; onOpen: (id: string) => void }) {
  const map = spaceMap(panel, circuits);
  const byId = new Map(circuits.map((c) => [c.id, c]));
  const used = [...map.cells.keys()];
  const rows = doorRows(panel, used);
  const dead = new Set(panel.dead_spaces ?? []);

  const cell = (space: number, side: "left" | "right") => {
    const k = map.cells.get(space);
    const numCls = cn("w-6 shrink-0 text-center font-mono text-[11px] text-slate-400", side === "right" && "order-last");
    if (dead.has(space) && !k) {
      return (
        <div className="flex min-h-[44px] items-center gap-1 rounded-md bg-slate-200 px-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          <span className={numCls}>{space}</span>
          <span className="flex-1 text-center">No Stab</span>
        </div>
      );
    }
    const occupant = (id: string, half: string | null) => {
      const c = byId.get(id);
      if (!c) return null;
      const first = c.space === space;
      return (
        <button
          key={`${id}:${half ?? "full"}`}
          type="button"
          onClick={() => onOpen(id)}
          className="flex min-h-[44px] w-full min-w-0 flex-col justify-center rounded px-1 text-left hover:bg-slate-50"
        >
          <span className="line-clamp-2 w-full break-words text-xs font-medium text-slate-800">
            {half ? `${half} · ` : ""}
            {circuitName(c)}
          </span>
          <span className="text-[10px] text-slate-500">
            {c.amps ? `${c.amps}A` : "?A"} · {c.poles}P{c.poles > 1 ? (first ? ` · With ${space + 2}` : ` · With ${c.space}`) : ""}
          </span>
        </button>
      );
    };
    const halves = k && (k.A.length || k.B.length) && !k.full.length;
    return (
      <div className={cn("flex min-h-[44px] items-center gap-1 rounded-md border px-1", k ? "border-slate-200 bg-white" : "border-dashed border-slate-200 bg-slate-50", dead.has(space) && "border-red-300")}>
        <span className={numCls}>{space}</span>
        <div className="min-w-0 flex-1">
          {!k ? (
            <span className="block text-center text-[11px] text-slate-400">Empty</span>
          ) : halves ? (
            <div className="divide-y divide-slate-100">
              {k.A.map((id) => occupant(id, "A"))}
              {k.B.map((id) => occupant(id, "B"))}
            </div>
          ) : (
            [...k.full, ...k.A, ...k.B].map((id) => occupant(id, null))
          )}
        </div>
      </div>
    );
  };

  return (
    <section className={card} aria-label="Positions">
      <h3 className="text-base font-semibold text-slate-900">{panel.name}: The Door</h3>
      {panel.spaces == null && <p className="mt-1 text-sm text-slate-500">Set the number of spaces on Edit Panel to see the whole door.</p>}
      {map.warnings.length > 0 && (
        <ul className="mt-2 space-y-1">
          {map.warnings.map((w, i) => (
            <li key={i} className="flex items-start gap-1.5 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {w.message}
            </li>
          ))}
        </ul>
      )}
      <div className="mt-3 space-y-1">
        {rows.map((r) => (
          <div key={r.left} className="grid grid-cols-2 gap-1">
            {cell(r.left, "left")}
            {cell(r.right, "right")}
          </div>
        ))}
      </div>
    </section>
  );
}
