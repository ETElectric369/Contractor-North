import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { coerceByPlaybook } from "@/lib/playbook/answers";
import { applicableNeeds } from "@/lib/playbook/resolve";
import { MAX_SCOPE_WORD, scopeWord, scopeWordRenames } from "@/lib/playbook/scope";
import { MAX_KIT_CATEGORY } from "@/lib/estimate/kit-from-task";
import type { Playbook } from "@/lib/playbook/types";

// The editor imports its server actions; a unit test never reaches them.
vi.mock("@/app/(app)/settings/playbook-actions", () => ({}));

/**
 * CARRIED FROM audit v1120 (fix wave cn-v1123): the playbook's scope — its words box, its kind
 * change, its rules, and the kit that files under it.
 */
const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

describe("Renaming a scope word in the words box orphans the rules that wait on it", () => {
  it("one word edited in place is a rename: Deck becomes Decking", () => {
    expect(scopeWordRenames(["Deck", "Remodel"], ["Decking", "Remodel"])).toEqual([{ from: "Deck", to: "Decking" }]);
    // blank lines and trailing spaces are not words
    expect(scopeWordRenames(["Deck ", "", "Remodel"], ["Decking", "Remodel", ""])).toEqual([{ from: "Deck", to: "Decking" }]);
  });

  it("two words edited in place pair in the order they stand", () => {
    expect(scopeWordRenames(["Deck", "Remodel"], ["Decking", "Remodeling"])).toEqual([
      { from: "Deck", to: "Decking" },
      { from: "Remodel", to: "Remodeling" },
    ]);
  });

  it("a reorder, an added word and a deleted word rename nothing - the author resolves those", () => {
    expect(scopeWordRenames(["Deck", "Remodel"], ["Remodel", "Deck"])).toEqual([]);
    expect(scopeWordRenames(["Deck", "Remodel"], ["Deck", "Remodel", "Repair"])).toEqual([]);
    expect(scopeWordRenames(["Deck", "Remodel"], ["Deck"])).toEqual([]);
    expect(scopeWordRenames(["Deck", "Remodel"], ["Deck", ""])).toEqual([]);
    // Deck renamed AND Repair added in one visit to the box: which is which is a guess, so none.
    expect(scopeWordRenames(["Deck", "Remodel"], ["Decking", "Remodel", "Repair"])).toEqual([]);
  });

  it("a reorder plus two renames in one visit never crosses them: only the lines that stand where they stood are renames", () => {
    // Deck and Remodel renamed in place, Repair untouched: by position, Deck -> Decking and Remodel -> Remodeling.
    expect(scopeWordRenames(["Deck", "Remodel", "Repair"], ["Decking", "Remodeling", "Repair"])).toEqual([
      { from: "Deck", to: "Decking" },
      { from: "Remodel", to: "Remodeling" },
    ]);
    // Repair moved up AND Deck/Remodel renamed: the old pairing by order of appearance wrote Deck -> Remodeling.
    const crossed = scopeWordRenames(["Deck", "Remodel", "Repair"], ["Repair", "Remodeling", "Decking"]);
    expect(crossed).not.toContainEqual({ from: "Deck", to: "Remodeling" });
    expect(crossed).not.toContainEqual({ from: "Remodel", to: "Decking" });
    expect(crossed).toEqual([{ from: "Remodel", to: "Remodeling" }]);
    // A different number of words is never paired.
    expect(scopeWordRenames(["Deck", "Remodel"], ["Decking"])).toEqual([]);
  });

  it("the words box commits the rename on blur, through the same function a chip uses", () => {
    const src = read("src/app/(app)/settings/playbook-manager.tsx");
    expect(src).toContain('import { scopeWordRenames } from "@/lib/playbook/scope";');
    expect(src).toContain('scopeWordsFrom.current.set(n.key, e.currentTarget.value.split("\\n"));');
    expect(src).toContain('for (const r of scopeWordRenames(from, e.currentTarget.value.split("\\n"))) renameOptionInRules(n.key, r.from, r.to);');
  });

  it("once the rule follows the word, the question still applies to the renamed scope", () => {
    const pb = (word: string, rule: string): Playbook => ({
      needs: [
        { key: "kind", label: "Project", ask: "What kind?", slot: { type: "scope", options: [word, "Remodel"] } },
        { key: "rail", label: "Railing type", ask: "Railing?", slot: { type: "text" }, when: [{ key: "kind", in: [rule] }] },
      ],
    });
    // before the cascade: the word is renamed, the rule is not - the question goes quiet
    expect(applicableNeeds(pb("Decking", "Deck"), { kind: "Decking" }).map((n) => n.key)).toEqual(["kind"]);
    // after: both say Decking
    expect(applicableNeeds(pb("Decking", "Decking"), { kind: "Decking" }).map((n) => n.key)).toEqual(["kind", "rail"]);
  });
});

