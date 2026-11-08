"use server";
import { dbError } from "@/lib/db-error";

import { revalidatePath } from "next/cache";
import { bustCustomerPdfs } from "@/lib/pdf-cache";
import { emptyToNull } from "@/lib/forms";
import { createClient } from "@/lib/supabase/server";
import { formatPhone, formatState, formatZip, titleCase } from "@/lib/utils";
import { requireStaff } from "@/lib/staff-guard";
import { sendEmail, renderReminderEmail } from "@/lib/email";
import { checkSendMessage, copyMeAddress, type PreviewResult, type SendMessage } from "@/lib/send-review";
import { logSend, senderEmail } from "@/lib/sent-messages";
import { PORTAL_EMAIL_BODY, portalSubject, portalEmailTail, sendWhyKey } from "@/lib/send-words";
import { getOrgSettings, accentHex, orgDocUrl } from "@/lib/org-settings";
import { findDuplicateGroups, normPhone, type DupCustomer, type DupGroup } from "@/lib/crm/duplicates";
import { visibleCustomerIdOrNull } from "@/lib/job-visibility";
import { callerLang } from "@/lib/lang-of";
import { translator } from "@/lib/i18n";
import { fillSlots } from "@/lib/lang-words";
import type { Lang } from "@/lib/locale";

export type ActionResult = { ok: boolean; error?: string; id?: string };

/**
 * THE CALLER'S OWN WORDS (the Ventas-2 wave, cn-v1146). Every sentence this file hands a SCREEN — a
 * refusal, the delete guard's count of a contact's records — comes from lib/words/customers-server
 * (cu_srv_) in the caller's language: profiles.language through lib/lang-of callerLang, read ONCE per
 * action call and only when an answer needs words (a save that says nothing pays no extra round trip);
 * English when nobody is signed in or the read fails. The English is the catalog's, byte for byte what
 * this file always said. What the tenant's CUSTOMER reads — the portal email's heading, message, button
 * and subject (emailPortalLink) — stays English: it is not said to the caller.
 *
 * ONE READ PER CALL, KEYED ON THE CALL'S OWN CLIENT (quotes/actions' wordsOf, copied): requireStaff
 * makes a fresh session client per call, so the memo is kept on that object (a WeakMap: it goes when
 * the call does). Not exported: a "use server" file exports only async functions.
 */
type Said = { lang: () => Promise<Lang>; say: (key: string, vars?: Record<string, string | number>) => Promise<string> };
const SAID = new WeakMap<object, Said>();
function wordsOf(supabase: unknown, userId?: string | null): Said {
  // The action's own entry (it hands the signed-in id) starts this call's memo; a helper (no id) reads it.
  const memo = supabase && typeof supabase === "object" ? (supabase as object) : null;
  const had = memo ? SAID.get(memo) : undefined;
  if (had && userId === undefined) return had;
  let read: Promise<Lang> | null = null;
  const lang = () => (read ??= callerLang(supabase as Parameters<typeof callerLang>[0], userId));
  const made: Said = { lang, say: async (key, vars) => fillSlots(translator(await lang())(key), vars) };
  if (memo) SAID.set(memo, made);
  return made;
}

/** Scan the whole contact book for LIKELY duplicates (shared phone / email / name), grouped so the
 *  office can review and fold each group into one record via the existing mergeCustomers. Read-only
 *  + staff-gated + RLS-scoped; it only SUGGESTS — nothing merges until the user confirms. */
export async function findDuplicateContacts(): Promise<{ ok: boolean; error?: string; groups?: DupGroup[] }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const { data } = await ctx.supabase
    .from("customers")
    .select("id, name, company_name, email, phone, type, status, created_at")
    .order("created_at", { ascending: true });
  return { ok: true, groups: findDuplicateGroups((data ?? []) as DupCustomer[]) };
}

/** A customer's portal link, as the office sees it on the contact page. The token itself is in
 *  customer_portal_access (0298), which only active office staff of the org can read: a tech's
 *  session gets no row back, so nothing here can hand one to the crew. */
export type PortalLinkState = {
  token: string;
  enabled: boolean;
  lastOpenedAt: string | null;
  /** Devices signed in with a code (0331), office looks not counted. null: couldn't be read. */
  devices: number | null;
};

