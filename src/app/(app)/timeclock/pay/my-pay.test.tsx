import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dict } from "@/lib/i18n";
import { formatCurrency } from "@/lib/utils";
import { entriesOfMyPeriod, myPayPeriods, toPayPaymentRow, type MyPay, type MyPayPeriod, type MyPayRun, type PayPaymentRow } from "@/lib/payroll-math";
import { MyPayCard, MyPayList, MyPayNotice, MyPayPeriodView, periodHref, rowWords } from "./my-pay-views";

/**
 * MY PAY PERIODS, DRAWN AND READ (cn-v1166). The repository has no DOM, so the pages are proven by
 * static renders of the pieces they hand their reads to, and the reads by their source: the list and one
 * period in every state a worker meets (paid, partly paid with what is left, unpaid, on the clock, paid
 * up, can't show) and in Spanish; and that the read selects nothing priced, no rate but his own, and no
 * note, and reads only his own rows. Stand-in names only.
 */
const ROOT = process.cwd();
const src = (f: string) => readFileSync(join(ROOT, f), "utf8");
const TZ = "America/Los_Angeles";
const O = { tz: TZ, schedule: "biweekly" as const, anchor: "2026-01-05" };
const SAM = "11111111-1111-4111-8111-111111111111";
const en = dict("en");
const es = dict("es");

let seq = 0;
function entry(day: string, hours: number, more: { paid?: boolean; running?: boolean; miles?: number; lunch?: number } = {}) {
  const inIso = `${day}T16:00:00.000Z`;
  seq += 1;
  return {
    id: `e${seq}`,
    profile_id: SAM,
    clock_in: inIso,
    clock_out: more.running ? null : new Date(Date.parse(inIso) + hours * 3_600_000 + (more.lunch ?? 0) * 60_000).toISOString(),
    status: more.running ? "open" : "closed",
    lunch_minutes: more.lunch ?? 0,
    miles: more.miles ?? 0,
    paid_at: more.paid ? "2026-01-20T00:00:00Z" : null,
    mileage_paid_at: null,
    rate_override: null,
    split_from: null,
    job: { job_number: "J-012", name: "Larkspur Kitchen", address: "12 Snowbell Way", customers: { name: "Dana Rook" } },
    profiles: { hourly_rate: 40, commute_baseline_miles: 0 },
  };
}
const baseRun = (start: string, end: string, gross: number, hours: number): MyPayRun => ({ kind: "base", period_start: start, period_end: end, hours, gross, miles: 0, mileage_amount: null });
const payment = (amount: number, paidOn: string, more: { voided?: boolean; reference?: string; note?: string } = {}): PayPaymentRow =>
  toPayPaymentRow({
    id: `p-${paidOn}-${amount}`,
    profile_id: SAM,
    amount,
    paid_on: paidOn,
    method: "check",
    reference: more.reference ?? null,
    note: more.note ?? null,
    needs_check: false,
    voided_at: more.voided ? "2026-02-01T00:00:00Z" : null,
  });

/** Three periods: Jan 5–18 locked and paid; Jan 19–Feb 1 partly paid; Feb 2–15 unpaid with a shift running. */
function fixture(): { pay: MyPay; entries: any[]; payments: PayPaymentRow[]; runs: MyPayRun[]; of: (p: MyPayPeriod) => any[] } {
  const entries = [
    entry("2026-01-06", 8, { paid: true }),
    entry("2026-01-20", 10, { miles: 23 }),
    entry("2026-02-03", 5, { lunch: 30 }),
    entry("2026-02-04", 0, { running: true }),
  ];
  const payments = [payment(150, "2026-02-01", { reference: "1043", note: "OFFICE NOTE never shown" }), payment(320, "2026-01-19"), payment(75, "2026-01-25", { voided: true })];
  const runs = [baseRun("2026-01-05", "2026-01-19", 320, 8)];
  const pay = myPayPeriods({ profileId: SAM, name: "", entries, runs, payments, ...O, fallbackRate: 40 });
  // One period's entries, chosen as its page chooses them (the rule its figures were built by).
  const of = (p: MyPayPeriod) => entriesOfMyPeriod(entries, runs, O, p);
  return { pay, entries, payments, runs, of };
}

