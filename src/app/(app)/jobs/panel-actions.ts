"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { requireStaff } from "@/lib/staff-guard";
import { isStaffRole } from "@/lib/actions/perms";
import { dbError } from "@/lib/db-error";
import { reportError } from "@/lib/observe";
import { officeRecipients, ringOffice } from "@/lib/notifications";
import {
  countWord,
  newSuggestionsOnly,
  nextProgress,
  quoteCircuitsToSuggestions,
  rankEstimateCandidates,
  type EstimateCandidate,
} from "@/lib/panel/model";
import { isUuid, normalizeCircuitPatch, normalizePanelPatch } from "@/lib/panel/input";
import type { CircuitProgress, JobCircuit, JobPanel, QuoteCircuit } from "@/lib/types";

/**
 * THE PANEL TAB'S SERVER DOORS (Panel plan, phases 1-2; migration 0333).
 *
 * WHO: Erik's decision 1 (2026-09-25, "go for all"). The crew and the office share every circuit
 * door — add, relabel, set the space, Planned / Roughed / Done, Verified On Site, Take Off with Undo,
 * Keep / Not This — because the crew are the ones standing at the panel and nothing here carries a
 * price. Only the office brings circuits in from an estimate (requireStaff, re-checked here, and the
 * database refuses source 'estimate' from anyone else) or takes a panel off a job.
 *
 * HOW: every write names a row of the caller's own org, whitelists its fields (lib/panel/input),
 * and reads back what it wrote — a zero-row update is a 204, not a save (the silent-write law). The
 * row that comes back is what the tab shows, so the screen is the database's answer, not a guess.
 * There is no Save button: each field saves when it changes, and every removal is soft, so Undo
 * puts it back exactly (the not-annoying law).
 *
 * THE OFFICE HEARS: a crew change rings the office once per job per hour (ringOffice, the ring the
 * materials list uses, pulled into lib/notifications). It runs behind after(), so it never costs
 * the man at the panel a round trip, and it can never unsave the change.
 */

const PANEL_COLS =
  "id, org_id, job_id, name, brand, bus_amps, main_amps, spaces, numbering, dead_spaces, twin_spaces, photo_document_id, notes, shown_on_portal, created_by, created_at, updated_by, updated_at, removed_at, removed_by";
const CIRCUIT_COLS =
  "id, org_id, job_id, panel_id, room, description, panel_label, amps, poles, kind, wire, wire_tag, space, half, work, progress, state, source, source_quote_id, source_document_id, source_row, verified, verified_by, verified_at, sort_order, created_by, created_at, updated_by, updated_at, removed_at, removed_by";

type Member = { supabase: SupabaseClient; userId: string; orgId: string; staff: boolean; name: string };
type Fail = { ok: false; error: string };
type RowResult<T> = { ok: true; row: T } | Fail;

const NOT_READY = "The Panel tab isn't switched on for this database yet. It turns on with the next update.";

/** Is this the "table isn't there yet" answer (0333 not applied)? */
function schemaMissing(e: { code?: string; message?: string } | null | undefined): boolean {
  if (!e) return false;
  return e.code === "42P01" || e.code === "PGRST205" || /job_(panels|circuits)/.test(String(e.message ?? "")) && /does not exist|could not find/i.test(String(e.message ?? ""));
}
const fail = (e: { code?: string; message?: string } | null | undefined, fallback: string): Fail => ({
  ok: false,
  error: schemaMissing(e) ? NOT_READY : e ? dbError(e) : fallback,
});

/** Signed in, active, in an org. The role rides along: it picks which doors show and whether the
 *  office is rung, never whether a circuit write is allowed (RLS and the guard say that). */
async function member(): Promise<Member | Fail> {
  const supabase = (await createClient()) as unknown as SupabaseClient;
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };
  const { data: me } = await supabase.from("profiles").select("role, org_id, active, full_name").eq("id", user.id).maybeSingle();
  const p = (me ?? null) as { role?: string | null; org_id?: string | null; active?: boolean | null; full_name?: string | null } | null;
  if (!p) return { ok: false, error: "Your account isn't set up yet." };
  if (p.active === false) return { ok: false, error: "This account has been deactivated." };
  if (!p.org_id) return { ok: false, error: "Your account isn't in a company yet." };
  return { supabase, userId: user.id, orgId: p.org_id, staff: isStaffRole(p.role), name: p.full_name?.trim() || "A crew member" };
}

