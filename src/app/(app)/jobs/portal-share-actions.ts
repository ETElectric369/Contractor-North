"use server";

import { revalidatePath } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireStaff } from "@/lib/staff-guard";
import { dbError } from "@/lib/db-error";
import { signDocumentUrls } from "@/lib/signed-docs";
import { normalizePick, normalizeStretch, type PickPatch } from "@/lib/portal/share-input";
import { getOrgSettings, orgDocUrl } from "@/lib/org-settings";

/**
 * THE OFFICE'S CONTROLS FOR WHAT THE CUSTOMER SEES ON A JOB (0300): the stretches of work, the
 * saved picks, and which photos are shown. Erik: "Update everything right away yes always", so
 * every one of these is live on the customer's page the moment it saves; there is no publish.
 *
 * Every action is office-only (requireStaff, and the RLS underneath says the same), names a job or
 * row of the caller's own org, and reads back what it wrote (the silent-write law: a zero-row
 * update is a 204, so "no row came back" is the failure, never "no error"). Remove is a soft
 * remove so the editor's Undo can put the row back exactly as it was (the not-annoying law: no
 * save button, an undo trail).
 */

export type StretchRow = {
  id: string;
  job_id: string;
  label: string;
  starts_on: string;
  ends_on: string;
  sort: number;
  removed_at: string | null;
  updated_at: string;
};
export type PickRow = {
  id: string;
  job_id: string;
  category: string;
  brand: string | null;
  option_id: string | null;
  name: string | null;
  code: string | null;
  location: string | null;
  note: string | null;
  color_hex: string | null;
  link_url: string | null;
  file_path: string | null;
  file_kind: "image" | "pdf" | null;
  sort: number;
  removed_at: string | null;
  updated_at: string;
};
type Result<T> = { ok: true; row: T } | { ok: false; error: string };

const STRETCH_COLS = "id, job_id, label, starts_on, ends_on, sort, removed_at, updated_at";
const PICK_COLS =
  "id, job_id, category, brand, option_id, name, code, location, note, color_hex, link_url, file_path, file_kind, sort, removed_at, updated_at";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Staff = { supabase: SupabaseClient; userId: string; orgId: string };
async function staff(): Promise<Staff | { error: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { error: ctx.error ?? "This action is staff-only." };
  if (!ctx.orgId) return { error: "Your account isn't in a company yet." };
  return { supabase: ctx.supabase as SupabaseClient, userId: ctx.userId, orgId: ctx.orgId };
}

async function jobIsOurs(s: Staff, jobId: string): Promise<boolean> {
  if (!UUID.test(jobId)) return false;
  const { data } = await s.supabase.from("jobs").select("id").eq("id", jobId).eq("org_id", s.orgId).maybeSingle();
  return !!data;
}

const touched = (jobId: string) => revalidatePath(`/jobs/${jobId}`);

// ── stretches ──────────────────────────────────────────────────────────────────────────────────

export async function addStretch(
  jobId: string,
  input: { label: unknown; startsOn: unknown; endsOn?: unknown },
): Promise<Result<StretchRow>> {
  const s = await staff();
  if ("error" in s) return { ok: false, error: s.error };
  if (!(await jobIsOurs(s, jobId))) return { ok: false, error: "That job isn't in your book." };
  const v = normalizeStretch(input);
  if (!v.ok) return v;
  const { data: last } = await s.supabase
    .from("job_stretches")
    .select("sort")
    .eq("job_id", jobId)
    .eq("org_id", s.orgId)
    .order("sort", { ascending: false })
    .limit(1)
    .maybeSingle();
  const { data, error } = await s.supabase
    .from("job_stretches")
    .insert({
      org_id: s.orgId,
      job_id: jobId,
      label: v.value.label,
      starts_on: v.value.starts_on,
      ends_on: v.value.ends_on,
      sort: v.value.sort ?? Number((last as { sort?: number } | null)?.sort ?? -1) + 1,
      created_by: s.userId,
      updated_by: s.userId,
    })
    .select(STRETCH_COLS)
    .maybeSingle();
  if (error) return { ok: false, error: dbError(error) };
  if (!data) return { ok: false, error: "The stretch didn't save. Try again." };
  touched(jobId);
  return { ok: true, row: data as StretchRow };
}

async function readStretch(s: Staff, id: string): Promise<StretchRow | null> {
  if (!UUID.test(id)) return null;
  const { data } = await s.supabase.from("job_stretches").select(STRETCH_COLS).eq("id", id).eq("org_id", s.orgId).maybeSingle();
  return (data as StretchRow | null) ?? null;
}

