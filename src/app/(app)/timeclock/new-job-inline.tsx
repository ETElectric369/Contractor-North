"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createJob } from "../schedule/actions";

/** What the caller gets back — enough to drop the job straight into a picker without
 *  waiting for the page's server-rendered job list to catch up. */
export interface CreatedJob {
  id: string;
  name: string;
}

/**
 * "Can't add new job from this window." — Erik, filing from the truck.
 *
 * Every job picker on the clock (clock-in, the mid-shift switch, the office's Add Entry form)
 * could only offer jobs that ALREADY existed. So the one moment you most need a new job —
 * you're standing on a site nobody has opened a job for — sent you off to /jobs and back,
 * which is precisely the round trip the 60mph rule exists to forbid.
 *
 * ONE FIELD on purpose. createJob is fragment-first (a bare name is a whole job), so this asks
 * for the only thing the clock actually needs and leaves the customer, the address and the
 * money to the office. Status is in_progress because you are about to clock into it.
 *
 * STAFF ONLY. createJob is requireStaff-guarded, so offering this to a tech would buy them
 * "This action is staff-only." for their trouble; a tech's honest answer is the job-less punch
 * the server already resolves — and the clock now says so out loud. Every mount site here is
 * already behind an isStaff gate; this component does not gate itself.
 */
export function NewJobInline({
  onCreated,
  label = "New Job",
  className = "",
}: {
  onCreated: (job: CreatedJob) => void;
  /** The trigger's words. "New Job" everywhere today — a prop so a surface can say what the
   *  new job is about to be used for. */
  label?: string;
  className?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function submit() {
    const trimmed = name.trim();
    if (!trimmed) {
      // createJob would happily mint "New job — Sep 9" from a blank box; a stub nobody can
      // recognize on a timecard is worse than being asked for four words.
      setError("Give it a name first — the street address works fine.");
      return;
    }
    setError(null);
    start(async () => {
      const fd = new FormData();
      fd.set("name", trimmed);
      // You're clocking into it as you make it, so it's underway — the same default the
      // office's New Job form carries.
      fd.set("status", "in_progress");
      try {
        const res = await createJob(fd);
        // ok WITHOUT an id is not a save: createJob's id comes from the insert's own
        // .select("id"), so a missing one means nothing landed. Say that, rather than handing
        // the picker an id-less job and letting the punch resolve to nothing.
        if (!res.ok || !res.id) {
          setError(res.error ?? "Could not create the job.");
          return;
        }
        onCreated({ id: res.id, name: trimmed });
        setName("");
        setOpen(false);
        // The page's job list is server-rendered and createJob revalidates /schedule and
        // /planner, not this route — catch the clock up so every OTHER picker on it (and the
        // crew board) sees the job too, not just the one that made it.
        router.refresh();
      } catch {
        // Dead spot: the punch flow's own rule — keep what they typed, and say why nothing
        // happened instead of throwing the whole clock to the error boundary.
        setError("No connection — what you typed is kept, try again when you have bars.");
      }
    });
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
        className={`inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline ${className}`}
      >
        <Plus className="h-3.5 w-3.5 shrink-0" /> {label}
      </button>
    );
  }

  return (
    <div className={`space-y-2 rounded-lg border border-brand/30 bg-white p-2 ${className}`}>
      <Input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          // A phone keyboard's Go key should finish the job, not submit whatever form the
          // picker happens to be sitting inside (the Add Entry modal's, for one).
          // GUARDED like the button is: on truck signal the round trip is seconds long, and a
          // double-tap of Go would otherwise mint the job twice — useTransition happily starts a
          // second run while the first is still in flight, and there is no unique key to catch it.
          if (e.key === "Enter" && !pending) {
            e.preventDefault();
            submit();
          }
        }}
        placeholder="Job name or address"
        aria-label="New job name"
        disabled={pending}
        className="h-11"
      />
      <p className="text-xs text-slate-500">
        That&apos;s all the clock needs — the office fills in the customer, address and the rest later.
      </p>
      {error && <p className="text-xs text-red-600">{error}</p>}
      <div className="flex gap-2">
        <Button size="sm" className="flex-1" onClick={submit} disabled={pending}>
          {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Create Job
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setOpen(false);
            setError(null);
          }}
          disabled={pending}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}
