import type { SupabaseClient } from "@supabase/supabase-js";
import { dbError } from "@/lib/db-error";
import { getOrgSettings } from "@/lib/org-settings";
import { effectiveMarkupPct } from "@/lib/pricing/markup";
import { ITEM_OPTIONS_EMBED, bookLineBuy } from "@/lib/pricing/item-options";
import { firstThatWorks, kitLineView, linkedItemOf } from "@/lib/kit-line";
import { partsKitsOnly, taskKitSelectRungs } from "./task-kits";
import { coerceTaskDetail, lineQty } from "./task-lines";
import { keyParts, materialKey, partQtyFor } from "./born-with-tasks";
import { readAllPages } from "@/lib/read-all-pages";
import { reportError } from "@/lib/observe";
import type { CountDiffers } from "./sync-job-materials";

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
  /** The job's own list (no estimate held it), or the original's (a revision), became this estimate's list; its task parts are the sync's to add. */
  adopted?: boolean;
  /** On an adopted list: what became of the estimate's PLAIN lines (takeOffWords says it). */
  follow?: PlainFollow;
};

/** What an ADOPTED list did with the estimate's PLAIN lines (a task line's parts are the sync's). */
export interface PlainFollow {
  /** Plain lines seeded: the list carried no row for them. */
  added: number;
  /** Rows the list already carried at the line's count: left exactly as they are. */
  carried: number;
  /** The estimate's own unbought rows brought to the revision's count, by name (Erik 2026-10-11). */
  recounted: string[];
  /** The estimate's own unbought rows whose line the revision dropped: removed, by name. */
  removed: string[];
  /** The estimate's own rows whose line is gone but which are bought, a tool, or carry a count he typed: kept, by name. */
  kept: string[];
  /** A matched row not rewritten — bought, a tool, a typed count, or the crew's — whose count is not the line's: said. */
  countsDiffer: CountDiffers[];
  /** A write that failed after the list became the estimate's: said with the one way out (the door is idempotent, a retry opens the list). */
  failed: string[];
}

/** The one-liner on the sheet for a part he named but never counted. */
export const HOW_MANY = " · how many?";

/** The company's price book as the take-off looks things up: by "[CODE]" (then its last token), then
 *  by the normalized description. One read, shared by the birth (takeOffFromQuote) and the sync
 *  (sync-job-materials), so a part is matched the same way whichever door lists it. */
