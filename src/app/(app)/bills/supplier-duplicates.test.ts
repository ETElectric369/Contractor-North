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

import { RECONCILE_WITHOUT_PICK, SupplierDuplicates, landingAfter, type SupplierDuplicateActions } from "./supplier-duplicates";
import { titleCaseIn } from "../../../../tests/title-case-words";
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
  it("an open pair offers Keep It on each job AND one Both Are Real for the pair, every button Title Case", () => {
    const html = render([group()]);
    const b = buttons(html);
    expect(b).toContain("Keep It on 13 Larkspur");
    expect(b).toContain("Keep It on 41 Bayberry");
    expect(b.filter((t) => t === "Both Are Real")).toHaveLength(1);
    for (const t of b) expect(titleCaseIn(t, "en"), t).toBe(true);
    expect(html).toContain("Both Are Real keeps both costs where they are and the pair stops being asked about.");
    expect(html).toContain("or that both are real purchases");
  });

  it("an answered pair offers neither pick nor Both Are Real; a mount without the door draws no button", () => {
    const answered = render([group({ resolution: { keptBillId: "a" } })]);
    expect(answered).not.toContain("Both Are Real");
    expect(answered).not.toContain("Keep It on");
    const noDoor = render([group()], { resolveDuplicate: vi.fn(), unresolveDuplicate: vi.fn() });
    expect(noDoor).not.toContain("Both Are Real");
    expect(noDoor).not.toContain("both are real purchases");
    expect(buttons(noDoor)).toContain("Keep It on 13 Larkspur");
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

  it("the card returns null only when there are no groups AND nothing was just done (AND no stray pick, cn-v1186)", () => {
    expect(card).toContain("if (!groups.length && !done && !strayPick) return null;");
    expect(card).not.toContain("if (!groups.length) return null;");
    // The hooks come first, so the mount is one shape whatever the list says.
    expect(card.indexOf("useState<{ text: string; undo: Undo | null } | null>(null)")).toBeLessThan(card.indexOf("if (!groups.length && !done && !strayPick) return null;"));
  });

  it("Reconcile mounts the card whenever the supersede door exists, never only while groups remain", () => {
    expect(page).toContain("{work.supersedeReady && (");
    expect(page).not.toContain("work.duplicates.length > 0 &&");
  });
});

/**
 * DISMISS (0419 duplicate_dismissed_at; cn-v1186): "im not going to change my mind, dismiss please".
 * An ANSWERED pair carries Dismiss beside Change Your Mind; an open pair never does; its Undo is the
 * restore door; and the sentence over an all-answered card says where a dismissed pick goes.
 */