/** "Signed in on N devices" (0331's portal_link_devices: staff of the customer's own org only). */
async function readPortalDevices(
  supabase: Awaited<ReturnType<typeof createClient>>,
  customerId: string,
): Promise<number | null> {
  const { data, error } = await supabase.rpc("portal_link_devices", { p_customer_id: customerId });
  if (error) return null;
  const n = Number((data as { devices?: number } | null)?.devices);
  return Number.isFinite(n) ? n : null;
}

async function readPortalLink(
  supabase: Awaited<ReturnType<typeof createClient>>,
  customerId: string,
): Promise<PortalLinkState | null> {
  const [{ data }, devices] = await Promise.all([
    supabase.from("customer_portal_access").select("token, enabled, last_opened_at").eq("customer_id", customerId).maybeSingle(),
    readPortalDevices(supabase, customerId),
  ]);
  if (!data) return null;
  return { token: data.token, enabled: data.enabled, lastOpenedAt: data.last_opened_at ?? null, devices };
}

/** Sign Out All Devices (0331). The link keeps working; every device that opens it needs a fresh
 *  code. portal_sessions_end_all checks staff and org itself; this is the app-layer half, and the
 *  card is read back so it shows what the database holds. */
export async function signOutPortalDevices(
  customerId: string,
): Promise<{ ok: boolean; error?: string; ended?: number; link?: PortalLinkState }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const { data, error } = await ctx.supabase.rpc("portal_sessions_end_all", { p_customer_id: customerId });
  if (error) return { ok: false, error: dbError(error) };
  const link = await readPortalLink(ctx.supabase, customerId);
  if (!link) return { ok: false, error: await wordsOf(ctx.supabase, ctx.userId).say("cu_srv_signedOutCardUnread") };
  if (link.devices !== 0) return { ok: false, error: await wordsOf(ctx.supabase, ctx.userId).say("cu_srv_didntTake") };
  revalidatePath(`/crm/${customerId}`);
  return { ok: true, ended: Number(data ?? 0), link };
}

/**
 * THE WORDS THE REVIEW SHEET OPENS WITH for the portal link (cn-v1155): the subject, and the
 * 6-digit-code sentences as the message, with the button's line fixed beneath. Email only. The same
 * refusals the send gives (no email on file is NOT one: the sheet lets him type an address). Reads
 * only; nothing is sent.
 */
export async function previewPortalSend(customerId: string): Promise<PreviewResult> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: String(ctx.error) };
  const { supabase, userId, orgId } = ctx;
  const ws = wordsOf(supabase, userId);
  const r = await readPortalSend(supabase, orgId, customerId, null);
  if (!r.ok) return { ok: false, error: await ws.say(r.error) };
  const { c, org, settings, link } = r;
  return {
    ok: true,
    preview: {
      kind: "portal",
      id: customerId,
      customerName: c.name ?? null,
      to: c.email ?? null,
      phone: null,
      subject: portalSubject(org?.name),
      body: PORTAL_EMAIL_BODY,
      smsBody: "",
      tail: { email: portalEmailTail(link), sms: "" },
      copyMe: settings.copy_owner_on_emails === true,
      copyTo: copyMeAddress(await senderEmail(supabase, userId), org?.email),
      textReady: false,
      viewerLang: await ws.lang(),
      reviewOff: settings.send_without_review === true,
    },
  };
}

/** One read for the portal link's preview and its send, so the sheet shows what goes. An error is the
 *  catalog key of the refusal. Not exported: a "use server" file exports only async functions. */
async function readPortalSend(
  supabase: any,
  orgId: string | null,
  customerId: string,
  /** A send passes the address it will use (the sheet's, else none): with neither that one nor the
   *  customer's own, it is refused before the link checks, as it always was. The preview passes null. */
  sendTo: { override: string | undefined } | null,
): Promise<
  | { ok: false; error: string }
  | { ok: true; c: { name?: string | null; email?: string | null }; org: any; settings: ReturnType<typeof getOrgSettings>; link: string }
