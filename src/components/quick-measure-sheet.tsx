"use client";

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Box, Check, Loader2 } from "lucide-react";
import { Modal, ModalActions } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { useLang } from "@/components/lang-provider";
import { fillText, translator } from "@/lib/i18n";
import { featureOn, type FeatureMap } from "@/lib/features";
import { megabytes } from "@/lib/upload-words";
import {
  askMeasureContext,
  closeMeasureSheet,
  heldModel,
  heldModelOf,
  measureHost,
  measureOwnerKey,
  measureStore,
  releaseHeldModel,
  setMeasureOwner,
  subscribeMeasure,
  whereIsHe,
  type HeldModel,
  type MeasureContext,
  type MeasureFigure,
  type MeasurePlace,
  type OpenResult,
} from "@/lib/quick-measure";
import {
  discardModel,
  finishSavingModel,
  forgetFigure,
  forgetMeasureVisitOf,
  modelTrip,
  saveMeasureToJob,
  saveModelToJob,
  startInspectionWith,
  visitMadeFor,
  type MeasureSaved,
  type SaveDoor,
  type SaveWords,
} from "@/lib/quick-measure-save";

/**
 * THE ONE RESULT SHEET OF MEASURE FROM THE + (cn-v1160). Mounted once by the + (GlobalQuickAdd), beside
 * Snap or Note's; it draws nothing while lib/quick-measure's store has no result open.
 *
 * The owner asked for the three Lidar tools from anywhere. On a visit he can write, the + runs the
 * Inspector's own flow and this sheet never opens. ANYWHERE ELSE the figure or the model has no home
 * yet, and this sheet is where it gets one. THE RULE IT KEEPS: nothing is filed by guess, and every
 * way out of an unsaved result is a save or a discard he was told about.
 *
 *   · WHERE HE IS decides the doors (sheetDoors, a pure function): the job whose page he is on, the
 *     job he is clocked on, a new inspection (with Leads & Inspections on), or, for a model reopened
 *     on a visit, that visit. Don't Keep It is always the last one.
 *   · A LENGTH OR AN AREA IS NEVER HELD: closing drops it, so the X, a tap outside and Back go through
 *     the Modal's own two-tap guard (`dirty`) while it is unsaved.
 *   · A 3D MODEL IS NEVER DROPPED BY CLOSING: it waits in the +, and the sheet says so. Letting go of
 *     one is a second, deliberate step.
 *   · NO DOOR IS DRAWN UNTIL THE SHEET KNOWS WHO IS ON THE PHONE and the job he is clocked on (one
 *     read, POST /api/measure/context through askMeasureContext, asked while he is still measuring so
 *     the answer is usually waiting): a door that arrived late would slide under a finger aimed at
 *     another. A clock that could not be read is said, with Try Again, never drawn as "not on the
 *     clock".
 *
 * NEVER KEYED, NEVER REMOUNTED (the cn-v1156 law: a key around an open Modal makes the new one close
 * itself). There is ONE Modal for the life of the +, and what is inside it starts over with state:
 * each result that opens is a new SITTING, and everything the sheet remembers carries its sitting's
 * number, so an answer that comes back for a sitting that has ended lands nowhere.
 *
 * NEVER CLOSED AND NAVIGATED IN ONE TICK (the overlay history reads that as a Back and throws the
 * navigation away): the push goes out with the sheet still open, and the sheet goes once the address
 * has changed.
 *
 * No English literal lives here: this file is one the leak scan reads.
 */

// ── WHICH DOORS, FROM WHERE HE IS ──────────────────────────────────────────────────────────────

/** A way out of the sheet. `job` is a job's label ("J-047 · Larkspur"). */
export type SheetDoor =
  | { id: "visit" }
  | { id: "thisJob"; jobId: string }
  | { id: "clockJob"; jobId: string; job: string }
  /** The file is up and the job's row is owed: this writes the row alone. `job` is null when the
   *  job is not the one he is clocked on (its label is not known here). */
  | { id: "finish"; jobId: string; job: string | null }
  /** `retry`: the visit was made and the result did not save on it; the tap fills THAT visit. */
  | { id: "inspection"; retry: boolean }
  /** The read of who is on the phone failed: ask again. */
  | { id: "askAgain" }
  | { id: "dontKeep" }
  | { id: "done" };

