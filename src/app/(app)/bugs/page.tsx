import { redirect } from "next/navigation";
import { isStaffRole } from "@/lib/actions/perms";
import { createClient } from "@/lib/supabase/server";
import { listBugReports } from "@/app/(app)/bug-report-actions";
import { BugList } from "./bug-list";

export const dynamic = "force-dynamic";

/** Bug watch — the owner's home for everything reported from the field. Open bugs also
 *  surface in the My Day "Needs action" inbox; this is where you triage them. Staff-only
 *  (RLS already returns zero rows to a tech, but redirect for a clean gate). */
export default async function BugsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { data: me } = user
    ? await supabase.from("profiles").select("role").eq("id", user.id).maybeSingle()
    : { data: null };
  const isStaff = isStaffRole((me as { role?: string } | null)?.role ?? "");
  if (!isStaff) redirect("/planner");

  const reports = await listBugReports();

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="mb-1 text-xl font-semibold text-slate-900">Bug watch</h1>
      <p className="mb-4 text-sm text-slate-500">
        Everything reported from the field — newest first. Mark items fixed as they ship; open ones also show up in your My Day inbox.
      </p>
      <BugList initial={reports} />
    </div>
  );
}
