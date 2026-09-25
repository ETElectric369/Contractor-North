import { ArrowLeft, Camera, ChevronRight, CircleDollarSign, Clock, FileText, Palette, Receipt } from "lucide-react";
import { formatCurrency } from "@/lib/utils";
import { formatDateTimeTz } from "@/lib/tz";
import type { PortalInvoice, PortalJobView } from "@/lib/portal/job-view-shape";
import { PublicInvoiceDocument, type PublicInvoiceData } from "@/components/public-invoice-document";
import { PortalSection, PortalShell } from "./portal-shell";
import { PortalLedger } from "./portal-ledger";
import { PortalKeepFresh, PortalPhotos, PortalPicks } from "./portal-media";
import { fmtHours, portalJobStatus, siteLine } from "./portal-format";

/**
 * THE CUSTOMER'S JOB PAGE (/portal/<token>/jobs/<jobId>), drawn from PortalJobView and nothing
 * else: shapePortalJob already cut the read to an allowlist, so this file cannot show a field the
 * shape does not carry. Live (Erik: "Update everything right away yes always"): the page says when
 * it was read, and every load reads again.
 *
 * Order, phone first: where the money stands; the stretches of work against the payments; work
 * not on a bill yet; the picks; the photos; every bill on the job exactly as /i prints it.
 *
 * A DRAFT IS NOT A BILL. While any bill on the job is a draft the money card says "Running total,
 * not a bill yet" and there is no Pay button for it. A sent bill keeps its own pay door, which is
 * the /i page (one door: the fee, the card and bank buttons and their refusals live there only).
 */
const BILL_STATUS: Record<string, string> = {
  draft: "Not Sent Yet",
  sent: "Sent",
  partial: "Part Paid",
  paid: "Paid",
  overdue: "Past Due",
};

const chip =
  "seaglass-btn inline-flex h-11 shrink-0 items-center whitespace-nowrap gap-1.5 rounded-xl px-3.5 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[rgb(var(--glass-ink))]";

