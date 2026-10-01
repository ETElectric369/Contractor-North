"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, ChevronDown } from "lucide-react";
import { ComeBackPicker } from "@/components/come-back-picker";
import { GLASS_MENU_CLASS, useGlassMenuPlacement } from "@/components/ui/glass-menu";
import { toneClasses, statusTone } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { isYmd, shortDay } from "@/lib/come-back-days";
// Use the GUARDED setJobStatus (jobs/actions: requireStaff + status whitelist + not-found check).
// There used to be an identically-named UNGUARDED copy in schedule/actions that this imported — a
// name-collision footgun that silently bypassed the staff guard. That copy is now deleted.
import { finishJob, setJobStatus } from "../actions";
import { setJobHold, snoozeJobHold } from "../../schedule/actions";
import { useToast } from "@/components/toast";
import { JOB_STATUSES, finishesTheJob, jobStatusLabel } from "@/lib/job-status";

/** "in_progress" → "In Progress": the pill and the menu rows are Title Case (the clickables law). */
export const statusTitle = (s: string | null | undefined): string => jobStatusLabel(s).replace(/\b\w/g, (c) => c.toUpperCase());

/**
 * THE HELD LINE (W1-17, NY-hold 0366): what rides beside the On Hold pill. "waiting on the permit ·
 * back Oct 3". `holdUntil` undefined means the database has no such column yet (0366 not applied):
 * then no day is said at all, never a false "no day set". null (a hold from before 0366) says so,
 * and the office's Snooze picks one. A day already come or passed is "back today": it waits on a
 * person now. Pure, so the header and its test read the same words.
 */
export function heldWords(holdReason: string | null | undefined, holdUntil: string | null | undefined, todayStr: string): string {
  const parts: string[] = [];
  const why = String(holdReason ?? "").trim();
  if (why) parts.push(why);
  if (holdUntil !== undefined) {
    if (!isYmd(holdUntil)) parts.push("no day set");
    else parts.push(holdUntil <= todayStr ? "back today" : `back ${shortDay(holdUntil)}`);
  }
  return parts.join(" · ");
}

const PILL =
  "inline-flex min-h-11 items-center gap-1 rounded-full px-3 text-sm font-medium transition-colors";

/**
 * THE ONE WRITE BEHIND A PICK. Whatever the job is now (held or not), the pick is written as itself
 * through the guarded setJobStatus: it clears hold_reason on any status that isn't on_hold, and the
 * jobs_hold_day trigger (0366) clears hold_until and hold_by, so the wake side effects happen without
 * a second writer choosing the status. A pick that FINISHES the job is finishJob's (Nort's no-toggle
 * path): the job is done AND its billing is put in front of the office, the way Manage → Finish Job
 * does it. Which statuses those are is not written out here — it is the one typed table every door
 * reads (lib/job-status JOB_STATUS_DOOR, M2), and setJobStatus sends a finish the same way, so this
 * is the short road to the same function, never a second rule. On Hold never comes here (the picker
 * asks why first).
 */
export async function writeStatusPick(id: string, next: string): Promise<{ ok: boolean; error?: string; speak?: string; warning?: string }> {
  if (finishesTheJob(next)) return finishJob(id, {});
  return setJobStatus(id, next);
}

/**
 * THE STATUS BADGE IS THE STATUS CONTROL (W1-17). One writer for a job's status, in the header where
 * the status is read, not a second dropdown down the Overview.
 *
 * The office: a tappable pill in the status's own colours with a small chevron, opening the glass
 * menu (44px rows, Title Case, the current one checked). Every write goes through the guarded
 * writers: setJobStatus, and setJobHold for a hold. Picking On Hold opens the come-back picker
 * instead of writing blind: Why? (required, it is the reminder the job comes back with) and the day
 * (In A Week unless another is picked; there is no "no date": "too quiet gets things lost", 0366),
 * with Hold It. Leaving on_hold is ONE write, the pick itself (writeStatusPick): setJobStatus clears
 * hold_reason on any status that isn't on_hold, and the database's own jobs_hold_day (0366) clears
 * the day and who held it, so a stale reason never reads as a live one. (It used to go through
 * setJobHold(id, null) first, whose wake rule picked "scheduled" or "to_be_scheduled" for itself and
 * ignored the pick: To Be Scheduled on a held job landed on Scheduled, ce9ba4ef.) Complete goes
 * through finishJob, the same door as Manage → Finish Job: the T&M Final draft, the nothing-new
 * check and the unbilled-work warning ride with the word, never the word alone (209451e1). While
 * held the pill reads "On Hold · waiting on the permit · back Oct 3" with a Snooze that moves the
 * day (snoozeJobHold). A refused write says why, right here (nothing silent).
 *
 * The crew: the same pill and the same words, not tappable (setJobStatus is the office's).
 *
 * The menu hangs in the header, above the dock; it wears the Manage panel's opaque backing so the
 * dock's glass never reads through it, and useGlassMenuPlacement keeps its last row off the bottom
 * bar.
 */
