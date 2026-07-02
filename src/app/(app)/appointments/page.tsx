import { redirect } from "next/navigation";

// Appointments live on the unified Schedule calendar (the week view is the default).
export default function AppointmentsRedirect() {
  redirect("/schedule");
}
