"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/toast";
import { setAppointmentStatus } from "../actions";

/** The capture page's status affordance — flips the appointment to `completed` so the
 *  Inspections tab's buckets stay truthful (a walked-through inspection stops reading
 *  as "upcoming" and lands in "To write up" until its estimate exists). */
export function MarkCompleteButton({ id, label = "Mark complete" }: { id: string; label?: string }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();

  return (
    <Button
      size="sm"
      variant="outline"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const res = await setAppointmentStatus(id, "completed");
          if (!res.ok) {
            toast(res.error ?? "Couldn't update the status — try again.", "error");
            return;
          }
          toast("Marked complete", "success");
          router.refresh();
        })
      }
    >
      <CheckCircle2 className="h-4 w-4" /> {pending ? "Saving…" : label}
    </Button>
  );
}