export function PortalJobPage({ view, homeHref }: { view: PortalJobView; homeHref: string }) {
  const { org, job, ledger } = view;
  const thisYear = view.asOfDay.slice(0, 4);
  const site = siteLine(job.site);
  const unbilled = view.unbilled && (view.unbilled.hours > 0 || Math.abs(view.unbilled.total) > 0.005) ? view.unbilled : null;
  const payable = view.invoices.filter((i) => i.payToken && i.balance > 0.005);
  const bills = view.invoices.filter((i) => i.doc);
  const onlyAllWork = ledger.stretches.length === 1 && !ledger.stretches[0].id;
  const hasWork = ledger.stretches.some((s) => s.days.length > 0 || s.payments.length > 0);
  // Two money ideas must not share one name. While a bill is a draft, the figures above are a
  // running total that is "not a bill yet" too, so the work outside them is "not added yet".
  const notIn = view.running
    ? { nav: "Not Added Yet", title: "Work Not Added Yet", total: "Not Added Yet" }
    : { nav: "Not Billed Yet", title: "Work Not On A Bill Yet", total: "Not Billed Yet" };

  const sections: { id: string; label: string; icon: React.ReactNode }[] = [
    ...(hasWork ? [{ id: "work", label: "Work And Payments", icon: <Clock className="h-4 w-4" aria-hidden /> }] : []),
    ...(unbilled ? [{ id: "unbilled", label: notIn.nav, icon: <CircleDollarSign className="h-4 w-4" aria-hidden /> }] : []),
    ...(view.picks.length ? [{ id: "picks", label: "Picks", icon: <Palette className="h-4 w-4" aria-hidden /> }] : []),
    ...(view.photos.length ? [{ id: "photos", label: "Photos", icon: <Camera className="h-4 w-4" aria-hidden /> }] : []),
    ...(bills.length ? [{ id: "bills", label: bills.length === 1 ? "The Bill" : "Bills", icon: <Receipt className="h-4 w-4" aria-hidden /> }] : []),
  ];

  return (
    <PortalShell org={{ ...org }}>
      {/* Live, and the photo and file links last 10 minutes: an open or restored page reads again. */}
      <PortalKeepFresh asOf={view.asOf} />
      <a href={homeHref} className="mb-3 inline-flex min-h-[44px] items-center gap-1.5 rounded-lg px-1 text-sm font-medium text-[rgb(var(--glass-ink))] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[rgb(var(--glass-ink))]">
        <ArrowLeft className="h-4 w-4" aria-hidden /> All Your Jobs And Papers
      </a>

      {/* The job, and when this was read. */}
      <div className="px-1">
        <h1 className="text-2xl font-bold leading-tight text-slate-900">{job.name}</h1>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-slate-700">
          {job.number ? <span>{job.number}</span> : null}
          <span className="rounded-full bg-white/80 px-2 py-0.5 text-xs font-semibold text-[rgb(var(--glass-ink))]">
            {portalJobStatus(job.status)}
          </span>
        </div>
        {site ? <p className="mt-1 text-sm text-slate-700">{site}</p> : null}
        <p className="mt-1 text-xs text-slate-600">
          Up to date as of {formatDateTimeTz(view.asOf, view.timezone)}. Changes show here as soon as {org.name} makes them.
        </p>
      </div>

      <MoneyCard view={view} payable={payable} unbilledTotal={unbilled?.total ?? 0} />

      {sections.length > 1 ? (
        <nav aria-label="On this page" className="-mx-4 mt-4 overflow-x-auto px-4 [scrollbar-width:none]">
          <ul className="flex gap-2">
            {sections.map((s) => (
              <li key={s.id} className="shrink-0">
                <a href={`#${s.id}`} className={chip}>
                  {s.icon}
                  <span>{s.label}</span>
                </a>
              </li>
            ))}
          </ul>
        </nav>
      ) : null}

      {hasWork ? (
        <PortalSection
          id="work"
          title={onlyAllWork ? "Work And Payments" : "Stretches Of Work And Payments"}
          icon={<Clock className="h-4 w-4" />}
        >
          <p className="mb-2 px-1 text-sm text-slate-700">
            Tap a stretch to see each day: who worked, the hours and what was bought, as it is billed. The balance after each
            stretch is all the work so far minus all the payments so far.
          </p>
          <PortalLedger ledger={ledger} thisYear={thisYear} />
        </PortalSection>
      ) : (
        <div className="portal-glass mt-6 rounded-2xl px-4 py-6 text-center text-sm text-slate-700">
          No billed work on this job yet. It will show here day by day as it is billed.
        </div>
      )}

      {unbilled ? (
        <PortalSection id="unbilled" title={notIn.title} icon={<CircleDollarSign className="h-4 w-4" />}>
          <div className="portal-glass rounded-2xl p-4">
            <p className="text-sm text-slate-700">
              {view.running
                ? "This work is done but is not in the running total above yet. It is shown at the prices you would be billed, and it will be added later."
                : "This work is done but is not on a bill yet, so it is not in the figures above. It is shown at the prices you would be billed, and it will be on a bill later."}
            </p>
            <ul className="mt-3 divide-y divide-slate-200/70 rounded-xl bg-white/80 text-sm">
              {unbilled.laborByPerson.map((p) => (
                <li key={p.name} className="flex items-start justify-between gap-3 px-3 py-2">
                  <div>
                    <div className="font-medium text-slate-900">{p.name}</div>
                    <div className="text-xs text-slate-600">{fmtHours(p.hours)}</div>
                  </div>
                  <div className="tabular-nums">{formatCurrency(p.amount)}</div>
                </li>
              ))}
              {Math.abs(unbilled.materials) > 0.005 ? (
                <li className="flex justify-between gap-3 px-3 py-2">
                  <span className="font-medium text-slate-900">Materials</span>
                  <span className="tabular-nums">{formatCurrency(unbilled.materials)}</span>
                </li>
              ) : null}
              {unbilled.returnsCredit > 0.005 ? (
                <li className="flex justify-between gap-3 px-3 py-2">
                  <span className="font-medium text-slate-900">Returns To Credit</span>
                  <span className="tabular-nums text-emerald-800">−{formatCurrency(unbilled.returnsCredit)}</span>
                </li>
              ) : null}
              <li className="flex justify-between gap-3 px-3 py-2 font-semibold">
                <span>{notIn.total}</span>
                <span className="tabular-nums">{formatCurrency(unbilled.total)}</span>
              </li>
            </ul>
          </div>
        </PortalSection>
      ) : null}

      {view.picks.length ? (
        <PortalSection id="picks" title="Your Picks" icon={<Palette className="h-4 w-4" />}>
          <p className="mb-2 px-1 text-sm text-slate-700">The colors, fixtures and finishes chosen for this job. Tap one to see it.</p>
          <PortalPicks picks={view.picks} />
        </PortalSection>
      ) : null}

      {view.photos.length ? (
        <PortalSection id="photos" title="Photos" icon={<Camera className="h-4 w-4" />} aside={<span className="text-sm text-slate-600">Newest first</span>}>
          <PortalPhotos photos={view.photos} thisYear={thisYear} />
        </PortalSection>
      ) : null}

      {bills.length ? (
        <PortalSection id="bills" title={bills.length === 1 ? "The Bill" : "Bills"} icon={<Receipt className="h-4 w-4" />}>
          <div className="space-y-3">
            {bills.map((b, i) => (
              <BillCard key={`${b.number ?? "bill"}-${i}`} b={b} explainBalance={hasWork && b.amountPaid > 0.005} />
            ))}
          </div>
        </PortalSection>
      ) : null}
    </PortalShell>
  );
}

