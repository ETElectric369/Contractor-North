import { Phone, Navigation } from "lucide-react";
import { NavLink } from "@/components/nav-link";
import { createInvoiceForJob, deleteJob } from "../actions";
import { JobTimeButton, type OpenEntry } from "./job-time-button";
import { JobPhotoQuick } from "./job-photo-quick";
import { JobManageMenu } from "./job-manage-menu";
import { JobEditButton } from "./job-edit-button";
import { ProposeDatesButton } from "./propose-dates-button";
import { FinishJobButton } from "./finish-job-button";
import type { Job } from "@/lib/types";

/** 44px secondary slot. On a phone the label is VISIBLE — a tiny 9px caption under
 *  the icon (60mph rule: an unlabeled glyph is a guess); at sm+ it's the familiar
 *  icon+label row. Shared by Photo / Call / Navigate / Manage — their label spans
 *  render plain text and inherit the size from here. */
const ICON_BTN =
  "inline-flex h-11 min-w-11 shrink-0 flex-col items-center justify-center gap-0.5 whitespace-nowrap rounded-lg border border-slate-300 bg-white px-1.5 text-[9px] font-medium leading-none text-slate-600 hover:bg-slate-50 sm:flex-row sm:gap-1.5 sm:px-3 sm:text-sm sm:leading-normal";

/**
 * The job action dock — ONE sticky glass bar replacing the old 7-control header
 * row. Slot order: [TIME — the only filled button] [Photo] [Call] [Navigate]
 * [Manage ⋯]. Add Cost left the dock (Erik, 2026-09-11: "combine costs with add
 * cost on that upper button and get rid of it below") — the cost door is now the
 * Costs tab's header, camera first (job-cost-capture.tsx), one chip away on the
 * strip. Sticky-TOP inside <main> (the app's scroll container);
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
    // Five slots (~300px) fit inside main's 343px at 375 without borrowing its side
    // padding — the six-slot bar needed the old -mx-2 borrow; this one sits inset
    // like every other card. The negative top offsets match main's p-4/lg:p-6 so
    // the stuck bar sits flush with the scrollport instead of hovering a
    // padding-gap below it.
    <div className="sticky -top-4 z-40 mb-5 lg:-top-6">
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
        <JobPhotoQuick orgId={job.org_id} jobId={job.id} className={ICON_BTN} />
        {customerPhone && (
          <a href={`tel:${customerPhone}`} title="Call customer" className={ICON_BTN}>
            <Phone className="h-4 w-4 shrink-0" />
            <span>Call</span>
          </a>
        )}
        {jobAddress && (
          <NavLink address={jobAddress} className={ICON_BTN}>
            <Navigation className="h-4 w-4 shrink-0" />
            {/* The whole word at every width: "Navigate" only had to shrink to "Map"
                to fit the six-slot 375px budget, and the sixth slot is gone. */}
            <span>Navigate</span>
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
