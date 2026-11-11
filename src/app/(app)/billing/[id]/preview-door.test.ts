import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { pdfPreviewHref } from "@/lib/pdf-preview-back";

/**
 * THE INVOICE'S PREVIEW STANDS IN THE HEADER, BESIDE SEND (Erik, 2026-11-10: "lets add a preview
 * button on the top bar next to send on all estimates and invoices converting to pdf so i dont have
 * to search for it"). It was a row under the ⋯ ("Preview / Print"); it is a button in the header's
 * row now, at every status, and the row is gone: one door to the paper, not two.
 *
 * The page is an async server component over a dozen reads, so its header is read here with the
 * compiler (the way tests/title-case.test.ts reads every door): WHERE the button sits in the tree is
 * the claim, and a regex over the text could not tell a sibling of the status switch from a branch
 * of it. The door itself (its address, its look, its words in both languages, that it is an in-app
 * link) is driven in components/preview-button.test.tsx.
 */
const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");
const page = read("src/app/(app)/billing/[id]/page.tsx");
const sf = ts.createSourceFile("page.tsx", page, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

/** Every node of one kind, in source order. */
function every<T extends ts.Node>(is: (n: ts.Node) => n is T): T[] {
  const out: T[] = [];
  const walk = (n: ts.Node): void => {
    if (is(n)) out.push(n);
    ts.forEachChild(n, walk);
  };
  walk(sf);
  return out;
}
const tagOf = (n: ts.JsxElement | ts.JsxSelfClosingElement) => (ts.isJsxElement(n) ? n.openingElement.tagName : n.tagName).getText(sf);
/** An element's children as a person would list them: no whitespace, no comment. */
const kids = (el: ts.JsxElement) =>
  el.children.filter((c) => !(ts.isJsxText(c) && !c.getText(sf).trim()) && !(ts.isJsxExpression(c) && !c.expression));
/** The source with its comments gone: a comment may still name the row that left. */
const code = page.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const previews = every(ts.isJsxSelfClosingElement).filter((n) => tagOf(n) === "PreviewButton");
const menu = every(ts.isJsxElement).find((n) => tagOf(n) === "SectionActionsMenu")!;

describe("the invoice header's row: the primary, Preview, then the ⋯", () => {
  it("one Preview on the page, for this invoice, through the one component", () => {
    expect(page).toContain('import { PreviewButton } from "@/components/preview-button";');
    expect(previews).toHaveLength(1);
    expect(previews[0].getText(sf)).toBe('<PreviewButton doc="invoice" id={inv.id} />');
    // The address it opens is the one the ⋯ row carried (the page wrote it out by hand then).
    expect(pdfPreviewHref("invoice", "INV-ID")).toBe("/print/pdf-preview?doc=invoice&id=INV-ID&back=/billing/INV-ID");
  });

  it("it sits in the header's button row, immediately after the primary (Send on a draft) and before the ⋯", () => {
    const row = previews[0].parent;
    expect(ts.isJsxElement(row)).toBe(true);
    const el = row as ts.JsxElement;
    // The row that wraps on a phone rather than shrink a button; Send comes first, so it stays on screen.
    expect(el.openingElement.getText(sf)).toBe('<div className="flex flex-wrap items-start gap-2 self-start">');
    const children = kids(el);
    expect(children).toHaveLength(3);
    const [primary, preview, actions] = children;
    // 1. The status switch: Send $X on a draft, Get Paid $X once it is out, nothing when paid or void.
    expect(ts.isJsxExpression(primary)).toBe(true);
    const primaryText = primary.getText(sf);
    expect(primaryText).toMatch(/^\{isDraft \? \(/);
    expect(primaryText).toContain("<SendButton");
    expect(primaryText).toContain('kind="invoice"');
    expect(primaryText).toContain("label={`Send ${formatCurrency(Number(inv.total))}`}");
    expect(primaryText).toContain("<GetPaidButton {...payDoor} label={`Get Paid ${formatCurrency(balance)}`} />");
    expect(primaryText).toMatch(/\) : null\}$/);
    // 2. Preview, the very next thing.
    expect(preview).toBe(previews[0]);
    // 3. The ⋯, last.
    expect(actions).toBe(menu);
  });

  it("it is drawn whatever the status: a sibling of the status switch, never a branch of it (a void or paid bill has no Send, and still has Preview)", () => {
    // No condition stands anywhere between the page's return and the button: not a ?:, not a &&.
    let steps = 0;
    for (let p: ts.Node = previews[0].parent; p && p !== sf; p = p.parent) {
      steps++;
      expect(ts.isConditionalExpression(p), "Preview sits under a ?:").toBe(false);
      expect(ts.isBinaryExpression(p), "Preview sits under a &&").toBe(false);
      expect(ts.isIfStatement(p), "Preview sits under an if").toBe(false);
    }
    expect(steps).toBeGreaterThan(3); // it really walked: the row, the header, the page, the return
    expect(page).toMatch(/\) : null\}\n\s*<PreviewButton doc="invoice" id=\{inv\.id\} \/>\n\s*<SectionActionsMenu/);
    // The page 404s before this for an invoice that does not exist, so there is always an id to open.
    expect(page).toContain("if (!invoice) notFound();");
  });
});

describe("one door: the ⋯'s Preview / Print row is gone, and the different verbs stay", () => {
  it("nothing under the ⋯ opens the PDF any more, and the page writes the address nowhere itself", () => {
    const rows = kids(menu).map((c) => c.getText(sf));
    expect(rows.some((r) => /pdf-preview|Preview|Print/.test(r))).toBe(false);
    expect(code).not.toContain("/print/pdf-preview");
    expect(code).not.toMatch(/Preview \/ Print/);
    expect(code).not.toMatch(/\bPrinter\b/);
  });

  it("the ⋯ keeps its order from Send Again on: Send Again, Get Paid (a draft), Job, Credit / Refund, QuickBooks, Set Aside Until…, the status deeds", () => {
    const rows = kids(menu).map((c) => c.getText(sf));
    const firstLine = (s: string) => s.split("\n")[0].trim();
    expect(firstLine(rows[0])).toBe('{!isDraft && inv.status !== "void" && (');
    expect(rows[0]).toContain('label="Send Again"');
    expect(rows.map((r) => /<([A-Z]\w+)/.exec(r)?.[1])).toEqual([
      "SendButton",
      "GetPaidButton",
      "Link",
      "CreditButton",
      "QboInvoiceButton",
      "SetAsideButton",
      "InvoiceStatusMenuItems",
    ]);
    expect(rows[2]).toContain("href={`/jobs/${(inv as any).job_id}`}");
  });

  it("Share (the customer's own link) stays on the title line: a different verb, not a second Preview", () => {
    expect(page).toContain('<ShareIconButton load={invoiceShareText.bind(null, inv.id)} className="ml-auto" />');
  });

  it("the older-copy notice's Send in the body is not the header and grows no Preview", () => {
    const body = read("src/app/(app)/billing/[id]/invoice-detail.tsx");
    expect(body).toContain("<SendButton");
    expect(body).not.toContain("PreviewButton");
  });
});
