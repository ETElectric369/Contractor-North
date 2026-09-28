"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Search } from "lucide-react";
import { Modal, ModalActions } from "@/components/ui/modal";
import { Badge, statusTone } from "@/components/ui/badge";
import { useToast } from "@/components/toast";
import { BlockTimeControls, type BlockPatch } from "@/components/block-time-controls";
import { jobStatusLabel } from "@/lib/job-status";
import { dayWords, readHm, workDayMinutes } from "@/lib/schedule/job-block";
import { dayHoursOf, nextDayHours } from "@/lib/schedule/day-hours";
import { minutesToHm } from "@/lib/schedule/fit-day";
import { initialsOf, nameSays, streetOf } from "@/lib/schedule/block-info";
import { WORK_DAY_MINUTES } from "@/lib/schedule/work-shape";
import { addJobDay } from "./actions";

/**
 * ADD TO SCHEDULE, FROM THE SCHEDULE, FOR ANY JOB (Erik, 2026-09-28, at night: "im on the schedule page
 * and i want to put heringbone on the page for the rest of the day after Seiler but theres no way to add
 * to the schedule from the schedule page unless its already scripted"). The rail lists only work with no
 * day; a job already under way over several days (Herringbone: 9/18, 9/22, 9/24) had no door to another.
 *
 * An open spot tapped on a day (or the day's "+") opens this: pick the job (search; the company's jobs
 * still in flight, the most recently worked first, each by its name with its street and who), the start
 * (the time tapped, else the work day's start), the length (the same time controls as everywhere: 1h 2h
 * 4h Full Day End; a job nobody sized goes down as two hours and says so), and who's on it (the team as
 * initials chips). Add To Schedule ADDS the day to the job (addJobDay): its other days stay, the new
 * day keeps its own hours, and an on-hold job comes off hold. Nothing is written until then; a refusal
 * is said in words, here, and the sheet stays open.
 *
 * STAFF ONLY: the schedule is the office's, the sheet renders only for it, and addJobDay asks
 * requireStaff. No money anywhere on it.
 */

export type AddableJob = {
  id: string;
  job_number?: string | null;
  name: string;
  status: string;
  address?: string | null;
  city?: string | null;
  planned_minutes?: number | null;
  assigned_to?: string[] | null;
  customers?: { name: string } | null;
};

/** Where the sheet was opened: a day, and the half hour tapped (null: the day's "+", no spot). */
export type AddAt = { day: string; minute: number | null };

/** The line under a job's name in the list: its street (unless the name already is it) and who. */
export function addableLine(j: Pick<AddableJob, "name" | "address" | "customers">): string {
  const street = streetOf(j.address);
  const who = j.customers?.name?.trim() ?? "";
  return [street && !nameSays(j.name, street) ? street : "", who && !nameSays(j.name, who) ? who : ""].filter(Boolean).join(" · ");
}

/** The jobs a search finds, every word somewhere in the name, the street, who, the number or the town. */
export function findAddable(jobs: AddableJob[], query: string): AddableJob[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return jobs;
  return jobs.filter((j) => {
    const hay = [j.name, j.address, j.customers?.name, j.job_number, j.city].map((v) => String(v ?? "").toLowerCase()).join(" ");
    return words.every((w) => hay.includes(w));
  });
}

/** The length a picked job starts with: its size under a day, a day or more is the whole work day, and
 *  nobody's size is the two-hour default (said, "— change it"). */
export function defaultDraft(start: string, sizeMinutes: number | null | undefined, workDay: { start: string; end: string }) {
  const wd = workDayMinutes(workDay);
  const s = readHm(start) ?? wd.startMin;
  const size = Math.max(0, Number(sizeMinutes ?? 0) || 0);
  if (size >= WORK_DAY_MINUTES) return { ...dayHoursOf(s, wd.endMin > s ? wd.endMin : s + 60), sized: true };
  return { ...dayHoursOf(s, s + (size || 120)), sized: size > 0 };
}

/**
 * THE SHEET'S HOURS AFTER A CHANGE, exactly as Add To Schedule will store them (addJobDay), so the sheet
 * never shows an end the save won't keep. While nobody chose a length, the save sends none and the
 * writer gives the new start the job's size (a day or more runs to closing, else the size, else two
 * hours): so does this, from defaultDraft. Once a length is chosen (a chip, an End, Full Day) the save
 * sends the length the sheet shows, and a new start keeps it on the clock (nextDayHours, own hours).
 */
