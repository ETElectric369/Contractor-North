"use client";

import { useState, useTransition } from "react";
import { GraduationCap, Loader2 } from "lucide-react";
import { unlockAudio } from "@/lib/tts";
import { TourDriver } from "@/components/tour/tour-driver";
import { markLessonSeen } from "@/app/(app)/setup-actions";
import { lessonByKey } from "@/lib/onboarding/tour";
import type { Answers } from "@/lib/playbook/types";

/**
 * A LESSON, OFFERED WHERE IT APPLIES — the training half of the onboarding split (cn-v726).
 *
 * Erik: "the onboarding is one thing but maybe it should just be onboarding and something else
 * better for training can come after." The teaching used to be steps 6–22 of a 24-step tour,
 * delivered on day one whether or not the screen it described was in front of you. Now each
 * lesson is offered ONCE, inline, at the top of the surface it explains — the why-lines lesson
 * at the playbook editor, which is the one thing "nobody is going to figure out without holding
 * their hand through it."
 *
 * NOT AN ⓘ ICON. An icon that waits to be pressed is exactly the thing that doesn't hold a hand;
 * this strip is in the flow, unmissable once, and gone after either answer. "No thanks" records
 * the offer too — the strip must never nag — and replay always lives behind the cap, so declining
 * loses nothing permanently.
 */
export function LessonOffer({
  lessonKey,
  seen,
  initial,
}: {
  lessonKey: string;
  /** profiles.lessons_seen (0197) — offered already means never offered again here. */
  seen: string[];
  initial: Answers;
}) {
  const lesson = lessonByKey(lessonKey);
  const [running, setRunning] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [pending, start] = useTransition();

  if (!lesson || dismissed || seen.includes(lesson.key)) return null;

  const record = () => start(async () => void (await markLessonSeen(lesson.key)));

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-brand/30 bg-brand-light/30 px-3 py-2">
        <GraduationCap className="h-4 w-4 shrink-0 text-brand" />
        <span className="min-w-0 text-sm text-slate-700">
          <strong className="font-medium">First time here?</strong> {lesson.blurb}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-2">
          <button
            type="button"
            disabled={pending}
            onClick={() => {
              // Same iOS rule as the cap: unlock audio inside the tap, or Nort is silent for the
              // whole first step on an iPhone.
              unlockAudio();
              setRunning(true);
              record();
            }}
            className="rounded-lg bg-brand px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-dark"
          >
            {pending && !running ? <Loader2 className="h-4 w-4 animate-spin" /> : "Show me (2 min)"}
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() => {
              setDismissed(true);
              record();
            }}
            className="text-sm text-slate-500 hover:underline"
          >
            No thanks
          </button>
        </span>
      </div>

      {running && (
        <TourDriver
          initial={initial}
          returning
          steps={lesson.steps}
          storageKey={`cn.lesson.${lesson.key}`}
          onClose={() => {
            setRunning(false);
            setDismissed(true);
          }}
        />
      )}
    </>
  );
}
