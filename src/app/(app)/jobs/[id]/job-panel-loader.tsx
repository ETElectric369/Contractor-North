"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { loadJobPanel, type PanelLoad } from "../panel-actions";
import { JobPanel } from "./job-panel";

/**
 * THE PANEL TAB'S LOADER (the JobCustomerPage pattern): the tab's data is read by a server action
 * when the tab opens, so the job hub pays nothing for it until someone looks, and a failed read says
 * so with a Try Again instead of taking the page down. The estimate finder runs only in an office
 * session (loadJobPanel decides on the server), so a tech's page never carries it.
 */
export function JobPanelLoader({ jobId }: { jobId: string }) {
  const [state, setState] = useState<PanelLoad | null>(null);
  const load = useCallback(() => {
    setState(null);
    loadJobPanel(jobId)
      .then(setState)
      .catch(() => setState({ ok: false, error: "The panel couldn't load. Check your connection and try again." }));
  }, [jobId]);
  useEffect(load, [load]);

  if (!state) {
    return (
      <div className="flex items-center gap-2 px-1 py-8 text-sm text-slate-500">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading the panel…
      </div>
    );
  }
  if (!state.ok) {
    return (
      <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
        <p>{state.error}</p>
        <Button variant="outline" className="mt-2" onClick={load}>
          Try Again
        </Button>
      </div>
    );
  }
  return <JobPanel jobId={jobId} initial={state} />;
}
