/**
 * THE NARROWED PICK'S RULES (cn-v1176, E3), pure so they are proven without a database. The reader is
 * appointments/actions searchJobsForVisit: it re-reads the visit on the server and hands these the ids
 * it read, never an id from the phone.
 */

/** The PostgREST `or` filter for the jobs a visit could have become: the visit's customer, its lead's
 *  customer, or its lead. null when the visit is tied to nobody (nothing to narrow to). */
export function visitJobArms(v: { customerId: string | null; leadCustomerId: string | null; inquiryId: string | null }): string | null {
  const customers = [...new Set([v.customerId, v.leadCustomerId].filter((x): x is string => !!x))];
  const arms = customers.map((id) => `customer_id.eq.${id}`);
  if (v.inquiryId) arms.push(`inquiry_id.eq.${v.inquiryId}`);
  return arms.length ? arms.join(",") : null;
}

/** The jobs in the order the pick shows them: the term (any length; empty keeps all) matches the job's
 *  name, number or street; a cancelled job never; unfinished first, then as read (newest first). */
export function narrowJobRows<T extends { job_number?: string | null; name?: string | null; address?: string | null; status?: string | null }>(
  rows: T[],
  q: string,
): T[] {
  const term = q.trim().toLowerCase();
  const hit = (r: T) => !term || [r.name, r.job_number, r.address].some((v) => String(v ?? "").toLowerCase().includes(term));
  return rows
    .filter((r) => r.status !== "cancelled" && hit(r))
    // Finished: complete, or already invoiced (cn-v1176 fix F11).
    .map((r, i) => ({ r, i, finished: r.status === "complete" || r.status === "invoiced" ? 1 : 0 }))
    .sort((a, b) => a.finished - b.finished || a.i - b.i)
    .map((x) => x.r);
}
