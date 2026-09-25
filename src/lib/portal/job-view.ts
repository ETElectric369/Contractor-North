import "server-only";
import { createServiceClient } from "@/lib/supabase/server";
import { signDocumentUrls } from "@/lib/signed-docs";
import { customerUnbilled, unbilledWorkForJob, type CustomerUnbilled } from "@/lib/unbilled-work";
import { jobBillsItsActuals } from "@/lib/invoice-import-rule";
import { reportError } from "@/lib/observe";
import { portalPathsToSign, shapePortalJob, type PortalJobRaw, type PortalJobView } from "./job-view-shape";

/**
 * THE CUSTOMER'S JOB PAGE, READ LIVE (/portal/<token>/jobs/<jobId>).
 *
 * Erik, 2026-09-24: "Update everything right away yes always". There is no snapshot and no publish
 * step: every load reads the job as it is. The page that calls this must be dynamic and must not
 * be cached at the edge (the customer's money, per customer, per load).
 *
 * THE DOOR. One service-role call to portal_job_view (0301), which holds the whole gate: the link
 * is switched on, the job belongs to the link's customer in the link's org and has a status a
 * customer is shown. A customer never touches RLS, never an auth user, never a staff path. What
 * comes back is turned into the page's allowlisted shape by shapePortalJob. Two more reads, both
 * as the service role and both only AFTER the gate passed, both pinned to the org the gate named:
 *   - signing: 10-minute signed URLs for exactly the pick files and shared photos the function
 *     returned (never a folder listing: receipts live in the same folder as photos);
 *   - the work not on a bill yet, on a job that bills its actuals, through the SAME fetcher the
 *     office's Unbilled card reads (scoped to the org by hand), cut to the customer's shape.
 */
export type PortalJobRead =
  | { kind: "ok"; view: PortalJobView }
  /** The office turned the link off or replaced it: say so, name who to ask, show nothing else. */
  | { kind: "off"; orgName: string | null }
  /** No such link, or no such job for it. The page 404s: it never says which. */
  | { kind: "missing" }
  /** 0300/0301 are not on this database yet. */
  | { kind: "not_ready" }
  | { kind: "error" };

const TOKEN = /^[0-9a-f]{32,128}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Long enough to open a photo on a phone, short enough that a forwarded URL is dead by lunch. */
export const PORTAL_FILE_TTL_SECONDS = 600;

function isMissingFunction(err: unknown): boolean {
  const code = String((err as { code?: string })?.code ?? "");
  const msg = String((err as { message?: string })?.message ?? "");
  return code === "PGRST202" || code === "42883" || (/portal_job_view/i.test(msg) && /could not find|does not exist/i.test(msg));
}

export async function readPortalJob(token: string, jobId: string): Promise<PortalJobRead> {
  if (typeof token !== "string" || !TOKEN.test(token) || typeof jobId !== "string" || !UUID.test(jobId)) {
    return { kind: "missing" };
  }
  const svc = createServiceClient();
  const { data, error } = await svc.rpc("portal_job_view", { p_token: token, p_job_id: jobId });
  if (error) {
    if (isMissingFunction(error)) return { kind: "not_ready" };
    reportError("portal.jobView", error, { jobId });
    return { kind: "error" };
  }
  const raw = data as (PortalJobRaw & { disabled?: boolean; org?: { name?: string | null } | null }) | null;
  if (!raw) return { kind: "missing" };
  if (raw.disabled) return { kind: "off", orgName: raw.org?.name ?? null };
  if (!raw.scope?.org_id || !raw.scope?.job_id || raw.scope.job_id.toLowerCase() !== jobId.toLowerCase()) return { kind: "missing" };

  const orgId = raw.scope.org_id;
  const billsActuals = jobBillsItsActuals(
    raw.billing?.billing_type ?? null,
    raw.billing?.quote_statuses ?? [],
    Number(raw.billing?.milestones ?? 0),
  );

  const [signed, unbilled] = await Promise.all([
    signDocumentUrls(svc, portalPathsToSign(raw), PORTAL_FILE_TTL_SECONDS),
    billsActuals
      ? unbilledWorkForJob(svc, raw.scope.job_id, { orgId }).then(
          (u): CustomerUnbilled | null => customerUnbilled(u),
          (e): CustomerUnbilled | null => {
            // A failed total is left off the page, never shown as $0 of work.
            reportError("portal.jobView.unbilled", e, { jobId });
            return null;
          },
        )
      : Promise.resolve<CustomerUnbilled | null>(null),
  ]);

  return { kind: "ok", view: shapePortalJob(raw, { signed, unbilled, now: new Date() }) };
}
