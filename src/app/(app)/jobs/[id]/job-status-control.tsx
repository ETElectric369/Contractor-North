"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Select } from "@/components/ui/input";
import { setJobStatus } from "../../schedule/actions";

const STATUSES = [
  "estimate",
  "scheduled",
  "in_progress",
  "on_hold",
  "complete",
  "invoiced",
  "cancelled",
];

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
          {s.replace("_", " ").replace(/^\w/, (c) => c.toUpperCase())}
        </option>
      ))}
    </Select>
  );
}