/** A sentence the sheet says, by the catalog key it is under (sh_measure_<line>). */
export type SheetLine = "approx" | "notSaved" | "noPicture" | "onClockThere" | "nowhere" | "modelWaits" | "rowOwed" | "inspectionMadeNotFilled" | "clockUnread";

export type SheetPlan = {
  /** Still asking who is on the phone: no door is drawn yet, so none slides under a finger later. */
  asking: boolean;
  doors: SheetDoor[];
  lines: SheetLine[];
  /** The read's own refusal, in the words it came in. */
  refusal: string | null;
};

/**
 * The doors and the sentences for one result, from where he is. Pure: the address, the read, the
 * result and the company's switches in; the plan out.
 */
export function sheetDoors(o: {
  place: MeasurePlace;
  /** Who is on the phone and the job he is clocked on; null while it is being asked. */
  ctx: MeasureContext | null;
  open: OpenResult;
  /** The model the + holds (a model's sheet is about this). */
  held: HeldModel | null;
  /** A visit Start an Inspection with It already made for THIS result: the fill is what is owed. */
  visitId?: string | null;
  features?: FeatureMap | null;
}): SheetPlan {
  const { place, ctx, open, held } = o;
  const plan = (doors: SheetDoor[], lines: SheetLine[] = [], more: Partial<SheetPlan> = {}): SheetPlan => ({ asking: false, doors, lines, refusal: null, ...more });

  // A refusal has nothing to keep. A model the + no longer holds has nothing to offer but the way out.
  if (open.kind === "refused") return plan([{ id: "done" }]);
  const figure = open.kind === "figure" ? open.figure : null;
  if (!figure && !held) return plan([{ id: "done" }]);

  const lines: SheetLine[] = [];
  if (figure) {
    if (figure.approx) lines.push("approx");
    lines.push("notSaved");
    if (!figure.photo) lines.push("noPicture");
  }

  // THE FILE IS UP ON A JOB AND ONLY ITS ROW IS OWED: one door, the row alone, wherever he is now.
  // Any other save would send the same hundred megabytes a second time.
  if (!figure && held?.landed) {
    const job = ctx?.ok && ctx.punchJob?.id === held.landed.jobId ? ctx.punchJob.label : null;
    return plan([{ id: "finish", jobId: held.landed.jobId, job }, { id: "dontKeep" }], ["rowOwed"]);
  }

  const waits: SheetLine[] = figure ? [] : ["modelWaits"];
  if (!ctx) return plan([], [...lines, ...waits], { asking: true });
  // No answer, no saving (every save needs the company): the one action is to ask again.
  if (!ctx.ok) return plan([{ id: "askAgain" }, { id: "dontKeep" }], [...lines, ...waits], { refusal: ctx.error });

  const doors: SheetDoor[] = [];
  // A job's Photos holds a picture: a figure whose picture did not come back has nothing to file there.
  const fileable = figure ? figure.photo !== null : true;
  if (!figure && place.kind === "visit") doors.push({ id: "visit" });
  if (place.kind === "job" && fileable) doors.push({ id: "thisJob", jobId: place.jobId });
  if (place.kind !== "job" && ctx.punchJob && fileable) {
    doors.push({ id: "clockJob", jobId: ctx.punchJob.id, job: ctx.punchJob.label });
    lines.push("onClockThere");
  }
  if (place.kind === "nowhere" && featureOn(o.features, "leads")) {
    const retry = !!o.visitId;
    doors.push({ id: "inspection", retry });
    if (retry) lines.push("inspectionMadeNotFilled");
  }
  // THE CLOCK COULD NOT BE READ: the job he may be clocked on is unknown, which is never "not on the
  // clock". Said, with the one action, where that job would have been offered (on a job's own page it
  // never is). The other doors stand: who is on the phone was read.
  if (ctx.punchUnread && place.kind !== "job") {
    doors.push({ id: "askAgain" });
    lines.push("clockUnread");
  }
  // Nothing here to save a figure to. (One with no picture has already said why.)
  if (figure && !doors.length && figure.photo) lines.push("nowhere");
  doors.push({ id: "dontKeep" });
  return plan(doors, [...lines, ...waits]);
}

