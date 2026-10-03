import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { TRADE_ORDER } from "@/lib/trade-codes";
import { getOrgSettings } from "@/lib/org-settings";
import { TRADE_WORDS, orgTrade, tradeKeyFromWords, tradeWordsOr, withArticle } from "./org-trade";

/** Every source file under src (tests and DB suites aside). */
const walk = (d: string): string[] =>
  readdirSync(d).flatMap((n) => {
    const p = join(d, n);
    if (statSync(p).isDirectory()) return walk(p);
    return /\.tsx?$/.test(n) && !/\.(test|db-suite)\.tsx?$/.test(n) ? [p] : [];
  });

/**
 * ONE TRADE READER. Sign-up keeps only the trade KEY (0352); every guide read the WORDS, so a new
 * company was asked its trade twice, its Nort had no trade line, and its starter inspection was
 * chosen by nothing. The key decides; the words describe; free text is the last resort.
 */
describe("the key decides, the words describe", () => {
  it("a company made since 0352 has only the key, and still has words", () => {
    expect(orgTrade({ trade: "plumbing" })).toEqual({ key: "plumbing", label: "plumber" });
    expect(orgTrade(getOrgSettings({ trade: "deck" }))).toEqual({ key: "deck", label: "deck builder" });
  });

  it("the company's own words win for the label, never for the key", () => {
    expect(orgTrade({ trade: "general", trade_label: "Construction" })).toEqual({ key: "general", label: "Construction" });
    expect(orgTrade({ trade: "deck", trade_label: "  electrical contractor " })).toEqual({ key: "deck", label: "electrical contractor" });
  });

  it("the three live companies read as themselves (the fixture, never the rule)", () => {
    expect(orgTrade({ trade: "electrical", trade_label: "electrical contractor" })).toEqual({ key: "electrical", label: "electrical contractor" });
    expect(orgTrade({ trade: "deck", trade_label: "deck builder" })).toEqual({ key: "deck", label: "deck builder" });
    expect(orgTrade({ trade: "general", trade_label: "Construction" }).key).toBe("general");
  });

  it("no key: the words are read as a last resort", () => {
    expect(orgTrade({ trade_label: "electrical contractor" }).key).toBe("electrical");
    expect(orgTrade({ trade: "other", trade_label: "I build decks" }).key).toBe("deck");
    expect(orgTrade({ trade_label: "glazier" })).toEqual({ key: "", label: "glazier" });
  });

  it("nothing known is nothing, and a prompt still gets a noun", () => {
    expect(orgTrade({})).toEqual({ key: "", label: "" });
    expect(orgTrade(null)).toEqual({ key: "", label: "" });
    expect(orgTrade(getOrgSettings(null))).toEqual({ key: "", label: "" });
    expect(tradeWordsOr({})).toBe("contractor");
    expect(tradeWordsOr({ trade: "roofing" })).toBe("roofer");
  });

  it("every sign-up trade has words of its own", () => {
    for (const k of TRADE_ORDER) {
      expect(TRADE_WORDS[k]?.trim(), k).toBeTruthy();
      // A person's words, not the dropdown's menu row ("Deck / carpentry").
      expect(TRADE_WORDS[k], k).not.toContain("/");
      // And the words read back as the same trade.
      expect(tradeKeyFromWords(TRADE_WORDS[k]), k).toBe(k);
    }
  });
});

describe("free text, the last resort", () => {
  it.each([
    ["electrical contractor", "electrical"],
    ["Electrician", "electrical"],
    ["deck builder", "deck"],
    ["Deck & Fence", "deck"],
    ["Decking and railings", "deck"],
    ["Plumbing & Heating", "plumbing"],
    ["HVAC", "hvac"],
    ["heating and air", "hvac"],
    ["roofer", "roofing"],
    ["concrete & masonry", "concrete"],
    ["tile and flooring", "tile"],
    ["landscaper", "landscaping"],
    ["painter", "painting"],
    // Never construction → deck: a builder is a general contractor.
    ["Construction", "general"],
    ["general contractor", "general"],
    // setup-playbook's own warning: a GC who subs out electrical is a GC.
    ["general contractor, I sub out electrical", "general"],
    ["Redeckorating", ""],
    ["glazier", ""],
    ["", ""],
  ])("%s → %s", (words, key) => {
    expect(tradeKeyFromWords(words)).toBe(key);
  });
});

describe("the words read as a sentence", () => {
  it("picks its article", () => {
    expect(withArticle("electrical contractor")).toBe("an electrical contractor");
    expect(withArticle("HVAC contractor")).toBe("an HVAC contractor");
    expect(withArticle("deck builder")).toBe("a deck builder");
    expect(withArticle("  ")).toBe("");
  });

  it("no prompt or screen puts its own article before the trade words ('a electrical contractor')", () => {
    // The key's own words need "an" as often as "a" (electrical, HVAC). Every "a ${trade}" was
    // written for "deck builder" and read "a electrical contractor" / "a HVAC contractor".
    const root = process.cwd();
    const hits = walk(join(root, "src"))
      .map((f) => relative(root, f))
      .flatMap((f) =>
        readFileSync(join(root, f), "utf8")
          .split("\n")
          .map((line, i) => ({ line, at: `${f}:${i + 1}` }))
          .filter(({ line }) => /\ban? \$\{[^}]*trade[^}]*\}/i.test(line))
          .map(({ at }) => at),
      );
    expect(hits).toEqual([]);
  });
});

describe("ONE reader: nothing else reads trade_label to decide anything", () => {
  // The words were read in ten places and the key in none, which is how a new company lost its
  // trade. The words may be WRITTEN by setup (saveSetup) and are declared in org-settings; every
  // read goes through lib/org-trade.
  const ALLOWED = new Set(["src/lib/org-trade.ts", "src/lib/org-settings.ts", "src/app/(app)/setup-actions.ts"]);

  it("reads of trade_label live only in the reader", () => {
    const root = process.cwd();
    const hits = walk(join(root, "src"))
      .map((f) => relative(root, f))
      .filter((f) => !ALLOWED.has(f))
      .filter((f) => /\.trade_label\b|\["trade_label"\]/.test(readFileSync(join(root, f), "utf8")));
    expect(hits).toEqual([]);
  });

  it("setup only WRITES the words", () => {
    const s = readFileSync(join(process.cwd(), "src/app/(app)/setup-actions.ts"), "utf8");
    for (const line of s.split("\n").filter((l) => /trade_label/.test(l) && !/^\s*(\/\/|\*)/.test(l)))
      expect(line, line).toMatch(/patch\.trade_label( = |\))/);
  });
});
