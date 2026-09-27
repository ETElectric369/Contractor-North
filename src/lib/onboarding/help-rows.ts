import { unlockAudio } from "@/lib/tts";
import { LESSONS, lessonBlurb, lessonOn } from "@/lib/onboarding/tour";
import { SETUP_PLAYBOOK } from "@/lib/onboarding/setup-playbook";
import { missingNeeds } from "@/lib/playbook/resolve";
import type { FeatureMap } from "@/lib/features";
import type { Answers } from "@/lib/playbook/types";

/**
 * THE HELP ROWS — what the graduation cap held, as rows (W1-09). The cap left the top bar; its
 * four doors live under Search Or Ask with Nort on (command-bar.tsx) and under Help in the avatar
 * menu with Nort off (account-menu.tsx). One builder, so the two can't drift, and one host
 * (components/setup-host.tsx) that opens what a row asks for, so closing the sheet a row sat in
 * never kills a running lesson.
 *
 *   Start Here                 this PERSON hasn't been walked through (profiles.onboarded_at)
 *   Finish Setting Up · N Left the COMPANY still has N setup questions open (never a total)
 *   Show Me How                the lessons whose switch is on
 *   Take The Setup Again       always: the replay, and how an answer changes
 *
 * Staff only, as the cap was: techs have no setup to run.
 */

/** What SetupHost opens: the tour, the setup questions, the finish questions, or one lesson. */
export type SetupRequest = "tour" | "questions" | "finish" | `lesson:${string}`;

/** The window event SetupHost listens for; its detail is a SetupRequest. */
export const SETUP_EVENT = "cn:setup";
/** Talk To Nort's window event. NEW, on purpose: cn:assistant-talk already means "resume" inside the
 *  open panel. GlobalAssistant runs launch() inside this event's dispatch. */
export const NORT_TALK_EVENT = "cn:nort-talk";

export type LessonRow = { key: string; label: string; sub: string; request: SetupRequest };
export type HelpRow =
  | { key: "start" | "finish" | "again"; label: string; sub: string; request: SetupRequest }
  | { key: "lessons"; label: "Show Me How"; sub: string; lessons: LessonRow[] };

/** The company's setup questions still unanswered, from the answers the layout already read. */
export const openSetupNeeds = (setup: Answers | null | undefined) => missingNeeds(SETUP_PLAYBOOK, setup ?? {});

/** Is there setup waiting on this person? The dot on the door that holds these rows (a mark, never
 *  a count): not walked through yet, or the company still has open questions. */
export const setupWaiting = ({ isStaff, onboarded, setup }: { isStaff: boolean; onboarded: boolean; setup?: Answers | null }): boolean =>
  isStaff && (!onboarded || openSetupNeeds(setup).length > 0);

/** The lessons Show Me How lists: only those whose switch is on, in their own words. */
export function lessonRows(features: FeatureMap | null | undefined, nortOn: boolean): LessonRow[] {
  return LESSONS.filter((l) => lessonOn(l, features)).map((l) => ({
    key: l.key,
    label: l.title,
    sub: lessonBlurb(l, nortOn),
    request: `lesson:${l.key}` as SetupRequest,
  }));
}

export function helpRows({
  isStaff,
  onboarded,
  setup,
  nortOn,
  features,
}: {
  isStaff: boolean;
  /** profiles.onboarded_at (0180): has THIS PERSON been walked through. */
  onboarded: boolean;
  setup?: Answers | null;
  nortOn: boolean;
  features?: FeatureMap | null;
}): HelpRow[] {
  if (!isStaff) return [];
  const rows: HelpRow[] = [];
  const open = openSetupNeeds(setup);
  // THE OLD CAP'S STATES, LOUDEST FIRST: never walked through → Start Here (the tour, which asks
  // the questions itself; the questions alone with Nort off, since the tour is Nort talking);
  // walked through but questions open → Finish Setting Up, straight to the questions.
  if (!onboarded) {
    rows.push({
      key: "start",
      label: "Start Here",
      sub: nortOn ? "Nort shows you around, out loud, and asks what he needs." : "A few questions about the business, and where everything lives.",
      request: nortOn ? "tour" : "questions",
    });
  } else if (open.length) {
    rows.push({
      key: "finish",
      label: `Finish Setting Up · ${open.length} Left`,
      sub: `Still missing: ${open.map((n) => (n.label ?? n.key).toLowerCase()).join(", ")}.`,
      request: "finish",
    });
  }
  const lessons = lessonRows(features, nortOn);
  if (lessons.length) {
    rows.push({ key: "lessons", label: "Show Me How", sub: `${lessons.map((l) => l.label).join(", ")}.`, lessons });
  }
  rows.push({
    key: "again",
    label: "Take The Setup Again",
    sub: nortOn ? "The walk-through from the top. Change anything you told Nort." : "The setup questions from the top. Change any answer.",
    request: nortOn ? "tour" : "questions",
  });
  return rows;
}

/**
 * OPEN A SETUP SCREEN, INSIDE THE TAP. iOS only plays sound from an element a gesture touched, and
 * the tour's first line is spoken from an effect after the driver mounts — outside the gesture.
 * Unlocking here, in the row's own click, is what lets Start Here speak on an iPhone. The event is
 * dispatched in the same call, so SetupHost (mounted once in the app layout) opens it even though
 * the sheet the row sat in is closing.
 */
export function openSetup(request: SetupRequest): void {
  unlockAudio();
  window.dispatchEvent(new CustomEvent<SetupRequest>(SETUP_EVENT, { detail: request }));
}

/**
 * TALK TO NORT, INSIDE THE TAP. dispatchEvent runs its listeners before it returns, so
 * GlobalAssistant's launch() — which starts the mic — runs inside this click's call stack. iOS only
 * honours a microphone start inside the user gesture: a setTimeout or an await before this line is
 * the old "the mic never starts on iPhone" bug.
 */
export function talkToNort(): void {
  window.dispatchEvent(new Event(NORT_TALK_EVENT));
}
