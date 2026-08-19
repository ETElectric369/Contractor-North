"use server";
import { dbError } from "@/lib/db-error";

import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/staff-guard";
import { getOrgSettings, accentHex, orgDocUrl } from "@/lib/org-settings";
import { scheduleStatus, contractTotalFromQuotes, type Milestone } from "@/lib/payment-schedule-math";
import { buildContractBody } from "@/lib/contract-body";
import { sendEmail, renderReminderEmail, ownerBcc } from "@/lib/email";
import { formatDate, formatCityStateZip } from "@/lib/utils";
import { type SiteParts, pickSite, siteLines } from "@/lib/site-address";

type Result = { ok: boolean; error?: string; id?: string };

/* See orgDocUrl in lib/org-settings — a contract's "Review & sign" link must be on the
   contractor's own domain. A homeowner about to e-sign is the worst possible moment to show
   them a company name they have never heard of. */

const csz = (x: { city?: string | null; state?: string | null; zip?: string | null } | null | undefined) =>
  formatCityStateZip(x?.city, x?.state, x?.zip);

/**
 * THE ADDRESS ON THE SIGNED PAPER, through the one resolver (cn-v711).
 *
 * This built its address strings by hand and so predated `unit` entirely: four TTP jobs share
 * 300 W Lake Blvd, and the contract naming the property said only "300 W Lake Blvd" — on the one
 * document where which dwelling it is has to be unambiguous. It also had no fallback, so a job
 * carrying no address of its own printed an EMPTY property block, and contract-body's own
 * `|| cu.address` then quietly named the customer's HOME as the work site — which after 0189 is a
 * different place on purpose.
 *
 * LINE-joined, never comma-joined: siteLines puts the dwelling on its own line directly under the
 * street, and contract-body's block() joins its lines with a newline, so a multi-line string lands
 * exactly as that block intends.
 */
