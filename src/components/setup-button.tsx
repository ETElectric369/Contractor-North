"use client";

import { useState } from "react";
import { GraduationCap } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { SetupInterview } from "@/components/setup-interview";
import type { Answers } from "@/lib/playbook/types";

/**
 * THE INTERVIEW'S FRONT DOOR — in the top bar, beside Nort, on every screen.
 *
 * Erik: "i would prefer the interview to be front and center on the top bar next to the speak
 * button so nobody has to search for it."
 *
 * It replaces a card on My Day that hid itself once setup was complete. Hiding was correct for a
 * card and wrong for this: the moment somebody wants to change what they said — a new rate, a
 * different service area, a trade they've grown into — the thing they used has evaporated, and
 * "where did that go" is the same failure as questions nobody could find.
 *
 * LOUD WHILE IT MATTERS, QUIET FOREVER AFTER, NEVER GONE. Unfinished, it carries a count and reads
 * "Set up" on a wide screen — a new company should trip over it. Finished, it is one quiet icon
 * that is still exactly where it was. That is "available is not visible" applied to a door rather
 * than to a box.
 *
 * STAFF ONLY, because what it writes is company config — a tech has nothing to answer here and RLS
 * would refuse the write anyway.
 */
export function SetupButton({
  initial,
  isStaff,
  onboarded,
}: {
  initial: Answers;
  isStaff: boolean;
  /** Has THIS PERSON reached the end of the walk-through (profiles.onboarded_at, 0180)?
   *  Deliberately not "are the fields full" — see the migration. */
  onboarded: boolean;
}) {
  const [open, setOpen] = useState(false);
  if (!isStaff) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={onboarded ? "Take the walk-through again" : "Start here — the two-minute walk-through"}
        aria-label={onboarded ? "Take the walk-through again" : "Start here, the walk-through"}
        className={
          onboarded
            ? "relative inline-flex h-10 w-10 items-center justify-center rounded-full text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
            : "btn-gloss relative inline-flex h-10 items-center gap-1.5 rounded-full bg-amber-500 px-3 text-sm font-medium text-white shadow-sm transition-colors hover:bg-amber-600"
        }
      >
        <GraduationCap className="h-5 w-5 shrink-0" />
        {!onboarded && (
          <>
            <span className="hidden md:inline">Start here</span>
            {/* On a phone the label is gone, so the dot is the only thing saying "this one is
                waiting on you". */}
            <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-rose-500 ring-2 ring-white md:hidden" />
          </>
        )}
      </button>

      {/* The topbar carries a translucent background but NO backdrop-filter (see topbar.tsx), so
          the overlay isn't trapped and needs no portal. */}
      <Modal open={open} onClose={() => setOpen(false)} title="Getting you set up" size="lg">
        <SetupInterview initial={initial} />
      </Modal>
    </>
  );
}
