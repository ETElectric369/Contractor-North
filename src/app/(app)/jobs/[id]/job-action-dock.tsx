import Link from "next/link";
import { Phone, Navigation, ListChecks } from "lucide-react";
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
 *  icon+label row. Shared by Photo / Call / Navigate / Tasks / Manage — their label
 *  spans render plain text and inherit the size from here.
 *
 *  px-1 (not 1.5) while stacked: only two captions are wider than the 44px minimum
 *  can hold — "Navigate" (39px in Geist at 9px) and "Manage" (34px) — and the
 *  six-slot budget below needs those slots at 49px and 44px, not 53 and 48. Every
 *  other slot is pinned at min-w-11 with room to spare, so its padding is moot.
 *
 *  The row layout waits for md (not sm): six icon+label slots measure 572px with
 *  "Clock In" and 627px with "On clock · 10:59", and a 640px mouse window wears the
 *  desktop shell (globals.css `shell:`), which leaves 640 − 84 dock − 48 padding =
 *  508px — the row would have scrolled the page sideways there. The stacked slots
 *  fit every width from 375 up; the row fits from 768 (636px beside the shell). */
const ICON_BTN =
  "inline-flex h-11 min-w-11 shrink-0 flex-col items-center justify-center gap-0.5 whitespace-nowrap rounded-lg border border-slate-300 bg-white px-1 text-[9px] font-medium leading-none text-slate-600 hover:bg-slate-50 md:flex-row md:gap-1.5 md:px-3 md:text-sm md:leading-normal";

/**
 * The job action dock — ONE sticky glass bar replacing the old 7-control header
 * row. Slot order: [TIME — the only filled button] [Photo] [Call] [Navigate]
 * [Tasks] [Manage ⋯]. Add Cost left the dock (Erik, 2026-09-11: "combine costs
 * with add cost on that upper button and get rid of it below") — the cost door is
 * now the Costs tab's header, camera first (job-cost-capture.tsx), one chip away
 * on the strip. Tasks joined (Erik, 2026-09-16, from a job's Tasks tab on his
 * phone: "Move tasks to the bar to the right of navigate button") as a second
 * door to the Tasks tab, which otherwise sits behind the strip's More chip.
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
  openTaskCount,
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
  /** Tasks not yet done — the same count the Tasks tab chip shows. Optional: with
   *  nothing passed the Tasks slot simply carries no badge. */
  openTaskCount?: number;
}) {
  // Same lifecycle gate the old header row used for Propose dates / Finish job.
  const schedulable = job.status !== "complete" && job.status !== "invoiced" && job.status !== "cancelled";

  return (
    // Six slots again, so the bar borrows half of main's side padding again at phone
    // width (-mx-2, still inset 8px) the way the pre-v947 six-slot bar did. The
    // measured budget at 375, Geist captions, stacked slots: TIME "Clock In" 104 +
    // Photo 44 + Call 44 + Navigate 49 + Tasks 44 + Manage 44 = 329, plus five 2px
    // gaps and the bar's 4px padding + 1px border each side = 349px. main's 343 can't
    // hold that; the borrow makes it 359, ten to spare (the shorter TIME states, "Switch"
    // 98 and a ticking "10:59" 87, need less). What could NOT give: the 44px touch
    // minimum — every slot is already pinned there, so dropping the Call caption saves
    // nothing — and the whole word "Navigate" (see its slot). Inset and roomy at md+.
    // The negative top offsets match main's p-4/lg:p-6 so the stuck bar sits flush
    // with the scrollport instead of hovering a padding-gap below it.
    <div className="sticky -top-4 z-40 -mx-2 mb-5 md:mx-0 lg:-top-6">
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
            {/* The whole word at every width. It once shrank to "Map" for an earlier
                six-slot bar; this six-slot bar pays for it with the gap, the padding
                and the -mx-2 borrow above instead — never with this caption. */}
            <span>Navigate</span>
          </NavLink>
        )}
        {/* Every role: the Tasks tab isn't staffOnly. A plain ?tab= link is the whole
            mechanism — the strip follows the URL (cn-v945), so this lands on the tab
            every time, and scroll={false} keeps the page where it is. */}
        <Link href="?tab=tasks" scroll={false} title="Tasks" className={`${ICON_BTN} relative`}>
          <ListChecks className="h-4 w-4 shrink-0" />
          <span>Tasks</span>
          {openTaskCount != null && openTaskCount > 0 && (
            // Hangs off the corner (absolute) so the count never widens the slot — the
            // 375 budget above has no room for it inline. -top-1 lands exactly on the
            // bar's inner edge (its 4px phone padding), never past its border.
            <span
              aria-label={`${openTaskCount} open`}
              className="absolute -top-1 right-0 flex h-4 min-w-4 items-center justify-center rounded-full bg-[rgb(var(--glass-ink))] px-1 text-[10px] font-semibold leading-none text-white"
            >
              {openTaskCount > 99 ? "99+" : openTaskCount}
            </span>
          )}
        </Link>
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
