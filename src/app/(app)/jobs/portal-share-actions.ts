"use server";

import { revalidatePath } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireStaff } from "@/lib/staff-guard";
import { dbError } from "@/lib/db-error";
import { signDocumentUrls } from "@/lib/signed-docs";
import {
  PHOTO_NOT_IN_JOB_FOLDER,
  normalizePick,
  normalizeSharedPaper,
  normalizeStretch,
  paperRefusal,
  type PickPatch,
  type SharedPaperPatch,
} from "@/lib/portal/share-input";
import { CUSTOMER_SHOWN_JOB_STATUSES, isJobPhotoPath } from "@/lib/portal/job-view-shape";
import {
  COMPANY_PAPER_CATEGORIES,
  MONEY_PAPER_REFUSAL,
  docFormat,
  organizeRowIsMoney,
  type DocFormat,
  type PortalDocKind,
} from "@/lib/portal/doc-kinds";
import { getOrgSettings, orgDocUrl } from "@/lib/org-settings";
import { staleSharedPhotoIds } from "@/lib/portal/shared-photo-state";

/**
 * THE OFFICE'S CONTROLS FOR WHAT THE CUSTOMER SEES ON A JOB (0300): the stretches of work, the
 * saved picks, and which photos are shown; and since 0326, which plans, permits, circuit maps,
 * drawings, renderings and scans are shown, each the newest of its versions. Erik: "Update everything right away yes always", so
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

// ── the papers the customer sees: photos, plans, permits, circuit maps, drawings (0300 → 0326) ─

/**
 * One row per paper the office showed (0326's job_shared_documents, 0300's job_shared_photos
 * widened). Taking a paper down is a soft remove, so what the customer was shown stays on record
 * with who and when; "replaces" names the older paper a newer one stands in for, and the customer
 * sees only the newest.
 */
export type SharedPaperRow = {
  document_id: string;
  kind: PortalDocKind;
  title: string;
  replaces_document_id: string | null;
  shared_by: string | null;
  shared_at: string;
  removed_at: string | null;
  removed_by: string | null;
  replaces_marked_by: string | null;
  replaces_marked_at: string | null;
};
const SHARES = "job_shared_documents";
const SHARE_COLS =
  "document_id, kind, title, replaces_document_id, shared_by, shared_at, removed_at, removed_by, replaces_marked_by, replaces_marked_at";
type PaperResult = { ok: true; row: SharedPaperRow } | { ok: false; error: string };

/** 0326 isn't on this database yet: undefined_table, or PostgREST's schema cache without it. */
function sharesNotReady(err: unknown): boolean {
  const code = String((err as { code?: string })?.code ?? "");
  const msg = String((err as { message?: string })?.message ?? "");
  return code === "42P01" || code === "PGRST205" || (/job_shared_documents/.test(msg) && /does not exist|could not find/i.test(msg));
}
const NOT_READY = "Showing plans and drawings on the customer's page isn't switched on yet (migration 0326). Photos still work from the Photos tab.";

type PaperDoc = { id: string; job_id: string | null; name: string | null; category: string | null; file_url: string | null };

async function readPaper(s: Staff, documentId: string): Promise<PaperDoc | null> {
  if (!UUID.test(documentId)) return null;
  const { data } = await s.supabase
    .from("documents")
    .select("id, job_id, name, category, file_url")
    .eq("id", documentId)
    .eq("org_id", s.orgId)
    .maybeSingle();
  return (data as PaperDoc | null) ?? null;
}

/** Is this paper tied to money through Organize? (The database checks this and supplier invoices.) */
async function paperIsMoney(s: Staff, documentId: string): Promise<boolean> {
  const { data } = await s.supabase
    .from("organized_items")
    .select("bill_id, tied_bill_id, tied_supplier_invoice_id, petty_cash_id, category")
    .eq("document_id", documentId)
    .eq("org_id", s.orgId);
  return ((data ?? []) as Parameters<typeof organizeRowIsMoney>[0][]).some(organizeRowIsMoney);
}

