import type { ActionKind } from "./types";

/**
 * A PICTURE PER KIND OF ACTION (cn-v1162, the owner's design, 2026-11-11: "the smaller tiles that drop
 * down get a picture with no color until they get an alert then they get a colored in picture next to
 * the alert"). Each Needs You row draws, in its own column right after the mark, a picture of WHAT
 * THERE IS TO DO about it: pick a day, call, send, collect, buy. The picture names the action, never
 * the urgency (that is the mark's job) and never the tile (that is the tile's name and, once the row is
 * marked, the picture's colour: components/action-items/kind-picture).
 *
 * Pure: no React, no catalog, no icon library. The ids are never shown; the component turns each into
 * an icon. Inside any one tile a picture names one kind of action, so two kinds share a picture only
 * where they share the action itself: a yes and a job with no day both need a day picked (Operations),
 * and a visit and a job done but not billed are both billed (Get Paid, and they share one pile). Across
 * tiles a shared picture is the same verb in a different place (send an estimate, send an invoice). A
 * pile's kinds always share one picture, so a pile's header can wear it (kind-picture.test.ts pins it).
 */
export type PictureId =
  | "pick_day"
  | "call"
  | "waiting"
  | "visit"
  | "send"
  | "sign"
  | "collect"
  | "bill"
  | "deadline"
  | "buy"
  | "hold"
  | "hours"
  | "permit"
  | "cost"
  | "stock"
  | "sort"
  | "papers"
  | "discount";

/** Each kind's picture. Its keys are in AFFORDANCES' order, like KIND_GROUP's (the test compares them). */
export const KIND_PICTURE: Record<ActionKind, PictureId> = {
  job_to_schedule: "pick_day",
  inquiry: "call",
  appointment: "visit",
  inspection_writeup: "visit",
  organize: "sort",
  invoice_overdue: "collect",
  quote_awaiting: "waiting",
  // Won: what it needs next is a day on the calendar, the same action as a job with no day.
  quote_accepted: "pick_day",
  invoice_draft: "send",
  visit_unbilled: "bill",
  quote_draft: "send",
  lien_deadline: "deadline",
  contract_unsigned: "sign",
  time_stray: "hours",
  // Shares the Done, Not Billed pile with visit_unbilled, so it shares its picture.
  job_unbilled_work: "bill",
  materials_needed: "buy",
  job_on_hold: "hold",
  stock_short: "stock",
  supplier_paper: "papers",
  supplier_pay: "discount",
  receipt_unbilled: "cost",
  permit_inspection: "permit",
};