describe("Remember As A Kit files the kit under a whole free-typed scope paragraph", () => {
  const FREE: Playbook = { needs: [{ key: "scope", label: "Scope", ask: "What's the job?", slot: { type: "scope" } }] };
  const WORDS: Playbook = { needs: [{ key: "kind", label: "Project", ask: "What kind?", slot: { type: "scope", options: ["Deck", "Remodel"] } }] };

  it("a paragraph is not a word: the scope word is null, so the kit's Scope box starts empty and asks", () => {
    const paragraph = "Converting the storage room to living space. Permitted for occupancy. " + "y".repeat(700);
    expect(scopeWord(FREE, { scope: paragraph })).toBeNull();
    expect(scopeWord(WORDS, { kind: paragraph })).toBeNull();
  });

  it("a word or two, picked or typed, is still the word", () => {
    expect(scopeWord(FREE, { scope: " Panel swap " })).toBe("Panel swap");
    expect(scopeWord(WORDS, { kind: "Deck" })).toBe("Deck");
    expect(scopeWord(WORDS, { kind: ["Remodel"] })).toBe("Remodel");
    expect(scopeWord(FREE, { scope: "x".repeat(MAX_SCOPE_WORD) })).toBe("x".repeat(MAX_SCOPE_WORD));
    expect(scopeWord(FREE, { scope: "x".repeat(MAX_SCOPE_WORD + 1) })).toBeNull();
  });

  it("the cap is the same 60 the kit's category is cut at, so no word is ever cut mid-word", () => {
    expect(MAX_SCOPE_WORD).toBe(MAX_KIT_CATEGORY);
  });

  it("the kit sheet's Scope box is seeded from the word and from nothing else", () => {
    expect(read("src/app/(app)/quotes/new/quote-builder.tsx")).toContain('useState(scopeWord ?? "")');
  });
});

describe("Turning a scope with words into Pick One drops its open door", () => {
  // slotForKind lives in the editor's module; importing it is the whole test of the kind change.
  const load = async () => (await import("@/app/(app)/settings/playbook-manager")).slotForKind;

  it("a scope with words becomes Pick One / Pick Any with his own words still accepted", async () => {
    const slotForKind = await load();
    const scope = { type: "scope" as const, options: ["Deck", "Remodel"] };
    expect(slotForKind("one", scope, undefined)).toEqual({ type: "select", options: ["Deck", "Remodel"], other: true });
    expect(slotForKind("many", scope, undefined)).toEqual({ type: "select", options: ["Deck", "Remodel"], multi: true, other: true });
  });

  it("a scope typed freely had the door open too", async () => {
    const slotForKind = await load();
    expect(slotForKind("one", { type: "scope" }, ["Deck"])).toEqual({ type: "select", options: ["Deck"], other: true });
  });

  it("the typed word survives the next autosave instead of coercing to null", async () => {
    const slotForKind = await load();
    const slot = slotForKind("one", { type: "scope", options: ["Deck", "Remodel"] }, undefined)!;
    const pb: Playbook = { needs: [{ key: "kind", label: "Project", ask: "What kind?", slot }] };
    expect(coerceByPlaybook(pb, { kind: "Gazebo" }).kind).toBe("Gazebo");
  });

  it("a pick that never had the door stays closed, and one that had it keeps it", async () => {
    const slotForKind = await load();
    expect(slotForKind("many", { type: "select", options: ["A", "B"] }, undefined)).toEqual({ type: "select", options: ["A", "B"], multi: true });
    expect(slotForKind("one", { type: "select", options: ["A", "B"], other: true }, undefined)).toEqual({ type: "select", options: ["A", "B"], other: true });
    // a text box turned into Pick One starts at Yes / No with the wall up, as it always did
    expect(slotForKind("one", { type: "text" }, undefined)).toEqual({ type: "select", options: ["Yes", "No"] });
  });
});