/** The office's doors: requireStaff (signed in, staff, active), then the org. */
async function office(): Promise<Member | Fail> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error === "This action is staff-only." ? "Only the office can do that." : (ctx.error ?? "Only the office can do that.") };
  if (!ctx.orgId) return { ok: false, error: "Your account isn't in a company yet." };
  const supabase = ctx.supabase as unknown as SupabaseClient;
  const { data: me } = await supabase.from("profiles").select("full_name").eq("id", ctx.userId).maybeSingle();
  return { supabase, userId: ctx.userId, orgId: ctx.orgId, staff: true, name: (me as { full_name?: string | null } | null)?.full_name?.trim() || "The office" };
}

type JobRow = { id: string; job_number: string | null; name: string | null; customer_id: string | null };
async function jobOf(m: Member, jobId: string): Promise<JobRow | null> {
  if (!isUuid(jobId)) return null;
  const { data } = await m.supabase.from("jobs").select("id, job_number, name, customer_id").eq("id", jobId).eq("org_id", m.orgId).maybeSingle();
  return (data as JobRow | null) ?? null;
}

async function circuitOf(m: Member, id: string): Promise<JobCircuit | null> {
  if (!isUuid(id)) return null;
  const { data } = await m.supabase.from("job_circuits").select(CIRCUIT_COLS).eq("id", id).eq("org_id", m.orgId).maybeSingle();
  return (data as JobCircuit | null) ?? null;
}

const touched = (jobId: string) => revalidatePath(`/jobs/${jobId}`);

/** A crew change rings the office once per job per hour, with a running count ("Brian changed 3
 *  circuits on J-011 13897 Herringbone"). Only a crew change is news; the office edits its own list
 *  all day. Everything it needs is resolved in request scope and handed to after(). */
function ringIfCrew(m: Member, jobId: string) {
  if (m.staff) return;
  after(() => ringPanelChange(m, jobId));
}

