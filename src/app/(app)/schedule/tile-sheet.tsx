"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CalendarOff, CalendarSync } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/toast";
import { BlockTimeControls, type BlockPatch } from "@/components/block-time-controls";
import { JobCrewChips, type CrewMember } from "../jobs/[id]/job-crew-card";
import { clearJobDate, moveJobDay, setJobTimes, setVisitTimes } from "./actions";
import { rescheduleAppointment, setAppointmentAssignee, unscheduleAppointment } from "../appointments/actions";
import { dayWords, endAfter, readJobBlock, readVisitBlock, type JobBlock } from "@/lib/schedule/job-block";
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
 * useJobCrew, through setJobCrew), and the two ways out: Open Job and Clear The Date.
 *
 * A VISIT gets the same sheet: its day, its time and the one person going (a visit carries one,
 * appointments.assigned_to), with Open Visit and Clear The Date.
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
};

export type TileVisit = {
  id: string;
  title: string;
  status: string;
  starts_at: string;
  ends_at: string | null;
  assigned_to: string | null;
};

export type TileTarget = { kind: "job"; day: string; job: TileJob } | { kind: "visit"; day: string; visit: TileVisit };

type Shared = {
  tz: string;
  workDay: { start: string; end: string };
  /** The active team (the crew picker's list). */
  team: CrewMember[];
  canEdit: boolean;
  onClose: () => void;
};

const BTN = "inline-flex h-11 items-center justify-center gap-1.5 rounded-lg px-4 text-sm font-medium";

export function ScheduleTileSheet({ target, ...rest }: Shared & { target: TileTarget | null }) {
  const title = !target ? "" : target.kind === "job" ? target.job.name : target.visit.title;
  return (
    <Modal open={!!target} onClose={rest.onClose} title={title || "Schedule"} size="md">
      {target && (
        <TileSheetBody
          // A different block (or day) is a fresh sheet: no half-typed time carries over.
          key={`${target.kind}:${target.kind === "job" ? target.job.id : target.visit.id}:${target.day}`}
          target={target}
          {...rest}
        />
      )}
    </Modal>
  );
}

/** The sheet's inside (exported for its render test). */
export function TileSheetBody({ target, ...rest }: Shared & { target: TileTarget }) {
  return target.kind === "job" ? <JobSheet day={target.day} job={target.job} {...rest} /> : <VisitSheet day={target.day} visit={target.visit} {...rest} />;
}

/** A section's small heading. */
function Heading({ children }: { children: React.ReactNode }) {
  return <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">{children}</div>;
}

/**
 * THE DAY: the tile's day in a date box and a Move button (a move is two deliberate steps, never a
 * change event: iOS date wheels fire one per spin). `move` returns the writer's answer.
 */
function DayRow({
  day,
  canEdit,
  move,
  idPrefix,
}: {
  day: string;
  canEdit: boolean;
  move: (to: string) => Promise<{ ok: boolean; error?: string; note?: string } | null>;
  idPrefix: string;
}) {
  const [to, setTo] = useState(day);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
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
            start(async () => {
              setError(null);
              try {
                const res = await move(to);
                if (res && !res.ok) setError(res.error ?? "It didn't move. Try again.");
              } catch {
                setError("It didn't move. You may be offline.");
              }
            })
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
function ClearTheDate({ what, clear }: { what: string; clear: () => Promise<{ ok: boolean; error?: string; note?: string }> }) {
  const [asking, setAsking] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
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
            start(async () => {
              setError(null);
              try {
                const res = await clear();
                if (!res.ok) setError(res.error ?? "The date didn't clear. Try again.");
              } catch {
                setError("The date didn't clear. You may be offline.");
              }
            })
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

function JobSheet({ day, job, tz, workDay, team, canEdit, onClose }: Shared & { day: string; job: TileJob }) {
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

  async function saveTimes(patch: BlockPatch) {
    const res = await setJobTimes(job.id, "start" in patch ? { start: patch.start } : { length: patch.length });
    if (res.ok) router.refresh();
    return res;
  }

  async function move(to: string) {
    let res = await moveJobDay(job.id, day, to);
    if (!res.ok && res.needsProposalConfirm) {
      if (!window.confirm(`${res.error} Move it anyway?`)) return null;
      res = await moveJobDay(job.id, day, to, { cancelProposals: true });
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

  return (
    <div className="space-y-5">
      {job.customers?.name && <p className="-mt-2 text-sm text-slate-500">{job.customers.name}</p>}
      <section>
        <Heading>Day</Heading>
        <DayRow day={day} canEdit={canEdit} move={move} idPrefix={`tile-${job.id}`} />
      </section>
      <section>
        <Heading>Time</Heading>
        {block.day ? (
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
            idPrefix={`tile-${job.id}`}
          />
        ) : (
          // A day kept as history (worked, its plan cleared): the time belongs to a planned day.
          <p className="text-sm text-slate-500">No day is planned for it yet. Move it to a day, then set its time.</p>
        )}
      </section>
      <section>
        <Heading>Crew</Heading>
        <JobCrewChips jobId={job.id} crew={crew} team={team} canEdit={canEdit} />
      </section>
      <div className="flex flex-wrap gap-2 border-t border-slate-100 pt-4">
        <Link href={`/jobs/${job.id}`} className={`${BTN} btn-gloss bg-[rgb(var(--glass-ink))] text-white hover:bg-[rgb(var(--glass-ink))]/90`}>
          Open Job
        </Link>
        {canEdit && <ClearTheDate what="this job" clear={clear} />}
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
  const dot = (on: boolean) =>
    `flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-xs font-semibold disabled:opacity-60 ${
      on ? "bg-brand text-white ring-2 ring-brand ring-offset-2" : "bg-slate-100 text-slate-600 hover:bg-slate-200"
    }`;
  const nobody = (on: boolean) =>
    `inline-flex h-11 items-center rounded-full border border-dashed px-3 text-sm disabled:opacity-60 ${
      on ? "border-brand text-brand" : "border-slate-300 text-slate-400 hover:border-slate-400"
    }`;

  if (!canEdit) {
    return who ? (
      <span className={dot(true)} title={nameOf(who)} aria-label={nameOf(who)}>
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
          className={dot(who === m.id)}
        >
          {initials(m.full_name ?? "")}
        </button>
      ))}
      {who && <span className="text-sm text-slate-600">{nameOf(who)}</span>}
    </div>
  );
}

function VisitSheet({ day, visit, tz, workDay, team, canEdit, onClose }: Shared & { day: string; visit: TileVisit }) {
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
        <DayRow day={day} canEdit={canEdit} move={move} idPrefix={`tile-${visit.id}`} />
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
        />
      </section>
      <section>
        <Heading>Who&apos;s Going</Heading>
        <VisitPerson visitId={visit.id} assigned={visit.assigned_to} team={team} canEdit={canEdit} />
      </section>
      <div className="flex flex-wrap gap-2 border-t border-slate-100 pt-4">
        <Link href={`/appointments/${visit.id}`} className={`${BTN} btn-gloss bg-[rgb(var(--glass-ink))] text-white hover:bg-[rgb(var(--glass-ink))]/90`}>
          Open Visit
        </Link>
        {canEdit && open && <ClearTheDate what="this visit" clear={clear} />}
      </div>
    </div>
  );
}