async function readShare(s: Staff, documentId: string): Promise<{ row: SharedPaperRow | null; jobId: string | null; error: unknown }> {
  const { data, error } = await s.supabase
    .from(SHARES)
    .select(`${SHARE_COLS}, job_id`)
    .eq("document_id", documentId)
    .eq("org_id", s.orgId)
    .maybeSingle();
  if (!data) return { row: null, jobId: null, error };
  const { job_id: jobId, ...row } = data as SharedPaperRow & { job_id: string };
  return { row, jobId, error };
}

/**
 * Put a paper on the customer's page, or back on it: a photo, a plan, a permit, a circuit map, a
 * drawing, a rendering, a scan. Receipts, bills and supplier invoices are refused here by name and
 * again by 0326's stamp, which also refuses anything Organize tied to money, whatever it is filed
 * as now. The row records the file the office is looking at; a later repoint or upload-over hides
 * it instead of showing whatever is there now. `replaces` names the older paper this one stands in
 * for: the customer then sees only this one.
 */
export async function showPaper(documentId: string, patch: SharedPaperPatch = {}): Promise<PaperResult> {
  const s = await staff();
  if ("error" in s) return { ok: false, error: s.error };
  const doc = await readPaper(s, documentId);
  if (!doc) return { ok: false, error: "That paper isn't on file." };
  const refusal = paperRefusal(doc, s.orgId);
  if (refusal) return { ok: false, error: refusal };
  if (await paperIsMoney(s, doc.id)) return { ok: false, error: MONEY_PAPER_REFUSAL };

  const cur = await readShare(s, doc.id);
  if (cur.error) return { ok: false, error: sharesNotReady(cur.error) ? NOT_READY : dbError(cur.error as never) };
  // Back up means back up on the job it came off (0326's stamp refuses the rest too): a paper
  // pointed at another job since would otherwise land on that job's, maybe another customer's, page.
  if (cur.row && cur.jobId !== doc.job_id) {
    return { ok: false, error: "This paper has moved to another job since it was on this job's page, so it can't go back up here." };
  }
  const v = normalizeSharedPaper(patch, doc, !cur.row);
  if (!v.ok) return v;

  let res;
  if (!cur.row) {
    // org_id, job_id, the file, who and when are stamped by the trigger from the documents row.
    res = await s.supabase
      .from(SHARES)
      .insert({ document_id: doc.id, org_id: s.orgId, job_id: doc.job_id, file_url_at_share: "", ...v.value })
      .select(SHARE_COLS);
  } else {
    // Back up (a new stamp of the file as it is now), with whatever else was sent.
    res = await s.supabase
      .from(SHARES)
      .update({ ...v.value, removed_at: null })
      .eq("document_id", doc.id)
      .eq("org_id", s.orgId)
      .select(SHARE_COLS);
  }
  if (res.error) return { ok: false, error: sharesNotReady(res.error) ? NOT_READY : dbError(res.error) };
  const row = (res.data as SharedPaperRow[] | null)?.[0];
  if (!row) return { ok: false, error: "It didn't go on the customer's page. Try again." };
  touched(doc.job_id!);
  return { ok: true, row };
}

/** Change what the customer reads for a paper already shown: its title, its kind, what it replaces. */
export async function updateShownPaper(documentId: string, patch: SharedPaperPatch): Promise<PaperResult> {
  const s = await staff();
  if ("error" in s) return { ok: false, error: s.error };
  const doc = await readPaper(s, documentId);
  if (!doc) return { ok: false, error: "That paper isn't on file." };
  const cur = await readShare(s, doc.id);
  if (cur.error) return { ok: false, error: sharesNotReady(cur.error) ? NOT_READY : dbError(cur.error as never) };
  if (!cur.row) return { ok: false, error: "That paper isn't on the customer's page. Show it first." };
  const v = normalizeSharedPaper(patch, doc, false);
  if (!v.ok) return v;
  if (!Object.keys(v.value).length) return { ok: true, row: cur.row };
  const { data, error } = await s.supabase.from(SHARES).update(v.value).eq("document_id", doc.id).eq("org_id", s.orgId).select(SHARE_COLS);
  if (error) return { ok: false, error: dbError(error) };
  const row = (data as SharedPaperRow[] | null)?.[0];
  if (!row) return { ok: false, error: "That didn't save. Reload the page." };
  touched(doc.job_id ?? "");
  return { ok: true, row };
}

