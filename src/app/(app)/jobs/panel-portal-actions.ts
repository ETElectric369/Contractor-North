"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireStaff } from "@/lib/staff-guard";
import { dbError } from "@/lib/db-error";
import { reportError } from "@/lib/observe";
import { getOrgSettings } from "@/lib/org-settings";
import { formatDate } from "@/lib/utils";
import { directoryFromRows, type DirectoryPanel } from "@/lib/panel/directory";
import type { JobCircuit, JobPanel } from "@/lib/types";
import { filePlan, showPaper, takePaperOff } from "./portal-share-actions";

/**
 * THE PANEL ON THE CUSTOMER'S SIDE: the office's three doors (Panel plan, phase 5).
 *
 *   - loadPanelPortal: the Customer Page tab's panel card: the switch's state and a preview of
 *     exactly what the customer reads (the same directory shape and renderer the portal uses).
 *   - setPanelOnPortal: "Show The Panel On Their Page", one switch per job (Erik's decision 2: OFF
 *     until the office turns it on). It sets job_panels.shown_on_portal on the job's live panels;
 *     0333's guard refuses it from anyone but the office, and 0335's portal_job_view reads it.
 *   - saveCircuitMap: "Save As Circuit Map". Renders the printed directory (the same /print/panel
 *     page Print Panel Directory shows, through the PDF engine), files it on the job as a Plan
 *     (filePlan: the plans door's own step), and shows it on the customer's Plans And Drawings as a
 *     Circuit Map that REPLACES the newest circuit map already there (showPaper with 0326's
 *     replaces chain), so the customer sees only the newest. The kind is this door's explicit
 *     word, never a guess from the file's name. Undo (undoCircuitMap) takes it off their page, and
 *     the older map shows again; the file stays in the job's Plans.
 *
 * Office only, every one (requireStaff; the Customer Page tab is not a tech's). Every write reads
 * back what it wrote (the silent-write law) and says what happened in plain words.
 */

type Fail = { ok: false; error: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOT_READY = "The Panel tab isn't switched on for this database yet. It turns on with the next update.";
type Office = { supabase: SupabaseClient; orgId: string };

async function office(): Promise<Office | Fail> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error === "This action is staff-only." ? "Only the office can do that." : (ctx.error ?? "Only the office can do that.") };
  if (!ctx.orgId) return { ok: false, error: "Your account isn't in a company yet." };
  return { supabase: ctx.supabase as unknown as SupabaseClient, orgId: ctx.orgId };
}

type JobLite = { id: string; name: string | null; customer: string | null };
async function jobOf(o: Office, jobId: string): Promise<JobLite | null> {
  if (!UUID.test(jobId)) return null;
  const { data } = await o.supabase.from("jobs").select("id, name, customers(name)").eq("id", jobId).eq("org_id", o.orgId).maybeSingle();
  if (!data) return null;
  const d = data as { id: string; name: string | null; customers: { name: string | null } | { name: string | null }[] | null };
  const c = Array.isArray(d.customers) ? d.customers[0] : d.customers;
  return { id: d.id, name: d.name, customer: c?.name?.trim() || null };
}

function schemaMissing(e: { code?: string; message?: string } | null | undefined): boolean {
  if (!e) return false;
  return e.code === "42P01" || e.code === "PGRST205" || (/job_(panels|circuits)/.test(String(e.message ?? "")) && /does not exist|could not find/i.test(String(e.message ?? "")));
}

const PANEL_COLS = "id, name, brand, main_amps, spaces, numbering, dead_spaces, shown_on_portal, created_at";
/** Only what the directory draws: no wire tag, note, progress, source or who. */
const CIRCUIT_COLS = "id, panel_id, room, description, panel_label, amps, poles, kind, space, half, work, state, removed_at, sort_order";

export type PanelPortalPanel = { id: string; name: string; shown: boolean };
export type CircuitMapShown = { documentId: string; title: string; sharedAt: string };
export type PanelPortalLoad =
  | {
      ok: true;
      panels: PanelPortalPanel[];
      /** Exactly what the customer reads for each panel (shown or not): the portal's shape. */
      preview: DirectoryPanel[];
      /** The circuit map on their Plans And Drawings now (the newest of its chain), if any. */
      circuitMap: CircuitMapShown | null;
    }
  | Fail;

