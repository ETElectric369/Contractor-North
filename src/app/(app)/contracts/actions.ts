"use server";

import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/staff-guard";
import { getOrgSettings } from "@/lib/org-settings";
import { scheduleStatus, contractTotalFromQuotes, type Milestone } from "@/lib/payment-schedule-math";
import { buildContractBody } from "@/lib/contract-body";
import { sendEmail, renderReminderEmail } from "@/lib/email";
import { formatDate } from "@/lib/utils";

type Result = { ok: boolean; error?: string; id?: string };

function contractLink(token: string) {
  return `${process.env.NEXT_PUBLIC_SITE_URL || ""}/c/${token}`;
}

/** "City, ST ZIP" from loose parts. */
function csz(x: { city?: string | null; state?: string | null; zip?: string | null } | null | undefined): string {
  const cs = [x?.city, x?.state].filter(Boolean).join(", ");
  return [cs, x?.zip].filter(Boolean).join(" ").trim();
}

/** Generate (or regenerate the draft of) a contract from a job — auto-filling the
 *  parties, property, scope, dates, billing model + payment schedule, and terms. */
export async function generateContractFromJob(jobId: string): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;

  // One live contract per job. A sent/signed one is frozen — just hand it back.
  const { data: existing } = await supabase
    .from("contracts")
    .select("id, status")
    .eq("job_id", jobId)
    .neq("status", "void")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existing && (existing as any).status !== "draft") return { ok: true, id: (existing as any).id };

  const { data: job } = await supabase
    .from("jobs")
    .select("name, description, address, city, state, zip, scheduled_start, scheduled_end, customer_id, billing_type")
    .eq("id", jobId)
    .maybeSingle();
  if (!job) return { ok: false, error: "Job not found." };
  const j = job as any;

  const [{ data: customer }, { data: org }, { data: quotes }, { data: milestones }] = await Promise.all([
    j.customer_id
      ? supabase.from("customers").select("name, company_name, address, city, state, zip").eq("id", j.customer_id).maybeSingle()
      : Promise.resolve({ data: null }),
    supabase.from("organizations").select("name, license, address_line1, address_line2, city, state, zip, phone, email, settings").maybeSingle(),
    supabase.from("quotes").select("total, status").eq("job_id", jobId),
    supabase.from("payment_milestones").select("*").eq("job_id", jobId).order("sort_order"),
  ]);

  const settings = getOrgSettings((org as any)?.settings);
  const contractTotal = contractTotalFromQuotes((quotes ?? []) as any);
  const status = scheduleStatus((milestones ?? []) as Milestone[], contractTotal);
  const o = org as any;
  const cu = customer as any;

  const body = buildContractBody({
    contractor: {
      name: o?.name ?? "Contractor",
      line2: o?.license ? `License #${o.license}` : undefined,
      address: [o?.address_line1, o?.address_line2, csz(o)].filter(Boolean).join(", ") || undefined,
      contact: [o?.phone, o?.email].filter(Boolean).join(" · ") || undefined,
    },
    customer: {
      name: cu?.name ?? "Customer",
      line2: cu?.company_name || undefined,
      address: [cu?.address, csz(cu)].filter(Boolean).join(", ") || undefined,
    },
    propertyAddress: [j.address, csz(j)].filter(Boolean).join(", ") || undefined,
    scopeTitle: j.name ?? "Service work",
    scopeDetail: j.description || undefined,
    startDate: j.scheduled_start ? formatDate(j.scheduled_start) : undefined,
    endDate: j.scheduled_end ? formatDate(j.scheduled_end) : undefined,
    billingType: j.billing_type === "tm" ? "tm" : "fixed",
    contractTotal,
    schedule: status.rows.map((r) => ({ label: r.label, percent: r.percent, dollars: r.dollars })),
    terms: settings.contract_terms,
  });

  const title = `Contract — ${j.name ?? ""}`.trim() || "Service contract";

  if (existing) {
    // Regenerate the draft — refresh customer + title too, not just the body.
    const { error } = await supabase
      .from("contracts")
      .update({ body, customer_id: j.customer_id ?? null, title, updated_at: new Date().toISOString() })
      .eq("id", (existing as any).id);
    if (error) return { ok: false, error: error.message };
    revalidatePath(`/jobs/${jobId}`);
    return { ok: true, id: (existing as any).id };
  }
  const { data: inserted, error } = await supabase
    .from("contracts")
    .insert({ job_id: jobId, customer_id: j.customer_id ?? null, title, body, created_by: ctx.userId })
    .select("id")
    .single();
  if (error) {
    // The one-live-per-job unique index caught a concurrent create — hand back that one.
    if ((error as any).code === "23505") {
      const { data: live } = await supabase
        .from("contracts")
        .select("id")
        .eq("job_id", jobId)
        .neq("status", "void")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (live) {
        revalidatePath(`/jobs/${jobId}`);
        return { ok: true, id: (live as any).id };
      }
    }
    return { ok: false, error: error.message };
  }
  revalidatePath(`/jobs/${jobId}`);
  return { ok: true, id: inserted.id };
}