/** Take a paper off the customer's page. Kept on record (who, when); Undo is showPaper. If it
 *  replaced an older paper, that older one shows again, and the office's list says so. */
export async function takePaperOff(documentId: string): Promise<PaperResult> {
  const s = await staff();
  if ("error" in s) return { ok: false, error: s.error };
  if (!UUID.test(documentId)) return { ok: false, error: "That paper isn't on file." };
  const { data, error } = await s.supabase
    .from(SHARES)
    .update({ removed_at: new Date().toISOString() })
    .eq("document_id", documentId)
    .eq("org_id", s.orgId)
    .select(`${SHARE_COLS}, job_id`);
  if (error) return { ok: false, error: sharesNotReady(error) ? NOT_READY : dbError(error) };
  const row = (data as (SharedPaperRow & { job_id: string })[] | null)?.[0];
  if (!row) return { ok: false, error: "That paper isn't on the customer's page." };
  touched(row.job_id);
  const { job_id: _job, ...rest } = row;
  void _job;
  return { ok: true, row: rest };
}

/**
 * The Photos tab's switch: show or stop showing one job photo. The same row as every other paper
 * (a photo is shown as kind Photo); stopping is a soft remove, as for the rest.
 */
export async function setPhotoShared(documentId: string, shared: boolean): Promise<{ ok: boolean; error?: string; shared?: boolean }> {
  const s = await staff();
  if ("error" in s) return { ok: false, error: s.error };
  const d = await readPaper(s, documentId);
  if (!d) return { ok: false, error: "That photo isn't on file." };
  if (d.category !== "Photo" || !d.job_id) return { ok: false, error: "Only a job photo can be shown to the customer." };
  // The portal signs only files in the job's own folder (isJobPhotoPath; 0326 refuses the rest by
  // name). A picture Organize filed elsewhere is said so here, never "shown" and then dropped.
  if (shared && !isJobPhotoPath(d.file_url, s.orgId, d.job_id)) return { ok: false, error: PHOTO_NOT_IN_JOB_FOLDER };
  if (shared) {
    const cur = await readShare(s, d.id);
    if (cur.row && !cur.row.removed_at) {
      // Up, but a newer paper stands in for it: the switch can't say "shown" while it isn't.
      const { data: newer } = await s.supabase
        .from(SHARES)
        .select("title")
        .eq("replaces_document_id", d.id)
        .eq("org_id", s.orgId)
        .is("removed_at", null)
        .limit(1);
      const n = (newer as { title: string }[] | null)?.[0];
      if (n) return { ok: false, error: `"${n.title}" replaces this photo on the customer's page. Change that on the Customer Page tab.` };
      // Already up (as a photo, or shown with the plans): nothing to do.
      return { ok: true, shared };
    }
    const res = await showPaper(d.id, cur.row ? {} : { kind: "photo" });
    return res.ok ? { ok: true, shared } : { ok: false, error: res.error };
  }
  const res = await takePaperOff(d.id);
  // "Not on the page" is fine here: it was not shown, and now it still is not.
  if (!res.ok && res.error !== "That paper isn't on the customer's page.") return { ok: false, error: res.error };
  touched(d.job_id);
  return { ok: true, shared };
}

/**
 * SHOW AGAIN (audit v994 PL4): a shown photo whose file changed after it was shown is hidden from
 * the customer (the portal shows only the file the office looked at). The office's tile says
 * "Changed Since Shown", and this is its one button: take the old share off and share the photo as
 * it is now, which stamps the new file. It is a person's decision on purpose; nothing re-shares a
 * changed file by itself (setPhotoShared(true) on a photo already shown changes nothing).
 */
export async function reshowPhoto(documentId: string): Promise<{ ok: boolean; error?: string; shared?: boolean }> {
  const off = await setPhotoShared(documentId, false);
  if (!off.ok) return off;
  const on = await setPhotoShared(documentId, true);
  // Off went through and on did not: the tile must say it is hidden now, not that it is shown.
  if (!on.ok) return { ok: false, shared: false, error: `${on.error ?? "It didn't show again."} It is off the customer's page now.` };
  return on;
}

