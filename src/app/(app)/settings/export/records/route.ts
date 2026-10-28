import { deflateRawSync } from "node:zlib";
import { NextResponse, type NextRequest } from "next/server";
import { requireOwnerExport } from "@/lib/export/guard";
import { exportDoorRefusal } from "@/lib/export/door";
import { createServiceClient } from "@/lib/supabase/server";
import { getOrgSettings } from "@/lib/org-settings";
import { readAllPages } from "@/lib/read-all-pages";
import { COMPANY_TABLE, EXPORT_TABLES, companyJson, rowCapOf, type ExportTable } from "@/lib/export/registry";
import { buildRecordsZip, tableSaid, type ExportRows } from "@/lib/export/records-zip";
import { zipResponse } from "@/lib/zip-response";
import { fileSafeName } from "@/lib/accountant-workbook";
import { todayStrInTz, wallClockInTz } from "@/lib/tz";
import { reportError } from "@/lib/observe";
import { SUPPORT_EMAIL } from "@/app/north-site/site-facts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

/** A refusal, in words, as plain text: the Your Data button reads it and says it on the card. */
const say = (words: string, status: number) =>
  new NextResponse(words, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });

const deflate = (b: Uint8Array) => new Uint8Array(deflateRawSync(b));

/** How many tables are read at once: a company's ninety tables are mostly one page each. */
const READS_AT_ONCE = 8;

const support = () => process.env.SUPPORT_EMAIL || SUPPORT_EMAIL;

/** readAllPages' own refusal when a list runs past its cap (the table's pages of 1,000). */
const overTheCap = (e: unknown): boolean => e instanceof Error && /^more than \d+ rows to read at once$/.test(e.message);

type Read = { def: ExportTable; rows: Record<string, unknown>[]; error: unknown };

/**
 * EVERY REGISTRY TABLE, WHOLE OR NOT AT ALL: readAllPages (ordered by the table's unique column,
 * advancing by the rows that came back, up to the table's own page cap) on the service client,
 * every read naming the company. A few at a time, in registry order, so a company with a long
 * trail does not open ninety connections at once; the first failure in registry order is the one
 * said.
 */
async function readEveryTable(svc: ReturnType<typeof createServiceClient>, orgId: string): Promise<Read[]> {
  const out: Read[] = [];
  for (let i = 0; i < EXPORT_TABLES.length; i += READS_AT_ONCE) {
    const slice = EXPORT_TABLES.slice(i, i + READS_AT_ONCE);
    const reads = await Promise.all(
      slice.map(async (def) => {
        const r = await readAllPages<Record<string, unknown>>(
          (from, to) => svc.from(def.table).select(def.columns.join(", ")).eq("org_id", orgId).order(def.order).range(from, to),
          def.maxPages,
        );
        return { def, rows: r.rows, error: r.error };
      }),
    );
    out.push(...reads);
  }
  return out;
}

/**
 * EVERYTHING THE COMPANY HAS, AS ONE ZIP OF RECORDS (cn-v1138). GET.
 *
 * THE OWNER, ONLY: requireOwnerExport is the refusal (a tech, an office seat, a stranger get their
 * status and one sentence, and not one row is read). A lapsed company's owner passes: the guard
 * reads no subscription state and neither does this. Then the door's two checks (lib/export/door):
 * a cross-site fetch is refused, and the company's downloads are counted, ten an hour.
 *
 * THE SERVICE CLIENT, NAMING THE COMPANY: every read is `.eq("org_id", …)` on the owner's own
 * company (three companies share one database); the company's row is read by its id.
 *
 * NOTHING SILENT: a read that does not come back whole refuses the download in words (the table in
 * its README words, never a raw name), and nothing partial is handed over. One agent_audit_log row
 * says the download happened (the trail the owner can read back in the zip itself next time); a
 * failed audit insert is filed and does not stop the download that already happened.
 */
export async function GET(req: NextRequest) {
  const verdict = await requireOwnerExport();
  if (!verdict.ok) return say(verdict.words, verdict.status);
  const { orgId, profileId } = verdict;
  const door = await exportDoorRefusal(req, orgId);
  if (door) return say(door.words, door.status);

  let svc: ReturnType<typeof createServiceClient>;
  try {
    svc = createServiceClient();
  } catch (e) {
    reportError("export:records:service", e, { orgId });
    return say("Nothing was made. The company could not be read. Try again.", 503);
  }

  const [orgRead, reads] = await Promise.all([
    svc.from(COMPANY_TABLE.table).select(COMPANY_TABLE.columns.join(", ")).eq("id", orgId).maybeSingle(),
    readEveryTable(svc, orgId),
  ]);
  const org = orgRead.data as Record<string, unknown> | null;
  if (orgRead.error || !org) {
    if (orgRead.error) reportError("export:records:read", orgRead.error, { orgId, table: COMPANY_TABLE.table });
    return say("Nothing was made. The company could not be read. Try again.", 503);
  }
  for (const r of reads) {
    if (!r.error) continue;
    if (overTheCap(r.error)) {
      return say(
        `${tableSaid(r.def.table)} is more than this door can pack (over ${rowCapOf(r.def).toLocaleString("en-US")} rows). Nothing was made. Write to ${support()}.`,
        413,
      );
    }
    reportError("export:records:read", r.error, { orgId, table: r.def.table });
    return say(`Nothing was made. ${tableSaid(r.def.table)} could not be read. Try again.`, 503);
  }

  const settings = getOrgSettings(org.settings);
  const tz = settings.timezone;
  const now = new Date();
  const company = companyJson(org, org.settings);
  const tables: ExportRows[] = reads.map((r) => ({ table: r.def.table, columns: r.def.columns, rows: r.rows }));

  let bytes: Uint8Array;
  try {
    bytes = buildRecordsZip({ company, tz, now, tables, deflate, modified: wallClockInTz(tz, now) });
  } catch (e) {
    reportError("export:records:zip", e, { orgId });
    return say(`Your records are larger than this door can pack in one zip. Nothing was made. Write to ${support()}.`, 413);
  }

  const rowCount = tables.reduce((n, t) => n + t.rows.length, 0);
  const { error: auditError } = await svc.from("agent_audit_log").insert({
    org_id: orgId,
    user_id: profileId,
    action: "export.records",
    risk: 1,
    effect: "read",
    ok: true,
    input_summary: { tables: tables.length, rows: rowCount },
    source: "ui",
  });
  if (auditError) reportError("export:audit", auditError, { orgId, action: "export.records" });

  return zipResponse(bytes, `${fileSafeName(String(org.name ?? ""))}-records-${todayStrInTz(tz, now)}.zip`);
}