export function JobStatusControl({
  id,
  status,
  holdReason,
  holdUntil,
  holdBy,
  todayStr,
  viewerIsStaff = true,
}: {
  id: string;
  status: string;
  holdReason?: string | null;
  /** The day a held job comes back (0366). undefined = the database has no such column yet. */
  holdUntil?: string | null;
  /** Who put it on hold, by name, when known. */
  holdBy?: string | null;
  /** The company's today (YYYY-MM-DD): the picker works the day out and says it. */
  todayStr: string;
  viewerIsStaff?: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  /** Which picker is open under the pill: putting it on hold, or moving a hold's day. */
  const [asking, setAsking] = useState<"hold" | "snooze" | null>(null);
  // NOTHING SILENT: a refused write (staff guard, vanished job) says why, here.
  const [err, setErr] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const { panelRef, panelStyle } = useGlassMenuPlacement(open);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (document.body.classList.contains("modal-open")) return;
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (document.body.classList.contains("modal-open")) return;
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const held = status === "on_hold";
  const words = held ? heldWords(holdReason, holdUntil, todayStr) : "";
  const tone = toneClasses(statusTone(status));

  function pick(next: string) {
    setOpen(false);
    if (next === status) return;
    if (next === "on_hold") {
      setErr(null);
      setAsking("hold");
      return;
    }
    setAsking(null);
    start(async () => {
      setErr(null);
      const res = await writeStatusPick(id, next);
      if (!res.ok) setErr(res.error ?? "That didn't save.");
      else if (next === "complete") {
        // Finish Job's own sentence (which draft was built, or that nothing new was left to bill),
        // and its warning (hours or bills still off a bill) has to be READ, so it stays until tapped.
        toast(res.speak ?? "Job finished.", "info");
        if (res.warning) toast(res.warning, "error", undefined, { sticky: true });
      }
      router.refresh();
    });
  }

  const heldLine = held && words && (
    <span className="text-sm text-slate-500" title={holdBy ? `Put on hold by ${holdBy}` : undefined}>
      · {words}
    </span>
  );

  if (!viewerIsStaff) {
    return (
      <div className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-1">
        <span className={cn(PILL, tone)}>{statusTitle(status)}</span>
        {heldLine}
      </div>
    );
  }

  return (
    <div className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-1">
      <div ref={ref} className="relative">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          disabled={pending}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={`Status: ${statusTitle(status)}. Change it`}
          className={cn(PILL, tone, "hover:brightness-95 disabled:opacity-60")}
        >
          {pending ? "Saving…" : statusTitle(status)}
          <ChevronDown className="h-3.5 w-3.5 shrink-0" />
        </button>
        {open && (
          // position set inline because .glass-gloss forces position:relative (the documented
          // gotcha); panelStyle owns the vertical side (down, or up near the bottom bar).
          <div ref={panelRef} role="menu" style={{ ...panelStyle, left: 0 }} className={`${GLASS_MENU_CLASS} w-56`}>
            {/* Opaque backing (the Manage panel's): the dock's glass never reads through the rows. */}
            <div aria-hidden className="absolute inset-0 -z-10 bg-white/85" />
            <div aria-hidden className="absolute inset-0 -z-10 bg-[rgb(var(--glass-tint))]/10" />
            {JOB_STATUSES.map((s) => (
              <button
                key={s}
                type="button"
                role="menuitemradio"
                aria-checked={s === status}
                onClick={() => pick(s)}
                className="relative z-10 flex min-h-11 w-full items-center gap-3 px-4 text-left text-sm font-medium text-slate-700 hover:bg-[rgb(var(--glass-tint))]/15"
              >
                {s === status ? <Check className="h-4 w-4 shrink-0 text-[rgb(var(--glass-ink))]" /> : <span aria-hidden className="h-4 w-4 shrink-0" />}
                {statusTitle(s)}
              </button>
            ))}
          </div>
        )}
      </div>
      {heldLine}
      {held && asking !== "snooze" && (
        <button
          type="button"
          onClick={() => {
            setErr(null);
            setAsking("snooze");
          }}
          className="inline-flex min-h-11 items-center rounded-lg px-2 text-sm font-medium text-brand hover:underline"
        >
          Snooze
        </button>
      )}
      {asking && (
        <div className="w-full max-w-sm">
          <ComeBackPicker
            label={asking === "hold" ? "Hold It" : "Snooze"}
            requireWhy={asking === "hold"}
            askWhy={asking === "snooze" && !String(holdReason ?? "").trim()}
            autoFocus
            initialWhy={asking === "hold" ? (holdReason ?? "") : ""}
            todayStr={todayStr}
            pending={pending}
            error={err}
            onCancel={() => {
              setAsking(null);
              setErr(null);
            }}
            onSubmit={({ why, when }) =>
              start(async () => {
                setErr(null);
                const res = asking === "hold" ? await setJobHold(id, why, when) : await snoozeJobHold(id, when, why || null);
                // Stay open on a refusal: the reason typed and the day picked aren't lost.
                if (!res.ok) {
                  setErr(res.error ?? "That didn't save.");
                  return;
                }
                setAsking(null);
                router.refresh();
              })
            }
          />
        </div>
      )}
      {!asking && err && <span className="text-xs font-medium text-red-600">{err}</span>}
    </div>
  );
}
