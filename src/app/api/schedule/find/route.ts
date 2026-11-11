import { requireStaff } from "@/lib/staff-guard";
import { ENDED_JOB_STATUSES } from "@/lib/job-status";
import {
  FIND_CUSTOMER_CAP,
  FIND_PAST_CAP,
  FIND_READ_LIMIT,
  capFound,
  customerSays,
  findWords,
  likeWord,
  mergeById,
  pastJobSays,
  type FoundCustomer,
  type PastJob,
} from "@/lib/schedule/find-for-day";

export const runtime = "nodejs";

/**
 * ADD TO SCHEDULE'S SEARCH BEYOND THE JOBS IN FLIGHT: the company's finished jobs and its customers
 * (lib/schedule/find-for-day says why). Read-only, the office only (requireStaff, the same guard as
 * the sheet's own writers), through the caller's own session, so the company's rows are the only rows.
 *
 * A POST with the words in its body, never a query string: what is typed here is a person's name or a
 * street, and an address bar's line is kept in logs. A route and not a server action: Next sends a
 * client's server actions one at a time, so a search made of them would queue behind each keystroke
 * and hold Add to Schedule's own write behind the queue.
 *
 * THE DATABASE IS ASKED FOR ONE WORD (the longest typed), across the columns a person searches by, and
 * every other word is matched here on what came back: PostgREST cannot say "every word, in any of these
 * columns, across the join to the customer". A person's name is on the customer and not on the job, so
 * the jobs of the customers that word found are read too. Each read is bounded and newest first; a read
 * that came back full, or a list cut to its cap, is said (`more`), never shown as the whole answer.
 */
const PAST_COLS = "id, job_number, name, status, address, unit, city, planned_minutes, assigned_to, customers(name)";

export async function POST(req: Request) {
  const ctx = await requireStaff();
  if ("error" in ctx) return Response.json({ ok: false }, { status: 403 });
  const supabase = ctx.supabase;

  let typed = "";
  try {
    typed = String(((await req.json()) as { q?: unknown } | null)?.q ?? "");
  } catch {
    // No body, or not JSON: nothing was asked.
  }
  const words = findWords(typed.slice(0, 120));
  const word = likeWord(words);
  if (!word) return Response.json({ ok: true, jobs: [], customers: [], more: false });
  const like = `%${word}%`;

  const [byJob, byName] = await Promise.all([
    supabase
      .from("jobs")
      .select(PAST_COLS)
      .in("status", ENDED_JOB_STATUSES)
      .or(`name.ilike.${like},address.ilike.${like},unit.ilike.${like},city.ilike.${like},job_number.ilike.${like}`)
      .order("updated_at", { ascending: false, nullsFirst: false })
      .limit(FIND_READ_LIMIT),
    supabase
      .from("customers")
      .select("id, name, company_name, address, unit, city")
      .or(`name.ilike.${like},company_name.ilike.${like},address.ilike.${like},unit.ilike.${like},city.ilike.${like}`)
      .order("name")
      .limit(FIND_READ_LIMIT),
  ]);
  if (byJob.error || byName.error) return Response.json({ ok: false }, { status: 500 });
  const customers = (byName.data ?? []) as unknown as FoundCustomer[];

  // The finished jobs OF the customers the word found: "rook" is on the customer, never on the job.
  const ids = customers.map((c) => c.id);
  const byWho = ids.length
    ? await supabase
        .from("jobs")
        .select(PAST_COLS)
        .in("status", ENDED_JOB_STATUSES)
        .in("customer_id", ids)
        .order("updated_at", { ascending: false, nullsFirst: false })
        .limit(FIND_READ_LIMIT)
    : { data: [] as unknown[], error: null };
  if (byWho.error) return Response.json({ ok: false }, { status: 500 });

  const own = (byJob.data ?? []) as unknown as PastJob[];
  const theirs = (byWho.data ?? []) as unknown as PastJob[];
  const jobs = capFound(mergeById(own, theirs), (j) => pastJobSays(j, words), FIND_PAST_CAP);
  const who = capFound(customers, (c) => customerSays(c, words), FIND_CUSTOMER_CAP);
  const readFull = own.length >= FIND_READ_LIMIT || theirs.length >= FIND_READ_LIMIT || customers.length >= FIND_READ_LIMIT;
  return Response.json({ ok: true, jobs: jobs.rows, customers: who.rows, more: jobs.more > 0 || who.more > 0 || readFull });
}
