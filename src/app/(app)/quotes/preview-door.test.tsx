import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { catalog, renderers, savedProps, text } from "./editor-test-mocks";

/**
 * THE ESTIMATE'S PREVIEW STANDS IN THE HEADER, BESIDE SEND (Erik, 2026-11-10: "lets add a preview
 * button on the top bar next to send on all estimates and invoices converting to pdf so i dont have
 * to search for it"). It was the ⋯'s "Print / PDF" row; it is a button in the header's row now, at
 * every status, and the row is gone with its words: one door to the paper, not two. The one estimate
 * editor is rendered here both ways, with a row (/quotes/[id]) and with none (/quotes/new). The door
 * itself (its address, its look, that it is an in-app link) is driven in
 * components/preview-button.test.tsx. Every name here is invented.
 */

// A CLOSED MODAL DRAWS NOTHING, as the real one does (ui/modal: `if (!open) return null`). The shared
// stand-in in editor-test-mocks draws every sheet whether or not it is open, which would put the Send
// sheet's own fields between Send and the button beside it. This one is registered after that module
// loaded and before the editor does, so the editor below is drawn with its sheets shut.
vi.doMock("@/components/ui/modal", () => ({
  Modal: ({ open, children, footer }: { open?: boolean; children?: ReactNode; footer?: ReactNode }) =>
    open ? createElement("div", { "data-modal": "" }, children, footer) : null,
  ModalActions: () => null,
}));

const { LangProvider } = await import("@/components/lang-provider");
const { EstimateEditor } = await import("./estimate-editor");
const { words: qe } = await import("@/lib/words/quotes-editor");
const { words: qt } = await import("@/lib/words/quotes");
const { saved, unsaved } = renderers(EstimateEditor);
const editorSrc = readFileSync(join(process.cwd(), "src/app/(app)/quotes/estimate-editor.tsx"), "utf8");

/** The saved row's id in editor-test-mocks is q1, so this is the address its ⋯ row carried. */
const HREF = 'href="/print/pdf-preview?doc=quote&amp;id=q1&amp;back=/quotes/q1"';
/** Send's button closing, and Preview's link opening straight after it: nothing between the two. */
const sendThenPreview = (send: string, preview: string) =>
  new RegExp(`<button [^>]*type="button"[^>]*>(?:(?!</button>).)*?</svg> ${send}</button><a [^>]*href="/print/pdf-preview\\?doc=quote&amp;id=q1&amp;back=/quotes/q1"[^>]*>(?:(?!</a>).)*?</svg> ${preview}</a>`);
const line = { id: "li-1", description: "Larkspur panel swap", quantity: 1, unit: "ea", unit_price: 2400, category: null, detail: null, sort_order: 0 };

describe("a saved estimate: Preview beside Send, in the header", () => {
  it("a draft (the one he checks before it goes): the link sits immediately after Send, at the address the ⋯ row carried", () => {
    const html = saved({ status: "draft" }, [line]);
    expect(html.split(HREF)).toHaveLength(2); // once, and only once
    expect(html).toMatch(sendThenPreview("Send", "Preview"));
    // 44px, like Send beside it.
    const cls = /<a class="([^"]*)" href="\/print\/pdf-preview/.exec(html)![1].split(" ");
    expect(cls).toContain("h-11");
    expect(cls).toContain("whitespace-nowrap");
  });

  it("at every status, a locked estimate included: Preview is not Send's to gate", () => {
    for (const status of ["draft", "sent", "accepted", "declined", "superseded"]) {
      const html = saved({ status }, [line]);
      expect(html.split(HREF), status).toHaveLength(2);
      expect(html, status).toMatch(sendThenPreview("Send", "Preview"));
    }
    const locked = saved({ status: "accepted" }, [line], { lock: { reason: "A draw was already billed against it — revise it instead." } });
    expect(text(locked)).toContain("These line items are locked");
    expect(locked.split(HREF)).toHaveLength(2);
    // An estimate with no lines yet still has its paper (the ⋯ row never asked for a line either).
    expect(saved({ status: "draft" }, []).split(HREF)).toHaveLength(2);
  });

  it("in the header's own row, in order: Send, Preview, the status, Duplicate, then the ⋯ (pinned at the source)", () => {
    const at = editorSrc.indexOf('<SendButton kind="quote" id={savedId}');
    const row = editorSrc.slice(editorSrc.lastIndexOf("<div className=", at), editorSrc.indexOf("</div>", at));
    expect(row.split("\n")[0]).toBe('<div className="flex flex-wrap items-center gap-2">'); // it wraps; nothing shrinks
    expect(row.split("\n").slice(1).map((l) => /<([A-Z]\w+)/.exec(l)?.[1]).filter(Boolean)).toEqual([
      "SendButton",
      "PreviewButton",
      "StatusControl",
      "DuplicateQuoteButton",
      "DuplicateQuoteButton",
      "SectionActionsMenu",
    ]);
    expect(row).toContain('label={t("qt_btn_send")} />\n            <PreviewButton doc="quote" id={savedId} />\n');
    expect(editorSrc).toContain('import { PreviewButton } from "@/components/preview-button";');
  });
});

