import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * THE 404 PAGE DRAWS THE APP'S MARK ON EVERY HOST (cn-v1203, 2026-11-26: the owner chose the mark
 * everywhere). /icon-192.png, the tile the sign-in page draws, and no bolt, whatever the host: the
 * app's own, a company's own domain, or none at all. The page reads no request header, so the host
 * cannot change it; `next/headers` is stood in only so that a read of it would be seen. Its words
 * and its one button are the same everywhere.
 */
const h = vi.hoisted(() => ({ host: null as string | null, reads: 0 }));
vi.mock("next/headers", () => ({
  headers: async () => {
    h.reads++;
    return new Headers(h.host === null ? {} : { host: h.host });
  },
}));

import NotFound from "./not-found";

const render = () => renderToStaticMarkup(NotFound());

beforeEach(() => {
  h.host = null;
  h.reads = 0;
});

describe("the not-found page", () => {
  it("draws the app icon and no bolt with no host, on the app's host and on a company's host", () => {
    for (const host of [null, "app.contractornorth.com", "larkspur-decks.example", "larkspur.contractornorth.com"]) {
      h.host = host;
      const html = render();
      expect(html, String(host)).toMatch(/<img[^>]*src="\/icon-192\.png"[^>]*alt="Contractor North"[^>]*class="mb-4 h-16 w-16 rounded-2xl shadow-sm"/);
      expect(html, String(host)).not.toMatch(/lucide-zap|bg-brand/);
    }
    expect(h.reads).toBe(0);
  });
  it("keeps its words and its button", () => {
    const html = render();
    expect(html).toContain("404");
    expect(html).toContain("We couldn&#x27;t find that page.");
    expect(html).toContain("Back to Dashboard");
    expect(html).toContain('href="/planner"');
  });
  it("is a plain component that imports nothing from next/headers and no bolt", () => {
    const src = readFileSync(join(process.cwd(), "src/app/not-found.tsx"), "utf8");
    expect(src).not.toMatch(/from\s+["']next\/headers["']/);
    expect(src).not.toMatch(/\bZap\b|isAppHostname|requestHost/);
    expect(src).not.toMatch(/\basync\s+function\s+NotFound\b/);
  });
});