function MoneyCard({ view, payable, unbilledTotal }: { view: PortalJobView; payable: PortalInvoice[]; unbilledTotal: number }) {
  const { ledger } = view;
  const ahead = ledger.balance < -0.005;
  return (
    <div className="portal-glass glass-gloss mt-4 rounded-2xl p-4">
      <div className="relative z-10">
        {view.running ? (
          <p className="mb-3 rounded-xl bg-[rgb(var(--glass-tint)/0.16)] px-3 py-2 text-sm font-semibold text-[rgb(var(--glass-ink))]">
            Running total, not a bill yet.
            <span className="block text-xs font-normal text-slate-700">
              {view.org.name} hasn&apos;t sent this as a bill. It is the work and payments so far, and it changes as the job goes.
            </span>
          </p>
        ) : null}
        <dl className="grid grid-cols-3 gap-2">
          <div>
            <dt className="text-xs font-medium text-slate-600">Work So Far</dt>
            <dd className="text-base font-semibold tabular-nums text-slate-900 sm:text-lg">{formatCurrency(ledger.workTotal)}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-slate-600">Paid</dt>
            <dd className="text-base font-semibold tabular-nums text-emerald-800 sm:text-lg">{formatCurrency(ledger.paidTotal)}</dd>
          </div>
          <div className="text-right">
            <dt className="text-xs font-medium text-slate-600">{ahead ? "Paid Ahead" : "Balance"}</dt>
            <dd className="text-xl font-bold tabular-nums text-slate-900 sm:text-2xl">{formatCurrency(Math.abs(ledger.balance))}</dd>
          </div>
        </dl>
        {unbilledTotal > 0.005 ? (
          <p className="mt-2 text-sm text-slate-700">
            Plus{" "}
            <a href="#unbilled" className="font-semibold text-[rgb(var(--glass-ink))] underline underline-offset-2">
              {formatCurrency(unbilledTotal)} of work {view.running ? "not added to the running total yet" : "not on a bill yet"}
            </a>
            .
          </p>
        ) : null}
        {payable.length ? (
          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            {payable.map((b) => (
              <a
                key={b.payToken!}
                href={`/i/${b.payToken}`}
                rel="nofollow"
                className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-xl bg-[rgb(var(--glass-ink))] px-5 py-2.5 text-center text-base font-semibold text-white shadow-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[rgb(var(--glass-ink))]"
              >
                View And Pay {b.number ?? "The Bill"} ({formatCurrency(b.balance)} due)
                <ChevronRight className="h-4 w-4" aria-hidden />
              </a>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * One bill, closed until tapped (the money card and the stretches already say where things stand;
 * the full sheet is the detail). Inside, the sheet is the customer's copy exactly as /i prints it,
 * drawn by the same PublicInvoiceDocument. `.portal-bill` only changes how it sits on a phone
 * (globals.css): the printed margins and the 11in floor come off, the letterhead and Bill To wrap,
 * and each line puts its amount beside its description, so nothing hides behind a sideways scroll.
 */
function BillCard({ b, explainBalance }: { b: PortalInvoice; explainBalance: boolean }) {
  const status = BILL_STATUS[b.status] ?? "Sent";
  return (
    <details className="portal-glass group rounded-2xl">
      <summary className="portal-summary flex min-h-[44px] cursor-pointer list-none items-center gap-3 rounded-2xl px-4 py-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[rgb(var(--glass-ink))]">
        <ChevronRight className="h-5 w-5 shrink-0 text-[rgb(var(--glass-ink))] motion-safe:transition-transform group-open:rotate-90" aria-hidden />
        <FileText className="h-5 w-5 shrink-0 text-slate-600" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="font-semibold text-slate-900">{b.number ?? "Bill"}</div>
          <div className="text-sm text-slate-700">
            {b.isDraft ? "Running total, not sent yet" : status}
            <span aria-hidden> · </span>
            <span className="tabular-nums">Total {formatCurrency(b.total)}</span>
          </div>
        </div>
        <div className="text-right">
          <div className="text-[11px] font-medium uppercase tracking-wide text-slate-600">Balance</div>
          <div className="font-bold tabular-nums">{formatCurrency(b.balance)}</div>
        </div>
      </summary>
      <div className="border-t border-white/70 sm:p-3">
        {explainBalance ? (
          <p className="px-3 pt-2 text-xs text-slate-700 sm:px-1 sm:pt-0 sm:pb-2">
            In this bill&apos;s list of payments, Balance counts down from the whole bill. The stretches above count up
            from the work done so far, so after the same payment the two figures differ.
          </p>
        ) : null}
        {b.payToken ? (
          <div className="flex justify-end p-2 sm:mb-2 sm:p-0">
            <a href={`/i/${b.payToken}`} rel="nofollow" className={chip}>
              {b.balance > 0.005 ? "View And Pay" : "Open On Its Own Page"}
              <ChevronRight className="h-4 w-4" aria-hidden />
            </a>
          </div>
        ) : null}
        <div className="portal-bill overflow-x-auto rounded-b-2xl sm:rounded-xl">
          <PublicInvoiceDocument data={b.doc as PublicInvoiceData} />
        </div>
      </div>
    </details>
  );
}
