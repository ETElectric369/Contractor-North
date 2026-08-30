"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Undo2, X } from "lucide-react";
import { setAppointmentStatus } from "./actions";
import { useToast } from "@/components/toast";

/** Quick "mark done" / "cancel" controls for an appointment row. */
export function ApptQuickActions({ id, status, title, boxClassName }: { id: string; status: string; title: string;
  /** Box for the icon verbs — a row of h-8 buttons passes its size so ✓/✗ join the set. */
  boxClassName?: string }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  /**
   * NO SAVE GAME (Erik's standing rule): every deed gets a way back. Cancelling a booking used
   * to be a one-way icon tap whose result was thrown away entirely — `await setAppointmentStatus`
   * with no check, so a write RLS declined reported nothing at all and the row just sat there.
   * Now the deed is announced, its failure is announced, and an undo sits next to it until the
   * page moves on.
   */
  const [undoTo, setUndoTo] = useState<string | null>(null);

  function set(next: string, opts: { undoable?: boolean } = {}) {
    start(async () => {
      const res = await setAppointmentStatus(id, next);
      if (!res.ok) {
        // Announce the failure. This is the whole reason the action now asks for the row back:
        // silence used to be indistinguishable from success.
        toast(res.error ?? "That didn't save.", "error");
        return;
      }
      setUndoTo(opts.undoable ? (res.previousStatus ?? null) : null);
      // ANNOUNCE THE DEED, NOT THE INTENT — and name the part that can't be undone rather than
      // offering an undo that quietly restores less than it promises.
      toast(next === "cancelled" ? `Cancelled${res.note ? ` — ${res.note}` : ""}` : "Marked done", "success");
      router.refresh();
    });
  }

  function undo() {
    if (!undoTo) return;
    start(async () => {
      const res = await setAppointmentStatus(id, undoTo);
      toast(res.ok ? "Put back" : (res.error ?? "Couldn't put it back."), res.ok ? "success" : "error");
      if (res.ok) setUndoTo(null);
      router.refresh();
    });
  }

  return (
    <div className="flex items-center gap-1">
      {undoTo && (
        <button
          onClick={undo}
          disabled={pending}
          className="flex items-center gap-1 rounded-md px-1.5 py-1 text-xs font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-800"
          title={`Put it back to ${undoTo}`}
        >
          <Undo2 className="h-3.5 w-3.5" />
          Undo
        </button>
      )}
      {status !== "completed" && (
        <button onClick={() => set("completed")} disabled={pending} className={`${boxClassName ?? "rounded-md p-1"} text-slate-400 hover:bg-green-50 hover:text-green-600`} title="Mark done">
          <Check className="h-4 w-4" />
        </button>
      )}
      {/* Cancelling a booking is destructive — one icon tap isn't consent.
          THE WORDING IS THE FIX. This used to ask `Cancel "Site inspection"?` inside a dialog
          whose own dismiss button is also labelled Cancel, so "Cancel" was both the verb and the
          escape hatch. Erik read it as delete, tapped it, and the row stayed on his screen — he
          made a second inspection two minutes later. Six rows across two tenants are in that
          state; nobody has ever successfully deleted one from here. The verb is now unambiguous,
          and it says plainly that the record survives. */}
      <button
        onClick={() => {
          if (!confirm(`Mark "${title}" as cancelled? It stays on file — use Delete to remove it.`)) return;
          set("cancelled", { undoable: true });
        }}
        disabled={pending}
        className={`${boxClassName ?? "rounded-md p-1"} text-slate-400 hover:bg-red-50 hover:text-red-600`}
        title="Cancel"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
