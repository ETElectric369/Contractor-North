"use client";

import { useTransition } from "react";
import { Select } from "@/components/ui/input";
import { updateQuoteStatus } from "../actions";
import { QUOTE_STATUSES } from "@/lib/statuses";

export function StatusControl({ id, status }: { id: string; status: string }) {
  const [pending, start] = useTransition();
  return (
    <Select
      value={status}
      disabled={pending}
      className="w-40"
      onChange={(e) =>
        start(async () => {
          await updateQuoteStatus(id, e.target.value);
        })
      }
    >
      {/* Options come from the spine (same set updateQuoteStatus validates against). */}
      {QUOTE_STATUSES.map((s) => (
        <option key={s} value={s}>
          {s[0].toUpperCase() + s.slice(1)}
        </option>
      ))}
    </Select>
  );
}
