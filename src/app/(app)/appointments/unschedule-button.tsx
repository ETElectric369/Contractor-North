"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { CalendarOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/toast";
import { unscheduleAppointment } from "./actions";

/** "We'll get back to you" is a real answer, and this is its button — the visit keeps everything
 *  but its date and waits on the schedule's rail under Waiting For A Day, placeable with one tap.
 *
 *  IT WORKS NOW (0368, 2026-09-27): appointments.starts_at held NOT NULL from 0042, so every press
 *  failed on production. 0368 lets a visit wait without a day (every reader already expected one),
 *  and until it lands the refusal is said in words, with the date unchanged (unscheduleAppointment). */
export function UnscheduleButton({ id }: { id: string }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  return (
    <Button
      variant="outline"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const res = await unscheduleAppointment(id);
          if (!res.ok) {
            toast(res.error ?? "Couldn't clear the date.", "error");
            return;
          }
          toast("It waits under Waiting For A Day on the schedule. Place it there when they call.", "success");
          router.refresh();
        })
      }
    >
      {/* A VERB, not a state. "No date yet" sat beside a header reading "Sep 1, 9:00 AM" — the
          page asserting a date and the button denying one, on the same screen (Erik: "a clear
          incongruency"). The button DOES something; its label says what. 44px, Title Case. */}
      <CalendarOff className="h-4 w-4" /> {pending ? "Clearing…" : "Clear The Date"}
    </Button>
  );
}
