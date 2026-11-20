import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ALL_ON, offFeatureKey, featuresFromOffKey, type FeatureMap } from "@/lib/features";
import { AFFORDANCES, KIND_GROUP, type ActionKind } from "./types";
import { FEEDER_SWITCHES, LIVE_OBLIGATIONS, feederOn, inquiryActionItem } from "./switches";

/**
 * NEEDS YOU AND THE SWITCH BOARD (0352). A switched-off feature's nudges leave the inbox; the live
 * obligations keep coming while their rows exist (rule c); the switches reach the cached reader as
 * ONE plain string, so the shell's badge and My Day's list still share one fan-out (rule m).
 */
const off = (...keys: (keyof FeatureMap)[]) => ({ ...ALL_ON, ...Object.fromEntries(keys.map((k) => [k, false])) }) as FeatureMap;
const KINDS = Object.keys(KIND_GROUP) as ActionKind[];
const src = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

describe("feederOn — which Needs You feeders a switch turns off", () => {
  it("everything on: every feeder runs (Needs You exactly as before)", () => {
    for (const k of KINDS) expect(feederOn(k, ALL_ON), k).toBe(true);
    for (const k of KINDS) expect(feederOn(k, featuresFromOffKey("")), k).toBe(true);
  });

  it("Estimates off: the started-never-sent nudge goes, and so does the inspection write-up", () => {
    expect(feederOn("quote_draft", off("estimates"))).toBe(false);
    expect(feederOn("inspection_writeup", off("estimates"))).toBe(false);
  });

  it("Leads off: the inspection write-up goes", () => {
    expect(feederOn("inspection_writeup", off("leads"))).toBe(false);
    expect(feederOn("quote_draft", off("leads"))).toBe(true);
  });

  it("the LIVE OBLIGATIONS never get a switch: they run with EVERY switch off", () => {
    const allOff = featuresFromOffKey(Object.keys(ALL_ON).join(","));
    for (const k of LIVE_OBLIGATIONS) {
      expect(FEEDER_SWITCHES[k], k).toBeUndefined();
      expect(feederOn(k, allOff), k).toBe(true);
    }
    expect(LIVE_OBLIGATIONS).toEqual(expect.arrayContaining(["inquiry", "quote_awaiting", "quote_accepted", "contract_unsigned", "lien_deadline"]));
  });

  it("money feeders are never switched: overdue and draft invoices, unbilled work, stray time", () => {
    for (const k of ["invoice_overdue", "invoice_draft", "visit_unbilled", "job_unbilled_work", "time_stray", "supplier_paper", "supplier_pay"] as ActionKind[])
      expect(FEEDER_SWITCHES[k], k).toBeUndefined();
  });
});

