"use client";

// A HOLD WHOSE DAY HAS COME, FILED WITH REMINDERS (cn-v1189). The owner, from My Day: "the on hold: Back
// Nov 29 is confusing so if that means its a reminder then lets call it Reminder Set Nov 29 and file it
// with reminders and the on hold stays put".
//
// So on its day a held job is a row in Tasks & Reminders, first (its day is today or earlier, like a
// Reminder due today), and not a Needs You row: no badge counts it (a Reminder never badges). It is
// DERIVED from the job's own hold_until by the one Needs You build (lib/action-items/types HoldReminder):
// nothing is written to tasks, and nothing is written when the day arrives. The job stays on hold.
//
// The row says the job, that it is on hold and its reason, with "Reminder Today" where a Reminder's due
// chip sits. It is not a task, so there is no box to check off: a pause mark stands in its place, and
// the row opens the job. Its ⋯ holds the doors that exist today, nothing new:
//   Pick Another Day  the hold's own snooze (snoozeJobHold, the door the job pill's Snooze uses): the
//                     come-back picker, asking why only when no reason is saved; the row then goes back
//                     to the Waiting fold, "Reminder Set Dec 6", and says so.
//   Take Off Hold     setJobHold(id, null), the rail's and Needs You's way off hold (scheduled when it has
//                     a date, to be scheduled when it has none), said in the off-hold sentence.
//   Open the Job      the job's page.

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Pause } from "lucide-react";
import { ComeBackPicker } from "@/components/come-back-picker";
import { RowMoreSheet, SheetLink, SHEET_ROW } from "@/components/row-more-sheet";
import { useToast } from "@/components/toast";
import { useLang } from "@/components/lang-provider";
import { fillText, translator } from "@/lib/i18n";
import type { Lang } from "@/lib/locale";
import { backWords, comeBackDay, offHoldWords, shortDay, type ComeBackWhen } from "@/lib/come-back-days";
import type { HoldReminder } from "@/lib/action-items/types";
import { setJobHold, snoozeJobHold } from "../schedule/actions";

/** The row's words, in the reader's language: the job, "On Hold · <reason>", and the chip
 *  ("Reminder Today": its day is today or earlier). Pure, so the row and its test read the same words. */
export function holdReminderWords(h: HoldReminder, todayStr: string, lang: Lang = "en"): { title: string; sub: string; chip: string } {
  const t = translator(lang);
  return {
    title: h.title,
    sub: `${t("jb_statusOnHold")} · ${h.reason?.trim() || t("ny_w_noReason")}`,
    chip: backWords(h.holdUntil, todayStr, lang, t),
  };
}

/** The day a pick means, for the sentence after it lands (the picker sends a date when it knows today). */
export function pickedDay(when: ComeBackWhen, todayStr: string): string {
  return "date" in when ? when.date : comeBackDay(todayStr, when.pick);
}

export function HoldReminderRow({ hold, todayStr }: { hold: HoldReminder; todayStr: string }) {
  const router = useRouter();
  const toast = useToast();
  const lang = useLang();
  const t = translator(lang);
  const [pending, start] = useTransition();
  const [picking, setPicking] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const w = holdReminderWords(hold, todayStr, lang);

  return (
    <li data-hold-reminder={hold.jobId}>
      <div className="flex items-center pr-2">
        <Link href={hold.href} className="flex min-h-[44px] min-w-0 flex-1 items-center gap-3 px-5 py-1.5 text-left hover:bg-slate-50">
          {/* Not a task: nothing to check off. The pause mark says what it is. */}
          <span aria-hidden className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-amber-50 text-amber-700">
            <Pause className="h-3.5 w-3.5" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium text-slate-900">{w.title}</span>
            <span className="block truncate text-xs text-slate-500">{w.sub}</span>
          </span>
          <span className="shrink-0 text-xs font-medium text-red-600">{w.chip}</span>
        </Link>
        <RowMoreSheet title={w.title} subline={`${w.sub} · ${w.chip}`}>
          {({ close }) => (
            <>
              {picking ? (
                <ComeBackPicker
                  reminder
                  label={t("md_btn_pickAnotherDay")}
                  askWhy={!hold.reason?.trim()}
                  todayStr={todayStr}
                  pending={pending}
                  error={err}
                  onCancel={() => {
                    setPicking(false);
                    setErr(null);
                  }}
                  onSubmit={({ why, when }) =>
                    start(async () => {
                      setErr(null);
                      const res = await snoozeJobHold(hold.jobId, when, why || null);
                      // Stay open on a refusal: the day picked and the words typed are not lost.
                      if (!res.ok) {
                        setErr(res.error ?? t("jb_didntSave"));
                        return;
                      }
                      setPicking(false);
                      close();
                      // Nothing silent: the row leaves the card for the Waiting fold, so it says where it went.
                      toast(fillText(t("md_holdReminderMoved"), { day: shortDay(pickedDay(when, todayStr), lang) }), "success");
                      router.refresh();
                    })
                  }
                />
              ) : (
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => {
                    setErr(null);
                    setPicking(true);
                  }}
                  className={SHEET_ROW}
                >
                  {t("md_btn_pickAnotherDay")}
                </button>
              )}
              <button
                type="button"
                disabled={pending}
                onClick={() =>
                  start(async () => {
                    const res = await setJobHold(hold.jobId, null);
                    if (!res.ok) {
                      toast(res.error ?? t("jb_didntSave"), "error");
                      return;
                    }
                    close();
                    toast(offHoldWords({ jobNumber: hold.jobNumber, name: hold.name, reason: hold.reason }, lang, t), "success");
                    router.refresh();
                  })
                }
                className={SHEET_ROW}
              >
                {t("ny_btn_takeOffHold")}
              </button>
              {/* Goes to the job; the page change takes the sheet with it (SheetLink). */}
              <SheetLink href={hold.href}>{t("ag_btn_openTheJob")}</SheetLink>
            </>
          )}
        </RowMoreSheet>
      </div>
    </li>
  );
}
