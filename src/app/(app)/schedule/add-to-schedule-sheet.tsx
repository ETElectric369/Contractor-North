"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Briefcase, CalendarPlus, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DayField } from "@/components/day-field";
import { Modal, ModalActions } from "@/components/ui/modal";
import { Badge, statusTone } from "@/components/ui/badge";
import { useToast } from "@/components/toast";
import { useLang } from "@/components/lang-provider";
import { translator, fillText } from "@/lib/i18n";
import type { Lang } from "@/lib/locale";
import { BlockTimeControls, type BlockPatch } from "@/components/block-time-controls";
import { jobStatusLabel } from "@/lib/job-status";
import { dayWords, hmWords, readHm, workDayMinutes } from "@/lib/schedule/job-block";
import { dayHoursOf, nextDayHours } from "@/lib/schedule/day-hours";
import { minutesToHm } from "@/lib/schedule/fit-day";
import { initialsOf, nameSays, streetOf } from "@/lib/schedule/block-info";
import { WORK_DAY_MINUTES } from "@/lib/schedule/work-shape";
import {
  FIND_CUSTOMER_CAP,
  FIND_PAST_CAP,
  capFound,
  customerLine,
  customerSays,
  findWords,
  likeWord,
  pastJobLine,
  pastJobSays,
  placeWords,
  saysEvery,
  type FoundCustomer,
  type PastJob,
} from "@/lib/schedule/find-for-day";
import { addJobDay, startJobOnDay } from "./actions";

/**
 * ADD TO SCHEDULE, FROM THE SCHEDULE, FOR ANY JOB (Erik, 2026-09-28, at night: "im on the schedule page
 * and i want to put honysuckle on the page for the rest of the day after Siskin but theres no way to add
 * to the schedule from the schedule page unless its already scripted"). The rail lists only work with no
 * day; a job already under way over several days (Honeysuckle: 9/18, 9/22, 9/24) had no door to another.
 *
 * An open spot tapped on a day (or the day's "+") opens this: pick the job (search; the company's jobs
 * still in flight, the most recently worked first, each by its name with its street and who), the start
 * (the time tapped, else the work day's start), the length (the same time controls as everywhere: 1h 2h
 * 4h Full Day End; a job nobody sized goes down as two hours and says so), and who's on it (the team as
 * initials chips). Add to Schedule ADDS the day to the job (addJobDay): its other days stay, the new
 * day keeps its own hours, and an on-hold job comes off hold. Nothing is written until then; a refusal
 * is said in words, here, and the sheet stays open.
 *
 * A PLACE TO GO BACK TO, AND A PERSON (Erik, 2026-11-10: "it wont let me add to schedule unless its
 * already a job and [a street] is a job already so why cant it find it?", "or rather is an address of a
 * previous job i need to go back to for more work", and "not even an address or a person as it states
 * it can find"). The box said street, name, customer and searched the jobs in flight alone. Once
 * something is typed it now also asks the server for FINISHED JOBS and CUSTOMERS (lib/schedule/
 * find-for-day; never shipped with the page: a company's finished jobs are every job it ever did):
 *   · a finished job ASKS how to go back: New Job Here (a new job for the same customer at that address,
 *     the old job and its bills untouched: the first choice, because it changes nothing that is closed)
 *     or Reopen This Job (the old job is Scheduled again). Nothing is guessed, and neither is hidden.
 *   · a customer starts a new job for them at the address on their card.
 * Both new jobs are made by startJobOnDay (the one New Job writer, then addJobDay); the reopen is
 * addJobDay with `reopen` said. Somebody or somewhere not on file yet is the New Job form's work: its
 * door is here, carrying the day and the hour.
 *
 * STAFF ONLY: the schedule is the office's, the sheet renders only for it, and every writer and the
 * search behind it ask requireStaff. Nothing about bills or pay anywhere on it.
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
  // The one rule every list in this sheet is searched by (lib/schedule/find-for-day).
  const words = findWords(query);
  if (!words.length) return jobs;
  return jobs.filter((j) => saysEvery([j.name, j.address, j.customers?.name, j.job_number, j.city], words));
}

/** How a finished job is gone back to: a new job at its address, or the old job reopened. */
export type GoBack = "new" | "reopen";

