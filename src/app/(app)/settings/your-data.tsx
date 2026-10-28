import { createServiceClient } from "@/lib/supabase/server";
import { requireOwnerExport } from "@/lib/export/guard";
import { Card, CardContent } from "@/components/ui/card";
import { InfoPopup } from "@/components/info-popup";
import { DownloadButton } from "@/components/download-button";
import { ownerFirstName } from "@/lib/lapse-words";
import { fileSafeName } from "@/lib/accountant-workbook";
import { reportError } from "@/lib/observe";
import { JOBS_PAGE, JOB_LIST_UNREAD_WORDS, readJobsWithFiles } from "@/lib/export-files/jobs-with-files";
import { YourDataList } from "./your-data-list";
import { FILES_BY_JOB, NO_JOB_FILES_WORDS, YOUR_DATA_FACTS, YOUR_DATA_LINE, YOUR_DATA_TITLE, askOwnerWords } from "./your-data-words";

/**
 * YOUR DATA (cn-v1138): the owner downloads everything the company has, from Settings › Getting
 * Paid. One line and an info icon (the long version is bullets behind it); for the owner, three
 * doors — the records zip, the company's files, and one zip per job that has files — and for
 * anyone else only who to ask, by first name. No subscription state is read anywhere here: a
 * lapsed company's owner uses this door (the lapse policy keeps the books open).
 *
 * The job list is read behind the same guard as the download routes (requireOwnerExport: the
 * owner, lapsed or not) on the SERVICE client, filtered to the company — not as the signed-in
 * person, because 0366 revokes a visit's inspection_answers column from the signed-in role and the
 * count of a job's files includes the sheet's photos. Whole or said: a failed read is one sentence
 * in the section and no rows; a company with no job files yet is told so. The first page is
 * server-rendered; Show More (your-data-list) asks the server action for the next.
 */
export async function YourData({ orgId, isOwner }: { orgId: string; isOwner: boolean }) {
  if (!isOwner) {
    const first = await ownerFirstName(orgId);
    return (
      <Section>
        <p className="text-sm text-slate-600">{askOwnerWords(first)}</p>
      </Section>
    );
  }

  // The prop says who the settings page thinks is here; the guard is the boundary the service
  // reads stand behind. When they disagree, the person reads who to ask and nothing is read.
  const who = await requireOwnerExport();
  if (!who.ok || who.orgId !== orgId) {
    const first = await ownerFirstName(orgId);
    return (
      <Section>
        <p className="text-sm text-slate-600">{askOwnerWords(first)}</p>
      </Section>
    );
  }
  const svc = createServiceClient();
  const [orgRead, jobs] = await Promise.all([
    svc.from("organizations").select("name").eq("id", orgId).maybeSingle(),
    readJobsWithFiles(svc, orgId, { offset: 0, limit: JOBS_PAGE }),
  ]);
  // The button's name is only its fallback: the route names the file itself (Content-Disposition).
  const company = fileSafeName((orgRead.data as { name?: string | null } | null)?.name);
  if (!jobs.ok) reportError("your-data:jobs-with-files", jobs.error, { orgId });

  return (
    <Section>
      <div className="flex flex-wrap gap-2">
        <DownloadButton href="/settings/export/records" fileName={`${company}-records.zip`} label="Download Everything" want="zip" />
        <DownloadButton href="/settings/export/company-files" fileName={`${company}-files.zip`} label="Company Files" variant="outline" want="zip" />
      </div>
      <h4 className="mt-5 text-xs font-semibold uppercase tracking-wide text-slate-500">{FILES_BY_JOB}</h4>
      {!jobs.ok ? (
        <p role="alert" className="mt-2 text-sm text-red-700">
          {JOB_LIST_UNREAD_WORDS}
        </p>
      ) : jobs.total === 0 ? (
        <p className="mt-2 text-sm text-slate-500">{NO_JOB_FILES_WORDS}</p>
      ) : (
        <YourDataList initial={jobs.rows} total={jobs.total} />
      )}
    </Section>
  );
}

/** The card, shaped like the settings page's other sections: the title, the one line and the icon. */
function Section({ children }: { children: React.ReactNode }) {
  return (
    <Card>
      <CardContent className="py-5">
        <div className="mb-1 flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-slate-900">{YOUR_DATA_TITLE}</h3>
          <InfoPopup title="What Your Data Holds" label="About Your Data" bullets={YOUR_DATA_FACTS} />
        </div>
        <p className="mb-4 text-sm text-slate-600">{YOUR_DATA_LINE}</p>
        {children}
      </CardContent>
    </Card>
  );
}
