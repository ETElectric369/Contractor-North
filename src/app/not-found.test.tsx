import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * THE 404 PAGE: THE APP'S OWN MARK ONLY ON THE APP'S OWN HOST (cn-v1202). On the app's host it draws
 * /icon-192.png, the same tile the sign-in page draws. A dead customer link on a company's own domain
 * renders this page too, and that visitor is the company's customer: there it draws the bolt tile it
 * drew before this release, with no "Contractor North" in the markup. A host that cannot be read gets
 * the bolt tile. Its words and its one button are the same everywhere.
 */
const h = vi.hoisted(() => ({ host: null as string | null, throws: false }));
vi.mock("next/headers", () => ({
  headers: async () => {
    if (h.throws) throw new Error("outside a request");
    return new Headers(h.host === null ? {} : { host: h.host });
  },
}));

import NotFound from "./not-found";

const render = async () => renderToStaticMarkup(await NotFound());
/** The tile as the page drew it before cn-v1202. */
const BOLT_TILE = /<div class="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-brand text-white"><svg[^>]*lucide-zap[^>]*>/;

beforeEach(() => {
  h.host = null;
  h.throws = false;
});

describe("the not-found page", () => {
  it("on the app's own host: the app icon and no bolt", async () => {
    for (const host of ["app.contractornorth.com", "localhost:3000"]) {
      h.host = host;
      const html = await render();
      expect(html).toMatch(/<img[^>]*src="\/icon-192\.png"[^>]*alt="Contractor North"/);
      expect(html).not.toMatch(/lucide-zap/);
    }
  });
  it("on a company's own host: the bolt tile, no app icon, no Contractor North", async () => {
    for (const host of ["larkspur-decks.example", "www.larkspur-decks.example", "larkspur.contractornorth.com"]) {
      h.host = host;
      const html = await render();
      expect(html).toMatch(BOLT_TILE);
      expect(html).not.toContain("/icon-192.png");
      expect(html).not.toContain("Contractor North");
    }
  });
  it("no host, or headers that cannot be read: the bolt tile", async () => {
    expect(await render()).toMatch(BOLT_TILE);
    h.host = "";
    expect(await render()).toMatch(BOLT_TILE);
    h.throws = true;
    const html = await render();
    expect(html).toMatch(BOLT_TILE);
    expect(html).not.toContain("/icon-192.png");
  });
  it("keeps its words and its button on both", async () => {
    for (const host of ["app.contractornorth.com", "larkspur-decks.example"]) {
      h.host = host;
      const html = await render();
      expect(html).toContain("404");
      expect(html).toContain("We couldn&#x27;t find that page.");
      expect(html).toContain("Back to Dashboard");
      expect(html).toContain('href="/planner"');
    }
  });
});