> {
  let q = supabase.from("customers").select("name, email").eq("id", customerId);
  if (orgId) q = q.eq("org_id", orgId);
  const { data: c } = await q.maybeSingle();
  if (!c) return { ok: false, error: "cu_srv_customerNotFound" };
  if (sendTo && !sendTo.override && !(c as { email?: string | null }).email) return { ok: false, error: "cu_srv_noEmail" };
  const access = await readPortalLink(supabase, customerId);
  if (!access) return { ok: false, error: "cu_srv_noLinkYet" };
  // Never email a link that opens to "this link was turned off".
  if (!access.enabled) return { ok: false, error: "cu_srv_linkOff" };
  const { data: org } = await supabase.from("organizations").select("id, name, phone, email, settings").maybeSingle();
  const settings = getOrgSettings((org as any)?.settings);
  // The customer's portal, on the contractor's own domain — see orgDocUrl in lib/org-settings.
  const link = orgDocUrl(settings, "portal", access.token);
  return { ok: true, c: c as { name?: string | null; email?: string | null }, org: org as any, settings, link };
}

/** Email the customer their passwordless portal link (invoices, contracts, quotes,
 *  project status). The link is their unguessable token — bookmark, no login. `message` is what the
 *  review sheet let go: an absent field keeps today's words. */
export async function emailPortalLink(customerId: string, message?: SendMessage): Promise<ActionResult> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const { supabase, userId, orgId } = ctx;
  const ws = wordsOf(supabase, userId);
  // An email has no fixed-tail limit to count against, so the check can run before the link is read.
  const checked = checkSendMessage(message, "email", 0);
  if (!checked.ok) return { ok: false, error: await ws.say(sendWhyKey(checked.why, "email")) };
  const m = checked.message;
  const r = await readPortalSend(supabase, orgId, customerId, { override: m.to });
  if (!r.ok) return { ok: false, error: await ws.say(r.error) };
  const { c, org, settings, link } = r;
  const to = m.to ?? c.email;
  if (!to) return { ok: false, error: await ws.say("cu_srv_noEmail") };

  // FROM HERE ON, THE CUSTOMER READS IT: the heading, the message, the button and the subject stay
  // English whatever the caller reads (pinned by crm/customers-server-es.test.ts).
  const html = renderReminderEmail({
    company: { name: org?.name ?? "Contractor North", brand: accentHex(settings.glass_tint), phone: org?.phone, email: org?.email },
    customerName: c.name ?? "there",
    heading: "Your customer portal",
    // 0331: the link asks each new phone or computer for a code. Say so before they meet it.
    message: PORTAL_EMAIL_BODY,
    cta: { label: "Open my portal", link },
    body: m.body,
  });
  // COPY ME: the sheet's tick wins; with none, the company's standing switch. The copy goes to the
  // sender's own address, else the company's.
  const copyTo = (m.copyMe ?? settings.copy_owner_on_emails) ? copyMeAddress(await senderEmail(supabase, userId), org?.email) : null;
  const subject = m.subject ?? portalSubject(org?.name);
  const res = await sendEmail({
    to,
    subject,
    fromName: org?.name ?? undefined,
    html,
    replyTo: org?.email ?? undefined,
    bcc: copyTo ?? undefined,
  });
  if (!res.ok) return res;
  const logOrg = orgId ?? org?.id ?? null;
  if (logOrg) {
    await logSend(supabase, {
      orgId: logOrg,
      docKind: "portal",
      docId: null,
      customerId,
      channel: "email",
      to,
      subject,
      body: m.body ?? PORTAL_EMAIL_BODY,
      copyTo,
      sentBy: userId,
      auto: false,
    });
  }
  return { ok: true };
}

/** New Link: the link the customer holds stops at once (it opens to "This link was turned off"),
 *  and a fresh one works right away. The swap happens inside portal_link_rotate, which checks
 *  staff and org itself; this action is the app-layer half of the same gate. */
export async function rotatePortalLink(
  customerId: string,
): Promise<{ ok: boolean; error?: string; link?: PortalLinkState }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const { error } = await ctx.supabase.rpc("portal_link_rotate", { p_customer_id: customerId });
  if (error) return { ok: false, error: dbError(error) };
  const link = await readPortalLink(ctx.supabase, customerId);
  if (!link) return { ok: false, error: await wordsOf(ctx.supabase, ctx.userId).say("cu_srv_newLinkUnread") };
  revalidatePath(`/crm/${customerId}`);
  return { ok: true, link };
}

