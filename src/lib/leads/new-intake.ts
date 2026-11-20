import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * NEW INTAKE: WHICH LEADS ARE ON THE LEADS LIST, AND WHAT STAGE A LEAD IS AT (cn-v1170).
 *
 * Erik, 2026-11-19, after going through the flow with two other contractors: "so the idea is that if
 * a lead is still on the lead page that IS the reminder and the follow up reminders dont really work,
 * one badge one list simple, right? so once a lead has been scheduled or Not Sold they come off the
 * leads page".
 *
 * So the list is not a status and not a follow-up day. A lead is ON THE LIST while it is OPEN (not
 * converted, not Not Sold) and NO VISIT MADE FROM IT IS STILL STANDING. Nothing is stamped on the
 * lead when it is scheduled: the rule reads the visits, so a visit that is dismissed or cancelled
 * puts its lead back on the list by itself, and one that is booked takes it off (stamp follows deed).
 * (A visit that ENDS Not Sold marks its lead Not Sold in the same deed: appointments/actions
 * setAppointmentOutcome. That is the one stamp, because Not Sold is the lead's own ending.)
 *
 * ONE RULE, EVERY READER: the Leads page, the Sales badge, Needs You's lead rows, the morning push
 * and the assistant's sweep all come through here, so the badge and the list cannot disagree.
 *
 * IN DOUBT, A LEAD IS OFFERED AND NEVER HIDDEN. A visit in a state this rule has not been taught does
 * not stand, and a lead whose visits could not be read stays on the list (and is named in `unread`,
 * so a caller can say so). A lead shown twice costs a tap; a lead nobody lists is lost business.
 *
 * Pure rule + one reader. No catalog (a lib never imports one), no money column.
 */

/** The stored word for a lead that is Not Sold. The database value did not change with the name. */
export const NOT_SOLD_STATUS = "lost";

/** The lead's own columns the rule reads. */
export type LeadStageRow = { status?: string | null; converted_at?: string | null };

/** One visit made from a lead, as the rule reads it. */
export type LeadVisitRow = {
  inquiry_id: string | null;
  status: string | null;
  outcome: string | null;
  /** When it is booked for. On a visit still waiting on the customer's pick: the first time offered. */
  starts_at: string | null;
};

/** What every reader of the rule selects from `appointments`. */
export const LEAD_VISIT_COLUMNS = "inquiry_id, status, outcome, starts_at";

/** OPEN: not converted into anything, and not Not Sold. */
export function isOpenLead(lead: LeadStageRow): boolean {
  return !lead.converted_at && lead.status !== NOT_SOLD_STATUS;
}

const STANDING_STATUSES: ReadonlySet<string> = new Set(["scheduled", "proposed", "completed"]);

/** Nobody has said how it ended. Won, Not Sold (`lost`, or the older `no_bid`) and an ending the rule
 *  was never taught are all answers, and an answered visit keeps nobody off the list. */
function undecided(outcome: string | null | undefined): boolean {
  return (outcome ?? "") === "";
}

/** The times were sent to the customer and no pick came back before the first one went by. */
function pickRanOut(visit: Pick<LeadVisitRow, "status" | "starts_at">, nowMs: number): boolean {
  if (visit.status !== "proposed") return false;
  const at = visit.starts_at ? Date.parse(visit.starts_at) : NaN;
  return !(at > nowMs);
}

/**
 * A VISIT STANDS while it is on the books and nobody has said how it ended: booked, waiting for a day,
 * or done and not yet written up. It does not stand once it is cancelled or has an ending. A status or
 * an ending the rule has not been taught stands for nothing (see the header: offered, never hidden).
 *
 * WON IS AN ENDING, AND IT DOES NOT STAND (cn-v1171, skeptic #74). The win is finished by picking its
 * job, which converts the lead, and a converted lead is on no list whatever its visits say. A visit
 * marked Won with no job picked (the ending card closed early, or the assistant's outcome door) left
 * its lead open, kept off the Leads list by this rule and filed off the Inspections list by its
 * ending: on no list at all. Now that lead is back on the Leads list, named in `wonPending` so its row
 * can say what is left to do. In doubt a lead is offered, never hidden.
 *
 * A VISIT WAITING ON THE CUSTOMER'S PICK STANDS ONLY UNTIL THE FIRST TIME OFFERED GOES BY (skeptic
 * #73). While the customer has times to choose from there is nothing for the office to do, so the
 * lead is off the list. Once the first one passes with no pick, nothing else in the app would say
 * so: the lead comes back onto the list, which is the reminder, and is named in `pickPending` so its
 * row can say the times were sent. The follow-up day used to do this; it is gone, and this is what
 * took its place. A pick that comes in later books the visit, and the lead leaves again.
 * Dated by argument: `nowMs` is the caller's clock.
 */
export function visitStands(visit: Pick<LeadVisitRow, "status" | "outcome" | "starts_at">, nowMs: number): boolean {
  if (!STANDING_STATUSES.has(String(visit.status ?? ""))) return false;
  if (!undecided(visit.outcome)) return false;
  return !pickRanOut(visit, nowMs);
}

/** A visit on the books that was marked Won: what `wonPending` collects. Its lead is converted when
 *  the job is picked; until then nothing else would say the win is unfinished. */
export function visitWasWon(visit: Pick<LeadVisitRow, "status" | "outcome">): boolean {
  return STANDING_STATUSES.has(String(visit.status ?? "")) && visit.outcome === "won";
}

/** A pick-a-time request that ran out with no answer and no ending: what `pickPending` collects. */
export function pickWentUnanswered(
  visit: Pick<LeadVisitRow, "status" | "outcome" | "starts_at">,
  nowMs: number,
): boolean {
  return (visit.outcome ?? "") === "" && pickRanOut(visit, nowMs);
}

/**
 * WHERE A LEAD IS, for the doors a screen draws:
 *  - `open`: on the Leads list (Schedule, Not Sold, Edit Details);
 *  - `standing`: a visit made from it is on the books, so it is on the Inspections side;
 *  - `notSold`: kept on file for later (Reopen);
 *  - `converted`: it became an estimate, a job or a customer.
 * The stamps outrank the visits: a converted or Not Sold lead is that, whatever its visits say.
 */
export type LeadStage = "open" | "standing" | "notSold" | "converted";

export function leadStage(lead: LeadStageRow, hasStandingVisit: boolean): LeadStage {
  if (lead.converted_at) return "converted";
  if (lead.status === NOT_SOLD_STATUS) return "notSold";
  return hasStandingVisit ? "standing" : "open";
}

/** A batch of lead ids and the rows one request may carry. PromiseLike, because a Supabase query
 *  builder is awaited without being a Promise. */
export type LeadVisitsQuery = (
  ids: string[],
  cap: number,
) => PromiseLike<{ data: LeadVisitRow[] | null; error: unknown }>;

/** A uuid is 36 characters and `in.(…)` puts them in the URL: fifty stays under two kilobytes. The
 *  same three numbers the board's older visits read settled on (lib/leads/visit-read). */
export const STANDING_IDS_PER_REQUEST = 50;
export const STANDING_ROW_CAP = 500;
export const STANDING_REQUESTS_AT_ONCE = 4;

export type StandingRead = {
  /** Leads with at least one standing visit: off the Leads list. */
  standing: ReadonlySet<string>;
  /** Leads whose visits could NOT be read (a failed batch, or one that came back at its row cap).
   *  They are in neither set's favour: the rule keeps them on the list. */
  unread: ReadonlySet<string>;
  /** Leads with nothing standing whose pick-a-time request ran out unanswered: on the list, and
   *  their row says the times were sent. */
  pickPending: ReadonlySet<string>;
  /** Leads with nothing standing that have a visit marked Won: on the list (they are still open, so
   *  no job was picked), and their row says so. */
  wonPending: ReadonlySet<string>;
};

/**
 * Which of these leads have a standing visit, read in batches. A batch that errors, or comes back
 * at its cap, marks THAT batch's leads unread and the rest are still answered.
 */
export async function readStanding(
  ids: readonly string[],
  query: LeadVisitsQuery,
  nowMs: number,
): Promise<StandingRead> {
  const standing = new Set<string>();
  const unread = new Set<string>();
  const unanswered = new Set<string>();
  const won = new Set<string>();
  const unique = [...new Set(ids.filter(Boolean))];
  const batches: string[][] = [];
  for (let i = 0; i < unique.length; i += STANDING_IDS_PER_REQUEST) {
    batches.push(unique.slice(i, i + STANDING_IDS_PER_REQUEST));
  }
  for (let w = 0; w < batches.length; w += STANDING_REQUESTS_AT_ONCE) {
    const wave = batches.slice(w, w + STANDING_REQUESTS_AT_ONCE);
    const answers = await Promise.all(
      wave.map(async (batch) => {
        try {
          return await query(batch, STANDING_ROW_CAP);
        } catch (error) {
          return { data: null, error };
        }
      }),
    );
    wave.forEach((batch, n) => {
      const { data, error } = answers[n];
      if (error || !data || data.length >= STANDING_ROW_CAP) {
        for (const id of batch) unread.add(id);
        return;
      }
      for (const row of data) {
        if (!row.inquiry_id) continue;
        if (visitStands(row, nowMs)) standing.add(row.inquiry_id);
        else if (pickWentUnanswered(row, nowMs)) unanswered.add(row.inquiry_id);
        else if (visitWasWon(row)) won.add(row.inquiry_id);
      }
    });
  }
  const pickPending = new Set([...unanswered].filter((id) => !standing.has(id)));
  const wonPending = new Set([...won].filter((id) => !standing.has(id)));
  return { standing, unread, pickPending, wonPending };
}

/** `readStanding` over a Supabase client. `orgId` is for a client that row-level security does not
 *  fence (a cron's service client): house law, such a read always names the company. `nowMs` is
 *  for a test; everyone else reads the clock here, once. */
export function standingFor(
  supabase: SupabaseClient,
  ids: readonly string[],
  opts: { orgId?: string | null; nowMs?: number } = {},
): Promise<StandingRead> {
  return readStanding(
    ids,
    (batch, cap) => {
      let q = supabase.from("appointments").select(LEAD_VISIT_COLUMNS).in("inquiry_id", batch).neq("status", "cancelled");
      if (opts.orgId) q = q.eq("org_id", opts.orgId);
      return q.limit(cap) as unknown as PromiseLike<{ data: LeadVisitRow[] | null; error: unknown }>;
    },
    opts.nowMs ?? Date.now(),
  );
}

/** The open leads that are new intake: every one with no standing visit. A lead whose visits could
 *  not be read is in neither set, so it stays. */
export function newIntakeOnly<T extends { id: string }>(openLeads: readonly T[], read: StandingRead): T[] {
  return openLeads.filter((lead) => !read.standing.has(lead.id));
}

export type NewIntake<T> = {
  /** The leads on the Leads list, in the order read. */
  leads: T[];
  /** Ids in `leads` that are there only because their visits could not be read. */
  unread: ReadonlySet<string>;
  /** Ids in `leads` whose pick-a-time request ran out unanswered (see `visitStands`). */
  pickPending: ReadonlySet<string>;
  /** Ids in `leads` that have a visit marked Won and no job picked (see `visitStands`). */
  wonPending: ReadonlySet<string>;
  /** The lead read's own failure. `leads` is then empty and the caller must say it could not load:
   *  an empty list and a failed read are not the same answer. */
  error: unknown | null;
  /** The lead read came back AT its `limit`, so there may be more open leads than were read. A
   *  caller that draws a count says "or more" on it; without a limit this is always false. */
  capped: boolean;
};

export type NewIntakeOptions = {
  /** Name the company on a client that row-level security does not fence. */
  orgId?: string | null;
  /** The most leads to read. Unset: whatever the API returns (the page's own behaviour). */
  limit?: number;
  /** Oldest first (a push names the lead that has waited longest). Default: newest first. */
  oldestFirst?: boolean;
  /** The clock, for a test. */
  nowMs?: number;
};

/**
 * THE LEADS LIST, read once: the open leads with `columns` (which must include `id`), then their
 * standing visits, then the rule. Every reader that needs rows comes through here.
 */
export async function loadNewIntake<T extends { id: string }>(
  supabase: SupabaseClient,
  columns: string,
  opts: NewIntakeOptions = {},
): Promise<NewIntake<T>> {
  let q = supabase.from("inquiries").select(columns).is("converted_at", null).neq("status", NOT_SOLD_STATUS);
  if (opts.orgId) q = q.eq("org_id", opts.orgId);
  q = q.order("created_at", { ascending: !!opts.oldestFirst });
  if (opts.limit) q = q.limit(opts.limit);
  const { data, error } = await q;
  if (error || !data) {
    return {
      leads: [],
      unread: new Set(),
      pickPending: new Set(),
      wonPending: new Set(),
      error: error ?? new Error("leads: no rows returned"),
      capped: false,
    };
  }
  const open = data as unknown as T[];
  const capped = !!opts.limit && open.length >= opts.limit;
  const read = await standingFor(
    supabase,
    open.map((l) => l.id),
    { orgId: opts.orgId, nowMs: opts.nowMs },
  );
  const leads = newIntakeOnly(open, read);
  const kept = new Set(leads.map((l) => l.id));
  const among = (ids: ReadonlySet<string>) => new Set([...ids].filter((id) => kept.has(id)));
  return { leads, unread: among(read.unread), pickPending: among(read.pickPending), wonPending: among(read.wonPending), error: null, capped };
}

/** The most open leads the badge reads. Past this the number is the count among the newest thousand,
 *  which a badge that tops out at two digits cannot tell apart. */
export const NEW_INTAKE_COUNT_CAP = 1000;

/** HOW MANY LEADS ARE ON THE LIST: the Sales badge's number. Throws on a failed lead read, so the
 *  caller files it and shows no badge (a count is cosmetic, never a crash). */
export async function countNewIntake(supabase: SupabaseClient, opts: { orgId?: string | null } = {}): Promise<number> {
  const res = await loadNewIntake<{ id: string }>(supabase, "id", { orgId: opts.orgId, limit: NEW_INTAKE_COUNT_CAP });
  if (res.error) throw res.error;
  return res.leads.length;
}