/** What the sheet has picked to put on the day: a job in flight, a finished job, or a customer. */
export type Picked = { kind: "job"; id: string } | { kind: "past"; job: PastJob } | { kind: "customer"; who: FoundCustomer };

/** Does Add to Schedule make a NEW job for this pick (a customer, or a finished job gone back to as new)? */
export const makesNewJob = (picked: Picked | null, back: GoBack): boolean =>
  picked?.kind === "customer" || (picked?.kind === "past" && back === "new");

/** A status said inside a sentence: lower case in both languages ("stays complete", "sigue terminado"). */
function statusInSentence(status: string, lang: Lang, t: (key: string) => string): string {
  const label = jobStatusLabel(status, lang, t);
  return lang === "es" ? label.toLocaleLowerCase("es") : label;
}

/** Under New Job Here: who the new job is for, where, and that the old job stays as it is. "The old
 *  job", never its name: a job is named for its street, so the new one will carry the same name, and a
 *  sentence with that name in it twice would not say which of the two stays finished. */
export function newJobHereWords(job: PastJob, lang: Lang, t: (key: string) => string): string {
  const who = job.customers?.name?.trim() ?? "";
  const place = placeWords(job);
  const key = who && place ? "ag_rail_newJobHereFor" : place ? "ag_rail_newJobHereAt" : who ? "ag_rail_newJobHereForNoPlace" : "ag_rail_newJobHereBare";
  return fillText(t(key), { who, place, status: statusInSentence(job.status, lang, t) });
}

/** Under a picked customer: a new job for them at the address on their card, or named for them. */
export function newJobForWords(who: FoundCustomer, t: (key: string) => string): string {
  const place = placeWords(who);
  return fillText(t(place ? "ag_rail_newJobForAt" : "ag_rail_newJobForNoPlace"), { who: who.name, place });
}

/** The line under the Day box: what the day is to the thing picked. */
export function dayLineKey(picked: Picked | null, back: GoBack): string {
  if (makesNewJob(picked, back)) return "ag_rail_dayNewJob";
  return picked?.kind === "past" ? "ag_rail_dayReopen" : "ag_rail_dayKeepsOthers";
}

/** The New Job form's address from here: the day (when there is one) and the hour the sheet is set to.
 *  Only a day and a time ride in the address, never a name or a street. */
export function newJobHref(day: string, startHm: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return "/jobs?new=1";
  return `/jobs?new=1&date=${day}${/^([01]\d|2[0-3]):[0-5]\d$/.test(startHm) ? `&time=${startHm}` : ""}`;
}

/** How long the box waits after a keystroke before it asks the server. */
const FIND_WAIT_MS = 250;

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
 * THE SHEET'S HOURS AFTER A CHANGE, exactly as Add to Schedule will store them (addJobDay), so the sheet
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

/** The day a new appointment from this sheet goes on: the Day box when it holds a date, else the
 *  tapped day — a cleared box must not send the create form to "today" without a word. */