/** Turn Off / Turn On. Off: the link opens to "This link was turned off. Ask <business> for a new
 *  one." On: the same link works again. Read back, so the card shows what the database holds. */
export async function setPortalEnabled(
  customerId: string,
  enabled: boolean,
): Promise<{ ok: boolean; error?: string; link?: PortalLinkState }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const { error } = await ctx.supabase.rpc("portal_link_set_enabled", {
    p_customer_id: customerId,
    p_enabled: enabled,
  });
  if (error) return { ok: false, error: dbError(error) };
  const link = await readPortalLink(ctx.supabase, customerId);
  if (!link || link.enabled !== enabled) {
    return { ok: false, error: await wordsOf(ctx.supabase, ctx.userId).say("cu_srv_didntTake") };
  }
  revalidatePath(`/crm/${customerId}`);
  return { ok: true, link };
}

export async function createCustomer(formData: FormData): Promise<ActionResult> {
  const guard = await requireStaff();
  if ("error" in guard) return { ok: false, error: guard.error };
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const ws = wordsOf(supabase, user?.id ?? null);
  if (!user) return { ok: false, error: await ws.say("cu_srv_notSignedIn") };

  const phone = orNull(formatPhone(String(formData.get("phone") ?? "")));
  // Fragment-first: a bare phone number is a valid customer — default the name to it.
  let name = String(formData.get("name") ?? "").trim();
  if (!name && phone) name = phone;
  if (!name) return { ok: false, error: await ws.say("cu_srv_nameRequired") };

  const { data, error } = await supabase
    .from("customers")
    .insert({
      name,
      company_name: emptyToNull(formData.get("company_name")),
      type: String(formData.get("type") ?? "residential"),
      status: String(formData.get("status") ?? "active"),
      email: emptyToNull(formData.get("email")),
      phone,
      address: emptyToNull(formData.get("address")),
      city: orNull(titleCase(String(formData.get("city") ?? ""))),
      state: orNull(formatState(String(formData.get("state") ?? ""))),
      zip: orNull(formatZip(String(formData.get("zip") ?? ""))),
      notes: emptyToNull(formData.get("notes")),
      created_by: user.id,
    })
    .select("id")
    .single();

  if (error) {
    // Before migration 0087 adds the 'subcontractor' enum value, picking that type returns a raw
    // Postgres enum error — surface a clear nudge instead.
    if (/enum/i.test(error.message) && /subcontractor/i.test(error.message))
      return { ok: false, error: await ws.say("cu_srv_subTypeUnavailable") };
    return { ok: false, error: dbError(error) };
  }

  revalidatePath("/crm");
  return { ok: true, id: data.id };
}

export async function updateCustomer(
  id: string,
  formData: FormData,
): Promise<ActionResult> {
  const ctx = await requireStaff(); // defense-in-depth (RLS also blocks non-staff)
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { ok: false, error: await wordsOf(ctx.supabase, ctx.userId).say("cu_srv_nameRequired") };

  const { data, error } = await supabase
    .from("customers")
    .update({
      name,
      company_name: emptyToNull(formData.get("company_name")),
      type: String(formData.get("type") ?? "residential"),
      status: String(formData.get("status") ?? "lead"),
      email: emptyToNull(formData.get("email")),
      phone: orNull(formatPhone(String(formData.get("phone") ?? ""))),
      address: emptyToNull(formData.get("address")),
      city: orNull(titleCase(String(formData.get("city") ?? ""))),
      state: orNull(formatState(String(formData.get("state") ?? ""))),
      zip: orNull(formatZip(String(formData.get("zip") ?? ""))),
      notes: emptyToNull(formData.get("notes")),
      pricing_level_id: emptyToNull(formData.get("pricing_level_id")),
    })
    .eq("id", id)
    // THE SILENT-WRITE LAW (audit v921): a zero-row update is a 204, not an error — editing a
    // contact that was merged away (or deleted) in another tab answered "Saved" and changed nothing.
    .select("id");
  // The bill-to block renders this person's name/address on every stored customer PDF —
  // drop their documents' copies so the next view/send re-renders (audit 7).
  if (!error) void bustCustomerPdfs(id);
  if (error) return { ok: false, error: dbError(error) };
  if (!data?.length) return { ok: false, error: await wordsOf(ctx.supabase, ctx.userId).say("cu_srv_contactUnavailable") };

  revalidatePath(`/crm/${id}`);
  revalidatePath("/crm");
  return { ok: true };
}

