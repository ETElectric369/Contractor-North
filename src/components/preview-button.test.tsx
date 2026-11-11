import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { LangProvider } from "@/components/lang-provider";
import { PreviewButton } from "./preview-button";
import { pdfPreviewBackHref, pdfPreviewHref } from "@/lib/pdf-preview-back";
import { translator } from "@/lib/i18n";
import { words as qt } from "@/lib/words/quotes";
import { titleCaseIn } from "../../tests/title-case-words";

// The button goes by the app's own router once a save it waited for has landed (cn-v1157).
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }) }));

/**
 * PREVIEW, IN THE HEADER (Erik, 2026-11-10: "lets add a preview button on the top bar next to send on
 * all estimates and invoices converting to pdf so i dont have to search for it"). This is the door
 * itself: where it goes, how it looks, its words in both languages, and that it stays an in-app
 * link. Where each page stands it beside Send is pinned beside that page
 * (billing/[id]/preview-door.test.ts, quotes/preview-door.test.tsx). Every id here is invented.
 */
const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");
const src = read("src/components/preview-button.tsx");
const INV = "7f1c0d2e-0000-4000-8000-00000000a001";
const EST = "7f1c0d2e-0000-4000-8000-00000000b002";
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

describe("the address is the one the app already had", () => {
  it("an invoice and an estimate open at /print/pdf-preview, byte for byte where the ⋯ rows went, back= included", () => {
    // The invoice ⋯'s "Preview / Print" and the estimate ⋯'s "Print / PDF" carried exactly these.
    expect(pdfPreviewHref("invoice", INV)).toBe(`/print/pdf-preview?doc=invoice&id=${INV}&back=/billing/${INV}`);
    expect(pdfPreviewHref("quote", EST)).toBe(`/print/pdf-preview?doc=quote&id=${EST}&back=/quotes/${EST}`);
    // One function writes the address, and the button writes none of its own.
    expect(src).toContain('import { pdfPreviewHref, type PreviewedDoc } from "@/lib/pdf-preview-back";');
    expect(src.replace(/\/\*[\s\S]*?\*\//g, "")).not.toContain("/print/");
  });

  it("the viewer takes it: Back lands on the document's own page, and the one PDF engine knows both documents", () => {
    expect(pdfPreviewBackHref("invoice", INV, `/billing/${INV}`)).toBe(`/billing/${INV}`);
    expect(pdfPreviewBackHref("quote", EST, `/quotes/${EST}`)).toBe(`/quotes/${EST}`);
    // One way to make the PDF: the viewer fetches /api/pdf/<doc>/<id>, and that route's list holds both.
    expect(read("src/app/print/pdf-preview/viewer.tsx")).toContain("fetch(`/api/pdf/${doc}/${id}?m=${m}`");
    expect(read("src/app/api/pdf/[doc]/[id]/route.ts")).toMatch(/const DOCS: Record<string, string> = \{\s*invoice: "invoice",\s*quote: "quote",/);
    // ...and this file renders nothing of its own: no second renderer, no fetch, no blob.
    expect(src).not.toMatch(/\bfetch\(|createObjectURL|application\/pdf|renderToStaticMarkup/);
  });
});

describe("the door as it is drawn", () => {
  const invoice = renderToStaticMarkup(<PreviewButton doc="invoice" id={INV} />);
  const estimate = renderToStaticMarkup(<PreviewButton doc="quote" id={EST} />);

  it("one link to the address, saying Preview, with the eye before the word", () => {
    expect(invoice).toMatch(/^<a [^>]*href="\/print\/pdf-preview\?doc=invoice&amp;id=[0-9a-f-]+&amp;back=\/billing\/[0-9a-f-]+"/);
    expect(invoice).toContain(`href="/print/pdf-preview?doc=invoice&amp;id=${INV}&amp;back=/billing/${INV}"`);
    expect(estimate).toContain(`href="/print/pdf-preview?doc=quote&amp;id=${EST}&amp;back=/quotes/${EST}"`);
    for (const html of [invoice, estimate]) {
      expect(text(html)).toBe("Preview");
      expect(html.match(/<a /g)).toHaveLength(1);
      expect(html).toMatch(/<svg[^>]*lucide-eye[^>]*>[\s\S]*<\/svg> Preview<\/a>$/);
    }
  });

  it("an outline button 44px tall that never shrinks: the row wraps instead", () => {
    const cls = /class="([^"]*)"/.exec(invoice)![1].split(" ");
    for (const c of ["h-11", "inline-flex", "whitespace-nowrap", "border", "border-slate-300", "bg-white", "rounded-lg", "px-4"]) expect(cls, c).toContain(c);
    // Outline, not the primary's fill: Send stays the one filled button in the row.
    expect(cls.some((c) => c.startsWith("bg-[rgb(var(--glass-ink))]"))).toBe(false);
    expect(cls).not.toContain("shrink");
    expect(cls).not.toContain("truncate");
  });

  it("with no id yet (an estimate nobody has saved) nothing is drawn", () => {
    expect(renderToStaticMarkup(<PreviewButton doc="quote" id={null} />)).toBe("");
    expect(renderToStaticMarkup(<PreviewButton doc="quote" id={undefined} />)).toBe("");
    expect(renderToStaticMarkup(<PreviewButton doc="quote" id="" />)).toBe("");
  });
});

describe("the words", () => {
  it("Preview and Vista Previa, from the catalog, Title Case in both languages", () => {
    expect(qt.en.qt_btn_preview).toBe("Preview");
    expect(qt.es.qt_btn_preview).toBe("Vista Previa");
    expect(titleCaseIn(qt.en.qt_btn_preview, "en")).toBe(true);
    expect(titleCaseIn(qt.es.qt_btn_preview, "es")).toBe(true);
    expect(translator("es")("qt_btn_preview")).toBe("Vista Previa");
    expect(qt.sameInBoth).not.toContain("qt_btn_preview");
  });

  it("a Spanish-speaking person reads Vista Previa on an invoice and on an estimate; English is the default", () => {
    const es = (doc: "invoice" | "quote", id: string) =>
      renderToStaticMarkup(
        <LangProvider lang="es">
          <PreviewButton doc={doc} id={id} />
        </LangProvider>,
      );
    expect(text(es("invoice", INV))).toBe("Vista Previa");
    expect(text(es("quote", EST))).toBe("Vista Previa");
    // The address does not follow the language.
    expect(es("invoice", INV)).toContain(`href="/print/pdf-preview?doc=invoice&amp;id=${INV}&amp;back=/billing/${INV}"`);
    const en = renderToStaticMarkup(
      <LangProvider lang="en">
        <PreviewButton doc="invoice" id={INV} />
      </LangProvider>,
    );
    expect(en).toBe(renderToStaticMarkup(<PreviewButton doc="invoice" id={INV} />));
  });

  it("the catalog names this file, so the leak scan reads it, and its one word comes through t()", () => {
    expect(qt.files).toContain("src/components/preview-button.tsx");
    expect(src).toContain('{waiting ? t("qt_btn_saving") : t("qt_btn_preview")}');
    expect(src).toContain("const t = translator(useLang());");
  });
});

describe("it shows what is saved, so it waits for the save", () => {
  it("drawn at rest it is the plain link: no busy mark, the word Preview", () => {
    const html = renderToStaticMarkup(<PreviewButton doc="invoice" id={INV} />);
    expect(html).not.toContain("aria-busy");
    expect(text(html)).toBe("Preview");
  });

  it("the words it says while it waits, and when the save has not landed, in both languages", () => {
    expect(qt.en.qt_btn_saving).toBe("Saving…");
    expect(qt.es.qt_btn_saving).toBe("Guardando…");
    expect(qt.en.qt_previewStillSaving).toBe("That change is still saving, so the preview would be missing it. Try Preview again in a moment.");
    expect(qt.es.qt_previewStillSaving).toBe("Ese cambio aún se está guardando, así que la vista previa no lo tendría. Intenta de nuevo en un momento.");
  });
});

describe("where Nort says the PDF is", () => {
  const map = read("src/lib/nort-product-map.ts");
  const line = map.split("\n").find((l) => l.startsWith("- Document PDFs:")) ?? "";

  it("the product map names the header's Preview, not the ⋯ row that left", () => {
    expect(line).toContain("Preview, the button at the top of every invoice and every saved estimate, next to Send (next to Get Paid once an invoice is out), opens the real PDF; Print and Download PDF are inside it.");
    expect(line).toContain("It is no longer a row under the ⋯.");
    expect(map).not.toContain("Preview/Print on any invoice");
    // True in code: both pages draw the one component, and the viewer's bar holds Print and Download PDF.
    expect(read("src/app/(app)/billing/[id]/page.tsx")).toContain('<PreviewButton doc="invoice" id={inv.id} />');
    expect(read("src/app/(app)/quotes/estimate-editor.tsx")).toContain('<PreviewButton doc="quote" id={savedId} />');
    const viewer = read("src/app/print/pdf-preview/viewer.tsx");
    expect(viewer).toContain('<Printer className="h-4 w-4" /> Print');
    expect(viewer).toContain('<Download className="h-4 w-4" /> Download PDF');
    // The invoices line says there is a second button in the header now.
    expect(map).toContain("each invoice has one main button, Send $X then Get Paid $X, with Preview beside it (the bill as its PDF)");
  });

  it("the other papers it names still open the same viewer from their own doors", () => {
    expect(line).toContain("A work order's Print / PDF button, a change order's printer icon and a material list's Pick List open the same viewer.");
    const workOrder = read("src/app/(app)/work-orders/[id]/page.tsx");
    expect(workOrder).toContain("/print/pdf-preview?doc=work-order&id=${w.id}");
    expect(workOrder).toContain("Print / PDF");
    expect(read("src/app/(app)/jobs/[id]/page.tsx")).toContain("/print/pdf-preview?doc=change-order&id=${c.id}");
    expect(read("src/app/(app)/materials/[id]/page.tsx")).toMatch(/\/print\/pdf-preview\?doc=material-list&id=\$\{l\.id\}[\s\S]{0,400}\{t\("mt_pickList"\)\}/);
    expect(translator("en")("mt_pickList")).toBe("Pick List");
  });
});

describe("in the iOS shell it does what the old rows did", () => {
  it("an in-app link: no window.open, no new tab, no shell fork; its one handler is the wait for a save", () => {
    expect(src).toContain('import Link from "next/link";');
    expect(src).toContain("const href = pdfPreviewHref(doc, id);");
    expect(src).toMatch(/<Link\s+href=\{href\}\s+className=\{LOOK\}/);
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(code).not.toMatch(/window\.open|target=|isNativeShell|navigator\.share|location\./);
    // One handler (the save gate) and one router call: the same in-app navigation the link makes,
    // to the same address, made after the save it waited for has landed.
    expect(code.match(/onClick/g)).toHaveLength(1);
    expect(code.match(/router\./g)).toHaveLength(1);
    expect(code).toContain("router.push(href)");
  });
});
