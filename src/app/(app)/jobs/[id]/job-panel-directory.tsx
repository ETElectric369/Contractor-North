"use client";

import { useState } from "react";
import { FileText, Loader2, Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/toast";
import { onDirectory } from "@/lib/panel/directory";
import type { JobCircuit } from "@/lib/types";
import { saveCircuitMap, undoCircuitMap } from "../panel-portal-actions";

/**
 * THE PANEL DIRECTORY CARD on the Panel tab (Panel plan, phase 5).
 *
 *   - Print Panel Directory (everyone): the door card, one page per panel with circuits in spaces,
 *     and the circuit map (the content of the map Erik built by hand for J-011), through the app's
 *     PDF viewer. The crew prints it at the panel; the office for the inspector.
 *   - Save As Circuit Map (the office): that same printed directory, filed in the job's Plans and
 *     put on the customer's Plans And Drawings as a Circuit Map in place of the older one. Says what
 *     it replaced, and Undo takes it back off their page (the older map shows again).
 *
 * Both read the KEPT circuits only; with none kept there is nothing to print, and the card says so
 * instead of offering a door to an empty page.
 */
export function PanelDirectoryCard({
  jobId,
  staff,
  circuits,
  busy = false,
  onSave,
}: {
  jobId: string;
  staff: boolean;
  circuits: Pick<JobCircuit, "state" | "removed_at" | "work">[];
  busy?: boolean;
  onSave?: () => void;
}) {
  const n = circuits.filter(onDirectory).length;
  const href = `/print/pdf-preview?doc=panel&id=${jobId}&back=${encodeURIComponent(`/jobs/${jobId}?tab=panel`)}`;
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm" aria-label="Panel Directory">
      <h3 className="flex items-center gap-2 text-base font-semibold text-slate-900">
        <FileText className="h-4 w-4 text-[rgb(var(--glass-ink))]" /> Panel Directory
      </h3>
      <p className="mt-0.5 text-sm text-slate-500">
        {n === 0
          ? "Keep circuits first. The directory prints the kept ones."
          : `The door card and the circuit map, from the ${n} kept circuit${n === 1 ? "" : "s"}. No prices, wire tags or notes are on it.`}
      </p>
      {n > 0 && (
        <div className={`mt-3 grid gap-2 ${staff ? "grid-cols-1 sm:grid-cols-2" : "grid-cols-1"}`}>
          <a
            href={href}
            className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-4 text-sm font-medium text-slate-800 hover:bg-slate-50"
          >
            <Printer className="h-4 w-4" /> Print Panel Directory
          </a>
          {staff && (
            <Button onClick={onSave} disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />} Save As Circuit Map
            </Button>
          )}
        </div>
      )}
      {staff && n > 0 && (
        <p className="mt-2 text-xs text-slate-500">Save As Circuit Map puts it on the customer&apos;s Plans And Drawings, in place of the older circuit map.</p>
      )}
    </section>
  );
}

/** The card with its Save door wired: the office's one tap, said out loud, with Undo. */
export function JobPanelDirectory({ jobId, staff, circuits }: { jobId: string; staff: boolean; circuits: Pick<JobCircuit, "state" | "removed_at" | "work">[] }) {
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

  return <PanelDirectoryCard jobId={jobId} staff={staff} circuits={circuits} busy={busy} onSave={save} />;
}
