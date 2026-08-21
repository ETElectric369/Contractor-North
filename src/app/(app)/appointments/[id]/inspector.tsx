"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Camera, Check, ClipboardList, CloudOff, FileText, Loader2, Plus, Trash2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { MediaLightbox } from "@/components/media-lightbox";
import { createClient } from "@/lib/supabase/client";
import { prepareImageForUpload } from "@/lib/image-prep";
import { coerceByPlaybook, retiredAnswers, retiredLabel } from "@/lib/playbook/answers";
import { ACCEPT_ATTR, isAllowedUpload, uploadDisplayName } from "@/lib/playbook/uploads";
import { scopeTotal, type ScopePick } from "@/lib/playbook/scopes";
import { playbookForForm } from "@/lib/playbook/parse";
import { applicableNeeds, clearInapplicable, isAnswered, isOpen, isSettled, missingNeeds, splitAsk } from "@/lib/playbook/resolve";
import type { Answers, AnswerValue, Need, Playbook } from "@/lib/playbook/types";
import { briefProvenanceKeys, computeBriefFills, type PlanBrief } from "@/lib/plan-brief";
import {
  captureId,
  inspectorReadiness,
  looseNumber,
  parseInspectorCapture,
  type CaptureItem,
  type CaptureMeasure,
} from "@/lib/inspection/capture";
import { createStarterInspectionSheet } from "../../forms/actions";
import { AddressAutocomplete } from "@/components/address-autocomplete";
import { LinkPicker } from "./link-picker";
import { TellNort } from "@/components/tell-nort";
import { hearIntoPlaybook } from "../hear-actions";
import { saveInspectionAnswers, saveInspectionCapture, setAppointmentPlace } from "../actions";

/** A numeric field that can be EMPTY. Deliberately not NumberInput: its value is a `number` and
 *  it renders 0 as blank, so "I didn't count it" and "zero of them" become the same stored value —
 *  and a silent zero reads as a real measurement all the way to a customer's price. */
function NumBox({
  value,
  onValue,
  className,
  onFocus,
  onBlur,
}: {
  value: number | null;
  onValue: (n: number | null) => void;
  className?: string;
  /** Same keyboard-stealing bug as the prose boxes: the first DIGIT flips isAnswered, the field
   *  moves to another branch of the tree, and iOS takes the keyboard with it. A measurement is
   *  rarely one digit. */
  onFocus?: () => void;
  onBlur?: () => void;
}) {
  return (
    <Input
      autoComplete="off"
      inputMode="decimal"
      value={value === null ? "" : String(value)}
      className={className}
      onFocus={onFocus}
      onBlur={onBlur}
      onChange={(e) => onValue(looseNumber(e.target.value))}
    />
  );
}

/** Which chips are lit, whatever shape the answer is stored in.
 *  The boolean case is the OLD checkbox renderer's value: a sheet checkbox is a two-option select
 *  in the playbook, so `true` must still light "Yes" rather than quietly lighting nothing. */
const chosen = (v: AnswerValue | undefined): string[] => {
  if (v === true) return ["Yes"];
  if (v === false) return ["No"];
  if (Array.isArray(v)) return v.map(String);
  if (v === null || v === undefined || v === "") return [];
  return [String(v)];
};

export interface CapturePhoto {
  path: string;
  url: string | null;
}
/** `playbook` (0179) is what it asks; `schema` is the older, smaller way of saying the same thing
 *  and is what every form still carries. See playbookForForm — one wins, and it is never both. */
export type InspectionTemplate = { id: string; name: string; schema: unknown; playbook?: unknown };
export type BookRow = { code: string; description: string; unit: string; price: number };

/**
 * ONE SMART INSPECTOR.
 *
 * Erik: "there are notes, measurements, etc then there is the thing you built when in reality it
 * should all be one smart thing that starts with the appointed questions and fragments from those
 * first … all the things need to be available that could build an estimate and they have to be in
 * the inspector … no nothing gets ruled out but get smarter about simplifying the process."
 *
 * What this replaces: a three-textarea capture card, and BELOW it a separate typed question sheet.
 * Two components, two Save buttons, and prose placeholders that said "the questions above" while
 * the questions were below. The person walking the job had to know which box was which.
 *
 * THE SHAPE — two zones and a bar.
 *
 *   ZONE A, THE ASK. One question at the top: what kind of work is this. Answer it and only the
 *   questions that apply to that answer appear. This is not new logic — showIf/visibleFields
 *   shipped and are tested; what is new is that they are the FIRST thing on the screen instead of
 *   the last. An answered question leaves the ask and reappears in Zone B, so the top of the
 *   screen is always "what's still open" and never a wall.
 *
 *   ZONE B, WHAT WE'VE GOT. Everything captured, in one list: answers, measurements, materials,
 *   photos, notes. Every row is editable in place — tap it and you are editing the same value in
 *   the same field, not a copy. NOTHING IS REMOVED: the three prose boxes are still here, because
 *   the sentence nobody anticipated ("the meter base is pulling away from the wall") is often the
 *   one that saves the job.
 *
 *   THE BAR. What is captured, and the one button that turns it into money.
 *
 * IT SAVES ITSELF. A capture is not a document you decide to commit — you are in a crawlspace and
 * it should just persist. Debounced, patch-only (see saveInspectionCapture for why never a
 * snapshot), and answers and capture are separate columns so they save independently.
 *
 * ── WHAT IT RENDERS FROM (cn-v628) ──────────────────────────────────────────────────────────
 *
 * A PLAYBOOK, not a sheet. The stored `forms.schema` is unchanged — playbookFromSheet converts it
 * on the way in — but everything on screen now comes from lib/playbook/resolve, which is the same
 * resolver the interview will speak through. That is the whole reason for the swap: the cold path
 * and the warm path can no longer disagree about what is still missing.
 *
 * Three things it buys immediately, all of which failed Erik at 13125 Moraine Rd:
 *   - the LABEL IS A SENTENCE (`need.ask`). His sheet had a field called "Panel"; he typed 2 into
 *     it and then 2 again into the next box, because a heading transmits nothing about the answer.
 *   - MULTI-SELECT. His job was outlets AND lights. A router that holds one value is why the sheet
 *     then asked him panel questions about a circuits job.
 *   - `when` IS A CONJUNCTION and clearing ITERATES. A rule can wait for two facts, and switching
 *     the work type drops the whole branch below it — not just its first level.
 */
