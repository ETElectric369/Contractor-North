import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { textOf } from "@/test/rendered-page";
import { NotNowOrDelete } from "./not-now-or-delete";

vi.mock("@/app/(app)/organize/paperwork-actions", () => ({ keepPaperwork: vi.fn() }));
vi.mock("@/app/(app)/organize/actions", () => ({ deleteOrganizedItem: vi.fn() }));

/**
 * ── A STATEMENT HE CAN BIN, AND A DOOR THAT SAYS WHERE THE PAPER WENT (2026-10-03) ─────────────
 *
 * Erik dropped a statement, wanted to bin it, and could not. A bank download's card and a supplier's
 * open-list card draw no ⋯ menu at all (nothing else on those rows applies), and `paperMenuRows` only
 * offers Delete on a paper the update cannot file — so the only way out was the put-it-away button,
 * which archived the paper with no word on the card about where it went. He could not find it again.
 */
const render = (label: string) =>
  renderToStaticMarkup(createElement(NotNowOrDelete, { itemId: "i1", what: "supplier's list", label, run: () => {}, working: false }));

const buttons = (html: string) => Array.from(html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)).map((m) => ({ text: textOf(m[1]).trim(), markup: m[0] }));

describe("putting a statement away, or binning it", () => {
  it("draws both doors, Title Case and a thumb tall", () => {
    const html = render("Not Now");
    expect(buttons(html).map((b) => b.text)).toEqual(["Not Now", "Delete"]);
    for (const b of buttons(html)) expect(b.markup, b.text).toMatch(/\bh-11\b/);
  });

  it("says where the paper goes ON THE CARD, not in a tooltip and not only in a toast", () => {
    const words = textOf(render("Not Now"));
    expect(words).toContain("Not Now keeps it in Organize, under Archive, and you can bring it back.");
    expect(words).toContain("Delete removes it and its file for good.");
    // A tooltip does not exist on a phone, which is where he was. The destination is in the page.
    expect(render("Not Now")).not.toMatch(/title="[^"]*Archive/);
  });

  it("wears the words of whichever card it is on", () => {
    expect(buttons(render("Set Aside")).map((b) => b.text)).toEqual(["Set Aside", "Delete"]);
    expect(textOf(render("Set Aside"))).toContain("Set Aside keeps it in Organize, under Archive");
  });

  /**
   * DELETE GOES THROUGH THE ONE FUNCTION THAT KNOWS WHAT A PAPER FILED. `deleteOrganizedItem` takes the
   * supplier documents a paper added down with it; a bespoke delete here would leave them behind. And it
   * is asked first, because it cannot be undone.
   */
  it("deletes through deleteOrganizedItem, behind a confirm that names the paper and its file", () => {
    const src = readFileSync(join(process.cwd(), "src/components/not-now-or-delete.tsx"), "utf8");
    expect(src).toContain('import { deleteOrganizedItem } from "@/app/(app)/organize/actions";');
    expect(src).toContain("deleteOrganizedItem(itemId)");
    expect(src).toMatch(/if \(confirm\(`Delete this \$\{what\}\?/);
    // `gone` (the 4th argument of the card's own write path) is what tells the toast there is no Undo.
    expect(src).toContain('run("delete", () => deleteOrganizedItem(itemId), undefined, "Deleted.")');
  });

  /** ONE PAIR, BOTH CARDS. A second copy is how one of them quietly loses its way out again. */
  it("is the only way either statement card puts a paper away or bins it", () => {
    for (const f of ["src/components/bank-card.tsx", "src/components/open-list-card.tsx"]) {
      const src = readFileSync(join(process.cwd(), f), "utf8");
      expect(src, f).toContain("<NotNowOrDelete");
      expect(src, f).not.toContain("<Trash2");
    }
  });
});
