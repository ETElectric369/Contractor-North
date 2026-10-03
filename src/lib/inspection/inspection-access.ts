/**
 * WHO FILLS IN THE INSPECTION (0356). Erik, 2026-09-26: "crew leader yes tech no".
 *
 *   office    staff (owner / admin / office): everything, as before: the price book, scope prices,
 *             Start The Estimate, the address, the links.
 *   crewLead  a crew lead (profiles.crew_lead, set only by an owner or admin) who is ON this visit
 *             (assigned_to = him, the rule 0227 reads by): the sheet's answers, notes, measurements,
 *             materials and photos. Never a price, the price book or Start The Estimate; never the
 *             schedule, status, customer, address or links; he adds photos and never takes one off.
 *   view      everyone else who can open the visit (a plain tech on his own visit): read-only.
 *
 * The database is the boundary (save_walkthrough_capture checks the same rule and holds a crew lead's
 * save to capture only); this is what the page renders from. `rpcReady` is the page's probe of that
 * function: before 0356 is applied a crew lead sees the read-only inspection, never a Save that
 * cannot work.
 */
import { parsePlaybook } from "@/lib/playbook/parse";

export type InspectionAccess = "office" | "crewLead" | "view";

export function inspectionAccess(v: {
  isStaff: boolean;
  crewLead: boolean;
  onThisVisit: boolean;
  rpcReady: boolean;
}): InspectionAccess {
  if (v.isStaff) return "office";
  if (v.crewLead && v.onThisVisit && v.rpcReady) return "crewLead";
  return "view";
}

/** PostgREST (PGRST202) or Postgres (42883) saying the function isn't there: 0356 not applied yet. */
export const isMissingRpc = (e: { code?: string | null } | null | undefined): boolean =>
  !!e && (e.code === "PGRST202" || e.code === "42883");

/** PostgREST (PGRST205, not in its schema cache) or Postgres (42P01, undefined table) saying the
 *  view isn't there: 0366 not applied yet. Nothing else: a refusal, a timeout or a broken function
 *  inside the view is an error, never a reason to read somewhere else. */
export const isMissingView = (e: unknown): boolean => {
  const code = String((e as { code?: unknown } | null)?.code ?? "");
  return code === "PGRST205" || code === "42P01";
};

/** The two stand-ins 0366 made, each for the table whose priced column it guards. */
export const INSPECTION_VIEWS = {
  /** appointments.inspection_answers: revoked from the signed-in role; the view strips prices for anyone but the office. */
  answers: { view: "appointment_answers", table: "appointments" },
  /** forms.playbook: a non-office reader reads a playbook form only here, without its money. */
  sheets: { view: "form_playbooks", table: "forms" },
} as const;

type Reader = { from: (relation: string) => any };

/**
 * READ THROUGH THE VIEW, OR, UNTIL THE VIEW EXISTS, THE TABLE (LEAK-0227, 0366).
 *
 * A push deploys before its migration, so every inspection read asks the view first and, ONLY when
 * the view isn't on this database yet (isMissingView), asks the table exactly as before: the app
 * works before 0366 runs and reads through it after. Any other error comes back as the error, with
 * `via` saying which read it was: tolerateMissingColumns alone would have swallowed "the view is
 * missing" and a real failure alike, and a swallowed answers read renders an EMPTY inspection whose
 * first keystroke autosaves the emptiness over the real one.
 *
 * `read` gets the relation's query builder and builds the same select on either (the view carries
 * every column these reads name).
 */
export async function readViaView<T>(
  supabase: Reader,
  which: keyof typeof INSPECTION_VIEWS,
  read: (from: any) => PromiseLike<{ data: T | null; error: unknown }>,
): Promise<{ data: T | null; error: unknown; via: "view" | "table" }> {
  const { view, table } = INSPECTION_VIEWS[which];
  const v = await read(supabase.from(view));
  if (!v.error) return { data: v.data ?? null, error: null, via: "view" };
  if (!isMissingView(v.error)) return { data: null, error: v.error, via: "view" };
  const t = await read(supabase.from(table));
  return { data: t.error ? null : (t.data ?? null), error: t.error ?? null, via: "table" };
}

