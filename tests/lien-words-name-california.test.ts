import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FEATURE_BY_KEY } from "@/lib/features";

/**
 * LIEN WORDS NAME CALIFORNIA (cn-v1134). The 20-day Preliminary Notice, the 90-day lien deadline and
 * the lien-rights blocker are California's rules (lib/prelim-notice.ts and the print page already
 * say so). A contractor in another state read them as the law everywhere; now every place a lien
 * rule is stated says whose it is, in plain words. Build for millions: other states later.
 */
const ROOT = path.resolve(__dirname, "..");
const read = (f: string) => readFileSync(path.join(ROOT, f), "utf8");

describe("every lien rule stated names California", () => {
  it("the job's lien card, before tracking starts", () => {
    expect(read("src/app/(app)/jobs/[id]/lien-insurance-card.tsx")).toContain(
      "Track the California 20-day Preliminary Notice and 90-day lien deadlines so you never lose lien rights.",
    );
  });

  it("the lien card's other two rules name California too: the notice not required, and the 60-day deadline after a Notice of Completion", () => {
    const card = read("src/app/(app)/jobs/[id]/lien-insurance-card.tsx");
    expect(card).toContain("No California preliminary notice required (direct contractor, no construction lender).");
    expect(card).toContain("Shortens the California lien deadline to 60 days (30 if you&apos;re a subcontractor).");
    expect(card).not.toContain("No preliminary notice required");
    expect(card).not.toContain("Shortens the lien deadline");
  });

  it("the delete blocker names the served notice as California's", () => {
    const s = read("src/app/(app)/jobs/actions.ts");
    expect(s).toContain('blockers.push("a served California preliminary notice (your lien rights)");');
    expect(s).not.toContain('"a served preliminary notice');
  });

  it("the Contracts & Lien Rights switch says California today, other states later", () => {
    const f = FEATURE_BY_KEY.contracts;
    expect(f.label).toBe("Contracts & Lien Rights");
    expect(f.line).toBe("E-sign contracts, payment schedules and lien deadlines. California rules today; other states later.");
    expect(f.line.length).toBeLessThanOrEqual(110); // the feature board's one plain line (features.test.ts)
  });

  it("the notice itself already said so", () => {
    expect(read("src/lib/prelim-notice.ts")).toMatch(/California/);
  });
});
