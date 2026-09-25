import { z } from "zod";
import { revalidatePath } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { dbError } from "@/lib/db-error";
import { jobLabel } from "@/lib/schedule-options";
import { normalizeCircuitPatch } from "@/lib/panel/input";
import { circuitLine } from "@/lib/panel/model";
import { NORT_SAYS, readerSuggestions, type ReadRow } from "@/lib/panel/readers";
import { writeSuggestions } from "@/lib/panel/suggest-write";
import type { JobCircuit } from "@/lib/types";
import { isUuid, resolveJobId } from "../resolve-id";
import type { ActionCtx, ActionDef, ActionResult } from "../types";

// NORT FILLS, A PERSON SAVES (the fill-vs-execute doctrine; Panel plan, phase 4).
//
// Erik: "add a 20 amp for the garage freezer". Nort puts it on the job's Panel tab as a SUGGESTION,
// dimmed and marked From Nort, and it counts for nothing (not in the pole count, not on the door)
// until a person taps Keep. There is no keep verb for the agent, on purpose: the only thing Nort can
// do to the circuit list is suggest. The database says the same (0333's guard lands every
// non-hand circuit as a suggestion, whatever the request said).
//
// The same matching every reader uses (lib/panel/readers): a circuit already on the list is said,
// not added twice; one that matches a listed circuit but differs becomes a label check a person
// uses or sets aside. Open to every role: the crew edits circuits in full (Erik's decision 1), so
// suggesting one is no more than they can already do by hand.

const CIRCUIT = z.object({
  description: z.string().trim().max(200).nullable().optional(),
  panel_label: z.string().trim().max(120).nullable().optional(),
  room: z.string().trim().max(80).nullable().optional(),
  amps: z.number().int().nullable().optional(),
  poles: z.number().int().min(1).max(3).optional(),
  kind: z.enum(["standard", "afci", "gfci", "dual_function", "spd"]).nullable().optional(),
  wire: z.string().trim().max(40).nullable().optional(),
  space: z.number().int().min(1).max(84).nullable().optional(),
  half: z.enum(["A", "B"]).nullable().optional(),
  work: z.enum(["new", "existing", "reused", "removed"]).optional(),
});

const COLS =
  "id, org_id, job_id, panel_id, room, description, panel_label, amps, poles, kind, wire, wire_tag, space, half, work, progress, state, source, source_quote_id, source_document_id, source_row, verified, verified_by, verified_at, sort_order, created_by, created_at, updated_by, updated_at, removed_at, removed_by";

const jobWords = (ref: string) => (isUuid(ref) ? "that job" : `the ${ref.trim()} job`);