export function apptDayOf(day: string, tapped: string | null | undefined): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : (tapped ?? "");
}

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
  const lang = useLang();
  const t = translator(lang);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<Picked | null>(null);
  /** A finished job picked: how it is gone back to. A new job first: it changes nothing that is closed. */
  const [back, setBack] = useState<GoBack>("new");
  /** A new job's few words (its description). Optional. */
  const [work, setWork] = useState("");
  /** What the server's search last brought, and where the asking stands. */
  const [found, setFound] = useState<{ jobs: PastJob[]; customers: FoundCustomer[]; more: boolean } | null>(null);
  const [finding, setFinding] = useState<"idle" | "busy" | "failed">("idle");
  const [day, setDay] = useState(at?.day ?? "");
  const tappedStart = at?.minute != null ? minutesToHm(at.minute) : workDay.start;
  /** The hours as the person set them (null: the picked job's default from the tapped start). */
  const [draft, setDraft] = useState<{ start: string; end: string } | null>(null);
  /** A length somebody chose (a chip, an End, Full Day); a new start alone keeps the default. */
  const [chosen, setChosen] = useState(false);
  /** Who's on it, as the sheet has it (null: the picked job's crew as it is). */
  const [crew, setCrew] = useState<string[] | null>(null);

  const job = picked?.kind === "job" ? (jobs.find((j) => j.id === picked.id) ?? null) : null;
  /** The job whose size and crew the controls start from: the one in flight, or the one being reopened.
   *  A new job has neither: two hours, said, and nobody on it yet. */
  const subject = job ?? (picked?.kind === "past" && back === "reopen" ? picked.job : null);
  const sizeMinutes = subject?.planned_minutes ?? null;
  const ready = !!picked && (picked.kind !== "job" || !!job);
  const inFlight = useMemo(() => findAddable(jobs, query), [jobs, query]);
  const words = useMemo(() => findWords(query), [query]);
  const asking = likeWord(words) !== null;
  /* What the last answer brought, narrowed by what is typed NOW: a row from the answer before never
     stands under words it does not match while the next answer is on its way. */
  const past = useMemo(() => (asking && found ? capFound(found.jobs, (j) => pastJobSays(j, words), FIND_PAST_CAP).rows : []), [asking, found, words]);
  const people = useMemo(() => (asking && found ? capFound(found.customers, (c) => customerSays(c, words), FIND_CUSTOMER_CAP).rows : []), [asking, found, words]);
  const nothing = !inFlight.length && !past.length && !people.length;
  const wd = workDayMinutes(workDay);
  const base = defaultDraft(tappedStart, sizeMinutes, workDay);
  const hours = draft ?? { start: base.start, end: base.end };
  const s = readHm(hours.start) ?? wd.startMin;
  const e = readHm(hours.end) ?? s + 120;
  const allDay = s === wd.startMin && e === wd.endMin;
  const jobCrew = (subject?.assigned_to ?? []).filter(Boolean);
  const onIt = crew ?? jobCrew;

  /* THE SEARCH BEYOND THE JOBS IN FLIGHT: finished jobs and customers, asked of the server a moment
     after the typing stops (a route, not a server action: lib/schedule/find-for-day and the route say
     why). A newer keystroke calls off the older question, so an old answer never lands on new words. A
     failed question is SAID in the list; it is never shown as "nothing found". */
  useEffect(() => {
    if (!likeWord(findWords(query))) {
      setFound(null);
      setFinding("idle");
      return;
    }
    const asked = new AbortController();
    setFinding("busy");
    const timer = setTimeout(() => {
      fetch("/api/schedule/find", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ q: query }),
        signal: asked.signal,
      })
        .then(async (r) => {
          const body = (await r.json()) as { ok?: boolean; jobs?: PastJob[]; customers?: FoundCustomer[]; more?: boolean } | null;
          if (!r.ok || !body?.ok) throw new Error("find");
          setFound({ jobs: body.jobs ?? [], customers: body.customers ?? [], more: !!body.more });
          setFinding("idle");
        })
        .catch(() => {
          if (!asked.signal.aborted) setFinding("failed");
        });
    }, FIND_WAIT_MS);
    return () => {
      clearTimeout(timer);
      asked.abort();
    };
  }, [query]);

  /** Pick what goes on the day. A length nobody chose follows the pick (its size, else two hours), from
   *  the start the sheet has; the crew starts over as the pick's own. */
  function pick(next: Picked, size: number | null | undefined) {
    setPicked(next);
    if (next.kind === "past") setBack("new");
    setCrew(null);
    if (!chosen && draft) {
      const d = defaultDraft(draft.start, size, workDay);
      setDraft({ start: d.start, end: d.end });
    }
    setError(null);
  }

  /** A finished job: a new job there, or the old one reopened (its own size and crew come with it). */
  function goBack(how: GoBack) {
    if (picked?.kind !== "past") return;
    setBack(how);
    setCrew(null);
    if (!chosen && draft) {
      const d = defaultDraft(draft.start, how === "reopen" ? picked.job.planned_minutes : null, workDay);
      setDraft({ start: d.start, end: d.end });
    }
    setError(null);
  }

  /** The time controls save into the sheet, never the database: the same rule the writer keeps. */
  async function draftSave(patch: BlockPatch) {
    const next = nextDraft({ now: hours, chosen, sizeMinutes, workDay, patch });
    if (!next) return { ok: false, error: t("ag_rail_timeDoesntWork") };
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
    const going = picked;
    if (!going || !ready) return setError(t("ag_rail_pickTheJobFirst"));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return setError(t("ag_pickADay"));
    setError(null);
    const length = chosen ? (allDay ? ("full" as const) : e - s) : undefined;
    const add = onIt.filter((id) => !jobCrew.includes(id));
    const remove = jobCrew.filter((id) => !onIt.includes(id));
    const payload = { day, start: hours.start, length, crew: { add, remove } };
    start(async () => {
      try {
        let res: { ok: boolean; error?: string; id?: string; note?: string; needsProposalConfirm?: boolean };
        if (going.kind === "customer" || (going.kind === "past" && back === "new")) {
          // A NEW JOB, for the customer or at the finished job's address: made, then put on the day.
          res = await startJobOnDay(going.kind === "customer" ? { customerId: going.who.id } : { pastJobId: going.job.id }, {
            day,
            start: hours.start,
            length,
            crew: { add },
            work,
          });
          if (!res.ok && res.id) {
            /* THE JOB WAS MADE AND ITS DAY WAS NOT (said in the error). The pick becomes that job, so
               a second tap adds the day to the job that exists and never makes another; the refresh
               brings it into the list, and until it does the button waits. Who was put on it stays
               chosen: the job has nobody yet, so the same people go on with the day. */
            setPicked({ kind: "job", id: res.id });
            router.refresh();
          }
        } else {
          // A job in flight takes another day; a finished one picked as Reopen says so to the writer.
          const id = going.kind === "job" ? going.id : going.job.id;
          const reopen = going.kind === "past";
          res = await addJobDay(id, payload, { reopen });
          if (!res.ok && res.needsProposalConfirm) {
            if (!window.confirm(fillText(t("ag_rail_addAnyway"), { error: res.error ?? "" }))) {
              setError(t("ag_rail_nothingAdded"));
              return;
            }
            res = await addJobDay(id, payload, { reopen, cancelProposals: true });
          }
        }
        if (!res.ok) {
          setError(res.error ?? t("ag_rail_dayDidntGoOn"));
          return;
        }
        toast(res.note ?? fillText(t("ag_rail_addedOn"), { day: dayWords(day, lang) }), "success");
        router.refresh();
        onClose();
      } catch {
        setError(t("ag_rail_dayDidntGoOnOffline"));
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
      title={t("ag_rail_btn_addToSchedule")}
      size="md"
      footer={<ModalActions onCancel={onClose} onSave={save} saveLabel={t("ag_rail_btn_addToSchedule")} saving={pending} disabled={!ready} />}
    >
      <div className="space-y-5">
        <section>
          <Heading>{t("ag_job")}</Heading>
          <label className="flex h-11 items-center gap-2 rounded-md border border-slate-200 bg-white px-2 focus-within:border-brand">
            <Search className="h-4 w-4 shrink-0 text-slate-400" />
            <input autoComplete="off"
              type="search"
              value={query}
              onChange={(ev) => setQuery(ev.target.value)}
              placeholder={t("ag_rail_findAJobHint")}
              aria-label={t("ag_rail_findAJob")}
              className="h-11 min-w-0 flex-1 bg-transparent text-sm text-slate-900 outline-none"
            />
          </label>
          <ul role="listbox" aria-label={t("ag_rail_jobs")} className="mt-2 max-h-64 divide-y divide-slate-100 overflow-y-auto rounded-md border border-slate-200">
            {inFlight.slice(0, LIST_MAX).map((j) => {
              const on = picked?.kind === "job" && picked.id === j.id;
              const line = addableLine(j);
              return (
                <li key={j.id} role="option" aria-selected={on}>
                  <button
                    type="button"
                    onClick={() => pick({ kind: "job", id: j.id }, j.planned_minutes)}
                    aria-pressed={on}
                    className={`flex min-h-11 w-full items-center gap-2 px-3 py-1.5 text-left ${on ? "bg-brand-light/50" : "hover:bg-slate-50"}`}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-slate-900">{j.name}</span>
                      {line && <span className="block truncate text-xs text-slate-500">{line}</span>}
                    </span>
                    <Badge tone={statusTone(j.status)} className="shrink-0">
                      {jobStatusLabel(j.status, lang, t)}
                    </Badge>
                  </button>
                </li>
              );
            })}
            <FoundRows past={past} people={people} picked={picked} onPick={(next) => pick(next, null)} />
            {/* NOTHING, said for what it is: no job in flight (while the rest is still being asked, or
                was never asked), or nothing anywhere once the server has answered. */}
            {nothing && finding !== "busy" && (
              <li className="px-3 py-3 text-sm text-slate-500">{t(asking && finding === "idle" && found ? "ag_rail_nothingMatches" : "ag_rail_noJobMatches")}</li>
            )}
            {finding === "busy" && <li className="px-3 py-2 text-xs text-slate-400">{t("ag_rail_searchingPast")}</li>}
            {finding === "failed" && <li className="px-3 py-2 text-xs text-amber-700">{t("ag_rail_searchFailed")}</li>}
          </ul>
          {inFlight.length > LIST_MAX && <p className="mt-1 text-xs text-slate-400">{fillText(t("ag_rail_keepTyping"), { n: String(inFlight.length - LIST_MAX) })}</p>}
          {asking && finding === "idle" && found?.more && <p className="mt-1 text-xs text-slate-400">{t("ag_rail_searchMore")}</p>}
          {!query.trim() && <p className="mt-1 text-xs text-slate-400">{t("ag_rail_typeToFindMore")}</p>}
        </section>

        <PickedSections picked={picked} back={back} onBack={goBack} work={work} onWork={setWork} />

        <section>
          <Heading>{t("ag_btn_day")}</Heading>
          <DayField
            value={day}
            onChange={(iso) => setDay(iso)}
            aria-label={t("ag_btn_day")}
          />
          {day && <p className="mt-1 text-xs text-slate-500">{fillText(t(dayLineKey(picked, back)), { day: dayWords(day, lang) })}</p>}
        </section>

        <section>
          <Heading>{t("ag_rail_time")}</Heading>
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
            plannedMinutes={chosen ? Math.max(1, e - s) : Math.max(0, Number(sizeMinutes ?? 0) || 0)}
            draft
          />
        </section>

        {ready && (
          <section>
            <Heading>{t("ag_rail_whosOnIt")}</Heading>
            <div role="group" aria-label={t("ag_rail_whosOnItAria")} className="flex flex-wrap items-center gap-2">
              {!onIt.length && (
                <span className="inline-flex h-11 items-center rounded-full border border-dashed border-slate-300 px-3 text-sm text-slate-400">{t("ag_rail_nobody")}</span>
              )}
              {team.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  aria-pressed={onIt.includes(m.id)}
                  aria-label={m.full_name ?? t("ag_unnamed")}
                  title={m.full_name ?? t("ag_unnamed")}
                  onClick={() => toggle(m.id)}
                  className={chip(onIt.includes(m.id))}
                >
                  {initialsOf(m.full_name)}
                </button>
              ))}
            </div>
            <p className="mt-1 text-xs text-slate-500">{t("ag_rail_crewForAllDays")}</p>
          </section>
        )}

        {/* OR A NEW JOB, for somebody or somewhere not on file yet: the New Job form (the one door that
            takes a new customer and a new address), opened on this day and hour. A link, and the sheet
            stays open under it: a navigation that takes the page is left alone by the Modal's history
            step (overlay-history), where closing first would step back under it. */}
        <section>
          <Heading>{t("ag_rail_btn_orANewJob")}</Heading>
          <Link
            href={newJobHref(apptDayOf(day, at?.day), draft?.start ?? (at?.minute != null ? minutesToHm(at.minute) : ""))}
            className="inline-flex min-h-11 items-center gap-2 rounded-md border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            <Briefcase className="h-4 w-4" />
            {apptDayOf(day, at?.day) ? fillText(t("ag_rail_btn_newJobOn"), { day: dayWords(apptDayOf(day, at?.day), lang) }) : t("ag_rail_newJob")}
          </Link>
          <p className="mt-1 text-xs text-slate-500">{t("ag_rail_notHere")}</p>
        </section>

        {/* OR AN APPOINTMENT AT THAT TIME (Erik, 2026-10-15: "add a new appointment to the schedule
            when I click on a time or a job or whatever"). This sheet places a JOB on the day; an
            appointment is the day drill's one create form, which answers ?new=1 with the day and the
            tapped half hour (schedule/page.tsx carries ?time=). One tap: the intent is pushed, and
            the calendar closes this sheet once the URL has landed — closing first would step
            history back under a navigation still in flight (the Modal's own entry). */}
        <section>
          <Heading>{t("ag_rail_btn_orAnAppointment")}</Heading>
          <Button
            type="button"
            variant="outline"
            className="h-auto min-h-11 whitespace-normal py-2 text-left"
            onClick={() =>
              router.push(`/schedule?view=day&date=${apptDayOf(day, at?.day)}&new=1${at?.minute != null ? `&time=${minutesToHm(at.minute)}` : ""}`)
            }
          >
            <CalendarPlus className="h-4 w-4" />{" "}
            {at?.minute != null
              ? fillText(t("ag_rail_btn_newApptAt"), { time: hmWords(minutesToHm(at.minute), lang) })
              : fillText(t("ag_rail_btn_newApptOn"), { day: dayWords(apptDayOf(day, at?.day), lang) })}
          </Button>
        </section>

        {error && <p className="text-sm text-red-600">{error}</p>}
      </div>
    </Modal>
  );
}

