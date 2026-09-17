import { z } from "zod";
import { revalidatePath } from "next/cache";
import { dbError } from "@/lib/db-error";
import { addMaterialItem, deleteMaterialItem, ensureJobMaterialList, setMaterialItemPurchased } from "@/app/(app)/materials/actions";
import { createClient } from "@/lib/supabase/server";
import { jobLabel } from "@/lib/schedule-options";
import { isStaffRole } from "../perms";
import { isUuid, resolveJobId } from "../resolve-id";
import type { ActionCtx, ActionDef, ActionResult } from "../types";

// THE JOB'S ONE MATERIALS LIST, BY VOICE.
//
// Erik to Nort, 2026-09-16: "can you add a single gang bell box to the materials list for Jason
// Waldo job and a short and long extension bit to be purchased". Nort: "I can't add lines to a
// job's materials list — I don't have a tool for that." Erik: "No, I want you to be able to do
// everything that I can do on this app. That's kind of the whole point."
//
// Each verb here WRAPS the existing server action in materials/actions.ts — the same one the
// job tab and /materials/[id] call — so the rules that already hold there hold here without a
// second copy: one list per job (ensureJobMaterialList finds it or mints it), techs write the
// same list (auth "any"; 0254's policy is the boundary), and a tech's line never carries money
// (withoutMoney on the server, the 0254 trigger at the database). A new line is unpurchased,
// which on this list means "to be purchased".
//
// A spoken job NAME ("Waldow", "the Waldo job", "J-012") goes through resolveJobId, which
// settles on exactly one job or asks — it never guesses among several. A spoken LINE ("the bell
// box") is resolved against that job's own list the same way: exactly one match or a refusal
// that lists the candidates, because ticking or deleting the wrong line is a real error.

type Db = Awaited<ReturnType<typeof createClient>>;
type JobRow = { id: string; job_number: string | null; name: string | null };
type LineRow = {
  id: string;
  description: string;
  part_number: string | null;
  quantity: number | string | null;
  unit: string | null;
  purchased: boolean | null;
};

/** "1 ea single-gang bell box" — the way a line is read back everywhere in this file. */
function lineWords(l: { quantity?: number | string | null; unit?: string | null; description: string }): string {
  const qty = Number(l.quantity ?? 1) || 1;
  const qtyText = Number.isInteger(qty) ? String(qty) : qty.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  return `${qtyText} ${(l.unit || "ea").trim()} ${l.description.trim()}`;
}

/** Lowercase, punctuation to spaces, whitespace collapsed — so "single-gang bell box" and
 *  "Single Gang Bell Box" are the same words. */
function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Resolve whatever the model passed for the job (uuid, name, or number) to the job row
 *  itself, through the caller's RLS-scoped client — a tech only ever sees their own org's
 *  jobs, and a name that matches several jobs is an ask, never a guess. */
async function resolveJob(supabase: Db, jobRef: string | null | undefined): Promise<{ job: JobRow } | { error: string }> {
  const r = await resolveJobId(supabase, jobRef ?? null);
  if ("error" in r) return { error: r.error };
  if (!r.id) return { error: "Which job? Pass the job's name, number, or id." };
  const { data: job, error } = await supabase.from("jobs").select("id, job_number, name").eq("id", r.id).maybeSingle();
  if (error) return { error: dbError(error) };
  if (!job) return { error: "Job not found (or not one you can see)." };
  return { job: job as JobRow };
}

/** The job's ONE list — the newest one linked to the job, exactly as the job tab and
 *  ensureJobMaterialList pick it. Never mints: the read-side verbs must not create a list
 *  just to say it's empty. */
