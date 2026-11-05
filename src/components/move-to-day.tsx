"use client";

import { useState } from "react";
import { CalendarSync } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { useToast } from "@/components/toast";
import { useLang } from "@/components/lang-provider";
import { translator } from "@/lib/i18n";
import { localeOf } from "@/lib/locale";

// THE one reschedule idiom for rows: "tap the Move glyph, tap a day" — the
// row-side twin of the calendar's armed-chip gesture. Deliberately DUMB: it
// knows nothing about jobs/appointments/tasks; callers bring their own server
// action via onPick, so every record type shares one grammar without this
// component growing a type switch.

export type MoveToDayResult = { ok: boolean; error?: string; note?: string } | void;

const p2 = (n: number) => String(n).padStart(2, "0");
const isoOf = (d: Date) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;

/** The next `count` days as chip data (local/user timezone — a picker, not a
 *  boundary computation). Exported so calendar-side surfaces can reuse the
 *  exact same strip without importing the sheet. */
export function nextDays(count = 14, lang?: string | null): { iso: string; label: string; sub: string }[] {
  const out: { iso: string; label: string; sub: string }[] = [];
  const d = new Date();
  const t = translator(lang);
  const locale = localeOf(lang);
  for (let i = 0; i < count; i++) {
    out.push({
      iso: isoOf(d),
      label: i === 0 ? t("ag_btn_today") : i === 1 ? t("ag_btn_tomorrow") : d.toLocaleDateString(locale, { weekday: "short" }),
      sub: d.toLocaleDateString(locale, { month: "short", day: "numeric" }),
    });
    d.setDate(d.getDate() + 1);
  }
  return out;
}

/**
 * Move-to-day bottom sheet. Trigger = `children` (or a default 44px
 * calendar-move glyph) → a panel with a 14-day chip strip + native date
 * fallback (+ optional "Clear date"). Awaits `onPick`; inline error on fail,
 * closes on success (a returned `note` surfaces as a toast).
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
  const days = nextDays(14, lang);

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

          {/* One row that scrolls — 14 day chips, 44px+ targets. */}
          <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
            {days.map((d) => (
              <button
                key={d.iso}
                type="button"
                onClick={() => pick(d.iso)}
                disabled={busy}
                className="flex h-14 min-w-[3.5rem] shrink-0 flex-col items-center justify-center rounded-xl border border-slate-200 bg-white px-2 text-slate-700 transition-colors hover:border-brand hover:text-brand disabled:opacity-50"
              >
                <span className="text-[11px] font-semibold leading-tight">{d.label}</span>
                <span className="text-xs leading-tight text-slate-400">{d.sub}</span>
              </button>
            ))}
          </div>

          {/* Native date fallback for anything past the strip. Explicit Go
              button — iOS date wheels fire change per spin, so committing
              on-change would move things mid-scroll. */}
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <Label htmlFor="mtd-date">{t("ag_cal_orPickADate")}</Label>
              <Input id="mtd-date" type="date" value={customDate} onChange={(e) => setCustomDate(e.target.value)} />
            </div>
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