/**
 * THE ROWS THE SEARCH FOUND, after the jobs in flight: finished jobs (a place to go back to; the row
 * says what the job is now) and customers (a person, with the address a new job for them takes). Drawn
 * apart from the sheet so they can be rendered and read without a server.
 */
export function FoundRows({ past, people, picked, onPick }: { past: PastJob[]; people: FoundCustomer[]; picked: Picked | null; onPick: (next: Picked) => void }) {
  const lang = useLang();
  const t = translator(lang);
  return (
    <>
      {/* FINISHED JOBS the search found: a place to go back to. The row says what the job is now. */}
      {past.length > 0 && <li role="presentation" className={GROUP}>{t("ag_rail_finishedJobs")}</li>}
      {past.map((j) => {
        const on = picked?.kind === "past" && picked.job.id === j.id;
        const line = pastJobLine(j);
        return (
          <li key={`past-${j.id}`} role="option" aria-selected={on}>
            <button
              type="button"
              // New Job Here is where a finished job starts, so its length starts unsized.
              onClick={() => onPick({ kind: "past", job: j })}
              aria-pressed={on}
              className={`flex min-h-11 w-full items-center gap-2 px-3 py-1.5 text-left ${on ? "bg-brand-light/50" : "hover:bg-slate-50"}`}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-slate-900">{j.name}</span>
                {line && <span className="block truncate text-xs text-slate-500">{line}</span>}
              </span>
              <Badge tone={statusTone(j.status)} className="shrink-0">
                {jobStatusLabel(j.status, lang, t)}
              </Badge>
            </button>
          </li>
        );
      })}
      {/* CUSTOMERS the search found: a person, with the address a new job for them takes. */}
      {people.length > 0 && <li role="presentation" className={GROUP}>{t("ag_rail_customers")}</li>}
      {people.map((c) => {
        const on = picked?.kind === "customer" && picked.who.id === c.id;
        const line = customerLine(c);
        return (
          <li key={`who-${c.id}`} role="option" aria-selected={on}>
            <button
              type="button"
              onClick={() => onPick({ kind: "customer", who: c })}
              aria-pressed={on}
              className={`flex min-h-11 w-full items-center gap-2 px-3 py-1.5 text-left ${on ? "bg-brand-light/50" : "hover:bg-slate-50"}`}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-slate-900">{c.name}</span>
                {line && <span className="block truncate text-xs text-slate-500">{line}</span>}
              </span>
              <Badge tone="slate" className="shrink-0">
                {t("ag_rail_customer")}
              </Badge>
            </button>
          </li>
        );
      })}
    </>
  );
}

