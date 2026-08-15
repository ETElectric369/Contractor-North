"use client";

import { useMemo, useState } from "react";
import { GraduationCap } from "lucide-react";
import { unlockAudio } from "@/lib/tts";
import { Modal } from "@/components/ui/modal";
import { SetupInterview } from "@/components/setup-interview";
import { TourDriver } from "@/components/tour/tour-driver";
import { LESSONS, lessonByKey } from "@/lib/onboarding/tour";
import { missingNeeds } from "@/lib/playbook/resolve";
import { SETUP_PLAYBOOK } from "@/lib/onboarding/setup-playbook";
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
  const [mode, setMode] = useState<null | "tour" | "questions" | "finish">(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [lessonKey, setLessonKey] = useState<string | null>(null);
  /**
   * WHAT THE COMPANY STILL HASN'T SAID ABOUT ITSELF — computed here, from the same answers the
   * layout already loads, so the third state costs no query. `onboarded` is about the PERSON (has
   * this one been walked through); this is about the COMPANY, and the two drift: service_area was
   * added to the setup playbook after all three live orgs were onboarded, so every cap in
   * production went grey over an unanswered question. Erik: "if one is set and the onboarding is
   * only partially complete then we should have the cap highlight in different colors to bring it
   * more attention" — and, in the same breath, it must never stop anyone doing anything. It's a
   * button. Nothing anywhere gates on it.
   */
  const missing = useMemo(() => missingNeeds(SETUP_PLAYBOOK, initial), [initial]);
  if (!isStaff) return null;

  // THREE STATES, LOUDEST FIRST: never toured → amber "Start here"; toured but the company has
  // unanswered setup questions → teal count, straight into the QUESTIONS (they know the app now —
  // re-running the walk-through to reach one box is a chore, and the interview shows each
  // question's why); everything answered → one grey cap, the replay door.
  const state = !onboarded ? "start" : missing.length ? "finish" : "done";

  return (
    <>
      <span className="relative inline-flex items-center">
      <button
        type="button"
        data-tour="setup"
        onClick={() => {
          // UNLOCK AUDIO INSIDE THE TAP. iOS only lets a gesture-touched element play sound
          // afterwards, and the tour's first line is spoken from an effect AFTER the driver mounts
          // — which is outside the gesture. Without this, Nort is silent on an iPhone for the whole
          // first step, on the one screen whose entire job is proving he talks.
          unlockAudio();
          // THE CAP IS THE INDEX (cn-v726). Amber runs setup; teal finishes it; the quiet grey cap
          // opens a menu of the LESSONS — the teaching that used to be steps 6–22 of the tour,
          // replayable one topic at a time instead of only as a 24-step march.
          if (state === "finish") setMode("finish");
          else if (state === "start") setMode("tour");
          else setMenuOpen((v) => !v);
        }}
        title={
          state === "start"
            ? "Start here — Nort will show you around"
            : state === "finish"
              ? `Finish setting up — still missing: ${missing.map((n) => n.label.toLowerCase()).join(", ")}`
              : "Take the walk-through again"
        }
        aria-label={
          state === "start"
            ? "Start here, Nort will show you around"
            : state === "finish"
              ? `Finish setting up, ${missing.length} question${missing.length === 1 ? "" : "s"} left`
              : "Take the walk-through again"
        }
        className={
          state === "start"
            ? "btn-gloss relative inline-flex h-10 items-center gap-1.5 rounded-full bg-amber-500 px-3 text-sm font-medium text-white shadow-sm transition-colors hover:bg-amber-600"
            : state === "finish"
              ? "btn-gloss relative inline-flex h-10 items-center gap-1.5 rounded-full bg-teal-600 px-3 text-sm font-medium text-white shadow-sm transition-colors hover:bg-teal-700"
              : "relative inline-flex h-10 w-10 items-center justify-center rounded-full text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
        }
      >
        <GraduationCap className="h-5 w-5 shrink-0" />
        {state === "start" && (
          <>
            <span className="hidden md:inline">Start here</span>
            {/* On a phone the label is gone, so the dot is the only thing saying "this one is
                waiting on you". */}
            <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-rose-500 ring-2 ring-white md:hidden" />
          </>
        )}
        {state === "finish" && (
          <span className="text-sm font-semibold">
            <span className="hidden md:inline">Finish setup · </span>
            {missing.length}
          </span>
        )}
      </button>

      {menuOpen && mode === null && !lessonKey && (
        <div className="fixed inset-x-3 top-16 z-[60] rounded-xl border border-slate-200 bg-white p-2 shadow-lg sm:absolute sm:inset-x-auto sm:right-0 sm:top-12 sm:w-72">
          <p className="px-2 pb-1 pt-1 text-xs font-semibold uppercase tracking-wide text-slate-400">Lessons</p>
          {LESSONS.map((l) => (
            <button
              key={l.key}
              type="button"
              onClick={() => {
                unlockAudio();
                setMenuOpen(false);
                setLessonKey(l.key);
              }}
              className="block w-full rounded-lg px-2 py-2 text-left hover:bg-slate-50"
            >
              <span className="block text-sm font-medium text-slate-900">{l.title}</span>
              <span className="block text-xs text-slate-500">{l.blurb}</span>
            </button>
          ))}
          <div className="mt-1 border-t border-slate-100 pt-1">
            <button
              type="button"
              onClick={() => {
                unlockAudio();
                setMenuOpen(false);
                setMode("tour");
              }}
              className="block w-full rounded-lg px-2 py-2 text-left text-sm text-slate-600 hover:bg-slate-50"
            >
              Take the setup again
            </button>
          </div>
        </div>
      )}

      </span>

      {lessonKey && (
        <TourDriver
          initial={initial}
          returning
          steps={lessonByKey(lessonKey)!.steps}
          storageKey={`cn.lesson.${lessonKey}`}
          onClose={() => setLessonKey(null)}
        />
      )}

      {mode === "tour" && (
        <TourDriver
          initial={initial}
          returning={onboarded}
          onClose={(completed) => setMode(completed ? "questions" : null)}
        />
      )}

      {/* The topbar carries a translucent background but NO backdrop-filter (see topbar.tsx), so
          the overlay isn't trapped and needs no portal. */}
      <Modal open={mode === "questions"} onClose={() => setMode(null)} title="Your questions, and your why lines" size="lg">
        <SetupInterview initial={initial} startAt={2} onSaved={() => setMode(null)} />
      </Modal>

      {/* THE FINISH DOOR — the teal state's target. Opens on the SETUP QUESTIONS (step 1), not the
          tour: this person has already been walked through, and what's left is a couple of boxes
          with their whys beside them. */}
      <Modal open={mode === "finish"} onClose={() => setMode(null)} title="A couple of things I still don't know" size="lg">
        <SetupInterview initial={initial} startAt={1} onSaved={() => setMode(null)} />
      </Modal>
    </>
  );
}
