import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { extrasSentence, importExtras } from "./import-extras";

describe("importExtras (audit v994 SI5)", () => {
  it("keeps the INV-074 drift warning and the return note a count would drop", () => {
    const x = importExtras([
      { ok: true, stats: { warnings: [] } },
      {
        ok: true,
        stats: {
          notes: ["one receipt's prices are a counter preview, not your account's pricing - check it before you send"],
          warnings: ["The edited Supplies & tax row for CED is $12.40 short of its parts."],
        },
      },
    ]);
    expect(x.warnings).toEqual(["The edited Supplies & tax row for CED is $12.40 short of its parts"]);
    expect(extrasSentence(x)).toBe(
      " One receipt's prices are a counter preview, not your account's pricing - check it before you send. The edited Supplies & tax row for CED is $12.40 short of its parts.",
    );
  });

  it("an empty materials run passes on a held return; a failed one says nothing here (the door names it)", () => {
    const x = importExtras([
      { ok: false, empty: true, emptyNote: "a $60.00 return from CED is held for an invoice that bills more than it" },
      { ok: false, empty: false, emptyNote: "never read" },
      { ok: false, empty: true },
    ]);
    expect(x).toEqual({ warnings: [], notes: ["a $60.00 return from CED is held for an invoice that bills more than it"] });
  });

  it("nothing said is an empty string, so a door's own sentence is unchanged", () => {
    expect(extrasSentence(importExtras([{ ok: true, stats: {} }]))).toBe("");
  });

  it("the job-level doors read the extras (a count alone dropped them)", () => {
    const root = join(__dirname, "..", "..");
    const jobs = readFileSync(join(root, "src/app/(app)/jobs/actions.ts"), "utf8");
    expect(jobs).toContain("out.results.push(r);");
    expect((jobs.match(/importExtras\(pulled\.results\)/g) ?? []).length).toBe(2);
    const billing = readFileSync(join(root, "src/app/(app)/billing/actions.ts"), "utf8");
    expect(billing).toContain("importExtras([pLabor, pCosts])");
    expect(billing).toContain("emptyNote: returnsSummaryParts(");
  });
});