/** Partial update — only the fields provided change (so the agent can fix a misspelled
 *  name or add a phone without wiping everything else). An ABSENT key never touches its
 *  column; an EXPLICIT null clears one (the old `!= null` checks silently ignored a
 *  deliberate "remove their email"). RLS scopes it to the org. */
export async function patchCustomer(
  id: string,
  patch: {
    name?: string; phone?: string | null; email?: string | null; company_name?: string | null;
    address?: string | null; city?: string | null; state?: string | null; zip?: string | null; notes?: string | null;
    type?: string;
  },
): Promise<ActionResult> {
  const guard = await requireStaff();
  if ("error" in guard) return { ok: false, error: guard.error };
  const supabase = await createClient();
  const ws = wordsOf(supabase, guard.userId);
  const upd: Record<string, unknown> = {};
  if (patch.type !== undefined) upd.type = patch.type; // lib/types CustomerType: residential | commercial | industrial | subcontractor | contractor
  if (patch.name !== undefined) { const n = String(patch.name ?? "").trim(); if (!n) return { ok: false, error: await ws.say("cu_srv_nameEmpty") }; upd.name = n; }
  if (patch.phone !== undefined) upd.phone = patch.phone == null ? null : orNull(formatPhone(String(patch.phone)));
  if (patch.email !== undefined) upd.email = emptyToNull(patch.email);
  if (patch.company_name !== undefined) upd.company_name = emptyToNull(patch.company_name);
  if (patch.address !== undefined) upd.address = emptyToNull(patch.address);
  if (patch.city !== undefined) upd.city = patch.city == null ? null : orNull(titleCase(String(patch.city)));
  if (patch.state !== undefined) upd.state = patch.state == null ? null : orNull(formatState(String(patch.state)));
  if (patch.zip !== undefined) upd.zip = patch.zip == null ? null : orNull(formatZip(String(patch.zip)));
  if (patch.notes !== undefined) upd.notes = emptyToNull(patch.notes);
  if (Object.keys(upd).length === 0) return { ok: false, error: await ws.say("cu_srv_nothingToUpdate") };
  // THE SILENT-WRITE LAW (audit v921): a zero-row update is a 204. Nort fixing the spelling on a
  // customer that had just been merged into another card reported "fixed" and wrote nothing.
  const { data, error } = await supabase.from("customers").update(upd).eq("id", id).select("id");
  if (error) return { ok: false, error: dbError(error) };
  if (!data?.length) return { ok: false, error: await ws.say("cu_srv_contactUnavailable") };
  revalidatePath("/crm");
  return { ok: true };
}

export interface CustomerImportRow {
  name: string;
  company_name?: string;
  email?: string;
  phone?: string;
  address?: string;
  city?: string;
  state?: string;
  zip?: string;
  notes?: string;
}

/** Bulk-import customers from a CSV (skips rows with no name; dedupes on
 *  exact name+phone already present). */
export async function bulkImportCustomers(rows: CustomerImportRow[]): Promise<ActionResult & { imported?: number; skipped?: number }> {
  const ctx = await requireStaff(); // defense-in-depth (RLS also blocks non-staff)
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;

  const clean = rows
    .map((r) => ({
      name: String(r.name ?? "").trim(),
      company_name: orNull(String(r.company_name ?? "")),
      email: orNull(String(r.email ?? "")),
      phone: orNull(formatPhone(String(r.phone ?? ""))),
      address: orNull(String(r.address ?? "")),
      city: orNull(titleCase(String(r.city ?? ""))),
      state: orNull(formatState(String(r.state ?? ""))),
      zip: orNull(formatZip(String(r.zip ?? ""))),
      notes: orNull(String(r.notes ?? "")),
      type: "residential",
      status: "active",
      created_by: ctx.userId,
    }))
    .filter((r) => r.name);
  if (!clean.length) return { ok: false, error: await wordsOf(ctx.supabase, ctx.userId).say("cu_srv_noRowsToImport") };
  if (clean.length > 2000) return { ok: false, error: await wordsOf(ctx.supabase, ctx.userId).say("cu_srv_maxRows") };

  // Skip exact duplicates already in the book.
  const { data: existing } = await supabase.from("customers").select("name, phone");
  // Key on the phone's DIGITS, not its formatted string: rows stored as "1 (916) ..." before the
  // one formatter dropped the leading 1 must still match today's "(916) ..." (review 2026-09-24).
  const dupKey = (name: string | null | undefined, phone: string | null | undefined) => `${(name ?? "").toLowerCase()}|${normPhone(phone)}`;
  const seen = new Set((existing ?? []).map((c: any) => dupKey(c.name, c.phone)));
  const fresh = clean.filter((r) => !seen.has(dupKey(r.name, r.phone)));
  const skipped = clean.length - fresh.length;

  if (fresh.length) {
    const { error } = await supabase.from("customers").insert(fresh);
    if (error) return { ok: false, error: dbError(error) };
  }
  revalidatePath("/crm");
  return { ok: true, imported: fresh.length, skipped };
}

