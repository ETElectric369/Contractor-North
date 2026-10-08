import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { leadRidesItsWriteUp, lessRidden } from "./lead-rides-its-writeup";

describe("a lead whose visit is waiting to be written up rides the write-up row", () => {
  it("keeps the lead's own row out only when its visit is on the write-up list", () => {
    const writeUps = new Set(["lead-macey"]);
    expect(leadRidesItsWriteUp("lead-macey", writeUps)).toBe(true);
    expect(leadRidesItsWriteUp("lead-braden", writeUps)).toBe(false);
    expect(leadRidesItsWriteUp(null, writeUps)).toBe(false);
    expect(leadRidesItsWriteUp(undefined, writeUps)).toBe(false);
  });

  it("takes the ridden rows off the pile's exact count, and never leaves a zero pile", () => {
    expect(lessRidden({ total: 60 }, 2)).toEqual({ total: 58 });
    expect(lessRidden({ total: 2 }, 2)).toEqual({});
    expect(lessRidden({}, 2)).toEqual({});
    expect(lessRidden({ total: 7, capped: true }, 1)).toEqual({ total: 6, capped: true });
  });

  it("query.ts builds the write-up rows first and skips those leads in both the Now loop and the fold", () => {
    const src = readFileSync(new URL("./query.ts", import.meta.url), "utf8");
    const writeUps = src.indexOf("const writeUpLeadIds = new Set<string>()");
    const nowLoop = src.indexOf("for (const q of (inqR.data ?? []) as any[])");
    const foldLoop = src.indexOf("for (const q of (inqLaterR.data ?? []) as any[])");
    expect(writeUps).toBeGreaterThan(-1);
    expect(writeUps).toBeLessThan(nowLoop);
    expect(src.slice(nowLoop, foldLoop)).toContain("leadRidesItsWriteUp(q.id, writeUpLeadIds)");
    expect(src.slice(foldLoop, foldLoop + 400)).toContain("leadRidesItsWriteUp(q.id, writeUpLeadIds)");
    expect(src).toContain("counts.leads_to_call = lessRidden(sqlCount(inqR), leadsRidden)");
    expect(src).toContain('if (a.inquiry_id) writeUpLeadIds.add(String(a.inquiry_id));');
  });
});
