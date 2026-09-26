import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { dbError } from "@/lib/db-error";
import { jobLabel } from "@/lib/schedule-options";
import { quotedData } from "@/lib/org-local-time";
import { fmtQty, matchShelfItem, normUnit, parseShelf, takeHref, takeShort, takeShortWords } from "@/lib/stock-take";
import { resolveJobId } from "../resolve-id";
import type { ActionDef, ActionResult } from "../types";

/**
 * THE SHELF'S ACTIONS (Shop Stock).
 *
 * inventory.adjust typed a signed delta over quantity_on_hand. That column is a cache the shelf's
 * own record keeps now and the database refuses a typed count, so it was retired (0303) rather than
 * left as a door that says no.
 *
 * stock.take (Phase 3) is Nort's way to move stock, and it moves nothing. "Took 60 feet of 12/2 from
 * stock for Herringbone" FILLS the Took From Stock card: the job resolved, the item resolved by name
 * off the crew's view of the shelf (shelf_for_crew: names, units, counts, never a cost), the count
 * with the item's own unit. The card's link opens the job's sheet filled in, and a PERSON taps Take
 * It (fill vs execute, Erik 2026-08-02). Two items that match the name are a question back, never a
 * pick. It is a read: it writes nothing, so it needs no write power and no confirm, and it is open
 * to every role, since taking from stock is the crew's own verb.
 */
export const inventoryActions: Record<string, ActionDef> = {
  "stock.take": {
    name: "stock.take",
    group: "stock",
    label: "Fill the Took From Stock card",
    description:
      "When someone says they TOOK material FROM STOCK / off the shelf / from the shop for a job ('took 60 feet of 12/2 from stock for Herringbone', 'grabbed 10 wire nuts off the shelf for Waldow'): this FILLS the job's Took From Stock card and returns the link and a card that are put on the screen for you. It does NOT take anything: the person taps Take It. NEVER say it's taken, recorded or on the job until they do; say it's ready to tap. " +
      "job_id = the job's id from list_jobs OR its name / number as spoken. item = the item's name as they said it ('12/2', '12/2 NM-B', 'wire nuts'). qty = the count they said, only if they said one; unit = the unit they said (feet, each), only if they said one. " +
      "If it says several items match, read the names back and ask which one; if none match, say what the shelf has (list_shelf). Never guess a count or a price. Taking more than the shelf shows is allowed: say what it says about the office settling it.",
    input: z.object({
      job_id: z.string().min(1),
      item: z.string().trim().min(1).max(120),
      qty: z.number().finite().gt(0).max(1_000_000).nullable().optional(),
      unit: z.string().trim().max(20).nullable().optional(),
    }),
    auth: "any",
    effect: "read", // it only FILLS the sheet: nothing is written until a person taps Take It
    handler: async (i, ctx): Promise<ActionResult> => {
      if (!ctx.orgId) return { ok: false, error: "Your account isn't in a company yet." };
      const supabase = await createClient();
      const r = await resolveJobId(supabase as never, i.job_id);
      if ("error" in r) return { ok: false, error: r.error };
      if (!r.id) return { ok: false, missingFields: ["job_id"], error: "Which job did it go on?" };
      const { data: job, error: jobErr } = await supabase.from("jobs").select("id, job_number, name").eq("id", r.id).eq("org_id", ctx.orgId).maybeSingle();
      if (jobErr) return { ok: false, error: dbError(jobErr) };
      if (!job) return { ok: false, error: "Job not found (or not one you can see)." };
      const label = jobLabel(job as { job_number?: string | null; name?: string | null });

      // The crew's view of the shelf, for everyone: this card never carries a cost.
      const { data: shelfRaw, error: shelfErr } = await supabase.rpc("shelf_for_crew");
      if (shelfErr) return { ok: false, error: dbError(shelfErr) };
      const shelf = parseShelf(shelfRaw);
      if (!shelf.length) return { ok: false, error: "Nothing is on the shelf yet, so there is nothing to take from. The office puts rolls and boxes on it from their tickets." };

      const m = matchShelfItem(shelf, i.item);
      if (m.kind === "none") {
        return {
          ok: false,
          error: `Nothing on the shelf is called ${quotedData(i.item)}. The shelf has: ${shelf.slice(0, 12).map((s) => quotedData(s.name)).join(", ")}${shelf.length > 12 ? ", and more" : ""}. Which one?`,
        };
      }
      if (m.kind === "many") {
        return {
          ok: false,
          error: `More than one item on the shelf matches ${quotedData(i.item)}: ${m.rows.map((s) => `${quotedData(s.name)} (${fmtQty(Math.max(s.onHand, 0))} ${s.unit})`).join(", ")}. Ask which one.`,
          data: { candidates: m.rows.map((s) => ({ item_id: s.id, name: s.name, unit: s.unit })) },
        };
      }
      const row = m.row;
      const said = normUnit(i.unit);
      if (said && said !== normUnit(row.unit)) {
        return { ok: false, error: `${quotedData(row.name)} is counted in ${row.unit}, not ${i.unit}. Ask how many ${row.unit} they took.` };
      }

      const qty = i.qty ?? null;
      const href = takeHref(r.id, row.id, qty);
      const { short, past } = qty ? takeShort(row, qty) : { short: 0, past: 0 };
      const shortSaid = takeShortWords({ short, past, unit: row.unit });
      const what = qty ? `${fmtQty(qty)} ${row.unit} of ${row.name}` : row.name;
      const onShelf = row.onHand > 0 ? `${fmtQty(row.onHand)} ${row.unit}` : "none on its record";
      return {
        ok: true,
        data: {
          href,
          job_id: r.id,
          item_id: row.id,
          item: row.name,
          unit: row.unit,
          qty,
          ...(short > 0 ? { short } : {}),
          // THE FILL ALWAYS REACHES A BUTTON: the chat route projects this card itself. It reads as
          // NOT DONE at a glance (fill vs execute): the eyebrow and the headline say it isn't saved,
          // and the headline is the door, since the card's open icon only shows on hover.
          card: {
            kind: "task",
            eyebrow: "not saved yet",
            title: `Tap To Take: ${what}`,
            scope: `Not taken yet: tap above, then Take It. For ${label}. On the shelf: ${onShelf}.${shortSaid ? ` ${shortSaid}.` : ""}`,
            href,
            next: qty ? "Open it and tap Take It to save it." : "Open it, type how many, and tap Take It.",
          },
        },
        speak: qty
          ? `Ready: ${fmtQty(qty)} ${row.unit} of ${quotedData(row.name)} for ${quotedData(label)}.${shortSaid ? ` That's ${shortSaid}.` : ""} Tap Take It to save it.`
          : `Ready: ${quotedData(row.name)} for ${quotedData(label)}. How many ${row.unit}? Type it on the card and tap Take It.`,
      };
    },
  },
};
