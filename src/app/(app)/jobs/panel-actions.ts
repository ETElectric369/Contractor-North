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
  circuitName,
  countWord,
  newSuggestionsOnly,
  nextProgress,
  offerEstimates,
  quoteCircuitsToSuggestions,
  type EstimateOffer,
} from "@/lib/panel/model";
import { CIRCUIT_FIELDS, PANEL_FIELDS, isUuid, normalizeCircuitPatch, normalizePanelPatch, type CircuitPatch } from "@/lib/panel/input";
import { decodeBreaker, decodeCode } from "@/lib/panel/breaker-catalog";
import { lineKey, type BreakerLine, type ListLine, type ShelfLine } from "@/lib/panel/breakers";
import { normalisePartNumber } from "@/lib/shelf-plan";
import { formatCurrency } from "@/lib/utils";
import { addMaterialItem, deleteMaterialItem, ensureJobMaterialList } from "@/app/(app)/materials/actions";
import type { CircuitKind, CircuitProgress, JobCircuit, JobPanel, QuoteCircuit, SpaceHalf } from "@/lib/types";

/**
 * THE PANEL TAB'S SERVER DOORS (Panel plan, phases 1-2; migration 0333).
 *
 * WHO: Erik's decision 1 (2026-09-25, "go for all"). The crew and the office share every circuit
 * door — add, relabel, set the space, Planned / Roughed / Done, Verified On Site, Take Off with Undo,
 * Keep / Not This — because the crew are the ones standing at the panel and nothing here carries a
 * price. Only the office brings circuits in from an estimate (requireStaff, re-checked here, and the
 * database refuses source 'estimate' from anyone else). Taking a panel off a job is the office's in
 * the database too, but it has no door yet: it comes with the phase that moves its circuits.
 *
 * HOW: every write names a row of the caller's own org, whitelists its fields (lib/panel/input),
 * and reads back what it wrote — a zero-row update is a 204, not a save (the silent-write law). The
 * row that comes back is what the tab shows, so the screen is the database's answer, not a guess.
 * A field edit names what the editor SAW (`seen`): if a crewmate changed that field in between,
 * nothing is overwritten, and the answer says who changed it and carries the row as it is now.
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
/** A refused edit may carry the row as it is now (someone changed it first), so the screen can show it. */
type RowResult<T> = { ok: true; row: T } | (Fail & { current?: T });

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

/** The job's one live panel, or null when it has none or several (then a person picks). */
async function onlyPanelOf(m: Member, jobId: string): Promise<string | null> {
  const { data } = await m.supabase.from("job_panels").select("id").eq("job_id", jobId).eq("org_id", m.orgId).is("removed_at", null).limit(2);
  const ids = ((data ?? []) as { id: string }[]).map((r) => r.id);
  return ids.length === 1 ? ids[0] : null;
}

/**
 * WHAT THE EDITOR SAW, AS A CONDITION ON THE WRITE. Each field the edit changes must still hold the
 * value the editor was looking at; a crewmate's newer value is never overwritten without a word.
 * Only the fields a person edits can be named (a condition on anything else is dropped).
 */
function matchSeen<Q>(q: Q, seen: Record<string, unknown> | undefined, allowed: readonly string[]): Q {
  let out = q as any;
  for (const [k, v] of Object.entries(seen ?? {})) {
    if (!allowed.includes(k)) continue;
    if (v == null) out = out.is(k, null);
    else if (Array.isArray(v)) out = out.eq(k, `{${v.map(Number).filter(Number.isFinite).join(",")}}`);
    else out = out.eq(k, v);
  }
  return out as Q;
}

async function nameOf(m: Member, id: string | null): Promise<string> {
  if (!id) return "Someone";
  if (id === m.userId) return "You";
  const { data } = await m.supabase.from("profiles").select("full_name").eq("id", id).maybeSingle();
  return (data as { full_name?: string | null } | null)?.full_name?.trim() || "Someone";
}

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

export type PanelEstimate = EstimateOffer;
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
  const estimates = m.staff ? await findEstimates(m, job, circuits) : [];

  const ids = [...new Set(circuits.flatMap((c) => [c.verified_by, c.updated_by]).filter(Boolean))] as string[];
  // The viewer rides along, so a mark they make now ("Verified On Site By Brian") has its name.
  const people: Record<string, string> = { [m.userId]: m.name };
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

