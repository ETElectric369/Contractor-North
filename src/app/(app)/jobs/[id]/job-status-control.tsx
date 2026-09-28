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
import { setJobStatus } from "../actions";
import { setJobHold, snoozeJobHold } from "../../schedule/actions";
import { JOB_STATUSES, jobStatusLabel } from "@/lib/job-status";

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
 * THE STATUS BADGE IS THE STATUS CONTROL (W1-17). One writer for a job's status, in the header where
 * the status is read, not a second dropdown down the Overview.
 *
 * The office: a tappable pill in the status's own colours with a small chevron, opening the glass
 * menu (44px rows, Title Case, the current one checked). Every write goes through the guarded
 * writers: setJobStatus, and setJobHold for a hold. Picking On Hold opens the come-back picker
 * instead of writing blind: Why? (required, it is the reminder the job comes back with) and the day
 * (In A Week unless another is picked; there is no "no date": "too quiet gets things lost", 0366),
 * with Hold It. Leaving on_hold clears the reason and the day (setJobHold's wake rule, and the
 * database's own jobs_hold_day, keep a stale reason from ever reading as a live one). While held the
 * pill reads "On Hold · waiting on the permit · back Oct 3" with a Snooze that moves the day
 * (snoozeJobHold). A refused write says why, right here (nothing silent).
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
      // Off hold via THE hold writer so the reason (and the day) clear with the status — setJobStatus
      // alone would leave "waiting on the permit" haunting a job that isn't waiting on anything.
      let res: { ok: boolean; error?: string };
      if (held) {
        res = await setJobHold(id, null);
        if (res.ok && next !== "scheduled" && next !== "to_be_scheduled") res = await setJobStatus(id, next);
      } else {
        res = await setJobStatus(id, next);
      }
      if (!res.ok) setErr(res.error ?? "That didn't save.");
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
