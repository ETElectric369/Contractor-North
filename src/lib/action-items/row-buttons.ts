import { INSPECTION_DOOR } from "./permit-inspection-items";
import type { Words } from "@/lib/lang-words";
import { nyWord } from "./row-words";
import type { PileName } from "./types";
import type { ActionItem, Affordance, AlreadyInvoicedTarget } from "./types";

/**
 * ONE NAMED BUTTON PER ROW, AND ⋯ (Wave 1, W1-13).
 *
 * The row used to end in a strip of grey icons (a calendar, a person, a clock, an X, a chevron) and a
 * 20px box: five guesses per row, none of them saying what it did. Now each row has ONE button that
 * says its verb ("Send It", "Pick a Day", "Close Out"), and behind lane 1a's ⋯ (RowMoreSheet) only
 * what is real for that row: a Snooze that picks a day, Assign on a job needing a day, and the row's
 * honest ending behind a confirm (Lost, Not Needed, Didn't Happen, Cancel, Set Aside, Not a Cost). Tapping the
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
  /** Asks for a day (the day picker), then sends the verb with it (Pick a Day). */
  | { type: "pickDay"; verb: "schedule" }
  /**
   * Asks when it comes back (the ComeBackPicker, In a Week picked), then sends the verb with the day
   * (and the words, when asked). askWhy: Why? is shown (never required).
   */
  | { type: "comeBack"; verb: "snooze"; askWhy: boolean; button: string }
  /** Asks who (never the unpicked default: blocksCrewWipe), then sends the verb with the person. */
  | { type: "assign"; verb: "assign" }
  /** An ending, behind a confirm that says what it does. */
  | { type: "confirm"; verb: Affordance; title: string; body: string; button: string; keep: string }
  /** Lane 4's Send sheet: who, how much, how many lines, then Email It or Text It. */
  | { type: "send" }
  /** The Already Invoiced sheet: pick the customer's invoice that billed it, and it is tied (no verb). */
  | { type: "alreadyInvoiced"; target: AlreadyInvoicedTarget }
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

/** The context a row's doors are said in. No language: English, byte for byte what the box always said. */
export type RowButtonsCtx = { leadsOn?: boolean; isStaff: boolean; lang?: string | null; words?: Words };

/**
 * A PILE'S VERB IN THE READER'S LANGUAGE. piles.ts keeps its English (PILE_DEFS); each verb is one of
 * the row buttons' own keys, so a pile and its first row say the same word. "Send It" is two words in
 * Spanish (an estimate is Enviarlo, an invoice Enviarla), so it is told apart by the pile's name.
 */
const PILE_VERB_KEY: Record<string, string> = {
  "Still Waiting": "ny_btn_stillWaiting",
  "Pick a Day": "ny_btn_pickADay",
  "Get Paid": "ny_btn_getPaid",
  "Bill It": "ny_btn_billIt",
  Called: "ny_btn_called",
  "Call Back": "ny_btn_callBack",
  "Close Out": "ny_btn_closeOut",
  "Open Them": "ny_btn_openThem",
  Snooze: "ny_btn_snooze",
  "Sort It": "ny_btn_sortIt",
  "File It": "ny_btn_fileIt",
  "Record It": "ny_btn_recordIt",
  "Settle It": "ny_btn_settleIt",
  "Buy Materials": "ny_btn_buyMaterials",
  "See Contract": "ny_btn_seeContract",
  "See Deadline": "ny_btn_seeDeadline",
  "See Them": "ny_btn_seeThem",
};

export function pileVerbKey(pile: { name: PileName; verb: string }): string | null {
  if (pile.verb === "Send It") return pile.name === "invoices_not_sent" ? "ny_btn_sendInvoice" : "ny_btn_sendEstimate";
  return PILE_VERB_KEY[pile.verb] ?? null;
}

/** The permit row's three doors (permit-inspection-items INSPECTION_DOOR) and its fallback, by their English. */
const PERMIT_DOOR_KEY: Record<string, string> = {
  "Book It": "ny_btn_bookIt",
  "Record Inspection Status": "ny_btn_recordInspectionStatus",
  "Book Another Visit": "ny_btn_bookAnotherVisit",
  "See the Permit": "ny_btn_seeThePermit",
};