async function findJobList(supabase: Db, jobId: string): Promise<{ listId: string | null } | { error: string }> {
  const { data, error } = await supabase
    .from("material_lists")
    .select("id")
    .eq("job_id", jobId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return { error: dbError(error) };
  return { listId: (data as { id?: string } | null)?.id ?? null };
}

/** Which line did they mean? By id when one was passed (and it must be ON this list), else by
 *  a description fragment matched in tiers — exact words, then part number, then contains, then
 *  every word present — stopping at the first tier that hits. One hit settles it; several
 *  refuse with the candidates (and their ids, so the next call can be exact); none refuse with
 *  what the list actually holds, so the model can re-ask instead of re-guessing. */
async function resolveLine(
  supabase: Db,
  listId: string,
  label: string,
  ref: { item_id?: string | null; description?: string | null },
): Promise<{ line: LineRow } | { error: string }> {
  const { data, error } = await supabase
    .from("material_list_items")
    .select("id, description, part_number, quantity, unit, purchased")
    .eq("list_id", listId)
    .order("sort_order");
  if (error) return { error: dbError(error) };
  const lines = (data ?? []) as LineRow[];
  if (!lines.length) return { error: `The ${label} materials list is empty — nothing to match "${ref.description ?? ref.item_id ?? ""}".` };

  const itemId = (ref.item_id ?? "").trim();
  if (itemId) {
    if (!isUuid(itemId)) return { error: "item_id must be the line's id from list_material_items — or pass the description instead." };
    const hit = lines.find((l) => l.id === itemId);
    if (!hit) return { error: `That line isn't on the ${label} materials list. Check it with list_material_items.` };
    return { line: hit };
  }

  const frag = norm(ref.description ?? "");
  if (!frag) return { error: "Say which line — a few words of its description, or its item_id." };
  const words = frag.split(" ");
  const tiers: ((l: LineRow) => boolean)[] = [
    (l) => norm(l.description) === frag,
    (l) => !!l.part_number && norm(l.part_number) === frag,
    (l) => norm(l.description).includes(frag),
    (l) => {
      const d = ` ${norm(l.description)} `;
      return words.every((w) => d.includes(` ${w} `));
    },
  ];
  for (const match of tiers) {
    const hits = lines.filter(match);
    if (hits.length === 1) return { line: hits[0] };
    if (hits.length > 1) {
      const list = hits.map((l) => `"${lineWords(l)}" (item_id ${l.id})`).join(", ");
      return { error: `Several lines on the ${label} materials list match "${ref.description}": ${list} — which one? Pass its item_id.` };
    }
  }
  const have = lines
    .slice(0, 12)
    .map((l) => `"${lineWords(l)}"${l.purchased ? " (purchased)" : ""}`)
    .join(", ");
  return {
    error: `Nothing on the ${label} materials list matches "${ref.description}". The list has: ${have}${lines.length > 12 ? `, and ${lines.length - 12} more` : ""}.`,
  };
}

/** Find the job, then the line on its list, for the two verbs that act on an existing line. */
async function jobAndLine(
  supabase: Db,
  i: { job_id: string; item_id?: string | null; description?: string | null },
): Promise<{ job: JobRow; label: string; listId: string; line: LineRow } | { error: string }> {
  const j = await resolveJob(supabase, i.job_id);
  if ("error" in j) return j;
  const label = jobLabel(j.job);
  const list = await findJobList(supabase, j.job.id);
  if ("error" in list) return list;
  if (!list.listId) return { error: `The ${label} job has no materials list yet — add a line to start one (material.addLine).` };
  const line = await resolveLine(supabase, list.listId, label, i);
  if ("error" in line) return line;
  return { job: j.job, label, listId: list.listId, line: line.line };
}

/** The confirm read-back names the job in the words the user used — a uuid is never spoken. */
const jobWords = (jobRef: string) => (isUuid(jobRef) ? "that job's" : `the ${jobRef.trim()}`);

// One of item_id / description is required to name a line; the model is told to pass BOTH
// when it has them (item_id for exactness, description for the spoken read-back).
const LINE_REF = z.object({
  job_id: z.string().min(1),
  item_id: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
});
const requireLineRef = (v: z.infer<typeof LINE_REF>, ctx: z.RefinementCtx) => {
  if ((v.item_id ?? "").trim() || (v.description ?? "").trim()) return;
  ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["description"], message: "Say which line: a few words of its description, or its item_id." });
};

