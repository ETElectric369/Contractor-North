import type { ActionItem } from "./types";
import { AFFORDANCES } from "./types";
import type { PileCount } from "./piles";
import { jobWords } from "./words";

/**
 * DONE, NOT BILLED, READ WHOLE (W1-FU-misc A, migration 0371).
 *
 * The pile used to read completed visits NEWEST first (limit 100) and finished jobs newest first
 * (limit 50), and only then drop the billed ones in code. Once the newest 100 visits were mostly
 * billed, the OLDEST unbilled service call was the one cut: the worst one to lose. And "billed" for a
 * job came from an unordered read of 5,000 invoices. public.needs_you_done_not_billed does the
 * billed-or-not test in SQL, over every row since the floors, and hands back the unbilled ones OLDEST
 * first with their true total: a cut never drops the oldest earned work, and "N+" says so only when
 * there really are more.
 *
 * What stays in code is only what depends on OTHER rows in the build: a visit whose open invoice is
 * already a Late Invoices row (one balance, one row), and a finished job whose bill is a draft on Now
 * (its Send It is the one row). Row ids, kinds, chips, hrefs and words are unchanged, so Dismiss and
 * the dispatch map keep working.
 *
 * Until 0371 is applied (the code deploys first) the build runs the two reads it replaced, unchanged,
 * through legacyDoneItems below, and says so once to the ops sink. Any other failure of the read is a
 * "Couldn't Check" line, never a quiet zero.
 */

export const DONE_NOT_BILLED_RPC = "needs_you_done_not_billed";

/** One row of public.needs_you_done_not_billed. */
export type DoneRow = {
  src: "visit" | "job";
  id: string;
  job_id: string | null;
  title: string | null;
  job_number: string | null;
  job_name: string | null;
  customer_name: string | null;
  at: string | null;
  open_invoice_id: string | null;
  total_count: number | string | null;
};

type Item = Omit<ActionItem, "stream">;

/** PostgREST (PGRST202) or Postgres (42883) saying the function isn't there: 0371 not applied yet. */
export function isMissingDoneRpc(err: unknown): boolean {
  const code = String((err as { code?: string } | null)?.code ?? "");
  return code === "PGRST202" || code === "42883";
}

/** A finished visit with no bill, or billed and waiting on the money (its chip says which). */
export function doneVisitItem(v: { id: string; job_id: string | null; title: string | null; who: string | null; at: string | null; openInvoice: string | null }): Item {
  return {
    id: `unbilled-${v.id}`,
    kind: "visit_unbilled",
    // Its chip says the state it is in: billed and waiting on the money, or not billed at all.
    ...(v.openInvoice ? { chip: "Billed, Not Paid" } : {}),
    title: v.title || "Work done",
    subtitle: v.who,
    who: null,
    when: v.at ?? null,
    urgency: 1, // earned and unasked-for ages worse than a draft
    done: false,
    // Billed → the open invoice (Get Paid); not billed → the job's Invoices tab, or the visit
    // (which carries Pay now) when it has no job (Bill It).
    href: v.openInvoice ? `/billing/${v.openInvoice}` : v.job_id ? `/jobs/${v.job_id}?tab=invoices` : `/appointments/${v.id}`,
    affordances: AFFORDANCES.visit_unbilled,
  };
}

/** THE JOB-SHAPED NORA HOLE: a job flipped to complete with no real invoice. */
export function doneJobItem(j: { id: string; job_number: string | null; name: string | null; customer: string | null; at: string | null }): Item {
  return {
    id: `jdone-${j.id}`,
    kind: "visit_unbilled",
    title: jobWords({ job_number: j.job_number, name: j.name }),
    subtitle: j.customer,
    who: null,
    when: j.at ?? null,
    urgency: 1,
    done: false,
    href: `/jobs/${j.id}?tab=invoices`,
    affordances: AFFORDANCES.visit_unbilled,
  };
}

/** The rows other rows already carry: an open invoice on Late Invoices, a job whose draft is on Now. */
export type DoneSeen = { overdueEmitted: ReadonlySet<string>; draftOnNowJobs: ReadonlySet<string> };