export function Inspector({
  appointmentId,
  templates,
  priceBook,
  initialTemplateId,
  initialAnswers,
  initialCapture,
  initialPhotos,
  orgId,
  userId,
  estimateHref,
  initialLocation,
  linked,
  planBrief = null,
}: {
  appointmentId: string;
  templates: InspectionTemplate[];
  /** The org's own price list, for `scopes` questions. Empty is fine — the picker says so. */
  priceBook: BookRow[];
  initialTemplateId: string | null;
  initialAnswers: Answers;
  initialCapture: unknown;
  initialPhotos: CapturePhoto[];
  orgId: string;
  userId: string | null;
  /** Where "Start the estimate" goes — built by the page so the capture/lead ids ride along. */
  estimateHref: string;
  /** appointments.location — the address, which is the fact that names everything downstream. */
  initialLocation: string;
  /** What this visit is already connected to — a lead, a customer or a job. */
  linked: { kind: "lead" | "customer" | "job"; name: string } | null;
  /** The lead's preliminary plan report (ready only) — server-parsed, so the card is in the
   *  initial HTML and Zone A's height never shifts after mount (the iOS keyboard law). */
  planBrief?: PlanBrief | null;
}) {
  const router = useRouter();
  const stored = useMemo(() => parseInspectorCapture(initialCapture), [initialCapture]);

  // Only an explicit CHOICE is state. The default is DERIVED, fresh, every render — because the
  // old useState initializer ran exactly once, at mount, and that froze two real people out:
  //
  //   Andrew pressed "Set up my questions", the seed created his form, router.refresh() delivered
  //   it — and templateId was still null from a mount when there were zero templates. So
  //   playbookForForm(undefined) produced an EMPTY playbook, zero open questions, and the green
  //   "That's everything this job needs" on a job he hadn't said a word about. His bug report:
  //   "Set up my questions button link did not go anywhere and gave me a green message."
  //
  //   Erik, with two sheets and an appointment that had never saved a pick, mounted straight into
  //   the same empty-playbook green tick: "That's not everything the job needs, I haven't even
  //   entered anything yet."
  //
  // A frozen default is a decision made from stale facts. Derive it and both bugs cannot exist.
  const [chosenId, setChosenId] = useState<string | null>(initialTemplateId);
  const template = useMemo(() => {
    const chosen = templates.find((x) => x.id === chosenId);
    if (chosen) return chosen;
    // No (surviving) choice: prefer the sheet with a WRITTEN playbook — that's the org's real
    // walk-through, not a converted checklist — else whatever the org has.
    return templates.find((t) => !!t.playbook) ?? templates[0] ?? null;
  }, [templates, chosenId]);
  const templateId = template?.id ?? null;
  const [answers, setAnswers] = useState<Answers>(initialAnswers ?? {});
  const [items, setItems] = useState<CaptureItem[]>(stored.items ?? []);
  const [measures, setMeasures] = useState<CaptureMeasure[]>(stored.measures ?? []);
  const [notes, setNotes] = useState(stored.notes);
  const [materials, setMaterials] = useState(stored.materials);
  const [proseMeasurements, setProseMeasurements] = useState(stored.measurements);
  const [photos, setPhotos] = useState<CapturePhoto[]>(initialPhotos);

  /**
   * AVAILABLE IS NOT VISIBLE.
   *
   * Erik: "it wasnt so much the measurements box in the way it was the subquestions that didnt
   * guide me… when i clicked kind of work i like that responsiveness but my eye left with the
   * measurements box becuase it stuck out permanent right there."
   *
   * I read "nothing gets ruled out" as "everything is always on screen", and those are not the
   * same instruction. Five empty labelled boxes announcing capabilities he wasn't using yet sat
   * between him and the one thing he wanted to do. Nothing is removed — a section appears the
   * moment it HAS something, or the moment he reaches for it, and until then it is one word in a
   * row of chips.
   */
  // Which "Something else" boxes he has opened but not yet typed into. Once there IS text the
  // answer itself carries it, so this only tracks the empty in-between.
  const [otherOpen, setOtherOpen] = useState<string[]>([]);
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const shows = (key: string, hasContent: boolean) => hasContent || opened.has(key);
  const open1 = (key: string) => setOpened((s) => new Set(s).add(key));

  const [place, setPlace] = useState(initialLocation);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [viewing, setViewing] = useState<CapturePhoto | null>(null);
  const [seeding, startSeed] = useTransition();
  const [pending, start] = useTransition();
  const fileRef = useRef<HTMLInputElement>(null);
  const captureRef = useRef<HTMLInputElement>(null);

  const playbook = useMemo<Playbook>(() => playbookForForm(template), [template]);

  // THE ASK is what applies AND is still unanswered. The moment you answer something it leaves
  // the top and shows up below — the top of the screen is never a list of things you've done.
  // ── THE FIELD YOU ARE TYPING IN DOES NOT MOVE ────────────────────────────────────────────
  //
  // Erik, bug 48fbfd6e, filed from 13125 Moraine Rd: "Can't type, keyboard disappears with one
  // click." That inspection's scope still reads "The scope of the job is to add" and stops there.
  // He didn't lose the rest — he could never enter it.
  //
  // THE MECHANISM. A need lives in exactly ONE of three lists, and which one depends on whether it
  // has an answer yet: `ask` while empty, then `spine` or `answered` once it isn't. Those are three
  // separate .map() blocks in three different places in the tree. So the FIRST character he typed
  // flipped isAnswered, moved the need to another branch, and React unmounted the textarea and
  // mounted a new one somewhere else. On iOS an unmounted input takes the keyboard with it. One
  // character per tap, forever.
  //
  // The fix is to hold the classification still while the cursor is in the field, rather than to
  // rearrange the zones: an answer half-typed is not yet an answer, and treating it as one is what
  // moved the furniture out from under him. It reclassifies on blur, which is when he's done.
  const [editingKey, setEditingKey] = useState<string | null>(null);
  // ── AND NEITHER DOES THE CHIP GRID YOU ARE HALF-WAY THROUGH TAPPING ──────────────────────
  //
  // `editingKey` is set by onFocus, and a <button> chip fires no focus event, so it structurally
  // cannot protect a chip row. That is fine for a SINGLE select — one tap is the whole answer, and
  // the need dropping to Zone B afterwards is the rule Erik liked ("answer it and it leaves the
  // top"). It is wrong for a MULTI select, where several taps are the point.
  //
  // What happens without this: tap "Wire" on a nine-category grid, isAnswered goes true on an
  // array of length 1, and the entire grid relocates to a different .map() block further down the
  // page. Taps two and three have to go find it. Worse, pulling ~150px of chips out of the ask
  // block shifts everything below it UP, so a second tap aimed where "Lighting & fans" was a beat
  // ago lands on whatever slid into that spot — a wrong answer on a different question, with no
  // feedback at all. That is bug 48fbfd6e's twin: same cause (the classification moved mid-gesture),
  // different input device.
  //
  // Vivian Builders' Site inspection has EIGHT multi-selects, so this is Andrew's sheet, live.
  //
  // It clears on the next interaction with any other need rather than on a timer, because a timer
  // would make the furniture move on its own schedule instead of his.
  const [multiKey, setMultiKey] = useState<string | null>(null);
  /**
   * THE KEYS WHOSE CLASSIFICATION IS FROZEN — never a masked copy of the answers.
   *
   * cn-v698 held a need still by passing `{...answers, [held]: null}` to the resolver. That froze
   * the zone correctly and ALSO hid the answer from the `when` graph, because applicableNeeds
   * reads the same object — so on Vivian Builders' chain of eight multi-selects, tapping a chip
   * made the question gated on that chip vanish. See missingNeeds' comment: applicability now
   * always reads the real `answers`, and a held key only counts as still-missing.
   */
  //
  // A MAP, NOT A SET (audit 6). cn-v699 made a held key count as still-MISSING, which froze a
  // first-time answer correctly and moved an ALREADY-ANSWERED one: tapping into the scope — an
  // open need pinned in the spine because it is the document everything else refers back to —
  // forced it to "missing" and it left the spine mid-gesture. The hold has to freeze the
  // classification at what it WAS, so the value here is isAnswered captured at hold time.
  const heldWas = useRef(new Map<string, boolean>());
  const held = useMemo(() => {
    const live = [editingKey, multiKey].filter((k): k is string => !!k);
    // Drop remembered holds that have been released, so the NEXT hold on that key reads the
    // classification fresh instead of resurrecting a stale one.
    for (const k of [...heldWas.current.keys()]) if (!live.includes(k)) heldWas.current.delete(k);
    return new Map(live.map((k) => [k, heldWas.current.get(k) ?? false] as const));
  }, [editingKey, multiKey]);
  /**
   * Take a hold, remembering the classification AS IT WAS WHEN THE GESTURE STARTED.
   *
   * ONLY IF NOT ALREADY HELD. Re-capturing on every tap defeats the whole thing: the first tap on
   * a nine-chip grid records "unanswered" and the grid stays put, but the second tap would record
   * "answered" — and the grid would relocate out from under his thumb between taps two and three,
   * which is the exact bug the hold exists to prevent.
   */
  const takeHold = (key: string) => {
    if (!heldWas.current.has(key)) heldWas.current.set(key, isAnswered(answers[key]));
  };
  /** Focusing a field is attention leaving whatever chip grid was being tapped. */
  const focusNeed = (key: string) => {
    takeHold(key);
    setEditingKey(key);
    setMultiKey((k) => (k === key ? k : null));
  };

  const open = useMemo(() => missingNeeds(playbook, answers, held), [playbook, answers, held]);

  // ── THE SPINE STAYS UP TOP ───────────────────────────────────────────────────────────────
  // Erik, looking at the Sara Cain walk-through: "i updated the scope and now its at the bottom
  // and all this other stuff doesnt make sense." He was right about the effect and generous about
  // the cause — nothing broke. The rule above did exactly what it says, and the rule is wrong for
  // one kind of need.
  //
  // A need WITH a control is a question you finish: tap it, it's done, it belongs downstairs. A
  // need with NO control is a sentence he is still writing. The scope is the working document of
  // the whole walk-through — every other answer refers back to it — so demoting it the instant he
  // types into it buries the one thing he's working against underneath six things he isn't.
  //
  // It never actually reached the bottom, which is worth knowing for the next person reading this:
  // it went to first-in-Zone-B, position 7 of 12. What made it READ as gone was two smaller things
  // fixed alongside — Zone B shows `n.label` ("Scope") instead of the sentence he answered, and the
  // open-need control was a fixed 2-row box showing two lines of a 700-character punch list.
  // Answered under a question he has since retired. Read from what's STORED, not from live state —
  // the whole point is that these keys are no longer part of the playbook's shape.
  const retired = useMemo(() => retiredAnswers(playbook, initialAnswers), [playbook, initialAnswers]);

  const spine = useMemo(
    () => applicableNeeds(playbook, answers).filter((n) => isOpen(n) && isSettled(answers, n.key, held)),
    [playbook, answers, held],
  );
  const answered = useMemo(() => {
    const stillOpen = new Set(open.map((n) => n.key));
    // Slotted needs only — an answered OPEN need is now pinned up top, and showing it in both
    // places would put the same textarea on screen twice with two cursors into one value.
    return applicableNeeds(playbook, answers).filter((n) => !stillOpen.has(n.key) && !isOpen(n));
  }, [playbook, answers, open]);
  // What's on screen now vs what's one tap away — see splitAsk. `open` stays the honest count.
  const { ask, reach } = useMemo(() => splitAsk(playbook, answers, opened, held), [playbook, answers, opened, held]);

  const readiness = inspectorReadiness({
    ...stored,
    notes,
    materials,
    measurements: proseMeasurements,
    photos: photos.map((p) => p.path),
    items,
    measures,
  });

  // ── SAVING ─────────────────────────────────────────────────────────────────────────────────
  // Two columns, two independent debounced writes. A patch names only what changed, so an
  // in-flight materials save can never blank notes somebody typed a second later.
  const capturePatchRef = useRef<Record<string, unknown>>({});
  const answersDirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // THE LATEST VALUES, NOT THE ONES THE SCHEDULING RENDER CLOSED OVER.
  //
  // `schedule()` runs inside the event handler for render N and captures render N's `flush`, which
  // read render N's `answers` — the value from BEFORE the setState that just fired. So the
  // debounced write was permanently ONE ANSWER BEHIND: tap the last open question, put the phone
  // in your pocket, and 900ms later it saved everything EXCEPT that answer and then said "Saved".
  // Pressing Save explicitly hid it (flush(true) runs in the current render), which is why it
  // survived — the failure only bites the hands-free path this whole screen exists for.
  //
  // Refs assigned at render time: always the newest value by the time any timeout fires.
  const answersRef = useRef(answers);
  answersRef.current = answers;
  // The unmount/pagehide flush runs OUTSIDE render, so it cannot close over the render's values —
  // it would send whatever they were when the effect was created. Refs, kept current every render.
  const templateIdRef = useRef(templateId);
  templateIdRef.current = templateId;
  const playbookRef = useRef(playbook);
  playbookRef.current = playbook;
  const placeRef = useRef(place);
  placeRef.current = place;

  function queueCapture(patch: Record<string, unknown>) {
    capturePatchRef.current = { ...capturePatchRef.current, ...patch };
    schedule();
  }
  function queueAnswers() {
    answersDirty.current = true;
    schedule();
  }
  function schedule() {
    if (timer.current) clearTimeout(timer.current);
    // Wrapped, not passed by reference: setTimeout hands the callback its timer id, which would
    // arrive as `explicit` and make every autosave claim to be a deliberate press.
    timer.current = setTimeout(() => flush(), 900);
  }
  function flush(explicit = false) {
    const patch = capturePatchRef.current;
    const wantAnswers = answersDirty.current;
    capturePatchRef.current = {};
    answersDirty.current = false;
    const latestPlace = placeRef.current;
    const placeDirty = latestPlace.trim() !== initialLocation.trim();
    if (!Object.keys(patch).length && !wantAnswers && !placeDirty) {
      // Pressing Save when everything is already written must still ANSWER. Silence reads as a
      // dead button, and the whole point of the press is to be told the work is safe.
      if (explicit) setSavedAt(Date.now());
      return;
    }
    // ── A FAILED SAVE MUST KEEP THE WORK AND TRY AGAIN ──────────────────────────────────────
    //
    // Two faults, both fatal in a crawlspace, both found by audit 6.
    //
    // 1. The refs were emptied ABOVE, before the write. Any failure — a server {ok:false}, or the
    //    network rejecting in a dead zone — dropped the patch on the floor. The next keystroke
    //    scheduled a flush carrying only THAT keystroke, so the answers before it were gone with
    //    no trace, and the last thing on screen was a green "Saved" tick.
    // 2. There was no try/catch at all. A rejected fetch inside a transition is an unhandled
    //    rejection, which takes the whole walk-through down to the error boundary — losing every
    //    unsaved answer on a page whose entire promise is that it saves itself.
    //
    // So: restore, say so, and RE-ARM. Newer keystrokes win the merge, because the retry must not
    // resurrect an old value over something he has since corrected.
    const restore = (msg: string) => {
      capturePatchRef.current = { ...patch, ...capturePatchRef.current };
      if (wantAnswers) answersDirty.current = true;
      setSavedAt(null); // a stale green tick must never stand over unwritten work
      setError(msg);
      schedule(); // retry without needing him to type another character
    };
    start(async () => {
      setError(null);
      try {
        if (Object.keys(patch).length) {
          const r = await saveInspectionCapture(appointmentId, patch as never);
          if (!r.ok) return restore(r.error ?? "Couldn't save — still trying.");
        }
        if (latestPlace.trim() !== initialLocation.trim()) {
          const r = await setAppointmentPlace(appointmentId, latestPlace);
          if (!r.ok) return restore(r.error ?? "Couldn't save the address — still trying.");
        }
        if (wantAnswers) {
          const r = await saveInspectionAnswers(appointmentId, templateId, coerceByPlaybook(playbook, answersRef.current) as never);
          if (!r.ok) return restore(r.error ?? "Couldn't save — still trying.");
        }
        setSavedAt(Date.now());
      } catch {
        // No signal. Nothing is lost and nothing is written; it will go as soon as there are bars.
        restore("No signal — your answers are held on this phone and will save when you're back in range.");
      }
    });
  }
  // ── A TAB CLOSING MID-DEBOUNCE MUST NOT EAT THE LAST THING TYPED ─────────────────────────
  //
  // That is what this comment always said. What the code did was CANCEL the timer — which is the
  // opposite: it guaranteed the pending write never happened. Nine hundred milliseconds is a long
  // time in the field, and the two ways out of this page both land inside it:
  //
  //   · "Start the estimate" sits six pixels from Save in the same sticky bar. Type "run 140 ft",
  //     tap it, and the measurement is gone — on the page whose whole promise is that it saves
  //     itself, at the moment the number is about to be turned into money.
  //   · Backgrounding the PWA on iOS, which may never resume this page-life at all.
  //
  // So: FLUSH, don't cancel. Fired directly rather than through flush(), because that path calls
  // setState and start() — a React transition on an unmounting tree does nothing, and the write
  // would be dropped a second way. These are plain promises; a server action already in flight
  // survives the component that started it.
  useEffect(() => {
    const send = () => {
      if (timer.current) clearTimeout(timer.current);
      const patch = capturePatchRef.current;
      capturePatchRef.current = {};
      if (Object.keys(patch).length) void saveInspectionCapture(appointmentId, patch as never).catch(() => {});
      if (answersDirty.current) {
        answersDirty.current = false;
        void saveInspectionAnswers(
          appointmentId,
          templateIdRef.current,
          coerceByPlaybook(playbookRef.current, answersRef.current) as never,
        ).catch(() => {});
      }
    };
    // pagehide covers the iOS case unmount does not: the PWA backgrounded and never resumed.
    // It is the one lifecycle event Safari reliably fires there — beforeunload is not.
    const onHide = () => send();
    window.addEventListener("pagehide", onHide);
    return () => {
      window.removeEventListener("pagehide", onHide);
      send();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appointmentId]);

  const setAnswer = (key: string, value: AnswerValue) => {
    // THE CATCH-ALL RELEASE. Every control funnels through here, so a hold cannot outlive the
    // gesture that took it however somebody moves on — a photo, a scope pick, another question's
    // chip. Without it the last multi answered stays in the ask list reading as unanswered.
    setMultiKey((k) => (k === key ? k : null));
    // Answer, then drop anything that answer just made inapplicable — a stale panel brand must not
    // ride into a lighting estimate as a fact. Iterates to a fixed point, which is the part the
    // sheet's one-pass clear could not do: work → power_source → feed → run_ft is four levels, and
    // one pass leaves an abandoned branch's measurement alive all the way into a price.
    setAnswers((a) => clearInapplicable(playbook, { ...a, [key]: value }));
    queueAnswers();
  };

  // ── THE PRELIMINARY REPORT'S ANSWERS ─────────────────────────────────────────────────────
  // What the plan reading prepared that THIS sheet still has open. Booking an inspection from
  // the lead seeds these server-side; this covers the other orderings — a walk-through booked
  // before the reading finished, or a sheet switched after. FILLS HOLES ONLY, through the same
  // setAnswers/clearInapplicable spine as every other write — never a second write path.
  // computeBriefFills re-coerces against the CURRENT playbook (the brief was coerced against the
  // sheet as it stood at reading time) and simulates the apply, so the count equals exactly what
  // a tap leaves answered — see its doc for the two review findings behind that.
  const rawBriefAnswers = planBrief?.status === "ready" ? (planBrief.answers ?? null) : null;
  const briefFills = useMemo(
    () => (rawBriefAnswers ? computeBriefFills(playbook, rawBriefAnswers, answers) : []),
    [rawBriefAnswers, playbook, answers],
  );
  // MOUNT-STABLE presence (the iOS keyboard law): the card and button exist based on what the
  // brief could fill AT LOAD — filling the last hole disables the button in place, it never
  // unmounts it, because collapsing the card mid-gesture shifts every chip grid below it.
  const briefHadFills = useMemo(
    () => (rawBriefAnswers ? computeBriefFills(playbook, rawBriefAnswers, initialAnswers).length > 0 : false),
    [rawBriefAnswers, playbook, initialAnswers],
  );
  // What the report ALREADY filled before this page opened (the booking seeded it server-side).
  // Andrew read the empty ask-list as "nothing was filled" while his six pre-filled answers sat
  // in Answered below — an answered question leaves the ask by design, so the card must SAY what
  // it answered and where it went. Computed against initialAnswers: mount-stable, never shifts.
  const briefSeededAtLoad = useMemo(() => {
    if (!rawBriefAnswers) return [] as string[];
    const keys = briefProvenanceKeys(playbook, rawBriefAnswers, initialAnswers);
    return playbook.needs.filter((n) => keys.has(n.key)).map((n) => n.label);
  }, [rawBriefAnswers, playbook, initialAnswers]);
  const applyBrief = () => {
    setAnswers((a) => {
      let next = { ...a };
      for (const f of briefFills) if (!isAnswered(next[f.key])) next = { ...next, [f.key]: f.value };
      return clearInapplicable(playbook, next);
    });
    queueAnswers();
    setSavedAt(null);
  };

  // ── PHOTOS ─────────────────────────────────────────────────────────────────────────────────
  async function upload(files: File[]) {
    if (!files.length) return;
    setUploading(true);
    setError(null);
    try {
      const supabase = createClient();
      const added: CapturePhoto[] = [];
      for (const raw of files) {
        // An image gets downscaled for the truck's connection; a document uploads untouched.
        const file = raw.type.startsWith("image/") ? await prepareImageForUpload(raw) : raw;
        const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
        const path = `${orgId}/appointments/${appointmentId}/${Date.now()}-${safe}`;
        const { error: upErr } = await supabase.storage.from("documents").upload(path, file, { upsert: false });
        if (upErr) throw upErr;
        const { data } = await supabase.storage.from("documents").createSignedUrl(path, 3600);
        added.push({ path, url: data?.signedUrl ?? null });
      }
      const next = [...photos, ...added];
      setPhotos(next);
      // Persist immediately — a closed tab must not lose the shots.
      const r = await saveInspectionCapture(appointmentId, { photos: next.map((p) => p.path) });
      if (!r.ok) setError(r.error ?? "Couldn't save the photos.");
      else setSavedAt(Date.now());
    } catch (e: unknown) {
      setError((e as { message?: string })?.message ?? "Upload failed.");
    } finally {
      setUploading(false);
    }
  }

  function removePhoto(p: CapturePhoto) {
    if (!confirm("Remove this?")) return;
    const next = photos.filter((x) => x.path !== p.path);
    setPhotos(next);
    queueCapture({ photos: next.map((x) => x.path) });
  }

  // ── EMPTY STATE ────────────────────────────────────────────────────────────────────────────
  // Never render as nothing. The whole per-trade engine was invisible in production for months
  // because the sheet component returned null when no org had a template.
  const noSheet = templates.length === 0;

  const isImage = (p: string) => /\.(jpe?g|png|gif|webp|heic|heif|avif|bmp)$/i.test(p);
  const fileLabel = (p: string) => (p.split("/").pop() ?? p).replace(/^\d{10,}-/, "");

  const control = (n: Need) => {
    const v = answers[n.key];

    // AN OPEN NEED — no slot, so no typed control can hold it. A box, because he types it himself
    // and Nort fills it in for him; that is the same instruction in both directions, and a
    // question with nowhere to put the answer is a dead end whichever way it got asked.
    if (!n.slot) {
      const text = typeof v === "string" ? v : "";
      return (
        <Textarea
          autoComplete="off"
          onFocus={() => focusNeed(n.key)}
          onBlur={() => setEditingKey((k) => (k === n.key ? null : k))}
          // GROWS WITH WHAT HE WROTE. Sara Cain's scope is 8 lines and ~700 characters; at a fixed
          // 2 rows he could see two of them, which is half of why it read as lost rather than moved.
          rows={Math.min(14, Math.max(3, text.split("\n").length + 1))}
          value={text}
          onChange={(e) => setAnswer(n.key, e.target.value)}
        />
      );
    }

    if (n.slot.type === "select") {
      const { options, multi, other } = n.slot;
      const picked = chosen(v);
      const listed = picked.filter((o) => options.includes(o));
      // WHAT HE TYPED RATHER THAN TAPPED. Derived from the ANSWER, never from local state, so it
      // survives a reload — his sentence has to still be in the box tomorrow.
      const free = picked.find((o) => !options.includes(o)) ?? "";
      const showOther = !!other && (!!free || otherOpen.includes(n.key));
      const put = (opts: string[], text: string) => {
        const all = text.trim() ? [...opts, text] : opts;
        setAnswer(n.key, multi ? (all.length ? all : null) : (all[0] ?? null));
      };
      return (
        <div className="space-y-2">
          {/* Chips, not a dropdown: a select on a phone costs a tap to open, a scroll, and a tap
              to choose. Chips cost one tap and you can read every option at a glance in daylight. */}
          <div className="flex flex-wrap gap-2">
            {options.map((o) => {
              const on = listed.includes(o);
              return (
                <button
                  key={o}
                  type="button"
                  onClick={() => {
                    // MULTI. "2 new circuits one for lights and one for outlets" — outlets AND
                    // lights, both true at once. Deselecting the last one is null, not [], because
                    // an empty array reads as answered-with-nothing and the question would leave
                    // the screen having never been answered.
                    //
                    // HOLD THE GRID STILL while he works through it — see multiKey. Only for a
                    // multi: a single select IS finished in one tap, and dropping it to Zone B
                    // then is the behaviour he asked for, not a bug.
                    if (multi) {
                      takeHold(n.key);
                      setMultiKey(n.key);
                      put(on ? listed.filter((x) => x !== o) : [...listed, o], free);
                    } else {
                      // A single-select tap RELEASES any held grid — including one on another
                      // need. Without this, tapping through a multi question and then answering
                      // something else leaves the first one pinned in the ask list looking
                      // unanswered until a text field happened to take focus.
                      setMultiKey(null);
                      put(on ? [] : [o], "");
                    }
                  }}
                  className={
                    on
                      ? "min-h-[44px] rounded-full border border-brand bg-brand px-4 text-sm font-medium text-white"
                      : "min-h-[44px] rounded-full border border-slate-300 bg-white px-4 text-sm text-slate-700 active:bg-slate-50"
                  }
                >
                  {o}
                </button>
              );
            })}

            {/* THE DOOR IN THE WALL. Erik: "you prompt me with options then a 'other' box i use
                often." Dashed, so it reads as the exit and not as a fifth answer. */}
            {other && (
              <button
                type="button"
                onClick={() => {
                  if (multi) { takeHold(n.key); setMultiKey(n.key); }
                  if (showOther) {
                    // Closing clears what he TYPED — prose stranded behind a hidden box is an
                    // answer nobody can find, which is the failure this file keeps coming back to.
                    // It must not clear what he TAPPED: `multi ? listed : []` threw the chip away
                    // on a single select, so picking "Panel upgrade", opening Other to add a note
                    // and then closing it left the question unanswered. `listed` is empty anyway
                    // when the stored value IS the free text, so this only ever restores.
                    put(listed, "");
                    setOtherOpen((k) => k.filter((x) => x !== n.key));
                  } else setOtherOpen((k) => [...k, n.key]);
                }}
                className={
                  showOther
                    ? "min-h-[44px] rounded-full border border-brand bg-brand px-4 text-sm font-medium text-white"
                    : "min-h-[44px] rounded-full border border-dashed border-slate-400 bg-white px-4 text-sm text-slate-600 active:bg-slate-50"
                }
              >
                Something else
              </button>
            )}
          </div>

          {showOther && (
            <Textarea
              autoComplete="off"
              // THE ONE TEXT CONTROL IN THIS FILE THAT HAD NO FOCUS WIRING. The open textarea, the
              // NumBox and the long-text box all set editingKey; this one never did, so the moment
              // any need carries `other: true` the first character typed here would flip isAnswered,
              // move the need to another .map() block, and take the iOS keyboard with it — bug
              // 48fbfd6e rebuilt inside the door that was meant to fix the wall. It has never bitten
              // because `other` is set on zero of the 56 needs in production. That is luck, not a
              // design, and it runs out the first time somebody ticks the box.
              onFocus={() => focusNeed(n.key)}
              onBlur={() => setEditingKey((k) => (k === n.key ? null : k))}
              rows={Math.min(10, Math.max(2, free.split("\n").length + 1))}
              placeholder="In your own words"
              value={free}
              onChange={(e) => put(multi ? listed : [], e.target.value)}
            />
          )}
        </div>
      );
    }

    if (n.slot.type === "number")
      return (
        <div className="flex items-center gap-2">
          <NumBox
            value={typeof v === "number" ? v : null}
            onValue={(x) => setAnswer(n.key, x)}
            onFocus={() => focusNeed(n.key)}
            onBlur={() => setEditingKey((k) => (k === n.key ? null : k))}
          />
          {n.slot.unit && <span className="shrink-0 text-sm text-slate-500">{n.slot.unit}</span>}
        </div>
      );

    // SCOPES — pick line items off his own price list and put a number on each, here, on site.
    // Erik: "when he chooses remodel he needs to be able to choose from a dropdown of optional
    // line items to add so he can add a value so it can be calculated ... it gets built with the
    // inspection." The rate can be 0.00 in the book on purpose; this is where it gets discovered.
    if (n.slot.type === "scopes") {
      const picked = Array.isArray(v) ? (v as ScopePick[]).filter((x) => x && typeof x === "object") : [];
      const allowed = n.slot.codes?.length ? new Set(n.slot.codes) : null;
      const menu = priceBook.filter((b) => (!allowed || allowed.has(b.code)) && !picked.some((p) => p.code === b.code));
      const setPicks = (next: ScopePick[]) => setAnswer(n.key, next.length ? (next as never) : null);
      return (
        <div className="rounded-lg border border-slate-200 p-2">
          {picked.length > 0 && (
            <ul className="mb-2 space-y-1.5">
              {picked.map((p, idx) => {
                const row = priceBook.find((b) => b.code === p.code);
                return (
                  <li key={p.code} className="flex items-center gap-1.5">
                    <span className="min-w-0 flex-1 truncate text-sm text-slate-700" title={row?.description}>
                      {row?.description || p.code}
                    </span>
                    <NumBox
                      value={p.qty}
                      onValue={(x) => setPicks(picked.map((q, j) => (j === idx ? { ...q, qty: x ?? 1 } : q)))}
                    />
                    <span className="w-8 shrink-0 text-xs text-slate-400">{row?.unit || "EA"}</span>
                    <span className="text-xs text-slate-400">@</span>
                    <NumBox
                      value={p.price}
                      onValue={(x) => setPicks(picked.map((q, j) => (j === idx ? { ...q, price: x ?? 0 } : q)))}
                    />
                    <button
                      type="button"
                      onClick={() => setPicks(picked.filter((_, j) => j !== idx))}
                      className="shrink-0 px-1 text-xs text-slate-400 hover:text-rose-600"
                      aria-label={`Remove ${row?.description || p.code}`}
                    >
                      ×
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {picked.length > 0 && (
            <p className="mb-2 text-right text-sm font-medium text-slate-900">
              {scopeTotal(picked).toLocaleString(undefined, { style: "currency", currency: "USD" })}
            </p>
          )}
          {menu.length ? (
            <Select
              value=""
              onChange={(e) => {
                const row = priceBook.find((b) => b.code === e.target.value);
                if (!row) return;
                // Seed the price from the book — 0.00 for the scopes that are priced on site, which
                // is the whole reason those rows exist. He types over it either way.
                setPicks([...picked, { code: row.code, qty: 1, price: row.price }]);
              }}
            >
              <option value="">Add a line item…</option>
              {menu.map((b) => (
                <option key={b.code} value={b.code}>
                  {b.description || b.code}
                  {b.price > 0 ? ` — $${b.price}/${b.unit}` : ""}
                </option>
              ))}
            </Select>
          ) : (
            <p className="text-xs text-slate-400">
              {priceBook.length ? "That's all of them." : "Add items to your price list and they'll show up here."}
            </p>
          )}
        </div>
      );
    }

    // FILES on the walk-through — the same question type the public door uses, so a playbook can
    // hold "upload the plans" whichever side answers it. Authenticated here, so it goes straight to
    // the private `documents` bucket the rest of the inspector already uses; the answer stores
    // PATHS, matching the public side.
    if (n.slot.type === "file") {
      const have = Array.isArray(v) ? (v as string[]) : [];
      return (
        <div className="rounded-lg border border-dashed border-slate-300 p-2">
          <input
            type="file"
            multiple={n.slot.multi !== false}
            accept={ACCEPT_ATTR}
            disabled={uploading}
            onChange={async (e) => {
              const files = Array.from(e.target.files ?? []);
              e.target.value = "";
              if (!files.length) return;
              setUploading(true);
              setError(null);
              try {
                const supabase = createClient();
                const added: string[] = [];
                for (const raw of files) {
                  if (!isAllowedUpload(raw.name)) throw new Error(`${raw.name} isn't a file type we accept.`);
                  const file = raw.type.startsWith("image/") ? await prepareImageForUpload(raw) : raw;
                  const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
                  const path = `${orgId}/appointments/${appointmentId}/${Date.now()}-${safe}`;
                  const { error: upErr } = await supabase.storage.from("documents").upload(path, file, { upsert: false });
                  if (upErr) throw upErr;
                  added.push(path);
                }
                setAnswer(n.key, [...have, ...added]);
              } catch (err) {
                setError(err instanceof Error ? err.message : "Upload failed.");
              } finally {
                setUploading(false);
              }
            }}
            className="block w-full text-sm text-slate-600 file:mr-3 file:rounded-full file:border-0 file:bg-slate-900 file:px-3 file:py-1.5 file:text-xs file:text-white"
          />
          {have.length > 0 && (
            <ul className="mt-1.5 space-y-0.5">
              {have.map((path) => (
                <li key={path} className="flex items-center justify-between gap-2 text-xs text-slate-600">
                  <span className="truncate">{uploadDisplayName(path)}</span>
                  <button
                    type="button"
                    onClick={() => setAnswer(n.key, have.filter((x) => x !== path))}
                    className="shrink-0 text-slate-400 underline-offset-2 hover:underline"
                  >
                    remove
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      );
    }

    return (n.slot.type === "text" && n.slot.long) ? (
      <Textarea
        autoComplete="off"
        rows={2}
        value={typeof v === "string" ? v : ""}
        onFocus={() => focusNeed(n.key)}
        onBlur={() => setEditingKey((k) => (k === n.key ? null : k))}
        onChange={(e) => setAnswer(n.key, e.target.value)}
      />
    ) : (
      // NO AUTOFILL ON AN ANSWER BOX. Erik, mid-walk-through: "a window to my personal contacts
      // popped up where it shouldnt." Safari heuristically offers Contacts on any bare text input,
      // and a playbook question is the worst possible place for it — he types a customer's name
      // into Scope and the browser then offers his address book over the Materials field.
      <Input
        autoComplete="off"
        value={typeof v === "string" ? v : ""}
        onFocus={() => focusNeed(n.key)}
        onBlur={() => setEditingKey((k) => (k === n.key ? null : k))}
        onChange={(e) => setAnswer(n.key, e.target.value)}
      />
    );
  };

  return (
    <Card className="overflow-hidden p-0">
      {/* ── ZONE A — THE ASK ──────────────────────────────────────────────────────────────── */}
      <div className="border-b border-slate-100 p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-medium">
            <ClipboardList className="h-4 w-4 text-slate-400" />
            Walk-through
          </div>
          {templates.length > 1 && (
            <Select
              value={templateId ?? ""}
              className="max-w-[10rem]"
              onChange={(e) => {
                const next = e.target.value || null;
                if (next === templateId) return;
                // SWITCHING SHEETS IS DESTRUCTIVE, and it used to be destructive SILENTLY: the
                // pick lived in client state only, so the next autosave wrote the OLD template id
                // with answers coerced against the NEW playbook — every key nulled, the previous
                // sheet's answers gone, and nothing on screen saying so. Now it says what it does,
                // clears deliberately (those answers belong to questions that no longer exist),
                // and persists the choice so the two can't disagree again.
                const hasAnswers = Object.values(answers).some(
                  (v) => v !== null && v !== undefined && v !== "" && !(Array.isArray(v) && !v.length),
                );
                if (hasAnswers && !confirm("Switching to a different set of questions clears the answers you've given — they belong to the other sheet. Switch anyway?"))
                  return;
                setChosenId(next);
                setAnswers({});
                queueAnswers();
              }}
            >
              <option value="">Pick a sheet…</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </Select>
          )}
        </div>

        {/* WHERE. First control on the surface, above the first question, because this is the
            fact that names the lead, the estimate, the job and the invoice — and because typing
            it into the title (which is what 4 of 13 real inspections did) was the only way to
            record it before. Saves on resolve/blur, and renames a stock-titled record so a list
            of visits stops reading "Site inspection" six times. */}
        <div className="mt-3">
          <Label className="mb-1.5">Where</Label>
          <AddressAutocomplete
            defaultValue={initialLocation}
            placeholder="Job address"
            onTextChange={(v) => { setPlace(v); schedule(); }}
            onResolved={(parts) => {
              // `formatted` is the full one-line address — appointments.location is a single
              // text column, so the whole thing is what belongs in it.
              const line = parts.formatted || parts.line1 || "";
              setPlace(line);
              // Resolved from autocomplete → the PARTS ride along (0177), so the city is stored
              // rather than left to be guessed out of a string later.
              if (line && line !== initialLocation)
                start(async () => {
                  await setAppointmentPlace(appointmentId, line, { city: parts.city, state: parts.state, zip: parts.zip });
                  router.refresh();
                });
            }}
          />
        </div>

        <LinkPicker appointmentId={appointmentId} linked={linked} seed={place} />

        {/* THE PRELIMINARY REPORT — what the plans already said, above the questions, because it
            answers some of them before anyone asks. Server-parsed prop (height-stable at mount),
            renders only when a ready brief exists (available is not visible), survives the green
            "that's everything" branch by sitting outside the ternary below. */}
        {planBrief?.status === "ready" && (planBrief.summary || briefHadFills || briefSeededAtLoad.length > 0) && (
          <div className="mt-3 rounded-xl border border-sky-200 bg-sky-50/60 p-3">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-sky-700">
              Preliminary report — from the customer&apos;s plans
            </p>
            {planBrief.summary && <p className="mt-1 text-sm text-slate-700">{planBrief.summary}</p>}
            {!!planBrief.scope_included?.length && (
              <p className="mt-1 text-xs text-slate-600">
                <span className="font-semibold">Includes:</span> {planBrief.scope_included.join(" · ")}
              </p>
            )}
            {!!planBrief.scope_excluded?.length && (
              <p className="mt-0.5 text-xs text-slate-600">
                <span className="font-semibold">Excludes:</span> {planBrief.scope_excluded.join(" · ")}
              </p>
            )}
            {!!planBrief.cautions?.length && (
              <p className="mt-1 text-xs text-amber-700">
                <span className="font-semibold">Verify on site:</span> {planBrief.cautions.join(" · ")}
              </p>
            )}
            {!!planBrief.observations?.length && (
              <details className="mt-1">
                <summary className="cursor-pointer text-xs font-medium text-sky-700">
                  More from the plans ({planBrief.observations.length})
                </summary>
                <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-slate-600">
                  {planBrief.observations.map((o, i) => (
                    <li key={i}>{o}</li>
                  ))}
                </ul>
              </details>
            )}
            {briefSeededAtLoad.length > 0 && (
              <p className="mt-1.5 text-xs text-slate-600">
                <span className="font-semibold text-sky-700">Already filled from the plans:</span>{" "}
                {briefSeededAtLoad.join(", ")} — they&apos;re under <span className="font-medium">Answered</span> below,
                edit anything that&apos;s off. The questions still showing here are the ones the plans couldn&apos;t
                answer.
              </p>
            )}
            {briefHadFills && (
              <button
                type="button"
                onClick={applyBrief}
                disabled={!briefFills.length}
                className="mt-2 rounded-lg bg-sky-600 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-sky-700 disabled:bg-slate-300"
              >
                {briefFills.length
                  ? `Fill ${briefFills.length} answer${briefFills.length === 1 ? "" : "s"} from the plans`
                  : "Filled from the plans"}
              </button>
            )}
          </div>
        )}

        {/* SAY IT, OR TAP IT — the same boxes either way. Above the questions because that is the
            order it happens on a job: he talks first, and what's left over is what gets asked. */}
        {!noSheet && (
          <TellNort
            hear={(a, said) => hearIntoPlaybook(appointmentId, templateId, a, said)}
            answers={answers}
            hint={ask[0]?.ask}
            onFilled={(next, filled, note) => {
              setAnswers(next);
              queueAnswers();
              if (filled.length) setSavedAt(null);
              // WHAT IT COULDN'T PLACE GOES IN THE NOTES, VERBATIM, and the box opens so he sees
              // it land. Losing the one sentence nobody's template anticipated is the failure this
              // whole capture exists to prevent.
              if (note) {
                open1("notes");
                setNotes((n) => {
                  const merged = n.trim() ? `${n.trim()}\n${note}` : note;
                  queueCapture({ notes: merged });
                  return merged;
                });
              }
            }}
          />
        )}

        {/* THE SPINE, PINNED. Outside the ternary below on purpose: the green "that's everything"
            branch replaces the whole ask block, and the moment he finishes the last question is the
            worst possible moment for the scope to vanish. Labelled with the SENTENCE he answered,
            not the short heading — "Scope" tells him nothing about the 700 characters underneath. */}
        {spine.map((n) => (
          <div key={n.key} className="mt-3">
            <Label className="mb-1">{n.ask}</Label>
            {n.why && <p className="mb-1.5 line-clamp-2 text-xs leading-snug text-slate-500">{n.why}</p>}
            {control(n)}
          </div>
        ))}

        {noSheet ? (
          <div className="mt-3">
            <p className="text-sm text-slate-500">
              You don&rsquo;t have a set of walk-through questions yet. Start with the ones for your trade —
              one question at a time, and only what applies to the job in front of you.
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <Button
                type="button"
                disabled={seeding}
                onClick={() =>
                  startSeed(async () => {
                    const r = await createStarterInspectionSheet();
                    if (!r.ok) setError(r.error ?? "Couldn't set that up.");
                    else router.refresh();
                  })
                }
              >
                {seeding ? <><Loader2 className="h-4 w-4 animate-spin" /> Setting up…</> : "Set up my questions"}
              </Button>
              <Link href="/forms" className="text-sm text-slate-500 underline-offset-2 hover:underline">or build my own</Link>
            </div>
          </div>
        ) : open.length === 0 ? (
          <p className="mt-3 flex items-center gap-1.5 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
            <Check className="h-4 w-4" /> That&rsquo;s everything this job needs.
          </p>
        ) : (
          <div className="mt-3 space-y-4">
            {/* AVAILABLE IS NOT VISIBLE, applied to the questions themselves.
                An OPEN need (no control) is a sentence Nort is meant to phrase and hear, so it
                renders nothing until it is reached for — otherwise "anything that'll bite us?"
                is an empty box sitting between him and the work, which is the exact complaint:
                "my eye left with the measurements box becuase it stuck out permanent right there."
                ONE EXCEPTION, and it is the whole point of the flag: a HOLD always shows. "Don't
                let me price without this" cannot be a thing you have to go looking for. */}
            {ask.map((n) => (
              <div key={n.key}>
                {/* THE SENTENCE, not the heading. His sheet had a field called "Panel" — he typed
                    2 into it and then 2 again into the next box, because a heading transmits
                    nothing about the answer it wants. */}
                <Label className="mb-1">{n.ask}</Label>
                {n.hold && (
                  <span className="mb-1.5 ml-2 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">
                    before you price it
                  </span>
                )}
                {/* HIS OWN REASON, on his own screen. Two lines, because the why is the fuel and
                    the fuel is what makes a question feel like guidance instead of a form. */}
                {n.why && <p className="mb-1.5 line-clamp-2 text-xs leading-snug text-slate-500">{n.why}</p>}
                {control(n)}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── ZONE B — WHAT WE'VE GOT ───────────────────────────────────────────────────────── */}
      <div className="space-y-5 p-4">
        {/* ANSWERED UNDER A QUESTION THAT NO LONGER EXISTS. Erik: "a bunch of info is missing and i
            found it in the playbook in those questions i deleted." It was never shown because the
            inspector only renders needs the playbook declares, so retiring a question made its
            answer invisible — and then the next autosave deleted it. It survives now (see
            retiredAnswers); this is where he can see it and move it somewhere that still exists. */}
        {Object.keys(retired).length > 0 && (
          <div>
            <SectionLabel>From questions you&rsquo;ve since changed</SectionLabel>
            <p className="mt-1 text-xs text-slate-500">
              You answered these on site, then edited your questions. Nothing was lost — copy anything
              still worth keeping into the boxes above.
            </p>
            <div className="mt-2 space-y-3">
              {Object.entries(retired).map(([k, t]) => (
                <div key={k} className="rounded-lg border border-amber-200 bg-amber-50/60 p-3">
                  <div className="text-[11px] uppercase tracking-wide text-amber-700">{retiredLabel(k)}</div>
                  <p className="mt-1 whitespace-pre-wrap text-sm text-slate-700">{t}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        {answered.length > 0 && (
          <div>
            <SectionLabel>Answered</SectionLabel>
            <div className="mt-2 space-y-3">
              {answered.map((n) => (
                <div key={n.key} className="rounded-lg bg-slate-50 p-3">
                  {/* The SHORT label down here — the sentence did its job upstairs; a recap of
                      twelve full questions is a wall. */}
                  <div className="text-[11px] uppercase tracking-wide text-slate-400">{n.label}</div>
                  <div className="mt-1.5">{control(n)}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* MEASUREMENTS — still always available, now not always VISIBLE. Typed rows for what a
            kit can size itself from, plus the prose box for the shape a number can't hold. */}
        {shows("measures", measures.length > 0 || !!proseMeasurements.trim()) && (
        <div>
          <SectionLabel>Measurements</SectionLabel>
          <div className="mt-2 space-y-2">
            {measures.map((m, i) => (
              <div key={m.id} className="flex items-center gap-2">
                <Input
                  value={m.label}
                  placeholder="what you measured"
                  onChange={(e) => {
                    const next = measures.map((x, j) => (j === i ? { ...x, label: e.target.value } : x));
                    setMeasures(next);
                    queueCapture({ measures: next });
                  }}
                />
                <NumBox
                  value={m.value}
                  className="w-24"
                  onValue={(n) => {
                    const next = measures.map((x, j) => (j === i ? { ...x, value: n } : x));
                    setMeasures(next);
                    queueCapture({ measures: next });
                  }}
                />
                <Input
                  value={m.unit}
                  placeholder="ft"
                  className="w-16"
                  onChange={(e) => {
                    const next = measures.map((x, j) => (j === i ? { ...x, unit: e.target.value } : x));
                    setMeasures(next);
                    queueCapture({ measures: next });
                  }}
                />
                <button
                  type="button"
                  onClick={() => {
                    const next = measures.filter((_, j) => j !== i);
                    setMeasures(next);
                    queueCapture({ measures: next });
                  }}
                  className="shrink-0 rounded-md p-2 text-slate-400 active:bg-slate-100"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
            <AddRow
              label="Add a measurement"
              onClick={() => setMeasures([...measures, { id: captureId(), label: "", value: null, unit: "" }])}
            />
            <Textarea
              rows={2}
              value={proseMeasurements}
              placeholder="Anything a number doesn't hold — “35' to the far corner, uphill”."
              onChange={(e) => {
                setProseMeasurements(e.target.value);
                queueCapture({ measurements: e.target.value });
              }}
            />
          </div>
        </div>
        )}

        {/* MATERIALS — a list you or Nort can add to, PLUS the paragraph box. Both, still. */}
        {shows("items", items.length > 0 || !!materials.trim()) && (
        <div>
          <SectionLabel>Materials</SectionLabel>
          <div className="mt-2 space-y-2">
            {items.map((it, i) => (
              <div key={it.id} className="flex items-center gap-2">
                <Input
                  value={it.description}
                  placeholder="what you need"
                  onChange={(e) => {
                    const next = items.map((x, j) => (j === i ? { ...x, description: e.target.value } : x));
                    setItems(next);
                    queueCapture({ items: next });
                  }}
                />
                <NumBox
                  value={it.quantity}
                  className="w-20"
                  onValue={(n) => {
                    const next = items.map((x, j) => (j === i ? { ...x, quantity: n } : x));
                    setItems(next);
                    queueCapture({ items: next });
                  }}
                />
                <Input
                  value={it.unit}
                  className="w-16"
                  onChange={(e) => {
                    const next = items.map((x, j) => (j === i ? { ...x, unit: e.target.value } : x));
                    setItems(next);
                    queueCapture({ items: next });
                  }}
                />
                <button
                  type="button"
                  onClick={() => {
                    const next = items.filter((_, j) => j !== i);
                    setItems(next);
                    queueCapture({ items: next });
                  }}
                  className="shrink-0 rounded-md p-2 text-slate-400 active:bg-slate-100"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
            <AddRow
              label="Add a material"
              onClick={() => setItems([...items, { id: captureId(), description: "", quantity: null, unit: "ea" }])}
            />
            <Textarea
              rows={2}
              value={materials}
              placeholder="Or just type it — “roughly 200' of 12-2, a couple of 20A breakers”."
              onChange={(e) => {
                setMaterials(e.target.value);
                queueCapture({ materials: e.target.value });
              }}
            />
          </div>
        </div>
        )}

        {/* PHOTOS — DELIBERATELY ALWAYS VISIBLE, unlike the others. "i exited stage left and took
            some pictures like i normally do to look at later" — the camera is the one thing that
            gets reached for on every job whether the rest of this screen helps or not. Hiding it
            behind a chip would be tidiness at the cost of the single most-used control. */}
        <div>
          <div className="flex items-center justify-between">
            <SectionLabel>Photos &amp; documents</SectionLabel>
            <div className="flex gap-2">
              <Button type="button" variant="secondary" disabled={uploading} onClick={() => captureRef.current?.click()}>
                {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Camera className="h-4 w-4" />} Take
              </Button>
              <Button type="button" variant="secondary" disabled={uploading} onClick={() => fileRef.current?.click()}>
                <Upload className="h-4 w-4" /> Add
              </Button>
            </div>
          </div>
          <input ref={fileRef} type="file" multiple accept="image/*,application/pdf" className="hidden"
                 onChange={(e) => { upload(Array.from(e.target.files ?? [])); e.target.value = ""; }} />
          <input ref={captureRef} type="file" accept="image/*" capture="environment" className="hidden"
                 onChange={(e) => { upload(Array.from(e.target.files ?? [])); e.target.value = ""; }} />
          {photos.length === 0 ? (
            <p className="mt-2 rounded-lg bg-slate-50 px-3 py-3 text-center text-xs text-slate-400">
              Whatever you&rsquo;d want to look at again from the office.
            </p>
          ) : (
            <div className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-4">
              {photos.map((p) => (
                <div key={p.path} className="group relative aspect-square overflow-hidden rounded-lg bg-slate-100">
                  {isImage(p.path) ? (
                    <button type="button" onClick={() => p.url && setViewing(p)} className="h-full w-full">
                      {p.url && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={p.url} alt="" className="h-full w-full object-cover" />
                      )}
                    </button>
                  ) : (
                    <a href={p.url ?? "#"} target="_blank" rel="noopener noreferrer"
                       className="flex h-full w-full flex-col items-center justify-center gap-1 p-2 text-center">
                      <FileText className="h-6 w-6 shrink-0 text-slate-400" />
                      <span className="line-clamp-2 break-all text-[10px] leading-tight text-slate-500">{fileLabel(p.path)}</span>
                    </a>
                  )}
                  <button
                    type="button"
                    onClick={() => removePhoto(p)}
                    // Always visible, not hover-revealed: there is no hover on a phone.
                    className="absolute right-1 top-1 rounded-md bg-black/50 p-1 text-white"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* NOTES — the escape hatch. The sentence nobody's template anticipated. */}
        {shows("notes", !!notes.trim()) && (
          <div>
            <SectionLabel>Notes</SectionLabel>
            <Textarea
              rows={3}
              className="mt-2"
              value={notes}
              placeholder="Anything the questions didn't cover."
              onChange={(e) => {
                setNotes(e.target.value);
                queueCapture({ notes: e.target.value });
              }}
            />
          </div>
        )}

        {/* THE ONE ROW THAT REPLACES FOUR EMPTY BOXES. Nothing is ruled out — everything is one
            tap away and says so. This is the whole "available is not visible" change: a capability
            he isn't using yet is a word, not a container. */}
        {(() => {
          const hidden = [
            // The open questions that aren't holds ride in the SAME row as the capture sections,
            // because they are the same kind of thing: something you can reach for, named, not a
            // box announcing itself. Tap one and its question opens upstairs with the rest.
            ...reach.map((n) => ({ k: n.key, label: n.label, on: () => open1(n.key) })),
            { k: "measures", label: "Measurement", on: () => { open1("measures"); setMeasures((m) => [...m, { id: captureId(), label: "", value: null, unit: "" }]); } },
            { k: "items", label: "Material", on: () => { open1("items"); setItems((i) => [...i, { id: captureId(), description: "", quantity: null, unit: "ea" }]); } },
            { k: "notes", label: "Note", on: () => open1("notes") },
          ].filter((x) => !shows(x.k, false));
          if (!hidden.length) return null;
          return (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[11px] uppercase tracking-wide text-slate-400">Add</span>
              {hidden.map((h) => (
                <button
                  key={h.k}
                  type="button"
                  onClick={h.on}
                  className="flex min-h-[36px] items-center gap-1 rounded-full border border-dashed border-slate-300 px-3 text-sm text-slate-500 active:bg-slate-50"
                >
                  <Plus className="h-3.5 w-3.5" /> {h.label}
                </button>
              ))}
            </div>
          );
        })()}
      </div>

      {/* ── THE BAR ───────────────────────────────────────────────────────────────────────── */}
      <div className="sticky bottom-0 flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 bg-white/95 px-4 py-3 backdrop-blur">
        <div className="text-xs text-slate-500">
          {/* Counts, never confidence. */}
          {[
            open.length > 0 ? `${open.length} still open` : "all questions answered",
            readiness.items ? `${readiness.items} materials` : null,
            readiness.measures ? `${readiness.measures} measurements` : null,
            readiness.photos ? `${readiness.photos} photos` : null,
          ].filter(Boolean).join(" · ")}
          <span className="ml-2">
            {pending ? (
              <span className="text-slate-400">saving…</span>
            ) : error ? (
              <span className="text-rose-600"><CloudOff className="mr-1 inline h-3 w-3" />{error}</span>
            ) : savedAt ? (
              <span className="font-medium text-emerald-700"><Check className="mr-0.5 inline h-3 w-3" />Saved</span>
            ) : null}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {/* THE SAVE BUTTON IS BACK, and autosave stays underneath it.
              Erik: "when i start and complete an inspection and im not ready to start the estimate
              i want to be able to save it and the save button is gone."
              I removed it because a capture persists itself, and that reasoning was wrong: autosave
              protects the DATA, it does not tell a person they are DONE. Walking away from a job
              needs an act — something to press that answers "did that stick?" before you get in the
              truck. So this flushes anything still in the debounce and says so out loud. */}
          <Button
            type="button"
            variant="secondary"
            disabled={pending}
            onClick={() => {
              if (timer.current) clearTimeout(timer.current);
              flush(true);
            }}
          >
            {pending ? <><Loader2 className="h-4 w-4 animate-spin" /> Saving…</> : <><Check className="h-4 w-4" /> Save</>}
          </Button>
          <Link href={estimateHref}>
            <Button type="button">Start the estimate</Button>
          </Link>
        </div>
      </div>

      {viewing?.url && <MediaLightbox url={viewing.url} name={fileLabel(viewing.path)} onClose={() => setViewing(null)} />}
    </Card>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{children}</div>;
}

function AddRow({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-h-[44px] w-full items-center gap-1.5 rounded-lg border border-dashed border-slate-300 px-3 text-sm text-slate-500 active:bg-slate-50"
    >
      <Plus className="h-4 w-4" /> {label}
    </button>
  );
}