describe("inquiryActionItem — a lead on Needs You (cn-v1170: the Leads list's own row)", () => {
  const at = "2026-09-24T17:00:00Z";
  const row = { id: "i1", name: "Dana Rook", status: "new", phone: "(530) 555-0142", created_at: at };

  it("Leads on: the lead row, its clock and its day the day it came in, opening the lead's file", () => {
    expect(inquiryActionItem(row, true)).toEqual({
      id: "i1",
      kind: "inquiry",
      title: "Dana Rook",
      subtitle: "New lead — reach out",
      who: "Dana Rook",
      what: { key: "ny_w_leadNew" },
      when: at,
      clock: at,
      urgency: 2,
      done: false,
      href: "/leads/i1",
      affordances: AFFORDANCES.inquiry,
      phone: "(530) 555-0142",
    });
    // No number: no phone on the row, so no Call anywhere.
    expect(inquiryActionItem({ ...row, phone: null }, true).phone).toBeUndefined();
  });

  it("no follow-up day: a reached lead keeps the clock from its arrival and says it is not booked yet", () => {
    const reached = inquiryActionItem({ ...row, status: "contacted" }, true);
    expect(reached.clock).toBe(at);
    expect(reached.when).toBe(at);
    expect(reached.what).toEqual({ key: "ny_w_leadReached" });
    expect(reached.urgency).toBe(1);
    // A row with no day in has no clock at all (the build's read always carries created_at).
    expect(inquiryActionItem({ ...row, created_at: null }, true).clock).toBeNull();
  });

  it("its doors: Schedule, then Call and Not Sold behind ⋯; no Called, no Snooze", async () => {
    const { rowButtons } = await import("./row-buttons");
    const on = rowButtons({ ...inquiryActionItem(row, true), group: KIND_GROUP.inquiry }, { leadsOn: true, isStaff: true });
    expect(on.primary).toEqual({ label: "Schedule", act: { type: "open", href: "/leads/i1?schedule=1" } });
    expect(on.more.map((d) => d.label)).toEqual(["Call", "Not Sold"]);
    expect(AFFORDANCES.inquiry).toEqual(["dismiss", "open"]);
    // Leads off: Call Back is the button, Not Sold behind ⋯, and no Schedule (it books an inspection).
    const offB = rowButtons({ ...inquiryActionItem(row, false), group: KIND_GROUP.inquiry }, { leadsOn: false, isStaff: true });
    expect(offB.primary).toEqual({ label: "Call Back", act: { type: "call", tel: "(530) 555-0142" } });
    expect(offB.more.map((d) => d.label)).toEqual(["Not Sold"]);
  });

  it("Leads off: 'New Request from Dana Rook', Call them back, and the number to dial", () => {
    const it2 = inquiryActionItem(row, false);
    expect(it2.title).toBe("New Request from Dana Rook");
    expect(it2.subtitle).toBe("Call them back");
    expect(it2.phone).toBe("(530) 555-0142");
    // Its chip rides on the row (Wave 1, W1-15): the flat list has no Leads header to rename.
    expect(it2.chip).toBe("Request");
    expect(it2.href).toBe("/leads/i1");
    expect(it2.urgency).toBe(2);
    expect(it2.kind).toBe("inquiry");
  });

  it("Leads off, a reached request with no phone: plain words and no Call Back to render", () => {
    const it3 = inquiryActionItem({ ...row, status: "contacted", phone: null }, false);
    expect(it3.title).toBe("Request from Dana Rook");
    expect(it3.subtitle).toBe("Called back");
    expect(it3.what).toEqual({ key: "ny_w_requestReached" });
    expect(it3.phone).toBeNull();
    expect(it3.urgency).toBe(1);
  });

  it("a nameless request still reads as a sentence", () => {
    expect(inquiryActionItem({ ...row, name: null }, false).title).toBe("New Request from Someone");
  });
});

describe("the wiring (structural)", () => {
  const query = src("src/lib/action-items/query.ts");

  it("the cache key carries the switches as a plain string, never the map (rule m)", () => {
    expect(query).toContain("ctx.off ?? \"\"");
    expect(query).toMatch(/cache\(\s*\(todayStr: string, isStaff: boolean, userId: string, tz: string, off: string\)/);
  });

  it("the gated feeders skip their reads, and the request feeder runs whatever Leads says", () => {
    expect(query).toContain('isStaff && feederOn("quote_draft", features)');
    expect(query).toContain('isStaff && feederOn("inspection_writeup", features)');
    expect(query).toContain("inquiryActionItem(q, leadsOn)");
    expect(query).not.toMatch(/feederOn\("inquiry"/);
  });

  it("the shell's badge and My Day pass the SAME string, so they share one fan-out", () => {
    expect(src("src/app/(app)/layout.tsx")).toContain("off: offFeatureKey(features)");
    expect(src("src/app/(app)/planner/page.tsx")).toContain("off: offFeatureKey(features)");
    // and it is a value comparison: two maps with the same switches give the same key.
    expect(offFeatureKey(off("leads", "nort"))).toBe(offFeatureKey({ ...off("nort"), leads: false }));
  });
});
