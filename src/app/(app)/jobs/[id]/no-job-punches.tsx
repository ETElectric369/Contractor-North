"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/toast";
import { putShiftOnJob, takeShiftOffJob } from "../../timeclock/actions";

/**
 * PUNCHES WITH NO JOB, ON THE JOB'S TIME TAB (the duplicate punches, 2026-09-26).
 *
 * On 9/19 the office billing 85 Whitney opened the job's Time tab, saw no 9/11 hours and typed the
 * day in again. Brian's own 9/11 punch had been in the book all along, 10:31 AM to 6:57 PM on no
 * job, and this tab never showed it. Now it lists the shifts on no job that this job's crew
 * (assigned, or with hours on it) clocked from the day before its first day to two days after its
 * last, each with Put This On <job>: the same door and guards as Add Entry's (office only; a shift
 * with no job and no invoice billing it; only the job changes, the clock times stay; Undo takes it
 * back off). Nothing listed, nothing shown.
 *
 * IT SITS ABOVE THE JOB'S OWN ENTRIES, so it shows the newest NEAR_SHOWN and a Show All <n> for the
 * rest: 13 of them (J-010, live) at 375px pushed the job's own hours about a thousand pixels down.
 * And the read stops at NEAR_JOB_CAP: when it does, the list says so and where the rest are.
 */

export type NearPunch = {
  id: string;
  name: string;
  clockIn: string;
  clockOut: string;
  hours: number;
  jobCode: string | null;
};

/** What the job page hands the list: the punches, and whether the read's cap was full. */
export type NearPunches = { punches: NearPunch[]; capped: boolean };

/** How many show before Show All. */
export const NEAR_SHOWN = 5;

/** Where the rest are: Timecards' Hours On No Job (the same place Needs You's line opens). */
export const NEAR_REST_HREF = "/timecards#no-job";

const dayOf = (iso: string, tz: string) =>
  new Date(iso).toLocaleDateString("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric" });
const timeOf = (iso: string, tz: string) => new Date(iso).toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" });

/** One punch's words, pure (shared with the tests): "Brian · Thu, Sep 11 · 10:31 AM to 6:57 PM · 8.43 h". */
export function nearPunchLine(p: NearPunch, tz: string): string {
  const first = p.name.trim().split(/\s+/)[0] || "Someone";
  const code = p.jobCode ? ` · ${p.jobCode}` : "";
  return `${first} · ${dayOf(p.clockIn, tz)} · ${timeOf(p.clockIn, tz)} to ${timeOf(p.clockOut, tz)} · ${p.hours.toFixed(2)} h${code}`;
}

/** Where the rest are, as a door (the list's cap sentences end on it). */
function RestOnTimecards() {
  return (
    <Link href={NEAR_REST_HREF} className="inline-flex min-h-[44px] items-center font-medium text-amber-900 underline">
      Hours On No Job, on Timecards
    </Link>
  );
}

/** The list as it looks. Null when there is nothing to show; a failed read says so instead. */
export function NoJobPunchesList({
  punches,
  failed = false,
  capped = false,
  showAll = false,
  jobLabel,
  tz,
  busyId = null,
  errors = {},
  onPut,
  onShowAll = () => {},
}: {
  punches: NearPunch[];
  failed?: boolean;
  /** The read stopped at its cap: there may be older ones than these. Said, never hidden. */
  capped?: boolean;
  /** Every punch, not just the newest NEAR_SHOWN. */
  showAll?: boolean;
  jobLabel: string;
  tz: string;
  busyId?: string | null;
  errors?: Record<string, string>;
  onPut: (p: NearPunch) => void;
  onShowAll?: () => void;
}) {
  if (failed) {
    return (
      <p className="border-b border-slate-100 bg-slate-50 px-5 py-2 text-xs text-slate-600">
        Couldn&rsquo;t check this crew&rsquo;s punches with no job just now. Look on Timecards before adding hours by hand.
      </p>
    );
  }
  if (!punches.length) {
    // The cap was full and none of it could be listed (billed, or empty): older punches weren't
    // checked, which is not the same as none.
    if (!capped) return null;
    return (
      <p className="border-b border-slate-100 bg-slate-50 px-5 py-2 text-xs text-slate-600">
        Couldn&rsquo;t list every punch with no job around this job&rsquo;s days: the newest ones are all billed or empty, so older
        ones weren&rsquo;t checked. They&rsquo;re under <RestOnTimecards />.
      </p>
    );
  }
  const shown = showAll ? punches : punches.slice(0, NEAR_SHOWN);
  return (
    <div className="border-b border-amber-200 bg-amber-50/70 px-5 py-3 text-sm" data-testid="no-job-punches">
      <p className="font-medium text-amber-900">Punches With No Job</p>
      <p className="text-xs text-amber-800">
        This job&rsquo;s crew clocked these around its days with no job on them. If one is this work, put it here instead of
        adding the hours again.
      </p>
      <ul className="mt-1 divide-y divide-amber-200/70">
        {shown.map((p) => (
          <li key={p.id} className="flex min-h-[44px] flex-wrap items-center gap-x-2 gap-y-1 py-1.5">
            <span className="min-w-0 flex-1 tabular-nums text-slate-800">{nearPunchLine(p, tz)}</span>
            {/* Wraps, never spills: the label carries the job's whole name, and at 375px the row
                has about 330px. 44px tall, like every door a thumb has to hit. */}
            <Button
              type="button"
              variant="outline"
              size="md"
              className="h-auto min-h-11 max-w-full whitespace-normal py-2 text-left"
              onClick={() => onPut(p)}
              disabled={!!busyId}
            >
              {busyId === p.id ? "Putting…" : `Put This On ${jobLabel}`}
            </Button>
            {errors[p.id] && (
              <p className="w-full text-xs text-red-600" role="alert">
                {errors[p.id]}
              </p>
            )}
          </li>
        ))}
      </ul>
      {shown.length < punches.length && (
        <Button type="button" variant="ghost" size="md" className="mt-1 min-h-11 text-amber-900" onClick={onShowAll}>
          Show All {punches.length}
        </Button>
      )}
      {capped && (
        <p className="mt-1 text-xs text-amber-800">
          These are the newest {punches.length}. Older ones are under <RestOnTimecards />.
        </p>
      )}
    </div>
  );
}

