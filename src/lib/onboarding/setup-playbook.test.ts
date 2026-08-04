import { describe, it, expect } from "vitest";
import { SETUP_PLAYBOOK } from "./setup-playbook";
import { applyHeard, parseHeard } from "@/lib/playbook/hear";
import { holdingNeeds, isClosed, missingNeeds, splitAsk } from "@/lib/playbook/resolve";
import { coerceByPlaybook } from "@/lib/playbook/answers";

/**
 * ANDREW COHEN's actual state on 2026-08-04, read out of production: trade null, city null,
 * service area "", rate null, zero customers. He signed up, landed on an empty My Day, got a
 * generic six-question walk-through, and pressed "generate questions" without finding what it
 * made. Every one of those failures traces to the first unanswered question here.
 */

describe("what a brand-new company is asked", () => {
  it("all five, in the order that unblocks the most", () => {
    expect(missingNeeds(SETUP_PLAYBOOK, {}).map((n) => n.key)).toEqual([
      "full_name",
      "trade",
      "city",
      "labor_rate",
    ]);
    // service_area waits for the town — "how far out do you go" means nothing without a from.
    expect(missingNeeds(SETUP_PLAYBOOK, { city: "Reno" }).map((n) => n.key)).toContain("service_area");
  });

  it("the trade is the one hold — three dead surfaces hang off it", () => {
    expect(holdingNeeds(SETUP_PLAYBOOK, {}).map((n) => n.key)).toEqual(["trade"]);
  });

  it("every box is real — nothing renders that can't be typed into", () => {
    // A setup card is the first thing a new company touches. An open need here would be a
    // question with no control on the one screen where nobody yet knows to press Talk.
    expect(isClosed(SETUP_PLAYBOOK, {})).toBe(true);
    for (const n of SETUP_PLAYBOOK.needs) {
      expect(n.slot, n.key).toBeTruthy();
      expect(n.ask.trim().length, n.key).toBeGreaterThan(8);
      expect(n.why?.trim().length ?? 0, n.key).toBeGreaterThan(20);
    }
  });

  it("nothing is left to ask once it's all answered — the card can disappear", () => {
    const done = { full_name: "Andrew Cohen", trade: "general contractor", city: "Reno", service_area: "the valley", labor_rate: 110 };
    expect(splitAsk(SETUP_PLAYBOOK, done).ask).toEqual([]);
  });
});

describe("ONE BREATH, and it is Andrew's — a GC who subs it all out", () => {
  const SAID =
    "I'm Andrew Cohen, general contractor out of Reno, I sub out electrical and plumbing, " +
    "I cover the whole valley and I bill 110 an hour";

  const EXTRACTED = {
    fills: [
      { key: "full_name", value: "Andrew Cohen", heard: "I'm Andrew Cohen" },
      { key: "trade", value: "general contractor, subs out electrical and plumbing", heard: "general contractor out of Reno, I sub out electrical and plumbing" },
      { key: "city", value: "Reno", heard: "out of Reno" },
      { key: "service_area", value: "the whole valley", heard: "I cover the whole valley" },
      { key: "labor_rate", value: 110, heard: "I bill 110 an hour" },
    ],
    leftover: "",
  };

  const out = applyHeard(SETUP_PLAYBOOK, {}, SAID, parseHeard(JSON.stringify(EXTRACTED)));

  it("the whole company, from one sentence", () => {
    expect(splitAsk(SETUP_PLAYBOOK, out.answers).ask).toEqual([]);
    expect(out.answers.labor_rate).toBe(110);
  });

  it("the trade is a SENTENCE, not a category — that is the point for a GC", () => {
    // Andrew's "what" isn't one trade off a list; he subs most of it out. A text slot can hold
    // that, and it's what the estimator and the walk-through seed read.
    expect(String(out.answers.trade)).toContain("subs out");
  });

  it("THE RATE IS GATED like any other number that becomes money", () => {
    // measured: true, so it has to be traceable to words he said. A model that helpfully converts
    // a day rate into an hourly one is inventing the number every future estimate is built on.
    const computed = applyHeard(
      SETUP_PLAYBOOK,
      {},
      "I bill 880 a day",
      parseHeard(JSON.stringify({ fills: [{ key: "labor_rate", value: 110, heard: "I bill 880 a day" }] })),
    );
    expect(computed.answers.labor_rate).toBeNull();
    expect(missingNeeds(SETUP_PLAYBOOK, computed.answers).map((n) => n.key)).toContain("labor_rate");
  });

  it("what didn't fit a question is not thrown away", () => {
    const chatty = applyHeard(SETUP_PLAYBOOK, {}, "my brother does the framing", {
      fills: [],
      leftover: "my brother does the framing",
    });
    expect(chatty.note).toBe("my brother does the framing");
  });
});

describe("the write boundary", () => {
  it("an undeclared key never reaches the org settings", () => {
    expect(coerceByPlaybook(SETUP_PLAYBOOK, { trade: "plumber", role: "owner", org_id: "x" })).toEqual({
      full_name: null,
      trade: "plumber",
      city: null,
      service_area: null,
      labor_rate: null,
    });
  });

  it("a rate typed the way a person types it still lands as a number", () => {
    expect(coerceByPlaybook(SETUP_PLAYBOOK, { labor_rate: "$110/hr" }).labor_rate).toBe(110);
    expect(coerceByPlaybook(SETUP_PLAYBOOK, { labor_rate: "ask me" }).labor_rate).toBeNull();
  });
});