async function writeStretch(s: Staff, id: string, jobId: string, fields: Record<string, unknown>): Promise<Result<StretchRow>> {
  const { data, error } = await s.supabase
    .from("job_stretches")
    .update({ ...fields, updated_by: s.userId })
    .eq("id", id)
    .eq("org_id", s.orgId)
    .select(STRETCH_COLS);
  if (error) return { ok: false, error: dbError(error) };
  const row = (data as StretchRow[] | null)?.[0];
  if (!row) return { ok: false, error: "That stretch is gone. Reload the page." };
  touched(jobId);
  return { ok: true, row };
}

/** Autosave: only the fields sent change. */
export async function updateStretch(
  id: string,
  patch: { label?: unknown; startsOn?: unknown; endsOn?: unknown; sort?: unknown },
): Promise<Result<StretchRow>> {
  const s = await staff();
  if ("error" in s) return { ok: false, error: s.error };
  const cur = await readStretch(s, id);
  if (!cur) return { ok: false, error: "That stretch is gone. Reload the page." };
  const v = normalizeStretch(patch, cur);
  if (!v.ok) return v;
  if (!Object.keys(v.value).length) return { ok: true, row: cur };
  return writeStretch(s, id, cur.job_id, v.value);
}

/** Taken off the customer's page. Undo is restoreStretch. */
export async function removeStretch(id: string): Promise<Result<StretchRow>> {
  const s = await staff();
  if ("error" in s) return { ok: false, error: s.error };
  const cur = await readStretch(s, id);
  if (!cur) return { ok: false, error: "That stretch is gone. Reload the page." };
  return writeStretch(s, id, cur.job_id, { removed_at: new Date().toISOString() });
}

export async function restoreStretch(id: string): Promise<Result<StretchRow>> {
  const s = await staff();
  if ("error" in s) return { ok: false, error: s.error };
  const cur = await readStretch(s, id);
  if (!cur) return { ok: false, error: "That stretch is gone. Reload the page." };
  return writeStretch(s, id, cur.job_id, { removed_at: null });
}

// ── picks ──────────────────────────────────────────────────────────────────────────────────────

/** A price-book option names the brand and the product; its prices never leave the price book. */
async function optionFill(s: Staff, optionId: string | null | undefined) {
  if (!optionId) return null;
  const { data } = await s.supabase
    .from("price_list_item_options")
    .select("id, vendor, label, part_number")
    .eq("id", optionId)
    .eq("org_id", s.orgId)
    .maybeSingle();
  return (data as { id: string; vendor: string; label: string | null; part_number: string | null } | null) ?? null;
}

export async function addPick(jobId: string, input: PickPatch): Promise<Result<PickRow>> {
  const s = await staff();
  if ("error" in s) return { ok: false, error: s.error };
  if (!(await jobIsOurs(s, jobId))) return { ok: false, error: "That job isn't in your book." };
  const v = normalizePick(input, { orgId: s.orgId, jobId, isNew: true });
  if (!v.ok) return v;
  const fields = { ...v.value };
  if (fields.option_id) {
    const opt = await optionFill(s, fields.option_id);
    if (!opt) return { ok: false, error: "That price-book choice isn't in your book." };
    // Pre-fill only what a person left blank: the brand and the product. Never a price.
    fields.brand = fields.brand ?? opt.vendor;
    fields.name = fields.name ?? opt.label;
    fields.code = fields.code ?? opt.part_number;
  }
  const { data: last } = await s.supabase
    .from("job_picks")
    .select("sort")
    .eq("job_id", jobId)
    .eq("org_id", s.orgId)
    .order("sort", { ascending: false })
    .limit(1)
    .maybeSingle();
  const { data, error } = await s.supabase
    .from("job_picks")
    .insert({
      ...fields,
      sort: fields.sort ?? Number((last as { sort?: number } | null)?.sort ?? -1) + 1,
      org_id: s.orgId,
      job_id: jobId,
      created_by: s.userId,
      updated_by: s.userId,
    })
    .select(PICK_COLS)
    .maybeSingle();
  if (error) return { ok: false, error: dbError(error) };
  if (!data) return { ok: false, error: "The pick didn't save. Try again." };
  touched(jobId);
  return { ok: true, row: data as PickRow };
}

async function readPick(s: Staff, id: string): Promise<PickRow | null> {
  if (!UUID.test(id)) return null;
  const { data } = await s.supabase.from("job_picks").select(PICK_COLS).eq("id", id).eq("org_id", s.orgId).maybeSingle();
  return (data as PickRow | null) ?? null;
}

async function writePick(s: Staff, id: string, jobId: string, fields: Record<string, unknown>): Promise<Result<PickRow>> {
  const { data, error } = await s.supabase
    .from("job_picks")
    .update({ ...fields, updated_by: s.userId })
    .eq("id", id)
    .eq("org_id", s.orgId)
    .select(PICK_COLS);
  if (error) return { ok: false, error: dbError(error) };
  const row = (data as PickRow[] | null)?.[0];
  if (!row) return { ok: false, error: "That pick is gone. Reload the page." };
  touched(jobId);
  return { ok: true, row };
}

