"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { CalendarOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/toast";
import { unscheduleAppointment } from "./actions";

/** "We'll get back to you" is a real answer, and this is its button — the visit keeps everything
 *  but its date and reappears under Waiting for a day on the schedule, placeable with one tap. */
export function UnscheduleButton({ id }: { id: string }) {
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
          const res = await unscheduleAppointment(id);
          if (!res.ok) { toast(res.error ?? "Couldn't clear the date.", "error"); return; }
          toast("Back on the waiting board — place it from the schedule when they call.", "success");
          router.refresh();
        })
      }
    >
      <CalendarOff className="h-4 w-4" /> {pending ? "Clearing…" : "No date yet"}
    </Button>
  );
}