/** The function's rows as Needs You rows (0371). */
export function doneRowItems(rows: readonly DoneRow[], seen: DoneSeen): Item[] {
  const out: Item[] = [];
  for (const r of rows) {
    if (r.src === "visit") {
      const openInvoice = r.open_invoice_id ? String(r.open_invoice_id) : null;
      // ONE balance, ONE row: once the anchored invoice ages into invoice_overdue, it isn't twice.
      if (openInvoice && seen.overdueEmitted.has(openInvoice)) continue;
      out.push(doneVisitItem({ id: String(r.id), job_id: r.job_id ? String(r.job_id) : null, title: r.title, who: r.customer_name ?? null, at: r.at, openInvoice }));
    } else {
      // Its bill is already a draft on Now: that row, with its Send It, is this job's one row.
      if (seen.draftOnNowJobs.has(String(r.id))) continue;
      out.push(doneJobItem({ id: String(r.id), job_number: r.job_number, name: r.job_name, customer: r.customer_name ?? null, at: r.at }));
    }
  }
  return out;
}

/** "N+" only when the function counted more rows than it handed back. */
export function doneRowsCount(rows: readonly DoneRow[]): PileCount {
  const total = Number(rows[0]?.total_count ?? rows.length);
  return Number.isFinite(total) && total > rows.length ? { capped: true } : {};
}

/** A read of the done work that failed for any reason but 0371 missing: said, never a quiet zero. */
export const DONE_UNREAD_ITEM: Item = {
  id: "donework-unread",
  kind: "visit_unbilled",
  title: "Done, Not Billed · Couldn't Check",
  subtitle: "Couldn't read which finished work has no bill just now. Open Invoices to see finished jobs.",
  who: null,
  when: null,
  urgency: 1,
  done: false,
  href: "/billing",
  affordances: ["open"],
};

/**
 * TODAY'S RULES, KEPT FOR THE DEPLOY WINDOW (before 0371): the two reads' rows, the anchored-invoice
 * read and the billed jobs, filtered in code exactly as the build did. The suite runs this beside the
 * function over the same fixtures (old = new).
 */
export function legacyDoneItems(input: {
  doneWork: readonly any[];
  doneJobs: readonly any[];
  settled: readonly { id: string; appointment_id: string | null; amount_paid: number | string | null }[];
  billedJobs: ReadonlySet<string>;
  seen: DoneSeen;
}): Item[] {
  const one = <T,>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));
  const settled = new Set<string>();
  const billedUnpaid = new Map<string, string>(); // appointment id → invoice id
  for (const r of input.settled) {
    if (!r.appointment_id) continue;
    if (Number(r.amount_paid ?? 0) > 0) settled.add(String(r.appointment_id));
    else billedUnpaid.set(String(r.appointment_id), String(r.id));
  }
  const out: Item[] = [];
  for (const a of input.doneWork) {
    if (settled.has(String(a.id))) continue;
    if (a.job_id && input.billedJobs.has(String(a.job_id))) continue;
    const who = one(a.customers as any)?.name ?? one(a.inquiries as any)?.name ?? null;
    const openInvoice = billedUnpaid.get(String(a.id)) ?? null;
    if (openInvoice && input.seen.overdueEmitted.has(openInvoice)) continue;
    out.push(doneVisitItem({ id: String(a.id), job_id: a.job_id ? String(a.job_id) : null, title: a.title ?? null, who, at: a.starts_at ?? null, openInvoice }));
  }
  for (const j of input.doneJobs) {
    if (input.billedJobs.has(String(j.id))) continue; // any real (non-draft, non-void) invoice settles it
    if (input.seen.draftOnNowJobs.has(String(j.id))) continue;
    out.push(doneJobItem({ id: String(j.id), job_number: j.job_number ?? null, name: j.name ?? null, customer: one(j.customers as any)?.name ?? null, at: j.updated_at ?? null }));
  }
  return out;
}
