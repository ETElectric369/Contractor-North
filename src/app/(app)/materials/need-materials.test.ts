import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LangProvider } from "@/components/lang-provider";

/**
 * TELL THE OFFICE, IN THE TECH'S LANGUAGE (cn-v1138). The ask-the-office door under a tech's list
 * reads profiles.language through the (app) layout's LangProvider; every word on it comes from
 * lib/words/materials (mt_). A Spanish-speaking tech reads the headline, the explainer, the example
 * and the door in Spanish; the English is byte-for-byte what it was.
 */
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("./actions", () => ({ requestMaterials: vi.fn() }));

import { NeedMaterials } from "./need-materials";

const inLang = (lang: "en" | "es") => renderToStaticMarkup(createElement(LangProvider, { lang, children: createElement(NeedMaterials, { jobId: "j1" }) }));
const textOf = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const buttons = (html: string) => [...html.matchAll(/<button[^>]*>[\s\S]*?<\/button>/g)].map((m) => textOf(m[0]));

describe("Tell The Office, in the tech's language (cn-v1138)", () => {
  it("Spanish: the headline, the explainer, the example and the door", () => {
    const html = inLang("es");
    const text = textOf(html);
    expect(text).toContain("¿Lo necesitas rápido? Avisa a la oficina.");
    expect(text).toContain("Di el artículo: va a la lista de arriba como una línea por comprar, y directo al teléfono de la oficina con este trabajo adjunto. No tienes que perseguir a nadie.");
    expect(html).toContain('placeholder="Dos cajas más de tornillos — las necesito mañana"');
    expect(buttons(html)).toContain("Avisar A La Oficina");
    expect(text).not.toContain("Tell The Office");
    expect(text).not.toContain("Need it fast");
  });

  it("English is unchanged: the same render inside an English provider is the render with no provider", () => {
    const html = inLang("en");
    expect(html).toBe(renderToStaticMarkup(createElement(NeedMaterials, { jobId: "j1" })));
    const text = textOf(html);
    expect(text).toContain("Need it fast? Tell the office.");
    expect(text).toContain("Say the item: it goes on the list above as a line to buy, and straight to the office’s phone with this job attached. You don’t have to chase anybody.");
    expect(html).toContain('placeholder="Two more boxes of screws — need them tomorrow"');
    expect(buttons(html)).toContain("Tell The Office");
  });
});
