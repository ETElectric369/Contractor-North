import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getOrgSettings } from "@/lib/org-settings";

/**
 * THE WEBSITE AND SITE CHAT SWITCHES ON PUBLIC OUTPUT (the switch board, 0352, rule e).
 *
 *  - Every page of the site itself (home, articles, builder pages, on the free subdomain and on a
 *    custom domain) resolves its company through publicSite: off, it is a 404 like an unpublished
 *    site; on, or no switches stored, publicSite hands back the very same object, so the page is
 *    byte-for-byte what it was.
 *  - The intake door, the estimate configurator, quote/invoice/portal links never ask it.
 *  - Site Chat off removes only the chat bubble, and the two chat routes answer 404 before a cent
 *    is spent at the model.
 * (The sitemap and the feed are pinned in sitemap.xml/website-switch.test.)
 */
const src = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

let stored: Record<string, unknown> = {};
const org = () => ({
  id: "org-1",
  name: "Fixture Electric",
  phone: null,
  email: null,
  license: null,
  logo_url: null,
  city: null,
  state: null,
  updated_at: null,
  settings: getOrgSettings({ public_handle: "fixture", ...stored }),
});
vi.mock("@/lib/public-org", async (orig) => ({
  ...(await orig<typeof import("@/lib/public-org")>()),
  getPublicOrgByHandle: async (h: string) => (h === "fixture" ? org() : null),
}));
const rateLimited = vi.fn(async () => false);
vi.mock("@/lib/rate-limit", () => ({ rateLimited: (...a: unknown[]) => (rateLimited as any)(...a), clientIp: () => "203.0.113.9" }));
const aiSpendExceeded = vi.fn(async () => false);
vi.mock("@/lib/ai-cost", () => ({ recordAiUsage: vi.fn(), aiSpendExceeded: (...a: unknown[]) => (aiSpendExceeded as any)(...a) }));
const getAnthropic = vi.fn(() => {
  throw new Error("the model must not be reached in this test");
});
vi.mock("@/lib/anthropic", () => ({ getAnthropic: () => getAnthropic() }));
const upload = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createServiceClient: () => ({ storage: { from: () => ({ upload, getPublicUrl: () => ({ data: { publicUrl: "https://x" } }) }) } }),
}));

const { publicSite } = await import("@/lib/public-org");
const { POST: chat } = await import("@/app/api/site-chat/route");
const { POST: chatUpload } = await import("@/app/api/site-chat/upload/route");

beforeEach(() => {
  stored = {};
  rateLimited.mockClear();
  getAnthropic.mockClear();
  upload.mockClear();
});

describe("publicSite, the one gate every site page asks", () => {
  it("no switches stored, or Website on: the very same object", () => {
    const o = org();
    expect(publicSite(o)).toBe(o);
    stored = { features: { website: true, site_chat: false } };
    const on = org();
    expect(publicSite(on)).toBe(on);
  });
  it("Website off: null (the page 404s like an unpublished site); no org stays null", () => {
    stored = { features: { website: false } };
    expect(publicSite(org())).toBeNull();
    expect(publicSite(null)).toBeNull();
  });
});

describe("every site page asks publicSite, and the doors that aren't the website don't", () => {
  const SITE_PAGES = [
    "./[handle]/page.tsx",
    "./[handle]/[...path]/page.tsx",
    "./[handle]/p/[slug]/page.tsx",
    "./by-domain/page.tsx",
    "./by-domain/[...path]/page.tsx",
    "./by-domain/p/[slug]/page.tsx",
  ];
  it.each(SITE_PAGES)("%s resolves its company through publicSite, on every lookup", (f) => {
    const s = src(f);
    const lookups = (s.match(/getPublicOrgBy(Handle|Domain)\(/g) ?? []).length;
    expect(lookups).toBeGreaterThan(0);
    expect((s.match(/publicSite\(await getPublicOrgBy(Handle|Domain)\(/g) ?? []).length).toBe(lookups);
  });
  it("the intake door and the estimate configurator never read the Website switch", () => {
    for (const f of ["../intake/[handle]/page.tsx", "../estimate/[handle]/page.tsx"]) {
      expect(src(f)).not.toContain("publicSite");
      expect(src(f)).not.toMatch(/featureOn\([^)]*"website"/);
    }
  });
  it("the chat bubble is drawn only while Site Chat is on, on the site and on the configurator", () => {
    expect(src("./org-site.tsx")).toContain('featureOn(s.features, "site_chat") && <AskNort');
    expect(src("../estimate/[handle]/page.tsx")).toContain('featureOn(settings.features, "site_chat") && <AskNort');
    // Exactly those two mounts, both gated.
    const mounts = [src("./org-site.tsx"), src("../estimate/[handle]/page.tsx")].join("\n").match(/<AskNort /g) ?? [];
    expect(mounts).toHaveLength(2);
  });
});

describe("the chat routes", () => {
  const ask = () =>
    chat(new Request("https://x/api/site-chat", { method: "POST", body: JSON.stringify({ handle: "fixture", messages: [{ role: "user", content: "hi" }] }) }));
  const photo = () => {
    const fd = new FormData();
    fd.set("handle", "fixture");
    fd.set("image", new File([new Uint8Array([1, 2, 3])], "a.jpg", { type: "image/jpeg" }));
    return chatUpload(new Request("https://x/api/site-chat/upload", { method: "POST", body: fd }));
  };

  it("Site Chat off: 404 'Not available.' before any model call or daily budget is touched", async () => {
    stored = { features: { site_chat: false } };
    const res = await ask();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not available." });
    expect(getAnthropic).not.toHaveBeenCalled();
    expect(rateLimited.mock.calls.map((c) => String((c as unknown[])[0]))).not.toContain("chat-day:org-1");
  });

  it("Website off turns Site Chat off with it", async () => {
    stored = { features: { website: false } };
    expect((await ask()).status).toBe(404);
  });

  it("the photo door goes with the chat, and stores nothing", async () => {
    stored = { features: { site_chat: false } };
    const res = await photo();
    expect(res.status).toBe(404);
    expect(upload).not.toHaveBeenCalled();
  });

  it("on / not stored: the photo door works as today", async () => {
    upload.mockResolvedValue({ error: null });
    const res = await photo();
    expect(res.status).toBe(200);
    expect(upload).toHaveBeenCalledTimes(1);
  });
});
