import { featureOn, type FeatureKey, type FeatureMap } from "@/lib/features";
import { AFFORDANCES, type ActionItem, type ActionKind } from "./types";

/**
 * NEEDS YOU AND THE SWITCH BOARD (0352). A switched-off feature's NUDGES leave the inbox (rule a):
 * each kind named here runs only while every switch it names is on, and its read is skipped too.
 * Every kind not named here always runs.
 */
export const FEEDER_SWITCHES: Partial<Record<ActionKind, readonly FeatureKey[]>> = {
  // An estimate started and never sent: an Estimates nudge.
  quote_draft: ["estimates"],
  // An inspection that happened and was never written up: a Leads & Inspections nudge, and its
  // door is the estimate builder, so it needs Estimates too.
  inspection_writeup: ["leads", "estimates"],
  // A permit still waiting on the town or the utility: a Permits & Inspections nudge, and its door is
  // the job's Permits tab. A company that does no permit work (the trade defaults switch it off for
  // landscaping and painting) has no permits to wait on, and its read is skipped.
  permit_inspection: ["permits"],
};

/**
 * LIVE OBLIGATIONS (rule c): these keep reaching Needs You while their rows exist, whatever the
 * switches say, because somebody outside the company is waiting on them or money is held up:
 *   inquiry            a request from the website or a lead door (every public door keeps working
 *                      with Leads off); with Leads off it reads "New Request from …" + Call Back
 *   quote_awaiting     an estimate already in the customer's hands
 *   quote_accepted     a customer said yes
 *   contract_unsigned  a contract already sent
 *   lien_deadline      a legal clock
 *   stock_short        pieces taken past the shelf bill nothing until settled (Took from Stock
 *                      goes with the switch, so no new ones are made)
 * switches.test.ts pins that none of them ever gets a switch above.
 */
export const LIVE_OBLIGATIONS: readonly ActionKind[] = [
  "inquiry",
  "quote_awaiting",
  "quote_accepted",
  "contract_unsigned",
  "lien_deadline",
  "stock_short",
];

/** Does this feeder run for a company with these switches? */
export function feederOn(kind: ActionKind, features: FeatureMap): boolean {
  return (FEEDER_SWITCHES[kind] ?? []).every((k) => featureOn(features, k));
}

export type InquiryRow = {
  id: string;
  name: string | null;
  status: string;
  next_follow_up_at: string | null;
  phone?: string | null;
};

/**
 * One request on Needs You. Leads on: the lead row, its button Called, and (when there's a number)
 * Call behind its ⋯. Leads off: the same request, in plain words ("New Request from Dana"), with the
 * phone number its Call Back button dials: the lead list is out of the way, the person asking for
 * work is not. The card still opens the request itself (/leads?focus=, which renders with the Off
 * line). The row table (row-buttons.ts) decides which button says what.
 */
export function inquiryActionItem(q: InquiryRow, todayStr: string, leadsOn: boolean): Omit<ActionItem, "group"> {
  const overdue = q.next_follow_up_at != null && q.next_follow_up_at <= todayStr;
  const fresh = q.status === "new";
  const phone = (q.phone ?? "").trim() || null;
  // WHO AND WHAT, for the box (cn-v1161): the person's name in bold, else the word for nobody named,
  // and the phrase as a key. Leads off says it as a request, the way its title does.
  const named = (q.name ?? "").trim() || null;
  const item: Omit<ActionItem, "group"> = {
    id: q.id,
    kind: "inquiry",
    title: q.name as string,
    subtitle: fresh ? "New lead — reach out" : "Follow up",
    who: named,
    ...(named ? {} : { whoSay: { key: "ny_who_someone" } }),
    what: { key: leadsOn ? (fresh ? "ny_w_leadNew" : "ny_w_leadFollowUp") : fresh ? "ny_w_requestNew" : "ny_w_requestFollowUp" },
    when: q.next_follow_up_at,
    // A brand-new, uncontacted lead is the hottest thing on the board (speed-to-lead wins
    // the job) → top urgency, which the one rule (needs-you-rule) reads as a Win Work row to act on soon.
    // An overdue follow-up is next; a contacted, on-schedule lead is normal.
    urgency: fresh ? 2 : overdue ? 1 : 0,
    done: false,
    // Deep-link to THIS lead (not the bare list) so a tap on My Day scrolls to and
    // flashes the exact row — the "new leads clickable on My Day" nerve.
    href: `/leads?focus=${q.id}`,
    affordances: AFFORDANCES.inquiry,
    ...(phone ? { phone } : {}),
  };
  if (leadsOn) return item;
  const who = (q.name ?? "").trim() || "Someone";
  return {
    ...item,
    // Its chip says Request (Wave 1, W1-15: the row carries its own words; the list has no Leads
    // header left to rename).
    chip: "Request",
    title: fresh ? `New Request from ${who}` : `Request from ${who}`,
    subtitle: fresh ? "Call them back" : "Follow up",
    phone,
  };
}