/** Edit a draft contract's title/body. A sent or signed contract is frozen. */
export async function updateContract(id: string, input: { title?: string; body?: string }): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const { data: c } = await supabase.from("contracts").select("status, job_id").eq("id", id).maybeSingle();
  if (!c) return { ok: false, error: "Contract not found." };
  if ((c as any).status !== "draft") return { ok: false, error: "This contract has been sent — it can no longer be edited." };
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (input.title != null) patch.title = input.title;
  if (input.body != null) patch.body = input.body;
  const { error } = await supabase.from("contracts").update(patch).eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath(`/jobs/${(c as any).job_id}`);
  return { ok: true };
}

/** Email the customer the public review-and-sign link, and mark the contract sent
 *  (which freezes its body). */
export async function sendContract(id: string): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const { data: c } = await supabase
    .from("contracts")
    .select("status, public_token, contract_number, job_id, customers(name, email)")
    .eq("id", id)
    .maybeSingle();
  if (!c) return { ok: false, error: "Contract not found." };
  if ((c as any).status === "signed") return { ok: false, error: "This contract is already signed." };
  const customer = (c as any).customers;
  if (!customer?.email) return { ok: false, error: "This customer has no email address." };

  const { data: org } = await supabase.from("organizations").select("name, brand_color, phone, email").maybeSingle();
  const link = contractLink((c as any).public_token);
  const html = renderReminderEmail({
    company: { name: org?.name ?? "Contractor North", brand: org?.brand_color ?? "#0b57c4", phone: org?.phone, email: org?.email },
    customerName: customer.name,
    heading: "Your contract is ready to review and sign",
    message: `Please review contract ${(c as any).contract_number ?? ""} and sign it online. If anything looks off, just reply to this email.`,
    cta: { label: "Review & sign", link },
  });
  const res = await sendEmail({
    to: customer.email,
    subject: `Contract ${(c as any).contract_number ?? ""} from ${org?.name ?? "us"}`,
    html,
    replyTo: org?.email ?? undefined,
  });
  if (!res.ok) return res;
  // Freeze the body by flipping draft -> sent only after the email actually went out.
  await supabase.from("contracts").update({ status: "sent", updated_at: new Date().toISOString() }).eq("id", id).eq("status", "draft");
  revalidatePath(`/jobs/${(c as any).job_id}`);
  return { ok: true };
}

/** Void a contract (e.g. superseded). */
export async function voidContract(id: string): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const { data: c } = await supabase.from("contracts").select("job_id, status").eq("id", id).maybeSingle();
  if (!c) return { ok: false, error: "Contract not found." };
  // A signed contract is an executed legal record — don't let it be voided away.
  if ((c as any).status === "signed") return { ok: false, error: "A signed contract can't be voided." };
  const { error } = await supabase.from("contracts").update({ status: "void" }).eq("id", id).neq("status", "signed");
  if (error) return { ok: false, error: error.message };
  revalidatePath(`/jobs/${(c as any).job_id}`);
  return { ok: true };
}
