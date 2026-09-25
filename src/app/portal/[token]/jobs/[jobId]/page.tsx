import { cache } from "react";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { NO_INDEX } from "@/lib/no-index";
import { readPortalJob } from "@/lib/portal/job-view";
import { PortalJobPage } from "@/components/portal/portal-job-page";
import { PortalNotice, PortalTurnedOff } from "@/components/portal/portal-shell";
import { OpenedBeacon } from "../../opened-beacon";

/**
 * THE CUSTOMER'S JOB PAGE, LIVE. Erik: "Update everything right away yes always", so there is no
 * snapshot: every load reads the job as it is now. That is also why nothing here may be cached:
 * force-dynamic and no-store on every fetch, so a response carries Next's
 * `private, no-cache, no-store` and neither the edge nor a shared cache keeps one customer's money
 * for the next request.
 *
 * THE DOOR is readPortalJob: one service-role call to portal_job_view with the whole gate inside
 * (the link is on, the job is this customer's, in this org, in a status customers are shown), then
 * the allowlisted shape. This page renders that shape and nothing else. A customer never touches
 * RLS or a staff path, and the token in the URL is the only credential: techs never see it (it
 * lives in an office-only table, 0298), and the office's "See What They See" adds ?look=office so
 * its own looks do not count as the customer opening it.
 *
 * A job that is not this customer's, or no such link, is a plain 404 that never says which. A
 * turned-off or replaced link says so and names who to ask.
 */
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

// generateMetadata and the page read once per request.
const read = cache((token: string, jobId: string) => readPortalJob(token, jobId));

export async function generateMetadata({ params }: { params: Promise<{ token: string; jobId: string }> }): Promise<Metadata> {
  const { token, jobId } = await params;
  const r = await read(token, jobId);
  const title =
    r.kind === "ok"
      ? `${r.view.org.name} — ${r.view.job.name}`
      : r.kind === "off"
        ? `${r.orgName ? `${r.orgName} — ` : ""}Link turned off`
        : "Your job";
  // NEVER indexed: the page carries a customer's address, the people on their job and their money.
  return { title, robots: NO_INDEX };
}

export default async function PortalJobRoute({
  params,
  searchParams,
}: {
  params: Promise<{ token: string; jobId: string }>;
  searchParams: Promise<{ look?: string }>;
}) {
  const { token, jobId } = await params;
  const { look } = await searchParams;
  const r = await read(token, jobId);

  if (r.kind === "off") return <PortalTurnedOff orgName={r.orgName} />;
  if (r.kind === "missing") notFound();
  if (r.kind === "not_ready") {
    return (
      <PortalNotice title="This page isn't ready yet.">
        Your contractor is setting it up. Try the link again later, or give them a call.
      </PortalNotice>
    );
  }
  if (r.kind === "error") {
    return (
      <PortalNotice title="This page couldn't load just now.">
        Pull down or reload to try again in a minute.
      </PortalNotice>
    );
  }

  const office = look === "office";
  return (
    <>
      {/* Last Opened: stamped from the customer's own browser only (see the portal home page). */}
      {!office && <OpenedBeacon token={token} />}
      <PortalJobPage view={r.view} homeHref={`/portal/${token}${office ? "?look=office" : ""}`} />
    </>
  );
}
