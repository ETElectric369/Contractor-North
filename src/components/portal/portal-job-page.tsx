import { ArrowLeft, Camera, ChevronRight, CircleDollarSign, Clock, DraftingCompass, FileText, Palette, Receipt, Zap } from "lucide-react";
import { formatCurrency } from "@/lib/utils";
import { formatDateTimeTz } from "@/lib/tz";
import type { PortalInvoice, PortalJobView } from "@/lib/portal/job-view-shape";
import { InvoiceDocument } from "@/components/invoice-document";
import { PortalSection, PortalShell } from "./portal-shell";
import { PortalLedger, SplitRows } from "./portal-ledger";
import { PortalKeepFresh, PortalPhotos, PortalPicks } from "./portal-media";
import { PortalDocuments } from "./portal-documents";
import { PortalPanel } from "./portal-panel";
import { fmtHours, portalJobStatus, siteLine } from "./portal-format";

/**
 * THE CUSTOMER'S JOB PAGE (/portal/<token>/jobs/<jobId>), drawn from PortalJobView and nothing
 * else: shapePortalJob already cut the read to an allowlist, so this file cannot show a field the
 * shape does not carry. Live (Erik: "Update everything right away yes always"): the page says when
 * it was read, and every load reads again.
 *
 * Order, phone first: where the money stands; the stretches of work against the payments; work
 * not on a bill yet; the picks; the plans and drawings (0326, newest version only); the panel (0335,
 * once the office shows it); the photos; every bill on the job exactly as /i prints it.
 *
 * LABOR AND MATERIALS, APART (Erik, 2026-09-24, on Andrew's page: "there is no simple breakdown
 * separating time and material right at the top, its all mixed in"). The money card leads with
 * Labor (and its hours) and Materials as two lines that add up to Billed To Date, then Paid and the
 * Balance; the stretches, each day, the work not billed yet and the bill itself keep the same two
 * headings (and any other kind of line under its own, only when there is one). One rule decides
 * which line is which everywhere: line-kind, from what the line stored, and for a typed line the
 * same words-and-unit rule the /i Cost Breakdown reads, so the portal and the bill never disagree.
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

export function PortalJobPage({
  view,
  homeHref,
  footer,
}: {
  view: PortalJobView;
  homeHref: string;
  /** Under the page (0331: Sign Out On This Device). */
  footer?: React.ReactNode;
}) {
  const { org, job, ledger } = view;
  const thisYear = view.asOfDay.slice(0, 4);
  const site = siteLine(job.site);
  const unbilled = view.unbilled && (view.unbilled.hours > 0 || Math.abs(view.unbilled.total) > 0.005) ? view.unbilled : null;
  const payable = view.invoices.filter((i) => i.payToken && i.balance > 0.005);
  const bills = view.invoices.filter((i) => i.doc || i.docFailed);
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
    ...(view.documents.length ? [{ id: "plans", label: "Plans And Drawings", icon: <DraftingCompass className="h-4 w-4" aria-hidden /> }] : []),
    ...(view.panels.length ? [{ id: "panel", label: "Panel", icon: <Zap className="h-4 w-4" aria-hidden /> }] : []),
    ...(view.photos.length ? [{ id: "photos", label: "Photos", icon: <Camera className="h-4 w-4" aria-hidden /> }] : []),
    ...(bills.length ? [{ id: "bills", label: bills.length === 1 ? "The Bill" : "Bills", icon: <Receipt className="h-4 w-4" aria-hidden /> }] : []),
  ];

  return (
    <PortalShell org={{ ...org }} footer={footer}>
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
            Each stretch shows its labor, materials and payments. Tap one to see each day: the labor (who worked and how long)
            and the materials (what was bought), as billed. The balance after each stretch is all the work to date minus all
            the payments so far.
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
            <UnbilledSplit unbilled={unbilled} totalLabel={notIn.total} />
          </div>
        </PortalSection>
      ) : null}

      {view.picks.length ? (
        <PortalSection id="picks" title="Your Picks" icon={<Palette className="h-4 w-4" />}>
          <p className="mb-2 px-1 text-sm text-slate-700">The colors, fixtures and finishes chosen for this job. Tap one to see it.</p>
          <PortalPicks picks={view.picks} />
        </PortalSection>
      ) : null}

      {view.documents.length ? (
        <PortalSection id="plans" title="Plans And Drawings" icon={<DraftingCompass className="h-4 w-4" />}>
          <p className="mb-2 px-1 text-sm text-slate-700">
            The plans, permits and drawings for this job. When {org.name} updates one, you see the newest version here.
          </p>
          <PortalDocuments documents={view.documents} thisYear={thisYear} />
        </PortalSection>
      ) : null}

      {view.panels.length ? (
        <PortalSection id="panel" title="Your Panel" icon={<Zap className="h-4 w-4" />}>
          <PortalPanel panels={view.panels} />
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
              {view.org.name} hasn&apos;t sent this as a bill. It is the work and payments to date, and it changes as the job goes.
            </span>
          </p>
        ) : null}
        {/* Labor and Materials first, as two lines that add up to what the bills carry (any other
            kind of line, a change order or a credit, gets its own line between them only when
            there is one), then what was paid and what is left. The total is the BILLS' total, not
            work to date (that is the Progress Summary's figure, tmWorkToDate): it may hold a
            deposit or tax and leaves out work not on a bill, stated on its own line below. So it
            never wears the work-to-date name. */}
        <dl data-portal-money className="text-base">
          <SplitRows split={ledger.split} total={ledger.workTotal} totalLabel={view.running ? "Running Total" : "Billed To Date"} />
          <div className="flex items-baseline justify-between gap-3 py-0.5">
            <dt className="text-slate-700">Paid</dt>
            <dd className="shrink-0 font-semibold tabular-nums text-emerald-800">{formatCurrency(ledger.paidTotal)}</dd>
          </div>
          <div className="mt-1 flex items-baseline justify-between gap-3 border-t border-slate-300/80 pt-1.5">
            <dt className="font-bold text-slate-900">{ahead ? "Paid Ahead" : "Balance"}</dt>
            <dd className="shrink-0 text-xl font-bold tabular-nums text-slate-900 sm:text-2xl">{formatCurrency(Math.abs(ledger.balance))}</dd>
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
 * The work not on a bill (or not in the running total) yet, under the same two headings as
 * everything above: Labor (each person, their hours) with its subtotal, Materials (and any returns
 * still to be credited) with its subtotal, then the total.
 */