/** The figure as the sheet shows it. "(approx.)" is said as a sentence under it, in his language. */
export function figureOnly(caption: string): string {
  return caption.replace(/\s*\(approx\.\)\s*$/i, "").trim();
}

// ── WHAT THE SHEET REMEMBERS FOR ONE SITTING ───────────────────────────────────────────────────

/** A door's write is out: its answer needs the sheet to land on. */
type Working = SaveDoor | "visit" | "discard" | null;

/** The result left the store (it is saved). What the sheet says about it, and where it may go next. */
export type SheetAfter = {
  /** The saved sentence. Said even when the page it was saved to is on its way: a page that never
   *  arrives (the signal went) must not leave a save with nothing said about it. */
  said: string;
  go: { to: "inspection" | "photos"; href: string; /** The address the sheet waits for before it goes. */ path: string } | null;
};

/** What the sheet remembers for ONE sitting. */
export type SheetMemory = {
  /** The sitting this belongs to. */
  n: number;
  ctx: MeasureContext | null;
  working: Working;
  fault: string | null;
  /** Don't Keep It was tapped on a model: the second step is showing. */
  confirming: boolean;
  after: SheetAfter | null;
};
/** A sitting that remembers nothing yet. */
export const freshSitting = (n: number): SheetMemory => ({ n, ctx: null, working: null, fault: null, confirming: false, after: null });

/**
 * One change to what the sheet remembers, for sitting `n`. The same sitting takes it; a newer sitting
 * starts from nothing and takes it; an OLDER one (an answer that came back after the sheet was closed,
 * or moved on to another result) changes nothing. Pure.
 */
export function patchSitting(cur: SheetMemory, n: number, p: Partial<Omit<SheetMemory, "n">>): SheetMemory {
  if (cur.n === n) return { ...cur, ...p };
  return cur.n < n ? { ...freshSitting(n), ...p } : cur;
}

/**
 * What the sheet remembers once a save has answered. Not saved: the door is free again and the
 * reason is said. Saved to a new inspection: the sentence, and the visit's own address (`go`: the
 * sheet opens it and waits for it). Saved to a job: the sentence, and for a figure the way to that
 * job's Photos unless he is already on the job's own page. `went` is the job a figure was sent to;
 * `pathname` is where he is NOW. Pure.
 */
export function sheetAfterSave(
  r: MeasureSaved,
  o: { went?: string | null; pathname: string | null; t: (key: string) => string },
): Pick<SheetMemory, "working" | "fault" | "after"> {
  if (!r.ok) return { working: null, fault: r.error, after: null };
  if (r.door === "inspection") {
    const path = `/appointments/${r.visitId}`;
    return { working: null, fault: null, after: { said: o.t("sh_measure_savedToInspection"), go: { to: "inspection", href: path, path } } };
  }
  // A model's answer carries no `stamped`: it is on the job's papers.
  if (r.stamped === undefined) return { working: null, fault: null, after: { said: o.t("sh_measure_savedModel"), go: null } };
  const path = o.went ? `/jobs/${o.went}` : null;
  return {
    working: null,
    fault: null,
    after: {
      // Never a claim the figure is on the picture when it could not be drawn there.
      said: o.t(r.stamped ? "sh_measure_savedToPhotos" : "sh_measure_savedToPhotosNamed"),
      go: path && o.pathname !== path ? { to: "photos", href: `${path}?tab=photos`, path } : null,
    },
  };
}

/** A read that has not answered in this long is said as no signal, with Try Again. An answer that
 *  comes after that is not drawn on its own (see askFor). */
export const ASK_PATIENCE_MS = 6000;

/** A link drawn as Button's outline, full width: the sheet's doors are one column. */
const LINK_LOOK =
  "btn-gloss inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-center text-sm font-medium text-slate-800 transition-colors hover:border-[rgb(var(--glass-ink))]/40 hover:bg-[rgb(var(--glass-tint))]/10 hover:text-[rgb(var(--glass-ink))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--glass-ink))] focus-visible:ring-offset-2";

// ── THE SHEET ──────────────────────────────────────────────────────────────────────────────────

