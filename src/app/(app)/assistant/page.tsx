import { redirect } from "next/navigation";

// The assistant is the slim drawer now (the Talk button in the topbar) — there's no full-page
// version. Any old link/bookmark to /assistant lands on My Day; tap Talk to open the assistant.
export default function AssistantPage() {
  redirect("/planner");
}