// ── what the editor opens with ─────────────────────────────────────────────────────────────────

export type PickOptionChoice = { id: string; brand: string; label: string | null; partNumber: string | null; itemName: string | null; itemCode: string | null };

/** A job paper the office could show, with why not when it can't (said before anyone taps). */
export type JobPaper = {
  id: string;
  name: string;
  category: string | null;
  createdAt: string;
  format: DocFormat;
  /** A short-lived link for the office's own thumbnail and preview. */
  signedUrl: string | null;
  refusal: string | null;
};
export type PapersState =
  | { ready: true; papers: JobPaper[]; shares: SharedPaperRow[]; people: Record<string, string> }
  | { ready: false; reason: string };

/**
 * The office's editor state for a job: its stretches and picks (removed ones too, newest removal
 * first, for Undo across a reload), which photos are shown, every paper the customer could be shown
 * with its share history, and the brands and price-book options to pick from (names only: no
 * buy_price, no markup ever leaves the price book here).
 */
export async function jobShareState(jobId: string): Promise<
  | {
      ok: true;
      stretches: StretchRow[];
      picks: (PickRow & { file_url: string | null })[];
      sharedPhotoIds: string[];
      /** Of those, the ones the customer's page has stopped showing because the file changed (PL4). */
      staleSharedPhotoIds: string[];
      papers: PapersState;
      brands: string[];
      options: PickOptionChoice[];
    }
  | { ok: false; error: string }
