import type { SupabaseClient } from "@supabase/supabase-js";
import { dbError } from "@/lib/db-error";
import { getOrgSettings } from "@/lib/org-settings";
import { effectiveMarkupPct } from "@/lib/pricing/markup";
import { ITEM_OPTIONS_EMBED, bookLineBuy } from "@/lib/pricing/item-options";
import { firstThatWorks, kitsSelectRungs, kitLineView, linkedItemOf } from "@/lib/kit-line";
import { coerceTaskDetail } from "./task-lines";
import { keyParts, materialKey } from "./born-with-tasks";
import { reportError } from "@/lib/observe";

/**
 * THE MATERIALS TAKE-OFF AN ACCEPTED ESTIMATE BECOMES — one rule, called by two doors.
 *
 * It lived inside materials/actions.ts as createMaterialListFromQuote, reachable only through a
 * signed-in staff client, so the customer's own Accept link (accept_public_quote) made a job with
 * no list at all. The body is here now, taking the client it is given: the staff door hands it the
 * user's client, finishPublicAcceptance (q/[token]/actions) hands it the service client with the
 * company's id, and the list is the same either way.
 *
 * A material list is an ORDER sheet, so it: DROPS labor lines, pulls each item's real BUY cost +
 * catalog # + vendor from the price book (not the marked-up estimate price), and reads the catalog #
 * from a "…[CODE]" tag in the description when present. Unmatched lines keep the estimate price as
 * a fallback, with the markup backed out.
 *
 * A TASK LINE IS NOT A MATERIAL (W3, cn-v1075). Since cn-v1074 an estimate line can be a TASK
 * ("Install transfer switch", 1 ea, $X) whose breakdown rides the row (detail, 0386): his hours and
 * his parts by code. This builder knew labor lines and book codes and nothing else, so a task line
 * landed on the crew's list as a part priced at sell ÷ (1 + markup) while the parts he actually
 * named never arrived. Now a task line puts NO row on the sheet for itself; each of its parts does —
 * by its code, at the book's unit, vendor and the buy cost the line was built with, and a part he
 * hasn't counted asks "how many?" instead of inventing a count.
 *
 * THREE ORGS, ONE DATABASE: a service client bypasses RLS, so when the caller names the company every
 * read that isn't keyed by id is scoped to it (the book, the settings, the kits). A user client
 * passes null and RLS scopes as before.
 */

export interface TakeOffWho {
  quoteId: string;
  /** The list's created_by: the staff member, or the estimate's author on the public door. */
  userId: string | null;
  /** The company, when the client is not scoped by RLS (service role). */
  orgId: string | null;
}

export type TakeOffResult = {
  ok: boolean;
  error?: string;
  id?: string;
  jobId?: string | null;
  /** The job's own list (no estimate held it) became this estimate's list; its task parts are the sync's to add. */
  adopted?: boolean;
  /** On an adopted list: plain lines not seeded because the list already carried them by code or words. */
  skipped?: number;
};

/** The one-liner on the sheet for a part he named but never counted. */
export const HOW_MANY = " · how many?";

/** The company's price book as the take-off looks things up: by "[CODE]" (then its last token), then
 *  by the normalized description. One read, shared by the birth (takeOffFromQuote) and the sync
 *  (sync-job-materials), so a part is matched the same way whichever door lists it. */