export function nextDraft(p: {
  now: { start: string; end: string };
  chosen: boolean;
  sizeMinutes: number | null | undefined;
  workDay: { start: string; end: string };
  patch: BlockPatch;
}): { hours: { start: string; end: string }; chosen: boolean } | null {
  if ("start" in p.patch && !p.chosen) {
    if (readHm(p.patch.start) == null) return null;
    const d = defaultDraft(p.patch.start, p.sizeMinutes, p.workDay);
    return { hours: { start: d.start, end: d.end }, chosen: false };
  }
  const wd = workDayMinutes(p.workDay);
  const s = readHm(p.now.start) ?? wd.startMin;
  const e = readHm(p.now.end) ?? s + 120;
  const next = nextDayHours({ before: { startMin: s, endMin: e, allDay: s === wd.startMin && e === wd.endMin }, own: true, plannedMinutes: null, patch: p.patch, wd });
  if (!next) return null;
  return { hours: next, chosen: p.chosen || !("start" in p.patch) };
}

const LIST_MAX = 40;

export function AddToScheduleSheet(props: {
  at: AddAt | null;
  jobs: AddableJob[];
  team: { id: string; full_name: string | null }[];
  workDay: { start: string; end: string };
  onClose: () => void;
}) {
  // A new spot is a fresh sheet: nothing half-picked carries over.
  const key = props.at ? `${props.at.day}:${props.at.minute ?? ""}` : "closed";
  return <AddSheet key={key} {...props} />;
}