/** Autosave: only the fields sent change. A replaced file is deleted once the new one is saved. */
export async function updatePick(id: string, patch: PickPatch): Promise<Result<PickRow>> {
  const s = await staff();
  if ("error" in s) return { ok: false, error: s.error };
  const cur = await readPick(s, id);
  if (!cur) return { ok: false, error: "That pick is gone. Reload the page." };
  const v = normalizePick(patch, { orgId: s.orgId, jobId: cur.job_id, isNew: false });
  if (!v.ok) return v;
  const fields = { ...v.value };
  if (fields.option_id) {
    const opt = await optionFill(s, fields.option_id);
    if (!opt) return { ok: false, error: "That price-book choice isn't in your book." };
    if (!("brand" in fields) && !cur.brand) fields.brand = opt.vendor;
    if (!("name" in fields) && !cur.name) fields.name = opt.label;
    if (!("code" in fields) && !cur.code) fields.code = opt.part_number;
  }
  if (!Object.keys(fields).length) return { ok: true, row: cur };
  const res = await writePick(s, id, cur.job_id, fields);
  if (res.ok && "file_path" in fields && cur.file_path && cur.file_path !== res.row.file_path) {
    // Best effort: the row no longer names it, so nothing can show it; a leftover costs storage only.
    await s.supabase.storage.from("documents").remove([cur.file_path]).catch(() => undefined);
  }
  return res;
}

/** Taken off the customer's page. Undo is restorePick; the file stays until then. */
export async function removePick(id: string): Promise<Result<PickRow>> {
  const s = await staff();
  if ("error" in s) return { ok: false, error: s.error };
  const cur = await readPick(s, id);
  if (!cur) return { ok: false, error: "That pick is gone. Reload the page." };
  return writePick(s, id, cur.job_id, { removed_at: new Date().toISOString() });
}

export async function restorePick(id: string): Promise<Result<PickRow>> {
  const s = await staff();
  if ("error" in s) return { ok: false, error: s.error };
  const cur = await readPick(s, id);
  if (!cur) return { ok: false, error: "That pick is gone. Reload the page." };
  return writePick(s, id, cur.job_id, { removed_at: null });
}

// ── photos ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Show or stop showing one job photo on the customer's page. Only a Photo can be shown (0300's
 * trigger refuses a receipt by name); the share row records the file the office is looking at, so
 * a later repoint of the document hides it instead of showing whatever it now points at.
 */
export async function setPhotoShared(documentId: string, shared: boolean): Promise<{ ok: boolean; error?: string; shared?: boolean }> {
  const s = await staff();
  if ("error" in s) return { ok: false, error: s.error };
  if (!UUID.test(documentId)) return { ok: false, error: "That photo isn't on file." };
  const { data: doc } = await s.supabase
    .from("documents")
    .select("id, job_id, category")
    .eq("id", documentId)
    .eq("org_id", s.orgId)
    .maybeSingle();
  const d = doc as { id: string; job_id: string | null; category: string | null } | null;
  if (!d) return { ok: false, error: "That photo isn't on file." };
  if (d.category !== "Photo" || !d.job_id) return { ok: false, error: "Only a job photo can be shown to the customer." };

  if (shared) {
    const { data: have } = await s.supabase
      .from("job_shared_photos")
      .select("document_id")
      .eq("document_id", documentId)
      .eq("org_id", s.orgId)
      .maybeSingle();
    if (!have) {
      // org_id, job_id and the file are stamped by the trigger from the documents row.
      const { data, error } = await s.supabase
        .from("job_shared_photos")
        .insert({ document_id: documentId, org_id: s.orgId, job_id: d.job_id, file_url_at_share: "" })
        .select("document_id");
      if (error) return { ok: false, error: dbError(error) };
      if (!data?.length) return { ok: false, error: "The photo didn't share. Try again." };
    }
  } else {
    const { error } = await s.supabase
      .from("job_shared_photos")
      .delete()
      .eq("document_id", documentId)
      .eq("org_id", s.orgId)
      .select("document_id");
    if (error) return { ok: false, error: dbError(error) };
    // Zero rows back is fine here: it was not shown, and now it still is not.
  }
  touched(d.job_id);
  return { ok: true, shared };
}

// ── what the editor opens with ─────────────────────────────────────────────────────────────────

export type PickOptionChoice = { id: string; brand: string; label: string | null; partNumber: string | null; itemName: string | null; itemCode: string | null };

/**
 * The office's editor state for a job: its stretches and picks (removed ones too, newest removal
 * first, for Undo across a reload), which photos are shown, and the brands and price-book options
 * to pick from (names only: no buy_price, no markup ever leaves the price book here).
 */
