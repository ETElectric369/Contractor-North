import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { STAFF_ROLES } from "@/lib/actions/perms";
import { viewerSeesOwnerMoney } from "@/lib/bank-viewer";

/**
 * WHO SEES THE OWNER'S OWN MONEY: ONE RULE, IN ONE FUNCTION, WITH TEETH.
 *
 * The rule (0286, the owner's "Office Can See This" switch): the owner always; office staff only
 * while the switch is on; nobody else, ever. A bank download is owner money line by line — the draw
 * and the personal spending — so every bank door asks the same question.
 *
 * IT HAD FOUR SPELLINGS. `viewerIsOwner || office_sees_owner_money` was typed out on /analytics, in
 * the accountant page's viewer and again in its download route, and read a fourth way inside
 * bank-viewer; moving the statement door onto Reconcile would have made five. That is the defect this
 * repo keeps shipping: one copy loses the staff test, or gains a role, and nobody finds out until a
 * figure turns up on a screen it was being kept off. So there is one function, every door calls it,
 * and the scan below fails if a door writes the condition out again.
 */
const ROOT = process.cwd();

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sourceFiles(p);
    return /\.tsx?$/.test(p) && !/\.(test|db-suite|db-fixture)\.tsx?$/.test(p) && !/\.d\.ts$/.test(p) ? [relative(ROOT, p)] : [];
  });
}
const FILES = sourceFiles(join(ROOT, "src"));
const read = (f: string) => readFileSync(join(ROOT, f), "utf8");

/** Where the rule lives, and the only file allowed to decide it. */
const THE_RULE = "src/lib/bank-viewer.ts";
/** Where the switch is stored and normalized. It holds no gate. */
const THE_SETTING = "src/lib/org-settings.ts";

describe("the rule itself", () => {
  it("the owner always, whatever the switch says", () => {
    expect(viewerSeesOwnerMoney("owner", false)).toBe(true);
    expect(viewerSeesOwnerMoney("owner", true)).toBe(true);
  });

  it("office staff follow the owner's switch, both ways", () => {
    for (const role of STAFF_ROLES.filter((r) => r !== "owner")) {
      expect(viewerSeesOwnerMoney(role, true), role).toBe(true);
      expect(viewerSeesOwnerMoney(role, false), role).toBe(false);
    }
    // And there IS someone other than the owner in that set, or this test proves nothing.
    expect(STAFF_ROLES.filter((r) => r !== "owner").length).toBeGreaterThan(0);
  });

  it("nobody outside the office, however the switch is left — and a missing sign-in is a no", () => {
    for (const role of ["tech", "customer", "", "nobody"]) {
      expect(viewerSeesOwnerMoney(role, true), role).toBe(false);
      expect(viewerSeesOwnerMoney(role, false), role).toBe(false);
    }
    expect(viewerSeesOwnerMoney(null, true)).toBe(false);
    expect(viewerSeesOwnerMoney(undefined, true)).toBe(false);
  });

  it("a switch that is anything but a real yes is a no (the stored-string lesson)", () => {
    for (const bad of [undefined, null, 0, 1, "true", "false", {}]) {
      expect(viewerSeesOwnerMoney("office", bad as unknown as boolean), String(bad)).toBe(false);
    }
  });
});

describe("no door writes the condition out a second time", () => {
  it("nothing joins a role to the owner's switch with an || of its own", () => {
    const hits: string[] = [];
    for (const f of FILES) {
      if (f === THE_RULE || f === THE_SETTING) continue;
      const src = read(f);
      if (!src.includes("office_sees_owner_money")) continue;
      src.split("\n").forEach((lineText, i) => {
        const code = lineText.replace(/\/\/.*$/, "");
        if (!code.includes("office_sees_owner_money")) return;
        // `x || office_sees_owner_money` or `office_sees_owner_money || x` is the rule, re-derived.
        if (/\|\|[^;]*office_sees_owner_money/.test(code) || /office_sees_owner_money[^;]*\|\|/.test(code)) {
          hits.push(`${f}:${i + 1}: ${code.trim()}`);
        }
      });
    }
    expect(hits).toEqual([]);
  });

  it("every door that needs the answer asks the one function for it", () => {
    for (const f of [
      "src/app/(app)/analytics/page.tsx",
      "src/app/(app)/analytics/accountant/viewer.ts",
      "src/app/(app)/analytics/accountant/export/route.ts",
      "src/app/(app)/reconcile/page.tsx",
    ]) {
      const src = read(f);
      expect(src, f).toContain("viewerSeesOwnerMoney");
      expect(src, f).toContain('from "@/lib/bank-viewer"');
    }
  });

  it("the bank actions keep reading it through viewerSortsBank, which is the same rule with the reads", () => {
    const rule = read(THE_RULE);
    expect(rule).toContain("viewerSeesOwnerMoney(me.role");
    for (const f of [
      "src/app/(app)/bills/bank-actions.ts",
      "src/app/(app)/bills/open-list-add-core.ts",
      "src/app/(app)/bills/bank-core.ts",
      "src/app/(app)/organize/actions.ts",
      "src/lib/action-items/query.ts",
    ]) {
      expect(read(f), f).toContain("viewerSortsBank");
    }
  });

  /**
   * AND IT IS A SCAN, NOT A LIST SOMEBODY HAS TO REMEMBER TO ADD TO. The list above went stale the
   * moment `addOpenList`'s body moved into a core of its own (2026-10-02) — the check travelled with
   * the body, as it had to, and the list still named the file it left. So the law is asked of the code:
   * whatever file puts a bank download in the tray asks the one function first, wherever it lives.
   */
  it("every file that creates a bank paper asks viewerSortsBank in the same file", () => {
    const makers = FILES.filter((f) => f !== "src/app/(app)/bills/bank-core.ts" && /\bcreateBankPaper\(/.test(read(f)));
    expect(makers.length).toBeGreaterThan(0);
    for (const f of makers) expect(read(f), f).toContain("viewerSortsBank(");
  });
});

/**
 * ONE DOOR, ON THE PAGE NAMED FOR THE JOB (Erik: "this should be in reconcile too i imagine"). The
 * drop door moved off /analytics rather than being copied onto Reconcile: two doors to one intake is
 * how one of them goes stale. Snap Or Note is a different thing and stays — it is THE one paper door
 * (W1-30) and takes photos and PDFs as well.
 */
describe("the statement door has exactly one home", () => {
  it("it lives in the reconcile folder and is rendered there, and nowhere else", () => {
    const defines = FILES.filter((f) => /export function BankDropLine\b/.test(read(f)));
    expect(defines).toEqual(["src/app/(app)/reconcile/bank-drop-line.tsx"]);
    const renders = FILES.filter((f) => read(f).includes("<BankDropLine"));
    expect(renders).toEqual(["src/app/(app)/reconcile/page.tsx"]);
  });

  it("Analytics has no bank drop line left on it", () => {
    const analytics = read("src/app/(app)/analytics/page.tsx");
    expect(analytics).not.toContain("BankDropLine");
    expect(analytics).not.toContain("bank-drop-line");
    expect(FILES).not.toContain("src/app/(app)/analytics/bank-drop-line.tsx");
  });
});
