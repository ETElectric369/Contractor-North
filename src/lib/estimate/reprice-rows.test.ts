import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repriceRows, rowForWho, rowRule, ruleInputsKey } from "./reprice-rows";
import type { DraftLineItem, TaskLabor } from "./line-map";

/**
 * THE LABOR ROWS BEHIND THE BUILDER'S TWO DOORS (cn-v1131): the re-price pass its rule effect runs and
 * the rule its Who select asks — pure, so they are driven here; the builder is pinned to call them.
 * Names are stand-ins (Snowbell, Larkspur), never a person's.
 */
const row = (over: Partial<TaskLabor> = {}): TaskLabor => ({ label: null, person_id: null, hours: 1, rate: 145, rate_from: "rule", ...over });
const line = (labor: TaskLabor[]): DraftLineItem => ({
  description: "Trench",
  quantity: 1,
  unit: "ea",
  unit_price: labor.reduce((t, r) => t + (r.hours ?? 0) * r.rate, 0),
  detail: { task_id: "t1", labor, units: null, kit_id: null, materials: [] },
});
const people = [
  { id: "p1", name: "Snowbell", billRate: 135 },
  { id: "p2", name: "Larkspur", billRate: null },
];

describe("rowRule — the rule's answer for whoever a row names", () => {
  it("a person on top, held under the level; nobody at the level, else the default; a person who left prices as nobody", () => {
    expect(rowRule("p1", { orgDefault: 145, people })).toEqual({ rate: 135, from: "person" });
    expect(rowRule("p1", { levelRate: 125, orgDefault: 145, people })).toEqual({ rate: 125, from: "person" });
    expect(rowRule("p2", { orgDefault: 145, people })).toEqual({ rate: 145, from: "default" });
    expect(rowRule(null, { levelRate: 125, orgDefault: 145, people })).toEqual({ rate: 125, from: "level" });
    expect(rowRule("gone", { orgDefault: 145, people })).toEqual({ rate: 145, from: "default" });
    expect(rowRule(null, {})).toEqual({ rate: 0, from: "none" });
  });
});

describe("ruleInputsKey — one string for every input the pass reads", () => {
  it("moves with the level, the default and any person's rate, and not with the list's identity", () => {
    const a = ruleInputsKey({ levelRate: 145, orgDefault: 145, people });
    expect(ruleInputsKey({ levelRate: 145, orgDefault: 145, people: people.map((p) => ({ ...p })) })).toBe(a);
    expect(ruleInputsKey({ levelRate: 125, orgDefault: 145, people })).not.toBe(a);
    expect(ruleInputsKey({ levelRate: 145, orgDefault: 135, people })).not.toBe(a);
    // THE SKEPTIC'S CASE: the level equals the default, so the no-person figure stands still while a
    // person's cap moves — the key still moves, so the effect runs.
    expect(ruleInputsKey({ levelRate: 145, orgDefault: 145, people: [{ id: "p1", billRate: 120 }, people[1]] })).not.toBe(a);
    expect(ruleInputsKey({ levelRate: "145", orgDefault: 145, people })).toBe(a); // a string figure is the same figure
  });
});

