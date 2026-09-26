import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ALL_ON, offFeatureKey, featuresFromOffKey, type FeatureMap } from "@/lib/features";
import { AFFORDANCES, KIND_STREAM, type ActionKind } from "./types";
import { FEEDER_SWITCHES, LIVE_OBLIGATIONS, feederOn, inquiryActionItem } from "./switches";

/**
 * NEEDS YOU AND THE SWITCH BOARD (0352). A switched-off feature's nudges leave the inbox; the live
 * obligations keep coming while their rows exist (rule c); the switches reach the cached reader as
 * ONE plain string, so the shell's badge and My Day's list still share one fan-out (rule m).
 */
const off = (...keys: (keyof FeatureMap)[]) => ({ ...ALL_ON, ...Object.fromEntries(keys.map((k) => [k, false])) }) as FeatureMap;
const KINDS = Object.keys(KIND_STREAM) as ActionKind[];
const src = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

describe("feederOn — which Needs You feeders a switch turns off", () => {
  it("everything on: every feeder runs (Needs You exactly as before)", () => {
    for (const k of KINDS) expect(feederOn(k, ALL_ON), k).toBe(true);
    for (const k of KINDS) expect(feederOn(k, featuresFromOffKey("")), k).toBe(true);
  });

  it("Estimates off: the started-never-sent nudge goes, and so does the walk-through write-up", () => {
    expect(feederOn("quote_draft", off("estimates"))).toBe(false);
    expect(feederOn("inspection_writeup", off("estimates"))).toBe(false);
  });

  it("Leads off: the walk-through write-up goes", () => {
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

describe("inquiryActionItem — a request on Needs You", () => {
  const row = { id: "i1", name: "Dana Reyes", status: "new", next_follow_up_at: null, phone: "(530) 555-0142" };

  it("Leads on: the lead row exactly as it always was, with no phone and no Call Back", () => {
    expect(inquiryActionItem(row, "2026-09-26", true)).toEqual({
      id: "i1",
      kind: "inquiry",
      title: "Dana Reyes",
      subtitle: "New lead — reach out",
      who: null,
      when: null,
      urgency: 2,
      done: false,
      href: "/leads?focus=i1",
      affordances: AFFORDANCES.inquiry,
    });
  });

  it("Leads off: 'New Request From Dana Reyes', Call them back, and the number to dial", () => {
    const it2 = inquiryActionItem(row, "2026-09-26", false);
    expect(it2.title).toBe("New Request From Dana Reyes");
    expect(it2.subtitle).toBe("Call them back");
    expect(it2.phone).toBe("(530) 555-0142");
    // Same record, same urgency, same door (the list renders with the Off line on top).
    expect(it2.href).toBe("/leads?focus=i1");
    expect(it2.urgency).toBe(2);
    expect(it2.kind).toBe("inquiry");
  });

  it("Leads off, a follow-up with no phone: plain words and no Call Back to render", () => {
    const it3 = inquiryActionItem({ ...row, status: "contacted", phone: null, next_follow_up_at: "2026-09-20" }, "2026-09-26", false);
    expect(it3.title).toBe("Request From Dana Reyes");
    expect(it3.subtitle).toBe("Follow up");
    expect(it3.phone).toBeNull();
    expect(it3.urgency).toBe(1);
  });

  it("a nameless request still reads as a sentence", () => {
    expect(inquiryActionItem({ ...row, name: null }, "2026-09-26", false).title).toBe("New Request From Someone");
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
    expect(query).toContain("inquiryActionItem(q, todayStr, leadsOn)");
    expect(query).not.toMatch(/feederOn\("inquiry"/);
  });

  it("the shell's badge and My Day pass the SAME string, so they share one fan-out", () => {
    expect(src("src/app/(app)/layout.tsx")).toContain("off: offFeatureKey(features)");
    expect(src("src/app/(app)/planner/page.tsx")).toContain("off: offFeatureKey(features)");
    // and it is a value comparison: two maps with the same switches give the same key.
    expect(offFeatureKey(off("leads", "nort"))).toBe(offFeatureKey({ ...off("nort"), leads: false }));
  });
});