function UnbilledSplit({ unbilled, totalLabel }: { unbilled: NonNullable<PortalJobView["unbilled"]>; totalLabel: string }) {
  const hasLabor = unbilled.laborByPerson.length > 0 || Math.abs(unbilled.laborAmount) > 0.005;
  const hasMaterials = Math.abs(unbilled.materials) > 0.005 || unbilled.returnsCredit > 0.005;
  const materialsNet = Math.round((unbilled.materials - unbilled.returnsCredit) * 100) / 100;
  const head = "flex items-baseline justify-between gap-3 px-3 pt-2 text-[11px] font-semibold uppercase tracking-wide text-[rgb(var(--glass-ink))]";
  return (
    <div className="mt-3 rounded-xl bg-white/80 pb-1 text-sm">
      {hasLabor ? (
        <section data-portal-unbilled-group="labor" aria-label="Labor">
          <h3 className={head}>
            <span>
              Labor
              {unbilled.hours > 0 ? <span className="font-medium normal-case tracking-normal text-slate-600"> · {fmtHours(unbilled.hours)}</span> : null}
            </span>
            <span className="tabular-nums text-slate-900">{formatCurrency(unbilled.laborAmount)}</span>
          </h3>
          <ul className="divide-y divide-slate-200/70">
            {unbilled.laborByPerson.map((p) => (
              <li key={p.name} className="flex items-start justify-between gap-3 px-3 py-2">
                <div>
                  <div className="font-medium text-slate-900">{p.name}</div>
                  <div className="text-xs text-slate-600">{fmtHours(p.hours)}</div>
                </div>
                <div className="tabular-nums">{formatCurrency(p.amount)}</div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {hasMaterials ? (
        <section data-portal-unbilled-group="materials" aria-label="Materials">
          <h3 className={head}>
            <span>Materials</span>
            <span className="tabular-nums text-slate-900">{formatCurrency(materialsNet)}</span>
          </h3>
          <ul className="divide-y divide-slate-200/70">
            {Math.abs(unbilled.materials) > 0.005 ? (
              <li className="flex justify-between gap-3 px-3 py-2">
                <span className="font-medium text-slate-900">Materials Bought</span>
                <span className="tabular-nums">{formatCurrency(unbilled.materials)}</span>
              </li>
            ) : null}
            {unbilled.returnsCredit > 0.005 ? (
              <li className="flex justify-between gap-3 px-3 py-2">
                <span className="font-medium text-slate-900">Returns To Credit</span>
                <span className="tabular-nums text-emerald-800">−{formatCurrency(unbilled.returnsCredit)}</span>
              </li>
            ) : null}
          </ul>
        </section>
      ) : null}
      <div className="mx-3 mt-1 flex justify-between gap-3 border-t border-slate-300/80 pt-2 font-semibold">
        <span>{totalLabel}</span>
        <span className="tabular-nums">{formatCurrency(unbilled.total)}</span>
      </div>
    </div>
  );
}

/**
 * One bill, closed until tapped (the money card and the stretches already say where things stand;
 * the full sheet is the detail). Inside, the sheet is the customer's copy exactly as the PDF and /i
 * print it: the same InvoiceDocument, fed by the same readInvoiceDocumentProps. `.portal-bill` only
 * changes how it sits on a phone (globals.css): the printed margins and the 11in floor come off, the letterhead and Bill To wrap,
 * and each line puts its amount beside its description, so nothing hides behind a sideways scroll.
 * `groupByKind`: the same lines, under Labor and Materials headings with a subtotal each (and any
 * other kind under its own heading only when the bill has one). Same lines, same figures, same
 * totals; only the order and the headings are the portal's.
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
        {b.doc ? (
          <div className="portal-bill overflow-x-auto rounded-b-2xl sm:rounded-xl">
            <InvoiceDocument {...b.doc} groupByKind />
          </div>
        ) : (
          // The bill is there; its sheet could not be read just now. Say so, never an empty sheet.
          <p className="px-4 py-4 text-sm text-slate-700">
            This bill couldn&apos;t load just now. Please refresh the page in a moment.
          </p>
        )}
      </div>
    </details>
  );
}
