import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { leadRidesItsWriteUp, lessRidden } from "./lead-rides-its-writeup";

describe("a lead whose visit is waiting to be written up rides the write-up row", () => {
  it("keeps the lead's own row out only when its visit is on the write-up list", () => {
    const writeUps = new Set(["lead-tilda"]);
    expect(leadRidesItsWriteUp("lead-tilda", writeUps)).toBe(true);
    expect(leadRidesItsWriteUp("lead-rowan", writeUps)).toBe(false);
    expect(leadRidesItsWriteUp(null, writeUps)).toBe(false);
    expect(leadRidesItsWriteUp(undefined, writeUps)).toBe(false);
  });

  it("takes the ridden rows off the pile's exact count, and never leaves a zero pile", () => {
    expect(lessRidden({ total: 60 }, 2)).toEqual({ total: 58 });
    expect(lessRidden({ total: 2 }, 2)).toEqual({});
    expect(lessRidden({}, 2)).toEqual({});
    expect(lessRidden({ total: 7, capped: true }, 1)).toEqual({ total: 6, capped: true });
  });

  // cn-v1170: no fold for a lead any more (no follow-up day), so the one loop is the Now loop.
  it("query.ts builds the write-up rows first and skips those leads in the lead loop", () => {
    const src = readFileSync(new URL("./query.ts", import.meta.url), "utf8");
    const writeUps = src.indexOf("const writeUpLeadIds = new Set<string>()");
    const nowLoop = src.indexOf("for (const q of (inqR.data ?? []) as InquiryRow[])");
    expect(writeUps).toBeGreaterThan(-1);
    expect(writeUps).toBeLessThan(nowLoop);
    expect(src.slice(nowLoop, nowLoop + 200)).toContain("leadRidesItsWriteUp(q.id, writeUpLeadIds)");
    expect(src).not.toContain("inqLaterR");
    expect(src).toContain("counts.leads_to_call = lessRidden(leadCount, leadsRidden)");
    expect(src).toContain('if (a.inquiry_id) writeUpLeadIds.add(String(a.inquiry_id));');
  });
});