describe("an estimate nobody has saved: no Preview", () => {
  it("/quotes/new with no row draws no header, so no Send and no Preview", () => {
    for (const html of [unsaved(), unsaved({ items: [{ description: "Snowbell trench", quantity: 1, unit: "ea", unit_price: 290 }] })]) {
      expect(html).not.toContain("/print/pdf-preview");
      expect(html).not.toMatch(/<\/svg> Preview</);
      expect(html).not.toMatch(/<\/svg> Send</);
    }
  });

  it("the header is drawn only once there is a row, and Preview is handed that row's id (pinned at the source)", () => {
    expect(editorSrc).toContain('const savedId = mode.kind === "saved" ? mode.id : null;');
    const header = editorSrc.slice(editorSrc.indexOf("return (\n    <div>\n      {savedId && mode.kind === \"saved\" && ("), editorSrc.indexOf("{/* What went out for this estimate"));
    expect(header.length).toBeGreaterThan(500);
    expect(header.split("<PreviewButton")).toHaveLength(2);
    // ...and nowhere outside that header.
    expect(editorSrc.split("<PreviewButton")).toHaveLength(2);
  });
});

describe("in Spanish", () => {
  const inLang = (lang: "en" | "es", el: ReactElement) => renderToStaticMarkup(createElement(LangProvider, { lang } as never, el));
  const savedEl = () => createElement(EstimateEditor as never, { mode: "saved", saved: savedProps({ status: "draft" }, [line]), catalog: catalog() } as never) as ReactElement;

  it("Enviar, then Vista Previa, at the same address; English with no provider and with the 'en' one", () => {
    const html = inLang("es", savedEl());
    expect(html).toMatch(sendThenPreview("Enviar", "Vista Previa"));
    expect(html.split(HREF)).toHaveLength(2);
    expect(html).not.toMatch(/<\/svg> Preview</);
    expect(inLang("en", savedEl())).toBe(renderToStaticMarkup(savedEl()));
    expect(qt.en.qt_btn_preview).toBe("Preview");
    expect(qt.es.qt_btn_preview).toBe("Vista Previa");
  });
});

describe("one door: the ⋯'s Print / PDF row is gone, and the different verbs stay", () => {
  it("the menu's map makes no print row, the editor writes the address nowhere itself, and the row's words are retired in both languages", () => {
    const tree = editorSrc.slice(editorSrc.indexOf("function quoteTree("), editorSrc.indexOf("/** The words beside a refused write"));
    expect(tree).not.toContain("qm-print");
    expect(tree).not.toContain("pdf-preview");
    expect(editorSrc).not.toContain("/print/pdf-preview");
    expect(editorSrc).not.toContain("qe_btn_printPdf");
    expect(qe.en).not.toHaveProperty("qe_btn_printPdf");
    expect(qe.es).not.toHaveProperty("qe_btn_printPdf");
    // What the ⋯ still holds: what this estimate becomes, and Delete.
    expect([...tree.matchAll(/id: "(qm-[a-z]+)"/g)].map((m) => m[1])).toEqual(["qm-inv", "qm-inv", "qm-job", "qm-job", "qm-wo", "qm-wo", "qm-ml", "qm-ml", "qm-circuits", "qm-del"]);
  });

  it("Share (the customer's own link) stays on the title line: a different verb, not a second Preview", () => {
    expect(editorSrc).toContain('<ShareIconButton load={(opts) => quoteShareText(savedId, opts)} className="ml-auto shrink-0" />');
    const html = saved({ status: "draft" }, [line]);
    expect(html).toContain('aria-label="Share"');
  });
});