async function ringPanelChange(m: Member, jobId: string): Promise<void> {
  try {
    const job = await jobOf(m, jobId);
    if (!job) return;
    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const [{ data: changed }, { data: panels }] = await Promise.all([
      m.supabase.from("job_circuits").select("id, updated_by").eq("job_id", jobId).eq("org_id", m.orgId).gte("updated_at", since),
      m.supabase.from("job_panels").select("id, updated_by").eq("job_id", jobId).eq("org_id", m.orgId).gte("updated_at", since),
    ]);
    const byIds = [...new Set([...(changed ?? []), ...(panels ?? [])].map((r: { updated_by: string | null }) => r.updated_by).filter(Boolean))] as string[];
    const { data: people } = byIds.length
      ? await m.supabase.from("profiles").select("id, full_name, role").in("id", byIds)
      : { data: [] as { id: string; full_name: string | null; role: string | null }[] };
    const crew = new Map(
      ((people ?? []) as { id: string; full_name: string | null; role: string | null }[])
        .filter((p) => !isStaffRole(p.role))
        .map((p) => [p.id, p.full_name?.trim() || "A crew member"]),
    );
    const circuits = (changed ?? []).filter((r: { updated_by: string | null }) => r.updated_by && crew.has(r.updated_by));
    const names = [...new Set([...circuits, ...(panels ?? [])].map((r: { updated_by: string | null }) => crew.get(r.updated_by ?? "")).filter(Boolean))] as string[];
    const who = names.length ? (names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`) : m.name;
    const where = [job.job_number, job.name].filter(Boolean).join(" ") || "a job";
    const n = circuits.length;
    const title = n > 0 ? `${who} changed ${n} circuit${n === 1 ? "" : "s"} on ${where}` : `${who} changed the panel on ${where}`;
    const recipients = await officeRecipients(m.supabase, m.userId);
    await ringOffice(m.orgId, recipients, {
      type: "panel_changed",
      title,
      body: "Open the Panel tab to see what changed.",
      url: `/jobs/${jobId}?tab=panel`,
      windowMinutes: 60,
      mode: "once_per_window",
    });
  } catch (e) {
    reportError("panel.ringPanelChange", e, { jobId });
  }
}

// ── reading ─────────────────────────────────────────────────────────────────────────────────────

export type PanelEstimate = EstimateCandidate & { onJob: number };
export type PanelLoad =
  | {
      ok: true;
      staff: boolean;
      panels: JobPanel[];
      circuits: JobCircuit[];
      /** The office only: estimates this job can bring circuits in from. Never sent to a tech. */
      estimates: PanelEstimate[];
      photos: { id: string; name: string | null; created_at: string }[];
      people: Record<string, string>;
    }
  | Fail;

/** Everything the tab shows, read when the tab opens (the hub pays nothing until someone looks). */
export async function loadJobPanel(jobId: string): Promise<PanelLoad> {
  const m = await member();
  if ("error" in m) return m;
  const job = await jobOf(m, jobId);
  if (!job) return { ok: false, error: "That job isn't in your book." };

  const [pRes, cRes, phRes] = await Promise.all([
    m.supabase.from("job_panels").select(PANEL_COLS).eq("job_id", jobId).eq("org_id", m.orgId).is("removed_at", null).order("created_at"),
    m.supabase.from("job_circuits").select(CIRCUIT_COLS).eq("job_id", jobId).eq("org_id", m.orgId).order("sort_order").order("created_at"),
    m.supabase.from("documents").select("id, name, created_at").eq("job_id", jobId).eq("org_id", m.orgId).eq("category", "Photo").order("created_at", { ascending: false }).limit(60),
  ]);
  if (pRes.error) return fail(pRes.error, "The panel couldn't load.");
  if (cRes.error) return fail(cRes.error, "The circuits couldn't load.");
  const panels = (pRes.data ?? []) as JobPanel[];
  const circuits = (cRes.data ?? []) as JobCircuit[];

  // THE ESTIMATE FINDER RUNS IN AN OFFICE SESSION ONLY: a tech's page never carries it (an estimate
  // is the office's paper), and the door it feeds is the office's.
  let estimates: PanelEstimate[] = [];
  if (m.staff) {
    let q = m.supabase
      .from("quotes")
      .select("id, quote_number, job_id, customer_id, circuits, address, created_at")
      .eq("org_id", m.orgId)
      .not("circuits", "is", null);
    q = job.customer_id ? q.or(`job_id.eq.${jobId},and(job_id.is.null,customer_id.eq.${job.customer_id})`) : q.eq("job_id", jobId);
    const { data: qs, error: qErr } = await q.order("created_at", { ascending: false }).limit(20);
    if (qErr) reportError("panel.loadJobPanel.estimates", qErr, { jobId });
    estimates = rankEstimateCandidates(jobId, job.customer_id, (qs ?? []) as never).map((c) => ({
      ...c,
      onJob: circuits.filter((x) => x.source_quote_id === c.id).length,
    }));
  }

  const ids = [...new Set(circuits.flatMap((c) => [c.verified_by, c.updated_by]).filter(Boolean))] as string[];
  const people: Record<string, string> = {};
  if (ids.length) {
    const { data: ps } = await m.supabase.from("profiles").select("id, full_name").in("id", ids);
    for (const p of (ps ?? []) as { id: string; full_name: string | null }[]) people[p.id] = p.full_name?.trim() || "Someone";
  }
  return {
    ok: true,
    staff: m.staff,
    panels,
    circuits,
    estimates,
    photos: ((phRes.data ?? []) as { id: string; name: string | null; created_at: string }[]),
    people,
  };
}

// ── the panel ───────────────────────────────────────────────────────────────────────────────────

/** Add The Panel (panelId null) or change one of its fields. The crew and the office alike. */
export async function savePanel(jobId: string, panelId: string | null, patch: Record<string, unknown>): Promise<RowResult<JobPanel>> {
  const m = await member();
  if ("error" in m) return m;
  const v = normalizePanelPatch(patch);
  if (!v.ok) return v;
  if (!(await jobOf(m, jobId))) return { ok: false, error: "That job isn't in your book." };
  if (v.value.photo_document_id) {
    const { data: doc } = await m.supabase
      .from("documents")
      .select("id")
      .eq("id", v.value.photo_document_id)
      .eq("job_id", jobId)
      .eq("org_id", m.orgId)
      .eq("category", "Photo")
      .maybeSingle();
    if (!doc) return { ok: false, error: "Pick the photo from this job's Photos." };
  }
  if (panelId && !isUuid(panelId)) return { ok: false, error: "That panel isn't on this job." };
  if (panelId && !Object.keys(v.value).length) return { ok: false, error: "Nothing to save." };
  const q = panelId
    ? m.supabase.from("job_panels").update(v.value).eq("id", panelId).eq("job_id", jobId).eq("org_id", m.orgId).is("removed_at", null)
    : m.supabase.from("job_panels").insert({ job_id: jobId, ...v.value });
  const { data, error } = await q.select(PANEL_COLS).maybeSingle();
  if (error) return fail(error, "The panel didn't save.");
  if (!data) return { ok: false, error: "The panel didn't save. It may have been taken off this job. Reload and try again." };
  touched(jobId);
  ringIfCrew(m, jobId);
  return { ok: true, row: data as JobPanel };
}

/** Take a panel off the job (the office only; the database says so too). Its circuits stay on the
 *  job with no panel, and Put Back returns it. */
export async function setPanelRemoved(jobId: string, panelId: string, removed: boolean): Promise<RowResult<JobPanel>> {
  const m = await office();
  if ("error" in m) return m;
  if (!isUuid(panelId) || !(await jobOf(m, jobId))) return { ok: false, error: "That panel isn't on this job." };
  const { data, error } = await m.supabase
    .from("job_panels")
    .update({ removed_at: removed ? new Date().toISOString() : null })
    .eq("id", panelId)
    .eq("job_id", jobId)
    .eq("org_id", m.orgId)
    .select(PANEL_COLS)
    .maybeSingle();
  if (error) return fail(error, "The panel didn't change.");
  if (!data) return { ok: false, error: "That panel isn't on this job any more. Reload and try again." };
  touched(jobId);
  return { ok: true, row: data as JobPanel };
}

// ── circuits ────────────────────────────────────────────────────────────────────────────────────

/** Add A Circuit: a person typed it, so it counts at once (kept, source hand). */
export async function addCircuit(jobId: string, input: Record<string, unknown>): Promise<RowResult<JobCircuit>> {
  const m = await member();
  if ("error" in m) return m;
  const v = normalizeCircuitPatch(input);
  if (!v.ok) return v;
  if (!(await jobOf(m, jobId))) return { ok: false, error: "That job isn't in your book." };
  const { data: last } = await m.supabase
    .from("job_circuits")
    .select("sort_order")
    .eq("job_id", jobId)
    .eq("org_id", m.orgId)
    .order("sort_order", { ascending: false })
    .limit(1)
    .maybeSingle();
  const { data, error } = await m.supabase
    .from("job_circuits")
    .insert({
      job_id: jobId,
      ...v.value,
      state: "kept",
      source: "hand",
      sort_order: v.value.sort_order ?? Number((last as { sort_order?: number } | null)?.sort_order ?? -1) + 1,
    })
    .select(CIRCUIT_COLS)
    .maybeSingle();
  if (error) return fail(error, "The circuit didn't save.");
  if (!data) return { ok: false, error: "The circuit didn't save. Try again." };
  touched(jobId);
  ringIfCrew(m, jobId);
  return { ok: true, row: data as JobCircuit };
}

async function writeCircuit(m: Member, id: string, fields: Record<string, unknown>, guard?: (q: any) => any): Promise<RowResult<JobCircuit>> {
  if (!isUuid(id)) return { ok: false, error: "That circuit isn't on this job." };
  let q = m.supabase.from("job_circuits").update(fields).eq("id", id).eq("org_id", m.orgId);
  if (guard) q = guard(q);
  const { data, error } = await q.select(CIRCUIT_COLS).maybeSingle();
  if (error) return fail(error, "The circuit didn't save.");
  if (!data) return { ok: false, error: "That circuit changed or went away while you were on it. Reload and try again." };
  const row = data as JobCircuit;
  touched(row.job_id);
  ringIfCrew(m, row.job_id);
  return { ok: true, row };
}

/** One field (or a few) saved as it changes. */
export async function saveCircuit(circuitId: string, patch: Record<string, unknown>): Promise<RowResult<JobCircuit>> {
  const m = await member();
  if ("error" in m) return m;
  const v = normalizeCircuitPatch(patch);
  if (!v.ok) return v;
  if (!Object.keys(v.value).length) return { ok: false, error: "Nothing to save." };
  return writeCircuit(m, circuitId, v.value);
}

/** The progress chip: one tap moves it on from what the tapper SAW, so a double tap or a crewmate's
 *  tap in the same second can't skip a step silently. */
export async function advanceProgress(circuitId: string, from: CircuitProgress): Promise<RowResult<JobCircuit>> {
  const m = await member();
  if ("error" in m) return m;
  if (!["planned", "roughed", "done"].includes(from)) return { ok: false, error: "Pick Planned, Roughed or Done." };
  const r = await writeCircuit(m, circuitId, { progress: nextProgress(from) }, (q) => q.eq("progress", from));
  if (r.ok) return r;
  const now = await circuitOf(m, circuitId);
  if (now && now.progress !== from) {
    const words = { planned: "Planned", roughed: "Roughed", done: "Done" }[now.progress];
    return { ok: false, error: `Someone just changed this one. It's ${words} now.` };
  }
  return r;
}

/** Verified On Site: who and when are stamped by the database from the session, never sent. */
export async function markVerified(circuitId: string, verified: boolean): Promise<RowResult<JobCircuit>> {
  const m = await member();
  if ("error" in m) return m;
  return writeCircuit(m, circuitId, { verified: !!verified });
}

/** Take Off (a kept circuit) or Not This (a suggestion): a soft remove, so Undo puts it back. */
export async function takeOffCircuit(circuitId: string): Promise<RowResult<JobCircuit>> {
  const m = await member();
  if ("error" in m) return m;
  return writeCircuit(m, circuitId, { removed_at: new Date().toISOString() }, (q) => q.is("removed_at", null));
}

/** Undo / Put Back. */
export async function undoTakeOff(circuitId: string): Promise<RowResult<JobCircuit>> {
  const m = await member();
  if ("error" in m) return m;
  return writeCircuit(m, circuitId, { removed_at: null }, (q) => q.not("removed_at", "is", null));
}

/** Not This: a suggestion set aside. It keeps its place in Bring In's memory, so a second Bring In
 *  doesn't bring it back. */
export async function dismissSuggestion(circuitId: string): Promise<RowResult<JobCircuit>> {
  const m = await member();
  if ("error" in m) return m;
  return writeCircuit(m, circuitId, { removed_at: new Date().toISOString() }, (q) => q.eq("state", "suggested").is("removed_at", null));
}

export type KeepResult = { ok: true; rows: JobCircuit[]; skipped: { id: string; error: string }[] } | Fail;

/**
 * Keep (one) or Keep All: suggestions become the job's circuits and start to count. keep=false is
 * the Undo, back to suggestions. One batch is one write and one ring to the office. If the batch is
 * refused (one suggestion sits on a No Stab space), each is tried on its own and the ones that
 * couldn't be kept are named, never dropped.
 */
export async function keepSuggestions(jobId: string, ids: string[], keep = true): Promise<KeepResult> {
  const m = await member();
  if ("error" in m) return m;
  const want = [...new Set((ids ?? []).filter(isUuid))];
  if (!want.length) return { ok: false, error: "Nothing to keep." };
  if (!(await jobOf(m, jobId))) return { ok: false, error: "That job isn't in your book." };
  const from = keep ? "suggested" : "kept";
  const to = keep ? "kept" : "suggested";
  const batch = await m.supabase
    .from("job_circuits")
    .update({ state: to })
    .in("id", want)
    .eq("job_id", jobId)
    .eq("org_id", m.orgId)
    .eq("state", from)
    .is("removed_at", null)
    .select(CIRCUIT_COLS);
  let rows: JobCircuit[] = [];
  const skipped: { id: string; error: string }[] = [];
  if (!batch.error) {
    rows = (batch.data ?? []) as JobCircuit[];
  } else if (schemaMissing(batch.error)) {
    return { ok: false, error: NOT_READY };
  } else {
    for (const id of want) {
      const one = await m.supabase
        .from("job_circuits")
        .update({ state: to })
        .eq("id", id)
        .eq("job_id", jobId)
        .eq("org_id", m.orgId)
        .eq("state", from)
        .is("removed_at", null)
        .select(CIRCUIT_COLS)
        .maybeSingle();
      if (one.error) skipped.push({ id, error: dbError(one.error) });
      else if (one.data) rows.push(one.data as JobCircuit);
    }
  }
  for (const id of want) {
    if (!rows.some((r) => r.id === id) && !skipped.some((s) => s.id === id)) {
      skipped.push({ id, error: keep ? "It was already kept or set aside." : "It was already a suggestion or taken off." });
    }
  }
  if (rows.length) {
    touched(jobId);
    ringIfCrew(m, jobId);
  }
  return { ok: true, rows, skipped };
}

export type BringInResult =
  | { ok: true; rows: JobCircuit[]; added: number; already: number; setAside: number; message: string }
  | Fail;

/**
 * Bring In From Estimate (the office only). The estimate's take-off lands as SUGGESTIONS, each
 * marked "From E-017"; nothing counts until a person keeps it. Idempotent by the row it came from:
 * a second tap adds nothing and says so out loud, and a row set aside with Not This stays set aside.
 * The estimate must be this job's own, or the same customer's with no job yet — the finder's rule.
 */
export async function bringInEstimateCircuits(jobId: string, quoteId: string): Promise<BringInResult> {
  const m = await office();
  if ("error" in m) return m;
  const job = await jobOf(m, jobId);
  if (!job) return { ok: false, error: "That job isn't in your book." };
  if (!isUuid(quoteId)) return { ok: false, error: "That estimate isn't in your book." };
  const { data: quote } = await m.supabase
    .from("quotes")
    .select("id, quote_number, job_id, customer_id, circuits")
    .eq("id", quoteId)
    .eq("org_id", m.orgId)
    .maybeSingle();
  const q = quote as { id: string; quote_number: string | null; job_id: string | null; customer_id: string | null; circuits: QuoteCircuit[] | null } | null;
  if (!q) return { ok: false, error: "That estimate isn't in your book." };
  const belongs = q.job_id === jobId || (q.job_id == null && !!job.customer_id && q.customer_id === job.customer_id);
  if (!belongs) return { ok: false, error: `${q.quote_number ?? "That estimate"} is for another job or customer.` };
  const label = q.quote_number ?? "the estimate";

  const { data: onJob, error: onErr } = await m.supabase
    .from("job_circuits")
    .select("source_quote_id, source_row, removed_at, sort_order")
    .eq("job_id", jobId)
    .eq("org_id", m.orgId);
  if (onErr) return fail(onErr, "The circuits couldn't load.");
  const existing = (onJob ?? []) as Pick<JobCircuit, "source_quote_id" | "source_row" | "removed_at" | "sort_order">[];
  const nextSort = existing.reduce((mx, r) => Math.max(mx, Number(r.sort_order ?? 0)), -1) + 1;
  const drafts = quoteCircuitsToSuggestions({ id: q.id, quote_number: q.quote_number, circuits: q.circuits }, nextSort);
  if (!drafts.length) return { ok: false, error: `${label} has no circuits to bring in.` };
  const { fresh, already, setAside } = newSuggestionsOnly(drafts, existing.filter((e) => e.source_quote_id === q.id));
  if (!fresh.length) {
    return {
      ok: true,
      rows: [],
      added: 0,
      already,
      setAside,
      message: `Nothing new: all ${drafts.length} from ${label} are already here${setAside ? ` (${setAside} set aside with Not This)` : ""}.`,
    };
  }
  const { data, error } = await m.supabase
    .from("job_circuits")
    .insert(fresh.map((d) => ({ ...d, job_id: jobId })))
    .select(CIRCUIT_COLS);
  if (error) {
    // Two taps racing: the unique index held, so nothing doubled. Say so rather than a raw error.
    if (/job_circuits_one_per_source_row/.test(String(error.message))) {
      return { ok: false, error: `Those circuits from ${label} were just brought in. Reload to see them.` };
    }
    return fail(error, "The circuits didn't come in.");
  }
  const rows = (data ?? []) as JobCircuit[];
  if (rows.length !== fresh.length) {
    return { ok: false, error: `Only ${rows.length} of ${fresh.length} came in. Reload and try again; nothing comes in twice.` };
  }
  touched(jobId);
  const more = already ? ` ${countWord(already)} ${already === 1 ? "was" : "were"} already here.` : "";
  return {
    ok: true,
    rows,
    added: rows.length,
    already,
    setAside,
    message: `Brought in ${rows.length} from ${label} as suggestions. Nothing counts until you keep it.${more}`,
  };
}
