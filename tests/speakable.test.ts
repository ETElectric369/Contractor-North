import { describe, expect, it } from "vitest";
import { speakable } from "@/lib/tts";

/**
 * The voice must speak electrician, not robot. speakable() translates app/trade
 * notation into spoken English at the speakSmart choke point (screen text is
 * untouched). These cases ARE the trade dictionary — extend, don't weaken.
 */
describe("speakable — trade + app notation", () => {
  it("doc numbers speak as their type", () => {
    expect(speakable("Saved E-009 for John.")).toContain("estimate 9");
    expect(speakable("INV-00012 is unpaid")).toContain("invoice 12");
    expect(speakable("on J-018 today")).toContain("job 18");
    expect(speakable("WO-001 done")).toContain("work order 1");
  });

  it("wire sizes speak like the trade", () => {
    expect(speakable("ran 30' of 10/3 NM-B")).toContain("30 feet");
    expect(speakable("ran 10/3 Romex")).toContain("10 3 Romex");
    expect(speakable("4/0 aluminum SER")).toContain("four aught aluminum");
    expect(speakable("pull #10 AWG")).toContain("number 10");
  });

  it("electrical units expand", () => {
    expect(speakable("a 200A panel")).toContain("200 amp");
    expect(speakable("240V circuit")).toContain("240 volt");
    expect(speakable("T&M job")).toContain("time and materials");
    expect(speakable("2 4S boxes")).toContain("four S");
  });

  it("money speaks naturally", () => {
    expect(speakable("total $5,550.00")).toContain("5,550 dollars");
    expect(speakable("total $5,550.00")).not.toContain(".00");
    expect(speakable("$82.50 in parts")).toContain("82 dollars and 50 cents");
  });

  it("quantities and symbols", () => {
    expect(speakable("2 ea @ 15%")).toContain("2 each");
    expect(speakable("2 ea @ 15%")).toContain("15 percent");
    expect(speakable("3 × 20")).toContain("3 by 20");
    expect(speakable("6\" box")).toContain("6 inches");
    expect(speakable("worked 3.5 hrs")).toContain("3.5 hours");
  });

  it("strips markdown noise, keeps words", () => {
    expect(speakable("**Saved** the `estimate`")).toBe("Saved the estimate");
  });
});
