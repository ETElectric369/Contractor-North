import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PLAYBOOK_STARTERS, startersForTrade, starterRowsForTrade } from "./index";
import { TRADE_ORDER, TRADE_PACKAGES } from "@/lib/trade-package";

/**
 * THE STARTERS, THE COMPANY'S OWN TRADE FIRST (cn-v1135). The trade package names the starter
 * written for each trade; the Settings card leads with that one and lists the rest under the other
 * trades. The DATA is unchanged — two starters, electrical and deck, each written by somebody who
 * does that work — and a trade without one is told so in one line that promises nothing.
 */
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const keys = (list: { key: string }[]) => list.map((s) => s.key);

describe("startersForTrade", () => {
  it("a deck company: its own first, the rest after, in library order", () => {
    const r = startersForTrade("deck");
    expect(r.own?.key).toBe("tahoe-deck");
    expect(keys(r.others)).toEqual(["et-electric"]);
  });
  it("an electrical company: the same, the other way round", () => {
    const r = startersForTrade("electrical");
    expect(r.own?.key).toBe("et-electric");
    expect(keys(r.others)).toEqual(["tahoe-deck"]);
  });
  it("a trade nobody has written a starter for, and an unknown trade: no own, every starter under the others", () => {
    for (const k of ["plumbing", "general", "painting", "", "other"]) {
      const r = startersForTrade(k);
      expect(r.own, k).toBeNull();
      expect(keys(r.others), k).toEqual(keys(PLAYBOOK_STARTERS));
    }
  });
  it("the own starter is exactly the registry's playbookStarter for every trade, and nothing is invented", () => {
    for (const k of TRADE_ORDER) {
      const r = startersForTrade(k);
      expect(r.own?.key ?? null, k).toBe(TRADE_PACKAGES[k].playbookStarter);
      expect([...(r.own ? [r.own] : []), ...r.others].length, k).toBe(PLAYBOOK_STARTERS.length);
    }
  });
});

describe("starterRowsForTrade — what the Settings page hands the browser", () => {
  it("rows carry the words only, never the playbook", () => {
    const r = starterRowsForTrade("deck");
    expect(Object.keys(r.own!)).toEqual(["key", "label", "blurb"]);
    for (const o of r.others) expect(Object.keys(o)).toEqual(["key", "label", "blurb"]);
  });
  it("the trade's words, with their article, for the no-starter line; empty when the trade isn't known", () => {
    expect(starterRowsForTrade("plumbing").tradeWords).toBe("a plumber");
    expect(starterRowsForTrade("hvac").tradeWords).toBe("an HVAC contractor");
    expect(starterRowsForTrade("electrical").tradeWords).toBe("an electrical contractor");
    expect(starterRowsForTrade("").tradeWords).toBe("");
    expect(starterRowsForTrade("other").tradeWords).toBe("");
  });
  it("the Settings page passes the two groups through the company's trade, and the card says the rule", () => {
    expect(src("src/app/(app)/settings/page.tsx")).toContain("starters={starterRowsForTrade(orgTrade(settings).key)}");
    const manager = src("src/app/(app)/settings/playbook-manager.tsx");
    expect(manager).toContain("Your Trade&rsquo;s Starter");
    expect(manager).toContain("Other Trades&rsquo; Starters");
    expect(manager).toContain("No starter is written for {starters.tradeWords} yet. Your inspection sheet is the honest start.");
    expect(manager).not.toMatch(/coming soon|on its way|we'll write/i); // no promise
    expect(manager).toContain("Replace all ${needs.length} of your questions with the ${s.label} starter?"); // installing still confirms
  });
});
