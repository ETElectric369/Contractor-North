"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CalendarOff, CalendarSync } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/toast";
import { BlockTimeControls, type BlockPatch } from "@/components/block-time-controls";
import { JobCrewChips, type CrewMember } from "../jobs/[id]/job-crew-card";
import { clearJobDate, moveJobDay, setJobDayTimes, setJobTimes, setVisitTimes } from "./actions";
import { rescheduleAppointment, setAppointmentAssignee, unscheduleAppointment } from "../appointments/actions";
import {
  dayWords,
  endAfter,
  jobDayBlock,
  readJobBlock,
  readVisitBlock,
  workDayMinutes,
  type JobBlock,
} from "@/lib/schedule/job-block";
import { minutesToHm } from "@/lib/schedule/fit-day";
import { chipDot, crewDayLines, placeLine, type CrewChip } from "@/lib/schedule/block-info";
import type { DayHours } from "@/lib/schedule-math";
import { shiftApptToDay } from "@/lib/appt-time";
import { initials } from "@/lib/utils";

/**
 * TAP A BLOCK ON THE SCHEDULE: ONE SMALL SHEET with its day, its start and its length, and who's on it.
 *
 * Erik, 2026-09-28, after Seiler · 3-way switches landed 10 AM to 5 PM: "i had no way to adjust the
 * time so i clicked on it and i could have cleared the day and reset it ... on the schedule itself
 * there should be a time adjustment inside the job itself with the crew picker". This replaces the
 * clear-and-reset: the day (a deliberate Move), the time (the same controls as the job page:
 * components/block-time-controls), the crew as initials chips (the job page's own crew logic,
 * useJobCrew, through setJobCrew), and the two ways out: Open The Job and Clear The Date.
 *
 * A VISIT gets the same sheet: its day, its time and the one person going (a visit carries one,
 * appointments.assigned_to), with Open The Visit and Clear The Date.
 *
 * STAFF ONLY. The schedule is the office's (a tech never reaches /schedule); `canEdit` false still
 * reads everything out with nothing to tap, and every writer behind it asks requireStaff. No price
 * is ever on it.
 */

export type TileJob = {
  id: string;
  name: string;
  status?: string | null;
  scheduled_start: string | null;
  scheduled_end: string | null;
  planned_minutes?: number | null;
  assigned_to?: string[] | null;
  customers?: { name: string } | null;
  /** The street and the town, for the sheet's where line (lib/schedule/block-info). */
  address?: string | null;
  city?: string | null;
};

export type TileVisit = {
  id: string;
  title: string;
  status: string;
  starts_at: string;
  ends_at: string | null;
  assigned_to: string | null;
};

export type TileTarget =
  | {
      kind: "job";
      day: string;
      job: TileJob;
      /** The tapped day's own hours (0370), when it keeps them. */
      dayHours?: DayHours | null;
      /** The crew as THAT DAY's rows leave it (Everyone's Day, lib/schedule/block-info crewChips): who is
       *  off that day or on another job, said under the crew. Absent: no day rows were read. */
      dayCrew?: CrewChip[] | null;
    }
  | { kind: "visit"; day: string; visit: TileVisit };

type Shared = {
  tz: string;
  workDay: { start: string; end: string };
  /** The active team (the crew picker's list). */
  team: CrewMember[];
  canEdit: boolean;
  /** Crew Board's switch (0352): on, the crew line points at Everyone's Day for one day's change. */
  crewBoard?: boolean;
  /** 0370 is applied: a day can keep its own hours, so the time here is THIS DAY's. Absent or false:
   *  the time is the job's (every day's), as before. */
  perDayHours?: boolean;
  onClose: () => void;
  /** Where the sheet's writes report: a save out holds the sheet open, a refusal the sheet closed
   *  before anyone read is said in a toast. Absent (the render test): inline words only. */
  voice?: SheetVoice;
};

/** What every writer inside the sheet tells the sheet around it. */
export type SheetVoice = {
  /** A write went out (true) or settled (false). Said in the same event as the tap. */
  pending: (busy: boolean) => void;
  /** A refusal in words, or null when a new try starts. */
  refusal: (words: string | null) => void;
};

