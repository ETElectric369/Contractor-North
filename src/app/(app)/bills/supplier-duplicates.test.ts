import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * THE SAME TICKET ON TWO JOBS has a third answer (0400 both_real_at; cn-v1137): Both Are Real. The
 * card is rendered the way Reconcile draws it (react-dom/server), with the router stubbed.
 */
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

import { SupplierDuplicates, type SupplierDuplicateActions } from "./supplier-duplicates";
import type { DuplicateBillGroup } from "./supplier-balance";

const group = (over: Partial<DuplicateBillGroup> = {}): DuplicateBillGroup => ({
  id: 'dup:["a","b"]',
  amount: 95.27,
  lineCount: 8,
  copies: [
    { billId: "a", jobId: "job-a", jobName: "13 Larkspur", billDate: "2026-07-29", supplier: "Catbird Electric Supply", source: "ticket.pdf" },
    { billId: "b", jobId: "job-b", jobName: "41 Bayberry", billDate: "2026-08-28", supplier: "Catbird Electric Supply", source: "85 Whit.pdf" },
  ],
  resolution: null,
  ...over,
});

const full: SupplierDuplicateActions = { resolveDuplicate: vi.fn(), unresolveDuplicate: vi.fn(), markBothReal: vi.fn(), unmarkBothReal: vi.fn() };
const render = (groups: DuplicateBillGroup[], actions: SupplierDuplicateActions = full) =>
  renderToStaticMarkup(createElement(SupplierDuplicates, { groups, actions }));
const buttons = (html: string) => [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((m) => m[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim());

describe("Both Are Real on the card", () => {
  it("an open pair offers Keep It On each job AND one Both Are Real for the pair, every button Title Case", () => {
    const html = render([group()]);
    const b = buttons(html);
    expect(b).toContain("Keep It On 13 Larkspur");
    expect(b).toContain("Keep It On 41 Bayberry");
    expect(b.filter((t) => t === "Both Are Real")).toHaveLength(1);
    for (const t of b) expect(t, t).toMatch(/^(?:[A-Z0-9][^\s]*)(?:\s+[A-Z0-9][^\s]*)*$/);
    expect(html).toContain("Both Are Real keeps both costs where they are and the pair stops being asked about.");
    expect(html).toContain("or that both are real purchases");
  });

  it("an answered pair offers neither pick nor Both Are Real; a mount without the door draws no button", () => {
    const answered = render([group({ resolution: { keptBillId: "a" } })]);
    expect(answered).not.toContain("Both Are Real");
    expect(answered).not.toContain("Keep It On");
    const noDoor = render([group()], { resolveDuplicate: vi.fn(), unresolveDuplicate: vi.fn() });
    expect(noDoor).not.toContain("Both Are Real");
    expect(noDoor).not.toContain("both are real purchases");
    expect(buttons(noDoor)).toContain("Keep It On 13 Larkspur");
  });
});

/**
 * THE UNDO VANISHED FOR THE LAST PAIR (skeptic #43, S3). Answering the last group took the list to
 * zero; the card returned null on an empty list and Reconcile unmounted it below zero groups — so the
 * done banner, and the Undo on it, went with the very answer it was offering to take back. The card
 * stays mounted while `done` is set, and the page mounts it whenever the door exists at all.
 */
describe("the done banner and its Undo outlive the last pair", () => {
  const card = readFileSync(join(process.cwd(), "src/app/(app)/bills/supplier-duplicates.tsx"), "utf8");
  const page = readFileSync(join(process.cwd(), "src/app/(app)/reconcile/page.tsx"), "utf8");

  it("nothing to ask and nothing just done: the card draws nothing", () => {
    expect(render([])).toBe("");
  });

  it("the card returns null only when there are no groups AND nothing was just done", () => {
    expect(card).toContain("if (!groups.length && !done) return null;");
    expect(card).not.toContain("if (!groups.length) return null;");
    // The hooks come first, so the mount is one shape whatever the list says.
    expect(card.indexOf("useState<{ text: string; undo: Undo | null } | null>(null)")).toBeLessThan(card.indexOf("if (!groups.length && !done) return null;"));
  });

  it("Reconcile mounts the card whenever the supersede door exists, never only while groups remain", () => {
    expect(page).toContain("{work.supersedeReady && (");
    expect(page).not.toContain("work.duplicates.length > 0 &&");
  });
});