/** The newest circuit map on the job's customer page: a live circuit_map share no live share replaces. */
async function currentCircuitMap(o: Office, jobId: string, except?: string): Promise<CircuitMapShown | null> {
  const { data, error } = await o.supabase
    .from("job_shared_documents")
    .select("document_id, title, replaces_document_id, shared_at")
    .eq("job_id", jobId)
    .eq("org_id", o.orgId)
    .eq("kind", "circuit_map")
    .is("removed_at", null);
  if (error) {
    reportError("panel.currentCircuitMap", error, { jobId });
    return null;
  }
  const rows = (data ?? []) as { document_id: string; title: string; replaces_document_id: string | null; shared_at: string }[];
  const replaced = new Set(rows.map((r) => r.replaces_document_id).filter(Boolean));
  const heads = rows.filter((r) => !replaced.has(r.document_id) && r.document_id !== except).sort((a, b) => b.shared_at.localeCompare(a.shared_at));
  const h = heads[0];
  return h ? { documentId: h.document_id, title: h.title, sharedAt: h.shared_at } : null;
}

export async function loadPanelPortal(jobId: string): Promise<PanelPortalLoad> {
  const o = await office();
  if ("error" in o) return o;
  const job = await jobOf(o, jobId);
  if (!job) return { ok: false, error: "That job isn't in your book." };
  const [pRes, cRes, map] = await Promise.all([
    o.supabase.from("job_panels").select(PANEL_COLS).eq("job_id", jobId).eq("org_id", o.orgId).is("removed_at", null).order("created_at"),
    o.supabase.from("job_circuits").select(CIRCUIT_COLS).eq("job_id", jobId).eq("org_id", o.orgId).eq("state", "kept").is("removed_at", null).order("sort_order").order("created_at"),
    currentCircuitMap(o, jobId),
  ]);
  const err = pRes.error ?? cRes.error;
  if (err) return { ok: false, error: schemaMissing(err) ? NOT_READY : dbError(err) };
  const panels = (pRes.data ?? []) as unknown as (JobPanel & { shown_on_portal: boolean })[];
  const circuits = (cRes.data ?? []) as unknown as JobCircuit[];
  return {
    ok: true,
    panels: panels.map((p) => ({ id: p.id, name: p.name, shown: !!p.shown_on_portal })),
    preview: panels.map((p) => directoryFromRows(p, circuits)),
    circuitMap: map,
  };
}

export type PanelSwitchResult = { ok: true; panels: PanelPortalPanel[] } | Fail;

/**
 * SHOW THE PANEL ON THEIR PAGE: on or off for every live panel on the job, in one write, read back.
 * A job with no panel yet has nothing to show: said so, never a silent "on".
 */
export async function setPanelOnPortal(jobId: string, shown: boolean): Promise<PanelSwitchResult> {
  const o = await office();
  if ("error" in o) return o;
  if (typeof shown !== "boolean") return { ok: false, error: "Pick on or off." };
  const job = await jobOf(o, jobId);
  if (!job) return { ok: false, error: "That job isn't in your book." };
  const { data, error } = await o.supabase
    .from("job_panels")
    .update({ shown_on_portal: shown })
    .eq("job_id", jobId)
    .eq("org_id", o.orgId)
    .is("removed_at", null)
    .select("id, name, shown_on_portal");
  if (error) return { ok: false, error: schemaMissing(error) ? NOT_READY : dbError(error) };
  const rows = (data ?? []) as { id: string; name: string; shown_on_portal: boolean }[];
  if (!rows.length) return { ok: false, error: "This job has no panel yet. Add it on the Panel tab first." };
  if (rows.some((r) => r.shown_on_portal !== shown)) return { ok: false, error: "That didn't save. Reload the page and try again." };
  revalidatePath(`/jobs/${jobId}`);
  return { ok: true, panels: rows.map((r) => ({ id: r.id, name: r.name, shown: r.shown_on_portal })) };
}

export type CircuitMapResult =
  | { ok: true; documentId: string; title: string; replaced: string | null; message: string }
  | (Fail & { documentId?: string });

