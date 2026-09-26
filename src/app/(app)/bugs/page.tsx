import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { DEFAULT_MODEL } from "@/lib/anthropic";
import { isPlatformAdmin } from "@/lib/platform-admin";
import { listBugReports } from "@/app/(app)/bug-report-actions";
import { BugList } from "./bug-list";
import { AiStatus } from "./ai-status";

export const dynamic = "force-dynamic";

/** Bug Watch — North's own page, not a subscriber's (Wave 0). Every company's Report A Problem
 *  lands here for the people who run North (platform_admins, 0176), with the AI key's status
 *  beside it: env var names and model ids are the platform's business, never a company's
 *  Settings. Anyone else is sent to My Day. */
export default async function BugsPage() {
  const supabase = await createClient();
  if (!(await isPlatformAdmin(supabase))) redirect("/planner");

  const reports = await listBugReports();

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <div>
        <h1 className="mb-1 text-xl font-semibold text-slate-900">Bug Watch</h1>
        <p className="mb-4 text-sm text-slate-500">
          Every company&apos;s reports, newest first. Mark items fixed as they ship.
        </p>
        <BugList initial={reports} />
      </div>
      <div>
        <h2 className="mb-2 text-base font-semibold text-slate-900">AI Assistant</h2>
        <AiStatus configured={!!process.env.ANTHROPIC_API_KEY} model={DEFAULT_MODEL} />
      </div>
    </div>
  );
}
