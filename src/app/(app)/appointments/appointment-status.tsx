"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, X } from "lucide-react";
import { setAppointmentStatus } from "./actions";

/** Quick "mark done" / "cancel" controls for an appointment row. */
export function ApptQuickActions({ id, status, title }: { id: string; status: string; title: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();

  function set(next: string) {
    start(async () => {
      await setAppointmentStatus(id, next);
      router.refresh();
    });
  }

  return (
    <div className="flex items-center gap-1">
      {status !== "completed" && (
        <button onClick={() => set("completed")} disabled={pending} className="rounded-md p-1 text-slate-400 hover:bg-green-50 hover:text-green-600" title="Mark done">
          <Check className="h-4 w-4" />
        </button>
      )}
      {/* Cancelling a booking is destructive — one icon tap isn't consent. */}
      <button
        onClick={() => {
          if (!confirm(`Cancel "${title}"?`)) return;
          set("cancelled");
        }}
        disabled={pending}
        className="rounded-md p-1 text-slate-400 hover:bg-red-50 hover:text-red-600"
        title="Cancel"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
