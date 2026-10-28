import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * THE SECTION SHEET IN THE PERSON'S LANGUAGE (cn-v1138). The long sections' handle and slide-over
 * (Jobs' rows for a tech) name the section, the current page and every row through lib/dock-words,
 * and their own chrome (the handle's "pages", Close) through the shell's catalog. English is what it
 * was, byte for byte.
 */
vi.mock("next/navigation", () => ({ usePathname: () => "/jobs" }));
vi.mock("next/link", () => ({
  default: ({ children, href }: { children: unknown; href: string }) => createElement("a", { href }, children as never),
}));
vi.mock("@/components/ui/modal-lock", () => ({ useCoversTheScreen: () => {} }));

import { SectionSheet } from "./section-sheet";
import { LangProvider } from "./lang-provider";
import { DOCK } from "@/lib/dock";
import type { Lang } from "@/lib/i18n";

const jobs = DOCK.find((s) => s.key === "jobs")!;
const render = (lang: Lang, activeHref = "/jobs?status=in_progress") =>
  renderToStaticMarkup(createElement(LangProvider, { lang, children: createElement(SectionSheet, { group: jobs, items: jobs.children, activeHref }) }));

describe("SectionSheet", () => {
  it("English: the handle, its title, the header, Close and the rows, as before", () => {
    const html = render("en");
    expect(html).toContain('aria-label="Jobs pages"');
    expect(html).toContain('title="Jobs — In Progress"');
    expect(html).toContain('aria-label="Close"');
    expect(html).toContain(">To Be Scheduled<");
    expect(html).toContain(">Cancelled<");
  });

  it("Spanish: the same doors in the tech's words; no English row is left", () => {
    const html = render("es");
    expect(html).toContain('aria-label="Páginas de Trabajos"');
    expect(html).toContain('title="Trabajos — En Curso"');
    expect(html).toContain('aria-label="Cerrar"');
    expect(html).toContain(">Todos<");
    expect(html).toContain(">Por Programar<");
    expect(html).toContain(">Cancelados<");
    for (const en of ["In Progress", "To Be Scheduled", "Cancelled", "Jobs pages", ">Jobs<"]) expect(html).not.toContain(en);
  });

  it("on a detail route the handle names the section, in the person's language", () => {
    expect(render("es", "")).toContain('title="Trabajos — Trabajos"');
    expect(render("en", "")).toContain('title="Jobs — Jobs"');
  });
});