export async function readPriceBook(supabase: SupabaseClient, orgId: string | null): Promise<{ findPl: (code: string | null, cleanDesc: string) => any | null }> {
  // The vendors under each code ride along (THE PROJECTION LAW): a line the estimator, Nort or a
  // picker priced at a vendor names it ("Replace windows (Marvin) [830]"), and bookLineBuy costs it
  // at THAT vendor, not at the code's own $830 allowance the customer was never quoted.
  let bookQ = supabase
    .from("price_list_items")
    .select(`code, description, supplier, buy_price, unit, ${ITEM_OPTIONS_EMBED}`)
    .eq("archived", false)
    .eq("price_list_item_options.archived", false);
  if (orgId) bookQ = bookQ.eq("org_id", orgId);
  const { data: book } = await bookQ;
  const normDesc = (x: string) => (x ?? "").toLowerCase().replace(/\[[^\]]*\]/g, "").replace(/[^a-z0-9]/g, "");
  const byCode = new Map<string, any>();
  const byDesc = new Map<string, any>();
  for (const b of (book ?? []) as any[]) {
    if (b.code) byCode.set(String(b.code).toUpperCase(), b);
    const k = normDesc(b.description);
    if (k && !byDesc.has(k)) byDesc.set(k, b);
  }
  // Match "[CODE]" exactly, then its last token ("[RACO 936]" → "936"), then the cleaned description.
  const findPl = (code: string | null, cleanDesc: string): any => {
    if (code) {
      const up = code.toUpperCase();
      if (byCode.has(up)) return byCode.get(up);
      const last = up.split(/\s+/).pop();
      if (last && byCode.has(last)) return byCode.get(last);
    }
    return byDesc.get(normDesc(cleanDesc)) ?? null;
  };
  return { findPl };
}

/** A part of a task line as a row on the sheet — ONE shape for the birth and the sync (0390). */
export interface TaskPartRow {
  list_id: string;
  org_id?: string;
  description: string;
  part_number: string | null;
  quantity: number;
  unit: string;
  vendor: string | null;
  est_cost: number | null;
  /** "line:<id>#<CODE|slug>" — how the sync finds this row again (0390). */
  source_key: string;
}

/** THE TASK'S PART, NEVER THE TASK. A named part is a row by its code; the book names the unit and the
 *  vendor; the cost is the buy the line was built with, else the book's, else it asks. A part he never
 *  counted says so on the sheet and rides as one so the row can exist. */
export function taskPartRow(
  listId: string,
  orgId: string | null,
  part: { code: string | null; name: string; qty: number | null; cost: number | null; source_key: string },
  pl: any | null,
): TaskPartRow {
  const name = part.name.trim();
  return {
    list_id: listId,
    ...(orgId ? { org_id: orgId } : {}),
    description: part.qty === null ? `${name}${HOW_MANY}` : name,
    part_number: pl?.code ?? part.code ?? null,
    quantity: part.qty ?? 1,
    unit: pl?.unit || "ea",
    vendor: pl?.supplier ?? null,
    est_cost: part.cost ?? (pl ? bookLineBuy(pl, name).buyPrice : null),
    source_key: part.source_key,
  };
}

