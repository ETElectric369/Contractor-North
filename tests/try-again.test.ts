import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
import { tryAgain } from "@/lib/try-again";

/**
 * TRY AGAIN, FOR REAL (audit v1018, class 9). `reset` alone re-renders the same cached server payload,
 * which still holds the throw, so Try Again brought the same error card straight back. The page is
 * fetched again first: router.refresh(), then reset(), in one transition.
 */
describe("tryAgain", () => {
  it("fetches the page again, then clears the error, inside one transition", () => {
    const calls: string[] = [];
    let inTransition = false;
    const router = { refresh: () => calls.push(`refresh${inTransition ? " (in transition)" : ""}`) };
    const reset = () => calls.push(`reset${inTransition ? " (in transition)" : ""}`);
    const startTransition = (fn: () => void) => {
      inTransition = true;
      fn();
      inTransition = false;
    };
    tryAgain(router, reset, startTransition);
    expect(calls).toEqual(["refresh (in transition)", "reset (in transition)"]);
  });
});

describe("every error page's Try Again goes through tryAgain", () => {
  const root = path.resolve(__dirname, "..", "src", "app");
  const pages: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === "error.tsx" || e.name === "global-error.tsx") pages.push(p);
    }
  };
  walk(root);

  it("finds the error pages (so an empty walk can never pass)", () => {
    expect(pages.length).toBeGreaterThanOrEqual(4);
  });

  it("none wires the bare reset to a button; each uses useTryAgain(reset)", () => {
    const bad: string[] = [];
    for (const p of pages) {
      const text = fs.readFileSync(p, "utf8");
      const rel = path.relative(root, p);
      if (/onClick=\{\s*reset\s*\}/.test(text) || /onClick=\{\s*\(\)\s*=>\s*reset\(\)\s*\}/.test(text)) bad.push(`${rel}: a button calls reset alone`);
      if (/\breset\b/.test(text) && !/useTryAgain\(reset\)/.test(text)) bad.push(`${rel}: takes reset but never calls useTryAgain(reset)`);
    }
    expect(bad).toEqual([]);
  });
});