/** An inspection read's failure, in words the page shows in place of the sheet it couldn't read. */
export const INSPECTION_UNREAD =
  "Couldn't read this inspection just now, so it isn't shown (nothing on it changed). Reload the page to try again.";

/**
 * THE ANSWERS, WITH NO PRICE IN THEM, for anyone who isn't the office.
 *
 * A scopes question stores [{code, qty, price}] (lib/playbook/scopes.ts), and the page hands the
 * stored answers to the browser. The crew's Inspector never draws a price, but a price in the page's
 * payload has already left the building, so it is taken out on the server before it goes. Only the
 * `price` key goes: the code and quantity say what was picked. The database keeps the office's
 * priced answers whatever a crew lead's save sends back (save_walkthrough_capture).
 */
export function answersWithoutPrices<T extends Record<string, unknown>>(answers: T | null | undefined): T {
  const src = (answers && typeof answers === "object" ? answers : {}) as Record<string, unknown>;
  const strip = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map((x) => (x && typeof x === "object" && !Array.isArray(x) ? omitPrice(x as Record<string, unknown>) : x));
    if (v && typeof v === "object") return omitPrice(v as Record<string, unknown>);
    return v;
  };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) out[k] = strip(v);
  return out as T;
}

/** A dollar figure, and the rate unit that follows one: "$400", "$1,250.00", "$4.50/ft", "$2k", "$90 per hr". */
const MONEY = /\s*\$\s?\d[\d,]*(?:\.\d+)?(?:\s?[kKmM]\b)?(?:\s?(?:\/|per\s+)\s?[A-Za-z][A-Za-z.]*)?/g;

/** The sentence with its dollar figures taken out: "turns a $400 circuit into a panel swap" reads
 *  "turns a circuit into a panel swap". */
export function withoutMoney(s: string): string {
  return s
    .replace(MONEY, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.;:!?)])/g, "$1")
    .trim();
}

/**
 * THE SHEETS, WITH NO MONEY IN THEM, for anyone who isn't the office.
 *
 * A written playbook's `why` is, by definition, where the answer ends up in the PRICE ("Zinsco or FPE
 * turns a $400 circuit into a panel swap"), and its `note` is the owner's own voice, which "never
 * appears on a job" (lib/playbook/types). The Inspector draws the why under every question, and the
 * page hands the whole forms row to the browser, so both would reach a crew lead or a tech. On the
 * server, before it goes: every `note` is dropped, and every `why` keeps its words without its dollar
 * figures (dropped when nothing is left). A sheet with no written playbook carries neither and goes
 * as it is; one with a playbook still has one, so the Inspector's default-sheet pick doesn't change.
 */
export function sheetsWithoutMoney<T extends { playbook?: unknown }>(sheets: readonly T[]): T[] {
  return sheets.map((s) => {
    if (!s.playbook) return s;
    const needs = parsePlaybook(s.playbook).needs.map((need) => {
      const { note: _note, why, ...rest } = need;
      void _note;
      const w = why ? withoutMoney(why) : "";
      return w ? { ...rest, why: w } : rest;
    });
    return { ...s, playbook: { needs } };
  });
}

function omitPrice(o: Record<string, unknown>): Record<string, unknown> {
  if (!("price" in o)) return o;
  const { price: _drop, ...rest } = o;
  void _drop;
  return rest;
}

/**
 * A crew lead's photo list: every photo already on the inspection stays, in its place, and the
 * ones he adds follow. He adds; the office takes one off. Merged on the server before the save, so a
 * photo the office added while his page was open is kept rather than refused. `next` is what he
 * ADDS (the photos just taken), never his page's whole list: a stale list would bring back a photo
 * the office took off.
 */
export function keepStoredPhotos(stored: readonly string[], next: readonly string[]): string[] {
  return [...new Set([...stored, ...next])];
}
