import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { catalog, renderers, savedProps, text } from "./editor-test-mocks";

/**
 * REVISE IS DRAWN IN ONE PLACE: INSIDE THE NOTICE THAT SAYS THE LINES ARE LOCKED (cn-v1169).
 *
 * Erik, 2026-11-19, after a second unit's quote made with Revise retired the first unit's: "so youre
 * telling me this Revise button creates a new duplicate ... and then theres a duplicate button that
 * also does the same thing?", then "i dont need to creat another document to revise my quote", and,
 * once it was explained where the app itself sends a person to Revise: "yes to hiding the revise
 * button inside locked quotes for good reason".
 *
 * It stood on the toolbar of every sent and every accepted estimate. An estimate that is not locked
 * is revised by editing it, so there the button was only a second Duplicate with a consequence nobody
 * could see. The one situation where the server refuses an edit and names Revise as the way out is an
 * accepted estimate with a signed contract or a billed scheduled payment on its job, and the button
 * sits under that refusal's own words now.
 *
 * The one estimate editor is rendered here with a row, at every status, with and without the lock the
 * page reads from the server rule. Every name is invented.
 */

// A closed sheet draws nothing, as the real one does (see preview-door.test for why this is re-mocked).
vi.doMock("@/components/ui/modal", () => ({
  Modal: ({ open, children, footer }: { open?: boolean; children?: ReactNode; footer?: ReactNode }) =>
    open ? createElement("div", { "data-modal": "" }, children, footer) : null,
  ModalActions: () => null,
}));

const { LangProvider } = await import("@/components/lang-provider");
const { EstimateEditor } = await import("./estimate-editor");
const { words: qs } = await import("@/lib/words/quotes-server");
const { saved } = renderers(EstimateEditor);
const editorSrc = readFileSync(join(process.cwd(), "src/app/(app)/quotes/estimate-editor.tsx"), "utf8");

const line = { id: "li-1", description: "Larkspur panel swap", quantity: 1, unit: "ea", unit_price: 2400, category: null, detail: null, sort_order: 0 };
/** The lock's sentence as the server words it, for an estimate with one billed scheduled payment. */
const DRAWN = "E-001 is accepted and 1 scheduled payment has already been billed against it — changing it now would re-price the remaining draws. Revise it instead (or void the draw).";
const SIGNED = "E-001 priced contract C-004, which the customer has already signed — changing it now would re-price the draws against a total they never agreed to. Revise it instead (or void the contract).";
/** Revise's button is the only thing on the page with this hover title. */
const REVISE = 'title="Revise this estimate: a copy that replaces it when accepted"';
const DUPLICATE = 'title="Duplicate quote"';
const count = (html: string, needle: string) => html.split(needle).length - 1;
/** The notice's own list item: from its heading to the item's end. */
const notice = (html: string) => {
  const at = html.indexOf("These line items are locked");
  return at < 0 ? "" : html.slice(at, html.indexOf("</li>", at));
};

describe("an estimate that is not locked has no Revise, at any status", () => {
  it("draft, sent, accepted, declined, superseded: Duplicate is there once and Revise is not", () => {
    for (const status of ["draft", "sent", "accepted", "declined", "superseded"]) {
      const html = saved({ status }, [line]);
      expect(count(html, REVISE), status).toBe(0);
      expect(text(html), status).not.toMatch(/\bRevise\b/);
      expect(count(html, DUPLICATE), status).toBe(1);
      expect(text(html), status).not.toContain("These line items are locked");
    }
  });

  it("the toolbar's row makes one copy button, the plain one (pinned at the source)", () => {
    const at = editorSrc.indexOf('<SendButton kind="quote" id={savedId}');
    const row = editorSrc.slice(at, editorSrc.indexOf("</div>", at));
    expect(row.split("<DuplicateQuoteButton")).toHaveLength(2);
    expect(row).toContain("{(catalog.estimatesOn || lock) && <DuplicateQuoteButton id={savedId} />}");
    expect(row).not.toContain("revision");
    // In the whole editor: the plain copy once, the revision once.
    expect(editorSrc.split("<DuplicateQuoteButton")).toHaveLength(3);
    expect(editorSrc.split("<DuplicateQuoteButton id={savedId} revision number={number || null} />")).toHaveLength(2);
  });
});

