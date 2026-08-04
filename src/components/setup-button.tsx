"use client";

import { useState } from "react";
import { GraduationCap } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { SetupInterview } from "@/components/setup-interview";
import { TourDriver } from "@/components/tour/tour-driver";
import type { Answers } from "@/lib/playbook/types";

/**
 * THE FRONT DOOR — in the top bar, beside Nort, on every screen.
 *
 * Erik: "i would prefer the interview to be front and center on the top bar next to the speak
 * button so nobody has to search for it."
 *
 * LOUD WHILE IT MATTERS, QUIET FOREVER AFTER, NEVER GONE. Unfinished it reads "Start here" in
 * amber with a dot on a phone; finished it is one grey cap in exactly the same place. That is
 * "available is not visible" applied to a door rather than to a box.
 *
 * TWO ACTS, IN ORDER, AND THE ORDER IS THE POINT:
 *
 *   1. THE TOUR. Nort talks, points at the real buttons with an arrow, asks the setup questions out
 *      loud, and — the part nobody works out unaided — explains what a why line IS and how to write
 *      one. Erik: "i didnt even know what a why line really meant until you showed me."
 *   2. THE DRAFT. Straight after, the thing the tour just promised: Nort's first pass at every
 *      question and why line in their trade's terms, for them to cut. Arguing with a draft is how
 *      somebody learns to write one; a blank box is how they learn to skip it.
 *
 * Leaving the tour early skips to nothing and saves what was answered — never a gate.
 */
export function SetupButton({
  initial,
  isStaff,
  onboarded,
}: {
  initial: Answers;
  isStaff: boolean;
  /** profiles.onboarded_at (0180) — has THIS PERSON been walked through, not "are the fields full". */
  onboarded: boolean;
}) {
  const [mode, setMode] = useState<null | "tour" | "questions">(null);
  if (!isStaff) return null;

  return (
    <>
      <button
        type="button"
        data-tour="setup"
        onClick={() => setMode("tour")}
        title={onboarded ? "Take the walk-through again" : "Start here — Nort will show you around"}
        aria-label={onboarded ? "Take the walk-through again" : "Start here, Nort will show you around"}
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

      {mode === "tour" && (
        <TourDriver
          initial={initial}
          onClose={(completed) => setMode(completed ? "questions" : null)}
        />
      )}

      {/* The topbar carries a translucent background but NO backdrop-filter (see topbar.tsx), so
          the overlay isn't trapped and needs no portal. */}
      <Modal open={mode === "questions"} onClose={() => setMode(null)} title="Your questions, and your why lines" size="lg">
        <SetupInterview initial={initial} startAt={2} onSaved={() => setMode(null)} />
      </Modal>
    </>
  );
}