describe("The plural fold on every select rule can make two different choices match one rule", () => {
  const pick = (options: string[], rule: string[]): Playbook => ({
    needs: [
      { key: "item", label: "Item", ask: "Which?", slot: { type: "select", options } },
      { key: "follow", label: "Follow-up", ask: "More?", slot: { type: "text" }, when: [{ key: "item", in: rule }] },
    ],
  });
  const applies = (pb: Playbook, answers: Record<string, unknown>) => applicableNeeds(pb, answers as never).map((n) => n.key);

  it("Outlet does not satisfy a rule written on Outlets, and Outlets still does", () => {
    const pb = pick(["Outlet", "Outlets"], ["Outlets"]);
    expect(applies(pb, { item: "Outlet" })).toEqual(["item"]);
    expect(applies(pb, { item: "Outlets" })).toEqual(["item", "follow"]);
  });

  it("choices that differ only by punctuation are different choices", () => {
    const pb = pick(["?", "!"], ["!"]);
    expect(applies(pb, { item: "?" })).toEqual(["item"]);
    expect(applies(pb, { item: "!" })).toEqual(["item", "follow"]);
  });

  it("a multi-select still matches by overlap on the exact word", () => {
    const pb = pick(["Fan", "Fans", "Light"], ["Fans"]);
    expect(applies(pb, { item: ["Light", "Fans"] })).toEqual(["item", "follow"]);
    expect(applies(pb, { item: ["Light", "Fan"] })).toEqual(["item"]);
  });

  it("the scope still reads a typed word blind to case, spacing and a plural", () => {
    const pb: Playbook = {
      needs: [
        { key: "kind", label: "Project", ask: "What kind?", slot: { type: "scope", options: ["Deck", "Remodel"] } },
        { key: "rail", label: "Railing", ask: "Railing?", slot: { type: "text" }, when: [{ key: "kind", in: ["Deck"] }] },
      ],
    };
    expect(applies(pb, { kind: "deck" })).toEqual(["kind", "rail"]);
    expect(applies(pb, { kind: " Decks. " })).toEqual(["kind", "rail"]);
    expect(applies(pb, { kind: "Remodel" })).toEqual(["kind"]);
    expect(applies(pb, { kind: "..." })).toEqual(["kind"]);
  });

  it("two scope words that differ only by a plural are still two words", () => {
    const pb: Playbook = {
      needs: [
        { key: "kind", label: "Project", ask: "What kind?", slot: { type: "scope", options: ["Outlet", "Outlets"] } },
        { key: "more", label: "More", ask: "More?", slot: { type: "text" }, when: [{ key: "kind", in: ["Outlets"] }] },
      ],
    };
    expect(applies(pb, { kind: "Outlet" })).toEqual(["kind"]);
    expect(applies(pb, { kind: "Outlets" })).toEqual(["kind", "more"]);
  });
});

describe("The kit-draft hint still says 'category' beside a box now called Scope", () => {
  it("the line for an unfinished new kit names the Scope box in its own word", () => {
    const src = read("src/app/(app)/price-list/kits-manager.tsx");
    expect(src).toContain("` (scope ${category.trim().slice(0, 30)})`");
    expect(src).not.toContain("(category ${category");
  });
});