export async function readPriceBook(
  supabase: SupabaseClient,
  orgId: string | null,
): Promise<{ findPl: (code: string | null, cleanDesc: string) => any | null; /** The read failed: nothing priced from it is true. */ error?: string }> {
  // The vendors under each code ride along (THE PROJECTION LAW): a line the estimator, Nort or a
  // picker priced at a vendor names it ("Replace windows (Marvin) [830]"), and bookLineBuy costs it
  // at THAT vendor, not at the code's own $830 allowance the customer was never quoted.
  // A LOST OR CUT READ IS SAID, NEVER PRICED AROUND (audit v1085): the error used to be dropped and
  // PostgREST's 1,000-row cap silently truncated a big book, so every part past the cap — or every
  // part on a bad connection — went on the buy list unpriced and un-vendored as if the book had no
  // such item. Paged by id, and the error comes back to the caller.
  const { rows: book, error: bErr } = await readAllPages<any>((from, to) => {
    let bookQ = supabase
      .from("price_list_items")
      .select(`id, code, description, supplier, buy_price, unit, ${ITEM_OPTIONS_EMBED}`)
      .eq("archived", false)
      .eq("price_list_item_options.archived", false);
    if (orgId) bookQ = bookQ.eq("org_id", orgId);
    return bookQ.order("code").order("id").range(from, to); // stable: byDesc's first-wins never flips between reads
  });
  if (bErr) return { findPl: () => null, error: dbError(bErr) };
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

/** Postgres 23505: a unique index another door just filled (0393 on the buy list, 0388 on the list itself). */
export const isDuplicateKey = (e: unknown): boolean => String((e as { code?: unknown } | null)?.code ?? "") === "23505";

/**
 * KEYED ROWS ONTO A LIST, ONE DOOR AT A TIME (0393, material_items_list_source_key_uq): two doors in the
 * same second (the customer's Accept and the office's; the take-off and the sync) each write the
 * estimate's parts, and the batch of the loser is refused whole on the first key the winner already
 * holds. A 23505 is answered by reading the keys the list holds NOW and writing only the rows whose
 * key is absent — the other door's view may have been older or newer, so "it wrote all of them" is
 * never assumed. Any other refusal is returned; a short count is an error too (silent-write law).
 */
export async function insertKeyedRows(
  sb: SupabaseClient,
  listId: string,
  orgId: string | null,
  rows: ReadonlyArray<Record<string, unknown> & { source_key: string }>,
): Promise<{ inserted: number; error?: unknown }> {
  if (!rows.length) return { inserted: 0 };
  const first = await sb.from("material_list_items").insert([...rows]).select("id");
  if (!first.error) return first.data?.length === rows.length ? { inserted: first.data.length } : { inserted: first.data?.length ?? 0, error: new Error(`${rows.length - (first.data?.length ?? 0)} of ${rows.length} rows did not save`) };
  if (!isDuplicateKey(first.error)) return { inserted: 0, error: first.error };
  let kq = sb.from("material_list_items").select("source_key").eq("list_id", listId);
  if (orgId) kq = kq.eq("org_id", orgId);
  const { data: had, error: kErr } = await kq;
  if (kErr) return { inserted: 0, error: kErr };
  const keys = new Set(((had ?? []) as Array<{ source_key: string | null }>).map((r) => r.source_key).filter((k): k is string => !!k));
  const missing = rows.filter((r) => !keys.has(r.source_key));
  if (!missing.length) return { inserted: 0 };
  const second = await sb.from("material_list_items").insert([...missing]).select("id");
  if (second.error) return { inserted: 0, error: second.error };
  const n = second.data?.length ?? 0;
  return n === missing.length ? { inserted: n } : { inserted: n, error: new Error(`${missing.length - n} of ${missing.length} rows did not save`) };
}

const CODE_RE = /\[([^\]]+)\]/;

/** How an UNKEYED row on the sheet is matched to a plain line: by its code, else by its words slugged like a
 *  key (materialKey) — the "how many?" tail set aside. plainLineOf's `half` is this same string for the row
 *  the take-off writes, so the take-off and the sync recognise a row the same way. */
export const plainRowHalf = (r: { part_number: string | null; description: string | null }): string =>
  materialKey("x", r.part_number, String(r.description ?? "").replace(HOW_MANY, "")).slice(2);

/** A PLAIN LINE'S ROW ON THE SHEET — one reading for the take-off that writes it and the sync that
 *  recognises it (audit v1085): the FIRST "[CODE]" is the code, the words are the text without it, the
 *  row's part number is the book's code when the book knows the part (else the tag), and the count is the
 *  line's (one when blank). A task line (its parts are rows, it is not) and a labor line (an order sheet
 *  carries materials) are no plain line: null. */
export function plainLineOf(
  line: { description?: string | null; quantity?: number | string | null; unit?: string | null; detail?: unknown },
  findPl: (code: string | null, cleanDesc: string) => any | null,
): { code: string | null; cleanDesc: string; pl: any | null; half: string; qty: number } | null {
  if (coerceTaskDetail(line.detail)) return null;
  const text = String(line.description ?? "");
  if (String(line.unit ?? "").toLowerCase() === "hr" || /^\s*labor\b/i.test(text)) return null;
  const m = text.match(CODE_RE);
  const code = m ? m[1].trim() : null;
  const cleanDesc = text.replace(CODE_RE, "").trim();
  const pl = findPl(code, cleanDesc);
  return { code, cleanDesc, pl, half: plainRowHalf({ part_number: pl?.code ?? code ?? null, description: cleanDesc || text }), qty: Number(line.quantity) || 1 };
}

