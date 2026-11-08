"use client";

import { useState } from "react";
import { CalendarSync } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { DayField } from "@/components/day-field";
import { useToast } from "@/components/toast";
import { useLang } from "@/components/lang-provider";
import { translator } from "@/lib/i18n";

// THE one reschedule idiom for rows: "tap the Move glyph, pick a day" — the
// row-side twin of the calendar's armed-chip gesture. Deliberately DUMB: it
// knows nothing about jobs/appointments/tasks; callers bring their own server
// action via onPick, so every record type shares one grammar without this
// component growing a type switch.
//
// cn-v1153: the sheet's own 14-day chip strip is gone. Erik (2026-11-07): "sometimes on my phone
// the calendar that pops up is the iphone native calendar which is better then using our own but
// then sometimes the app calendar pops up on others … continuity of systems and single source of
// truth." The sheet now opens straight into THE one DayField (the phone's own picker, focused), and
// Move commits it. A past day is the caller's call, as it always was here: the box sets no floor.

export type MoveToDayResult = { ok: boolean; error?: string; note?: string } | void;

/**
 * Move-to-day bottom sheet. Trigger = `children` (or a default 44px
 * calendar-move glyph) → a panel with the one DayField + Move (+ optional
 * "Clear date"). Awaits `onPick`; inline error on fail, closes on success
 * (a returned `note` surfaces as a toast).
 */
export function MoveToDay({
  onPick,
  label,
  clearable = false,
  children,
  triggerClassName,
}: {
  /** The caller's server action. `null` = clear the date (clearable only). */
  onPick: (dateISO: string | null) => Promise<MoveToDayResult> | MoveToDayResult;
  label?: string;
  clearable?: boolean;
  /** Custom trigger content; default is the calendar-move glyph. */
  children?: React.ReactNode;
  /** Override the default trigger styling when embedding in a tight row. */
  triggerClassName?: string;
}) {
  const toast = useToast();
  const lang = useLang();
  const t = translator(lang);
  label = label ?? t("ag_cal_btn_moveToADay");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [customDate, setCustomDate] = useState("");

  function close() {
    setOpen(false);
    setError(null);
    setCustomDate("");
  }

  async function pick(dateISO: string | null) {
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      const res = await onPick(dateISO);
      if (res && !res.ok) {
        setError(res.error ?? t("ag_cal_couldntMove"));
        return;
      }
      if (res?.note) toast(res.note, "info");
      close();
    } catch {
      setError(t("ag_cal_couldntMove"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={label}
        aria-label={label}
        className={
          triggerClassName ??
          "flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700"
        }
      >
        {children ?? <CalendarSync className="h-4 w-4" />}
      </button>

      <Modal
        open={open}
        onClose={close}
        title={label}
        size="md"
        footer={
          <>
            {clearable && (
              <div className="mr-auto">
                <Button type="button" variant="outline" onClick={() => pick(null)} disabled={busy} className="text-red-600">
                  {t("ag_cal_btn_clearDate")}
                </Button>
              </div>
            )}
            <Button type="button" variant="outline" onClick={close} disabled={busy}>
              {t("ag_btn_cancel")}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

          {/* The one day field, focused on open so the phone's picker is a tap away. Explicit Move
              button — iOS date wheels fire change per spin, so committing on-change would move
              things mid-scroll. */}
          <div className="flex items-end gap-2">
            <DayField
              autoFocus
              value={customDate}
              onChange={(iso) => setCustomDate(iso)}
              aria-label={label}
              disabled={busy}
              className="flex-1"
            />
            <Button
              type="button"
              onClick={() => pick(customDate)}
              disabled={busy || !/^\d{4}-\d{2}-\d{2}$/.test(customDate)}
            >
              {busy ? t("ag_cal_btn_moving") : t("ag_btn_move")}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
