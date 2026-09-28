import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * THE WALK-THROUGH IS CALLED A WALK-THROUGH (Wave 2, W2-10). The visit where the office walks the
 * job before pricing it is a "Walk-Through" everywhere a person reads it; Settings' empty sheet was
 * the last place still telling people to start one "from an inspection".
 */
describe("Settings' walk-through sheet, when there is none yet", () => {
  it("says to start a walk-through, never an inspection", () => {
    const s = readFileSync(new URL("./playbook-manager.tsx", import.meta.url), "utf8");
    expect(s).toContain("You don&rsquo;t have a walk-through sheet yet. Start a walk-through and it&rsquo;ll show up here.");
    expect(s).not.toContain("Start one from an inspection");
  });
});