> {
  const s = await staff();
  if ("error" in s) return { ok: false, error: s.error };
  if (!(await jobIsOurs(s, jobId))) return { ok: false, error: "That job isn't in your book." };
  const [st, pk, sh, docs, opts, vendors, stale] = await Promise.all([
    s.supabase.from("job_stretches").select(STRETCH_COLS).eq("job_id", jobId).eq("org_id", s.orgId).order("starts_on").order("sort"),
    s.supabase.from("job_picks").select(PICK_COLS).eq("job_id", jobId).eq("org_id", s.orgId).order("sort").order("updated_at"),
    s.supabase.from(SHARES).select(SHARE_COLS).eq("job_id", jobId).eq("org_id", s.orgId).order("shared_at", { ascending: false }),
    s.supabase
      .from("documents")
      .select("id, job_id, name, category, file_url, created_at")
      .eq("job_id", jobId)
      .eq("org_id", s.orgId)
      .not("file_url", "is", null)
      .order("created_at", { ascending: false }),
    s.supabase
      .from("price_list_item_options")
      .select("id, vendor, label, part_number, price_list_items(name, code)")
      .eq("org_id", s.orgId)
      .eq("archived", false)
      .order("vendor")
      .limit(1000),
    s.supabase.from("price_list_vendors").select("name").eq("org_id", s.orgId).eq("archived", false).order("name"),
    staleSharedPhotoIds(s.supabase, jobId),
  ]);
  const firstError = st.error ?? pk.error ?? docs.error;
  if (firstError) return { ok: false, error: dbError(firstError) };
  const picks = (pk.data ?? []) as PickRow[];

  // THE PAPERS. Before 0326 the share rows live under 0300's name: count the photos from there and
  // say the plans aren't ready, rather than failing the whole tab.
  let papers: PapersState;
  let sharedPhotoIds: string[];
  if (sh.error) {
    if (!sharesNotReady(sh.error)) return { ok: false, error: dbError(sh.error) };
    const old = await s.supabase.from("job_shared_photos").select("document_id").eq("job_id", jobId).eq("org_id", s.orgId);
    sharedPhotoIds = ((old.data ?? []) as { document_id: string }[]).map((r) => r.document_id);
    papers = { ready: false, reason: NOT_READY };
  } else {
    const shares = (sh.data ?? []) as SharedPaperRow[];
    sharedPhotoIds = shares.filter((r) => !r.removed_at && r.kind === "photo").map((r) => r.document_id);
    const docRows = (docs.data ?? []) as (PaperDoc & { created_at: string })[];
    // Receipts, bills and invoices never appear on this list at all: they are never shown.
    const candidates = docRows.filter((d) => !(COMPANY_PAPER_CATEGORIES as readonly string[]).includes(String(d.category ?? "")));
    const ids = candidates.map((d) => d.id);
    const [oi, signed] = await Promise.all([
      ids.length
        ? s.supabase
            .from("organized_items")
            .select("document_id, bill_id, tied_bill_id, tied_supplier_invoice_id, petty_cash_id, category")
            .in("document_id", ids)
            .eq("org_id", s.orgId)
        : Promise.resolve({ data: [] as unknown[] }),
      signDocumentUrls(s.supabase, candidates.map((d) => d.file_url)),
    ]);
    const money = new Set(
      ((oi.data ?? []) as (Parameters<typeof organizeRowIsMoney>[0] & { document_id: string })[]).filter(organizeRowIsMoney).map((r) => r.document_id),
    );
    const list: JobPaper[] = candidates
      .filter((d) => !money.has(d.id))
      .map((d) => ({
        id: d.id,
        name: d.name ?? "Untitled",
        category: d.category,
        createdAt: d.created_at,
        format: docFormat(d.file_url),
        signedUrl: (d.file_url && signed.get(d.file_url)) || null,
        refusal: paperRefusal(d, s.orgId),
      }));
    const who = [...new Set(shares.flatMap((r) => [r.shared_by, r.removed_by, r.replaces_marked_by]).filter((x): x is string => !!x))];
    const people: Record<string, string> = {};
    if (who.length) {
      const { data: ppl } = await s.supabase.from("profiles").select("id, full_name").in("id", who).eq("org_id", s.orgId);
      for (const p of (ppl ?? []) as { id: string; full_name: string | null }[]) people[p.id] = p.full_name?.trim() || "Someone";
    }
    papers = { ready: true, papers: list, shares, people };
  }

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
    sharedPhotoIds,
    // Only photos the switch calls shown can read "Changed Since Shown" (0326's view also carries
    // the plans and drawings, which job_shared_photo_state never calls stale after 0326's rebuild).
    staleSharedPhotoIds: stale.filter((id) => sharedPhotoIds.includes(id)),
    papers,
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
  | {
      ok: true;
      url: string | null;
      enabled: boolean;
      /** The customer has a link at all (an access row). No row is "no link yet", not "turned off". */
      hasLink: boolean;
      /** The job's status is one a customer is shown (0301's allowlist); else their link 404s here. */
      jobShown: boolean;
      customerId: string | null;
      customerName: string | null;
    }
  | { ok: false; error: string }
> {
  const s = await staff();
  if ("error" in s) return { ok: false, error: s.error };
  if (!UUID.test(jobId)) return { ok: false, error: "That job isn't in your book." };
  const { data: job } = await s.supabase
    .from("jobs")
    .select("id, status, customer_id, customers(name)")
    .eq("id", jobId)
    .eq("org_id", s.orgId)
    .maybeSingle();
  const j = job as { id: string; status: string | null; customer_id: string | null; customers: { name: string | null } | null } | null;
  if (!j) return { ok: false, error: "That job isn't in your book." };
  const jobShown = CUSTOMER_SHOWN_JOB_STATUSES.includes(String(j.status ?? ""));
  if (!j.customer_id) return { ok: true, url: null, enabled: false, hasLink: false, jobShown, customerId: null, customerName: null };
  const [{ data: access }, { data: org }] = await Promise.all([
    s.supabase.from("customer_portal_access").select("token, enabled").eq("customer_id", j.customer_id).eq("org_id", s.orgId).maybeSingle(),
    s.supabase.from("organizations").select("settings").eq("id", s.orgId).maybeSingle(),
  ]);
  const a = access as { token: string; enabled: boolean } | null;
  const url = a?.token
    ? `${orgDocUrl(getOrgSettings((org as { settings?: unknown } | null)?.settings), "portal", a.token)}/jobs/${j.id}`
    : null;
  return { ok: true, url, enabled: !!a?.enabled, hasLink: !!a?.token, jobShown, customerId: j.customer_id, customerName: j.customers?.name ?? null };
}
