import { buyMaterialsTitle } from "@/lib/materials-checklist";
import type { ActionItem, Affordance } from "./types";

/**
 * ONE NAMED BUTTON PER ROW, AND ⋯ (Wave 1, W1-13).
 *
 * The row used to end in a strip of grey icons (a calendar, a person, a clock, an X, a chevron) and a
 * 20px box: five guesses per row, none of them saying what it did. Now each row has ONE button that
 * says its verb ("Send It", "Pick A Day", "Close Out"), and behind lane 1a's ⋯ (RowMoreSheet) only
 * what is real for that row: a Snooze that picks a day, Assign on a job needing a day, and the row's
 * honest ending behind a confirm (Lost, Not Needed, Didn't Happen, Cancel, Set Aside). Tapping the
 * row still opens it. The words Dismiss and Delete never appear.
 *
 * ONE TABLE, read by the list and by anything else that names what a row can do (Nort next wave), so
 * the two can never offer different doors. Every verb a door here sends is one of the row's own
 * affordances, and dispatch-map.ts resolves every (kind, verb) to a registry action
 * (dispatch.test.ts walks this whole table).
 */

export type RowAct =
  /** Opens a page. */
  | { type: "open"; href: string }
  /** Dials a number. */
  | { type: "call"; tel: string }
  /** Sends the verb straight away (Called, Close Out, Take Off Hold). */
  | { type: "run"; verb: Affordance }
  /** Asks for a day (the day picker), then sends the verb with it (Pick A Day). */
  | { type: "pickDay"; verb: "schedule" }
  /**
   * Asks when it comes back (the ComeBackPicker, In A Week picked), then sends the verb with the day
   * (and the words, when asked). askWhy: Why? is shown (never required).
   */
  | { type: "comeBack"; verb: "snooze"; askWhy: boolean; button: string }
  /** Asks who (never the unpicked default: blocksCrewWipe), then sends the verb with the person. */
  | { type: "assign"; verb: "assign" }
  /** An ending, behind a confirm that says what it does. */
  | { type: "confirm"; verb: Affordance; title: string; body: string; button: string; keep: string }
  /** Lane 4's Send sheet: who, how much, how many lines, then Email It or Text It. */
  | { type: "send" }
  /** A pile opens in place (or its list page, when it can't show every row here). */
  | { type: "unfold" };

export type RowDoor = { label: string; act: RowAct };

export type RowButtons = {
  /** The row's one named button, or null (a tech's visit only opens; a rollup carries its own cards). */
  primary: RowDoor | null;
  /** A second button drawn beside it: only a hold whose day has come (Snooze and Take Off Hold). */
  also: RowDoor | null;
  /** What ⋯ holds. Empty: no ⋯ at all. */
  more: RowDoor[];
};

const open = (label: string, href: string): RowDoor => ({ label, act: { type: "open", href } });
const has = (item: Pick<ActionItem, "affordances">, v: Affordance) => item.affordances.includes(v);

/** The words every ending's confirm is built from. `what` names the row. */
function ending(verb: Affordance, label: string, title: string, body: string, button: string): RowDoor {
  return { label, act: { type: "confirm", verb, title, body, button, keep: "Keep It" } };
}

