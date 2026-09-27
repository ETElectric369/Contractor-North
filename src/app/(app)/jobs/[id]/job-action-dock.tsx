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
 *  the icon (60mph rule: an unlabeled glyph is a guess); at md+ it's the familiar
 *  icon+label row. Shared by Photo / Call / Navigate / Manage — their label
 *  spans render plain text and inherit the size from here.
 *
 *  px-1 (not 1.5) while stacked: only two captions are wider than the 44px minimum
 *  can hold — "Navigate" (39px in Geist at 9px) and "Manage" (34px). Every other slot
 *  is pinned at min-w-11 with room to spare, so its padding is moot.
 *
 *  The row layout waits for md (not sm): a 640px mouse window wears the desktop shell
 *  (globals.css `shell:`), which leaves 640 − 84 dock − 48 padding = 508px, too narrow
 *  for the icon+label row with "On clock · 10:59". The stacked slots fit every width
 *  from 375 up; the row fits from 768. */
const ICON_BTN =
  "inline-flex h-11 min-w-11 shrink-0 flex-col items-center justify-center gap-0.5 whitespace-nowrap rounded-lg border border-slate-300 bg-white px-1 text-[9px] font-medium leading-none text-slate-600 hover:bg-slate-50 md:flex-row md:gap-1.5 md:px-3 md:text-sm md:leading-normal";

/**
 * The job action dock — ONE sticky glass bar replacing the old 7-control header
 * row. Slot order: [TIME — the only filled button] [Photo] [Call] [Navigate]
 * [Manage ⋯]. Add Cost left the dock (Erik, 2026-09-11: "combine costs
 * with add cost on that upper button and get rid of it below") — the cost door is
 * now the Costs tab's header, camera first (job-cost-capture.tsx), one chip away
 * on the strip. The Tasks slot (2026-09-16) left too: Tasks is now a pinned chip
 * right after Overview on the strip below (Erik, 2026-09-26: "put it on the bottom
 * bar next to overview"), so a dock slot would be the same door twice.
 * Sticky-TOP inside <main> (the app's scroll container); the bottom edge already
 * belongs to the bottom nav + bug button. NOTE: no .glass-gloss here — it forces
 * position:relative AND overflow:hidden (the documented gotcha), which would
 * fight `sticky` and clip the Manage dropdown.
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
  taskPhotos = false,
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
  /** The database holds photos on tasks (0358): the Photo slot's toast then offers Make It A Task. */
  taskPhotos?: boolean;
}) {
  // Same lifecycle gate the old header row used for Propose dates / Finish job.
  const schedulable = job.status !== "complete" && job.status !== "invoiced" && job.status !== "cancelled";

  return (
    // Five slots, so the bar fits inside main's own padding again (the six-slot bar had
    // to borrow 8px each side). The measured budget at 375, Geist captions, stacked
    // slots: TIME "Clock In" 104 + Photo 44 + Call 44 + Navigate 49 + Manage 44 = 285,
    // plus four 2px gaps and the bar's 4px padding + 1px border each side = 303px of
    // main's 343. What never gives: the 44px touch minimum and the whole word "Navigate".
    // The negative top offsets match main's p-4/lg:p-6 so the stuck bar sits flush
    // with the scrollport instead of hovering a padding-gap below it.
    <div className="sticky -top-4 z-40 mb-5 lg:-top-6">
      <div className="glass glass-menu flex items-center gap-0.5 rounded-xl p-1 md:gap-2 md:p-2">
        <JobTimeButton
          jobId={job.id}
          jobNumber={job.job_number}
          isStaff={viewerIsStaff}
          tz={tz}
          openEntry={openEntry}
          techs={techs}
          defaultProfileId={defaultProfileId}
        />
        <JobPhotoQuick orgId={job.org_id} jobId={job.id} className={ICON_BTN} taskDoor={taskPhotos} />
        {customerPhone && (
          <a href={`tel:${customerPhone}`} title="Call customer" className={ICON_BTN}>
            <Phone className="h-4 w-4 shrink-0" />
            <span>Call</span>
          </a>
        )}
        {jobAddress && (
          <NavLink address={jobAddress} className={ICON_BTN}>
            <Navigation className="h-4 w-4 shrink-0" />
            {/* The whole word at every width. It once shrank to "Map" for an earlier
                six-slot bar; this six-slot bar pays for it with the gap, the padding
                and the -mx-2 borrow above instead — never with this caption. */}
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
                      isTm={job.billing_type === "tm"}
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
