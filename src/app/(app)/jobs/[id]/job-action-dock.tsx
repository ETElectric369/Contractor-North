import { Phone, Navigation } from "lucide-react";
import { NavLink } from "@/components/nav-link";
import { deleteJob } from "../actions";
import { JobTimeButton, type OpenEntry } from "./job-time-button";
import { JobPhotoQuick } from "./job-photo-quick";
import { JobManageMenu } from "./job-manage-menu";
import { JobEditButton } from "./job-edit-button";
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
 * The job action dock — ONE sticky glass bar. Slot order: [TIME — the only filled button, and the
 * job's ONE clock (W1-20)] [Photo — the job's one camera] [Call] [Navigate] [Manage ⋯, the office's].
 * Add Cost left the dock (Erik, 2026-09-11: "combine costs with add cost on that upper button and
 * get rid of it below") — the cost door is the Costs tab's header, one chip away on the strip. The
 * Tasks slot (2026-09-16) left too: Tasks is a pinned chip right after Overview on the strip below
 * (Erik, 2026-09-26: "put it on the bottom bar next to overview"), so a dock slot would be the same
 * door twice. MANAGE IS THE OFFICE'S (W1-17): Edit Job, Finish Job and Delete Job, all staff writes,
 * so a tech's dock is TIME · Photo · Call · Navigate and draws no Manage at all (a ⋯ with nothing
 * behind it is a dead end). Propose Dates moved out of Manage to Offer Dates beside the Overview's
 * Scheduled; Create Invoice is the Overview's one button.
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
  // Same lifecycle gate the old header row used for Finish job.
  const schedulable = job.status !== "complete" && job.status !== "invoiced" && job.status !== "cancelled";

  return (
    // THE SLOT BUDGET AT 375 (Geist captions, stacked slots): TIME "Clock In" 104 + Photo 44 + Call 44
    // + Navigate 49 + Manage 44 = 285, plus four 2px gaps and the bar's 4px padding + 1px border each
    // side = 303px of main's 343 for the office; the crew's four slots (no Manage) are 257px. What
    // never gives: the 44px touch minimum and the whole word "Navigate".
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
                six-slot bar; this bar pays for it with the gap and the padding instead —
                never with this caption. */}
            <span>Navigate</span>
          </NavLink>
        )}
        {viewerIsStaff && (
          <div className="ml-auto shrink-0">
            <JobManageMenu jobNumber={job.job_number} deleteJob={deleteJob.bind(null, job.id)} triggerClassName={ICON_BTN}>
              <JobEditButton menuItem job={job as Job} customers={customers} techs={techs} templates={templates} workDay={workDay} />
              {schedulable && (
                <FinishJobButton
                  menuItem
                  jobId={job.id}
                  hasQuote={hasQuote}
                  defaultSendInvoice={defaultSendInvoice}
                  isDrawBilled={isDrawBilled}
                  isTm={job.billing_type === "tm"}
                />
              )}
            </JobManageMenu>
          </div>
        )}
      </div>
    </div>
  );
}