describe("an accepted estimate the server has locked: Revise sits under the words that send a person to it", () => {
  it("a billed scheduled payment, and a signed contract: the reason, then one Revise, inside the notice", () => {
    for (const reason of [DRAWN, SIGNED]) {
      const html = saved({ status: "accepted" }, [line], { lock: { reason } });
      expect(count(html, REVISE)).toBe(1);
      const box = notice(html);
      expect(text(box)).toContain(reason);
      expect(count(box, REVISE)).toBe(1);
      // The sentence first, the door after it.
      expect(box.indexOf("Revise it instead")).toBeGreaterThan(0);
      expect(box.indexOf(REVISE)).toBeGreaterThan(box.indexOf("Revise it instead"));
      expect(box).toMatch(/<\/svg> Revise<\/button>/);
      // Duplicate (a copy that stands on its own) is still on the toolbar, once, and not in the notice.
      expect(count(html, DUPLICATE)).toBe(1);
      expect(count(box, DUPLICATE)).toBe(0);
    }
  });

  it("the sentences are the catalog's own, and each ends at Revise", () => {
    expect(qs.en.qs_lockDrawnOne.replace("{quote}", "E-001").replace("{n}", "1")).toBe(DRAWN);
    expect(qs.en.qs_lockSigned.replace("{quote}", "E-001").replace("{contract}", "contract C-004")).toBe(SIGNED);
    for (const key of ["qs_lockSigned", "qs_lockDrawnOne", "qs_lockDrawnMany"] as const) {
      expect(qs.en[key], key).toContain("Revise it instead");
      expect(qs.es[key], key).toContain("Usa Crear Revisión en su lugar");
    }
  });

  it("its first tap makes nothing: the button opens the sentence, drawn shut on a first render", () => {
    const html = saved({ status: "accepted" }, [line], { lock: { reason: DRAWN } });
    expect(text(html)).not.toContain("A revision replaces");
    expect(text(html)).not.toContain("Make the Revision");
  });

  it("with no line on it the notice and its door are still there", () => {
    const html = saved({ status: "accepted" }, [], { lock: { reason: DRAWN } });
    expect(count(notice(html), REVISE)).toBe(1);
  });

  it("the row it stands in wraps, because the button draws its own full-width sentence and error line (pinned at the source)", () => {
    expect(editorSrc).toContain(
      '{savedId && status === "accepted" && (\n                      <div className="mt-2 flex flex-wrap items-center gap-2">\n                        <DuplicateQuoteButton id={savedId} revision number={number || null} />\n                      </div>\n                    )}',
    );
    const at = editorSrc.indexOf('{t("qe_theseAreLocked")}');
    const item = editorSrc.slice(at, editorSrc.indexOf("</li>", at));
    expect(item.indexOf("{lock?.reason}")).toBeGreaterThan(0);
    expect(item.indexOf("<DuplicateQuoteButton")).toBeGreaterThan(item.indexOf("{lock?.reason}"));
  });
});

describe("the other lock, a superseded estimate's: its revision is the paper to edit, so no Revise", () => {
  it("the notice says what replaced it and offers no button the server would refuse", () => {
    const reason = qs.en.qs_supersededBy.replace("{quote}", "E-001").replace("{revision}", "E-002");
    expect(reason).toBe("E-001 is superseded by E-002 — edit that one instead.");
    const html = saved({ status: "superseded" }, [line], { lock: { reason } });
    expect(text(notice(html))).toContain(reason);
    expect(count(html, REVISE)).toBe(0);
  });
});

describe("in Spanish", () => {
  const inLang = (lang: "en" | "es", el: ReactElement) => renderToStaticMarkup(createElement(LangProvider, { lang } as never, el));
  const lockedEl = () => createElement(EstimateEditor as never, { mode: "saved", saved: savedProps({ status: "accepted" }, [line], { lock: { reason: qs.es.qs_lockDrawnOne.replace("{quote}", "E-001").replace("{n}", "1") } }), catalog: catalog() } as never) as ReactElement;

  it("Crear Revisión, once, under the sentence that names it", () => {
    const html = inLang("es", lockedEl());
    const at = html.indexOf("Estas partidas están bloqueadas");
    expect(at).toBeGreaterThan(0);
    const box = html.slice(at, html.indexOf("</li>", at));
    expect(box).toContain("Usa Crear Revisión en su lugar");
    expect(box).toMatch(/<\/svg> Crear Revisión<\/button>/);
    expect(html.split("</svg> Crear Revisión</button>")).toHaveLength(2);
  });
});