/**
 * NOTHING SAID TO A SHEET NOBODY CAN SEE. The sheet saves as a box is left (no Save button), so the
 * tap that closes it is often the tap that saved: the backdrop press blurs the End box, the save goes
 * out, and the same tap's click reached the backdrop and closed the sheet. A refusal then landed on a
 * line that was gone, and the calendar just kept the old block (the class 21f6e37c fixed on Which
 * Job). So: while any write is out the sheet holds itself open (Modal holdOpen; the count is said the
 * moment a write starts), a refusal still standing when the sheet closes is said again in a toast, and
 * one that comes back after it closed (Back still closes) goes straight to a toast.
 */
export function createSheetGuard(say: (words: string) => void, setBusy: (count: number) => void) {
  let busy = 0;
  let open = false;
  let standing: string | null = null;
  return {
    opened() {
      open = true;
      standing = null;
    },
    pending(on: boolean) {
      busy = Math.max(0, busy + (on ? 1 : -1));
      setBusy(busy);
    },
    refusal(words: string | null) {
      if (words == null) standing = null;
      else if (open) standing = words;
      else say(words);
    },
    closing() {
      open = false;
      const w = standing;
      standing = null;
      if (w) say(w);
    },
  };
}

const BTN = "inline-flex h-11 items-center justify-center gap-1.5 rounded-lg px-4 text-sm font-medium";

export function ScheduleTileSheet({ target, ...rest }: Shared & { target: TileTarget | null }) {
  const toast = useToast();
  const sayRef = useRef(toast);
  sayRef.current = toast;
  const [busy, setBusy] = useState(0);
  const [guard] = useState(() => createSheetGuard((w) => sayRef.current(w, "error"), setBusy));
  const key = !target ? "" : `${target.kind}:${target.kind === "job" ? target.job.id : target.visit.id}:${target.day}`;
  useEffect(() => {
    if (key) guard.opened();
  }, [key, guard]);
  const close = () => {
    guard.closing();
    rest.onClose();
  };
  const title = !target ? "" : target.kind === "job" ? target.job.name : target.visit.title;
  return (
    <Modal open={!!target} onClose={close} holdOpen={busy > 0} title={title || "Schedule"} size="md">
      {target && (
        <TileSheetBody
          // A different block (or day) is a fresh sheet: no half-typed time carries over.
          key={key}
          target={target}
          {...rest}
          onClose={close}
          voice={guard}
        />
      )}
    </Modal>
  );
}

/** The sheet's inside (exported for its render test). */
export function TileSheetBody({ target, ...rest }: Shared & { target: TileTarget }) {
  return target.kind === "job" ? (
    <JobSheet day={target.day} job={target.job} dayHours={target.dayHours ?? null} dayCrew={target.dayCrew ?? null} {...rest} />
  ) : (
    <VisitSheet day={target.day} visit={target.visit} {...rest} />
  );
}

/** A section's small heading. */
function Heading({ children }: { children: React.ReactNode }) {
  return <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">{children}</div>;
}

/**
 * THE DAY: the tile's day in a date box and a Move button (a move is two deliberate steps, never a
 * change event: iOS date wheels fire one per spin). `move` returns the writer's answer.
 */
/** One write from inside the sheet: its pending state and its refusal in words, both also told to the
 *  sheet (SheetVoice) the moment they happen. `fn` answers with the refusal's words, or null. */
function useSheetWrite(voice: SheetVoice | undefined) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const refuse = (words: string | null) => {
    setError(words);
    voice?.refusal(words);
  };
  const run = (fn: () => Promise<string | null>, offline: string) => {
    refuse(null);
    voice?.pending(true);
    start(async () => {
      try {
        const words = await fn();
        if (words) refuse(words);
      } catch {
        refuse(offline);
      } finally {
        voice?.pending(false);
      }
    });
  };
  return { pending, error, run };
}

