"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CalendarPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/toast";
import { WorkedTrack } from "@/components/worked-track";
import { peopleWords, type WorkedPerson } from "@/lib/schedule/plan-vs-actual";
import { nameSays } from "@/lib/schedule/block-info";
import { bookWorkedDay, unbookWorkedDay } from "./actions";

/**
 * WORK NOBODY BOOKED (Wave 2, SV-ghost; Erik's approval 2026-09-26). A job's past day with clocked time
 * and no booking draws DASHED on the schedule: slate, 2px dashed, white, "worked, not booked" (never a
 * booking's look: a proposed visit keeps its type's tone with a thin dashed border). A tap opens it in
 * the one tile sheet: who worked it and when, as a track and in words, and two doors:
 *
 *   Book This Day   the day becomes a real block of the job at the hours actually worked
 *                   (bookWorkedDay: the day added and nothing else; the status, the listed day and any
 *                   hold never move), a toast with Undo (that one day comes off again);
 *   Open The Job    the job.
 *
 * NEVER NAGS: no badge, count, Needs You row, push or banner; nothing is saved without the tap; closing
 * changes nothing. The day drill carries the same as a dashed "Worked, Not Booked" row (its 44px doors
 * are the guaranteed ones: a squeezed ghost in a week can be ~42px wide). No money anywhere.
 */

/** A ghost as the sheet and the day drill read it. */
export type GhostTarget = {
  jobId: string;
  /** The job's name (a street, by the namer), its number (second, small) and who it's for. */
  name: string;
  jobNumber: string | null;
  customer: string | null;
  /** Who worked it, each with their stretches (plan-vs-actual ghostsFor). */
  people: WorkedPerson[];
};

/** "12 Elm St · Rita Moss", or the name alone when it already says who (or there is no one). */
export function ghostTitle(g: Pick<GhostTarget, "name" | "customer">): string {
  const who = String(g.customer ?? "").trim();
  return who && !nameSays(g.name, who) ? `${g.name} · ${who}` : g.name;
}

/** What the sheet and the track say: "Brian 11:04 AM–1:46 PM · Erik 12:30–5:30 PM. Nothing was booked this day." */
export function ghostLine(g: Pick<GhostTarget, "people">): string {
  return `${peopleWords(g.people)}. Nothing was booked this day.`;
}

/** What a sheet around this tells it (the tile sheet's SheetVoice): a write out, or a refusal in words. */
type Voice = { pending: (busy: boolean) => void; refusal: (words: string | null) => void };

/**
 * BOOK THIS DAY, ONCE: the sheet and the day drill's row share it. The answer is said: its note in a
 * toast, with Undo when the day was added (never for a day that was already on the schedule), and a
 * refusal in its words where the tap was.
 */
export function useBookWorkedDay(jobId: string, day: string, opts?: { onBooked?: () => void; voice?: Voice }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const refuse = (words: string | null) => {
    setError(words);
    opts?.voice?.refusal(words);
  };

  // The Undo runs after the sheet has closed (the ghost became a block), so it owns no component state.
  const undo = async () => {
    try {
      const res = await unbookWorkedDay(jobId, day);
      if (!res.ok) toast(res.error ?? "That day didn't come off. Check the job's days.", "error");
      else toast("Put back where it was.", "success");
    } catch {
      toast("That Undo didn't reach the server. Check your connection; nothing may have changed.", "error");
    }
    router.refresh();
  };

  const book = () => {
    refuse(null);
    opts?.voice?.pending(true);
    start(async () => {
      try {
        const res = await bookWorkedDay(jobId, day);
        if (!res.ok) {
          refuse(res.error ?? "That day didn't book. Try again.");
          return;
        }
        toast(res.note ?? "Booked.", "success", res.added ? { label: "Undo", onClick: () => void undo() } : undefined);
        router.refresh();
        opts?.onBooked?.();
      } catch {
        refuse("That didn't reach the server. Check your connection and try again.");
      } finally {
        opts?.voice?.pending(false);
      }
    });
  };

  return { pending, error, book };
}

const DOOR = "inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg px-4 text-sm font-medium";

/** The ghost's two doors: Book This Day (the office) and Open The Job. 44px each. */
function GhostDoors({ jobId, canEdit, pending, onBook }: { jobId: string; canEdit: boolean; pending: boolean; onBook: () => void }) {
  return (
    <div className="flex flex-wrap gap-2">
      {canEdit && (
        <Button type="button" onClick={onBook} disabled={pending} className="min-h-11">
          <CalendarPlus className="h-4 w-4" /> {pending ? "Booking…" : "Book This Day"}
        </Button>
      )}
      <Link href={`/jobs/${jobId}`} className={`${DOOR} border border-slate-300 bg-white text-slate-800 hover:border-slate-400`}>
        Open The Job
      </Link>
    </div>
  );
}

/** The tile sheet's inside for a ghost (rendered by ScheduleTileSheet; exported for its render test). */
export function GhostSheetBody({
  day,
  ghost,
  canEdit,
  onClose,
  voice,
}: {
  day: string;
  ghost: GhostTarget;
  canEdit: boolean;
  onClose: () => void;
  voice?: Voice;
}) {
  const { pending, error, book } = useBookWorkedDay(ghost.jobId, day, { onBooked: onClose, voice });
  return (
    <div className="space-y-4">
      {ghost.jobNumber && <p className="-mt-2 text-xs text-slate-400">{ghost.jobNumber}</p>}
      <WorkedTrack booked={null} people={ghost.people} sentence={ghostLine(ghost)} />
      <div className="border-t border-slate-100 pt-4">
        <GhostDoors jobId={ghost.jobId} canEdit={canEdit} pending={pending} onBook={book} />
        {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
      </div>
    </div>
  );
}

/** The day drill's dashed "Worked, Not Booked" row: the track, the words, the same two doors. */
export function GhostRow({ day, ghost, canEdit }: { day: string; ghost: GhostTarget; canEdit: boolean }) {
  const { pending, error, book } = useBookWorkedDay(ghost.jobId, day);
  return (
    <div className="col-span-full rounded-lg border-2 border-dashed border-slate-400 bg-white/60 p-2.5 text-xs text-slate-700">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Worked, Not Booked</div>
      <div className="mt-1">
        <WorkedTrack booked={null} people={ghost.people} sentence={`${ghostTitle(ghost)} — ${peopleWords(ghost.people)}`} />
      </div>
      <div className="mt-2">
        <GhostDoors jobId={ghost.jobId} canEdit={canEdit} pending={pending} onBook={book} />
        {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
      </div>
    </div>
  );
}
