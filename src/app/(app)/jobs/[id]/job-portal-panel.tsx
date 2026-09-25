"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ChevronRight, Loader2, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/toast";
import { formatDate } from "@/lib/utils";
import { PanelDirectoryList } from "@/components/panel-directory";
import type { DirectoryPanel } from "@/lib/panel/directory";
import { loadPanelPortal, setPanelOnPortal, type CircuitMapShown, type PanelPortalLoad, type PanelPortalPanel } from "../panel-portal-actions";

/**
 * THE PANEL ON THE CUSTOMER'S PAGE, THE OFFICE'S SWITCH (Panel plan, phase 5). Office only: the
 * Customer Page tab renders for staff alone, and setPanelOnPortal is requireStaff (0333's guard
 * refuses anyone else too).
 *
 * One switch per job, "Show The Panel On Their Page", OFF until the office turns it on (Erik's
 * decision 2), so a half-finished rough-in list never shows up live by itself. Under it, exactly
 * what the customer reads, drawn by the same renderer and from the same safe shape as their page:
 * so the office never guesses what "on" will show. Turning it on or off says so and offers Undo.
 */
export type PanelCardViewProps = {
  who: string;
  jobId: string;
  panels: PanelPortalPanel[];
  preview: DirectoryPanel[];
  circuitMap: CircuitMapShown | null;
  busy: boolean;
  onFlip: (next: boolean) => void;
};

/** Everything on the card, render-only (the tests draw exactly what the office sees). */
export function PanelCardView({ who, jobId, panels, preview, circuitMap, busy, onFlip }: PanelCardViewProps) {
  const on = panels.length > 0 && panels.every((p) => p.shown);
  const partly = !on && panels.some((p) => p.shown);
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm" data-panel-card>
      <h3 className="flex items-center gap-2 text-base font-semibold text-slate-900">
        <Zap className="h-4 w-4 text-[rgb(var(--glass-ink))]" /> Panel
      </h3>
      {panels.length === 0 ? (
        <>
          <p className="mt-1 text-sm text-slate-600">This job has no panel yet. Add it on the Panel tab first, then it can go on {who}&apos;s page.</p>
          <Link href={`/jobs/${jobId}?tab=panel`} className="mt-2 inline-flex min-h-[44px] items-center gap-1 text-sm font-semibold text-brand">
            Go To Panel <ChevronRight className="h-4 w-4" />
          </Link>
        </>
      ) : (
        <>
          <button
            type="button"
            role="switch"
            aria-checked={on}
            onClick={() => onFlip(!on)}
            disabled={busy}
            className="mt-2 flex min-h-[44px] w-full items-center justify-between gap-3 rounded-lg px-1 text-left text-sm font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-60"
          >
            <span>Show The Panel On Their Page</span>
            {busy ? (
              <Loader2 className="h-5 w-5 animate-spin text-slate-500" />
            ) : (
              <span className={`relative block h-6 w-11 shrink-0 rounded-full transition-colors ${on ? "bg-brand" : "bg-slate-300"}`}>
                <span className={`absolute top-0.5 block h-5 w-5 rounded-full bg-white shadow transition-all ${on ? "left-[22px]" : "left-0.5"}`} />
              </span>
            )}
          </button>
          <p className="mt-1 px-1 text-sm text-slate-600">
            {on
              ? `${who} sees this list on their page, live: what the office or crew keeps shows on their next look.`
              : partly
                ? `Only part of the panel is on ${who}'s page (a panel added later starts off). Turn the switch on to show all of it.`
                : `${who} doesn't see the panel. Turn it on when the list is ready.`}{" "}
            Never shown: part numbers, suppliers, prices, wire tags, notes, progress, or suggestions nobody kept.
          </p>
          <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">{on ? `What ${who} Sees` : `What ${who} Would See`}</div>
            <div className="space-y-4">
              {preview.map((p, i) => (
                <PanelDirectoryList key={`${p.name}-${i}`} panel={p} />
              ))}
            </div>
          </div>
        </>
      )}
      <p className="mt-3 px-1 text-sm text-slate-600">
        {circuitMap
          ? `On their Plans And Drawings: "${circuitMap.title}", shown ${formatDate(circuitMap.sharedAt)}. Save As Circuit Map on the Panel tab puts a newer one in its place.`
          : "No circuit map on their page yet. Save As Circuit Map on the Panel tab puts the printed directory there."}
      </p>
    </div>
  );
}

export function JobPortalPanel({ jobId, who }: { jobId: string; who: string }) {
  const toast = useToast();
  const [state, setState] = useState<PanelPortalLoad | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    loadPanelPortal(jobId)
      .then(setState)
      .catch(() => setState({ ok: false, error: "The panel couldn't load. Check your connection and open the tab again." }));
  }, [jobId]);
  useEffect(load, [load]);

  const flip = useCallback(
    async (next: boolean, undoing = false) => {
      setBusy(true);
      try {
        const r = await setPanelOnPortal(jobId, next);
        if (!r.ok) {
          toast(r.error, "error");
          return;
        }
        setState((s) => (s && s.ok ? { ...s, panels: r.panels } : s));
        if (undoing) {
          toast(next ? `The panel is back on ${who}'s page.` : `The panel is off ${who}'s page again.`, "success");
          return;
        }
        toast(next ? `The panel is on ${who}'s page now.` : `The panel is off ${who}'s page.`, "success", {
          label: "Undo",
          onClick: () => void flip(!next, true),
        });
      } catch {
        toast("That didn't save. Check your connection and try again.", "error");
      } finally {
        setBusy(false);
      }
    },
    [jobId, toast, who],
  );

  if (!state) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-4 text-sm text-slate-500">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading the panel…
      </div>
    );
  }
  if (!state.ok) {
    return (
      <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
        <p>{state.error}</p>
        <Button variant="outline" className="mt-2" onClick={() => { setState(null); load(); }}>
          Try Again
        </Button>
      </div>
    );
  }
  return <PanelCardView who={who} jobId={jobId} panels={state.panels} preview={state.preview} circuitMap={state.circuitMap} busy={busy} onFlip={(n) => void flip(n)} />;
}