function DayRow({
  day,
  canEdit,
  move,
  idPrefix,
  voice,
}: {
  day: string;
  canEdit: boolean;
  move: (to: string) => Promise<{ ok: boolean; error?: string; note?: string } | null>;
  idPrefix: string;
  voice?: SheetVoice;
}) {
  const [to, setTo] = useState(day);
  const { pending, error, run } = useSheetWrite(voice);
  if (!canEdit) return <p className="text-sm text-slate-700">{dayWords(day)}</p>;
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <input
          id={`${idPrefix}-day`}
          type="date"
          value={to}
          disabled={pending}
          onChange={(e) => setTo(e.target.value)}
          aria-label="Day"
          className="h-11 rounded-md border border-slate-200 bg-white px-2 text-sm text-slate-900 disabled:opacity-60"
        />
        <Button
          type="button"
          variant="outline"
          disabled={pending || !/^\d{4}-\d{2}-\d{2}$/.test(to) || to === day}
          onClick={() =>
            run(async () => {
              const res = await move(to);
              return res && !res.ok ? (res.error ?? "It didn't move. Try again.") : null;
            }, "It didn't move. You may be offline.")
          }
        >
          <CalendarSync className="h-4 w-4" /> {pending ? "Moving…" : "Move"}
        </Button>
      </div>
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  );
}

/** The two-tap Clear The Date: the first tap asks, in words, what it will do. */
function ClearTheDate({
  what,
  clear,
  voice,
}: {
  what: string;
  clear: () => Promise<{ ok: boolean; error?: string; note?: string }>;
  voice?: SheetVoice;
}) {
  const [asking, setAsking] = useState(false);
  const { pending, error, run } = useSheetWrite(voice);
  if (!asking) {
    return (
      <Button type="button" variant="outline" onClick={() => setAsking(true)}>
        <CalendarOff className="h-4 w-4" /> Clear The Date
      </Button>
    );
  }
  return (
    <div className="w-full rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700">
      <p>Take {what} off the calendar? It waits under Waiting For A Day until it gets one.</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          className="text-red-600"
          disabled={pending}
          onClick={() =>
            run(async () => {
              const res = await clear();
              return res.ok ? null : (res.error ?? "The date didn't clear. Try again.");
            }, "The date didn't clear. You may be offline.")
          }
        >
          {pending ? "Clearing…" : "Clear It"}
        </Button>
        <Button type="button" variant="ghost" disabled={pending} onClick={() => setAsking(false)}>
          Keep
        </Button>
      </div>
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  );
}

