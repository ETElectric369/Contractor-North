import { describe, it, expect } from "vitest";
import { KIND_PICTURE, type PictureId } from "./kind-picture";
import { AFFORDANCES, type ActionKind, type Group } from "./types";
import { GROUP_ORDER, KIND_GROUP } from "./needs-you-rule";
import { pileOf } from "./piles";

/**
 * A PICTURE PER KIND OF ACTION (cn-v1162). Every kind has one; a pile's kinds share one, so its header
 * can wear it; and inside any one tile a picture names one kind of action, so two kinds share a picture
 * there only where the owner's table says they share the action.
 */
const KINDS = Object.keys(AFFORDANCES) as ActionKind[];

/** The only pictures two kinds may share inside one tile, and the kinds that share them. */
const SHARED_IN_A_TILE: Partial<Record<PictureId, readonly ActionKind[]>> = {
  pick_day: ["job_to_schedule", "quote_accepted"],
  bill: ["job_unbilled_work", "visit_unbilled"],
};

describe("KIND_PICTURE", () => {
  it("every kind has a picture, and its keys are in AFFORDANCES' order, like KIND_GROUP's", () => {
    expect(Object.keys(KIND_PICTURE)).toEqual(KINDS);
    expect(Object.keys(KIND_PICTURE)).toEqual(Object.keys(KIND_GROUP));
    for (const k of KINDS) expect(KIND_PICTURE[k], k).toMatch(/^[a-z_]+$/);
  });

  it("is the owner's table: eighteen pictures over twenty-two kinds", () => {
    expect(new Set(Object.values(KIND_PICTURE)).size).toBe(18);
    expect(KIND_PICTURE).toEqual({
      job_to_schedule: "pick_day",
      inquiry: "call",
      appointment: "visit",
      inspection_writeup: "visit",
      organize: "sort",
      invoice_overdue: "collect",
      quote_awaiting: "waiting",
      quote_accepted: "pick_day",
      invoice_draft: "send",
      visit_unbilled: "bill",
      quote_draft: "send",
      lien_deadline: "deadline",
      contract_unsigned: "sign",
      time_stray: "hours",
      job_unbilled_work: "bill",
      materials_needed: "buy",
      job_on_hold: "hold",
      stock_short: "stock",
      supplier_paper: "papers",
      supplier_pay: "discount",
      receipt_unbilled: "cost",
      permit_inspection: "permit",
    });
  });

  it("every pile's kinds share one picture: a pile's header wears it", () => {
    const byPile = new Map<string, Set<PictureId>>();
    for (const kind of KINDS) {
      for (const paper of [undefined, "tray", "organize", "bank"] as const) {
        const p = pileOf({ kind, id: "x", paper });
        if (p) byPile.set(p, new Set([...(byPile.get(p) ?? []), KIND_PICTURE[kind]]));
      }
    }
    expect(byPile.size).toBeGreaterThan(10);
    for (const [p, pictures] of byPile) expect(pictures.size, p).toBe(1);
  });

  it("inside one tile two kinds share a picture only where the table says they share the action", () => {
    for (const g of GROUP_ORDER) {
      const byPicture = new Map<PictureId, ActionKind[]>();
      for (const k of KINDS.filter((k) => KIND_GROUP[k] === g)) byPicture.set(KIND_PICTURE[k], [...(byPicture.get(KIND_PICTURE[k]) ?? []), k]);
      for (const [picture, kinds] of byPicture) {
        if (kinds.length === 1) continue;
        expect([...kinds].sort(), `${g}: ${picture}`).toEqual(SHARED_IN_A_TILE[picture]);
      }
    }
    // And each allowed pair is in one tile, so the allowance is not hiding a pair across tiles.
    for (const kinds of Object.values(SHARED_IN_A_TILE)) expect(new Set(kinds!.map((k) => KIND_GROUP[k] as Group)).size).toBe(1);
  });
});