/**
 * WHAT WAS PICKED, WHEN IT IS NOT A JOB IN FLIGHT. A finished job ASKS how to go back (New Job Here
 * first: it changes nothing that is closed; Reopen This Job beside it, never hidden), a customer says
 * the new job it starts and where, and a new job takes a few optional words for its description.
 */
export function PickedSections({ picked, back, onBack, work, onWork }: { picked: Picked | null; back: GoBack; onBack: (how: GoBack) => void; work: string; onWork: (words: string) => void }) {
  const lang = useLang();
  const t = translator(lang);
  if (!picked || picked.kind === "job") return null;
  return (
    <>
      {/* A FINISHED JOB PICKED: how to go back. Asked, never guessed; a new job stands first because it
          changes nothing that is closed. */}
      {picked?.kind === "past" && (
        <section>
          <Heading>{t("ag_rail_goingBack")}</Heading>
          {/* WHICH job, said here: its row can leave the list above when the box is typed in again, and
              Reopen must never be pressed without the job it reopens in sight (skeptic #62). */}
          <p className="mb-2 text-sm">
            <span className="font-medium text-slate-900">{picked.job.name}</span>
            {pastJobLine(picked.job) && <span className="text-slate-500"> · {pastJobLine(picked.job)}</span>}
            <span className="text-slate-500"> · {jobStatusLabel(picked.job.status, lang, t)}</span>
          </p>
          <div role="group" aria-label={t("ag_rail_goingBackAria")} className="grid grid-cols-2 gap-2">
            {(["new", "reopen"] as const).map((how) => (
              <button key={how} type="button" aria-pressed={back === how} onClick={() => onBack(how)} className={choice(back === how)}>
                {t(how === "new" ? "ag_rail_btn_newJobHere" : "ag_rail_btn_reopenThisJob")}
              </button>
            ))}
          </div>
          <p className="mt-2 text-sm text-slate-600">
            {back === "new" ? newJobHereWords(picked.job, lang, t) : t("ag_rail_reopenSays")}
          </p>
        </section>
      )}

      {/* A CUSTOMER PICKED: a new job for them, said with where. */}
      {picked?.kind === "customer" && (
        <section>
          <Heading>{t("ag_rail_newJob")}</Heading>
          <p className="text-sm text-slate-600">{newJobForWords(picked.who, t)}</p>
        </section>
      )}

      {/* A new job's few words: its description, so the crew reads what the visit is for. */}
      {makesNewJob(picked, back) && (
        <section>
          <label htmlFor="add-to-schedule-work" className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400">
            {t("ag_rail_whatsTheWork")}
          </label>
          <input
            id="add-to-schedule-work"
            type="text"
            autoComplete="off"
            maxLength={500}
            value={work}
            onChange={(ev) => onWork(ev.target.value)}
            placeholder={t("ag_rail_whatsTheWorkHint")}
            className="h-11 w-full rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-900 outline-none focus:border-brand"
          />
        </section>
      )}
    </>
  );
}

/** A group's small label inside the list. */
const GROUP = "bg-slate-50 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400";

/** One of the two ways back to a finished job: 44px, and the one picked is filled. */
const choice = (on: boolean) =>
  `min-h-11 rounded-md border px-3 py-2 text-sm font-medium ${on ? "border-brand bg-brand text-white" : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"}`;

function Heading({ children }: { children: React.ReactNode }) {
  return <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">{children}</div>;
}
