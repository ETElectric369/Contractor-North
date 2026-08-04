"use client";

import { useState } from "react";
import { GraduationCap } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { SetupInterview } from "@/components/setup-interview";
import { SETUP_PLAYBOOK } from "@/lib/onboarding/setup-playbook";
import { missingNeeds } from "@/lib/playbook/resolve";
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
export function SetupButton({ initial, isStaff }: { initial: Answers; isStaff: boolean }) {
  const [open, setOpen] = useState(false);
  if (!isStaff) return null;

  const left = missingNeeds(SETUP_PLAYBOOK, initial).length;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={left ? `Finish setting up — ${left} to go` : "Your setup"}
        aria-label={left ? `Finish setting up, ${left} remaining` : "Your setup"}
        className={
          left
            ? "btn-gloss relative inline-flex h-10 items-center gap-1.5 rounded-full bg-amber-500 px-3 text-sm font-medium text-white shadow-sm transition-colors hover:bg-amber-600"
            : "relative inline-flex h-10 w-10 items-center justify-center rounded-full text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
        }
      >
        <GraduationCap className="h-5 w-5 shrink-0" />
        {left > 0 && (
          <>
            <span className="hidden md:inline">Set up</span>
            <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-white/25 px-1 text-xs font-semibold">
              {left}
            </span>
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
