import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * THE ERROR PAGES IN THE PERSON'S LANGUAGE (cn-v1138). The (app) boundary renders inside the shell,
 * under the LangProvider, so a Spanish-speaking tech reads the snag in Spanish with Title Case
 * doors; the root boundary covers every page a CUSTOMER sees and has no provider above it, so it
 * reads English — nothing a customer can see changes.
 */
vi.mock("next/link", () => ({
  default: ({ children, href }: { children: unknown; href: string }) => createElement("a", { href }, children as never),
}));
vi.mock("@/app/report-client-error", () => ({ reportClientError: vi.fn(async () => {}) }));
vi.mock("@/lib/chunk-reload", () => ({
  recoverFromChunkError: () => false,
  isTransportError: (e: Error) => e.message === "Load failed",
}));
vi.mock("@/lib/try-again", () => ({ useTryAgain: (reset: () => void) => ({ tryAgain: reset, trying: false }) }));

import AppError from "./error";
import RootError from "@/app/error";
import { LangProvider } from "@/components/lang-provider";
import type { Lang } from "@/lib/i18n";

const snag = Object.assign(new Error("boom"), { digest: "d1" });
const dropped = new Error("Load failed");
const app = (lang: Lang, error: Error) =>
  renderToStaticMarkup(createElement(LangProvider, { lang, children: createElement(AppError, { error, reset: () => {} }) }));
const words = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").replace(/&#x27;/g, "'").trim();

describe("the (app) error boundary", () => {
  it("English: the snag, the dropped connection, Try Again and My Day, as before", () => {
    expect(words(app("en", snag))).toContain("This page hit a snag Something went wrong loading this screen. Your data is safe — try again, or head back to your day. Try Again My Day");
    expect(words(app("en", dropped))).toContain("The connection dropped Check your signal and try again — nothing was lost.");
  });

  it("Spanish: the same page in the tech's words, its two doors Title Case", () => {
    const html = app("es", snag);
    expect(words(html)).toContain("Esta página tuvo un problema Algo salió mal al cargar esta pantalla. Tus datos están a salvo: inténtalo de nuevo o vuelve a tu día. Intentar De Nuevo Mi Día");
    expect(html).toMatch(/<a href="\/planner"><button[^>]*>Mi Día<\/button><\/a>/);
    expect(words(app("es", dropped))).toContain("Se cortó la conexión Revisa tu señal e inténtalo de nuevo. No se perdió nada.");
    for (const en of ["hit a snag", "Try Again", "My Day", "connection dropped"]) expect(words(app("es", snag)) + words(app("es", dropped))).not.toContain(en);
  });
});

describe("the root error boundary (a customer's pages)", () => {
  it("reads English with no provider above it: nothing a customer can see changes", () => {
    const html = renderToStaticMarkup(createElement(RootError, { error: snag, reset: () => {} }));
    expect(words(html)).toContain("Something went wrong An unexpected error occurred. You can try again, or head back to the dashboard. Try Again Dashboard");
  });
});
