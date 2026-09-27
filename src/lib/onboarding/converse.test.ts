import { describe, it, expect } from "vitest";
import { conversePrompt } from "./converse";
import { SETUP_PLAYBOOK } from "./setup-playbook";

const trade = SETUP_PLAYBOOK.needs.find((n) => n.key === "trade");

describe("conversePrompt: what's on file for the question on screen", () => {
  it("says it can be replaced, so a person's own words are filled and not just agreed with", () => {
    const p = conversePrompt(trade, { trade: "plumber" }, "master plumber and gas fitter", "");
    expect(p).toContain("on file already: plumber");
    expect(p).toMatch(/theirs replaces this one/);
  });

  it("says nothing of the kind when the question is still open", () => {
    expect(conversePrompt(trade, {}, "I build decks", "")).not.toContain("on file already");
  });
});
