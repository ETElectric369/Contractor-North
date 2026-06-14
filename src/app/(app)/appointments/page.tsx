import { redirect } from "next/navigation";

// Appointments is now a view of the unified Schedule hub.
export default function AppointmentsRedirect() {
  redirect("/schedule?view=appointments");
}
