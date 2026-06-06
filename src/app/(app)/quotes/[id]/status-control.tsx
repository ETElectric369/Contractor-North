"use client";

import { useTransition } from "react";
import { Select } from "@/components/ui/input";
import { updateQuoteStatus } from "../actions";

const STATUSES = ["draft", "sent", "accepted", "declined", "expired"];

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
      {STATUSES.map((s) => (
        <option key={s} value={s}>
          {s[0].toUpperCase() + s.slice(1)}
        </option>
      ))}
    </Select>
  );
}