/**
 * EVERY table that carries a customers.id FK — the single list deleteCustomer and
 * mergeCustomers both read, so the delete guard can never again cover a subset of what
 * the merge knows about (it used to check 3 of these 11).
 *
 * `blocking: true` means losing the link is unacceptable, so the delete is refused:
 * job_contacts is ON DELETE CASCADE (its rows — a sub's role notes on six live jobs —
 * are simply gone, unrecoverable), and jobs/quotes/invoices/contracts/customer_credits
 * are history and money that must stay attributable.
 *
 * The rest are ON DELETE SET NULL: they survive the delete but orphan (an appointment
 * renders with no customer, a document becomes unreachable from any contact). Those get
 * named in an explicit confirm rather than silently orphaned.
 */
const CUSTOMER_CHILD_TABLES = [
  // `kind` names the count's words: cu_srv_child<kind>One / …Many (lib/words/customers-server).
  { table: "jobs", kind: "Job", blocking: true },
  { table: "quotes", kind: "Estimate", blocking: true },
  { table: "invoices", kind: "Invoice", blocking: true },
  { table: "job_contacts", kind: "JobLink", blocking: true },
  { table: "contracts", kind: "Contract", blocking: true },
  { table: "customer_credits", kind: "AccountCredit", blocking: true },
  { table: "inquiries", kind: "Inquiry", blocking: false },
  { table: "documents", kind: "Document", blocking: false },
  { table: "work_orders", kind: "WorkOrder", blocking: false },
  { table: "appointments", kind: "Appointment", blocking: false },
  { table: "recurring_templates", kind: "RecurringTemplate", blocking: false },
] as const;

/** "2 jobs" / "1 job" in the caller's words: a count is its own sentence (…One / …Many). */
const plural = (ws: Said, n: number, kind: string) => ws.say(`cu_srv_child${kind}${n === 1 ? "One" : "Many"}`, { n });

/**
 * Delete a customer — refused while any history, money or CASCADE-linked record still
 * points at them.
 *
 * The guard used to count only jobs/quotes/invoices, which let a non-paying contact walk
 * straight through it: a subcontractor like "Sierra Drywall" is never a client, so all
 * three counts are 0 — and deleting them CASCADE-deleted every job_contacts row, stripping
 * the sub (and their role notes) off six active jobs with no warning and no undo.
 *
 * `confirmOrphans` is the caller's assertion that the user has SEEN the SET NULL tail it
 * will orphan (appointments, documents, work orders, inquiries, recurring templates) and
 * agreed. It defaults off, so a programmatic caller — Nort, the action registry, a voice
 * command — can never orphan records silently; it gets the itemized refusal instead.
 */