export function QuickMeasureSheet({
  features,
}: {
  /** The shell's switch map: Start an Inspection with It is offered only with Leads & Inspections on. */
  features?: FeatureMap | null;
}) {
  const s = useSyncExternalStore(subscribeMeasure, measureStore, measureStore);
  const lang = useLang();
  const t = translator(lang);
  const pathname = usePathname();
  const router = useRouter();

  // A SITTING: one result on the table, from the moment it opens until the sheet goes. A new result
  // is a new sitting (decided while rendering, the way state follows a prop), and what the sheet
  // remembers below belongs to the sitting it carries the number of. `of` keeps the result once it
  // has left the store (saved), so the sheet still shows what it was.
  const [sitting, setSitting] = useState<{ n: number; of: OpenResult | null }>({ n: 0, of: null });
  if (s.open && s.open !== sitting.of) setSitting({ n: sitting.n + 1, of: s.open });
  const [local, setLocal] = useState<SheetMemory>(freshSitting(0));
  const L = local.n === sitting.n ? local : freshSitting(sitting.n);
  const patch = (n: number, p: Partial<Omit<SheetMemory, "n">>) => setLocal((cur) => patchSitting(cur, n, p));
  // The sitting is over: whatever it remembered is dropped with its number. (`of` is left as it
  // is: a result still open in the store would otherwise read as a new one, again and again.)
  const endSitting = () => setSitting((cur) => ({ n: cur.n + 1, of: cur.of }));
  // Open while a result is on the table, while a write is out, and while what became of it is said.
  const show = !!s.open || L.working !== null || L.after !== null;
  // What an answer coming back reads: the sitting and the address as they are NOW, not as they were
  // when its door was tapped.
  const now = useRef(sitting.n);
  now.current = sitting.n;
  const where = useRef(pathname);
  where.current = pathname;
  // THE SHEET IS ON SCREEN FOR AS LONG AS THE + IS, and the + leaving IS the app being left (a
  // sign-out is a soft navigation, and somebody else may be on the phone next). What comes back after
  // that belongs to whoever was here when it was asked: it names nobody and opens no page.
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const words: SaveWords = { lang, t, en: translator("en") };

  // ── WHO IS ON THE PHONE, AND THE JOB HE IS CLOCKED ON ──
  const ask = async (): Promise<MeasureContext> => {
    try {
      const c = await askMeasureContext(t("sh_checkSignal"));
      // Who is on the phone is the store's to know (setMeasureOwner: the same person in the same
      // company gets back what the + holds; a model scanned before anybody was named is the first
      // name's; anyone else starts with nothing held). A failed read names nobody. Never from an answer
      // that outlived the sheet: naming the one who has left would hand what the leaving hid to
      // whoever is here now.
      if (live.current) setMeasureOwner(measureOwnerKey(c));
      return c;
    } catch {
      return { ok: false, error: t("sh_checkSignal") };
    }
  };
  /**
   * Ask for this sitting (or wait on a read already out), and say so if it takes too long.
   *
   * AN ANSWER THAT COMES AFTER THE SHEET SAID SO IS NOT DRAWN ON ITS OWN. By then Try Again and Don't
   * Keep It are on screen, and doors arriving above them would move Don't Keep It under a finger
   * aimed at Try Again (on a figure, that tap is the discard). He taps Try Again: the doors go, the
   * read is asked again, and its answer draws them where nothing was.
   */
  const askFor = (n: number, asked: Promise<MeasureContext> = ask()) => {
    patch(n, { ctx: null, fault: null });
    let saidLate = false;
    const late = setTimeout(() => {
      saidLate = true;
      setLocal((cur) => (cur.n === n && cur.ctx === null ? { ...cur, ctx: { ok: false, error: t("sh_checkSignal") } } : cur));
    }, ASK_PATIENCE_MS);
    void asked.then((c) => {
      clearTimeout(late);
      if (!saidLate) patch(n, { ctx: c });
    });
    return () => clearTimeout(late);
  };

  // ASKED WHILE HE MEASURES: the measuring screen is up for seconds (a scan, minutes), so the read
  // goes out as it opens and its answer is waiting when the sheet draws its doors. Not on a page
  // whose Inspector takes the result itself: no sheet opens there.
  const warm = useRef<{ asked: Promise<MeasureContext>; got: MeasureContext | null } | null>(null);
  useEffect(() => {
    if (!s.busy) {
      // The screen came down with nothing to show (a cancel): its read is not kept for a sheet
      // opened some other time, when he may be clocked on another job.
      if (!measureStore().open) warm.current = null;
      return;
    }
    if (measureHost()) return;
    const w = { asked: ask(), got: null as MeasureContext | null };
    void w.asked.then((c) => {
      w.got = c;
    });
    warm.current = w;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.busy]);

  // A RESULT OPENED. The read asked while he measured is taken as it stands when it answered well
  // (before the first paint, so the doors are whole from the start); otherwise it is asked now. And
  // a model whose save is still on its way (the sheet was closed in the middle of it) is joined,
  // never sent a second time.
  useLayoutEffect(() => {
    const open = measureStore().open;
    if (!open) return;
    const n = sitting.n;
    const w = warm.current;
    warm.current = null;
    // A refusal has nothing to save, so nobody needs asking.
    if (open.kind === "refused") return;
    let stop: (() => void) | undefined;
    if (w?.got?.ok) patch(n, { ctx: w.got });
    else stop = askFor(n, w && !w.got ? w.asked : undefined);
    const trip = open.kind === "model" ? modelTrip() : null;
    if (trip) void land(n, trip.door, trip.done);
    return stop;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sitting.n]);

  // A page's Inspector registers its host in ITS effect, which runs after this sheet has rendered:
  // look again once the page has settled, so a sheet opened as a visit's page arrives sees the visit.
  const [, lookAgain] = useState(0);
  useEffect(() => {
    if (!s.open) return;
    const id = setTimeout(() => lookAgain((x) => x + 1), 0);
    return () => clearTimeout(id);
  }, [pathname, s.open]);

  // THE PAGE HE ASKED FOR IS ON SCREEN: now the sheet goes. Never in the same tick as the push.
  const going = L.after?.go?.path ?? null;
  useEffect(() => {
    if (going && pathname === going) endSitting();
  }, [pathname, going]);

  // The picture, as an address in this page's memory, let go when the figure changes or the sheet goes.
  const photo = show && sitting.of?.kind === "figure" ? sitting.of.figure.photo : null;
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!photo || typeof URL === "undefined" || typeof URL.createObjectURL !== "function") {
      setSrc(null);
      return;
    }
    const url = URL.createObjectURL(photo);
    setSrc(url);
    return () => URL.revokeObjectURL(url);
  }, [photo]);

  // ── THE DOORS' WRITES ──

  /** Wait for a save and say what became of it. `went` is the job a figure was sent to. */
  const land = async (n: number, door: SaveDoor, trip: Promise<MeasureSaved>, went?: { jobId: string }) => {
    patch(n, { working: door, fault: null, confirming: false });
    let r: MeasureSaved;
    try {
      r = await trip;
    } catch {
      r = { ok: false, door, error: t("sh_checkSignal"), final: false };
    }
    // The sheet was closed on it, or the app was left: the save ran its course, and its answer has
    // nowhere to land (and no page is opened for somebody who is not looking at this sheet).
    if (!live.current || now.current !== n) return;
    const next = sheetAfterSave(r, { went: went?.jobId, pathname: where.current, t });
    patch(n, next);
    // The new visit opens WITH THE SHEET STILL UP: closing and pushing in one tick reads as a Back
    // and the navigation is thrown away. The sheet goes when the address has changed (below).
    if (next.after?.go?.to === "inspection") router.push(next.after.go.href);
  };

  /** Save to This Visit: the Inspector takes the model and sends it down its own path. */
  const toVisit = async (n: number) => {
    const held = heldModel();
    const host = measureHost();
    if (!held) return;
    if (!host) return lookAgain((x) => x + 1); // the visit's page is gone: the doors are drawn again for where he is
    patch(n, { working: "visit", fault: null });
    let took = false;
    try {
      took = (await host.adoptModel({ model: held.model, path: held.path, shots: held.shots })) === true;
    } catch {
      took = false;
    }
    if (!took) {
      if (now.current === n) patch(n, { working: null, fault: t("sh_measure_visitBusy") });
      return;
    }
    // The Inspector owns the file from here, the phone's copy with it: the + only lets go. A visit an
    // earlier Start an Inspection with It made for this model is forgotten with it: if the Inspector
    // ever hands the model back, Try Again must never fill that visit behind his back.
    releaseHeldModel();
    forgetMeasureVisitOf(held.model);
    if (now.current === n) endSitting();
  };

  const discard = async (n: number) => {
    patch(n, { working: "discard", fault: null });
    try {
      await discardModel();
    } catch {
      // the + let go of it either way
    }
    if (now.current === n) endSitting();
  };

  /** The X, a tap outside, Escape, Back (each past the Modal's two-tap guard while a figure is
   *  unsaved), Done, and Don't Keep It on a figure. A figure goes; a model stays held in the +. */
  const close = () => {
    const was = measureStore().open;
    endSitting();
    closeMeasureSheet();
    if (was?.kind === "figure") void forgetFigure(was.figure);
  };

  const onDoor = (d: SheetDoor) => {
    if (d.id === "done") return close();
    const open = measureStore().open;
    if (!open || L.working !== null) return;
    const n = sitting.n;
    const ctx = L.ctx?.ok ? L.ctx : null;
    const figure: MeasureFigure | null = open.kind === "figure" ? open.figure : null;
    switch (d.id) {
      case "dontKeep":
        // A model costs a walk to make: letting go of it is a second, deliberate step. A figure goes.
        if (open.kind === "model") return patch(n, { confirming: true, fault: null });
        return close();
      case "askAgain":
        return void askFor(n);
      case "visit":
        return void toVisit(n);
      case "finish":
        return void land(n, "job", finishSavingModel({ words }));
      case "thisJob":
      case "clockJob":
        if (!ctx) return;
        if (figure) return void land(n, "job", saveMeasureToJob({ orgId: ctx.orgId, jobId: d.jobId, figure, words }), { jobId: d.jobId });
        return void land(n, "job", saveModelToJob({ orgId: ctx.orgId, jobId: d.jobId, words }));
      case "inspection":
        if (!ctx) return;
        return void land(n, "inspection", startInspectionWith({ orgId: ctx.orgId, figure, words }));
    }
  };

  // ── WHAT IS DRAWN ──

  const of = show ? sitting.of : null;
  const heldNow = heldModelOf(s);
  const planNow = s.open
    ? sheetDoors({
        place: whereIsHe(pathname, !!measureHost()),
        ctx: L.ctx,
        open: s.open,
        held: heldNow,
        visitId: visitMadeFor(s.open.kind === "figure" ? s.open.figure : s.open.kind === "model" ? heldNow?.model : null),
        features,
      })
    : null;
  // A save lets go of its result a moment before its answer reaches the sheet. For that moment the
  // sheet keeps drawing what it drew (its doors, one of them saying Saving…), so nothing blinks; and
  // while it says what became of a model, it still says which model that was.
  const drawn = useRef<{ plan: SheetPlan | null; held: HeldModel | null }>({ plan: null, held: null });
  if (s.open) drawn.current = { plan: planNow, held: heldNow };
  else if (L.working === null && !L.after) drawn.current = { plan: null, held: null };
  const plan = planNow ?? drawn.current.plan;
  const held = heldNow ?? drawn.current.held;
  // The second step stays on screen while the discard it started is out.
  const confirming = L.confirming && (s.open?.kind === "model" || L.working === "discard");
  // Done only for a refusal or a result with nothing left to do. While the sheet is still asking who
  // is on the phone there are no doors yet, and an empty list is not "only Done": a Done there would
  // let a figure go in one tap, past the Modal's two-tap guard.
  const onlyDone = !!L.after || !plan || (plan.doors.length > 0 && plan.doors.every((d) => d.id === "done"));

  return (
    <Modal
      open={show}
      onClose={close}
      title={of?.kind === "model" ? t("sh_measure_titleModel") : of?.kind === "refused" ? t("vi_lidar") : t("sh_measure_title")}
      size="md"
      dirty={s.open?.kind === "figure" && !L.after}
      holdOpen={L.working !== null}
      footer={
        confirming ? (
          // The question's two answers, in the words the + menu's own second step uses. Both wait
          // while the discard is out: Keep It must never be there to tap once it cannot keep it.
          <>
            <Button type="button" variant="outline" disabled={L.working !== null} onClick={() => patch(sitting.n, { confirming: false })}>
              {t("sh_btn_measureKeepModel")}
            </Button>
            <Button type="button" variant="destructive" disabled={L.working !== null} onClick={() => void discard(sitting.n)}>
              {t("vi_btn_discardKept3dModel")}
            </Button>
          </>
        ) : onlyDone ? (
          <ModalActions hideCancel onCancel={close} onSave={close} saveLabel={t("sh_btn_measureDone")} disabled={L.working !== null} />
        ) : undefined
      }
    >
      {of && (
        <QuickMeasureBody
          of={of}
          held={held}
          plan={plan}
          src={src}
          working={L.working}
          fault={L.fault}
          confirming={confirming}
          after={L.after}
          onDoor={onDoor}
        />
      )}
    </Modal>
  );
}

