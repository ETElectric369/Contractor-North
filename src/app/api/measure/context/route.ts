import { requireStaff } from "@/lib/staff-guard";
import { jobLabelWithNumber } from "@/lib/schedule-options";
import type { MeasureContext } from "@/lib/quick-measure";

export const runtime = "nodejs";

/**
 * WHO IS ON THE PHONE, AND THE JOB HE IS CLOCKED ON (cn-v1160): the one read Measure from the + makes
 * (lib/quick-measure askMeasureContext asks it).
 *
 * The result sheet lives in the top bar, which hands it no company and no rows, so it asks here. It
 * needs two things: the company (every save files under the company's own folder, and what the +
 * holds is tied to the person and the company) and, when he is on the clock on a job, that job's
 * id and label, for the door "Save to J-047 · Larkspur".
 *
 * A ROUTE AND NOT A SERVER ACTION: Next sends a client's server actions one at a time, and this is
 * asked at every mount of the + and every measure; as an action, with no signal, it would stand in
 * front of his own saves (cn-v1159's Add to Schedule search moved to a route for the same reason).
 *
 * THE OFFICE'S ALONE (requireStaff): the + is a menu only for the office, and the crew's + is Snap or
 * Note. Anyone else gets a bare refusal, with no words: the client says its own sentence in the
 * reader's language. EVERY READ NAMES THE COMPANY: three companies share one database, and a rule at
 * one read is a convention, not a boundary. NO MONEY COLUMN IS READ: a punch's job id, and a job's
 * number and name.
 *
 * A punch with no job on it, no punch at all, or a punch on a job that is gone: he is clocked on
 * nothing a result can be saved to (punchJob null). A clock read that FAILED is a different thing and
 * is never answered as "not on the clock": the answer still names who is on the phone (what the +
 * holds is theirs, and every other door still works) and says `punchUnread`.
 */

/** A job's label columns and nothing that costs money. */
const LABEL_COLUMNS = "id, job_number, name";

export async function POST() {
  const ctx = await requireStaff();
  if ("error" in ctx || !ctx.orgId) return Response.json({ ok: false }, { status: 403 });
  const { supabase, userId, orgId } = ctx;
  const answer = (c: MeasureContext) => Response.json(c);
  const unread = () => answer({ ok: true, userId, orgId, punchJob: null, punchUnread: true });

  const punch = await supabase.from("time_entries").select("job_id").eq("org_id", orgId).eq("profile_id", userId).eq("status", "open").limit(1).maybeSingle();
  if (punch.error) return unread();
  const jobId = ((punch.data as { job_id?: string | null } | null)?.job_id ?? null) || null;
  if (!jobId) return answer({ ok: true, userId, orgId, punchJob: null });

  const job = await supabase.from("jobs").select(LABEL_COLUMNS).eq("org_id", orgId).eq("id", jobId).maybeSingle();
  if (job.error) return unread();
  const row = job.data as { id?: string | null; job_number?: string | null; name?: string | null } | null;
  // A door is never drawn with no name on it: a job that is gone, or one with neither a number nor
  // a name, is not offered.
  if (!row?.id || !`${row.job_number ?? ""}${row.name ?? ""}`.trim()) return answer({ ok: true, userId, orgId, punchJob: null });
  return answer({ ok: true, userId, orgId, punchJob: { id: String(row.id), label: jobLabelWithNumber(row) } });
}