describe("repriceRows — the pass the rule effect runs", () => {
  const list = line([
    row(), // rule, nobody
    row({ person_id: "p1", rate: 135 }), // rule, Snowbell
    row({ person_id: "p2", rate: 145 }), // rule, Larkspur (no rate of her own)
    row({ rate: 200, rate_from: "hand" }),
    row({ label: "2-man crew", rate: 150, rate_from: "stated" }),
    row({ rate: 145, rate_from: "legacy" }), // the old one-figure shape, still at the old rule
    row({ rate: 160, rate_from: "legacy" }), // the old shape at a figure he must have typed
  ]);

  it("the default moves 145 → 135: rule rows follow for whoever they name, the legacy row at the old answer follows, hand / stated / the other legacy stand", () => {
    const next = repriceRows(list, { orgDefault: 135, people }, 145);
    expect(next.detail!.labor.map((r) => r.rate)).toEqual([135, 135, 135, 200, 150, 135, 160]);
    expect(next.detail!.labor.map((r) => r.rate_from)).toEqual(["rule", "rule", "rule", "hand", "stated", "legacy", "legacy"]);
    expect(next.unit_price).toBe(135 + 135 + 135 + 200 + 150 + 135 + 160);
  });

  it("the level equals the default (the no-person figure still) while Snowbell's rate moves: her row follows, nothing else does", () => {
    const next = repriceRows(list, { levelRate: 145, orgDefault: 145, people: [{ id: "p1", billRate: 120 }, people[1]] }, 145);
    expect(next.detail!.labor.map((r) => r.rate)).toEqual([145, 120, 145, 200, 150, 145, 160]);
  });

  it("a level rate caps a person's row; a person who left the team prices as nobody; a line with no breakdown is returned as it is", () => {
    const capped = repriceRows(line([row({ person_id: "p1", rate: 135 })]), { levelRate: 125, orgDefault: 145, people }, 145);
    expect(capped.detail!.labor[0].rate).toBe(125);
    const gone = repriceRows(line([row({ person_id: "gone", rate: 135 })]), { orgDefault: 145, people }, 145);
    expect(gone.detail!.labor[0].rate).toBe(145);
    const plain: DraftLineItem = { description: "Permit", quantity: 1, unit: "ea", unit_price: 250 };
    expect(repriceRows(plain, { orgDefault: 135, people }, 145)).toBe(plain);
  });

  it("an answer equal to the stored one changes nothing (the same line object back), so the effect costs no autosave", () => {
    expect(repriceRows(list, { orgDefault: 145, people }, 145)).toEqual(list);
  });
});

describe("rowForWho — the Who select re-asks the rule only for a rule or legacy row", () => {
  const now = { orgDefault: 145, people };
  it("a rule row picks a person: their rate, still the rule's; picks Labor: the no-person answer; picks Other: nobody, his word kept", () => {
    expect(rowForWho(row(), { personId: "p1", label: null }, now)).toEqual(row({ person_id: "p1", rate: 135 }));
    expect(rowForWho(row({ person_id: "p1", rate: 135 }), { personId: null, label: null }, now)).toEqual(row());
    expect(rowForWho(row({ label: "Helper" }), { personId: null, label: "Helper" }, now)).toEqual(row({ label: "Helper" }));
  });
  it("a legacy row re-asks too and is a rule row from here", () => {
    expect(rowForWho(row({ rate: 160, rate_from: "legacy" }), { personId: "p1", label: null }, now)).toEqual(row({ person_id: "p1", rate: 135 }));
  });
  it("a typed or dictated rate STANDS through a pick of a person, Labor or Other (the skeptic's S4)", () => {
    const hand = row({ rate: 200, rate_from: "hand" });
    expect(rowForWho(hand, { personId: "p1", label: null }, now)).toEqual({ ...hand, person_id: "p1" });
    expect(rowForWho({ ...hand, person_id: "p1" }, { personId: null, label: null }, now)).toEqual(hand);
    expect(rowForWho(hand, { personId: null, label: "" }, now)).toEqual({ ...hand, label: "" });
    const stated = row({ label: "2-man crew", rate: 150, rate_from: "stated" });
    expect(rowForWho(stated, { personId: "p2", label: null }, now)).toEqual({ ...stated, person_id: "p2", label: null });
  });
  it("the kit's mark on the hours is not the rule's business: it rides through a pick", () => {
    expect(rowForWho(row({ from_kit: true }), { personId: "p1", label: null }, now)).toEqual(row({ person_id: "p1", rate: 135, from_kit: true }));
  });
});

describe("the builder goes through these two doors", () => {
  const src = readFileSync(join(process.cwd(), "src/app/(app)/quotes/new/quote-builder.tsx"), "utf8");
  it("the rule effect is keyed on every input and runs repriceRows once per change; the Who select goes through rowForWho", () => {
    expect(src).toContain('import { repriceRows, rowForWho, ruleInputsKey, type RuleInputs } from "@/lib/estimate/reprice-rows";');
    expect(src).toContain("const ruleNow: RuleInputs = { levelRate, orgDefault: defaultLaborRate, people };");
    expect(src).toContain("const ruleKey = ruleInputsKey(ruleNow);");
    expect(src).toContain("if (ruleSeen.current.key === ruleKey) return;");
    expect(src).toContain("l.detail && detailExplains(l.detail, l) ? repriceRows(l, ruleNow, prevRate) : l");
    expect(src).toContain("}, [ruleKey]);");
    expect(src).not.toContain("withPeopleRates");
    expect(src).not.toContain("}, [rule.rate]);");
    expect(src).toContain("setLabor(i, rowForWho(row, who, ruleInputs));");
  });
});
