import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Badge, type Tone } from "@/components/ui/badge";
import { fillText, localeOf, translator } from "@/lib/i18n";
import { formatCurrency, formatDate, formatDuration, hoursBetween } from "@/lib/utils";
import { todayStrInTz } from "@/lib/tz";
import { jobLabelWithNumber, jobSiteLabel } from "@/lib/schedule-options";
import { paymentMethodLabel } from "@/lib/payment-method";
import { owedReading, paymentsToShow, type MyPay, type MyPayPeriod, type PayPaymentRow } from "@/lib/payroll-math";

/**
 * MY PAY PERIODS, DRAWN (cn-v1166). Server pieces with no state: the two pages read (my-pay-read) and
 * hand the result here, and the tests render these with renderToStaticMarkup. Every word is the tc_
 * catalog's, every amount formatCurrency in the reader's language, every day the company's day.
 *
 * Built for a 320px phone: each period is a two-line stack, never a table. A row's words are worked out
 * before the row is drawn (rowWords), so the badge's status word is never read as the door's label.
 */

const PAY_TONE: Record<MyPayPeriod["state"], Tone> = { paid: "green", partly: "amber", unpaid: "slate", onClock: "blue" };

/** A period as it is said: its first day to its last (the end is exclusive), in the reader's language. */
export function periodDates(start: string, endExclusive: string, lang: string): string {
  const endIncl = new Date(new Date(`${endExclusive}T00:00:00Z`).getTime() - 86_400_000).toISOString().slice(0, 10);
  return `${formatDate(start, undefined, lang)} – ${formatDate(endIncl, undefined, lang)}`;
}

/** The address of one period's page: its first day and its exclusive end. */
export function periodHref(p: { start: string; end: string }): string {
  return `/timeclock/pay/${p.start}_${p.end}`;
}

/** The state's word (a badge: the catalog's lowercase word, capitalized by the badge itself). */
export function stateWord(p: MyPayPeriod, lang: string): string {
  const t = translator(lang);
  return p.state === "paid" ? t("tc_paid") : p.state === "partly" ? t("tc_partlyPaid") : p.state === "unpaid" ? t("tc_unpaid") : t("tc_onTheClock");
}

/** What one row says, worked out once. */
export function rowWords(p: MyPayPeriod, lang: string) {
  const t = translator(lang);
  const share = p.gross > 0 ? Math.round((p.paid / p.gross) * 100) : p.state === "paid" ? 100 : 0;
  return {
    dates: periodDates(p.start, p.end, lang),
    gross: p.state === "onClock" ? "" : formatCurrency(p.gross, lang),
    hours: p.state === "onClock" ? "" : formatDuration(p.hours),
    left: p.state === "partly" ? fillText(t("tc_leftAmount"), { amount: formatCurrency(p.left, lang) }) : "",
    state: stateWord(p, lang),
    tone: PAY_TONE[p.state],
    paidShare: Math.max(0, Math.min(100, share)),
  };
}

/**
 * THE CARD ON THE TIME CLOCK (techs only): the newest of My Pay Periods (its dates, hours, base pay and
 * paid state) and the door to every period. Mileage dollars are deliberately absent (settled by a human
 * on /payroll). A read that failed says so in place of a figure. Built for a 320px phone: what is left on
 * a partly paid period stands on a line of its own, as the list's row says it, and the lines wrap.
 */
