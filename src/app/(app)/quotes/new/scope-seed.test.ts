import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applicableNeeds, clearInapplicable } from "@/lib/playbook/resolve";
import type { Answers, Playbook } from "@/lib/playbook/types";

/**
 * START THE ESTIMATE SEEDS PRICED LINES ONLY FROM A SCOPES QUESTION THAT STILL APPLIES.
 *
 * A crew lead's save (0356) keeps every declared scopes key the office stored, even one his own
 * answers have since turned off (his cleaned payload leaves it out, and the database puts it back).
 * The Inspector hides that question, so its picks must not become lines on the estimate.
 */
const pb: Playbook = {
  needs: [
    { key: "project_type", label: "Project", ask: "What kind of project?", slot: { type: "select", options: ["Remodel", "Resurface"] } },
    { key: "remodel_scopes", label: "Remodel scopes", ask: "Which remodel scopes?", slot: { type: "scopes" }, when: [{ key: "project_type", in: ["Remodel"] }] },
  ],
};
const stored: Answers = {
  project_type: "Resurface",
  remodel_scopes: [
    { code: "R1", qty: 1, price: 1200 },
    { code: "R3", qty: 2, price: 450 },
  ],
};

describe("the scopes the estimate seeds from an inspection", () => {
  it("a scopes question the answers turned off seeds nothing, though its picks are still stored", () => {
    const live = clearInapplicable(pb, stored);
    const scopes = applicableNeeds(pb, live).filter((n) => n.slot?.type === "scopes");
    expect(scopes).toEqual([]);
    expect(live.remodel_scopes).toBeNull();
  });

  it("the page reads the picks through the cleared answers and the applicable needs, never pb.needs", () => {
    const src = readFileSync(join(process.cwd(), "src/app/(app)/quotes/new/page.tsx"), "utf8");
    expect(src).toContain("const liveAnswers = clearInapplicable(pb, answers);");
    expect(src).toContain("for (const n of applicableNeeds(pb, liveAnswers)) {");
    expect(src).toContain("coerceScopes((liveAnswers as Record<string, unknown>)[n.key])");
    expect(src).not.toMatch(/for \(const n of pb\.needs\) \{\s*if \(n\.slot\?\.type !== "scopes"\)/);
  });
});