export function rowButtons(item: ActionItem, ctx: { leadsOn?: boolean; isStaff: boolean }): RowButtons {
  const none: RowButtons = { primary: null, also: null, more: [] };
  const leadsOn = ctx.leadsOn !== false;
  const what = item.title;

  if (item.pile) return { primary: { label: item.pile.verb, act: { type: "unfold" } }, also: null, more: [] };
  // A "Couldn't Check" line only opens the page that can say what it couldn't.
  if (item.id.endsWith("-unread")) return none;

  const snooze = (askWhy: boolean): RowDoor | null =>
    has(item, "snooze") ? { label: "Snooze", act: { type: "comeBack", verb: "snooze", askWhy, button: "Snooze" } } : null;
  const endlessSnooze = item.waitKey ? snooze(true) : null;

  switch (item.kind) {
    case "supplier_paper":
      // Nothing new: its cards carry Put It On J-0xx / Another Job / Shop Stock / Business Cost /
      // Already Billed, one tap each.
      return none;
    case "supplier_pay":
      return ctx.isStaff ? { ...none, primary: open(`Pay ${item.payee?.trim() || "Supplier"}`, item.href) } : none;
    case "time_stray":
      // Already Billed stays on the row (its own door, drawn by the list).
      return { ...none, primary: open(item.chip === "Clock Left Running" ? "Fix The Clock" : "Put On A Job", item.href) };
    case "visit_unbilled": {
      const billed = item.chip === "Billed, Not Paid";
      const onJob = item.id.startsWith("jdone-");
      return {
        primary: open(billed ? "Get Paid" : "Bill It", item.href),
        also: null,
        more: has(item, "dismiss")
          ? [
              ending(
                "dismiss",
                "Cancel",
                onJob ? "Cancel This Job?" : "Cancel This Visit?",
                `Marks ${what} cancelled, so nothing is billed for it and it leaves Needs You. You can change it back on the ${onJob ? "job" : "visit"}.`,
                onJob ? "Cancel The Job" : "Cancel The Visit",
              ),
            ]
          : [],
      };
    }
    case "quote_draft":
      return {
        primary: item.send ? { label: "Send It", act: { type: "send" } } : open("Send It", item.href),
        also: null,
        more: has(item, "dismiss")
          ? [
              ending(
                "dismiss",
                "Not Needed",
                "Not Needed?",
                `Marks ${what} declined, so it stops asking. Nothing is sent to anyone, and you can change it back on the estimate.`,
                "Not Needed",
              ),
            ]
          : [],
      };
    case "quote_awaiting":
      return {
        primary: has(item, "snooze") ? { label: "Still Waiting", act: { type: "comeBack", verb: "snooze", askWhy: false, button: "Still Waiting" } } : null,
        also: null,
        more: has(item, "dismiss")
          ? [ending("dismiss", "Lost", "Didn't Win It?", `Records ${what} as lost, so it stops asking. The estimate is marked declined; you can change it back on its own page.`, "Mark It Lost")]
          : [],
      };
    case "quote_accepted":
      return {
        ...none,
        primary: has(item, "schedule") && item.targetId ? { label: "Pick A Day", act: { type: "pickDay", verb: "schedule" } } : open("Pick A Day", item.href),
      };
    case "inquiry": {
      const call: RowDoor | null = item.phone ? { label: leadsOn ? "Call" : "Call Back", act: { type: "call", tel: item.phone } } : null;
      const called: RowDoor | null = has(item, "do") ? { label: "Called", act: { type: "run", verb: "do" } } : null;
      const lost = has(item, "dismiss")
        ? ending(
            "dismiss",
            "Lost",
            "Lost This One?",
            `Marks ${what} lost, so it leaves Needs You. It stays on the ${leadsOn ? "Leads list" : "request's page"} as lost, and you can set it back there.`,
            "Mark It Lost",
          )
        : null;
      if (leadsOn) {
        return { primary: called, also: null, more: [call, snooze(false), lost].filter((d): d is RowDoor => !!d) };
      }
      // Leads switched off: Call Back stays the button (the person asking for work is not switched off).
      return call
        ? { primary: call, also: null, more: [called, lost].filter((d): d is RowDoor => !!d) }
        : { primary: called, also: null, more: [lost].filter((d): d is RowDoor => !!d) };
    }
    case "appointment":
      // A tech's visit only opens: closing it out is the office's (appointment.setStatus is staff).
      if (!has(item, "do")) return none;
      return {
        primary: { label: "Close Out", act: { type: "run", verb: "do" } },
        also: null,
        more: has(item, "dismiss")
          ? [ending("dismiss", "Didn't Happen", "Didn't Happen?", `Marks ${what} cancelled, so it stops asking. You can change it back on the visit.`, "Didn't Happen")]
          : [],
      };
    case "inspection_writeup":
      return {
        primary: open("Write It Up", item.href),
        also: null,
        more: has(item, "dismiss")
          ? [ending("dismiss", "Lost", "Didn't Win It?", `Records ${what} as lost, so it stops asking. The walk-through is marked lost; you can change it back on its own page.`, "Mark It Lost")]
          : [],
      };
    case "job_to_schedule":
      return {
        primary: has(item, "schedule") ? { label: "Pick A Day", act: { type: "pickDay", verb: "schedule" } } : open("Pick A Day", item.href),
        also: null,
        more: [
          has(item, "assign") ? { label: "Assign", act: { type: "assign", verb: "assign" } } : null,
          has(item, "do")
            ? ending(
                "do",
                "Finish",
                "Finish This Job?",
                `Marks ${what} complete. Its bill is drafted from the job's own record, or what isn't billed yet is named, and nothing is sent.`,
                "Finish It",
              )
            : null,
          has(item, "dismiss")
            ? ending("dismiss", "Cancel", "Cancel This Job?", `Marks ${what} cancelled, so it leaves the schedule and Needs You. You can change it back on the job.`, "Cancel The Job")
            : null,
        ].filter((d): d is RowDoor => !!d),
      };
    case "materials_needed":
      return {
        primary: open(item.openToBuy ? buyMaterialsTitle({ open: item.openToBuy }) : "Buy Materials", item.href),
        also: null,
        more: endlessSnooze ? [endlessSnooze] : [],
      };
    case "job_unbilled_work":
      return { primary: open("Add Costs", item.href), also: null, more: endlessSnooze ? [endlessSnooze] : [] };
    case "job_on_hold": {
      // Both visible (Erik's answer): the reminder's two real answers. The Snooze asks why only when
      // the hold has no reason saved.
      const s = has(item, "snooze")
        ? ({ label: "Snooze", act: { type: "comeBack", verb: "snooze", askWhy: !(item.holdReason ?? "").trim(), button: "Snooze" } } as RowDoor)
        : null;
      const off = has(item, "do") ? ({ label: "Take Off Hold", act: { type: "run", verb: "do" } } as RowDoor) : null;
      return { primary: s ?? off, also: s ? off : null, more: [] };
    }
    case "invoice_overdue":
      return { ...none, primary: open("Get Paid", item.href) };
    case "invoice_draft":
      return {
        primary: open("Send It", item.href),
        also: null,
        more: has(item, "snooze") ? [{ label: "Set Aside Until…", act: { type: "comeBack", verb: "snooze", askWhy: true, button: "Set Aside" } }] : [],
      };
    case "receipt_unbilled":
      return { ...none, primary: open("Record It", item.href) };
    case "organize": {
      const primary = open(item.paper === "organize" ? "File It" : "Sort It", item.href);
      return {
        primary,
        also: null,
        more: has(item, "dismiss")
          ? [ending("dismiss", "Set Aside", "Set It Aside?", `Puts ${what} in the Archive, so it leaves Needs You. You can bring it back from the Archive in Organize My.`, "Set It Aside")]
          : [],
      };
    }
    case "stock_short":
      return { ...none, primary: open("Settle It", item.href) };
    case "lien_deadline":
      return { ...none, primary: open("See Deadline", item.href) };
    case "contract_unsigned":
      return { ...none, primary: open("See Contract", item.href) };
    default:
      return none;
  }
}

/** Every door a row offers, in order: its button, the second one, then ⋯. */
export function allDoors(b: RowButtons): RowDoor[] {
  return [b.primary, b.also, ...b.more].filter((d): d is RowDoor => !!d);
}

/** The verb a door sends, when it sends one (a page, a call, the Send sheet or a pile send none). */
export function doorVerb(d: RowDoor): Affordance | null {
  const a = d.act;
  return a.type === "run" || a.type === "pickDay" || a.type === "comeBack" || a.type === "assign" || a.type === "confirm" ? a.verb : null;
}
