"use client";

import { Suspense, useEffect, useState } from "react";
import { Modal } from "@/components/ui/modal";
import { SetupInterview } from "@/components/setup-interview";
import { TourDriver } from "@/components/tour/tour-driver";
import { lessonByKey, lessonOn } from "@/lib/onboarding/tour";
import { SETUP_EVENT, type SetupRequest } from "@/lib/onboarding/help-rows";
import { featureOn, type FeatureMap } from "@/lib/features";
import type { Answers } from "@/lib/playbook/types";

/** What the host shows: one screen at a time. */
export type SetupScreen = { mode: "tour" | "questions" | "finish"; lessonKey: null } | { mode: null; lessonKey: string };

/**
 * THE SCREEN A ROW ASKED FOR, or null for a request that can't be honoured (an unknown lesson, or
 * one whose switch is off). The tour IS Nort talking, so with him off "tour" opens the questions,
 * exactly as the cap did. Pure, so the rule is pinned in a test.
 */
export function screenFor(req: unknown, nortOn: boolean, features?: FeatureMap | null): SetupScreen | null {
  if (typeof req !== "string") return null;
  if (req.startsWith("lesson:")) {
    const l = lessonByKey(req.slice("lesson:".length));
    return l && lessonOn(l, features) ? { mode: null, lessonKey: l.key } : null;
  }
  if (req === "tour") return { mode: nortOn ? "tour" : "questions", lessonKey: null };
  if (req === "questions" || req === "finish") return { mode: req, lessonKey: null };
  return null;
}

/**
 * THE SETUP HOST — the graduation cap's screens, with no button of its own (W1-09).
 *
 * The cap left the top bar; its four doors are rows now (lib/onboarding/help-rows): under Search
 * Or Ask with Nort on, under Help in the avatar menu with Nort off. Those rows live in sheets that
 * close the moment you pick one, so the screens they open can't live inside them — a lesson that
 * unmounted with its menu would die the instant it started. This is mounted ONCE, in the app
 * layout, and opens whatever a row asks for through one window event, `cn:setup`:
 *
 *   tour             Start Here / Take The Setup Again with Nort on: Nort talks, points, asks
 *   questions        the setup questions (straight away with Nort off; after the tour with it on)
 *   finish           Finish Setting Up: only the questions still open, with their whys
 *   lesson:<key>     one lesson from Show Me How
 *
 * TWO ACTS, IN ORDER, AND THE ORDER IS THE POINT (unchanged from the cap):
 *   1. THE TOUR. Nort talks, points at the real buttons, asks the setup questions out loud, and —
 *      the part nobody works out unaided — explains what a why line IS. Erik: "i didnt even know
 *      what a why line really meant until you showed me."
 *   2. THE DRAFT. Straight after, the thing the tour just promised: Nort's first pass at every
 *      question and why line in their trade's terms, for them to cut.
 * Leaving the tour early skips to nothing and saves what was answered — never a gate.
 */
export function SetupHost({
  initial,
  isStaff,
  onboarded,
  features,
}: {
  /** What the company has and hasn't said about itself, in the setup playbook's keys (the layout
   *  reads it off the settings it already loaded). */
  initial: Answers;
  isStaff: boolean;
  /** profiles.onboarded_at (0180) — has THIS PERSON been walked through. */
  onboarded: boolean;
  /** The shell's switch map: Nort off opens the questions instead of the tour, and a lesson skips
   *  its switched-off steps. Left out = everything on. */
  features?: FeatureMap | null;
}) {
  const nortOn = featureOn(features, "nort");
  const [mode, setMode] = useState<null | "tour" | "questions" | "finish">(null);
  const [lessonKey, setLessonKey] = useState<string | null>(null);

  useEffect(() => {
    // Techs have no setup to run and no row that asks for one.
    if (!isStaff) return;
    const onSetup = (e: Event) => {
      const next = screenFor((e as CustomEvent<SetupRequest>).detail, nortOn, features);
      if (!next) return;
      // One screen at a time: whatever was open gives way to what was just asked for.
      setMode(next.mode);
      setLessonKey(next.lessonKey);
    };
    window.addEventListener(SETUP_EVENT, onSetup);
    return () => window.removeEventListener(SETUP_EVENT, onSetup);
  }, [isStaff, nortOn, features]);

  if (!isStaff) return null;
  const lesson = lessonKey ? lessonByKey(lessonKey) : null;

  return (
    <>
      {/* The driver reads the URL (useSearchParams): its own Suspense island, like the Dock. */}
      <Suspense fallback={null}>
        {lesson && (
          <TourDriver
            initial={initial}
            returning
            steps={lesson.steps}
            storageKey={`cn.lesson.${lessonKey}`}
            onClose={() => setLessonKey(null)}
            nortOn={nortOn}
            features={features}
          />
        )}

        {mode === "tour" && (
          <TourDriver
            initial={initial}
            returning={onboarded}
            onClose={(completed) => setMode(completed ? "questions" : null)}
            features={features}
          />
        )}
      </Suspense>

      {/* After the tour it opens on the draft (step 2), because the tour already asked the questions.
          With Nort off there was no tour, so it opens on the questions (step 1). */}
      <Modal open={mode === "questions"} onClose={() => setMode(null)} title="Your questions, and your why lines" size="lg">
        <SetupInterview initial={initial} startAt={nortOn ? 2 : 1} onSaved={() => setMode(null)} nortOn={nortOn} />
      </Modal>

      {/* FINISH SETTING UP opens on the SETUP QUESTIONS (step 1), not the tour: this person has
          already been walked through, and what's left is a couple of boxes with their whys. */}
      <Modal open={mode === "finish"} onClose={() => setMode(null)} title={nortOn ? "A couple of things I still don't know" : "A couple of things still missing"} size="lg">
        <SetupInterview initial={initial} startAt={1} onSaved={() => setMode(null)} nortOn={nortOn} />
      </Modal>
    </>
  );
}