/** The office's bar: this job's own estimates, then the same customer's with no job yet (never a
 *  declined one), each with what Bring In would still bring. A copy of an estimate whose rows are
 *  already here offers nothing (offerEstimates). */
async function findEstimates(
  m: Member,
  job: JobRow,
  circuits: Pick<JobCircuit, "source_quote_id" | "source_row" | "removed_at">[],
): Promise<PanelEstimate[]> {
  let q = m.supabase
    .from("quotes")
    .select("id, quote_number, job_id, customer_id, circuits, address, created_at, status")
    .eq("org_id", m.orgId)
    .not("circuits", "is", null)
    .neq("status", "declined");
  q = job.customer_id ? q.or(`job_id.eq.${job.id},and(job_id.is.null,customer_id.eq.${job.customer_id})`) : q.eq("job_id", job.id);
  const { data: qs, error: qErr } = await q.order("created_at", { ascending: false }).limit(20);
  if (qErr) reportError("panel.findEstimates", qErr, { jobId: job.id });
  return offerEstimates(job.id, job.customer_id, (qs ?? []) as never, circuits);
}

// ── the panel ───────────────────────────────────────────────────────────────────────────────────

export type PanelSaveResult =
  | { ok: true; row: JobPanel; adopted: JobCircuit[]; notAdopted: string[] }
  | (Fail & { current?: JobPanel });

/**
 * Add The Panel (panelId null) or change one of its fields. The crew and the office alike. `seen`
 * is what the editor was looking at for the fields it changes (see matchSeen).
 *
 * THE FIRST PANEL TAKES THE CIRCUITS ALREADY ON THE LIST. Circuits listed before anyone looked in
 * the box (Bring In, Keep All, Add A Circuit, then Add The Panel: J-011's planned order) have no
 * panel. With one panel on the job there is no picker to attach them, so the job's only panel
 * adopts them here, and from then on the door shows them and the No Stab refusal covers them. One
 * the database won't place (a kept circuit on a space this panel marks No Stab) stays panel-less,
 * and is named, never dropped.
 */
export async function savePanel(
  jobId: string,
  panelId: string | null,
  patch: Record<string, unknown>,
  seen?: Record<string, unknown>,
): Promise<PanelSaveResult> {
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
    ? matchSeen(m.supabase.from("job_panels").update(v.value).eq("id", panelId).eq("job_id", jobId).eq("org_id", m.orgId).is("removed_at", null), seen, PANEL_FIELDS)
    : m.supabase.from("job_panels").insert({ job_id: jobId, ...v.value });
  const { data, error } = await q.select(PANEL_COLS).maybeSingle();
  if (error) return fail(error, "The panel didn't save.");
  if (!data) {
    if (panelId && seen && Object.keys(seen).length) {
      const { data: now } = await m.supabase.from("job_panels").select(PANEL_COLS).eq("id", panelId).eq("org_id", m.orgId).is("removed_at", null).maybeSingle();
      if (now) {
        const who = await nameOf(m, (now as JobPanel).updated_by);
        return { ok: false, error: `${who} just changed this panel. It shows what's there now; change it again if it still needs it.`, current: now as JobPanel };
      }
    }
    return { ok: false, error: "The panel didn't save. It may have been taken off this job. Reload and try again." };
  }
  const row = data as JobPanel;
  let adopted: JobCircuit[] = [];
  const notAdopted: string[] = [];
  if (!panelId && (await onlyPanelOf(m, jobId)) === row.id) {
    const loose = m.supabase.from("job_circuits").update({ panel_id: row.id }).eq("job_id", jobId).eq("org_id", m.orgId).is("panel_id", null);
    const all = await loose.select(CIRCUIT_COLS);
    if (!all.error) {
      adopted = (all.data ?? []) as JobCircuit[];
    } else {
      // One of them sits on a space this panel marks No Stab (or past its end): place the rest.
      const { data: each } = await m.supabase.from("job_circuits").select("id, room, description, panel_label, amps, poles").eq("job_id", jobId).eq("org_id", m.orgId).is("panel_id", null);
      for (const c of (each ?? []) as Pick<JobCircuit, "id" | "room" | "description" | "panel_label" | "amps" | "poles">[]) {
        const one = await m.supabase.from("job_circuits").update({ panel_id: row.id }).eq("id", c.id).eq("org_id", m.orgId).is("panel_id", null).select(CIRCUIT_COLS).maybeSingle();
        if (one.data) adopted.push(one.data as JobCircuit);
        else notAdopted.push(`${circuitName(c)}: ${one.error ? dbError(one.error) : "it changed while the panel was added."}`);
      }
    }
  }
  touched(jobId);
  ringIfCrew(m, jobId);
  return { ok: true, row, adopted, notAdopted };
}