export const panelActions: Record<string, ActionDef> = {
  "panel.suggest": {
    name: "panel.suggest",
    group: "panel",
    label: "Suggest circuits on a job's panel",
    description:
      "Put one or more circuits on a job's Panel tab as SUGGESTIONS ('add a 20 amp for the garage freezer on Herringbone', 'the dryer is a 2-pole 30 on space 21'). A suggestion counts for nothing until a person taps Keep on the Panel tab: say exactly that, and NEVER say the circuit is added, kept, placed or counted. " +
      "job_id is the job's id from list_jobs OR its name / number as spoken ('Herringbone', 'J-011'). One object per circuit: description = what it feeds ('Freezer'), room ('Garage'), amps (15, 20, 30…), poles (1-3, default 1), kind (standard / afci / gfci / dual_function / spd, only when said), panel_label = the door's words only when said, space / half only when said, work = new (default) / existing / reused / removed. " +
      "Pass only what was said; never invent amps or a space. Read the panel first with get_job_panel when you need to know what is already there: a circuit already on the list is reported back, not added twice.",
    input: z.object({
      job_id: z.string().min(1),
      circuits: z.array(CIRCUIT).min(1).max(24),
    }),
    auth: "any",
    effect: "write",
    describe: (i) => `Suggest ${i.circuits.length === 1 ? "a circuit" : `${i.circuits.length} circuits`} on ${jobWords(i.job_id)}'s Panel tab, for a person to keep.`,
    handler: async (i, ctx: ActionCtx): Promise<ActionResult> => {
      if (!ctx.orgId) return { ok: false, error: "Your account isn't in a company yet." };
      const supabase = (await createClient()) as unknown as SupabaseClient;
      const r = await resolveJobId(supabase as never, i.job_id);
      if ("error" in r) return { ok: false, error: r.error };
      if (!r.id) return { ok: false, error: "Which job? Pass the job's name, number, or id." };
      const { data: job } = await supabase.from("jobs").select("id, job_number, name").eq("id", r.id).eq("org_id", ctx.orgId).maybeSingle();
      if (!job) return { ok: false, error: "Job not found (or not one you can see)." };
      const label = jobLabel(job as { job_number: string | null; name: string | null });

      // Each circuit through the same checks a person's edit goes through (sizes, spaces, words).
      const rows: ReadRow[] = [];
      for (const [n, c] of i.circuits.entries()) {
        const v = normalizeCircuitPatch({
          description: c.description ?? null,
          panel_label: c.panel_label ?? null,
          room: c.room ?? null,
          amps: c.amps ?? null,
          poles: c.poles ?? 1,
          kind: c.kind ?? null,
          wire: c.wire ?? null,
          space: c.space ?? null,
          half: c.half ?? null,
          work: c.work ?? "new",
        });
        if (!v.ok) return { ok: false, error: `Circuit ${n + 1}: ${v.error}` };
        const p = v.value;
        const said = p.description ?? p.panel_label ?? null;
        if (!said && p.amps == null) return { ok: false, error: `Circuit ${n + 1}: say what it feeds or its size.` };
        rows.push({
          space: p.space ?? null,
          half: p.space != null ? (p.half ?? null) : null,
          said,
          door: p.panel_label ?? null,
          feeds: p.description ?? null,
          room: p.room ?? null,
          amps: p.amps ?? null,
          poles: p.poles ?? 1,
          kind: p.kind ?? null,
          wire: p.wire ?? null,
          work: p.work ?? "new",
          check: null,
        });
      }

      const [{ data: all, error: aErr }, { data: panels }] = await Promise.all([
        supabase.from("job_circuits").select(COLS).eq("job_id", r.id).eq("org_id", ctx.orgId),
        supabase.from("job_panels").select("id").eq("job_id", r.id).eq("org_id", ctx.orgId).is("removed_at", null).limit(2),
      ]);
      if (aErr) return { ok: false, error: /job_circuits/.test(aErr.message ?? "") ? "The Panel tab isn't switched on for this database yet." : dbError(aErr) };
      const panelIds = ((panels ?? []) as { id: string }[]).map((p) => p.id);
      const panelId = panelIds.length === 1 ? panelIds[0] : null;
      const outcome = readerSuggestions({
        source: "nort",
        rows,
        circuits: (all ?? []) as unknown as JobCircuit[],
        panelId,
        says: NORT_SAYS,
        startSort: 0,
      });
      const wrote = await writeSuggestions(supabase, { orgId: ctx.orgId, jobId: r.id, panelId, documentId: null, drafts: outcome.drafts, cols: COLS });
      if (!wrote.ok) return { ok: false, error: wrote.error };
      if (wrote.rows.length) revalidatePath(`/jobs/${r.id}`);

      const fresh = wrote.rows.filter((x) => !x.source_row?.flag_for);
      const checks = wrote.rows.filter((x) => x.source_row?.flag_for);
      const said = [
        fresh.length ? `Suggested on ${label}: ${fresh.map((x) => circuitLine(x)).join("; ")}.` : null,
        checks.length ? `${checks.length === 1 ? "A label check" : `${checks.length} label checks`}: ${checks.map((x) => x.source_row?.check).join(" ")}` : null,
        outcome.same ? `${outcome.same} ${outcome.same === 1 ? "is" : "are"} already on the list.` : null,
        outcome.already ? `${outcome.already} ${outcome.already === 1 ? "was" : "were"} already suggested.` : null,
        outcome.setAside ? `${outcome.setAside} someone already set aside with Not This (not suggested again).` : null,
      ].filter(Boolean);
      return {
        ok: true,
        data: { job_id: r.id, suggested: fresh.map((x) => x.id), label_checks: checks.map((x) => x.id), already_on_list: outcome.same },
        recorded:
          `${said.join(" ")}${wrote.rows.length ? " Nothing counts until someone taps Keep on the job's Panel tab." : ""}`.trim() ||
          "Nothing new to suggest.",
      };
    },
  },
};
