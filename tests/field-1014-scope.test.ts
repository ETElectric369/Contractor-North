/**
 * THE SCOPE IS A PLAYBOOK SETTING (Erik 2026-10-13: "the scope should be a setting in the playbook
 * first and foremost … type freely … or a dropdown with options in his words Remodel, Deck …
 * moldable and adjustable but not too specific to me"). One slot kind with its own mode; one
 * string answer; the kit offer keys off the WORD, blind to case — typed "deck" and chosen "Deck"
 * both light "Add The Deck Tasks". Nothing is seeded into anyone's playbook.
 */
import { describe, expect, it } from "vitest";
import { parsePlaybook } from "@/lib/playbook/parse";
import { coerceByPlaybook } from "@/lib/playbook/answers";
import { sheetFromPlaybook } from "@/lib/playbook/from-sheet";
import { hearRequest } from "@/lib/playbook/hear";
import { publicIntakeNeeds } from "@/lib/playbook/public-intake";
import { groupedKits, kitsForScope, offerLabel, sameScope, scopeKey, scopeNeed, scopeTitle, scopeWord } from "@/lib/playbook/scope";
import { kitsWithoutMoney, taskKitSelectRungs, taskKitsFrom } from "@/lib/estimate/task-kits";
import { readFileSync } from "node:fs";
import { kitFromTaskDetail } from "@/lib/estimate/kit-from-task";
import type { Playbook } from "@/lib/playbook/types";

const roundTrip = (pb: unknown) => JSON.parse(JSON.stringify(pb));

const FREE: Playbook = { needs: [{ key: "scope", label: "Scope", ask: "What's the job?", slot: { type: "scope" } }, { key: "tasks", label: "Tasks", ask: "The tasks?", slot: { type: "tasks" } }] };
const WORDS: Playbook = { needs: [{ key: "kind", label: "Project", ask: "What kind of project is it?", slot: { type: "scope", options: ["Deck", "Remodel"] } }] };

describe("the slot survives the database in both modes", () => {
  it("type freely and his words both parse; empty words = type freely; junk and a second scope are plain", () => {
    expect(parsePlaybook(roundTrip(FREE))).toEqual(FREE);
    expect(parsePlaybook(roundTrip(WORDS))).toEqual(WORDS);
    const back = parsePlaybook({ needs: [{ key: "k", label: "K", ask: "K?", slot: { type: "scope", options: ["", "  ", 7, "x".repeat(80)] } }] });
    expect(back.needs[0].slot).toEqual({ type: "scope", options: ["x".repeat(60)] });
    const empty = parsePlaybook({ needs: [{ key: "k", label: "K", ask: "K?", slot: { type: "scope", options: [] } }] });
    expect(empty.needs[0].slot).toEqual({ type: "scope" });
    const two: Playbook = { needs: [...WORDS.needs, { key: "again", label: "Again", ask: "Again?", slot: { type: "scope" } }] };
    expect(scopeNeed(two)?.key).toBe("kind"); // the FIRST is the scope
  });
  it("the answer is one trimmed string in either mode — a word off the list is kept, never nulled", () => {
    expect(coerceByPlaybook(FREE, { scope: "  panel   swap " }).scope).toBe("panel swap");
    expect(coerceByPlaybook(WORDS, { kind: "Deck" }).kind).toBe("Deck");
    expect(coerceByPlaybook(WORDS, { kind: "Hot tub" }).kind).toBe("Hot tub");
    expect(coerceByPlaybook(WORDS, { kind: ["Remodel"] }).kind).toBe("Remodel"); // an old select answer survives a kind change
    expect(coerceByPlaybook(WORDS, { kind: "" }).kind).toBeNull();
    expect(String(coerceByPlaybook(FREE, { scope: "y".repeat(500) }).scope).length).toBe(200);
  });
  it("the old sheet mirror and the public form see what it looks like: his words with the door open, or a box", () => {
    expect(sheetFromPlaybook(WORDS)[0]).toMatchObject({ key: "kind", type: "select", options: ["Deck", "Remodel"], other: true });
    expect(sheetFromPlaybook(FREE)[0]).toMatchObject({ key: "scope", type: "text" });
    expect(publicIntakeNeeds(WORDS)[0].slot).toEqual({ type: "select", options: ["Deck", "Remodel"], other: true });
    expect(publicIntakeNeeds(FREE)[0].slot).toEqual({ type: "text" });
  });
  it("Nort is told it is THE scope, with his usual words when he has them", () => {
    expect(hearRequest(WORDS, {}, "it's a deck")).toContain("THE SCOPE — what kind of job this is, in a word or two; his usual words: Deck | Remodel — or his own if none of those fit");
    expect(hearRequest(FREE, {}, "panel swap")).toContain("THE SCOPE — what kind of job this is, in a word or two\n");
  });
});