export function MyPayCard({ newest, cantShow, lang }: { newest: MyPayPeriod | null; cantShow: boolean; lang: string }) {
  if (!newest && !cantShow) return null;
  const t = translator(lang);
  const w = newest ? rowWords(newest, lang) : null;
  return (
    <Card>
      <CardContent className="py-4">
        <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-3">
          <h3 className="text-sm font-semibold text-slate-900">{t("tc_myPayPeriod")}</h3>
          {w && <span className="text-xs text-slate-400">{w.dates}</span>}
        </div>
        {newest && w ? (
          <>
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 text-sm">
              <span className="min-w-0 text-slate-600">{w.hours}</span>
              <span className="flex shrink-0 items-center gap-2">
                <span className="font-bold text-slate-900">{w.gross}</span>
                <Badge tone={w.tone}>{w.state}</Badge>
              </span>
            </div>
            {w.left && <p className="mt-0.5 text-right text-xs text-slate-500">{w.left}</p>}
          </>
        ) : (
          <p className="text-sm text-slate-700">{t("tc_payCantShow")}</p>
        )}
        {newest?.running && (
          <p className="mt-1.5 rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-xs text-amber-800">{t("tc_openNotCounted")}</p>
        )}
        <p className="mt-1.5 text-xs text-slate-400">{t("tc_basePayOnly")}</p>
        <Link
          href="/timeclock/pay"
          className="mt-3 flex min-h-[44px] items-center justify-center rounded-md border border-slate-200 text-sm font-medium text-slate-700 active:bg-slate-50"
        >
          {t("tc_seeAllPayPeriods")}
        </Link>
      </CardContent>
    </Card>
  );
}

/** The one plain line that stands where the figures would: a read that failed, or someone paid by draw. */
export function MyPayNotice({ lang, kind }: { lang: string; kind: "cantShow" | "draw" }) {
  const t = translator(lang);
  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title={t("tc_myPayPeriods")} />
      <Card>
        <CardContent className="py-4">
          <p className="text-sm text-slate-700">{kind === "draw" ? t("tc_paidByDraw") : t("tc_payCantShow")}</p>
        </CardContent>
      </Card>
      <Link href="/timeclock" className={BACK}>
        {t("tc_backToClock")}
      </Link>
    </div>
  );
}

/** The way back, under the page: a full-height row a thumb can hit. */
const BACK = "mt-4 flex min-h-[44px] items-center text-sm font-medium text-slate-600 active:text-slate-900";

/** The one figure first: what the company still owes for closed hours (owedReading's words). A worker
 *  opens this page during the work day, on the clock, so the figure is NOT withheld for a running shift
 *  (the office's Payroll page still withholds it): it is said for his closed hours, and directly under it
 *  the line that the shift running now is not counted until he clocks out. */
function OwedFigure({ pay, lang }: { pay: MyPay; lang: string }) {
  const t = translator(lang);
  const reading = owedReading({ name: "", owed: pay.owed, onClock: false });
  return (
    <Card>
      <CardContent className="py-4">
        {reading.kind === "owed" && (
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-sm font-semibold text-slate-900">{t("tc_owedToYou")}</span>
            <span className="text-2xl font-bold text-slate-900">{formatCurrency(reading.amount, lang)}</span>
          </div>
        )}
        {reading.kind === "square" && <p className="text-sm font-semibold text-slate-900">{t("tc_paidUp")}</p>}
        {reading.kind === "ahead" && (
          <p className="text-sm font-semibold text-slate-900">{fillText(t("tc_paidAhead"), { amount: formatCurrency(reading.amount, lang) })}</p>
        )}
        {pay.onClock && (
          <p className="mt-1.5 rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-xs text-amber-800">{t("tc_openNotCounted")}</p>
        )}
        <p className="mt-1.5 text-xs text-slate-400">{t("tc_basePayOnly")}</p>
      </CardContent>
    </Card>
  );
}

function PeriodRow({ p, lang }: { p: MyPayPeriod; lang: string }) {
  const w = rowWords(p, lang);
  return (
    <Link href={periodHref(p)} className="block py-3 active:bg-slate-50">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="min-w-0 truncate font-medium text-slate-900">{w.dates}</span>
        <span className="shrink-0 font-semibold text-slate-900">{w.gross}</span>
      </div>
      <div className="mt-0.5 flex items-center justify-between gap-3 text-xs text-slate-500">
        <span className="min-w-0 truncate">{w.hours}</span>
        <span className="flex shrink-0 items-center gap-2">
          {w.left}
          <Badge tone={w.tone}>{w.state}</Badge>
        </span>
      </div>
      {/* The paid share, for the eye only: the words above say it. */}
      <div aria-hidden="true" className="mt-1.5 h-1 overflow-hidden rounded-full bg-slate-100">
        <div className="h-full rounded-full bg-green-500" style={{ width: `${w.paidShare}%` }} />
      </div>
    </Link>
  );
}

