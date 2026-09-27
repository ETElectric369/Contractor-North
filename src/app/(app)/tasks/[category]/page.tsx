import { redirect } from "next/navigation";

/**
 * THE CATEGORY PAGES ARE GONE (0358): /tasks is the one Reminders page, grouped By Category there. An
 * old link (a bookmark, a bell sent before this, a calendar row from an older build) lands on that
 * grouping instead of a 404 — no dead end.
 */
export default function OldCategoryTasksPage() {
  redirect("/tasks?by=category");
}
