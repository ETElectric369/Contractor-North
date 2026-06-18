"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { clockIn } from "../../timeclock/actions";
import { ClockStartPicker } from "../../timeclock/clock-start-picker";

/** One-tap clock-in to this job, right in the job's Time tab. Pick a different
 *  start time if you forgot to clock in. Clock out from My Day or the Timeclock. */
export function JobClockButton({ jobId }: { jobId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [startAt, setStartAt] = useState(""); // "" = now; otherwise a chosen ISO
  const [msg, setMsg] = useState<string | null>(null);

  return (
    <div className="flex flex-col items-start gap-1.5">
      <div className="flex items-center gap-2">
        {msg && <span className="text-xs text-slate-500">{msg}</span>}
        <Button
          variant="outline"
          onClick={() => {
            setMsg(null);
            start(async () => {
              const res = await clockIn({ job_id: jobId, job_code: null, gps: null, clock_in_at: startAt || null });
              if (!res.ok) setMsg(res.error ?? "Couldn't clock in.");
              else {
                setMsg("Clocked in ✓");
                router.refresh();
              }
            });
          }}
          disabled={pending}
        >
          <Play className="h-3.5 w-3.5" /> Clock in
        </Button>
      </div>
      <ClockStartPicker onChange={(iso) => setStartAt(iso ?? "")} />
    </div>
  );
}
