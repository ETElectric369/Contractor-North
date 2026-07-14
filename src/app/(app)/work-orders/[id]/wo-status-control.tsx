"use client";

import { useTransition } from "react";
import { Select } from "@/components/ui/input";
import { setWorkOrderStatus } from "../actions";
import { jobStatusLabel } from "@/lib/job-status";
import { WORK_ORDER_STATUSES } from "@/lib/statuses";

export function WoStatusControl({ id, status }: { id: string; status: string }) {
  const [pending, start] = useTransition();
  return (
    <Select
      value={status}
      disabled={pending}
      className="w-44"
      onChange={(e) =>
        start(async () => {
          await setWorkOrderStatus(id, e.target.value);
        })
      }
    >
      {/* Options come from the spine (same set setWorkOrderStatus validates against). */}
      {WORK_ORDER_STATUSES.map((s) => (
        <option key={s} value={s}>
          {jobStatusLabel(s).replace(/^\w/, (c) => c.toUpperCase())}
        </option>
      ))}
    </Select>
  );
}
