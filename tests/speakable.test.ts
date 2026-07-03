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

  it("street-suffix abbreviations expand (capitalized only, no false trips)", () => {
    expect(speakable("the Apache Ct job")).toContain("Apache Court");
    expect(speakable("123 Sierra Blvd")).toContain("Sierra Boulevard");
    expect(speakable("off Northwoods Rd")).toContain("Northwoods Road");
    expect(speakable("the 3rd panel")).toContain("3rd"); // ordinal must survive
    expect(speakable("we have three")).toContain("three"); // 'have'/'three' must survive
  });

  it("leading list bullets are stripped so they don't read as 'dash'", () => {
    expect(speakable("- Labor: $100")).not.toMatch(/^-/);
    expect(speakable("- Labor: $100")).toContain("Labor");
  });
});

/**
 * Erik's field report (2026-07-03): the voice recited estimate line-item MATH ("24 hours by
 * 150 dollars ... 3,600 dollars", twice, then the total) instead of jumping to highlights.
 * speakable() now collapses a cost breakdown to prose + total FOR SPEECH ONLY — the screen,
 * which never calls speakable(), still shows every line.
 */
describe("speakable — cost breakdown collapses to highlights + total", () => {
  const chmura =
    "Here's E-010 for John Chmura — 400A Service Upgrade (T&M), still a draft:\n\n" +
    "- Labor — Owner: 24 hr × $150 = $3,600\n" +
    "- Labor — Bryan: 24 hr × $150 = $3,600\n" +
    "- Consumables allowance: $150\n\n" +
    "**Total: $7,350**\n\n" +
    "Heads up — it's all labor. Want me to build the material side?";

  it("drops the per-line math but keeps the total + heads-up", () => {
    const s = speakable(chmura);
    expect(s).not.toContain("3,600");
    expect(s).not.toContain("by 150");
    expect(s).not.toMatch(/24 hours/);
    expect(s).toContain("7,350 dollars");
    expect(s).toContain("Heads up");
    expect(s).toContain("estimate 10");
    expect(s).toContain("400 amp");
  });

  it("leaves lines alone when there's no total to anchor on", () => {
    const s = speakable("- Labor: $100\n- Materials: $50");
    expect(s).toContain("100 dollars");
    expect(s).toContain("50 dollars");
  });

  it("never drops a Total/balance line even if bulleted", () => {
    const s = speakable("- Labor: $100\n- Parts: $50\n- Balance due: $150");
    expect(s).toContain("Balance due");
  });
});
