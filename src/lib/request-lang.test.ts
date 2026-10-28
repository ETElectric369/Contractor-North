import { describe, it, expect } from "vitest";
import { langBeforeSession, langFromAcceptLanguage } from "./request-lang";

/**
 * THE LANGUAGE BEFORE A SESSION EXISTS (lib/request-lang, cn-v1138): the Accept-Language header's
 * FIRST tag decides, a link's ?lang= wins over it, and nothing odd ever throws.
 */
describe("langFromAcceptLanguage", () => {
  it("the first tag decides: es-MX is Spanish, en-US ahead of es is English, a bare es is Spanish", () => {
    expect(langFromAcceptLanguage("es-MX,es;q=0.9,en;q=0.8")).toBe("es");
    expect(langFromAcceptLanguage("es")).toBe("es");
    expect(langFromAcceptLanguage("ES-419")).toBe("es");
    expect(langFromAcceptLanguage("en-US,en;q=0.9,es;q=0.8")).toBe("en");
    expect(langFromAcceptLanguage(" es-US ; q=1 , en")).toBe("es");
  });

  it("anything else is English: blank, missing, a language the app does not speak, a tag that only starts with es", () => {
    expect(langFromAcceptLanguage("")).toBe("en");
    expect(langFromAcceptLanguage(null)).toBe("en");
    expect(langFromAcceptLanguage(undefined)).toBe("en");
    expect(langFromAcceptLanguage("fr-CA,fr;q=0.9")).toBe("en");
    expect(langFromAcceptLanguage("eso")).toBe("en");
    expect(langFromAcceptLanguage("*")).toBe("en");
  });
});

describe("langBeforeSession", () => {
  it("?lang=es or ?lang=en wins over the header; anything else falls back to the header", () => {
    expect(langBeforeSession("es", "en-US,en")).toBe("es");
    expect(langBeforeSession("en", "es-MX,es")).toBe("en");
    expect(langBeforeSession("ES", "en-US")).toBe("es");
    expect(langBeforeSession(null, "es-MX,es")).toBe("es");
    expect(langBeforeSession("", "es-MX,es")).toBe("es");
    expect(langBeforeSession("fr", "es-MX,es")).toBe("es");
    expect(langBeforeSession("klingon", "en-US")).toBe("en");
    expect(langBeforeSession(undefined, undefined)).toBe("en");
  });
});
