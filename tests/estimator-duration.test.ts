import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * THE ESTIMATOR GETS ITS TIME (2026-11-05). The estimator runs at effort high, up to 16000 tokens a
 * round and up to three rounds, not streamed; the statement scan reads at 16000 on /bills. A server
 * action runs under the segment config of the page that invoked it, so every page that renders the
 * estimate editor (the door to generateQuoteDraft and kin) and /bills says maxDuration = 300 — the
 * largest value the repo uses, never past it.
 */
const read = (p: string) => readFileSync(p, "utf8");
const DURATION = /export const maxDuration = (\d+);/;

function files(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) files(p, out);
    else if (/\.(ts|tsx)$/.test(p) && !/\.test\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

describe("the estimator's pages carry its time", () => {
  const all = files("src");
  const editorPages = all.filter((f) => f.endsWith("/page.tsx") && /from "(\.\.?\/)+estimate-editor"|from "@\/app\/\(app\)\/quotes\/estimate-editor"/.test(read(f)));

  it("finds the pages that render the estimate editor", () => {
    expect(editorPages.sort()).toEqual(["src/app/(app)/quotes/[id]/page.tsx", "src/app/(app)/quotes/new/page.tsx"]);
  });

  it("every one of them, and /bills, says maxDuration = 300", () => {
    for (const p of [...editorPages, "src/app/(app)/bills/page.tsx"]) {
      expect(read(p).match(DURATION)?.[1], p).toBe("300");
    }
  });

  it("no page or route asks for more than the largest the repo already uses (300)", () => {
    const most = Math.max(...all.map((f) => Number(read(f).match(DURATION)?.[1] ?? 0)));
    expect(most).toBe(300);
  });
});
