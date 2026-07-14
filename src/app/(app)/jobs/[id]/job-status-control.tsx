"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Select } from "@/components/ui/input";
// Use the GUARDED setJobStatus (jobs/actions: requireStaff + status whitelist + not-found check).
// There used to be an identically-named UNGUARDED copy in schedule/actions that this imported — a
// name-collision footgun that silently bypassed the staff guard. That copy is now deleted.
import { setJobStatus } from "../actions";
import { JOB_STATUSES, jobStatusLabel } from "@/lib/job-status";

// Reference implementation for spine-driven status controls: options derive from the
// spine + labels via jobStatusLabel (wo-status-control / quotes status-control copy this).
const STATUSES = JOB_STATUSES;

export function JobStatusControl({ id, status }: { id: string; status: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Select
      value={status}
      disabled={pending}
      className="w-40"
      onChange={(e) =>
        start(async () => {
          await setJobStatus(id, e.target.value);
          router.refresh();
        })
      }
    >
      {STATUSES.map((s) => (
        <option key={s} value={s}>
          {jobStatusLabel(s).replace(/^\w/, (c) => c.toUpperCase())}
        </option>
      ))}
    </Select>
  );
}