describe("the list", () => {
  const f = fixture();
  const html = renderToStaticMarkup(createElement(MyPayList, { pay: f.pay, payments: f.payments, lang: "en" }));

  it("the fixture is the three states and a running shift", () => {
    expect(f.pay.periods.map((p) => [p.start, p.state, p.gross, p.paid, p.left])).toEqual([
      ["2026-02-02", "unpaid", 200, 0, 200],
      ["2026-01-19", "partly", 400, 150, 250],
      ["2026-01-05", "paid", 320, 320, 0],
    ]);
    expect(f.pay.onClock).toBe(true);
  });

  it("a shift on the clock does NOT withhold the one figure: Owed to You for closed hours, and directly under it that the running shift isn't counted", () => {
    expect(html).toContain(en.tc_owedToYou);
    expect(html).toContain(formatCurrency(f.pay.owed, "en"));
    expect(f.pay.owed).toBe(450);
    expect(html).toContain(en.tc_openNotCounted);
    // The line stands directly under the figure, before the base-pay line and before any period row.
    const fig = html.indexOf(formatCurrency(f.pay.owed, "en"));
    const line = html.indexOf(en.tc_openNotCounted);
    expect(fig).toBeLessThan(line);
    expect(line).toBeLessThan(html.indexOf(en.tc_basePayOnly));
    expect(line).toBeLessThan(html.indexOf("/timeclock/pay/"));
    expect(html).toContain(en.tc_basePayOnly);
    expect(html).toContain(en.tc_myPayPeriods);
    expect(html).toContain(en.tc_payPeriodsDesc);
  });

  it("each period is a link to its own page: dates and gross, hours and its state, Partly Paid with what is left", () => {
    expect(html).toContain('href="/timeclock/pay/2026-01-19_2026-02-02"');
    expect(html).toContain('href="/timeclock/pay/2026-01-05_2026-01-19"');
    expect(html).toContain("Jan 19, 2026 – Feb 1, 2026");
    expect(html).toContain("$400.00");
    expect(html).toContain("10h 0m");
    expect(html).toContain("$250.00 left");
    expect(html).toContain(`>${en.tc_partlyPaid}<`);
    expect(html).toContain(`>${en.tc_paid}<`);
    expect(html).toContain(`>${en.tc_unpaid}<`);
    // The bar is for the eye only, and its share is the paid share.
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("width:38%");
    expect(html).toContain("width:100%");
    expect(html).toContain("width:0%");
    // Never a table.
    expect(html).not.toContain("<table");
  });

  it("the payments: date, amount, method and reference; an undone one struck through and marked; never the office's note", () => {
    expect(html).toContain(en.tc_paymentsToYou);
    expect(html).toContain("Check · 1043");
    expect(html).toContain("line-through");
    expect(html).toContain(`>${en.tc_undone}<`);
    expect(html).not.toContain("OFFICE NOTE");
    expect(html).toContain('href="/timeclock"');
    expect(html).toContain(en.tc_backToClock);
  });

  it("owed with no shift running: Owed to You and the amount, first", () => {
    const pay: MyPay = { ...f.pay, onClock: false };
    const out = renderToStaticMarkup(createElement(MyPayList, { pay, payments: [], lang: "en" }));
    expect(out).toContain(en.tc_owedToYou);
    expect(out).toContain(formatCurrency(pay.owed, "en"));
    expect(out.indexOf(en.tc_owedToYou)).toBeLessThan(out.indexOf("/timeclock/pay/"));
    expect(out).not.toContain(en.tc_openNotCounted);
    expect(out).not.toContain(en.tc_paymentsToYou);
  });

  it("paid up, paid ahead, earlier pay still owed, and no periods yet", () => {
    const base: MyPay = { periods: [], owed: 0, earlier: 0, onClock: false, unreadable: false };
    expect(renderToStaticMarkup(createElement(MyPayList, { pay: base, payments: [], lang: "en" }))).toContain(en.tc_paidUp.replace(/'/g, "&#x27;"));
    expect(renderToStaticMarkup(createElement(MyPayList, { pay: base, payments: [], lang: "en" }))).toContain(en.tc_noPayPeriods);
    const ahead = renderToStaticMarkup(createElement(MyPayList, { pay: { ...base, owed: -60 }, payments: [], lang: "en" }));
    expect(ahead).toContain("You&#x27;re paid $60.00 ahead. It comes off your next hours.");
    const p: MyPayPeriod = { start: "2026-01-19", end: "2026-02-02", hours: 2, gross: 80, paid: 0, left: 80, state: "unpaid", locked: false, running: false, heldMiles: 0, settledMiles: 0, mileagePaid: null };
    const earlier = renderToStaticMarkup(createElement(MyPayList, { pay: { ...base, periods: [p], owed: 130, earlier: 50 }, payments: [], lang: "en" }));
    expect(earlier).toContain(en.tc_earlierOwed);
    expect(earlier).toContain("$50.00");
  });

  it("a period holding only a running shift says On the Clock and no money", () => {
    const p: MyPayPeriod = { start: "2026-02-02", end: "2026-02-16", hours: 0, gross: 0, paid: 0, left: 0, state: "onClock", locked: false, running: true, heldMiles: 0, settledMiles: 0, mileagePaid: null };
    const w = rowWords(p, "en");
    expect(w).toMatchObject({ gross: "", hours: "", left: "", state: en.tc_onTheClock, tone: "blue" });
  });

  it("can't show and paid by draw: one plain line and no figure", () => {
    const cant = renderToStaticMarkup(createElement(MyPayNotice, { lang: "en", kind: "cantShow" }));
    expect(cant).toContain("Your pay can&#x27;t be shown right now. Nothing changed.");
    expect(cant).not.toContain("$");
    const draw = renderToStaticMarkup(createElement(MyPayNotice, { lang: "en", kind: "draw" }));
    expect(draw).toContain("You&#x27;re paid by owner&#x27;s draw, so there are no pay periods here.");
    expect(draw).not.toContain("$");
  });

  it("in Spanish: every word is the catalog's, and the money and days in the reader's language", () => {
    const out = renderToStaticMarkup(createElement(MyPayList, { pay: f.pay, payments: f.payments, lang: "es" }));
    for (const k of ["tc_myPayPeriods", "tc_payPeriodsDesc", "tc_openNotCounted", "tc_paymentsToYou", "tc_undone", "tc_backToClock", "tc_partlyPaid"]) {
      expect(out, k).toContain(es[k].replace(/'/g, "&#x27;"));
    }
    expect(out).toContain(`Faltan ${formatCurrency(250, "es")}`);
    expect(out).not.toContain("Payments to You");
    expect(out).not.toContain(" left");
    expect(out).toContain("ene");
  });
});

describe("one period", () => {
  const f = fixture();
  const partly = f.pay.periods.find((p) => p.state === "partly")!;
  const html = renderToStaticMarkup(createElement(MyPayPeriodView, { period: partly, entries: f.of(partly), lang: "en", tz: TZ, jobCodesOn: true }));

  it("its figures: hours and gross, what was paid toward it and what is left, mileage not settled; base pay only", () => {
    expect(html).toContain("Jan 19, 2026 – Feb 1, 2026");
    expect(html).toContain("$150.00 paid toward this period");
    expect(html).toContain("$250.00 left");
    expect(html).toContain("23 mi not settled yet");
    expect(html).toContain(en.tc_basePayOnly);
    expect(html).not.toContain("Mileage paid");
    expect(html).toContain('href="/timeclock/pay"');
    expect(html).toContain(en.tc_backToPayPeriods);
  });

  it("its days, each entry with the job by number and name, in–out and hours; another period's entries are not here", () => {
    expect(html).toContain("J-012 · Larkspur Kitchen");
    expect(html).toContain("8:00 AM–6:00 PM");
    expect(html).toContain("10h 0m");
    expect(html).not.toContain("Jan 6");
    expect(html).not.toContain("Feb 3");
  });

  it("a paid period with a stated mileage settlement; a period with a running shift shows it on the clock, not counted", () => {
    const paid: MyPayPeriod = { ...f.pay.periods.find((p) => p.state === "paid")!, mileagePaid: 12.5 };
    const out = renderToStaticMarkup(createElement(MyPayPeriodView, { period: paid, entries: f.of(paid), lang: "en", tz: TZ, jobCodesOn: true }));
    expect(out).toContain("Mileage paid $12.50");
    expect(out).toContain("$320.00 paid toward this period");
    expect(out).not.toContain(" left<");
    const unpaid = f.pay.periods.find((p) => p.state === "unpaid")!;
    const run = renderToStaticMarkup(createElement(MyPayPeriodView, { period: unpaid, entries: f.of(unpaid), lang: "en", tz: TZ, jobCodesOn: true }));
    expect(run).toContain(en.tc_openNotCounted);
    expect(run).toContain(en.tc_onTheClock);
    expect(run).toContain("8:00 AM–now");
    expect(run).toContain("30m lunch");
  });

  it("codes off: the job by its customer and street", () => {
    const out = renderToStaticMarkup(createElement(MyPayPeriodView, { period: partly, entries: f.of(partly), lang: "en", tz: TZ, jobCodesOn: false }));
    expect(out).toContain("Dana Rook · 12 Snowbell Way");
  });

  it("in Spanish", () => {
    const out = renderToStaticMarkup(createElement(MyPayPeriodView, { period: partly, entries: f.of(partly), lang: "es", tz: TZ, jobCodesOn: true }));
    expect(out).toContain(`${formatCurrency(150, "es")} pagado para este periodo`);
    expect(out).toContain("23 mi aún sin liquidar");
    expect(out).toContain(es.tc_backToPayPeriods);
    expect(out).not.toContain("paid toward");
  });

  it("the address is the period's first day and its exclusive end, and the page checks it is his", () => {
    expect(periodHref(partly)).toBe("/timeclock/pay/2026-01-19_2026-02-02");
    const page = src("src/app/(app)/timeclock/pay/[period]/page.tsx");
    expect(page).toContain("/^(\\d{4}-\\d{2}-\\d{2})_(\\d{4}-\\d{2}-\\d{2})$/");
    expect(page).toContain("if (!m) notFound();");
    expect(page).toContain("const period = data.pay.periods.find((p) => p.start === m[1] && p.end === m[2]);");
    expect(page).toContain("if (!period) notFound();");
    // Its entries by the SAME rule its figures use, never a second date filter in the page or the view.
    expect(page).toContain("const entries = entriesOfMyPeriod(data.entries, data.runs, rule, period);");
    expect(page).toContain("withJobs: true");
    expect(src("src/app/(app)/timeclock/pay/my-pay-views.tsx")).not.toContain("day >= period.start");
  });
});

describe("the read takes only his own rows and nothing priced", () => {
  const read = src("src/app/(app)/timeclock/pay/my-pay-read.ts");
  const code = read.replace(/\/\*\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const selects = [...code.matchAll(/const (\w+_COLS) =\s*"([^"]*)"/g)].map((m) => [m[1], m[2]] as const);

  it("names every column, never *, never bill_rate, cost_rate, a note, created_by or a job's money", () => {
    expect(selects.map(([n]) => n).sort()).toEqual(["MY_ENTRY_COLS", "MY_ENTRY_JOB_COLS", "MY_PAYMENT_COLS", "MY_RUN_COLS", "SELF_PAY_COLS"]);
    for (const [name, cols] of selects) {
      for (const bad of ["*", "bill_rate", "cost_rate", "created_by", "price", "amount_due", "total", "cost", "budget", "contract"]) {
        expect(cols, `${name}: ${bad}`).not.toContain(bad);
      }
      expect(cols.split(/[\s,()]+/), `${name}: note`).not.toContain("note");
      expect(cols.split(/[\s,()]+/), `${name}: notes`).not.toContain("notes");
    }
    expect(code).not.toMatch(/\.select\(\s*["'`]\*/);
    // Every .select( names one of the lists (the entries' two through entryCols, chosen by withJobs).
    for (const m of code.matchAll(/\.select\(([^)]*)\)/g)) expect(["SELF_PAY_COLS", "entryCols", "MY_PAYMENT_COLS", "MY_RUN_COLS"]).toContain(m[1].trim());
    expect(code).toContain("const entryCols = o.withJobs ? MY_ENTRY_JOB_COLS : MY_ENTRY_COLS;");
    // The job: its number, name, street and customer's name, nothing else, and ONLY on the one-period read.
    const plain = selects.find(([n]) => n === "MY_ENTRY_COLS")![1];
    const withJob = selects.find(([n]) => n === "MY_ENTRY_JOB_COLS")![1];
    expect(plain).not.toContain("job");
    expect(withJob).toBe(`${plain}, job:job_id(job_number, name, address, customers(name))`);
    expect(src("src/app/(app)/timeclock/pay/page.tsx")).not.toContain("withJobs");
    expect(src("src/app/(app)/timeclock/page.tsx")).not.toContain("withJobs");
    expect(selects.find(([n]) => n === "SELF_PAY_COLS")![1]).toBe("hourly_rate, commute_baseline_miles, paid_by_draw");
  });

  it("every read is his own: profile_id (or his own id on profile_pay) on each", () => {
    const froms = [...code.matchAll(/\.from\("(\w+)"\)/g)].map((m) => m[1]);
    expect(froms.sort()).toEqual(["pay_payments", "payroll_runs", "profile_pay", "time_entries", "time_entries"]);
    expect(code.match(/\.eq\("profile_id", userId\)/g)?.length).toBe(4);
    expect(code).toContain('.from("profile_pay").select(SELF_PAY_COLS).eq("id", userId).maybeSingle()');
  });

  it("the reads come back whole or no figure is drawn; paid by draw is its own answer", () => {
    expect(code).toContain('if (error || !data) return "failed";');
    expect(code).toContain('return "tooLong";');
    expect(code).toContain('if ([closed, open, paymentRows, runs].includes("failed")) return cantShow("failed");');
    expect(code).toContain('if (selfRes?.error || !self) return cantShow("failed", selfRes?.error);');
    expect(code).toContain("if (isPaidByDraw(self)) return { kind: \"draw\" };");
    expect(code).toContain('if (pay.unreadable) return cantShow("unreadable");');
    // The window is the office's.
    expect(code).toContain("balanceWindowStartYmd(o.today)");
  });

  it("the pages hand the read to the views and render the notice for anything but ok", () => {
    for (const f of ["src/app/(app)/timeclock/pay/page.tsx", "src/app/(app)/timeclock/pay/[period]/page.tsx"]) {
      const s = src(f);
      expect(s, f).toContain("if (data.kind !== \"ok\") return <MyPayNotice lang={lang} kind={data.kind} />;");
      // A page exports only what Next allows.
      expect([...s.matchAll(/^export (?:const|async function|function|default)\s*(\w*)/gm)].map((m) => m[1]).sort()).toEqual(["async", "dynamic"]);
    }
  });
});

describe("the card on the clock is the newest row of the same rule", () => {
  it("drawn for a non-staff person only, from myPayPeriods' newest row, with partly paid and the door to every period", () => {
    const page = src("src/app/(app)/timeclock/page.tsx");
    expect(page).toContain("!isStaff && user");
    expect(page).toContain("readMyPay(supabase, user.id,");
    expect(page).toContain("const newest = myPay?.kind === \"ok\" ? (myPay.pay.periods[0] ?? null) : null;");
    expect(page).toContain("{!isStaff && <MyPayCard newest={newest} cantShow={myPayCantShow} lang={lang} />}");
    // The card no longer decides paid from paid_at.
    expect(page).not.toContain("row.unpaidHours === 0");
    expect(page).not.toContain("aggregatePayrollEntries");
  });
});

describe("the card on the clock, drawn (MyPayCard)", () => {
  const f = fixture();
  const partly = f.pay.periods.find((p) => p.state === "partly")!;
  const card = (newest: MyPayPeriod | null, cantShow: boolean, lang: string) => renderToStaticMarkup(createElement(MyPayCard, { newest, cantShow, lang }));

  it("partly paid on a 320px phone: what is left stands on a line of its own, and the figures' line wraps", () => {
    for (const [lang, d] of [["en", en], ["es", es]] as const) {
      const out = card({ ...partly, left: 1234.56 }, false, lang);
      const left = `${d.tc_leftAmount.replace("{amount}", formatCurrency(1234.56, lang))}</p>`;
      // Its own paragraph, after the hours / gross / badge line has closed.
      expect(out, lang).toContain(`<p class="mt-0.5 text-right text-xs text-slate-500">${left}`);
      expect(out.indexOf(`>${d.tc_partlyPaid}<`), lang).toBeLessThan(out.indexOf(left));
      expect(out, lang).toContain('class="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 text-sm"');
      expect(out, lang).toContain(d.tc_seeAllPayPeriods);
      expect(out, lang).toContain('href="/timeclock/pay"');
    }
  });

  it("paid has no left line; a failed read says so in place of a figure; nothing at all is drawn with neither", () => {
    const paid = f.pay.periods.find((p) => p.state === "paid")!;
    const out = card(paid, false, "en");
    expect(out).toContain(`>${en.tc_paid}<`);
    expect(out).not.toContain(" left<");
    const cant = card(null, true, "en");
    expect(cant).toContain(en.tc_payCantShow.replace(/'/g, "&#x27;"));
    expect(cant).not.toContain("$");
    expect(card(null, false, "en")).toBe("");
  });
});
