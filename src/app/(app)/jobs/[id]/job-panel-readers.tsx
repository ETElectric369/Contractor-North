"use client";

import { useMemo, useState } from "react";
import { AlertTriangle, Camera, FileText, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/toast";
import { formatDate } from "@/lib/utils";
import { PHOTO_READS_PER_JOB_PER_DAY, headerSuggestions, type HeaderSaid, type HeaderSuggestion } from "@/lib/panel/readers";
import type { JobCircuit, JobPanel } from "@/lib/types";
import { readPanelPhoto, readPlanCircuits, savePanel } from "../panel-actions";

/**
 * THE READERS (Panel plan, phase 4): Read The Panel Photo (the crew and the office) and Read
 * Circuits From The Plans (the office). A read writes SUGGESTIONS only; they land in the Suggestions
 * card above, dimmed and named by where they came from, and count for nothing until a person keeps
 * them. What a read says about the panel itself (brand, main, spaces, No Stab), and what the
 * walk-through said, shows here with a Use beside each line: nothing is written by being read.
 *
 * Nothing silent: the cap (three photo reads per job per day) and the cost (a few cents a read) are
 * said before the tap, every refusal is said in plain words, and what a reader couldn't read is
 * listed, never dropped. 44px targets, 375px wide, Title Case on every clickable.
 */

type Paper = { id: string; name: string | null; created_at: string };
type Result = { from: string; message: string; notes: string[]; header: HeaderSuggestion[] };

const card = "rounded-xl border border-slate-200 bg-white p-4 shadow-sm";
const select = "h-11 w-full min-w-0 rounded-lg border border-slate-300 bg-white px-2 text-sm";

const FIELD_WORDS: Record<HeaderSuggestion["field"], string> = { brand: "Brand", main_amps: "Main", spaces: "Spaces", dead_spaces: "No Stab Spaces" };

export function PanelReaders({
  jobId,
  staff,
  photos,
  plans,
  panel,
  walkthrough,
  onRows,
  onPanel,
}: {
  jobId: string;
  staff: boolean;
  photos: Paper[];
  plans: (Paper & { onCustomer: boolean })[];
  panel: JobPanel | null;
  walkthrough: { said: HeaderSaid; words: string | null } | null;
  onRows: (rows: JobCircuit[]) => void;
  onPanel: (row: JobPanel, placed?: { adopted: JobCircuit[]; notAdopted: string[] }) => void;
}) {
  const toast = useToast();
  const [photoId, setPhotoId] = useState<string>(panel?.photo_document_id ?? photos[0]?.id ?? "");
  const [planId, setPlanId] = useState<string>(plans[0]?.id ?? "");
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);

  // The walk-through's suggestions are worked out against the panel as it is now, so each one goes
  // away by itself once the panel says the same.
  const fromWalk = useMemo(() => (walkthrough ? headerSuggestions(panel, walkthrough.said, "The Walk-Through") : []), [walkthrough, panel]);
  const fromRead = useMemo(() => {
    if (!result) return [];
    return headerSuggestions(panel, Object.fromEntries(result.header.map((h) => [h.field, h.value])) as HeaderSaid, result.from);
  }, [result, panel]);
  const header = [...fromRead, ...fromWalk];

  async function read(kind: "photo" | "plan") {
    const id = kind === "photo" ? photoId : planId;
    if (!id) return;
    setBusy(kind);
    try {
      const r = kind === "photo" ? await readPanelPhoto(jobId, id, panel?.id ?? null) : await readPlanCircuits(jobId, id);
      if (!r.ok) {
        toast(r.error, "error", undefined, { sticky: true });
        return;
      }
      onRows(r.rows);
      setResult({ from: kind === "photo" ? "The Panel Photo" : "The Plans", message: r.message, notes: r.notes, header: r.header });
      toast(r.message, r.rows.length ? "success" : "info");
    } catch {
      toast("The read didn't finish. Check your connection and try again; nothing was added.", "error");
    } finally {
      setBusy(null);
    }
  }

  async function applyHeader(h: HeaderSuggestion) {
    if (!panel) return;
    const was = panel[h.field];
    setBusy(`use:${h.field}`);
    try {
      const r = await savePanel(jobId, panel.id, { [h.field]: h.value }, { [h.field]: was });
      if (!r.ok) {
        toast(r.error, "error");
        if (r.current) onPanel(r.current);
        return;
      }
      onPanel(r.row);
      toast(`${FIELD_WORDS[h.field]} set from ${h.from}.`, "success", {
        label: "Undo",
        onClick: async () => {
          const u = await savePanel(jobId, panel.id, { [h.field]: was }, { [h.field]: r.row[h.field] });
          if (u.ok) onPanel(u.row);
          else toast(u.error, "error");
        },
      });
    } catch {
      toast("That didn't save. Check your connection and try again.", "error");
    } finally {
      setBusy(null);
    }
  }

  /** No panel yet: one tap adds it with what was read. */
  async function addWith(list: HeaderSuggestion[]) {
    setBusy("add-panel");
    try {
      const patch: Record<string, unknown> = { name: "Main Panel" };
      for (const h of list) if (!(h.field in patch)) patch[h.field] = h.value;
      const r = await savePanel(jobId, null, patch);
      if (!r.ok) {
        toast(r.error, "error");
        return;
      }
      onPanel(r.row, r);
      toast(`Added ${r.row.name}. Change anything on Edit Panel.`, "success");
    } catch {
      toast("That didn't save. Check your connection and try again.", "error");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className={card} aria-label="Read The Panel">
      <h3 className="text-base font-semibold text-slate-900">Read It For Me</h3>
      <p className="mt-0.5 text-sm text-slate-500">
        What it reads comes in as suggestions. Nothing counts until you keep it.
      </p>

      {/* READ THE PANEL PHOTO: the crew and the office. */}
      <div className="mt-3 space-y-2">
        {photos.length === 0 ? (
          <p className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">
            Take a photo of the panel door on the Photos tab first, then read it here.
          </p>
        ) : (
          <>
            <label className="block">
              <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">Panel Photo</span>
              <select className={select} value={photoId} onChange={(e) => setPhotoId(e.target.value)} disabled={busy !== null}>
                {photos.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.id === panel?.photo_document_id ? "The Panel's Photo · " : ""}
                    {p.name || "Photo"} · {formatDate(p.created_at)}
                  </option>
                ))}
              </select>
            </label>
            <Button className="w-full" onClick={() => read("photo")} disabled={busy !== null || !photoId}>
              {busy === "photo" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Camera className="h-4 w-4" />} Read The Panel Photo
            </Button>
            <p className="text-xs text-slate-500">
              Up to {PHOTO_READS_PER_JOB_PER_DAY} reads a day on this job, a few cents each. A straight, close photo of the door&apos;s list reads best.
            </p>
          </>
        )}
      </div>

      {/* READ CIRCUITS FROM THE PLANS: the office only (a tech's page never carries the list). */}
      {staff && (
        <div className="mt-4 space-y-2 border-t border-slate-100 pt-3">
          {plans.length === 0 ? (
            <p className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">
              No plans on this job or its customer yet. Add them on the Customer Page tab, or with Upload Plans on the estimate.
            </p>
          ) : (
            <>
              <label className="block">
                <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">Plans</span>
                <select className={select} value={planId} onChange={(e) => setPlanId(e.target.value)} disabled={busy !== null}>
                  {plans.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name || "Plans"} · {formatDate(p.created_at)}
                      {p.onCustomer ? " · On The Customer" : ""}
                    </option>
                  ))}
                </select>
              </label>
              <Button variant="outline" className="w-full" onClick={() => read("plan")} disabled={busy !== null || !planId}>
                {busy === "plan" ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />} Read Circuits From The Plans
              </Button>
              <p className="text-xs text-slate-500">Reads the panel schedules and electrical sheets. A sheet it can&apos;t count is named, never skipped quietly.</p>
            </>
          )}
        </div>
      )}

      {/* WHAT THE LAST READ SAID, and what it couldn't read. */}
      {result && (
        <div role="status" className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
          <div className="flex items-start justify-between gap-2">
            <p className="min-w-0">{result.message}</p>
            <button type="button" onClick={() => setResult(null)} aria-label="Close" className="-m-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100">
              <X className="h-4 w-4" />
            </button>
          </div>
          {result.notes.length > 0 && (
            <ul className="mt-2 space-y-1">
              {result.notes.map((n, i) => (
                <li key={i} className="flex items-start gap-1.5 text-xs font-medium text-amber-800">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {n}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* THE PANEL ITSELF: what a read or the walk-through said that the panel doesn't say yet. */}
      {header.length > 0 && (
        <div className="mt-4 border-t border-slate-100 pt-3">
          <h4 className="text-sm font-semibold text-slate-900">About The Panel</h4>
          {walkthrough?.words && fromWalk.length > 0 && (
            <p className="mt-1 text-xs text-slate-500">The walk-through said: &ldquo;{walkthrough.words}&rdquo;</p>
          )}
          <ul className="mt-2 space-y-2">
            {header.map((h) => (
              <li key={`${h.from}:${h.field}`} className="flex items-center justify-between gap-2">
                <span className="min-w-0 text-sm text-slate-700">
                  {h.words}
                  <span className="block text-[11px] text-slate-500">From {h.from}</span>
                </span>
                {panel && (
                  <Button variant="outline" onClick={() => applyHeader(h)} disabled={busy !== null}>
                    {busy === `use:${h.field}` ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Use
                  </Button>
                )}
              </li>
            ))}
          </ul>
          {!panel && (
            <Button className="mt-3 w-full" onClick={() => addWith(header)} disabled={busy !== null}>
              {busy === "add-panel" ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Add The Panel With These
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
