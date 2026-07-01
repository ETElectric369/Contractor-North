import { z } from "zod";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import type { ActionDef } from "../types";

// The one-field front door (fragment-first): ANY spoken/typed fragment is a valid
// record. capture.quick saves the raw text INSTANTLY as a private organized_items
// stub (status 'needs_review'), which already flows into the Needs-action inbox
// (src/lib/action-items/query.ts) with triage affordances built. HARD BOUNDARY:
// this path NEVER calls the AI — classification stays in Organize's async review.
// Nothing is inferred; the fragment lands exactly as given and gets sorted later.

/** Optional caller hint about what the fragment looks like → the free-text
 *  category column (the triage UI + AI review read it as a hint, nothing more).
 *  kind stays 'note' — the one organized_items kind a bare text capture IS. */
const CATEGORY_HINT: Record<string, string> = {
  note: "Note",
  task: "Task",
  lead: "Lead",
  job: "Job",
};

export const captureActions: Record<string, ActionDef> = {
  "capture.quick": {
    name: "capture.quick",
    group: "capture",
    label: "Capture anything",
    description:
      "Capture ANY fragment as-is into the review inbox — a name, a number, a half-thought, 'the Hendersons want a hot tub circuit'. Use when the user just wants something WRITTEN DOWN and no more specific action fits. Saves instantly as a private stub (nothing sent, nothing inferred); it gets sorted later. Pass the raw text, plus an optional kind hint (note, task, lead, or job).",
    input: z.object({
      text: z.string().trim().min(1, "Type something to capture.").max(2000),
      kind: z.enum(["note", "task", "lead", "job"]).optional(),
    }),
    auth: "any", // everyone captures — it writes only a private review stub
    effect: "write", // tier-1 (lowest write): one reversible private row
    handler: async (i, ctx) => {
      const supabase = await createClient();
      const clean = i.text.trim();
      if (!clean) return { ok: false, error: "Nothing to capture." };
      // Title = first ~80 chars; the full fragment lives in summary, verbatim.
      const title = clean.length > 80 ? clean.slice(0, 77) + "…" : clean;
      const { error } = await supabase.from("organized_items").insert({
        kind: "note",
        title,
        summary: clean,
        category: CATEGORY_HINT[i.kind ?? "note"],
        confidence: "high",
        status: "needs_review", // → the Needs-action inbox on My Day
        file_url: null,
        created_by: ctx.userId,
      });
      if (error) return { ok: false, error: error.message };
      revalidatePath("/organize");
      revalidatePath("/planner");
      return { ok: true, speak: "Captured — it's in your inbox." };
    },
  },
};