describe("the word lights the kits", () => {
  const KITS = [
    { id: "a", name: "Footings", category: "Deck" },
    { id: "b", name: "Railing", category: " deck " },
    { id: "c", name: "Demo", category: "Remodel" },
    { id: "d", name: "Service call", category: null },
    { id: "e", name: "Drywall", category: "Re-model" },
  ];
  it("case, spacing and punctuation blind; nothing without a word", () => {
    expect(scopeKey(" Deck. ")).toBe("deck");
    expect(scopeKey("Re-model")).toBe("re model");
    expect(sameScope("deck", "DECK")).toBe(true);
    expect(sameScope("", "")).toBe(false);
    expect(sameScope(null, "deck")).toBe(false);
    expect(kitsForScope(KITS, "deck").map((k) => k.id)).toEqual(["a", "b"]);
    expect(kitsForScope(KITS, "Remodel").map((k) => k.id)).toEqual(["c"]);
    expect(kitsForScope(KITS, null)).toEqual([]);
    expect(kitsForScope(KITS, "   ")).toEqual([]);
  });
  it("the word comes from the scope need's answer; the offer row says the count in Title Case", () => {
    expect(scopeWord(WORDS, { kind: "deck" })).toBe("deck");
    expect(scopeWord(FREE, { scope: " Panel swap " })).toBe("Panel swap");
    expect(scopeWord(FREE, {})).toBeNull();
    expect(scopeWord({ needs: [] }, { scope: "x" })).toBeNull();
    expect(scopeTitle("panel swap")).toBe("Panel Swap");
    expect(offerLabel("deck", 7)).toBe("Add The Deck Tasks (7)");
  });
  it("the picker groups by scope — the visit's first, Other Kits last — and stays flat when no kit has one", () => {
    const g = groupedKits(KITS, "remodel")!;
    expect(g.map((x) => x.label)).toEqual(["Remodel", "Deck", "Re-model", "Other Kits"]);
    expect(g[0].kits.map((k) => k.id)).toEqual(["c"]);
    expect(g[3].kits.map((k) => k.id)).toEqual(["d"]);
    expect(groupedKits(KITS, null)!.map((x) => x.label)).toEqual(["Deck", "Re-model", "Remodel", "Other Kits"]);
    expect(groupedKits([{ id: "x", name: "X", category: null }], "deck")).toBeNull();
  });
  it("the category rides the task-kit read and the money-stripped copy, and Remember As A Kit files it", () => {
    expect(taskKitSelectRungs("category").every((r) => r.includes("category"))).toBe(true);
    // the Inspector's page asks for it through the rung door (the shared column list is unchanged)
    expect(readFileSync("src/app/(app)/appointments/[id]/page.tsx", "utf8")).toContain('.order("name"), "category")');
    const kits = taskKitsFrom([{ id: "k1", name: "Footing", category: "  Deck ", labor_minutes: 120, unit: "footing", kit_items: [] }, { id: "k2", name: "Parts only", category: "Deck", labor_minutes: null }]);
    expect(kits).toEqual([{ id: "k1", name: "Footing", labor_minutes: 120, unit: "footing", category: "Deck", items: [] }]);
    expect(kitsWithoutMoney(kits)[0].category).toBe("Deck");
    const made = kitFromTaskDetail({ task_id: "t", name: "Footings", hours: 2, units: 1, materials: [] } as never, { name: "Footings", unit: "footing", category: "  deck  " });
    expect(made.ok && made.value.kit.category).toBe("deck");
    const bare = kitFromTaskDetail({ task_id: "t", name: "Footings", hours: 2, units: 1, materials: [] } as never, { name: "Footings", unit: "footing" });
    expect(bare.ok && bare.value.kit.category).toBeNull();
  });
});