/** An unkeyed row on an adopted list, as the plan sees it. */
export interface PlainRow {
  id: string;
  half: string;
  quantity: number | null;
  description: string;
  unit?: string | null;
  /** Bought, or a tool: his — never rewritten, never removed. */
  his: boolean;
}
/** A plain line of the estimate, with the row the take-off would write for it. */
export interface PlainLine<T> {
  half: string;
  qty: number;
  unit?: string | null;
  row: T;
}
export interface PlainPlan<T> {
  /** Lines no row carries: written. */
  insert: T[];
  /** The estimate's own UNTOUCHED rows (still at the original line's count), and an untouched "how many?"
   *  placeholder: brought to the line's count — with the words (the tail dropped) and the unit when they change. */
  recount: Array<{ id: string; description: string; from: number | null; to: number; words?: string; unit?: string }>;
  /** The estimate's own untouched, unbought rows whose line is gone. */
  remove: PlainRow[];
  /** The estimate's own rows whose line is gone but which are bought, a tool, or carry a typed count: his, said. */
  kept: PlainRow[];
  /** A matched row not rewritten (his, a typed count, or the crew's) whose count is not the line's: said. */
  countsDiffer: CountDiffers[];
  /** Matched at the line's count: nothing to do. */
  carried: number;
}

/** THE PLAN FOR THE PLAIN LINES ON AN ADOPTED LIST, pure (Erik 2026-10-11: "yes" — they follow). Each line
 *  claims one unkeyed row by code else words — an equal count first, then one that is not his — or is
 *  written. `estimateHalves` are the plain lines of the estimate the list belonged to (a REVISION's
 *  original; empty for the job's own visit list), each with the COUNT that line had: a row matching one of
 *  them is the ESTIMATE'S row, and it FOLLOWS only while it is UNTOUCHED — still at the original line's
 *  count (a count he typed over it looks the same as one the take-off wrote, so the original's figure is
 *  the only way to tell; the sync's own rule for the job's length). An untouched unbought row takes the
 *  revision's count (and its unit when that changed), or goes when no line wants it any more; a bought or
 *  tool one, or one with a typed count, is kept and said. An untouched "how many?" placeholder (count 1,
 *  not his) takes the count a line now gives it, whoever's row it is — the tail goes with it. Every other
 *  unkeyed row is the crew's: never rewritten, never removed, a differing count only said. Rows with the
 *  same code or words (the crew typed what a line says) are told apart by their count, then by order. */
