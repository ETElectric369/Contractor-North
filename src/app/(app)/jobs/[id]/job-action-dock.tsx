import { Phone, Navigation } from "lucide-react";
import { QuickCostButton } from "@/components/quick-cost-button";
import { NavLink } from "@/components/nav-link";
import { createInvoiceForJob, deleteJob } from "../actions";
import { JobTimeButton, type OpenEntry } from "./job-time-button";
import { JobPhotoQuick } from "./job-photo-quick";
import { JobManageMenu } from "./job-manage-menu";
import { JobEditButton } from "./job-edit-button";
import { ProposeDatesButton } from "./propose-dates-button";
import { FinishJobButton } from "./finish-job-button";
import type { Job } from "@/lib/types";

/** 44px secondary slot — icon-only on a phone (sr-only keeps the name for screen
 *  readers), icon+label at sm+. Shared by Photo / Call / Navigate / Manage. */
const ICON_BTN =
  "inline-flex h-11 min-w-11 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-slate-300 bg-white px-2.5 text-sm font-medium text-slate-600 hover:bg-slate-50 sm:px-3";

/** QuickCostButton renders `<Wallet/> {label}` itself, so the icon-only-on-phone
 *  trick is font-size 0 (the label stays in the DOM for screen readers). */
const COST_BTN =
  "inline-flex h-11 min-w-11 shrink-0 items-center justify-center gap-0 rounded-lg border border-slate-300 bg-white px-2.5 text-[0px] font-medium text-slate-600 hover:bg-slate-50 sm:gap-1.5 sm:px-3 sm:text-sm";

/**
 * The job action dock — ONE sticky glass bar replacing the old 7-control header
 * row. Slot order: [TIME — the only filled button] [Add cost] [Photo] [Call]
 * [Navigate] [Manage ⋯]. Sticky-TOP inside <main> (the app's scroll container);
 * the bottom edge already belongs to the bottom nav + bug button. NOTE: no
 * .glass-gloss here — it forces position:relative AND overflow:hidden (the
 * documented gotcha), which would fight `sticky` and clip the Manage dropdown.
 */
export function JobActionDock({
  job,
  viewerIsStaff,
  tz,
  openEntry,
  techs,
  defaultProfileId,
  jobAddress,
  customerPhone,
  pendingProposal,
  hasQuote,
  defaultSendInvoice,
  isDrawBilled,
  customers,
  templates,
  workDay,
}: {
  job: any;
  viewerIsStaff: boolean;
  tz: string;
  openEntry: OpenEntry | null;
  techs: { id: string; full_name: string | null }[];
  defaultProfileId: string;
  jobAddress: string;
  customerPhone: string | null;
  pendingProposal: { id: string; token: string; dates: any[] } | null;
  hasQuote: boolean;
  defaultSendInvoice: boolean;
  isDrawBilled: boolean;
  customers: { id: string; name: string }[];
  templates: { id: string; name: string }[];
  /** Org work-day window (workDayWindowHm) for the Edit Job modal's time defaults. */
  workDay?: { start: string; end: string };
}) {
  // Same lifecycle gate the old header row used for Propose dates / Finish job.
  const schedulable = job.status !== "complete" && job.status !== "invoiced" && job.status !== "cancelled";

  return (
    // -mx-2 at phone width: the six 44px slots need ~357px, so the bar borrows
    // half of main's side padding (still inset 8px) — roomy again at sm+. The
    // negative top offsets match main's p-4/lg:p-6 so the stuck bar sits flush
    // with the scrollport instead of hovering a padding-gap below it.
    <div className="sticky -top-4 z-40 -mx-2 mb-5 sm:mx-0 lg:-top-6">
      <div className="glass glass-menu flex items-center gap-1 rounded-xl p-1.5 sm:gap-2 sm:p-2">
        <JobTimeButton
          jobId={job.id}
          jobNumber={job.job_number}
          isStaff={viewerIsStaff}
          tz={tz}
          openEntry={openEntry}
          techs={techs}
          defaultProfileId={defaultProfileId}
        />
        {viewerIsStaff && <QuickCostButton jobId={job.id} className={COST_BTN} />}
        <JobPhotoQuick orgId={job.org_id} jobId={job.id} className={ICON_BTN} />
        {customerPhone && (
          <a href={`tel:${customerPhone}`} title="Call customer" className={ICON_BTN}>
            <Phone className="h-4 w-4 shrink-0" />
            <span className="sr-only sm:not-sr-only">Call</span>
          </a>
        )}
        {jobAddress && (
          <NavLink address={jobAddress} className={ICON_BTN}>
            <Navigation className="h-4 w-4 shrink-0" />
            <span className="sr-only sm:not-sr-only">Navigate</span>
          </NavLink>
        )}
        <div className="ml-auto shrink-0">
          <JobManageMenu
            isStaff={viewerIsStaff}
            customerId={job.customer_id}
            jobNumber={job.job_number}
            createInvoice={viewerIsStaff ? createInvoiceForJob.bind(null, job.id) : undefined}
            deleteJob={viewerIsStaff ? deleteJob.bind(null, job.id) : undefined}
            triggerClassName={ICON_BTN}
          >
            {viewerIsStaff && (
              <>
                <JobEditButton menuItem job={job as Job} customers={customers} techs={techs} templates={templates} workDay={workDay} />
                {schedulable && (
                  <>
                    <ProposeDatesButton menuItem jobId={job.id} customerPhone={customerPhone} pending={pendingProposal} />
                    <FinishJobButton
                      menuItem
                      jobId={job.id}
                      hasQuote={hasQuote}
                      defaultSendInvoice={defaultSendInvoice}
                      isDrawBilled={isDrawBilled}
                    />
                  </>
                )}
              </>
            )}
          </JobManageMenu>
        </div>
      </div>
    </div>
  );
}
