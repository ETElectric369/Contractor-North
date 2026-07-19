"use client";

import { useSearchParams } from "next/navigation";
import { EditEntryButton } from "./edit-entry-button";
import type { JobCode } from "@/lib/types";

/**
 * The week-grid pill's landing: /timecards?entry=<id> mounts THAT entry's edit
 * modal already open. Gated on the LIVE ?entry= param (useSearchParams), not
 * just mount-time props, and keyed by entry id at the call site — so closing
 * (which strips the param with a SHALLOW history write, no RSC round-trip)
 * unmounts the modal, and tapping the same pill again remounts it fresh.
 */
export function OpenEntryEditor({
  entry,
  jobCodes,
  jobs,
  members,
  jobCodesEnabled = true,
}: {
  entry: { id: string } & Record<string, any>;
  jobCodes: JobCode[];
  jobs: { id: string; job_number: string; name: string }[];
  members: { id: string; full_name: string | null; hourly_rate?: number | null; bill_rate?: number | null }[];
  /** Org setting timeclock_job_codes — must ride through to the editor so the deep-link
   *  path hides the code picker exactly like the page's other editor mounts. */
  jobCodesEnabled?: boolean;
}) {
  const searchParams = useSearchParams();
  if (searchParams.get("entry") !== entry.id) return null;

  const stripParam = () => {
    const url = new URL(window.location.href);
    url.searchParams.delete("entry");
    window.history.replaceState(null, "", `${url.pathname}${url.search}`);
  };

  return (
    <EditEntryButton
      entry={entry as any}
      jobCodes={jobCodes}
      jobs={jobs}
      members={members}
      isStaff
      jobCodesEnabled={jobCodesEnabled}
      initialOpen
      hideTrigger
      onClosed={stripParam}
    />
  );
}