export function planPlainRows<T>(lines: ReadonlyArray<PlainLine<T>>, rows: ReadonlyArray<PlainRow>, estimateHalves: ReadonlyMap<string, readonly number[]> = new Map()): PlainPlan<T> {
  const free = [...rows];
  const left = new Map([...estimateHalves].map(([h, qs]) => [h, [...qs]] as [string, number[]]));
  /** Whose row this is: the estimate's at the line's own count, the estimate's with a count typed over it, or nobody's (the crew's). */
  const identity = (half: string, qty: number | null): "untouched" | "typed" | "none" => {
    const qs = left.get(half);
    if (!qs?.length) return "none";
    const i = qs.indexOf(Number(qty));
    if (i !== -1) {
      qs.splice(i, 1);
      return "untouched";
    }
    qs.splice(0, 1);
    return "typed";
  };
  const isPlaceholder = (r: PlainRow) => !r.his && r.description.endsWith(HOW_MANY) && Number(r.quantity) === 1;
  const plan: PlainPlan<T> = { insert: [], recount: [], remove: [], kept: [], countsDiffer: [], carried: 0 };
  for (const l of lines) {
    const same = free.filter((r) => r.half === l.half);
    if (!same.length) {
      plan.insert.push(l.row);
      continue;
    }
    const pick = same.find((r) => Number(r.quantity) === l.qty) ?? same.find((r) => !r.his) ?? same[0];
    free.splice(free.indexOf(pick), 1);
    const its = identity(l.half, pick.quantity);
    if (Number(pick.quantity) === l.qty) {
      plan.carried++;
      continue;
    }
    const placeholder = isPlaceholder(pick);
    if (!pick.his && (placeholder || its === "untouched")) {
      const unit = l.unit && (pick.unit ?? "ea") !== l.unit ? l.unit : undefined;
      plan.recount.push({
        id: pick.id,
        description: pick.description,
        from: pick.quantity,
        to: l.qty,
        ...(placeholder ? { words: pick.description.slice(0, -HOW_MANY.length) } : {}),
        ...(unit ? { unit } : {}),
      });
      continue;
    }
    plan.countsDiffer.push({ description: pick.description, shows: pick.quantity, estimate: l.qty });
  }
  for (const r of free) {
    const its = identity(r.half, r.quantity);
    if (its === "none") continue; // the crew's: never the estimate's to remove
    (r.his || its === "typed" ? plan.kept : plan.remove).push(r);
  }
  return plan;
}

export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
export const few = (names: string[]): string => (names.length ? ` (${names.slice(0, 3).join(", ")}${names.length > 3 ? ", …" : ""})` : "");