/** The list, wired to Put This On <job> (putShiftOnJob) with its Undo. */
export function NoJobPunches({
  jobId,
  jobLabel,
  tz,
  punches,
  failed = false,
  capped = false,
}: {
  jobId: string;
  jobLabel: string;
  tz: string;
  punches: NearPunch[];
  failed?: boolean;
  capped?: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [showAll, setShowAll] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  // A punch put on the job leaves the list at once; the refresh brings it back in the job's own
  // entries below. An Undo brings it back here on that same refresh.
  const [gone, setGone] = useState<Set<string>>(() => new Set());

  // THE 60MPH LAW: a server action that rejects (no signal) throws. Every await has its catch, so a
  // dead zone is a sentence under the row, never a silent button.
  const put = async (p: NearPunch) => {
    if (busyId) return;
    setBusyId(p.id);
    setErrors((e) => {
      const next = { ...e };
      delete next[p.id];
      return next;
    });
    try {
      let r: Awaited<ReturnType<typeof putShiftOnJob>>;
      try {
        r = await putShiftOnJob({ entry_id: p.id, job_id: jobId });
      } catch {
        setErrors((e) => ({ ...e, [p.id]: "No connection, so that shift didn't move. Try again when you have a bar or two." }));
        return;
      }
      if (!r.ok) {
        // Said twice on purpose. The line under the row stays for a refusal that keeps the row (a
        // clash with another shift). But most refusals are someone else having acted first (it is
        // on another job now, it got a job a moment ago, it is gone, an invoice bills it), and the
        // refresh below drops exactly that punch from this list, taking the row and its line with
        // it: to the office that looks like a success. The toast outlives the row.
        const sentence = r.error ?? "That shift didn't move.";
        setErrors((e) => ({ ...e, [p.id]: sentence }));
        toast(sentence, "error");
        router.refresh();
        return;
      }
      setGone((g) => new Set(g).add(p.id));
      toast(r.sentence ?? `Put on ${jobLabel}.`, "success", {
        label: "Undo",
        onClick: () => {
          void takeShiftOffJob({ entry_id: p.id, job_id: jobId }).then(
            (u) => {
              toast(u.ok ? "Back to no job." : (u.error ?? "Couldn't undo."), u.ok ? "success" : "error");
              if (u.ok)
                setGone((g) => {
                  const next = new Set(g);
                  next.delete(p.id);
                  return next;
                });
              router.refresh();
            },
            () => toast("No connection, so the Undo didn't go through. The shift may still be on the job: check it on Timecards when you have a bar or two.", "error"),
          );
        },
      });
      router.refresh();
    } finally {
      setBusyId(null);
    }
  };

  return (
    <NoJobPunchesList
      punches={punches.filter((p) => !gone.has(p.id))}
      failed={failed}
      capped={capped}
      showAll={showAll}
      onShowAll={() => setShowAll(true)}
      jobLabel={jobLabel}
      tz={tz}
      busyId={busyId}
      errors={errors}
      onPut={(p) => void put(p)}
    />
  );
}
