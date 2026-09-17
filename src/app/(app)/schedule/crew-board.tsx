"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { isInspectionType, appointmentTypeLabel } from "@/lib/statuses";
import { ChevronLeft, ChevronRight, Calendar } from "lucide-react";
import { Badge, statusTone } from "@/components/ui/badge";
import { jobStatusLabel } from "@/lib/job-status";
import { Button } from "@/components/ui/button";
import { Label, Select } from "@/components/ui/input";
import { Modal, ModalActions } from "@/components/ui/modal";
import { setCrewDayAssignment, setCrewOffRange, clearCrewOffRange } from "../timeclock/crew-actions";
import { TimeOffButton } from "./time-off-button";

export type CrewJob = { id: string; label: string; status: string; customer: string | null; assigned: string[] };
export type CrewAppt = { id: string; title: string; type: string; time: string; jobId: string | null; who: string | null; assigned: string | null };
/** The crew_day_assignments row for this person on this day, as the lane consumes it.
 *  null = no row = NOBODY HAS DECIDED (which is not the same as "nothing is happening"). */
export type CrewDecision = { kind: "job" | "off"; jobId: string | null; label: string | null; reason: string | null };
export type Lane = {
  id: string;
  name: string;
  jobs: CrewJob[];
  appts: CrewAppt[];
  decision: CrewDecision | null;
  /** What the job calendar says this person is on for this day (pickScheduledJobForDay). */
  scheduledJobId: string | null;
  scheduledLabel: string | null;
};
export type JobOption = { id: string; label: string; today: boolean };

/** The all-crew day board: one lane per person, so the whole crew's load is visible at a glance —
 *  who's slammed, who has room to take another job.
 *
 *  IT IS THE ONE PLACE A DAY GETS DECIDED NOW (cn-v951). The /timeclock crew week grid is gone;
 *  its writes moved here, onto the day you are already looking at. A list of PEOPLE for ONE day,
 *  stacked down the screen — not a seven-column grid you have to pan sideways on a ladder.
 *
 *  FOUR STATES, and the legend above the board names three of them out loud:
 *    • coloured chip  — you put them there (a crew_day_assignments kind='job' row)
 *    • grey Scheduled — what the job calendar says (jobs.assigned_to + segments)
 *    • grey Off       — time off (a kind='off' row)
 *    • nothing        — nobody has decided yet. Drawn muted but at FULL strength: a resting
 *                       state you have to hover or squint to find is, on a phone in daylight,
 *                       the same as no door at all.
 *
 *  THE PRECEDENCE LAW (migration 0139) is what the rendering says: an explicit row beats the
 *  schedule, because the row is the decision and the schedule is only the default. */