// ── THE SHEET'S INSIDE ─────────────────────────────────────────────────────────────────────────

/** A sentence beside the doors. Amber is something to act on; slate is something to know. */
function Note({ tone, alert, children }: { tone: "amber" | "slate"; alert?: boolean; children: ReactNode }) {
  return (
    <p
      role={alert ? "alert" : undefined}
      className={tone === "amber" ? "rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900" : "text-sm text-slate-600"}
    >
      {children}
    </p>
  );
}

/** What a door says. Each is a catalog key; a job's label fills its slot. */
function doorWords(d: SheetDoor, t: (key: string) => string): string {
  switch (d.id) {
    case "visit":
      return t("sh_btn_measureSaveToThisVisit");
    case "thisJob":
      return t("sh_btn_measureSaveToThisJob");
    case "clockJob":
      return fillText(t("sh_btn_measureSaveToJob"), { job: d.job });
    case "finish":
      return d.job ? fillText(t("sh_btn_measureFinishSaving"), { job: d.job }) : t("sh_btn_measureFinishSavingJob");
    case "inspection":
      return d.retry ? t("sh_tryAgain") : t("sh_btn_measureStartInspection");
    case "askAgain":
      return t("sh_tryAgain");
    case "dontKeep":
      return t("sh_btn_measureDontKeep");
    case "done":
      return t("sh_btn_measureDone");
  }
}