export function rowButtons(item: ActionItem, ctx: RowButtonsCtx): RowButtons {
  const none: RowButtons = { primary: null, also: null, more: [] };
  /** A door's words: the catalog's for a Spanish reader whose caller handed its translator, else the English. */
  const L = (key: string, vars?: Record<string, string | number>) => nyWord(key, ctx, vars);
  const leadsOn = ctx.leadsOn !== false;
  const what = item.title;

  // A pile carries its rows' verb, and opens itself with it; when its rows have no button for this
  // viewer (a tech's own visits only open), neither has the pile.
  if (item.pile) {
    const first = item.children?.[0];
    const kid = first ? rowButtons(first, ctx) : null;
    const verbKey = pileVerbKey(item.pile);
    const verb = verbKey ? L(verbKey) : item.pile.verb;
    return kid?.primary ? { primary: { label: verb, act: { type: "unfold" } }, also: null, more: [] } : none;
  }
  // A "Couldn't Check" line only opens the page that can say what it couldn't.
  if (item.id.endsWith("-unread")) return none;

  // ALREADY INVOICED (2026-11-04): the bill exists, the app can't see it tie to this work. Staff only.
  const invoiced: RowDoor | null =
    ctx.isStaff && item.alreadyInvoiced ? { label: L("ny_btn_alreadyInvoiced"), act: { type: "alreadyInvoiced", target: item.alreadyInvoiced } } : null;
  const snooze = (askWhy: boolean): RowDoor | null =>
    has(item, "snooze") ? { label: L("ny_btn_snooze"), act: { type: "comeBack", verb: "snooze", askWhy, button: L("ny_btn_snooze") } } : null;
  const endlessSnooze = item.waitKey ? snooze(true) : null;

  switch (item.kind) {
    case "supplier_paper":
      // Nothing new: its cards carry Put It on J-0xx / Another Job / Shop Stock / Business Cost /
      // Already Billed, one tap each.
      return none;
    case "supplier_pay":
      return ctx.isStaff ? { ...none, primary: open(item.payee?.trim() ? L("ny_btn_payName", { name: item.payee.trim() }) : L("ny_btn_paySupplier"), item.href) } : none;
    case "time_stray":
      // Already Billed stays on the row (its own door, drawn by the list).
      return { ...none, primary: open(item.chip === "Clock Left Running" ? L("ny_btn_fixTheClock") : L("ny_btn_putOnAJob"), item.href) };
    case "visit_unbilled": {
      const billed = item.chip === "Billed, Not Paid";
      const onJob = item.id.startsWith("jdone-");
      return {
        primary: open(billed ? L("ny_btn_getPaid") : L("ny_btn_billIt"), item.href),
        also: null,
        more: [
          ...(invoiced ? [invoiced] : []),
          ...(has(item, "dismiss")
          ? [
              ending(
                "dismiss",
                L("ny_btn_cancel"),
                onJob ? "Cancel This Job?" : "Cancel This Visit?",
                `Marks ${what} cancelled, so nothing is billed for it and it leaves Needs You. You can change it back on the ${onJob ? "job" : "visit"}.`,
                onJob ? "Cancel the Job" : "Cancel the Visit",
              ),
            ]
          : []),
        ],
      };
    }
    case "quote_draft":
      return {
        primary: item.send ? { label: L("ny_btn_sendEstimate"), act: { type: "send" } } : open(L("ny_btn_sendEstimate"), item.href),
        also: null,
        more: has(item, "dismiss")
          ? [
              ending(
                "dismiss",
                L("ny_btn_notNeeded"),
                "Not Needed?",
                `Marks ${what} declined, so it stops asking. Nothing is sent to anyone, and you can change it back on the estimate.`,
                "Not Needed",
              ),
            ]
          : [],
      };
    case "quote_awaiting":
      return {
        primary: has(item, "snooze") ? { label: L("ny_btn_stillWaiting"), act: { type: "comeBack", verb: "snooze", askWhy: false, button: L("ny_btn_stillWaiting") } } : null,
        also: null,
        more: [
          has(item, "do")
            ? ending(
                "do",
                L("ny_btn_wonIt"),
                "Won It?",
                `Marks ${what} accepted: the day it was won is stamped and its job is made or caught up. Nothing is sent to anyone, and you can change it back on the estimate.`,
                "Mark It Won",
              )
            : null,
          invoiced,
          has(item, "dismiss")
            ? ending("dismiss", L("ny_btn_lost"), "Didn't Win It?", `Records ${what} as lost, so it stops asking. The estimate is marked declined; you can change it back on its own page.`, "Mark It Lost")
            : null,
        ].filter((d): d is RowDoor => !!d),
      };
    case "quote_accepted":
      return {
        primary: has(item, "schedule") && item.targetId ? { label: L("ny_btn_pickADay"), act: { type: "pickDay", verb: "schedule" } } : open(L("ny_btn_pickADay"), item.href),
        also: null,
        // The bill exists (tie it), or the work went away after all (Lost marks the estimate declined).
        more: [
          invoiced,
          has(item, "dismiss")
            ? ending("dismiss", L("ny_btn_lost"), "Lost After All?", `Marks ${what} declined, so it stops asking for a day. Its job is left as it is, and you can change the estimate back on its own page.`, "Mark It Lost")
            : null,
        ].filter((d): d is RowDoor => !!d),
      };
    case "inquiry": {
      const call: RowDoor | null = item.phone ? { label: leadsOn ? L("ny_btn_call") : L("ny_btn_callBack"), act: { type: "call", tel: item.phone } } : null;
      const called: RowDoor | null = has(item, "do") ? { label: L("ny_btn_called"), act: { type: "run", verb: "do" } } : null;
      const lost = has(item, "dismiss")
        ? ending(
            "dismiss",
            L("ny_btn_lost"),
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
        primary: { label: L("ny_btn_closeOut"), act: { type: "run", verb: "do" } },
        also: null,
        more: has(item, "dismiss")
          ? [ending("dismiss", L("ny_btn_didntHappen"), "Didn't Happen?", `Marks ${what} cancelled, so it stops asking. You can change it back on the visit.`, "Didn't Happen")]
          : [],
      };
    case "inspection_writeup":
      return {
        // OPEN THE INSPECTION, never an estimate: a tap reads or changes the report first; the estimate
        // and the job are chosen from the visit page itself. item.href is /appointments/<id>.
        primary: open(L("ld_btn_openTheInspection"), item.href),
        also: null,
        // NO "Open the Visit" UNDER ⋯ (zero duplicate doors). cn-v1071 put it here when every door on
        // this row led to a NEW estimate, so a visit that had already become a job by another road
        // (written up without the backlink) could reach its own page, where the attach door (won) is.
        // Since cn-v1157 the row's one button IS that page (item.href is /appointments/<id>, and the
        // row's id is the visit), so the ⋯ row was the same door twice under a second name.
        more: [
          ...(has(item, "wontHappen")
            ? [ending("wontHappen", L("ny_btn_didntHappen"), "Didn't Happen?", `Marks ${what} as a visit that didn't happen. It is removed if nothing was captured on it, otherwise cancelled and kept on file.`, "Didn't Happen")]
            : []),
          ...(has(item, "dismiss")
            ? [ending("dismiss", L("ny_btn_lostVisit"), "Didn't Win It?", `Records ${what} as lost, so it stops asking. The inspection is marked lost; you can change it back on its own page.`, "Mark It Lost")]
            : []),
        ],
      };
    case "job_to_schedule":
      return {
        primary: has(item, "schedule") ? { label: L("ny_btn_pickADay"), act: { type: "pickDay", verb: "schedule" } } : open(L("ny_btn_pickADay"), item.href),
        also: null,
        more: [
          has(item, "assign") ? { label: L("ny_btn_assign"), act: { type: "assign", verb: "assign" } } : null,
          has(item, "do")
            ? ending(
                "do",
                L("ny_btn_finish"),
                "Finish This Job?",
                `Marks ${what} complete. Its bill is drafted from the job's own record, or what isn't billed yet is named, and nothing is sent.`,
                "Finish It",
              )
            : null,
          has(item, "dismiss")
            ? ending("dismiss", L("ny_btn_cancel"), "Cancel This Job?", `Marks ${what} cancelled, so it leaves the schedule and Needs You. You can change it back on the job.`, "Cancel the Job")
            : null,
        ].filter((d): d is RowDoor => !!d),
      };
    case "materials_needed":
      return {
        // The same words as lib/materials-checklist buyMaterialsTitle, through the catalog (a row is listed
        // only while something is open, so "All Bought" is never this row's).
        primary: open(item.openToBuy ? L(item.openToBuy === 1 ? "ny_btn_buyMaterialsOpenOne" : "ny_btn_buyMaterialsOpen", { n: item.openToBuy }) : L("ny_btn_buyMaterials"), item.href),
        also: null,
        more: endlessSnooze ? [endlessSnooze] : [],
      };
    case "job_unbilled_work":
      return { primary: open(L("ny_btn_addCosts"), item.href), also: null, more: endlessSnooze ? [endlessSnooze] : [] };
    case "job_on_hold": {
      // Both visible (Erik's answer): the reminder's two real answers. The Snooze asks why only when
      // the hold has no reason saved.
      const s = has(item, "snooze")
        ? ({ label: L("ny_btn_snooze"), act: { type: "comeBack", verb: "snooze", askWhy: !(item.holdReason ?? "").trim(), button: L("ny_btn_snooze") } } as RowDoor)
        : null;
      const off = has(item, "do") ? ({ label: L("ny_btn_takeOffHold"), act: { type: "run", verb: "do" } } as RowDoor) : null;
      return { primary: s ?? off, also: s ? off : null, more: [] };
    }
    case "invoice_overdue":
      return { ...none, primary: open(L("ny_btn_getPaid"), item.href) };
    case "invoice_draft":
      return {
        primary: open(L("ny_btn_sendInvoice"), item.href),
        also: null,
        more: has(item, "snooze") ? [{ label: L("ny_btn_setAsideUntil"), act: { type: "comeBack", verb: "snooze", askWhy: true, button: L("ny_btn_setAside") } }] : [],
      };
    case "receipt_unbilled":
      return {
        primary: open(L("ny_btn_recordIt"), item.href),
        also: null,
        // NOT A COST (the owner, 2026-11-10: "it's a quote from my supplier not a bill, everything is
        // closed"). The paper was filed as a Receipt and never was one; Record It would add a cost
        // nobody paid. The same two words as a tray paper's Not a Cost, and the category it is filed
        // under (document.notACost, the job's own paper list rule). Saying what a paper is NOT leaves
        // its audience as it was: the office's alone, like the Receipt, never the crew's (a supplier's
        // quote carries his prices). The office's door (the action is staff-only), so a tech is never
        // handed one that only refuses.
        more:
          ctx.isStaff && has(item, "notACost")
            ? [
                ending(
                  "notACost",
                  L("ny_btn_notACost"),
                  "Not a Cost?",
                  `Files ${what} as Not a Cost, so it stops asking to be recorded. It stays with the job's papers for the office, and the crew does not see it. No cost is recorded or removed. To change it back, use the pencil under Receipts & Papers on the job's Costs tab.`,
                  "Not a Cost",
                ),
              ]
            : [],
      };
    // THE ROW'S OWN STATE PICKS THE WORDS: Book It, Record Inspection Status, or Book Another Visit. The chip
    // and the door are declared together (permit-inspection-items INSPECTION_DOOR) so they cannot
    // drift. Every one of them opens the permit's card, which is where all three are answered.
    case "permit_inspection":
      {
      const door = INSPECTION_DOOR[item.chip ?? ""] ?? "See the Permit";
      const key = PERMIT_DOOR_KEY[door];
      return { ...none, primary: open(key ? L(key) : door, item.href) };
    }
    case "organize": {
      const primary = open(item.paper === "organize" ? L("ny_btn_fileIt") : L("ny_btn_sortIt"), item.href);
      return {
        primary,
        also: null,
        more: has(item, "dismiss")
          ? [ending("dismiss", L("ny_btn_setAside"), "Set It Aside?", `Puts ${what} in the Archive, so it leaves Needs You. You can bring it back from the Archive in Organize My.`, "Set It Aside")]
          : [],
      };
    }
    case "stock_short":
      return { ...none, primary: open(L("ny_btn_settleIt"), item.href) };
    case "lien_deadline":
      return { ...none, primary: open(L("ny_btn_seeDeadline"), item.href) };
    case "contract_unsigned":
      return {
        primary: open(L("ny_btn_seeContract"), item.href),
        also: null,
        more: has(item, "do")
          ? [
              ending(
                "do",
                L("ny_btn_signedOnPaper"),
                "Signed on Paper?",
                `Records ${what} signed on paper by its customer today, so it stops asking. The wording they signed is frozen as it was sent. To name someone else or another day, use Signed on Paper on the job's contract.`,
                "Record It Signed",
              ),
            ]
          : [],
      };
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
