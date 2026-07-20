import { redirect } from "next/navigation";

/**
 * The cross-job Permits list is RETIRED (Erik 2026-07-20: "permits live with the job like
 * materials"). Permits are job documents — they live on the job's own Permits tab, the same
 * way Materials, Change Orders and Work Orders do. The route stays as a redirect so old
 * links, bookmarks and the LiDAR-era deep links land somewhere sane instead of 404ing.
 */
export default function PermitsPage() {
  redirect("/jobs");
}
