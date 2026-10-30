"use client";

import { useMemo, useState } from "react";
import { FileText, Loader2, Printer, Tags } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/toast";
import { onDirectory } from "@/lib/panel/directory";
import { inchWords, panelGeometry } from "@/lib/panel/geometry";
import { circuitsOfPanel } from "@/lib/panel/held";
import { stripLines, type StripCircuit, type StripPanel } from "@/lib/panel/strip";
import { fitCheck, tightWords } from "@/lib/panel/fit";
import type { JobCircuit } from "@/lib/types";
import { saveCircuitMap, undoCircuitMap } from "../panel-portal-actions";

/** What the card counts and prints from: the tab's live circuits (the strips read their spaces). */
type PrintCircuit = Pick<JobCircuit, "state" | "removed_at" | "work"> & Partial<StripCircuit>;

const door =
  "inline-flex min-h-[44px] items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-4 text-sm font-medium text-slate-800 hover:bg-slate-50";

/**
 * THE PRINT CARD on the Panel tab (Panel plan, phase 5; ONE DOOR since the panel-first wave). Erik,
 * 10-30: "Panel Directory and Circuit Map will mold into one intuitive solution." So one card,
 * Print, with two things to print:
 *
 *   - Door Labels (everyone): the panel's two label strips at true size, side by side with one line
 *     to cut on (/print/panel-labels/<job>?panel=<id>). The line under it says the strip's width
 *     (the panel's own measurement, else the make's) and where to change it, and when a name can't
 *     fit at 6 pt it says so HERE, before anyone opens the page, so nobody prints blind. It opens in
 *     the same window, the way Print Business Cards does: a popup belongs to Safari in the installed
 *     app and its print dialog lands behind the app (the PDF viewer's note, 7/24); the labels page
 *     has its own Back.
 *   - Circuit Map (everyone): the door card and the circuit map (the map Erik built by hand for
 *     J-011), through the app's PDF viewer, exactly as before. Under it, the office's Save As
 *     Circuit Map: that same document filed in the job's Plans and put on the customer's Plans And
 *     Drawings in place of the older one; it says what it replaced, and Undo takes it back off.
 *
 * Both read the KEPT circuits only; with none kept there is nothing to print, and the card says so
 * instead of offering a door to an empty page.
 */
export function PanelDirectoryCard({
  jobId,
  staff,
  circuits,
  panel = null,
  livePanels = null,
  busy = false,
  onSave,
}: {
  jobId: string;
  staff: boolean;
  circuits: PrintCircuit[];
  /** The panel the tab shows: the labels print ITS strips at ITS width. Without one, the labels page
   *  prints the job's first panel and the card says nothing about a width it doesn't know. */
  panel?: StripPanel | null;
  /** How many live panels the job has: a loose circuit is on its only one (lib/panel/held), on the
   *  card exactly as on the labels page. */
  livePanels?: number | null;
  busy?: boolean;
  onSave?: () => void;
}) {
  const n = circuits.filter(onDirectory).length;
  const mapHref = `/print/pdf-preview?doc=panel&id=${jobId}&back=${encodeURIComponent(`/jobs/${jobId}?tab=panel`)}`;
  const labelsHref = `/print/panel-labels/${jobId}${panel ? `?panel=${encodeURIComponent(panel.id)}` : ""}`;

  // The strips this panel prints: their width, and whether every name fits (the labels page's sum),
  // from the circuits that are this panel's by the door's own rule.
  const labels = useMemo(() => {
    if (!panel) return null;
    const geo = panelGeometry(panel);
    const strips = stripLines(panel, circuitsOfPanel(panel, circuits as StripCircuit[], livePanels));
    const tight = fitCheck(strips.left, geo.labelWidthLeftIn).count + fitCheck(strips.right, geo.labelWidthRightIn).count;
    const worded = [...strips.left, ...strips.right].some((l) => l.text !== "");
    const width =
      geo.labelWidthRightIn === geo.labelWidthLeftIn
        ? `${inchWords(geo.labelWidthLeftIn)} in`
        : `${inchWords(geo.labelWidthLeftIn)} in left, ${inchWords(geo.labelWidthRightIn)} in right`;
    return { width, tight: tightWords(tight), worded };
  }, [panel, circuits, livePanels]);

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm" aria-label="Print">
      <h3 className="flex items-center gap-2 text-base font-semibold text-slate-900">
        <Printer className="h-4 w-4 text-[rgb(var(--glass-ink))]" /> Print
      </h3>
      {n === 0 ? (
        <p className="mt-0.5 text-sm text-slate-500">Keep circuits first. The labels and the circuit map print the kept ones.</p>
      ) : (
        <div className="mt-3 space-y-4">
          {/* DOOR LABELS: the strips, true size, cut on the line. */}
          <div data-print="labels">
            <a href={labelsHref} className={`${door} w-full`}>
              <Tags className="h-4 w-4" /> Door Labels
            </a>
            <p className="mt-1 text-xs text-slate-500">
              Two strips at true size, cut on the line.
              {labels ? ` Width ${labels.width}; change it under Edit Panel.` : ""}
            </p>
            {labels && !labels.worded && <p className="mt-1 text-xs text-slate-500">No kept circuit has a space on this panel yet, so the strips print blank.</p>}
            {labels?.tight && (
              <p className="mt-1 text-xs font-semibold text-amber-800" data-tight>
                {labels.tight}
              </p>
            )}
          </div>

          {/* CIRCUIT MAP: the door card and the map, and (the office) the saved document. */}
          <div data-print="map">
            <div className={`grid gap-2 ${staff ? "grid-cols-1 sm:grid-cols-2" : "grid-cols-1"}`}>
              <a href={mapHref} className={door}>
                <FileText className="h-4 w-4" /> Circuit Map
              </a>
              {staff && (
                <Button onClick={onSave} disabled={busy}>
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />} Save As Circuit Map
                </Button>
              )}
            </div>
            <p className="mt-1 text-xs text-slate-500">
              The door card and the circuit map, from the {n} kept circuit{n === 1 ? "" : "s"}. No prices, wire tags or notes are on it.
            </p>
            {staff && (
              <p className="mt-1 text-xs text-slate-500">Save As Circuit Map puts it on the customer&apos;s Plans And Drawings, in place of the older circuit map.</p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

/** The card with its Save door wired: the office's one tap, said out loud, with Undo. */
export function JobPanelDirectory({
  jobId,
  staff,
  circuits,
  panel = null,
  livePanels = null,
}: {
  jobId: string;
  staff: boolean;
  circuits: PrintCircuit[];
  /** The panel the tab shows (optional: without it the labels print the job's first panel). */
  panel?: StripPanel | null;
  /** How many live panels the job has (which loose circuits are this panel's). */
  livePanels?: number | null;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      const r = await saveCircuitMap(jobId);
      if (!r.ok) {
        toast(r.error, "error", undefined, r.documentId ? { sticky: true } : undefined);
        return;
      }
      toast(r.message, "success", {
        label: "Undo",
        onClick: async () => {
          const u = await undoCircuitMap(r.documentId).catch(() => null);
          if (!u) toast("That didn't undo. Check your connection and try again.", "error");
          else if (!u.ok) toast(u.error, "error");
          else toast(u.message, "success");
        },
      });
    } catch {
      toast("The circuit map didn't save. Check your connection and try again.", "error");
    } finally {
      setBusy(false);
    }
  }

  return <PanelDirectoryCard jobId={jobId} staff={staff} circuits={circuits} panel={panel} livePanels={livePanels} busy={busy} onSave={save} />;
}
