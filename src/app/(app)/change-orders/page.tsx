import { redirect } from "next/navigation";

/**
 * The cross-job Change Orders list is RETIRED (W2-12). A change order belongs to its job and lives on
 * the job's own Change Orders tab (New Change Order, edit, approve, print), the same way Permits,
 * Materials and Work Orders do; no dock row had linked this list for a long while. The route stays
 * as a redirect so old links and bookmarks land somewhere real instead of 404ing.
 *
 * Nothing is left behind it: a change order always has its job now (createChangeOrder refuses one
 * without, and an edit can't unlink it), so every one of them opens from its job.
 *
 * The route stays in lib/feature-doors FEATURE_ROUTES (owned by Estimates), which is what lets this
 * page draw no Off line of its own (feature-off-line-wiring.test.ts).
 */
export default function ChangeOrdersPage() {
  redirect("/jobs");
}