export async function takeOffFromQuote(supabase: SupabaseClient, who: TakeOffWho): Promise<TakeOffResult> {
  const { quoteId, orgId } = who;
  // The company's own settings row: by id when the client is not scoped, else the one RLS shows.
  const orgSettings = () =>
    orgId ? supabase.from("organizations").select("settings").eq("id", orgId).maybeSingle() : supabase.from("organizations").select("settings").limit(1).maybeSingle();

  const { data: quote, error: qErr } = await supabase
    .from("quotes")
    .select("id, quote_number, job_id, title, customer_id, status, revises_quote_id")
    .eq("id", quoteId)
    .maybeSingle();
  if (qErr) return { ok: false, error: qErr.message };
  if (!quote) return { ok: false, error: "Quote not found." };

  // Idempotent: one material list per quote — re-running opens the existing one.
  const { data: existingList } = await supabase
    .from("material_lists")
    .select("id")
    .eq("quote_id", quoteId)
    .limit(1)
    .maybeSingle();
  if (existingList) return { ok: true, id: existingList.id, jobId: quote.job_id ?? null };

  let linesQ = supabase
    .from("quote_line_items")
    // `detail` (0386): the task behind a line, when it was built from one — its parts are the rows.
    .select("id, description, quantity, unit, unit_price, sort_order, detail")
    .eq("quote_id", quoteId);
  if (orgId) linesQ = linesQ.eq("org_id", orgId); // the same rows the birth read (born-with-tasks)
  const { data: items, error: iErr } = await linesQ.order("sort_order");
  if (iErr) return { ok: false, error: iErr.message };
  if (!items || items.length === 0)
    return { ok: false, error: "This quote has no line items to build from." };

  // THE JOB'S OWN LIST IS THE LIST (cn-v1084). A job born from a visit already has a list — the
  // visit's parts, keyed "task:<id>#…" (addCaptureItemsToJobList) — and the estimate drafted from
  // that same visit used to get a SECOND list here; the job tab then showed the newest as the one
  // list and the visit's as superseded: the same parts twice, with the crew's bought marks on the dead
  // one. An ACCEPTED estimate ADOPTS the job's CANONICAL list (the newest, the one every reader shows —
  // canonicalListIdForJob's own pick) when no estimate holds it (compare-and-set on quote_id null;
  // 0388 still keeps one list per estimate). Its plain lines are seeded below, skipping what the list
  // already carries by code or words (the visit's typed items come back as plain lines); its TASK
  // PARTS are left to the sync (sync-job-materials), which finds the visit's rows by the task id the
  // line's breakdown remembers and re-keys them instead of adding them again — so the caller runs the
  // sync after an adoption (the acceptance doors do; so does Create Material List). A draft or sent
  // estimate never adopts: nothing would add its parts. A refused adoption is reported and falls
  // through to a fresh list — what happened before. A REVISION (0391) adopts the list of the estimate
  // it revises the same way (compare-and-set on that estimate's id): the crew's list — bought marks
  // and all — becomes the revision's, and the sync re-keys the original's rows to the revision's lines.
  let list: { id: string } | null = null;
  let adopted = false;
  const revises = (quote as { revises_quote_id?: string | null }).revises_quote_id ?? null;
  if (quote.job_id && (quote as { status?: string }).status === "accepted") {
    let ownQ = supabase.from("material_lists").select("id, quote_id").eq("job_id", quote.job_id);
    if (orgId) ownQ = ownQ.eq("org_id", orgId);
    const { data: own } = await ownQ.order("created_at", { ascending: false }).order("id", { ascending: false }).limit(1).maybeSingle();
    const canonical = own as { id: string; quote_id: string | null } | null;
    const fromOriginal = !!(canonical && revises && canonical.quote_id === revises);
    if (canonical && (canonical.quote_id === null || fromOriginal)) {
      let tq = supabase.from("material_lists").update({ quote_id: quote.id }).eq("id", canonical.id);
      tq = fromOriginal ? tq.eq("quote_id", revises as string) : tq.is("quote_id", null);
      const { data: took, error: tErr } = await tq.select("id");
      if (tErr) reportError("takeOffFromQuote:adopt", tErr, { quoteId, listId: canonical.id });
      if (took?.length) {
        list = { id: canonical.id };
        adopted = true;
      }
    }
  }

  if (!list) {
    const { data: made, error } = await supabase
      .from("material_lists")
      .insert({
        ...(orgId ? { org_id: orgId } : {}),
        name: `Materials — ${quote.quote_number}`,
        job_id: quote.job_id,
        quote_id: quote.id,
        created_by: who.userId,
      })
      .select("id")
      .single();
    if (error) {
      // TWO DOORS IN THE SAME SECOND: both read "no list yet"; the second insert is refused by
      // material_lists_one_per_quote_uq (0388). The other door's list IS the list — open it.
      if ((error as { code?: string }).code === "23505") {
        const { data: won } = await supabase.from("material_lists").select("id").eq("quote_id", quoteId).limit(1).maybeSingle();
        if (won) return { ok: true, id: won.id, jobId: quote.job_id ?? null };
      }
      return { ok: false, error: dbError(error) };
    }
    list = made as { id: string };
  }

  // The price book (RLS-scoped to this org, or scoped here) → resolve each material line to its REAL
  // buy cost, catalog #, and vendor (readPriceBook: "[CODE]" first, then the normalized description;
  // tools are archived, so they never land on an order sheet).
  const { findPl } = await readPriceBook(supabase, orgId);
  // An order sheet is a BUY list. Lines that don't match the price book carry the estimate's SELL
  // price, so back the markup out to get cost — through the SAME rule that built the sell:
  // runEstimator prices off-book lines at customer level → default_markup_pct (the item rung is
  // vacuous off-book), so the reverse must read the same knobs. material_markup_percent is a
  // DIFFERENT lane (the job-cost → invoice import in billing) and must not leak in here — with
  // the two Settings fields set differently it would over/understate cost on every unmatched line.
  const { data: orgS } = await orgSettings();
  let levelPct: number | null = null;
  if (quote.customer_id) {
    const { data: cust } = await supabase
      .from("customers")
      .select("pricing_levels(markup_pct)")
      .eq("id", quote.customer_id)
      .maybeSingle();
    const lvl = (cust as any)?.pricing_levels?.markup_pct;
    if (lvl != null) levelPct = Number(lvl);
  }
  const settings = getOrgSettings((orgS as any)?.settings);
  const markup = effectiveMarkupPct({
    levelPct,
    itemPct: 0, // off-book: no item markup exists
    orgDefaultPct: settings.default_markup_pct,
  });
  const costFromSell = (p: number) => Math.round((p / (1 + markup / 100)) * 100) / 100;

  const CODE_RE = /\[([^\]]+)\]/;
  const isLabor = (it: any) =>
    String(it.unit ?? "").toLowerCase() === "hr" || /^\s*labor\b/i.test(String(it.description ?? ""));

  type Row = {
    list_id: string;
    org_id?: string;
    description: string;
    part_number: string | null;
    quantity: number;
    unit: string;
    vendor: string | null;
    est_cost: number | null;
    sort_order: number;
    /** 0390: only a task line's part carries one; a plain line's row and a catalog kit's row are not the estimate's to follow. */
    source_key?: string;
  };
  const rows: Row[] = [];
  // On an adopted list the new rows go after what the crew already has, and a plain line the list
  // already carries UNKEYED by code or words (the visit's typed items) is not seeded a second time.
  let so = 0;
  const onList = new Map<string, number>();
  let skipped = 0;
  if (adopted) {
    let haveQ = supabase.from("material_list_items").select("sort_order, part_number, description, source_key").eq("list_id", list.id);
    if (orgId) haveQ = haveQ.eq("org_id", orgId);
    const { data: had, error: hErr } = await haveQ;
    if (hErr) return { ok: false, error: dbError(hErr) };
    for (const r of (had ?? []) as Array<{ sort_order: number | null; part_number: string | null; description: string | null; source_key: string | null }>) {
      so = Math.max(so, (r.sort_order ?? -1) + 1);
      if (r.source_key) continue;
      const half = materialKey("x", r.part_number, String(r.description ?? "").replace(HOW_MANY, "")).slice(2);
      onList.set(half, (onList.get(half) ?? 0) + 1);
    }
  }
  const stamp = orgId ? { org_id: orgId } : {};
  for (const it of items as any[]) {
    // THE TASK FIRST (the skeptic's case): "Labor to relocate meter" with a breakdown is a task with
    // parts to buy, not a labor line to drop. Only a line that is not a task is tested for labor.
    const task = coerceTaskDetail(it.detail);
    if (task) {
      // THE TASK'S PARTS, NEVER THE TASK (taskPartRow — the one shape the sync writes too), each keyed
      // to its line and part (0390) so a later change to the estimate can find it. On an ADOPTED list
      // they are the sync's to add (it knows the visit's rows); here they would double them.
      if (adopted) continue;
      for (const m of keyParts(`line:${it.id}`, task.materials.filter((x) => x.name.trim()))) {
        const name = m.name.trim();
        rows.push({ ...taskPartRow(list.id, orgId, { code: m.code, name, qty: m.qty, cost: m.cost, source_key: m.key }, findPl(m.code, name)), sort_order: so++ });
      }
      continue;
    }
    if (isLabor(it)) continue; // an order sheet carries materials, never labor
    const m = String(it.description ?? "").match(CODE_RE);
    const code = m ? m[1].trim() : null;
    const cleanDesc = String(it.description ?? "").replace(CODE_RE, "").trim();
    const pl = findPl(code, cleanDesc);
    if (adopted) {
      const half = materialKey("x", pl?.code ?? code ?? null, cleanDesc || String(it.description ?? "")).slice(2);
      const n = onList.get(half) ?? 0;
      if (n) {
        onList.set(half, n - 1);
        skipped++;
        continue;
      }
    }
    rows.push({
      list_id: list.id,
      ...stamp,
      description: cleanDesc || it.description,
      part_number: pl?.code ?? code ?? null,
      quantity: Number(it.quantity) || 1,
      unit: it.unit || pl?.unit || "ea",
      vendor: pl?.supplier ?? null,
      // matched → the book's real buy price, at the vendor the line names when it names one;
      // unmatched → estimate price with the markup removed. `vendor` stays the item's supplier:
      // a vendor option is the BRAND (Marvin), the supplier is where it is bought, and the brand
      // is already in the description.
      est_cost: pl ? bookLineBuy(pl, cleanDesc).buyPrice : it.unit_price != null ? costFromSell(Number(it.unit_price)) : null,
      sort_order: so++,
    });
  }

  // Catalog orgs (Tahoe Deck): the granular MATERIAL kits (Framing, Hardware, Decking…) are
  // the POST-ACCEPTANCE purchasing breakdown — deliberately kept OFF the estimate, seeded onto
  // the job's materials list here so the crew has the buy-list grouped by scope. Prefixed with
  // the kit name (material_list_items has no group column). Only on first creation (idempotent
  // return above), so re-running never duplicates the groups. RLS scopes kits to this org on a
  // user client; the company's id scopes them on the service client.
  // On an ADOPTED list (cn-v1084/0391) the groups are there already — the crew's bought marks on them.
  if (settings.estimating_mode === "catalog" && !adopted) {
    // THE SHARED SELECT SHAPE (kit-line.ts), tolerant of 0166/0240 not having landed. A LINKED
    // line (0240) puts the ITEM on the order sheet: its description, catalog #, unit, vendor and
    // — the whole point — its BUY price as est_cost, not a sell price to back a markup out of.
    // A frozen line keeps today's behaviour (its unit_price as the estimate).
    const { data: matKits } = await firstThatWorks(
      kitsSelectRungs("name").map((sel) => () => {
        let q = supabase.from("kits").select(sel).not("name", "in", '("Decks","Remodels")');
        if (orgId) q = q.eq("org_id", orgId);
        return q.order("name");
      }),
    );
    for (const k of (matKits ?? []) as any[]) {
      const kitItems = [...(k.kit_items ?? [])].sort((a: any, b: any) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
      for (const it of kitItems) {
        const item = linkedItemOf(it);
        // ONE RESOLUTION (audit v994 VP2): a code with a default vendor is BOUGHT at that vendor,
        // so the words, the unit and est_cost all come from the same kitLineView the kit priced
        // the line with. A vendor can carry its own unit (a supplier quoting by the pair); taking
        // the item's unit beside the vendor's per-pair cost made the buy list and the quote
        // disagree about what one of it is. Markup doesn't touch any of the three, so any pricing
        // will do. The code rides in part_number, so the words drop the "CODE — " the view leads
        // with and keep the vendor and its part number ("Windows (Marvin, #M-1)").
        const view = item ? kitLineView(it, { orgDefaultPct: 0 }) : null;
        const lead = view?.code ? `${view.code} — ` : "";
        const words = view ? (lead && view.description.startsWith(lead) ? view.description.slice(lead.length) : view.description) : it.description;
        rows.push({
          list_id: list.id,
          ...stamp,
          description: `${k.name} — ${words}`,
          part_number: item?.code ?? null,
          quantity: Number(it.quantity) || 1,
          unit: view ? view.unit : it.unit || "ea",
          vendor: item?.supplier ?? null,
          est_cost: view ? view.cost : it.unit_price != null ? Number(it.unit_price) : null,
          sort_order: so++,
        });
      }
    }
  }

  if (rows.length) {
    const { data: seeded, error: itemsErr } = await supabase.from("material_list_items").insert(rows).select("id");
    if (itemsErr) return { ok: false, error: dbError(itemsErr) };
    if ((seeded?.length ?? 0) !== rows.length)
      return { ok: false, error: adopted ? "The list is there but its new lines didn't save. Open it and try again." : "The list was created but its lines didn't save. Open it and try again." };
  }

  return { ok: true, id: list.id, jobId: quote.job_id ?? null, ...(adopted ? { adopted: true, skipped } : {}) };
}
