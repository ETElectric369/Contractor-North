import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { DEFAULT_MODEL } from "@/lib/anthropic";
import { isPlatformAdmin } from "@/lib/platform-admin";
import { listBugReports } from "@/app/(app)/bug-report-actions";
import { BugList } from "./bug-list";
import { listErrorEvents } from "./error-actions";
import { ErrorList } from "./error-list";
import { listCompanies } from "./company-actions";
import { CompanyList } from "./company-list";
import { AiStatus } from "./ai-status";

export const dynamic = "force-dynamic";

/** Bug Watch — North's own page, not a subscriber's (Wave 0). Every company's Report A Problem
 *  lands here for the people who run North (platform_admins, 0176), with the error sink beneath it
 *  (cn-v1136: every caught failure, deduped, marked as it is triaged) and the AI key's status
 *  beside them: env var names and model ids are the platform's business, never a company's
 *  Settings. Anyone else is sent to My Day. */
export default async function BugsPage() {
  const supabase = await createClient();
  if (!(await isPlatformAdmin(supabase))) redirect("/planner");

  // A failed read is said on the page (cn-v1130), never shown as "All clear".
  const { rows, error } = await listBugReports();
  const errors = await listErrorEvents();
  const companies = await listCompanies();

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <div>
        <h1 className="mb-1 text-xl font-semibold text-slate-900">Bug Watch</h1>
        <p className="mb-4 text-sm text-slate-500">
          Every company&apos;s reports, newest first. Mark items fixed as they ship.
        </p>
        <BugList initial={rows} readError={error} />
      </div>
      <div>
        <h2 className="mb-1 text-base font-semibold text-slate-900">Errors</h2>
        <p className="mb-4 text-sm text-slate-500">
          Every caught failure, deduped: the first sighting is kept, repeats are counted, a fixed one that returns comes back as new. Mark them as you go.
        </p>
        <ErrorList initial={errors.rows} readError={errors.error} openCapped={errors.openCapped} />
      </div>
      <div>
        <h2 className="mb-1 text-base font-semibold text-slate-900">Companies</h2>
        <p className="mb-4 text-sm text-slate-500">
          Every company&apos;s standing: trial, grace, comped or lapsed. Comp the founding cohort here; a comp is access and no billing notices until it ends.
        </p>
        <CompanyList initial={companies.rows} readError={companies.error} />
      </div>
      <div>
        <h2 className="mb-2 text-base font-semibold text-slate-900">AI Assistant</h2>
        <AiStatus configured={!!process.env.ANTHROPIC_API_KEY} model={DEFAULT_MODEL} />
      </div>
    </div>
  );
}
