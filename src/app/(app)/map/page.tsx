import { redirect } from "next/navigation";

// Map is now a view of the unified Schedule hub.
export default function MapRedirect() {
  redirect("/schedule?view=map");
}