export const materialActions: Record<string, ActionDef> = {
  "material.addLine": {
    name: "material.addLine",
    group: "material",
    label: "Add materials line",
    description:
      "Add ONE line to a job's materials list (the job's one shopping/take-off list) — 'add a single-gang bell box to the Waldow materials list', 'put two short extension bits on the Miller job, to be purchased'. Pass job_id as the job's id from list_jobs, OR the job's name / number as spoken ('Waldow', 'J-012'); it resolves itself, and if several jobs match you'll be asked which — then look it up with list_jobs (search) and pass the id. One line per call: 'a bell box and two extension bits' is two calls. description is the item as a person would say it; quantity defaults to 1 and unit to 'ea' (also ft, box, roll…). part_number / vendor / est_cost / is_tool (true = a tool from the truck, not something to buy) are optional — pass them only when said. A new line is unpurchased, which means 'to be purchased'; the office is notified when a crew member adds one. Use list_material_items to read the list back.",
    input: z.object({
      job_id: z.string().min(1),
      description: z.string().trim().min(1),
      quantity: z.number().positive().optional().default(1),
      unit: z.string().trim().optional().default("ea"),
      part_number: z.string().nullable().optional(),
      vendor: z.string().nullable().optional(),
      est_cost: z.number().nullable().optional(),
      is_tool: z.boolean().optional(),
    }),
    auth: "any",
    effect: "write",
    describe: (i) => `Add ${lineWords(i)} to ${jobWords(i.job_id)} materials list.`,
    handler: async (i, ctx: ActionCtx): Promise<ActionResult> => {
      const supabase = await createClient();
      const j = await resolveJob(supabase, i.job_id);
      if ("error" in j) return { ok: false, error: j.error };
      const label = jobLabel(j.job);

      // The job's ONE list: found, or minted now (0254 lets a tech's first add mint it).
      const list = await ensureJobMaterialList(j.job.id);
      if (!list.ok || !list.id) return { ok: false, error: list.error ?? "Couldn't open that job's materials list." };

      // A tech's line carries no money (withoutMoney strips it server-side and 0254 pins it at the
      // database). Drop it HERE too so the read-back below never announces a price nobody saved.
      const staff = isStaffRole(ctx.role);
      const draft = {
        description: i.description,
        part_number: i.part_number ?? null,
        quantity: i.quantity ?? 1,
        unit: i.unit || "ea",
        vendor: staff ? (i.vendor ?? null) : null,
        est_cost: staff ? (i.est_cost ?? null) : null,
        is_tool: staff ? (i.is_tool ?? false) : false,
      };
      const added = await addMaterialItem(list.id, draft);
      if (!added.ok) return { ok: false, error: added.error ?? "Couldn't add that line." };

      // ANNOUNCE THE DEED: read back THE ROW THIS CALL MADE — by its id, which addMaterialItem
      // now hands back (audit, 2026-09-17). It used to re-find "its" line by description, newest
      // first, which is a guess dressed as an identity: two adds of the same item on one list —
      // two people at the supply house, or one man adding a second box on purpose — and the id
      // Nort reads back names the OTHER row. A later "take that one off the list" then deletes
      // the wrong line, and the confirm card, built from the same id, reads perfectly correct
      // while it does. Falling back to the description match keeps an older row answering.
      const { data: row } = added.id
        ? await supabase
            .from("material_list_items")
            .select("id, description, quantity, unit, purchased")
            .eq("id", added.id)
            .maybeSingle()
        : await supabase
            .from("material_list_items")
            .select("id, description, quantity, unit, purchased")
            .eq("list_id", list.id)
            .eq("description", i.description.trim())
            .order("sort_order", { ascending: false })
            .limit(1)
            .maybeSingle();
      revalidatePath(`/jobs/${j.job.id}`);
      revalidatePath("/materials");
      const words = row ? lineWords(row as LineRow) : lineWords(draft);
      const extras = [
        draft.part_number ? `part # ${draft.part_number}` : "",
        draft.vendor ? `from ${draft.vendor}` : "",
        draft.est_cost != null ? `est. $${Number(draft.est_cost).toFixed(2)}` : "",
        draft.is_tool ? "marked as a tool" : "",
      ].filter(Boolean);
      const droppedMoney = !staff && (i.vendor || i.est_cost != null || i.is_tool);
      return {
        ok: true,
        data: {
          job_id: j.job.id,
          list_id: list.id,
          item_id: (row as { id?: string } | null)?.id ?? null,
          description: draft.description,
          quantity: draft.quantity,
          unit: draft.unit,
          purchased: false,
        },
        recorded: `Added: ${words} to the ${label} materials list${extras.length ? ` (${extras.join(", ")})` : ""} — to be purchased.`,
        ...(droppedMoney ? { warning: "Cost, vendor and the tool flag are the office's to set — the line was added without them." } : {}),
      };
    },
  },

  "material.markPurchased": {
    name: "material.markPurchased",
    group: "material",
    label: "Mark materials line purchased",
    description:
      "Tick ONE line on a job's materials list as purchased (bought) — 'mark the bell box purchased on the Waldow job', 'I picked up the extension bits'. Pass purchased=false to un-tick it. job_id is the job's id from list_jobs OR its name / number as spoken. Name the line with description (a few words of it — it must match exactly ONE line on that job's list, or you'll be told the candidates) or with item_id from list_material_items; pass both when you have them. If you're not sure which line, read the list first with list_material_items.",
    input: LINE_REF.extend({ purchased: z.boolean().optional().default(true) }).superRefine(requireLineRef),
    auth: "any",
    effect: "write",
    describe: (i) => `Mark "${(i.description ?? "that line").trim()}" ${i.purchased === false ? "not purchased" : "purchased"} on ${jobWords(i.job_id)} materials list.`,
    handler: async (i): Promise<ActionResult> => {
      const supabase = await createClient();
      const r = await jobAndLine(supabase, i);
      if ("error" in r) return { ok: false, error: r.error };
      const want = i.purchased !== false;
      const words = lineWords(r.line);
      // Already in the asked-for state: say so and change nothing — re-stamping purchased_at
      // would quietly move the date the crew actually bought it.
      if (!!r.line.purchased === want)
        return {
          ok: true,
          data: { job_id: r.job.id, list_id: r.listId, item_id: r.line.id, purchased: want, changed: false },
          speak: `${words} on the ${r.label} list was already marked ${want ? "purchased" : "not purchased"}.`,
        };
      const res = await setMaterialItemPurchased(r.line.id, r.listId, want);
      if (!res.ok) return { ok: false, error: res.error ?? "Couldn't update that line." };
      revalidatePath(`/jobs/${r.job.id}`);
      return {
        ok: true,
        data: { job_id: r.job.id, list_id: r.listId, item_id: r.line.id, purchased: want, changed: true },
        recorded: `Marked ${want ? "purchased" : "not purchased"}: ${words} on the ${r.label} materials list.`,
      };
    },
  },

  "material.removeLine": {
    name: "material.removeLine",
    group: "material",
    label: "Remove materials line",
    description:
      "Delete ONE line from a job's materials list — 'take the bell box off the Waldow list', 'remove the extension bits'. Not for marking something bought (that's material.markPurchased). job_id is the job's id from list_jobs OR its name / number as spoken. Name the line with description (a few words — it must match exactly ONE line on that list, or you'll be told the candidates) or item_id from list_material_items; pass both when you have them. This asks the user to confirm before it deletes.",
    input: LINE_REF.superRefine(requireLineRef),
    auth: "any",
    effect: "write",
    confirm: "destructive",
    describe: (i) => `Remove "${(i.description ?? "that line").trim()}" from ${jobWords(i.job_id)} materials list — say yes to confirm.`,
    handler: async (i): Promise<ActionResult> => {
      const supabase = await createClient();
      const r = await jobAndLine(supabase, i);
      if ("error" in r) return { ok: false, error: r.error };
      const words = lineWords(r.line);
      const res = await deleteMaterialItem(r.line.id, r.listId);
      if (!res.ok) return { ok: false, error: res.error ?? "Couldn't remove that line." };
      revalidatePath(`/jobs/${r.job.id}`);
      return {
        ok: true,
        data: { job_id: r.job.id, list_id: r.listId, item_id: r.line.id, removed: true },
        recorded: `Removed: ${words} from the ${r.label} materials list.`,
      };
    },
  },
};