describe("Dismiss on an answered pair", () => {
  const withDismiss: SupplierDuplicateActions = { ...full, dismissDuplicate: vi.fn(), restoreDuplicate: vi.fn() };
  const card = readFileSync(join(process.cwd(), "src/app/(app)/bills/supplier-duplicates.tsx"), "utf8");

  it("an answered pair offers Change Your Mind and Dismiss, both Title Case", () => {
    const b = buttons(render([group({ resolution: { keptBillId: "a" } })], withDismiss));
    expect(b).toEqual(["Change Your Mind", "Dismiss"]);
    for (const t of b) expect(titleCaseIn(t, "en"), t).toBe(true);
  });

  it("an open pair never offers Dismiss", () => {
    expect(buttons(render([group()], withDismiss))).not.toContain("Dismiss");
  });

  it("a mount without the door draws no Dismiss and keeps the old sentence", () => {
    const html = render([group({ resolution: { keptBillId: "a" } })]);
    expect(buttons(html)).not.toContain("Dismiss");
    expect(html).toContain("The picks you made are below, and you can change any of them.");
  });

  it("with the door, the all-answered sentence says a dismissed pick leaves this page", () => {
    expect(render([group({ resolution: { keptBillId: "a" } })], withDismiss)).toContain(
      "Nothing is waiting on you here. The picks you made are below: change one, or dismiss it and it leaves this page.",
    );
  });

  it("Dismiss runs the dismiss door through the card's own run, with the restore door as its Undo", () => {
    expect(card).toMatch(/run\(\s*\(\) => actions\.dismissDuplicate!\(g\.id\),\s*`dismiss:\$\{g\.id\}`,[\s\S]{0,200}undoDismiss\(g\.id\),\s*"leave-pick",\s*\)/);
    expect(card).toMatch(/const undoDismiss = \(groupId: string\): Undo \| null =>\s*actions\.restoreDuplicate\s*\?\s*\{ fn: \(\) => actions\.restoreDuplicate!\(groupId\)/);
    // Only under the answered branch: the button sits inside `g.resolution ? (` and before its `) : (`.
    const answeredBranch = card.slice(card.indexOf("{g.resolution ? (\n                  <>"), card.indexOf("<WhyFold>\n                    <p>\n                      Picking a job"));
    expect(answeredBranch).toContain("actions.dismissDuplicate && (");
  });

  it("Reconcile hands the card both doors", () => {
    const page = readFileSync(join(process.cwd(), "src/app/(app)/reconcile/page.tsx"), "utf8");
    expect(page).toContain("dismissDuplicate: dismissDuplicatePick,");
    expect(page).toContain("restoreDuplicate: restoreDuplicatePick,");
  });
});

/**
 * DISMISS ON A PAIR OPENED THROUGH `?pick=` TAKES IT OFF THE PAGE (cn-v1186, skeptic S4). A refresh
 * keeps the pick, and the pick draws the dismissed pair again; so a Dismiss there lands on the page
 * without the pick. Every other answer, and the Undo, still refreshes in place.
 */
describe("Dismiss on a page opened through a pick", () => {
  const card = readFileSync(join(process.cwd(), "src/app/(app)/bills/supplier-duplicates.tsx"), "utf8");
  const page = readFileSync(join(process.cwd(), "src/app/(app)/reconcile/page.tsx"), "utf8");

  it("lands on Reconcile without the pick, at the card", () => {
    expect(landingAfter("leave-pick", true)).toBe("/reconcile#same-ticket-two-jobs");
    expect(RECONCILE_WITHOUT_PICK).not.toContain("pick");
  });

  it("without a pick, and for every other answer, it refreshes in place", () => {
    expect(landingAfter("leave-pick", false)).toBeNull();
    expect(landingAfter("refresh", true)).toBeNull();
    expect(landingAfter("refresh", false)).toBeNull();
  });

  it("the run replaces the route on a landing and refreshes otherwise; only Dismiss asks to leave the pick", () => {
    expect(card).toMatch(/const landing = landingAfter\(then, picked\);\s*if \(landing\) router\.replace\(landing\);\s*else router\.refresh\(\);/);
    expect(card.match(/"leave-pick",\n/g)?.length).toBe(1);
    expect(card).toMatch(/undoDismiss\(g\.id\),\s*"leave-pick",\s*\)/);
    // The Undo runs with the default, a refresh: the restored pair is drawn again where it was.
    expect(card).toContain("onClick={() => run(done.undo!.fn, done.undo!.key, done.undo!.fallback)}");
  });

  it("Reconcile tells the card whether it was opened with a pick", () => {
    expect(page).toContain("picked={!!pick}");
  });
});

/**
 * THE CHANGE LINK NEVER LEADS NOWHERE (cn-v1186, skeptic S6): a pick whose copies no longer match is
 * held by no pair; the card says so in one line and offers Put It Back on that pair.
 */
describe("a pick that no pair holds", () => {
  const stray = { billId: "b", groupId: 'dup:["a","b"]', supplier: "Northline Supply", amount: 84.1, billDate: "2026-08-28" };
  const page = readFileSync(join(process.cwd(), "src/app/(app)/reconcile/page.tsx"), "utf8");
  const card = readFileSync(join(process.cwd(), "src/app/(app)/bills/supplier-duplicates.tsx"), "utf8");

  it("with no groups the card still draws, says so in one line, and offers Put It Back", () => {
    const html = renderToStaticMarkup(createElement(SupplierDuplicates, { groups: [], actions: full, strayPick: stray }));
    expect(html).toContain("Northline Supply · $84.10");
    expect(html).toContain("the two no longer match, so there is no pair to show here");
    expect(buttons(html)).toEqual(["Put It Back"]);
    expect(titleCaseIn("Put It Back", "en")).toBe(true);
    expect(html).not.toMatch(/please|!/i);
  });

  it("Put It Back runs the unresolve door on that pair, through the card's run (its answer said on the card)", () => {
    expect(card).toMatch(/run\(\s*\(\) => actions\.unresolveDuplicate!\(strayPick\.groupId\),\s*`unresolve:\$\{strayPick\.groupId\}`,/);
  });

  it("without a stray pick nothing extra is drawn", () => {
    expect(render([])).toBe("");
  });

  it("a mount without the unresolve door draws the line and no dead button", () => {
    const html = renderToStaticMarkup(
      createElement(SupplierDuplicates, { groups: [], actions: { resolveDuplicate: vi.fn() }, strayPick: stray }),
    );
    expect(html).toContain("no pair to show here");
    expect(buttons(html)).toEqual([]);
  });

  it("Reconcile hands the card the read's stray pick", () => {
    expect(page).toContain("strayPick={work.strayPick}");
  });
});