function JobSheet({
  day,
  job,
  dayHours,
  dayCrew,
  tz,
  workDay,
  team,
  canEdit,
  crewBoard = false,
  perDayHours = false,
  onClose,
  voice,
}: Shared & { day: string; job: TileJob; dayHours: DayHours | null; dayCrew: CrewChip[] | null }) {
  const router = useRouter();
  const toast = useToast();
  const block: JobBlock = readJobBlock({
    scheduledStart: job.scheduled_start,
    scheduledEnd: job.scheduled_end,
    plannedMinutes: job.planned_minutes ?? null,
    tz,
    workDay,
  });
  const crew: CrewMember[] = (job.assigned_to ?? []).map((id) => team.find((m) => m.id === id) ?? { id, full_name: null });
  /* THE DAY TAPPED MAY BE HISTORY: a worked day kept on the calendar outside the plan (or with no plan
     left). The grid draws it all day, so the sheet says what it is, its time controls are the PLAN's
     and say so, and its Move moves the plan (or, with none, gives it one), never the worked day. */
  const onPlan = !!block.day && day >= block.day && day <= (block.lastDay ?? block.day);
  /* THIS DAY'S TIME (0370). A day can keep its own hours, so the time here is the tapped day's: the
     job's other days keep theirs, and the job page's control sets the usual hours (every day without
     its own). The job's ONE day is the job's time (setJobDayTimes moves the job's hours there). Before
     0370 there are no own hours: the time is the job's, as it always was. */
  const soleDay = !!block.day && !block.multiDay && block.day === day;
  const thisDay = perDayHours && !soleDay;
  const drawn = jobDayBlock({
    day,
    scheduledStart: job.scheduled_start,
    scheduledEnd: job.scheduled_end,
    plannedMinutes: job.planned_minutes ?? null,
    tz,
    wd: workDayMinutes(workDay),
    dayHours,
  });
  const drawnMinutes = Math.max(1, drawn.endMin - drawn.startMin);

  async function saveTimes(patch: BlockPatch) {
    const res = await setJobTimes(job.id, "start" in patch ? { start: patch.start } : { length: patch.length });
    if (res.ok) router.refresh();
    return res;
  }

  async function saveDayTimes(patch: BlockPatch) {
    const res = await setJobDayTimes(job.id, day, "start" in patch ? { start: patch.start } : { length: patch.length });
    if (res.ok) router.refresh();
    return res;
  }

  const usual = useSheetWrite(voice);
  function backToUsual() {
    usual.run(async () => {
      const res = await setJobDayTimes(job.id, day, { usual: true });
      if (!res.ok) return res.error ?? "That day's hours didn't change. Try again.";
      router.refresh();
      return null;
    }, "That day's hours didn't change. You may be offline.");
  }

  async function move(to: string) {
    const from = onPlan ? day : null;
    let res = await moveJobDay(job.id, from, to);
    if (!res.ok && res.needsProposalConfirm) {
      if (!window.confirm(`${res.error} Move it anyway?`)) return null;
      res = await moveJobDay(job.id, from, to, { cancelProposals: true });
    }
    if (res.ok) {
      toast(res.note ?? `Moved to ${dayWords(to)}.`, res.note ? "info" : "success");
      router.refresh();
      onClose();
    }
    return res;
  }

  async function clear() {
    const res = await clearJobDate(job.id);
    if (res.ok) {
      toast(res.note ?? "It waits under Waiting For A Day on the schedule.", res.note ? "info" : "success");
      router.refresh();
      onClose();
    }
    return res;
  }

  // WHERE AND WHO under the name, as the block says it: the street (or who, when the name is the
  // street), the town small.
  const place = placeLine({ name: job.name, street: job.address, customer: job.customers?.name });
  return (
    <div className="space-y-5">
      {(place || job.city) && (
        <p className="-mt-2 text-sm text-slate-500">
          {place?.text}
          {job.city && <span className="text-xs text-slate-400">{place ? " · " : ""}{job.city}</span>}
        </p>
      )}
      <section>
        <Heading>Day</Heading>
        <DayRow day={day} canEdit={canEdit} move={move} idPrefix={`tile-${job.id}`} voice={voice} />
        {!onPlan && (
          <p className="mt-1 text-xs text-slate-500">
            {block.day
              ? `Work was done this day; it stays as history. The job is planned ${dayWords(block.day)}${canEdit ? ", and Move moves that" : ""}.`
              : `Work was done this day; it stays as history. No day is planned yet${canEdit ? ": Move gives it one" : ""}.`}
          </p>
        )}
      </section>
      <section>
        <Heading>Time</Heading>
        {thisDay || block.day ? (
          <>
            {thisDay ? (
              <p className="mb-1.5 text-xs text-slate-500">
                This Day, {dayWords(day)}
                {dayHours ? ": its own hours. The job's other days keep theirs." : ". Only this day changes; the job page sets the hours of its other days."}
              </p>
            ) : !onPlan && block.day ? (
              <p className="mb-1.5 text-xs text-slate-500">The plan&apos;s time, {dayWords(block.day)}:</p>
            ) : perDayHours && canEdit ? (
              <p className="mb-1.5 text-xs text-slate-500">This Day, {dayWords(day)}: the job&apos;s one day, so this is the job&apos;s time.</p>
            ) : null}
            <BlockTimeControls
              key={thisDay ? "this-day" : "the-job"}
              startHm={thisDay ? minutesToHm(drawn.startMin) : block.startHm}
              endHm={thisDay ? minutesToHm(drawn.endMin) : block.endHm}
              allDay={thisDay ? drawn.allDay : block.allDay}
              sized={thisDay ? !!dayHours || Number(job.planned_minutes ?? 0) > 0 : block.sized}
              multiDay={thisDay ? false : block.multiDay}
              lastDayWords={dayWords(block.lastDay)}
              workDay={workDay}
              canEdit={canEdit}
              save={thisDay ? saveDayTimes : saveTimes}
              idPrefix={`tile-${job.id}`}
              // The Start box predicts the end the writer keeps: a day's own length when it has its own
              // hours, else the job's size (lib/schedule/day-hours nextDayHours).
              plannedMinutes={thisDay && dayHours ? drawnMinutes : (job.planned_minutes ?? null)}
              onPending={voice?.pending}
              onRefusal={voice?.refusal}
            />
            {thisDay && dayHours && canEdit && (
              <div className="mt-2">
                <Button type="button" variant="outline" disabled={usual.pending} onClick={backToUsual}>
                  {usual.pending ? "Saving…" : "Use The Job's Usual Hours"}
                </Button>
                {usual.error && <p className="mt-1 text-xs text-red-600">{usual.error}</p>}
              </div>
            )}
          </>
        ) : (
          // A day kept as history (worked, its plan cleared): the time belongs to a planned day.
          <p className="text-sm text-slate-500">No day is planned for it yet. Move it to a day, then set its time.</p>
        )}
      </section>
      <section>
        <Heading>Crew</Heading>
        <JobCrewChips jobId={job.id} crew={crew} team={team} canEdit={canEdit} />
        {/* WHOSE CREW THIS IS, in plain words: the job's crew is the whole job, every day; one day's
            change is Everyone's Day's (when it's on); and what that day's rows already did. */}
        <div className="mt-2 space-y-0.5 text-xs text-slate-500">
          <p>The whole job, every day.{crewBoard ? " To change one day, use Everyone's Day." : ""}</p>
          {crewDayLines(dayCrew).map((line) => (
            <p key={line} className="text-slate-600">
              {line}
            </p>
          ))}
        </div>
      </section>
      <div className="flex flex-wrap gap-2 border-t border-slate-100 pt-4">
        <Link href={`/jobs/${job.id}`} className={`${BTN} btn-gloss bg-[rgb(var(--glass-ink))] text-white hover:bg-[rgb(var(--glass-ink))]/90`}>
          Open The Job
        </Link>
        {canEdit && block.day && <ClearTheDate what="this job" clear={clear} voice={voice} />}
      </div>
    </div>
  );
}

