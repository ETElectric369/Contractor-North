import { redirect } from "next/navigation";

// Calendar is now a view of the unified Schedule hub.
export default function CalendarRedirect() {
  redirect("/schedule");
}