const siteBlock = (...candidates: { source: string; parts?: SiteParts | null }[]): string | undefined =>
  siteLines(pickSite(candidates)).join("\n") || undefined;

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
    .select("name, description, address, unit, city, state, zip, scheduled_start, scheduled_end, customer_id, billing_type")
    .eq("id", jobId)
    .maybeSingle();
  if (!job) return { ok: false, error: "Job not found." };
  const j = job as any;

  const [{ data: customer }, { data: org }, { data: quotes }, { data: milestones }] = await Promise.all([
    j.customer_id
      ? supabase.from("customers").select("name, company_name, address, unit, city, state, zip").eq("id", j.customer_id).maybeSingle()
      : Promise.resolve({ data: null }),
    supabase.from("organizations").select("name, license, address_line1, address_line2, city, state, zip, phone, email, settings").maybeSingle(),
    supabase.from("quotes").select("total, status, created_at").eq("job_id", jobId),
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
      address: siteBlock({ source: "customer", parts: cu }),
    },
    // Job first, customer second — the same order every other document resolves in, and
    // all-or-nothing per record: never the job's street under the customer's town.
    propertyAddress: siteBlock({ source: "job", parts: j }, { source: "customer", parts: cu }),
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
    if (error) return { ok: false, error: dbError(error) };
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
    return { ok: false, error: dbError(error) };
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
  if (error) return { ok: false, error: dbError(error) };
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

  const { data: org } = await supabase.from("organizations").select("name, phone, email, settings").maybeSingle();
  const link = orgDocUrl(getOrgSettings((org as any)?.settings), "c", (c as any).public_token);
  const html = renderReminderEmail({
    company: { name: org?.name ?? "Contractor North", brand: accentHex(getOrgSettings((org as any)?.settings).glass_tint), phone: org?.phone, email: org?.email },
    customerName: customer.name,
    heading: "Your contract is ready to review and sign",
    message: `Please review contract ${(c as any).contract_number ?? ""} and sign it online. If anything looks off, just reply to this email.`,
    cta: { label: "Review & sign", link },
  });
  const res = await sendEmail({
    to: customer.email,
    subject: `Contract ${(c as any).contract_number ?? ""} from ${org?.name ?? "us"}`,
    fromName: org?.name ?? undefined,
    html,
    replyTo: org?.email ?? undefined,
    bcc: ownerBcc(getOrgSettings((org as any)?.settings).copy_owner_on_emails, org?.email),
  });
  if (!res.ok) return res;
  // Freeze the body by flipping draft -> sent only after the email actually went out — and
  // CHECK IT (audit 8). Fire-and-forget meant a failed freeze left the contract 'draft', so
  // public_contract (which serves only sent/signed) returned null and the customer who had
  // just been told "your contract is ready to review" landed on nothing. A resend legitimately
  // matches zero rows (the row is already 'sent'), so zero rows is only a failure when the row
  // we read moments ago WAS a draft.
  const wasDraft = (c as any).status === "draft";
  const { data: frozen, error: freezeErr } = await supabase
    .from("contracts")
    .update({ status: "sent", updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("status", "draft")
    .select("id");
  revalidatePath(`/jobs/${(c as any).job_id}`);
  if (freezeErr) return { ok: false, error: dbError(freezeErr) };
  if (wasDraft && !frozen?.length)
    return { ok: false, error: "The email went out, but the contract didn't lock — open it and send again so the customer can see it." };
  return { ok: true };
}

/**
 * SIGNED ON PAPER — the ending a contract could not have (audit of the Needs-action feeders).
 *
 * `status = 'signed'` had exactly ONE writer in the entire codebase: the public sign_contract
 * RPC, i.e. the customer typing their name on /c/<token>. So a wet-ink signature in the truck,
 * a scanned PDF emailed back, or a DocuSign left the contract "sent" forever — and the only exit
 * the app offered was VOID, which records that the agreement does not exist on a job where it
 * very much does. Contractors sign on paper constantly; this is the normal case, not an edge.
 *
 * ATTRIBUTED, NEVER INFERRED: the office types who signed and when. Nothing guesses a signature
 * from a job status — that would be the estimator's mistake in a legal document. The signature
 * record notes it was recorded by staff, so an executed-on-paper contract can never be mistaken
 * for one the customer clicked.
 *
 * The DB's own freeze trigger (0068) keeps it honest afterwards: once signed, the wording and
 * the signature record are immutable, whichever route wrote them.
 */
export async function recordPaperSignature(
  id: string,
  input: { name: string; signedOn?: string | null },
): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const name = input.name.trim();
  if (!name) return { ok: false, error: "Who signed it?" };

  const { data: c } = await supabase
    .from("contracts")
    .select("job_id, status, body")
    .eq("id", id)
    .maybeSingle();
  if (!c) return { ok: false, error: "Contract not found." };
  const status = (c as { status?: string }).status;
  if (status === "signed") return { ok: false, error: "This contract is already signed." };
  if (status === "void") return { ok: false, error: "This contract was voided." };
  if (status === "draft")
    return { ok: false, error: "Send the contract first — a draft's wording can still change." };

  // The signed_body is the frozen text they actually signed, exactly as the public route does.
  const signedOn = input.signedOn?.trim() ? new Date(`${input.signedOn}T12:00:00`).toISOString() : new Date().toISOString();
  const { data: wrote, error } = await supabase
    .from("contracts")
    .update({
      status: "signed",
      signed_at: signedOn,
      signed_name: name,
      signed_body: (c as { body?: string }).body ?? null,
      signed_user_agent: `recorded by office (paper/other) — ${ctx.userId}`,
    })
    .eq("id", id)
    .eq("status", "sent") // never overwrite a signature that already landed
    .select("id");
  if (error) return { ok: false, error: dbError(error) };
  if (!wrote?.length) return { ok: false, error: "That didn't save — reload and check the contract's status." };
  revalidatePath(`/jobs/${(c as { job_id?: string }).job_id ?? ""}`);
  revalidatePath("/planner");
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
  if (error) return { ok: false, error: dbError(error) };
  revalidatePath(`/jobs/${(c as any).job_id}`);
  return { ok: true };
}