/** Which write a door starts, so the one that is out shows Saving… on its own button. */
const doorWrites = (d: SheetDoor): Working =>
  d.id === "inspection" ? "inspection" : d.id === "visit" ? "visit" : d.id === "thisJob" || d.id === "clockJob" || d.id === "finish" ? "job" : null;

/**
 * The inside of the sheet for one result: what it is, what the sheet has to say about it, and its
 * doors, one column, in a fixed order. Drawn from what it is handed and nothing else, so each place
 * he can be is a render with no store behind it.
 */
export function QuickMeasureBody({
  of,
  held,
  plan,
  src = null,
  working = null,
  fault = null,
  confirming = false,
  after = null,
  onDoor,
}: {
  /** The result this sitting is about (kept once it is saved, so the sheet still shows what it was). */
  of: OpenResult;
  held: HeldModel | null;
  /** Null once the result has left the store. */
  plan: SheetPlan | null;
  /** The picture's address in this page's memory. */
  src?: string | null;
  working?: SaveDoor | "visit" | "discard" | null;
  fault?: string | null;
  confirming?: boolean;
  after?: SheetAfter | null;
  onDoor: (door: SheetDoor) => void;
}) {
  const t = translator(useLang());

  // A refusal is the plugin's own sentence, as it came (it says its refusals in his language).
  if (of.kind === "refused") {
    return (
      <p role="alert" className="text-sm text-slate-700">
        {of.said}
      </p>
    );
  }

  const lines = plan?.lines ?? [];
  const says = (line: SheetLine) => !after && lines.includes(line);
  const figure = of.kind === "figure" ? of.figure : null;
  const head = figure ? (
    <div className="space-y-1 text-center">
      {src && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt={figure.caption} className="mx-auto mb-2 max-h-[32vh] w-auto max-w-full rounded-lg bg-slate-100 object-contain" />
      )}
      <p className="text-3xl font-semibold tabular-nums text-slate-900">{figureOnly(figure.caption)}</p>
      {figure.approx && <p className="text-sm text-amber-800">{t("sh_measure_approx")}</p>}
      {says("notSaved") && <p className="text-sm text-slate-500">{t("sh_measure_notSaved")}</p>}
    </div>
  ) : held ? (
    <p className="flex items-center gap-2 text-sm font-medium text-slate-900">
      <Box className="h-5 w-5 shrink-0 text-[rgb(var(--glass-ink))]" />
      <span>{fillText(t("sh_measure_modelReady"), { mb: String(megabytes(held.model.size)) })}</span>
    </p>
  ) : null;

  // IT IS SAVED: the sentence, and the way to where it went when that is another page. (A new
  // inspection is opened for him as well; the link is for when that page does not arrive.)
  if (after) {
    return (
      <div className="space-y-4">
        {head}
        <p role="status" className="flex items-start gap-2 text-sm font-medium text-green-800">
          <Check className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{after.said}</span>
        </p>
        {after.go && (
          <Link href={after.go.href} className={LINK_LOOK}>
            {after.go.to === "inspection" ? t("sh_btn_measureOpenInspection") : t("jb_openPhotos")}
          </Link>
        )}
      </div>
    );
  }

  // LETTING GO OF A MODEL, the second step: the question, and the two answers in the sheet's foot.
  if (confirming) {
    return (
      <div className="space-y-4">
        {head}
        <Note tone="amber">{t("vi_discardKeptConfirm")}</Note>
      </div>
    );
  }

  const doors = plan?.doors ?? [];
  const first = doors[0]?.id;
  /** One door of the plan, when the plan has it. Written out door by door, in the order they are
   *  drawn, so no list (and no key) is needed. */
  const door = (id: SheetDoor["id"]) => {
    const d = doors.find((x) => x.id === id);
    if (!d || d.id === "done") return null;
    const out = working !== null && doorWrites(d) === working;
    return (
      <div>
        <Button
          type="button"
          variant={d.id === "dontKeep" ? (doors.length === 1 ? "outline" : "ghost") : d.id === first ? "primary" : "secondary"}
          disabled={working !== null}
          onClick={() => onDoor(d)}
          className="h-auto min-h-11 w-full whitespace-normal py-2.5"
        >
          {out ? (
            <>
              <Loader2 className="animate-spin" /> {t("sh_saving")}
            </>
          ) : (
            doorWords(d, t)
          )}
        </Button>
        {d.id === "clockJob" && <p className="mt-1 text-center text-xs text-slate-500">{t("sh_measure_onClockThere")}</p>}
      </div>
    );
  };

  return (
    <div className="space-y-4">
      {head}
      {says("noPicture") && <Note tone="slate">{t("sh_measure_noPicture")}</Note>}
      {says("modelWaits") && <Note tone="slate">{t("sh_measure_modelWaits")}</Note>}
      {says("nowhere") && <Note tone="amber">{t("sh_measure_nowhere")}</Note>}
      {says("rowOwed") && <Note tone="amber">{t("sh_measure_rowOwed")}</Note>}
      {says("inspectionMadeNotFilled") && <Note tone="amber">{t("sh_measure_inspectionMadeNotFilled")}</Note>}
      {says("clockUnread") && <Note tone="amber">{t("sh_measure_clockUnread")}</Note>}
      {plan?.refusal && (
        <Note tone="amber" alert>
          {plan.refusal}
        </Note>
      )}
      {fault && (
        <Note tone="amber" alert>
          {fault}
        </Note>
      )}
      {plan?.asking && (
        <p role="status" className="flex justify-center py-2 text-slate-400">
          <Loader2 className="h-5 w-5 animate-spin" />
        </p>
      )}
      <div className="space-y-2">
        {door("visit")}
        {door("thisJob")}
        {door("clockJob")}
        {door("finish")}
        {door("inspection")}
        {door("askAgain")}
        {door("dontKeep")}
      </div>
    </div>
  );
}