/**
 * WHO'S GOING, for a visit: it carries one person, so the team is a row of initials chips with the one
 * going lit, and "Nobody" (dashed) lit when no one is. One tap puts someone on (or swaps), "Nobody"
 * takes them off; setAppointmentAssignee writes it and says so when it can't.
 */
function VisitPerson({ visitId, assigned, team, canEdit }: { visitId: string; assigned: string | null; team: CrewMember[]; canEdit: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [who, setWho] = useState<string | null>(assigned);
  const [seen, setSeen] = useState(assigned);
  if (assigned !== seen && !pending) {
    setSeen(assigned);
    setWho(assigned);
  }
  const nameOf = (id: string | null) => (id ? (team.find((m) => m.id === id)?.full_name ?? "Unnamed") : "Nobody");
  // ONE PERSON IS ONE COLOR: every circle wears its person's color (lib/schedule/block-info chipDot);
  // the one going is lit (full color, a ring), the rest are faded until tapped.
  const dot = (id: string, on: boolean) =>
    `flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-xs font-semibold text-white disabled:opacity-60 ${chipDot({ id })} ${
      on ? "ring-2 ring-slate-900 ring-offset-2" : "opacity-40 hover:opacity-70"
    }`;
  const nobody = (on: boolean) =>
    `inline-flex h-11 items-center rounded-full border border-dashed px-3 text-sm disabled:opacity-60 ${
      on ? "border-brand text-brand" : "border-slate-300 text-slate-400 hover:border-slate-400"
    }`;

  if (!canEdit) {
    return who ? (
      <span className={dot(who, true)} title={nameOf(who)} aria-label={nameOf(who)}>
        {initials(nameOf(who))}
      </span>
    ) : (
      <span className={nobody(false)}>Nobody</span>
    );
  }

  function pick(next: string | null) {
    if (next === who) return;
    const prev = who;
    setWho(next);
    start(async () => {
      try {
        const res = await setAppointmentAssignee(visitId, next);
        if (!res.ok) {
          setWho(prev);
          toast(res.error ?? "Who's going didn't change. Try again.", "error");
          return;
        }
        router.refresh();
      } catch {
        setWho(prev);
        toast("Who's going didn't change. You may be offline.", "error");
      }
    });
  }

  return (
    <div role="group" aria-label="Who's going" className="flex flex-wrap items-center gap-2">
      <button type="button" disabled={pending} aria-pressed={!who} onClick={() => pick(null)} className={nobody(!who)}>
        Nobody
      </button>
      {team.map((m) => (
        <button
          key={m.id}
          type="button"
          disabled={pending}
          aria-pressed={who === m.id}
          aria-label={m.full_name ?? "Unnamed"}
          title={m.full_name ?? "Unnamed"}
          onClick={() => pick(m.id)}
          className={dot(m.id, who === m.id)}
        >
          {initials(m.full_name ?? "")}
        </button>
      ))}
      {who && <span className="text-sm text-slate-600">{nameOf(who)}</span>}
    </div>
  );
}

function VisitSheet({ day, visit, tz, workDay, team, canEdit, onClose, voice }: Shared & { day: string; visit: TileVisit }) {
  const router = useRouter();
  const toast = useToast();
  const block = readVisitBlock({ startsAt: visit.starts_at, endsAt: visit.ends_at, tz, workDay });

  async function saveTimes(patch: BlockPatch) {
    // The visit's own rule, in the words the controls predict: a new start keeps the length (a full
    // day keeps closing), a quick length runs from the start, Full Day is the company's day.
    let start = block.startHm;
    let end = block.endHm;
    if ("start" in patch) {
      start = patch.start;
      end = block.multiDay || block.allDay ? block.endHm : endAfter(patch.start, block.minutes);
    } else if (patch.length === "full") {
      start = workDay.start;
      end = workDay.end;
    } else {
      end = endAfter(start, patch.length);
    }
    const res = await setVisitTimes(visit.id, { day: block.day ?? day, start, end, endDay: block.multiDay ? block.lastDay : null });
    if (res.ok) {
      if (res.note) toast(res.note, "info");
      router.refresh();
    }
    return res;
  }

  async function move(to: string) {
    if (visit.status === "proposed" && !window.confirm("A pick-a-time link is out to the customer for this — moving it withdraws that link. Move it anyway?")) return null;
    const t = shiftApptToDay(visit.starts_at, visit.ends_at, to, tz);
    const res = await rescheduleAppointment(visit.id, t.start, t.end);
    if (res.ok) {
      toast(res.note ?? `Moved to ${dayWords(to)}.`, res.note ? "info" : "success");
      router.refresh();
      onClose();
    }
    return res;
  }

  async function clear() {
    const res = await unscheduleAppointment(visit.id);
    if (res.ok) {
      toast("It waits under Waiting For A Day on the schedule. Place it there when they call.", "success");
      router.refresh();
      onClose();
    }
    return res;
  }

  const open = visit.status === "scheduled" || visit.status === "proposed";
  return (
    <div className="space-y-5">
      <section>
        <Heading>Day</Heading>
        <DayRow day={day} canEdit={canEdit} move={move} idPrefix={`tile-${visit.id}`} voice={voice} />
      </section>
      <section>
        <Heading>Time</Heading>
        <BlockTimeControls
          startHm={block.startHm}
          endHm={block.endHm}
          allDay={block.allDay}
          sized={block.sized}
          multiDay={block.multiDay}
          lastDayWords={dayWords(block.lastDay)}
          workDay={workDay}
          canEdit={canEdit}
          save={saveTimes}
          idPrefix={`tile-${visit.id}`}
          // A visit's length is its own clock (never the job's closing-time stamp): a new start keeps it.
          plannedMinutes={block.minutes}
          onPending={voice?.pending}
          onRefusal={voice?.refusal}
        />
      </section>
      <section>
        <Heading>Who&apos;s Going</Heading>
        <VisitPerson visitId={visit.id} assigned={visit.assigned_to} team={team} canEdit={canEdit} />
      </section>
      <div className="flex flex-wrap gap-2 border-t border-slate-100 pt-4">
        <Link href={`/appointments/${visit.id}`} className={`${BTN} btn-gloss bg-[rgb(var(--glass-ink))] text-white hover:bg-[rgb(var(--glass-ink))]/90`}>
          Open The Visit
        </Link>
        {canEdit && open && <ClearTheDate what="this visit" clear={clear} voice={voice} />}
      </div>
    </div>
  );
}