function PaymentRow({ p, lang }: { p: PayPaymentRow; lang: string }) {
  const t = translator(lang);
  const how = [paymentMethodLabel(p.method), p.reference ?? ""].filter((s) => s.trim()).join(" · ");
  return (
    <div className="py-2.5">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className={`min-w-0 truncate text-slate-700 ${p.voided ? "line-through" : ""}`}>{formatDate(p.paidOn, undefined, lang)}</span>
        <span className={`shrink-0 font-semibold text-slate-900 ${p.voided ? "line-through" : ""}`}>{formatCurrency(p.amount, lang)}</span>
      </div>
      <div className="mt-0.5 flex items-center justify-between gap-3 text-xs text-slate-500">
        <span className={`min-w-0 truncate ${p.voided ? "line-through" : ""}`}>{how}</span>
        {p.voided && <Badge tone="slate">{t("tc_undone")}</Badge>}
      </div>
    </div>
  );
}

/** The list: the one figure, every period newest first, what is owed from before them, and the payments. */
export function MyPayList({ pay, payments, lang }: { pay: MyPay; payments: PayPaymentRow[]; lang: string }) {
  const t = translator(lang);
  // At most ten, newest first; the office's own rule for which ones (a payment still to be checked is kept).
  const shown = paymentsToShow(payments, 10).shown.slice(0, 10);
  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title={t("tc_myPayPeriods")} description={t("tc_payPeriodsDesc")} />
      <div className="space-y-4">
        <OwedFigure pay={pay} lang={lang} />
        <Card>
          <CardContent className="py-2">
            {pay.periods.length === 0 ? (
              <p className="py-2 text-sm text-slate-500">{t("tc_noPayPeriods")}</p>
            ) : (
              <div className="divide-y divide-slate-100">
                {pay.periods.map((p) => (
                  <PeriodRow key={`${p.start}|${p.end}`} p={p} lang={lang} />
                ))}
                {pay.earlier > 0 && (
                  <div className="flex items-baseline justify-between gap-3 py-3 text-sm">
                    <span className="min-w-0 text-slate-700">{t("tc_earlierOwed")}</span>
                    <span className="shrink-0 font-semibold text-slate-900">{formatCurrency(pay.earlier, lang)}</span>
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
        {shown.length > 0 && (
          <Card>
            <CardContent className="py-4">
              <h3 className="text-sm font-semibold text-slate-900">{t("tc_paymentsToYou")}</h3>
              <div className="divide-y divide-slate-100">
                {shown.map((p) => (
                  <PaymentRow key={p.id} p={p} lang={lang} />
                ))}
              </div>
            </CardContent>
          </Card>
        )}
      </div>
      <Link href="/timeclock" className={BACK}>
        {t("tc_backToClock")}
      </Link>
    </div>
  );
}

type JobBits = { job_number?: string | null; name?: string | null; address?: string | null; customers?: { name?: string | null } | null } | null;

/** One period: its figures, its mileage, and its days with every entry in them. `entries` are this
 *  period's own, chosen by the page with lib/payroll-math entriesOfMyPeriod (the rule its figures use). */
export function MyPayPeriodView({
  period,
  entries,
  lang,
  tz,
  jobCodesOn,
}: {
  period: MyPayPeriod;
  entries: any[];
  lang: string;
  tz: string;
  jobCodesOn: boolean;
}) {
  const t = translator(lang);
  const w = rowWords(period, lang);
  const clock = (iso: string) => new Date(iso).toLocaleTimeString(localeOf(lang), { timeZone: tz, hour: "numeric", minute: "2-digit" });
  const jobTag = (j: JobBits): string | null =>
    j ? (jobCodesOn ? jobLabelWithNumber(j, lang === "es" ? "es" : "en") : jobSiteLabel({ ...j, customer_name: j.customers?.name ?? null })) : null;

  // The period's entries by the company's day, in clock order. A running shift is shown and not counted.
  const days: { day: string; label: string; total: number; rows: { id: string; when: string; lunch: number; job: string | null; hours: number | null }[] }[] = [];
  const mine = [...(entries ?? [])].sort((a, b) => String(a.clock_in).localeCompare(String(b.clock_in)));
  for (const e of mine) {
    const day = todayStrInTz(tz, new Date(e.clock_in));
    let g = days.find((d) => d.day === day);
    if (!g) {
      g = {
        day,
        label: new Date(e.clock_in).toLocaleDateString(localeOf(lang), { timeZone: tz, weekday: "short", month: "short", day: "numeric" }),
        total: 0,
        rows: [],
      };
      days.push(g);
    }
    const h = e.clock_out ? hoursBetween(e.clock_in, e.clock_out, e.lunch_minutes) : null;
    g.rows.push({
      id: String(e.id),
      when: `${clock(e.clock_in)}–${e.clock_out ? clock(e.clock_out) : t("tc_now")}`,
      lunch: Math.max(0, Number(e.lunch_minutes) || 0),
      job: jobTag(e.job ?? null),
      hours: h,
    });
    if (h != null) g.total += h;
  }

  const paidToward = period.paid > 0 ? fillText(t("tc_paidTowardThis"), { amount: formatCurrency(period.paid, lang) }) : "";
  const leftWords = period.left > 0 ? fillText(t("tc_leftAmount"), { amount: formatCurrency(period.left, lang) }) : "";
  const milesHeld = period.heldMiles > 0.05 ? fillText(t("tc_milesNotSettled"), { miles: String(Math.round(period.heldMiles * 10) / 10) }) : "";
  const mileagePaid = period.mileagePaid != null ? fillText(t("tc_mileagePaid"), { amount: formatCurrency(period.mileagePaid, lang) }) : "";

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title={w.dates} />
      <div className="space-y-4">
        <Card>
          <CardContent className="py-4">
            <div className="flex items-center justify-between gap-3 text-sm">
              <span className="text-slate-600">{w.hours}</span>
              <span className="flex items-center gap-2">
                <span className="font-bold text-slate-900">{w.gross}</span>
                <Badge tone={w.tone}>{w.state}</Badge>
              </span>
            </div>
            {paidToward && <p className="mt-1.5 text-sm text-slate-700">{paidToward}</p>}
            {leftWords && <p className="mt-0.5 text-sm font-semibold text-slate-900">{leftWords}</p>}
            {period.running && (
              <p className="mt-1.5 rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-xs text-amber-800">{t("tc_openNotCounted")}</p>
            )}
            {milesHeld && <p className="mt-1.5 text-xs text-slate-600">{milesHeld}</p>}
            {mileagePaid && <p className="mt-0.5 text-xs text-slate-600">{mileagePaid}</p>}
            <p className="mt-1.5 text-xs text-slate-400">{t("tc_basePayOnly")}</p>
          </CardContent>
        </Card>
        {days.length > 0 && (
          <Card>
            <CardContent className="py-3">
              <div className="divide-y divide-slate-100">
                {days.map((d) => (
                  <div key={d.day} className="py-2.5">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-semibold uppercase tracking-wide text-slate-500">{d.label}</span>
                      {d.total > 0 && <span className="font-medium text-slate-500">{formatDuration(d.total)}</span>}
                    </div>
                    {d.rows.map((r) => (
                      <div key={r.id} className="mt-1 flex items-center justify-between gap-3 text-sm">
                        <span className="min-w-0 truncate text-slate-700">
                          {r.when}
                          {r.lunch > 0 ? ` · ${fillText(t("tc_lunchShort"), { min: String(r.lunch) })}` : ""}
                          {r.job ? ` · ${r.job}` : ""}
                        </span>
                        <span className="shrink-0 text-slate-600">{r.hours != null ? formatDuration(r.hours) : t("tc_onTheClock")}</span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}
      </div>
      <Link href="/timeclock/pay" className={BACK}>
        {t("tc_backToPayPeriods")}
      </Link>
    </div>
  );
}