export function CrewBoard({
  day,
  dayLabel,
  isToday,
  prevHref,
  nextHref,
  todayHref,
  lanes,
  unassigned,
  canEdit,
  jobOptions,
  offToday,
}: {
  /** The org-local day being shown, "YYYY-MM-DD" — every write is stamped with it. */
  day: string;
  dayLabel: string;
  isToday: boolean;
  prevHref: string;
  nextHref: string;
  todayHref: string;
  lanes: Lane[];
  unassigned: Lane;
  /** Staff only. crew-actions.ts refuses a tech server-side; this keeps the door from drawing. */
  canEdit: boolean;
  jobOptions: JobOption[];
  offToday: string[];
}) {
  const columns = [...lanes, unassigned].filter((l) => l.id === "__unassigned__" ? l.jobs.length + l.appts.length > 0 : true);

  const router = useRouter();
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  // The decide sheet. `aimJobId` is set when it was opened by tapping a specific chip, which turns
  // the sheet's top row into the one-tap "Put Brian On 22 Pine".
  const [sheet, setSheet] = useState<{ laneId: string; aimJobId?: string } | null>(null);
  const [pickJobId, setPickJobId] = useState("");
  const [reason, setReason] = useState<"vacation" | "sick" | "other">("vacation");

  const lane = sheet ? lanes.find((l) => l.id === sheet.laneId) ?? null : null;
  const aimId = sheet?.aimJobId ?? null;
  // The label comes from wherever it is known — the picker holds the 200 newest active jobs, and a
  // job pinned months ago can fall off the end of that list. A chip that says "This Job" is a bad
  // day; a chip that fails to draw is a dead end.
  const aimLabel = aimId
    ? jobOptions.find((j) => j.id === aimId)?.label ??
      (lane?.decision?.jobId === aimId ? lane.decision.label : null) ??
      lane?.jobs.find((j) => j.id === aimId)?.label ??
      "This Job"
    : null;
  const aimIsDecision = !!aimId && lane?.decision?.jobId === aimId;
  const first = (lane?.name ?? "").trim().split(/\s+/)[0] || "Them";

  const openSheet = (laneId: string, aimJobId?: string) => {
    const l = lanes.find((x) => x.id === laneId);
    setErr(null);
    setReason("vacation");
    // Default the picker to whatever is already true for this day, so the common "yes, that one"
    // is a single tap and nothing has to be re-chosen from memory. Only an id the picker actually
    // carries — a <select> handed a value with no matching <option> just renders blank.
    const want = aimJobId ?? l?.decision?.jobId ?? l?.scheduledJobId ?? "";
    setPickJobId(jobOptions.some((j) => j.id === want) ? want : "");
    setSheet({ laneId, aimJobId });
  };

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>) =>
    start(async () => {
      setErr(null);
      const res = await fn();
      if (!res.ok) return setErr(res.error ?? "Couldn't save that.");
      setSheet(null);
      router.refresh();
    });

  const putOn = (profileId: string, jobId: string) =>
    run(() => setCrewDayAssignment({ profileId, workDate: day, jobId, isCrewLead: false }));

  // ONE day, so first and last are the same day — and includeWeekends is TRUE on purpose: the
  // range form skips weekends because a Saturday nobody was working needs no record, but a
  // deliberate tap on a Saturday lane is exactly that record being asked for.
  const markOff = (profileId: string) =>
    run(() => setCrewOffRange({ profileId, fromDate: day, toDate: day, reason, includeWeekends: true }));

  // Hand the day back to the job calendar. An OFF row clears through clearCrewOffRange (which
  // touches only off rows, so it can never eat a real pinned job); a pinned JOB clears with
  // clear:"forget", the 0170 verb that means "drop the plan" rather than "he is away".
  const followSchedule = (profileId: string, kind: "job" | "off") =>
    run(() =>
      kind === "off"
        ? clearCrewOffRange({ profileId, fromDate: day, toDate: day })
        : setCrewDayAssignment({ profileId, workDate: day, jobId: null, clear: "forget", isCrewLead: false }),
    );

  return (
    <div className="mx-auto max-w-6xl">
      {/* Header: back to the calendar + the day + prev/today/next + Time Off */}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <Link
            href="/schedule"
            className="inline-flex h-8 items-center gap-1 rounded-lg px-2 text-sm font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-900"
          >
            <ChevronLeft className="h-4 w-4 shrink-0" /> Calendar
          </Link>
          <h1 className="text-lg font-bold tracking-tight text-slate-900">Everyone&apos;s Day</h1>
        </div>
        {/* flex-wrap, and every control shrink-0: at 375px the pager plus Time Off runs about
            30px wider than the content box, and without wrapping that deficit comes out of the
            two arrow Links, which squeeze to ~17px wide while staying 32px tall. This is the
            control Erik uses to plan tomorrow, and it only broke on the days he paged TO. */}
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          <Link href={prevHref} aria-label="Previous day" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-slate-200 text-slate-500 hover:border-brand hover:text-brand">
            <ChevronLeft className="h-4 w-4" />
          </Link>
          <span className="min-w-[7rem] text-center text-sm font-semibold text-slate-700">
            {isToday ? "Today" : dayLabel}
          </span>
          <Link href={nextHref} aria-label="Next day" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-slate-200 text-slate-500 hover:border-brand hover:text-brand">
            <ChevronRight className="h-4 w-4" />
          </Link>
          {!isToday && (
            <Link href={todayHref} className="ml-1 inline-flex h-8 shrink-0 items-center gap-1 rounded-lg border border-slate-200 px-2 text-xs font-medium text-slate-600 hover:border-brand hover:text-brand">
              <Calendar className="h-3.5 w-3.5" /> Today
            </Link>
          )}
          {/* The one piece of the retired Time Off box with nowhere else to live. It writes the
              same OFF rows this board reads, so it belongs beside the board that shows them. */}
          {canEdit && <TimeOffButton members={lanes.map((l) => ({ id: l.id, full_name: l.name }))} />}
        </div>
      </div>

      {/* WHO IS AWAY — the first place in the app that says so. Only when it has something to say. */}
      {offToday.length > 0 && (
        <p className="mb-2 rounded-lg bg-slate-100 px-3 py-2 text-sm font-medium text-slate-700">
          {isToday ? "Off today" : `Off ${dayLabel}`}: {offToday.join(", ")}
        </p>
      )}

      {/* WHAT THE CHIPS MEAN. Three lines, with the real chips in them, readable at arm's length. */}
      <div className="mb-3 flex flex-col gap-1 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-500">
        <span className="flex items-center gap-2">
          <Badge tone="blue">On this job</Badge> You put them here.
        </span>
        <span className="flex items-center gap-2">
          <Badge tone="slate">Scheduled</Badge> What the job calendar says.
        </span>
        <span className="flex items-center gap-2">
          <Badge tone="slate">Off</Badge> Time off. An empty lane means nobody has decided yet.
        </span>
      </div>

      {/* One card per person, stacked down the screen on a phone. Day-first: this is ONE day, so
          it reads as a list of people, never a grid you pan sideways with a thumb. */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {columns.map((laneRow) => {
          const unassignedLane = laneRow.id === "__unassigned__";
          const decision = laneRow.decision;
          const off = decision?.kind === "off";
          const pinnedId = decision?.kind === "job" ? decision.jobId : null;
          // The pinned job may or may not also be on the day's schedule — either way it draws once,
          // as the decision, and never twice.
          const scheduledJobs = laneRow.jobs.filter((j) => j.id !== pinnedId);
          const load = (pinnedId ? 1 : 0) + scheduledJobs.length + laneRow.appts.length;
          // A man on vacation whose calendar still has work on him is a real conflict, and it is
          // the exact class of bug that ate the Materials button: a row that quietly disappears.
          const stillOn = off ? [...laneRow.jobs.map((j) => j.label), ...laneRow.appts.map((a) => a.title)] : [];
          const editable = canEdit && !unassignedLane;

          return (
            <div key={laneRow.id} className="flex flex-col rounded-xl border border-slate-200 bg-slate-50/60">
              {/* The whole header row is the door — a row beats a button inside it, one-handed. */}
              {editable ? (
                <button
                  type="button"
                  onClick={() => openSheet(laneRow.id)}
                  aria-label={`Set ${laneRow.name}'s day`}
                  className="flex min-h-11 items-center justify-between gap-2 rounded-t-xl border-b border-slate-200 bg-white px-3 py-2 text-left hover:bg-slate-50"
                >
                  <span className="truncate text-sm font-semibold text-slate-900">{laneRow.name}</span>
                  <span className="flex shrink-0 items-center gap-1.5">
                    <LoadPill load={load} off={off} />
                    {/* The row is the door; this says so without words. A hover background is not
                        an affordance on a touch screen, where there is no hover. */}
                    <ChevronRight className="h-4 w-4 text-slate-400" />
                  </span>
                </button>
              ) : (
                <div className={`flex min-h-11 items-center justify-between gap-2 rounded-t-xl border-b px-3 py-2 ${unassignedLane ? "border-amber-200 bg-amber-50" : "border-slate-200 bg-white"}`}>
                  <span className="truncate text-sm font-semibold text-slate-900">{laneRow.name}</span>
                  <LoadPill load={load} off={off} />
                </div>
              )}

              <div className="flex flex-col gap-1.5 p-2">
                {/* OFF — the decision, and the lane carries nothing else under it. */}
                {off && (
                  <div className="rounded-lg border border-slate-200 bg-slate-100 p-2 text-xs">
                    <div className="flex items-center gap-1.5">
                      <Badge tone="slate">Off</Badge>
                      {decision?.reason && <span className="text-slate-500">{decision.reason}</span>}
                    </div>
                    {stillOn.length > 0 && (
                      <p className="mt-1 text-slate-500">Still on the calendar: {stillOn.join(", ")}</p>
                    )}
                  </div>
                )}

                {!off && (
                  <>
                    {/* THE DECISION — a coloured chip, so it never reads like the calendar's default.
                        Tapping it opens the same sheet: changing your mind is one tap, and the job
                        itself is one tap further in. */}
                    {pinnedId &&
                      (editable ? (
                        <button
                          type="button"
                          onClick={() => openSheet(laneRow.id, pinnedId)}
                          className="min-h-11 rounded-lg border border-brand bg-brand/5 p-2 text-left text-xs shadow-sm"
                        >
                          <div className="flex items-start justify-between gap-1">
                            <span className="min-w-0 flex-1 truncate font-semibold text-slate-900">{decision?.label}</span>
                            <Badge tone="blue">On this job</Badge>
                          </div>
                        </button>
                      ) : (
                        <Link
                          href={`/jobs/${pinnedId}`}
                          className="min-h-11 rounded-lg border border-brand bg-brand/5 p-2 text-xs shadow-sm"
                        >
                          <div className="flex items-start justify-between gap-1">
                            <span className="min-w-0 flex-1 truncate font-semibold text-slate-900">{decision?.label}</span>
                            <Badge tone="blue">On this job</Badge>
                          </div>
                        </Link>
                      ))}

                    {load === 0 && (
                      <p className="px-1 pt-3 text-center text-xs text-slate-400">Nothing scheduled. Has room.</p>
                    )}

                    {scheduledJobs.map((j) =>
                      editable ? (
                        // One tap on a Scheduled chip offers the one-tap version of the decision.
                        // The job itself stays one tap away inside the sheet, so this is a move,
                        // not a dead end.
                        <button
                          key={j.id}
                          type="button"
                          onClick={() => openSheet(laneRow.id, j.id)}
                          className="min-h-11 rounded-lg border border-slate-200 bg-white p-2 text-left text-xs shadow-sm hover:border-brand"
                        >
                          <div className="flex items-start justify-between gap-1">
                            <span className="min-w-0 flex-1 truncate font-medium text-slate-900">{j.label}</span>
                            <Badge tone="slate">Scheduled</Badge>
                          </div>
                          <div className="mt-0.5 flex items-center gap-1.5 text-slate-400">
                            {j.customer && <span className="truncate">{j.customer}</span>}
                            <Badge tone={statusTone(j.status)}>{jobStatusLabel(j.status)}</Badge>
                          </div>
                        </button>
                      ) : (
                        <Link
                          key={j.id}
                          href={`/jobs/${j.id}`}
                          className="min-h-11 rounded-lg border border-slate-200 bg-white p-2 text-xs shadow-sm hover:border-brand"
                        >
                          <div className="flex items-start justify-between gap-1">
                            <span className="min-w-0 flex-1 truncate font-medium text-slate-900">{j.label}</span>
                            <Badge tone={statusTone(j.status)}>{jobStatusLabel(j.status)}</Badge>
                          </div>
                          {j.customer && <div className="mt-0.5 truncate text-slate-400">{j.customer}</div>}
                        </Link>
                      ),
                    )}

                    {laneRow.appts.map((a) => (
                      <Link
                        key={a.id}
                        // The appointment ITSELF (view + Edit Details) — like a job card
                        // opens its job. Its job stays one tap away on the capture page.
                        href={`/appointments/${a.id}`}
                        className="min-h-11 rounded-lg border border-slate-200 bg-white p-2 text-xs shadow-sm hover:border-brand"
                      >
                        <div className="flex items-center gap-1.5">
                          <Badge tone={isInspectionType(a.type) ? "amber" : "blue"}>{appointmentTypeLabel(a.type)}</Badge>
                          <span className="text-slate-500">{a.time}</span>
                        </div>
                        <div className="mt-0.5 truncate font-medium text-slate-900">{a.title}</div>
                        {a.who && <div className="truncate text-slate-400">{a.who}</div>}
                      </Link>
                    ))}
                  </>
                )}

                {/* NOBODY HAS DECIDED — a real door, muted but at full strength. It was drawn at
                    opacity-30 with a hover reveal, which is about 1.9:1 against this card and is
                    the same "invisible forever" the hover rule was written to avoid: on iOS the
                    hover never fires until you have already found and touched it. It names no
                    job, so it is a door, not a suggestion (cn-v590: no guesses in a person's row). */}
                {editable && !decision && (
                  <button
                    type="button"
                    onClick={() => openSheet(laneRow.id)}
                    className="min-h-11 w-full rounded-lg border border-dashed border-slate-300 bg-white/60 px-2 text-xs font-medium text-slate-500 hover:border-brand hover:text-brand"
                  >
                    Put {(laneRow.name.trim().split(/\s+/)[0] || "Them")} On A Job
                  </button>
                )}
              </div>
            </div>
          );
        })}
        {columns.length === 0 && (
          <p className="px-1 py-8 text-sm text-slate-400">No crew yet. Add team members to see their day.</p>
        )}
      </div>

      {/* THE DECIDE SHEET — put them on a job, mark them off, or hand the day back to the schedule. */}
      {lane && (
        <Modal
          open
          onClose={() => setSheet(null)}
          title={`${lane.name} · ${isToday ? "Today" : dayLabel}`}
          size="sm"
          footer={<ModalActions onCancel={() => setSheet(null)} onSave={() => setSheet(null)} saveLabel="Done" hideCancel />}
        >
          <div className="space-y-4">
            {/* A refusal goes at the TOP: a sheet this tall scrolls on a phone, and an error under
                the fold is an error nobody reads. */}
            {err && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{err}</p>}
            {aimId && (
              <div className="flex flex-col gap-2 rounded-lg border border-brand/40 bg-brand/5 p-3">
                {/* THE ONE TAP. Skipped when the tap came from the chip that already IS the
                    decision — offering to put him where he already is reads as a broken button. */}
                {!aimIsDecision && (
                  <Button className="w-full" onClick={() => putOn(lane.id, aimId)} disabled={pending}>
                    Put {first} On {aimLabel}
                  </Button>
                )}
                <Link
                  href={`/jobs/${aimId}`}
                  className="flex min-h-11 items-center justify-center text-sm font-medium text-slate-600 underline underline-offset-2"
                >
                  Open The Job
                </Link>
              </div>
            )}

            <div>
              <Label htmlFor="crew-day-job">Put on a job</Label>
              <Select id="crew-day-job" value={pickJobId} onChange={(e) => setPickJobId(e.target.value)}>
                <option value="">Pick a job…</option>
                <optgroup label="On this day's schedule">
                  {jobOptions.filter((j) => j.today).map((j) => (
                    <option key={j.id} value={j.id}>{j.label}</option>
                  ))}
                </optgroup>
                <optgroup label="Other active jobs">
                  {jobOptions.filter((j) => !j.today).map((j) => (
                    <option key={j.id} value={j.id}>{j.label}</option>
                  ))}
                </optgroup>
              </Select>
              <p className="mt-1 text-xs text-slate-500">
                They get a heads up, and their Clock In lands on this job without picking one.
              </p>
              <Button
                className="mt-2 w-full"
                onClick={() => putOn(lane.id, pickJobId)}
                disabled={pending || !pickJobId}
              >
                Put On This Job
              </Button>
            </div>

            <div className="border-t border-slate-200 pt-3">
              <Label htmlFor="crew-day-off">Mark off</Label>
              <Select id="crew-day-off" value={reason} onChange={(e) => setReason(e.target.value as never)}>
                <option value="vacation">Vacation</option>
                <option value="sick">Sick</option>
                <option value="other">Other</option>
              </Select>
              <p className="mt-1 text-xs text-slate-500">
                Just this one day. They stay on their jobs&rsquo; crews. They are not told automatically, so tell them.
              </p>
              <Button className="mt-2 w-full" variant="outline" onClick={() => markOff(lane.id)} disabled={pending}>
                Mark Off
              </Button>
            </div>

            {lane.decision && (
              <div className="border-t border-slate-200 pt-3">
                <Button
                  className="w-full"
                  variant="outline"
                  onClick={() => followSchedule(lane.id, lane.decision!.kind)}
                  disabled={pending}
                >
                  Follow The Schedule
                </Button>
                <p className="mt-1 text-xs text-slate-500">
                  {lane.decision.kind === "off" ? "Clears the time off." : "Drops your pick."}{" "}
                  {lane.scheduledLabel
                    ? `The job calendar says ${lane.scheduledLabel}.`
                    : "The job calendar has nothing on them this day."}
                  {lane.decision.kind === "job" && " They stay on that job's crew."}
                </p>
              </div>
            )}

          </div>
        </Modal>
      )}
    </div>
  );
}

/** The load pill — unchanged in shape: a count, or "open" when the day is empty. An OFF lane says
 *  so instead of counting to zero, because "open" on a man who is on vacation reads as "has room". */
function LoadPill({ load, off }: { load: number; off: boolean }) {
  if (off) {
    return <span className="shrink-0 rounded-full bg-slate-200 px-1.5 py-0.5 text-[11px] font-semibold text-slate-600">off</span>;
  }
  return (
    <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[11px] font-semibold ${load === 0 ? "bg-emerald-100 text-emerald-700" : "bg-slate-200 text-slate-600"}`}>
      {load === 0 ? "open" : load}
    </span>
  );
}