export async function jobShareState(jobId: string): Promise<
  | {
      ok: true;
      stretches: StretchRow[];
      picks: (PickRow & { file_url: string | null })[];
      sharedPhotoIds: string[];
      brands: string[];
      options: PickOptionChoice[];
    }
  | { ok: false; error: string }
> {
  const s = await staff();
  if ("error" in s) return { ok: false, error: s.error };
  if (!(await jobIsOurs(s, jobId))) return { ok: false, error: "That job isn't in your book." };
  const [st, pk, sh, opts, vendors] = await Promise.all([
    s.supabase.from("job_stretches").select(STRETCH_COLS).eq("job_id", jobId).eq("org_id", s.orgId).order("starts_on").order("sort"),
    s.supabase.from("job_picks").select(PICK_COLS).eq("job_id", jobId).eq("org_id", s.orgId).order("sort").order("updated_at"),
    s.supabase.from("job_shared_photos").select("document_id").eq("job_id", jobId).eq("org_id", s.orgId),
    s.supabase
      .from("price_list_item_options")
      .select("id, vendor, label, part_number, price_list_items(name, code)")
      .eq("org_id", s.orgId)
      .eq("archived", false)
      .order("vendor")
      .limit(1000),
    s.supabase.from("price_list_vendors").select("name").eq("org_id", s.orgId).eq("archived", false).order("name"),
  ]);
  const firstError = st.error ?? pk.error ?? sh.error;
  if (firstError) return { ok: false, error: dbError(firstError) };
  const picks = (pk.data ?? []) as PickRow[];
  const signed = await signDocumentUrls(s.supabase, picks.map((p) => p.file_path));
  const options: PickOptionChoice[] = ((opts.data ?? []) as any[]).map((o) => ({
    id: String(o.id),
    brand: String(o.vendor ?? ""),
    label: o.label ?? null,
    partNumber: o.part_number ?? null,
    itemName: o.price_list_items?.name ?? null,
    itemCode: o.price_list_items?.code ?? null,
  }));
  const brandSet = new Map<string, string>();
  for (const n of [...options.map((o) => o.brand), ...((vendors.data ?? []) as { name: string }[]).map((v) => v.name)]) {
    const t = String(n ?? "").trim();
    if (t && !brandSet.has(t.toLowerCase())) brandSet.set(t.toLowerCase(), t);
  }
  return {
    ok: true,
    stretches: (st.data ?? []) as StretchRow[],
    picks: picks.map((p) => ({ ...p, file_url: p.file_path ? signed.get(p.file_path) ?? null : null })),
    sharedPhotoIds: ((sh.data ?? []) as { document_id: string }[]).map((r) => r.document_id),
    brands: [...brandSet.values()].sort((a, b) => a.localeCompare(b)),
    options,
  };
}

// ── the office's own look at the customer's job page ───────────────────────────────────────────

/**
 * The link to this job's page as the customer opens it, for the office's See What They See and
 * Copy The Link. Office only: the token lives in customer_portal_access (0298), which a tech's
 * session reads nothing from, and requireStaff refuses before it is asked. The link is built on the
 * org's own public host (orgDocUrl), the same host the portal email sends.
 */
export async function jobPortalLink(jobId: string): Promise<
  | { ok: true; url: string | null; enabled: boolean; customerId: string | null; customerName: string | null }
  | { ok: false; error: string }
> {
  const s = await staff();
  if ("error" in s) return { ok: false, error: s.error };
  if (!UUID.test(jobId)) return { ok: false, error: "That job isn't in your book." };
  const { data: job } = await s.supabase
    .from("jobs")
    .select("id, customer_id, customers(name)")
    .eq("id", jobId)
    .eq("org_id", s.orgId)
    .maybeSingle();
  const j = job as { id: string; customer_id: string | null; customers: { name: string | null } | null } | null;
  if (!j) return { ok: false, error: "That job isn't in your book." };
  if (!j.customer_id) return { ok: true, url: null, enabled: false, customerId: null, customerName: null };
  const [{ data: access }, { data: org }] = await Promise.all([
    s.supabase.from("customer_portal_access").select("token, enabled").eq("customer_id", j.customer_id).eq("org_id", s.orgId).maybeSingle(),
    s.supabase.from("organizations").select("settings").eq("id", s.orgId).maybeSingle(),
  ]);
  const a = access as { token: string; enabled: boolean } | null;
  const url = a?.token
    ? `${orgDocUrl(getOrgSettings((org as { settings?: unknown } | null)?.settings), "portal", a.token)}/jobs/${j.id}`
    : null;
  return { ok: true, url, enabled: !!a?.enabled, customerId: j.customer_id, customerName: j.customers?.name ?? null };
}
