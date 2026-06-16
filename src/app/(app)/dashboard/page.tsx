import { redirect } from "next/navigation";

// Overview was merged into My Day (one home, less confusion). Keep the route so
// old links/bookmarks land somewhere sensible.
export default function DashboardPage() {
  redirect("/planner");
}
