import { deflateRawSync } from "node:zlib";
import { NextResponse, type NextRequest } from "next/server";
import { requireOwnerExport } from "@/lib/export/guard";
import { exportDoorRefusal } from "@/lib/export/door";
import { createServiceClient } from "@/lib/supabase/server";
import { reportError } from "@/lib/observe";
import { getOrgSettings } from "@/lib/org-settings";
import { readAllPages } from "@/lib/read-all-pages";
import { todayStrInTz, wallClockInTz } from "@/lib/tz";
import { fileSafeName } from "@/lib/accountant-workbook";
import { zipResponse } from "@/lib/zip-response";
import { companyFileRefs, overCap } from "@/lib/export-files/collect";
import { walkFolder } from "@/lib/export-files/list";
import { packFiles } from "@/lib/export-files/pack";
import { recordExport } from "@/lib/export-files/audit";
import { COMPANY_NO_FILES_WORDS, COMPANY_UNREAD_WORDS, FILES_UNLISTED_WORDS, couldNotReadWords, tooBigWords } from "@/lib/export-files/words";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

/** A refusal, in words, as plain text: the download button reads it and says it on the card. */
const say = (words: string, status: number) =>
  new NextResponse(words, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });

const deflate = (b: Uint8Array) => new Uint8Array(deflateRawSync(b));

/**
 * THE COMPANY'S OWN FILES AS A ZIP (cn-v1138). GET /settings/export/company-files
 *
 * Everything uploaded outside a job's own folder: the crew's documents (Employees/<Person>/), the
 * insurance papers, what Organize My filed, the intake form's uploads, every visit's photos and
 * sheet files (Visits/<visit>/ — a lead's visit as much as a job's, so no visit is missed; a job's
 * zip carries its own visits too), the logo, portfolio and avatars, and the site chat's lead
 * uploads. THE OWNER ONLY, BEFORE ANY READ (lib/export/guard; a lapsed owner passes), then the
 * door's two checks (lib/export/door: no cross-site fetch, ten downloads an hour per company). Every
 * row read names the company; every folder walked is the company's own prefix; a walk or a read
 * that did not come back whole refuses in words and is filed; the pack is whole or nothing; one
 * audit row; the zip, streamed, named for the company and its today. A job's files are its own zip
 * (export/job/<id>); the records are the records zip (export/records).
 */
export async function GET(req: NextRequest) {
  const who = await requireOwnerExport();
  if (!who.ok) return say(who.words, who.status);
  const { orgId, profileId } = who;
  const door = await exportDoorRefusal(req, orgId);
  if (door) return say(door.words, door.status);

  let svc: ReturnType<typeof createServiceClient>;
  try {
    svc = createServiceClient();
  } catch (e) {
    reportError("export:company-files:service", e, { orgId });
    return say(COMPANY_UNREAD_WORDS, 503);
  }
  const orgRead = await svc.from("organizations").select("name, settings").eq("id", orgId).maybeSingle();
  const org = orgRead.data as { name?: string | null; settings?: unknown } | null;
  if (orgRead.error || !org) {
    reportError("export:company-files:company", orgRead.error ?? new Error("no company row"), { orgId });
    return say(COMPANY_UNREAD_WORDS, 503);
  }
  const tz = getOrgSettings(org.settings).timezone;

  const [employeeDocs, people, organized, employees, insurance, organize, intake, visits, branding, leads] = await Promise.all([
    readAllPages<{ profile_id: string | null; name: string | null; file_url: string | null }>((f, t) =>
      svc.from("employee_documents").select("profile_id, name, file_url").eq("org_id", orgId).order("id").range(f, t),
    ),
    readAllPages<{ id: string; full_name: string | null }>((f, t) => svc.from("profiles").select("id, full_name").eq("org_id", orgId).order("id").range(f, t)),
    readAllPages<{ title: string | null; file_url: string | null }>((f, t) =>
      svc.from("organized_items").select("title, file_url").eq("org_id", orgId).order("id").range(f, t),
    ),
    walkFolder(svc, "documents", `${orgId}/employees`),
    walkFolder(svc, "documents", `${orgId}/insurance`),
    walkFolder(svc, "documents", `${orgId}/organize`),
    walkFolder(svc, "intake-uploads", `${orgId}/intake`),
    walkFolder(svc, "documents", `${orgId}/appointments`),
    walkFolder(svc, "branding", orgId),
    walkFolder(svc, "lead-uploads", orgId),
  ]);
  const walks = [employees, insurance, organize, intake, visits, branding, leads];
  const unlisted = [employeeDocs.error, people.error, organized.error, ...walks.map((w) => (w.ok ? null : w.error))].find((e) => e);
  if (unlisted) {
    reportError("export:company-files:list", unlisted, { orgId });
    return say(FILES_UNLISTED_WORDS, 503);
  }
  const files = (w: (typeof walks)[number]) => (w.ok ? w.files : []);

  const refs = companyFileRefs({
    orgId,
    employeeDocs: employeeDocs.rows,
    people: people.rows,
    organized: organized.rows,
    listings: {
      employees: files(employees),
      insurance: files(insurance),
      organize: files(organize),
      intake: files(intake),
      appointments: files(visits),
      branding: files(branding),
      leads: files(leads),
    },
  });
  if (!refs.length) return say(COMPANY_NO_FILES_WORDS, 404);
  if (overCap(refs)) return say(tooBigWords(), 413);

  // Stamped on the company's own clock: an unzipper reads a zip's time as local time.
  const packed = await packFiles(svc, refs, { deflate, modified: wallClockInTz(tz) });
  if (!packed.ok) {
    if ("overCap" in packed) return say(tooBigWords(), 413);
    reportError("export:company-files:pack", new Error(`${packed.failed} of ${packed.total} objects could not be read`), { orgId });
    return say(couldNotReadWords(packed.failed, packed.total), 503);
  }

  await recordExport(svc, { orgId, userId: profileId, action: "export.company_files", input: { files: packed.files, bytes: packed.bytes.length } });

  return zipResponse(packed.bytes, `${fileSafeName(org.name)}-files-${todayStrInTz(tz)}.zip`);
}