/** Render /print/panel/<job> through the PDF engine with the office's own session. */
async function renderDirectoryPdf(jobId: string): Promise<{ ok: true; bytes: Uint8Array } | Fail> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "https";
  const cookie = h.get("cookie");
  if (!host) return { ok: false, error: "The directory couldn't be printed just now. Try again." };
  try {
    const res = await fetch(`${proto}://${host}/api/pdf/panel/${jobId}?m=0.5`, {
      headers: cookie ? { cookie } : undefined,
      cache: "no-store",
    });
    if (!res.ok || !String(res.headers.get("content-type") ?? "").includes("application/pdf")) {
      const j = (await res.json().catch(() => null)) as { error?: string } | null;
      return { ok: false, error: j?.error ? `The directory couldn't be printed: ${j.error}` : "The directory couldn't be printed just now. Try again." };
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length < 100) return { ok: false, error: "The directory came back empty. Try again." };
    return { ok: true, bytes };
  } catch (e) {
    reportError("panel.renderDirectoryPdf", e, { jobId });
    return { ok: false, error: "The directory couldn't be printed just now. Check your connection and try again." };
  }
}

/**
 * SAVE AS CIRCUIT MAP. Print → file as a Plan on the job → show it on the customer's Plans And
 * Drawings as a Circuit Map replacing the newest one there. Each step's refusal is said as it is; a
 * file that went up but was never filed is taken back out, and one that was filed but didn't go on
 * their page says so (it is kept in the job's Plans, where the office can show it by hand).
 */
export async function saveCircuitMap(jobId: string): Promise<CircuitMapResult> {
  const o = await office();
  if ("error" in o) return o;
  const job = await jobOf(o, jobId);
  if (!job) return { ok: false, error: "That job isn't in your book." };
  const who = job.customer ?? "the customer";

  const { count, error: cErr } = await o.supabase
    .from("job_circuits")
    .select("id", { count: "exact", head: true })
    .eq("job_id", jobId)
    .eq("org_id", o.orgId)
    .eq("state", "kept")
    .is("removed_at", null)
    .neq("work", "removed");
  if (cErr) return { ok: false, error: schemaMissing(cErr) ? NOT_READY : dbError(cErr) };
  if (!count) return { ok: false, error: "There are no kept circuits on this job yet, so there is no map to save." };

  const pdf = await renderDirectoryPdf(jobId);
  if (!pdf.ok) return pdf;

  const { data: org } = await o.supabase.from("organizations").select("settings").eq("id", o.orgId).maybeSingle();
  const tz = getOrgSettings((org as { settings?: unknown } | null)?.settings).timezone;
  const day = formatDate(new Date(), tz);
  // The job's folder, the way every job file lands (lib/job-file-upload's shape), so the portal's
  // "is it in the job's folder" check holds.
  const path = `${o.orgId}/${jobId}/${Date.now()}-Circuit_Map.pdf`;
  const up = await o.supabase.storage.from("documents").upload(path, pdf.bytes, { contentType: "application/pdf", upsert: false });
  if (up.error) return { ok: false, error: `The circuit map didn't upload (${up.error.message}). Try again.` };

  const filed = await filePlan(jobId, { path, name: `Circuit Map ${day}.pdf`, sizeBytes: pdf.bytes.length });
  if (!filed.ok) {
    // filePlan takes the file back out when its row doesn't land; a refusal before that leaves it.
    await o.supabase.storage.from("documents").remove([path]);
    return { ok: false, error: filed.error };
  }
  const docId = filed.paper.id;
  const older = await currentCircuitMap(o, jobId, docId);
  const shown = await showPaper(docId, { kind: "circuit_map", title: "Circuit Map", ...(older ? { replaces: older.documentId } : {}) });
  if (!shown.ok) {
    return { ok: false, documentId: docId, error: `Saved in the job's Plans, but it didn't go on ${who}'s page: ${shown.error}` };
  }
  revalidatePath(`/jobs/${jobId}`);
  return {
    ok: true,
    documentId: docId,
    title: shown.row.title,
    replaced: older?.title ?? null,
    message: older
      ? `Saved as the circuit map on ${who}'s page. It replaces "${older.title}", so ${who} sees only the new one.`
      : `Saved as the circuit map on ${who}'s page, under Plans And Drawings.`,
  };
}

/** Undo Save As Circuit Map: off their page (the older map shows again); the file stays a Plan. */
export async function undoCircuitMap(documentId: string): Promise<{ ok: true; message: string } | Fail> {
  const res = await takePaperOff(documentId);
  if (!res.ok) return res;
  return {
    ok: true,
    message: res.row.replaces_document_id
      ? "Taken off their page. The older circuit map shows again. The file stays in the job's Plans."
      : "Taken off their page. The file stays in the job's Plans.",
  };
}
