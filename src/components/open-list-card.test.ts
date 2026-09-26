import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { OpenListView } from "@/lib/supplier-open-list";

/**
 * THE ONE CARD (Erik, 2026-09-26: "we cant get too complicated for the user"). One sentence in the
 * supplier's own name, Apply and Not Now, the detail folded; when the list can't be read yet it asks
 * the one thing it needs. Every button Title Case and 44px tall.
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));
vi.mock("@/app/(app)/bills/open-list-actions", () => ({ applyOpenList: vi.fn(), pickOpenListAccount: vi.fn(), pickOpenListColumns: vi.fn() }));
vi.mock("@/app/(app)/organize/paperwork-actions", () => ({ keepPaperwork: vi.fn() }));

import { OpenListCard } from "./open-list-card";

const textOf = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const buttons = (html: string) => [...html.matchAll(/<button[^>]*>[\s\S]*?<\/button>/g)].map((m) => ({ markup: m[0], text: textOf(m[0]) }));
const titleCase = (s: string) => s.split(/\s+/).filter((w) => /^[a-z]/i.test(w)).every((w) => /^[A-Z]/.test(w));

const BASE: OpenListView = {
  supplier: "Consolidated Electrical Distributors",
  accountId: "a1",
  accountFrom: "number",
  accounts: [{ id: "a1", name: "Consolidated Electrical Distributors" }],
  needs: null,
  dateSaid: "Sep 26, the day the file was saved",
  problem: null,
  plan: {
    headline: "Consolidated Electrical Distributors' open list of Sep 26: 16 papers marked paid ($2,070.22), 3 new, balance now $3,304.73.",
    discountLine: "After $30.79 of prompt-pay discount on the list: $3,273.94.",
    complete: { ok: false, said: "The list doesn't print its own total, so it could be one page of several." },
    fingerprint: "abc",
    nothing: false,
    close: [{ id: "p1", number: "8802-1103832", date: "2026-07-22", open: 10.29 }],
    keepNewer: [],
    keepUndated: [],
    add: [{ number: "8802-1108647", kind: "invoice", date: "2026-09-23", po: "13897 HERRING", open: 103.99 }],
    update: [],
    conflicts: [],
    payments: [],
    skipped: [],
    before: 5174.62,
    after: 3304.73,
    firstList: false,
  },
};

const render = (view: OpenListView | null) =>
  renderToStaticMarkup(createElement(OpenListCard, { itemId: "i1", view, run: () => {}, busy: null, working: false }));

describe("the open-list card", () => {
  it("says it in one sentence, with Apply and Not Now, the detail folded", () => {
    const html = render(BASE);
    const text = textOf(html);
    expect(text).toContain(BASE.plan!.headline);
    expect(text).toContain("$3,273.94");
    expect(buttons(html).map((b) => b.text)).toEqual(["This Is The Whole Open List: Apply", "Not Now"]);
    expect(html).toContain("<details");
    expect(text).toContain("See What It Changes");
  });

  it("is just Apply when the list is known to be whole", () => {
    const html = render({ ...BASE, plan: { ...BASE.plan!, complete: { ok: true, said: "" } } });
    expect(buttons(html).map((b) => b.text)).toEqual(["Apply", "Not Now"]);
  });

  it("asks whose list it is when nothing on it names an account", () => {
    const html = render({ ...BASE, supplier: null, accountId: null, plan: null });
    expect(textOf(html)).toContain("Whose list is this?");
    expect(buttons(html).map((b) => b.text)).toEqual(["Use This Supplier", "Not Now"]);
  });

  it("asks for the columns once, showing the list itself", () => {
    const html = render({
      ...BASE,
      plan: null,
      needs: { header: ["Doc Ref Code", "When", "Still Owing"], sample: [["Q-1001", "09/01/26", "10.00"]], headerRow: 0, width: 3, columns: {}, missing: ["reference", "openBalance"] },
    });
    const text = textOf(html);
    expect(text).toContain("Doc Ref Code");
    expect(text).toContain("Q-1001");
    expect(buttons(html).map((b) => b.text)).toEqual(["Read It With These Columns", "Not Now"]);
  });

  it("says what stops it, and never leaves a dead end", () => {
    const html = render({ ...BASE, plan: null, problem: "There is no supplier account to check it against yet." });
    expect(textOf(html)).toContain("There is no supplier account");
    expect(buttons(html).map((b) => b.text)).toEqual(["Not Now"]);
  });

  it("every button is Title Case and 44px tall", () => {
    for (const html of [render(BASE), render({ ...BASE, plan: null })]) {
      for (const b of buttons(html)) {
        expect(titleCase(b.text)).toBe(true);
        expect(b.markup).toMatch(/\bh-11\b/);
      }
    }
  });
});