// ── circuits ────────────────────────────────────────────────────────────────────────────────────

/** Add A Circuit: a person typed it, so it counts at once (kept, source hand). */
export async function addCircuit(jobId: string, input: Record<string, unknown>): Promise<RowResult<JobCircuit>> {
  const m = await member();
  if ("error" in m) return m;
  const v = normalizeCircuitPatch(input);
  if (!v.ok) return v;
  if (!(await jobOf(m, jobId))) return { ok: false, error: "That job isn't in your book." };
  // No panel named and the job has exactly one: it goes on that one (nothing else would attach it).
  if (v.value.panel_id == null) v.value.panel_id = await onlyPanelOf(m, jobId);
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

async function writeCircuit(
  m: Member,
  id: string,
  fields: Record<string, unknown>,
  guard?: (q: any) => any,
  seen?: Record<string, unknown>,
): Promise<RowResult<JobCircuit>> {
  if (!isUuid(id)) return { ok: false, error: "That circuit isn't on this job." };
  let q = matchSeen(m.supabase.from("job_circuits").update(fields).eq("id", id).eq("org_id", m.orgId), seen, CIRCUIT_FIELDS);
  if (guard) q = guard(q);
  const { data, error } = await q.select(CIRCUIT_COLS).maybeSingle();
  if (error) return fail(error, "The circuit didn't save.");
  if (!data) {
    if (seen && Object.keys(seen).length) {
      const now = await circuitOf(m, id);
      if (now) {
        const who = await nameOf(m, now.updated_by);
        return { ok: false, error: `${who} just changed ${circuitName(now)}. It shows what's there now; change it again if it still needs it.`, current: now };
      }
    }
    return { ok: false, error: "That circuit changed or went away while you were on it. Reload and try again." };
  }
  const row = data as JobCircuit;
  touched(row.job_id);
  ringIfCrew(m, row.job_id);
  return { ok: true, row };
}

/**
 * One field (or a few) saved as it changes. `seen` is what the editor was looking at for those
 * fields: a crewmate's newer value is never overwritten silently (the answer carries it instead).
 * A space set on a circuit with no panel lands on the job's panel when the job has exactly one.
 */
export async function saveCircuit(circuitId: string, patch: Record<string, unknown>, seen?: Record<string, unknown>): Promise<RowResult<JobCircuit>> {
  const m = await member();
  if ("error" in m) return m;
  const v = normalizeCircuitPatch(patch);
  if (!v.ok) return v;
  if (!Object.keys(v.value).length) return { ok: false, error: "Nothing to save." };
  if (v.value.space != null && !("panel_id" in v.value)) {
    const c = await circuitOf(m, circuitId);
    if (c && c.panel_id == null) {
      const only = await onlyPanelOf(m, c.job_id);
      if (only) v.value.panel_id = only;
    }
  }
  return writeCircuit(m, circuitId, v.value, undefined, seen);
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
    const who = await nameOf(m, now.updated_by);
    return { ok: false, error: `${who} just changed this one. It's ${words} now.`, current: now };
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

/**
 * Set aside (aside=true) or put back a batch of suggestions: Bring In's Undo, and the Undo of that.
 * Only suggestions, only this job's; a set-aside suggestion keeps its place in Bring In's memory.
 */
export async function setAsideSuggestions(jobId: string, ids: string[], aside = true): Promise<{ ok: true; rows: JobCircuit[] } | Fail> {
  const m = await member();
  if ("error" in m) return m;
  const want = [...new Set((ids ?? []).filter(isUuid))];
  if (!want.length) return { ok: false, error: "Nothing to set aside." };
  if (!(await jobOf(m, jobId))) return { ok: false, error: "That job isn't in your book." };
  let q = m.supabase
    .from("job_circuits")
    .update({ removed_at: aside ? new Date().toISOString() : null })
    .in("id", want)
    .eq("job_id", jobId)
    .eq("org_id", m.orgId)
    .eq("state", "suggested");
  q = aside ? q.is("removed_at", null) : q.not("removed_at", "is", null);
  const { data, error } = await q.select(CIRCUIT_COLS);
  if (error) return fail(error, aside ? "They weren't set aside." : "They weren't put back.");
  const rows = (data ?? []) as JobCircuit[];
  if (!rows.length) return { ok: false, error: aside ? "Those were already kept or set aside." : "Those were already back." };
  touched(jobId);
  ringIfCrew(m, jobId);
  return { ok: true, rows };
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
  | { ok: true; rows: JobCircuit[]; added: number; already: number; setAside: number; message: string; estimates: PanelEstimate[] }
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
  // Every circuit on the job, not only this estimate's: a row already here from a copy or an
  // earlier version of the estimate is not brought in twice.
  const { fresh, already, setAside, elsewhere, elsewhereFrom } = newSuggestionsOnly(drafts, existing);
  const fromElsewhere = elsewhere ? ` ${countWord(elsewhere)} ${elsewhere === 1 ? "is" : "are"} already here from ${elsewhereFrom ?? "another estimate"}.` : "";
  if (!fresh.length) {
    return {
      ok: true,
      rows: [],
      added: 0,
      already,
      setAside,
      message: `Nothing new: all ${drafts.length} from ${label} are already here${setAside ? ` (${setAside} set aside with Not This)` : ""}.${fromElsewhere}`,
      estimates: await findEstimates(m, job, existing),
    };
  }
  // With one panel on the job, the suggestions land on it (nothing else would attach them).
  const panelId = await onlyPanelOf(m, jobId);
  const { data, error } = await m.supabase
    .from("job_circuits")
    .insert(fresh.map((d) => ({ ...d, job_id: jobId, panel_id: panelId })))
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
    message: `Brought in ${rows.length} from ${label} as suggestions. Nothing counts until you keep it.${more}${fromElsewhere}`,
    estimates: await findEstimates(m, job, [...existing, ...rows]),
  };
}

// ── the breakers (phase 3; migration 0334) ──────────────────────────────────────────────────────

export type OfficeTicketLine = {
  /** The card group this line counts toward (lib/panel/breakers lineKey), or null if unreadable. */
  key: string | null;
  description: string;
  qty: number;
  bill_number: string | null;
  supplier: string | null;
  bill_date: string | null;
  /** What one cost on this ticket: the line's amount over its quantity (the extension is the
   *  price), or null when the line has no quantity to divide by. */
  each: number | null;
};
export type BookPrice = { id: string; code: string; buy_price: number };
export type BreakersLoad =
  | {
      ok: true;
      staff: boolean;
      /** False while 0334 isn't on the database: the card says the tickets can't be read yet. */
      ticketsReady: boolean;
      bought: BreakerLine[];
      list: ListLine[];
      listId: string | null;
      shelf: ShelfLine[];
      /** The office only (never serialised to a tech): which tickets, what they cost, the book. */
      office: { tickets: OfficeTicketLine[]; prices: BookPrice[] } | null;
    }
  | Fail;

const fnMissing = (e: { code?: string; message?: string } | null | undefined) =>
  !!e && (e.code === "PGRST202" || e.code === "42883" || /could not find the function|function .* does not exist/i.test(String(e.message ?? "")));

/**
 * What the Breakers card counts from. THE SAME HAVE FOR EVERYONE: the tickets are read through
 * breakers_bought_for_job (0334), which a tech may call and which carries no price, so the crew's
 * card and the office's card count the same breakers. The materials list is the job's one list (the
 * newest, as every reader picks it) and the shelf is shelf_for_crew (names and counts, no cost).
 * The office's session then adds, from its own RLS, which tickets they came on and the price book.
 */
export async function loadPanelBreakers(jobId: string): Promise<BreakersLoad> {
  const m = await member();
  if ("error" in m) return m;
  if (!(await jobOf(m, jobId))) return { ok: false, error: "That job isn't in your book." };

  const [boughtRes, listRes, shelfRes] = await Promise.all([
    m.supabase.rpc("breakers_bought_for_job", { p_job: jobId }),
    m.supabase
      .from("material_lists")
      .select("id")
      .eq("job_id", jobId)
      .eq("org_id", m.orgId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(1)
      .maybeSingle(),
    m.supabase.rpc("shelf_for_crew"),
  ]);
  const ticketsReady = !fnMissing(boughtRes.error);
  if (boughtRes.error && ticketsReady) return fail(boughtRes.error, "The job's tickets couldn't be read.");
  const bought: BreakerLine[] = ((boughtRes.data ?? []) as { description: string; qty: number | string }[]).map((r) => ({
    description: r.description,
    qty: Number(r.qty),
  }));

  const listId = (listRes.data as { id?: string } | null)?.id ?? null;
  let list: ListLine[] = [];
  if (listId) {
    const { data: items, error: iErr } = await m.supabase
      .from("material_list_items")
      .select("description, part_number, quantity, purchased")
      .eq("list_id", listId)
      .eq("org_id", m.orgId)
      .order("sort_order");
    if (iErr) reportError("panel.loadPanelBreakers.list", iErr, { jobId });
    list = ((items ?? []) as { description: string; part_number: string | null; quantity: number | string; purchased: boolean | null }[])
      .map((i) => ({ description: i.description, part_number: i.part_number, qty: Number(i.quantity), purchased: !!i.purchased }))
      .filter((i) => decodeBreaker(i.part_number, i.description).kind !== "not_breaker");
  }
  if (shelfRes.error && !fnMissing(shelfRes.error)) reportError("panel.loadPanelBreakers.shelf", shelfRes.error, { jobId });
  const shelf: ShelfLine[] = ((shelfRes.data ?? []) as { name: string; on_hand: number | string | null }[])
    .map((s) => ({ name: s.name, on_hand: Number(s.on_hand ?? 0) }))
    .filter((s) => s.on_hand > 0 && decodeBreaker(s.name).kind === "breaker");

  // THE OFFICE'S HALF. Staff-only reads (bills and the book are money); a tech's load never runs it.
  const office = m.staff ? await officeBreakerExtras(m, jobId) : null;
  return { ok: true, staff: m.staff, ticketsReady, bought, list, listId, shelf, office };
}

async function officeBreakerExtras(m: Member, jobId: string): Promise<{ tickets: OfficeTicketLine[]; prices: BookPrice[] }> {
  const tickets: OfficeTicketLine[] = [];
  const { data: bills, error: bErr } = await m.supabase
    .from("bills")
    .select("id, bill_number, supplier, bill_date, status, is_statement, on_shelf")
    .eq("job_id", jobId)
    .eq("org_id", m.orgId)
    .is("superseded_by_bill_id", null);
  if (bErr) reportError("panel.officeBreakerExtras.bills", bErr, { jobId });
  // The same tickets 0334 counts: not replaced, not a statement, not a shelf ticket, not void.
  type BillRow = { id: string; bill_number: string | null; supplier: string | null; bill_date: string | null; status: string | null; is_statement: boolean | null; on_shelf: boolean | null };
  const live = ((bills ?? []) as BillRow[]).filter((b) => !b.is_statement && !b.on_shelf && b.status !== "void");
  if (live.length) {
    const { data: lines, error: lErr } = await m.supabase
      .from("bill_line_items")
      .select("bill_id, description, quantity, amount, is_stock")
      .in(
        "bill_id",
        live.map((b) => b.id),
      )
      .eq("org_id", m.orgId);
    if (lErr) reportError("panel.officeBreakerExtras.lines", lErr, { jobId });
    const byId = new Map(live.map((b) => [b.id, b]));
    type LineRow = { bill_id: string; description: string | null; quantity: number | string | null; amount: number | string | null; is_stock: boolean | null };
    for (const l of (lines ?? []) as LineRow[]) {
      if (l.is_stock || !l.description) continue;
      if (decodeBreaker(l.description).kind === "not_breaker") continue;
      const b = byId.get(l.bill_id)!;
      const qty = Number(l.quantity ?? 0);
      const amount = Number(l.amount ?? 0);
      tickets.push({
        key: lineKey(l.description),
        description: l.description,
        qty,
        bill_number: b.bill_number,
        supplier: b.supplier,
        bill_date: b.bill_date,
        each: qty > 0 && Number.isFinite(amount) ? Math.round((amount / qty) * 100) / 100 : null,
      });
    }
  }
  // The book's breaker rows: anything whose code reads as a breaker this app knows.
  const { data: book, error: pErr } = await m.supabase
    .from("price_list_items")
    .select("id, code, buy_price")
    .eq("org_id", m.orgId)
    .eq("archived", false)
    .or("code.ilike.Q%,code.ilike.HOM%,code.ilike.BR%,code.ilike.CH%,code.ilike.THQ%")
    .limit(2000);
  if (pErr) reportError("panel.officeBreakerExtras.book", pErr, { jobId });
  const prices: BookPrice[] = ((book ?? []) as { id: string; code: string | null; buy_price: number | string | null }[])
    .filter((r) => r.code && decodeCode(r.code)?.kind === "breaker")
    .map((r) => ({ id: r.id, code: normalisePartNumber(r.code)!, buy_price: Number(r.buy_price ?? 0) }));
  return { tickets, prices };
}

/**
 * Add To Materials (the crew and the office): the missing breaker goes on the job's ONE materials
 * list as a line to buy, with its part number, so the next count reads a code. It goes through the
 * same two doors material.addLine wraps (ensureJobMaterialList + addMaterialItem): the list is found
 * or started, a tech's line carries no money, and a crew addition rings the office.
 */
export async function addBreakerToMaterials(
  jobId: string,
  input: { part: string | null; description: string; qty: number },
): Promise<{ ok: true; id: string; listId: string; words: string } | Fail> {
  const m = await member();
  if ("error" in m) return m;
  if (!(await jobOf(m, jobId))) return { ok: false, error: "That job isn't in your book." };
  const description = String(input?.description ?? "").replace(/\s+/g, " ").trim();
  if (!description || description.length > 200) return { ok: false, error: "Say what the breaker is, in under 200 characters." };
  const qty = Number(input?.qty);
  if (!Number.isInteger(qty) || qty < 1 || qty > 99) return { ok: false, error: "The count has to be a whole number from 1 to 99." };
  const part = input?.part ? normalisePartNumber(input.part) : null;
  if (part && decodeCode(part)?.kind !== "breaker") return { ok: false, error: `${part} isn't a breaker this app can read.` };
  const list = await ensureJobMaterialList(jobId);
  if (!list.ok || !list.id) return { ok: false, error: list.error ?? "The job's materials list couldn't be opened." };
  const added = await addMaterialItem(list.id, { description, part_number: part, quantity: qty, unit: "ea", vendor: null, est_cost: null });
  if (!added.ok || !added.id) return { ok: false, error: added.error ?? "The line didn't save." };
  touched(jobId);
  revalidatePath("/materials");
  return { ok: true, id: added.id, listId: list.id, words: `${qty} x ${description}` };
}

/** The Undo of Add To Materials: that one line, by its id. */
export async function removeBreakerFromMaterials(jobId: string, itemId: string, listId: string): Promise<{ ok: true } | Fail> {
  const m = await member();
  if ("error" in m) return m;
  if (!isUuid(itemId) || !isUuid(listId)) return { ok: false, error: "That line isn't on this job's list." };
  const r = await deleteMaterialItem(itemId, listId);
  if (!r.ok) return { ok: false, error: r.error ?? "The line didn't come off." };
  touched(jobId);
  return { ok: true };
}

const BRAND_WORDS: Record<string, string> = {
  siemens: "Siemens",
  square_d_homeline: "Square D Homeline",
  square_d_qo: "Square D QO",
  eaton_br: "Eaton BR",
  eaton_ch: "Eaton CH",
  ge: "GE",
};

/**
 * Add To Price Book (the office only, never silent): a breaker code the tickets or the card name
 * that the book doesn't have yet (Q115, Q2020, Q21530CT, Q22020CT on ET's book). The person sees and
 * can change the cost before it is written; the ticket's each-price is only what the box starts at.
 */
export async function addBreakerToPriceBook(input: {
  code: string;
  buy_price: number;
  supplier: string | null;
}): Promise<{ ok: true; row: BookPrice; words: string } | Fail> {
  const m = await office();
  if ("error" in m) return m;
  const code = normalisePartNumber(input?.code);
  const d = code ? decodeCode(code) : null;
  if (!code || d?.kind !== "breaker") return { ok: false, error: "That isn't a breaker part number this app can read." };
  const price = Number(input?.buy_price);
  if (!Number.isFinite(price) || price <= 0 || price > 100000) return { ok: false, error: "Put in what one costs, more than $0." };
  const supplier = input?.supplier ? String(input.supplier).replace(/\s+/g, " ").trim().slice(0, 120) || null : null;

  const { data: same } = await m.supabase
    .from("price_list_items")
    .select("id, code, buy_price")
    .eq("org_id", m.orgId)
    .eq("archived", false)
    .ilike("code", `${code.slice(0, 2)}%`)
    .limit(1000);
  const dup = ((same ?? []) as { id: string; code: string | null; buy_price: number | string | null }[]).find((r) => normalisePartNumber(r.code) === code);
  if (dup) return { ok: false, error: `${code} is already in your price book at ${formatCurrency(Number(dup.buy_price ?? 0))}.` };

  const description = `${d.brand ? `${BRAND_WORDS[d.brand]} ` : ""}${code} ${d.words} Breaker`;
  const { data, error } = await m.supabase
    .from("price_list_items")
    .insert({ code, description, category: null, supplier, unit: "ea", buy_price: Math.round(price * 100) / 100, markup_pct: 0 })
    .select("id, code, buy_price")
    .maybeSingle();
  if (error) return { ok: false, error: dbError(error) };
  if (!data) return { ok: false, error: "Nothing was saved. Try again." };
  revalidatePath("/price-list");
  const row = { id: (data as { id: string }).id, code, buy_price: Number((data as { buy_price: number | string }).buy_price) };
  return { ok: true, row, words: `Added ${code} to your price book at ${formatCurrency(row.buy_price)}.` };
}

/** The Undo of Add To Price Book: the row leaves the book (archived, the book's own Undo). */
export async function takeBreakerOutOfPriceBook(id: string): Promise<{ ok: true } | Fail> {
  const m = await office();
  if ("error" in m) return m;
  if (!isUuid(id)) return { ok: false, error: "That item isn't in your book." };
  const { data, error } = await m.supabase.from("price_list_items").update({ archived: true }).eq("id", id).eq("org_id", m.orgId).eq("archived", false).select("id");
  if (error) return { ok: false, error: dbError(error) };
  if (!data?.length) return { ok: false, error: "It was already out of the book." };
  revalidatePath("/price-list");
  return { ok: true };
}

export type PlaceInput = {
  /** An unplaced kept circuit this pole group is, or null for a new circuit. */
  circuit_id: string | null;
  space: number;
  half: SpaceHalf | null;
  poles: number;
  amps: number;
  kind: CircuitKind | null;
  room?: string | null;
  description?: string | null;
};
export type PlaceResult =
  | { ok: true; rows: JobCircuit[]; moved: { id: string; space: number }[]; added: string[]; problems: string[] }
  | Fail;

/**
 * Place From What Was Bought (the crew and the office): a bought breaker goes in at a space, and each
 * of its pole groups becomes a circuit on the panel. A person has already picked, part by part,
 * which circuit on the list it is (or A New Circuit), and tapped to confirm; this writes exactly
 * that. An existing circuit only moves if it still has no space and is still that size, so a
 * crewmate's placement in the same minute is never overwritten. The No Stab refusal is the
 * database's; anything it refuses is named, never dropped.
 */
export async function placeBoughtBreaker(jobId: string, panelId: string, parts: PlaceInput[]): Promise<PlaceResult> {
  const m = await member();
  if ("error" in m) return m;
  if (!(await jobOf(m, jobId))) return { ok: false, error: "That job isn't in your book." };
  if (!isUuid(panelId)) return { ok: false, error: "Pick the panel it goes in." };
  const { data: panel } = await m.supabase.from("job_panels").select("id").eq("id", panelId).eq("job_id", jobId).eq("org_id", m.orgId).is("removed_at", null).maybeSingle();
  if (!panel) return { ok: false, error: "That panel isn't on this job." };
  if (!Array.isArray(parts) || parts.length < 1 || parts.length > 3) return { ok: false, error: "A breaker is one to three circuits." };
  const ids = parts.map((p) => p?.circuit_id).filter(Boolean) as string[];
  if (new Set(ids).size !== ids.length) return { ok: false, error: "Each part of the breaker has to be a different circuit." };

  const clean: { p: PlaceInput; v: CircuitPatch }[] = [];
  for (const p of parts) {
    if (p?.circuit_id != null && !isUuid(p.circuit_id)) return { ok: false, error: "That circuit isn't on this job." };
    const v = normalizeCircuitPatch({
      space: p.space,
      half: p.half,
      poles: p.poles,
      amps: p.amps,
      kind: p.kind ?? null,
      ...(p.circuit_id ? {} : { room: p.room ?? null, description: p.description ?? null }),
    });
    if (!v.ok) return v;
    if (v.value.space == null || v.value.amps == null) return { ok: false, error: "Each part needs its space and amps." };
    clean.push({ p, v: v.value });
  }

  const rows: JobCircuit[] = [];
  const moved: { id: string; space: number }[] = [];
  const problems: string[] = [];
  for (const { p, v } of clean) {
    if (!p.circuit_id) continue;
    let q = m.supabase
      .from("job_circuits")
      .update({ panel_id: panelId, space: v.space, half: v.half ?? null })
      .eq("id", p.circuit_id)
      .eq("job_id", jobId)
      .eq("org_id", m.orgId)
      .eq("state", "kept")
      .is("removed_at", null)
      .is("space", null)
      .eq("poles", v.poles!)
      .eq("amps", v.amps!);
    q = v.kind && v.kind !== "standard" ? q.eq("kind", v.kind) : q.or("kind.is.null,kind.eq.standard");
    const { data, error } = await q.select(CIRCUIT_COLS).maybeSingle();
    const name = `Space ${v.space}${v.half ?? ""}`;
    if (error) problems.push(`${name}: ${dbError(error)}`);
    else if (!data) problems.push(`${name}: that circuit was placed or changed by someone else first.`);
    else {
      rows.push(data as JobCircuit);
      moved.push({ id: (data as JobCircuit).id, space: v.space! });
    }
  }
  const fresh = clean.filter(({ p }) => !p.circuit_id);
  const added: string[] = [];
  if (fresh.length) {
    const { data: last } = await m.supabase
      .from("job_circuits")
      .select("sort_order")
      .eq("job_id", jobId)
      .eq("org_id", m.orgId)
      .order("sort_order", { ascending: false })
      .limit(1)
      .maybeSingle();
    let sort = Number((last as { sort_order?: number } | null)?.sort_order ?? -1) + 1;
    const { data, error } = await m.supabase
      .from("job_circuits")
      .insert(fresh.map(({ v }) => ({ job_id: jobId, panel_id: panelId, ...v, work: "new", state: "kept", source: "hand", sort_order: sort++ })))
      .select(CIRCUIT_COLS);
    if (error) problems.push(`The new ${fresh.length === 1 ? "circuit" : "circuits"}: ${dbError(error)}`);
    else if ((data ?? []).length !== fresh.length) problems.push(`Only ${(data ?? []).length} of ${fresh.length} new circuits saved. Reload and check.`);
    for (const r of (data ?? []) as JobCircuit[]) {
      rows.push(r);
      added.push(r.id);
    }
  }
  if (!rows.length) return { ok: false, error: problems.join(" ") || "Nothing was placed." };
  touched(jobId);
  ringIfCrew(m, jobId);
  return { ok: true, rows, moved, added, problems };
}