function AddSheet({ at, jobs, team, workDay, onClose }: Parameters<typeof AddToScheduleSheet>[0]) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [jobId, setJobId] = useState<string | null>(null);
  const [day, setDay] = useState(at?.day ?? "");
  const tappedStart = at?.minute != null ? minutesToHm(at.minute) : workDay.start;
  /** The hours as the person set them (null: the picked job's default from the tapped start). */
  const [draft, setDraft] = useState<{ start: string; end: string } | null>(null);
  /** A length somebody chose (a chip, an End, Full Day); a new start alone keeps the default. */
  const [chosen, setChosen] = useState(false);
  /** Who's on it, as the sheet has it (null: the picked job's crew as it is). */
  const [crew, setCrew] = useState<string[] | null>(null);

  const job = jobs.find((j) => j.id === jobId) ?? null;
  const found = useMemo(() => findAddable(jobs, query), [jobs, query]);
  const wd = workDayMinutes(workDay);
  const base = defaultDraft(tappedStart, job?.planned_minutes, workDay);
  const hours = draft ?? { start: base.start, end: base.end };
  const s = readHm(hours.start) ?? wd.startMin;
  const e = readHm(hours.end) ?? s + 120;
  const allDay = s === wd.startMin && e === wd.endMin;
  const jobCrew = (job?.assigned_to ?? []).filter(Boolean);
  const onIt = crew ?? jobCrew;

  /** The time controls save into the sheet, never the database: the same rule the writer keeps. */
  async function draftSave(patch: BlockPatch) {
    const next = nextDraft({ now: hours, chosen, sizeMinutes: job?.planned_minutes, workDay, patch });
    if (!next) return { ok: false, error: "That time doesn't work. Pick a start and a length." };
    setDraft(next.hours);
    setChosen(next.chosen);
    return { ok: true };
  }

  function toggle(id: string) {
    setCrew((cur) => {
      const now = cur ?? jobCrew;
      return now.includes(id) ? now.filter((x) => x !== id) : [...now, id];
    });
  }

  function save() {
    if (!job) return setError("Pick the job first.");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return setError("Pick a day.");
    setError(null);
    const length = chosen ? (allDay ? ("full" as const) : e - s) : undefined;
    const add = onIt.filter((id) => !jobCrew.includes(id));
    const remove = jobCrew.filter((id) => !onIt.includes(id));
    const payload = { day, start: hours.start, length, crew: { add, remove } };
    start(async () => {
      try {
        let res = await addJobDay(job.id, payload);
        if (!res.ok && res.needsProposalConfirm) {
          if (!window.confirm(`${res.error} Add the day anyway?`)) {
            setError("Nothing was added. The customer's link is still out.");
            return;
          }
          res = await addJobDay(job.id, payload, { cancelProposals: true });
        }
        if (!res.ok) {
          setError(res.error ?? "That day didn't go on. Try again.");
          return;
        }
        toast(res.note ?? `Added ${dayWords(day)}.`, "success");
        router.refresh();
        onClose();
      } catch {
        setError("That day didn't go on. You may be offline.");
      }
    });
  }

  const chip = (on: boolean) =>
    `flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-xs font-semibold disabled:opacity-60 ${
      on ? "bg-brand text-white ring-2 ring-brand ring-offset-2" : "bg-slate-100 text-slate-600 hover:bg-slate-200"
    }`;

  return (
    <Modal
      open={!!at}
      onClose={onClose}
      holdOpen={pending}
      title="Add To Schedule"
      size="md"
      footer={<ModalActions onCancel={onClose} onSave={save} saveLabel="Add To Schedule" saving={pending} disabled={!job} />}
    >
      <div className="space-y-5">
        <section>
          <Heading>Job</Heading>
          <label className="flex h-11 items-center gap-2 rounded-md border border-slate-200 bg-white px-2 focus-within:border-brand">
            <Search className="h-4 w-4 shrink-0 text-slate-400" />
            <input
              type="search"
              value={query}
              onChange={(ev) => setQuery(ev.target.value)}
              placeholder="Find a job: street, name, customer"
              aria-label="Find a job"
              className="h-11 min-w-0 flex-1 bg-transparent text-sm text-slate-900 outline-none"
            />
          </label>
          <ul role="listbox" aria-label="Jobs" className="mt-2 max-h-64 divide-y divide-slate-100 overflow-y-auto rounded-md border border-slate-200">
            {found.slice(0, LIST_MAX).map((j) => {
              const on = j.id === jobId;
              const line = addableLine(j);
              return (
                <li key={j.id} role="option" aria-selected={on}>
                  <button
                    type="button"
                    onClick={() => {
                      setJobId(j.id);
                      setCrew(null);
                      // A length nobody chose follows the job picked (its size, else two hours), from
                      // the start the sheet has.
                      if (!chosen && draft) {
                        const d = defaultDraft(draft.start, j.planned_minutes, workDay);
                        setDraft({ start: d.start, end: d.end });
                      }
                      setError(null);
                    }}
                    aria-pressed={on}
                    className={`flex min-h-11 w-full items-center gap-2 px-3 py-1.5 text-left ${on ? "bg-brand-light/50" : "hover:bg-slate-50"}`}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-slate-900">{j.name}</span>
                      {line && <span className="block truncate text-xs text-slate-500">{line}</span>}
                    </span>
                    <Badge tone={statusTone(j.status)} className="shrink-0">
                      {jobStatusLabel(j.status)}
                    </Badge>
                  </button>
                </li>
              );
            })}
            {!found.length && <li className="px-3 py-3 text-sm text-slate-500">No job matches that. Try the street number or the customer&apos;s name.</li>}
          </ul>
          {found.length > LIST_MAX && <p className="mt-1 text-xs text-slate-400">Keep typing to find the rest ({found.length - LIST_MAX} more).</p>}
        </section>

        <section>
          <Heading>Day</Heading>
          <input
            type="date"
            value={day}
            onChange={(ev) => setDay(ev.target.value)}
            aria-label="Day"
            className="h-11 rounded-md border border-slate-200 bg-white px-2 text-sm text-slate-900"
          />
          {day && <p className="mt-1 text-xs text-slate-500">{dayWords(day)}. The job keeps every other day it has.</p>}
        </section>

        <section>
          <Heading>Time</Heading>
          <BlockTimeControls
            startHm={hours.start}
            endHm={hours.end}
            allDay={allDay}
            sized={chosen || base.sized}
            workDay={workDay}
            save={draftSave}
            idPrefix="add-to-schedule"
            // The End a new start predicts: the length shown once one is chosen, else the job's size
            // (what the save will use: nextDraft).
            plannedMinutes={chosen ? Math.max(1, e - s) : Math.max(0, Number(job?.planned_minutes ?? 0) || 0)}
            draft
          />
        </section>

        {job && (
          <section>
            <Heading>Who&apos;s On It</Heading>
            <div role="group" aria-label="Who's on it" className="flex flex-wrap items-center gap-2">
              {!onIt.length && (
                <span className="inline-flex h-11 items-center rounded-full border border-dashed border-slate-300 px-3 text-sm text-slate-400">Nobody</span>
              )}
              {team.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  aria-pressed={onIt.includes(m.id)}
                  aria-label={m.full_name ?? "Unnamed"}
                  title={m.full_name ?? "Unnamed"}
                  onClick={() => toggle(m.id)}
                  className={chip(onIt.includes(m.id))}
                >
                  {initialsOf(m.full_name)}
                </button>
              ))}
            </div>
            <p className="mt-1 text-xs text-slate-500">The job&apos;s crew, for all its days. Tap to put someone on or take them off.</p>
          </section>
        )}

        {error && <p className="text-sm text-red-600">{error}</p>}
      </div>
    </Modal>
  );
}

function Heading({ children }: { children: React.ReactNode }) {
  return <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">{children}</div>;
}