/** What an adopted list did with the estimate's plain lines, as a sentence — or null when nothing changed. */
export function takeOffWords(res: Pick<TakeOffResult, "follow">, lead = "The crew's list is this estimate's now"): string | null {
  const f = res.follow;
  if (!f) return null;
  const bits: string[] = [];
  if (f.added) bits.push(`${plural(f.added, "line", "lines")} added`);
  if (f.recounted.length) bits.push(`${f.recounted.length} re-counted${few(f.recounted)}`);
  if (f.removed.length) bits.push(`${f.removed.length} removed${few(f.removed)} — not on this estimate`);
  if (f.kept.length) bits.push(`${f.kept.length} kept${few(f.kept)} — bought, a tool, or a count you typed, though not on this estimate`);
  for (const w of f.failed) bits.push(w);
  for (const c of f.countsDiffer.slice(0, 3)) bits.push(`${c.description} shows ${c.shows ?? "no count"}, the estimate says ${c.estimate}`);
  if (f.countsDiffer.length > 3) bits.push(`${f.countsDiffer.length - 3} more counts differ`);
  return bits.length ? `${lead}: ${bits.join(" · ")}.` : null;
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
    .select("id, job_id")
    .eq("quote_id", quoteId)
    .limit(1)
    .maybeSingle();
  if (existingList) {
    // THE LIST FOLLOWS THE ESTIMATE ONTO ITS JOB (audit v1085, carried): a list made from a draft with no
    // job (Create Material List) stayed job-less when the estimate got one — the job's Materials tab read
    // empty while the sync kept writing into it, and the crew's first Add minted a second list.
    const had = existingList as { id: string; job_id: string | null };
    if (!had.job_id && quote.job_id) {
      let lq = supabase.from("material_lists").update({ job_id: quote.job_id }).eq("id", had.id).is("job_id", null);
      if (orgId) lq = lq.eq("org_id", orgId);
      const { data: linked, error: lErr } = await lq.select("id");
      if (lErr || !linked?.length) reportError("takeOffFromQuote:linkList", lErr ?? new Error("zero rows"), { quoteId, listId: had.id });
    }
    return { ok: true, id: had.id, jobId: quote.job_id ?? null };
  }
  // A REPLACED ESTIMATE, OR A REVISION NOT YET ACCEPTED, MAKES NO LIST (audit v1085, carried): a newer list
  // on the job would become the one list every reader shows and hide the crew's. The revision's own take-off
  // happens when it is accepted, adopting that list.
  const status = (quote as { status?: string }).status;
  if (status === "superseded") return { ok: false, error: "This estimate was replaced by a revision — make the list from that one." };
  if ((quote as { revises_quote_id?: string | null }).revises_quote_id && status !== "accepted")
    return { ok: false, error: "This revision isn't accepted yet — accept it, and the crew's list becomes its own." };

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

  // THE PRICE BOOK FIRST (audit v1085): read before any list row exists, so a failed read leaves no
  // empty list behind that the idempotent return above would hand back as "the list" for good.
  const { findPl, error: bookErr } = await readPriceBook(supabase, orgId);
  if (bookErr) return { ok: false, error: `The price book could not be read (${bookErr}) — nothing was taken off. Try again.` };

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
  let adoptedFromOriginal = false;
  const revises = (quote as { revises_quote_id?: string | null }).revises_quote_id ?? null;
  const originalHalves = new Map<string, number[]>();
  if (quote.job_id && status === "accepted") {
    let ownQ = supabase.from("material_lists").select("id, quote_id").eq("job_id", quote.job_id);
    if (orgId) ownQ = ownQ.eq("org_id", orgId);
    const { data: own } = await ownQ.order("created_at", { ascending: false }).order("id", { ascending: false }).limit(1).maybeSingle();
    const canonical = own as { id: string; quote_id: string | null } | null;
    let fromOriginal = !!(canonical && revises && canonical.quote_id === revises);
    if (canonical && canonical.quote_id && revises && !fromOriginal) {
      // A REVISION OF A REVISION (audit v1085, carried): the crew's list may still be the FIRST estimate's —
      // the one in between was never accepted, so it never adopted. Walk the chain upward (bounded, a cycle
      // stops at the first repeat): the list of any estimate this one replaces is the list to adopt.
      const seen = new Set<string>([quote.id]);
      let cur: string | null = revises;
      for (let hop = 0; cur && !seen.has(cur) && hop < 12 && !fromOriginal; hop++) {
        seen.add(cur);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let aq: any = supabase.from("quotes").select("revises_quote_id").eq("id", cur);
        if (orgId) aq = aq.eq("org_id", orgId);
        const { data: anc, error: aErr }: { data: { revises_quote_id?: string | null } | null; error: { message: string } | null } = await aq.maybeSingle();
        if (aErr) return { ok: false, error: `The estimates this one revises could not be read (${dbError(aErr)}) — nothing was taken off. Try again.` };
        cur = (anc as { revises_quote_id?: string | null } | null)?.revises_quote_id ?? null;
        if (cur && cur === canonical.quote_id) fromOriginal = true;
      }
      if (!fromOriginal) {
        // A SIBLING (the skeptic's case): two revisions of one original, the first accepted and holding the
        // crew's list, then the second accepted — supersedeRevised moved the first, so its list is this
        // estimate's to adopt too, bought marks and all, instead of a second list hiding them.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let hq: any = supabase.from("quotes").select("revises_quote_id, status").eq("id", canonical.quote_id);
        if (orgId) hq = hq.eq("org_id", orgId);
        const { data: holder, error: hErr }: { data: { revises_quote_id?: string | null; status?: string | null } | null; error: { message: string } | null } = await hq.maybeSingle();
        if (hErr) return { ok: false, error: `The estimate holding the crew's list could not be read (${dbError(hErr)}) — nothing was taken off. Try again.` };
        if (holder?.status === "superseded" && holder.revises_quote_id && seen.has(holder.revises_quote_id)) fromOriginal = true;
      }
    }
    if (canonical && (canonical.quote_id === null || fromOriginal)) {
      // THE ORIGINAL'S PLAIN LINES (a revision, 0391; Erik 2026-10-11): which unkeyed rows on the list it
      // adopts are the ESTIMATE'S own rows — those FOLLOW the revision (planPlainRows below) — and which
      // are the crew's. Read BEFORE the adoption is written, so a failed read changes nothing.
      if (fromOriginal) {
        let oq = supabase.from("quote_line_items").select("description, quantity, unit, detail").eq("quote_id", canonical.quote_id as string);
        if (orgId) oq = oq.eq("org_id", orgId);
        const { data: olines, error: oErr } = await oq;
        if (oErr) return { ok: false, error: `The estimate this revises could not be read (${dbError(oErr)}) — nothing was taken off. Try again.` };
        for (const l of (olines ?? []) as any[]) {
          const p = plainLineOf(l, findPl);
          if (p) originalHalves.set(p.half, [...(originalHalves.get(p.half) ?? []), p.qty]);
        }
      }
      let tq = supabase.from("material_lists").update({ quote_id: quote.id }).eq("id", canonical.id);
      tq = fromOriginal ? tq.eq("quote_id", canonical.quote_id as string) : tq.is("quote_id", null);
      const { data: took, error: tErr } = await tq.select("id");
      if (tErr) reportError("takeOffFromQuote:adopt", tErr, { quoteId, listId: canonical.id });
      if (took?.length) {
        list = { id: canonical.id };
        adopted = true;
        adoptedFromOriginal = fromOriginal;
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

  // The price book (read above; RLS-scoped to this org, or scoped here) resolves each material line to
  // its REAL buy cost, catalog #, and vendor (readPriceBook: "[CODE]" first, then the normalized
  // description; tools are archived, so they never land on an order sheet).
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
  // ON AN ADOPTED LIST the new rows go after what the crew already has, and the estimate's PLAIN lines are
  // matched to the rows the list carries UNKEYED — by code else words (planPlainRows): the crew's rows, the
  // visit's typed items and, on a REVISION, the original estimate's own rows, which FOLLOW (Erik
  // 2026-10-11): an unbought one takes the revision's count or goes when its line is gone; a bought one is
  // kept and said; a row of the crew's is never the estimate's to change. Everything it did is said
  // (takeOffWords) — nothing on the sheet moves in silence.
  let so = 0;
  const unkeyed: PlainRow[] = [];
  const plainLines: PlainLine<Row>[] = [];
  if (adopted) {
    let haveQ = supabase.from("material_list_items").select("id, sort_order, part_number, description, source_key, quantity, unit, purchased, is_tool").eq("list_id", list.id);
    if (orgId) haveQ = haveQ.eq("org_id", orgId);
    const { data: had, error: hErr } = await haveQ.order("sort_order");
    if (hErr) return { ok: false, error: dbError(hErr) };
    for (const r of (had ?? []) as Array<{ id: string; sort_order: number | null; part_number: string | null; description: string | null; source_key: string | null; quantity: number | null; unit?: string | null; purchased: boolean | null; is_tool: boolean | null }>) {
      so = Math.max(so, (r.sort_order ?? -1) + 1);
      if (r.source_key) continue;
      unkeyed.push({ id: r.id, half: plainRowHalf(r), quantity: r.quantity, description: String(r.description ?? ""), unit: r.unit ?? null, his: r.purchased === true || r.is_tool === true });
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
      // THIS MANY OF THE TASK (cn-v1133): each part's count × the line's quantity, the birth's own rule
      // (partQtyFor); a part he never counted stays the "how many?" placeholder at any quantity.
      const qty = lineQty(it);
      for (const m of keyParts(`line:${it.id}`, task.materials.filter((x) => x.name.trim()))) {
        const name = m.name.trim();
        rows.push({ ...taskPartRow(list.id, orgId, { code: m.code, name, qty: partQtyFor(m.qty, qty), cost: m.cost, source_key: m.key }, findPl(m.code, name)), sort_order: so++ });
      }
      continue;
    }
    const plain = plainLineOf(it, findPl); // the one reading of a plain line (the sync's too)
    if (!plain) continue; // an order sheet carries materials, never labor
    const { code, cleanDesc, pl } = plain;
    const row: Row = {
      list_id: list.id,
      ...stamp,
      description: cleanDesc || it.description,
      part_number: pl?.code ?? code ?? null,
      quantity: plain.qty,
      unit: it.unit || pl?.unit || "ea",
      vendor: pl?.supplier ?? null,
      // matched → the book's real buy price, at the vendor the line names when it names one;
      // unmatched → estimate price with the markup removed. `vendor` stays the item's supplier:
      // a vendor option is the BRAND (Marvin), the supplier is where it is bought, and the brand
      // is already in the description.
      est_cost: pl ? bookLineBuy(pl, cleanDesc).buyPrice : it.unit_price != null ? costFromSell(Number(it.unit_price)) : null,
      sort_order: 0,
    };
    if (adopted) plainLines.push({ half: plain.half, qty: plain.qty, unit: row.unit, row });
    else rows.push({ ...row, sort_order: so++ });
  }

  const plan = adopted ? planPlainRows(plainLines, unkeyed, originalHalves) : null;
  for (const r of plan?.insert ?? []) rows.push({ ...r, sort_order: so++ });

  // Catalog orgs (Tahoe Deck): the granular MATERIAL kits (Framing, Hardware, Decking…) are
  // the POST-ACCEPTANCE purchasing breakdown — deliberately kept OFF the estimate, seeded onto
  // the job's materials list here so the crew has the buy-list grouped by scope. Prefixed with
  // the kit name (material_list_items has no group column). Only on first creation (idempotent
  // return above), so re-running never duplicates the groups. RLS scopes kits to this org on a
  // user client; the company's id scopes them on the service client.
  // On a list adopted from the ORIGINAL estimate (0391) the groups are there already — the crew's bought
  // marks on them. The job's own list (a visit's, a hand add) never had them (audit v1085, carried): seeded
  // after the crew's rows. A TASK KIT (hours per unit) prices a task line and is never a buy-list group
  // (partsKitsOnly, the same rule the kit pickers use).
  if (settings.estimating_mode === "catalog" && !adoptedFromOriginal) {
    // THE SHARED SELECT SHAPE (kit-line.ts), tolerant of 0166/0240 not having landed. A LINKED
    // line (0240) puts the ITEM on the order sheet: its description, catalog #, unit, vendor and
    // — the whole point — its BUY price as est_cost, not a sell price to back a markup out of.
    // A frozen line keeps today's behaviour (its unit_price as the estimate).
    const { data: matKits } = await firstThatWorks(
      taskKitSelectRungs().map((sel) => () => {
        let q = supabase.from("kits").select(sel).not("name", "in", '("Decks","Remodels")');
        if (orgId) q = q.eq("org_id", orgId);
        return q.order("name");
      }),
    );
    for (const k of partsKitsOnly((matKits ?? []) as any[])) {
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

  if (!plan) {
    // A FRESH LIST: the plain and kit rows (unkeyed — no other door writes those) in one write, then the
    // task parts (keyed) through insertKeyedRows, so a key another door already holds (0393: the sync got
    // there first) can only ever refuse the keyed batch, and only the missing keys are written. The door
    // is idempotent (the list exists now), so a lost write is said with the way out, not "try again".
    const unkeyed = rows.filter((r) => !r.source_key);
    const keyed = rows.filter((r): r is Row & { source_key: string } => !!r.source_key);
    if (unkeyed.length) {
      const { data: seeded, error: itemsErr } = await supabase.from("material_list_items").insert(unkeyed).select("id");
      if (itemsErr) return { ok: false, error: dbError(itemsErr) };
      if ((seeded?.length ?? 0) !== unkeyed.length) return { ok: false, error: "The list was created but its lines didn't save — open it and add them." };
    }
    if (keyed.length) {
      const k = await insertKeyedRows(supabase, list.id, orgId, keyed);
      if (k.error) return { ok: false, error: `The list was created but the task parts didn't save (${dbError(k.error)}) — open it and add them.` };
    }
    return { ok: true, id: list.id, jobId: quote.job_id ?? null };
  }

  // AN ADOPTED LIST — THE ORDER OF WRITES (the skeptic's case): ADD first, then re-count, then take away, so a
  // failure part way leaves the crew with more than they need, never less. The list IS this estimate's
  // now (the next call opens it, it cannot be re-run), so what could not be done is SAID on an ok result
  // with the one way out, and reported — never a refusal that a retry cannot honour. Every write is
  // conditional on what was read (the count, not bought, not a tool: a change made meanwhile is his, said).
  const countsDiffer = [...plan.countsDiffer];
  const recounted: string[] = [];
  const removed: string[] = [];
  const kept = plan.kept.map((r) => r.description);
  const failed: string[] = [];
  const follow: PlainFollow = { added: 0, carried: plan.carried, recounted, removed, kept, countsDiffer, failed };
  const done = () => ({ ok: true, id: list!.id, jobId: quote.job_id ?? null, adopted: true, follow });
  if (rows.length) {
    // Unkeyed rows only (a task line's parts are the sync's on an adopted list; a plain or kit row has no
    // key), so 0393's unique index cannot refuse this write.
    const { data: seeded, error: itemsErr } = await supabase.from("material_list_items").insert(rows).select("id");
    const n = seeded?.length ?? 0;
    follow.added = itemsErr ? 0 : n;
    if (itemsErr || n !== rows.length) {
      reportError("takeOffFromQuote:seed", itemsErr ?? new Error(`${n} of ${rows.length} rows saved`), { quoteId, listId: list.id });
      failed.push(`${plural(rows.length - follow.added, "line", "lines")} could not be added${itemsErr ? ` (${dbError(itemsErr)})` : ""} — add them on the list; nothing else was changed`);
      return done(); // nothing is re-counted or removed on a list that did not get its new lines
    }
  }
  for (const r of plan.recount) {
    const patch = { quantity: r.to, ...(r.words ? { description: r.words } : {}), ...(r.unit ? { unit: r.unit } : {}) };
    let uq = supabase.from("material_list_items").update(patch).eq("id", r.id).eq("list_id", list.id).eq("purchased", false).eq("is_tool", false).eq("quantity", r.from);
    if (orgId) uq = uq.eq("org_id", orgId);
    const { data, error } = await uq.select("id");
    if (error) {
      reportError("takeOffFromQuote:recount", error, { quoteId, listId: list.id, rowId: r.id });
      failed.push(`${r.words ?? r.description} could not be re-counted (${dbError(error)}) — set it to ${r.to} on the list`);
      continue;
    }
    if (data?.length) recounted.push(`${r.words ?? r.description} ${r.from ?? "?"} → ${r.to}`);
    else countsDiffer.push({ description: r.description, shows: r.from, estimate: r.to }); // changed or bought meanwhile: his
  }
  if (plan.remove.length) {
    let dq = supabase.from("material_list_items").delete().in("id", plan.remove.map((r) => r.id)).eq("list_id", list.id).eq("purchased", false).eq("is_tool", false);
    if (orgId) dq = dq.eq("org_id", orgId);
    const { data, error } = await dq.select("id");
    if (error) {
      reportError("takeOffFromQuote:remove", error, { quoteId, listId: list.id });
      failed.push(`${plural(plan.remove.length, "line", "lines")} the estimate dropped could not be removed (${dbError(error)}) — remove ${plan.remove.map((r) => r.description).slice(0, 3).join(", ")}${plan.remove.length > 3 ? ", …" : ""} on the list`);
    } else {
      const gone = new Set(((data ?? []) as Array<{ id: string }>).map((r) => r.id));
      for (const r of plan.remove) (gone.has(r.id) ? removed : kept).push(r.description);
    }
  }
  return done();
}
