"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/toast";
import { setAppointmentStatus } from "../actions";
import { useStatusUndo } from "./visit-header-actions";

/** The visit page's main button on an inspection that is booked (W2-11): flips it to `completed`
 *  so the Inspections tab's buckets stay truthful (a visit that happened stops reading as
 *  "upcoming" and lands in "To write up" until its estimate exists). 44px, primary: at most one main
 *  button sits in the header, and on a booked inspection this is it. Said in a toast, with Undo:
 *  the page has no other way back from Done. */
export function MarkCompleteButton({ id, label = "Mark Inspection Done" }: { id: string; label?: string }) {
  const router = useRouter();
  const toast = useToast();
  const undo = useStatusUndo(id);
  const [pending, start] = useTransition();

  return (
    <Button
      disabled={pending}
      onClick={() =>
        start(async () => {
          const res = await setAppointmentStatus(id, "completed");
          if (!res.ok) {
            toast(res.error ?? "Couldn't update the status — try again.", "error");
            return;
          }
          toast(res.note ? `Marked Done. ${res.note}` : "Marked Done", "success", undo(res.previousStatus));
          router.refresh();
        })
      }
    >
      <CheckCircle2 className="h-4 w-4" /> {pending ? "Saving…" : label}
    </Button>
  );
}
