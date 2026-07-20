"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ChevronDown } from "lucide-react";
import { Card } from "@/components/ui/card";
import { JobRow, type JobRowData } from "./job-row";

/** Per-session memory of the expand state — a mis-tap away from losing your place
 *  otherwise. sessionStorage (not local): a fresh visit starts collapsed again. */
const OPEN_KEY = "jobs.completed.open";

/**
 * The default /jobs view's "Completed" shelf (owner spec 2026-07-20): finished jobs
 * don't hide behind a link anymore — they sit collapsed at the BOTTOM of the list
 * under a count + chevron header, each row wearing its billing tag (To Be Invoiced /
 * Pending / Partial / Paid In Full — derived server-side by jobBillingStatus, the
 * AR-shared SSOT). `total` may exceed rows.length — the list is capped newest-first
 * and says so honestly.
 */
export function CompletedJobsSection({ jobs, total }: { jobs: JobRowData[]; total: number }) {
  const [open, setOpen] = useState(false);

  // Collapsed on the server render; re-open after mount if this session left it open.
  useEffect(() => {
    try {
      if (sessionStorage.getItem(OPEN_KEY) === "1") setOpen(true);
    } catch {
      /* storage blocked — stateless toggle still works */
    }
  }, []);

  const toggle = () =>
    setOpen((o) => {
      const next = !o;
      try {
        sessionStorage.setItem(OPEN_KEY, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });

  if (jobs.length === 0) return null;

  return (
    <Card className="mt-4 overflow-hidden">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-5 py-3 text-left hover:bg-slate-50"
      >
        <span className="text-sm font-semibold text-slate-700">Completed</span>
        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-500">{total}</span>
        <ChevronDown
          className={`ml-auto h-4 w-4 text-slate-400 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && (
        <>
          <ul className="divide-y divide-slate-100 border-t border-slate-100">
            {jobs.map((j) => (
              <JobRow key={j.id} job={j} hideStatus />
            ))}
          </ul>
          {total > jobs.length && (
            <p className="border-t border-slate-100 px-5 py-2 text-center text-xs text-slate-400">
              Showing the latest {jobs.length} of {total} —{" "}
              <Link href="/jobs?status=complete" className="text-brand hover:underline">
                view all completed
              </Link>
            </p>
          )}
        </>
      )}
    </Card>
  );
}
