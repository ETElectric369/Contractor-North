import type { createClient } from "@/lib/supabase/server";
import { KIND_LABEL, durationLabel, workKind } from "@/lib/schedule/work-shape";
import { formatCurrency } from "@/lib/utils";

/**
 * THE STORY OF ONE PIECE OF WORK — the activity log Erik asked for.
 *
 * "your clickable track record of the lead seems to be putting the lead back onto the lead page so
 * that logic doesnt really work does it? ... a lead not being a lead anymore doesnt include putting
 * it back, we should have an activity log for everyone."
 *
 * The "← from lead" arrow used to navigate to /leads?focus=... — which RESURRECTED the lead as a
 * lead, live convert menu and all, on the page it had already graduated from. The provenance he
 * wanted was the STORY: came in, tagged, booked, became a job, billed, paid. That story was never
 * stored anywhere — and it never needs to be, because every chapter already exists as a row with a
 * timestamp. This assembles it by walking the mycelium: inquiry ↔ visits ↔ job ↔ estimates ↔
 * invoices ↔ payments.
 *
 * DERIVED, NOT LOGGED. No new table, no write path to forget somewhere — a record that assembles
 * its own history can't drift from it. The cost is that only stamped moments appear (a re-tagged
 * work_kind leaves no trace, because no column remembers when); that is the honest trade, and a
 * real audit trail is a different, heavier tool.
 */

export type StoryEvent = {
  at: string; // ISO — when this chapter happened
  text: string;
  href?: string;
};

export async function storyForJob(
  supabase: Awaited<ReturnType<typeof createClient>>,
  jobId: string,
): Promise<StoryEvent[]> {
  const { data: job } = await supabase
    .from("jobs")
    .select("id, job_number, name, status, created_at, inquiry_id, customer_id, customers(name)")
    .eq("id", jobId)
    .maybeSingle();
  if (!job) return [];

  const [inqR, apptR, quoteR, invR] = await Promise.all([
    job.inquiry_id
      ? supabase
          .from("inquiries")
          .select("id, name, created_at, status, converted_at, work_kind, planned_minutes")
          .eq("id", job.inquiry_id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    supabase
      .from("appointments")
      .select("id, title, type, status, starts_at, ends_at, created_at, updated_at")
      .or(`job_id.eq.${jobId}${job.inquiry_id ? `,inquiry_id.eq.${job.inquiry_id}` : ""}`)
      .neq("status", "cancelled")
      .order("created_at")
      .limit(20),
    supabase
      .from("quotes")
      .select("id, quote_number, status, total, created_at, accepted_at")
      .or(`job_id.eq.${jobId}${job.inquiry_id ? `,inquiry_id.eq.${job.inquiry_id}` : ""}`)
      .order("created_at")
      .limit(10),
    supabase
      .from("invoices")
      .select("id, invoice_number, status, total, created_at")
      .eq("job_id", jobId)
      .neq("status", "void")
      .order("created_at")
      .limit(20),
  ]);

  const invoiceIds = ((invR.data ?? []) as { id: string }[]).map((r) => r.id);
  const { data: pays } = invoiceIds.length
    ? await supabase
        .from("payments")
        .select("invoice_id, amount, method, paid_at, created_at")
        .in("invoice_id", invoiceIds)
        .order("created_at")
        .limit(50)
    : { data: [] };

  const out: StoryEvent[] = [];
  const inq = inqR.data as {
    id: string; name: string; created_at: string; work_kind: string | null;
    planned_minutes: number | null; converted_at: string | null;
  } | null;

  if (inq) {
    const kind = inq.work_kind ? KIND_LABEL[workKind({ kind: "lead", workKind: inq.work_kind })] : null;
    const size = inq.planned_minutes ? durationLabel(inq.planned_minutes) : null;
    out.push({
      at: inq.created_at,
      // The lead's tag and size ride the first chapter — no column remembers when they were set,
      // and inventing a timestamp would be worse than attaching the facts where they began.
      text: `Came in as a lead — ${inq.name}${kind ? ` · ${kind}` : ""}${size ? ` · ${size}` : ""}`,
    });
  }

  for (const a of (apptR.data ?? []) as { id: string; title: string; status: string; starts_at: string | null; ends_at: string | null; created_at: string; updated_at: string | null }[]) {
    out.push({
      at: a.created_at,
      text: a.starts_at
        ? `Visit booked — ${a.title}`
        : `Visit created (no date yet) — ${a.title}`,
      href: `/appointments/${a.id}`,
    });
    if (a.status === "completed") {
      // No column remembers the completion click — the visit's own end is the stamped moment
      // closest to it. updated_at drifts with every later edit (a Wednesday typo fix was
      // re-dating Monday's completion past the estimate it produced).
      out.push({ at: a.ends_at ?? a.starts_at ?? a.updated_at ?? a.created_at, text: `Visit completed — ${a.title}`, href: `/appointments/${a.id}` });
    }
  }

  for (const q of (quoteR.data ?? []) as { id: string; quote_number: string | null; status: string; total: number | null; created_at: string; accepted_at: string | null }[]) {
    out.push({
      at: q.created_at,
      text: `Estimate ${q.quote_number ?? ""} started · ${formatCurrency(Number(q.total ?? 0))}`.trim(),
      href: `/quotes/${q.id}`,
    });
    if (q.accepted_at) out.push({ at: q.accepted_at, text: `Estimate ${q.quote_number ?? ""} accepted`, href: `/quotes/${q.id}` });
  }

  out.push({ at: job.created_at, text: `Became job ${job.job_number} — ${job.name}` });

  for (const v of (invR.data ?? []) as { id: string; invoice_number: string | null; status: string; total: number | null; created_at: string }[]) {
    out.push({
      at: v.created_at,
      text: `Invoice ${v.invoice_number ?? ""} · ${formatCurrency(Number(v.total ?? 0))}`.trim(),
      href: `/billing/${v.id}`,
    });
  }
  for (const p of (pays ?? []) as { invoice_id: string; amount: number; method: string | null; paid_at: string | null; created_at: string }[]) {
    out.push({
      at: p.paid_at ?? p.created_at,
      text: `Paid ${formatCurrency(Number(p.amount ?? 0))}${p.method ? ` · ${p.method}` : ""}`,
      href: `/billing/${p.invoice_id}`,
    });
  }

  return out.sort((a, z) => String(a.at).localeCompare(String(z.at)));
}