export async function deleteCustomer(
  id: string,
  opts: { confirmOrphans?: boolean } = {},
): Promise<ActionResult> {
  const ctx = await requireStaff(); // defense-in-depth (RLS also blocks non-staff)
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const ws = wordsOf(supabase, ctx.userId);

  const counts = await Promise.all(
    CUSTOMER_CHILD_TABLES.map(({ table }) =>
      supabase.from(table).select("id", { count: "exact", head: true }).eq("customer_id", id),
    ),
  );

  // The counts, kept as numbers; they become words only when a refusal says them (no language read
  // on a delete that goes through).
  const blocking: { n: number; kind: string }[] = [];
  const orphaning: { n: number; kind: string }[] = [];
  CUSTOMER_CHILD_TABLES.forEach((child, i) => {
    const n = counts[i]?.count ?? 0;
    if (!n) return;
    (child.blocking ? blocking : orphaning).push({ n, kind: child.kind });
  });
  const list = async (xs: { n: number; kind: string }[]) => (await Promise.all(xs.map((x) => plural(ws, x.n, x.kind)))).join(", ");

  if (blocking.length) {
    return { ok: false, error: await ws.say("cu_srv_hasBlocking", { list: await list(blocking) }) };
  }
  if (orphaning.length && !opts.confirmOrphans) {
    return { ok: false, error: await ws.say("cu_srv_leavesOrphans", { list: await list(orphaning) }) };
  }

  const { error } = await supabase.from("customers").delete().eq("id", id);
  if (error) return { ok: false, error: dbError(error) };
  revalidatePath("/crm");
  return { ok: true };
}

/** Merge a duplicate customer into another. Re-points every child table that references
 *  the source customer onto the target, then deletes the now-empty source. This is the
 *  ONLY way to clean up duplicates once they're referenced (deleteCustomer refuses while
 *  history points at them). Org-safe: requireStaff + both ids must be visible to the
 *  caller's org (RLS scopes every read/write below). */
export async function mergeCustomers(
  sourceId: string,
  targetId: string,
): Promise<ActionResult> {
  const ctx = await requireStaff(); // defense-in-depth (RLS also blocks non-staff)
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const ws = wordsOf(supabase, ctx.userId);

  if (!sourceId || !targetId) return { ok: false, error: await ws.say("cu_srv_pickMergeTarget") };
  if (sourceId === targetId) return { ok: false, error: await ws.say("cu_srv_mergeIntoItself") };

  // Confirm BOTH belong to the caller's org (visibleCustomerIdOrNull is RLS-scoped, so a
  // row from another org resolves to nothing → treated as not found).
  if (!(await visibleCustomerIdOrNull(supabase, sourceId)))
    return { ok: false, error: await ws.say("cu_srv_sourceNotFound") };
  if (!(await visibleCustomerIdOrNull(supabase, targetId)))
    return { ok: false, error: await ws.say("cu_srv_targetNotFound") };

  // job_contacts has a unique (job_id, customer_id, role) — re-pointing source→target
  // would collide where the target is already linked to the same job/role. Drop those
  // duplicate source links first so the re-point can't violate the constraint.
  const { data: srcLinks } = await supabase
    .from("job_contacts")
    .select("id, job_id, role")
    .eq("customer_id", sourceId);
  if (srcLinks && srcLinks.length) {
    const { data: tgtLinks } = await supabase
      .from("job_contacts")
      .select("job_id, role")
      .eq("customer_id", targetId);
    const taken = new Set((tgtLinks ?? []).map((l: any) => `${l.job_id}|${l.role}`));
    const collidingIds = srcLinks
      .filter((l: any) => taken.has(`${l.job_id}|${l.role}`))
      .map((l: any) => l.id);
    if (collidingIds.length) {
      const { error } = await supabase.from("job_contacts").delete().in("id", collidingIds);
      if (error) return { ok: false, error: dbError(error) };
    }
  }

  // Re-point every child table that references customers.id from source → target — the
  // SAME list deleteCustomer guards on (CUSTOMER_CHILD_TABLES), so a new customer_id FK
  // can't be added to one and forgotten in the other. RLS scopes each update.
  for (const { table } of CUSTOMER_CHILD_TABLES) {
    const { error } = await supabase
      .from(table)
      .update({ customer_id: targetId })
      .eq("customer_id", sourceId);
    if (error) return { ok: false, error: await ws.say("cu_srv_couldntMove", { table, error: error.message }) };
  }

  // Source is now unreferenced — delete it.
  const { error: delErr } = await supabase.from("customers").delete().eq("id", sourceId);
  if (delErr) return { ok: false, error: delErr.message };

  revalidatePath("/crm");
  revalidatePath(`/crm/${targetId}`);
  revalidatePath("/leads");
  return { ok: true, id: targetId };
}

function orNull(s: string): string | null {
  const t = s.trim();
  return t.length ? t : null;
}
