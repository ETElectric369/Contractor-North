import { describe, it, expect, vi, beforeEach } from "vitest";
import { getOrgSettings } from "@/lib/org-settings";

/**
 * THE WEBSITE SWITCH ON THE ORG'S OWN FEEDS (the switch board, 0352, rule e). The sitemap and the
 * RSS feed are the site's search listing: with Website off they advertise nothing for that company
 * (an empty urlset, a 404 feed). With the switch on, or with no switches stored at all (every
 * company today), both are byte-for-byte what they were before the switch existed: the expected
 * strings below were captured from the code as it stood before this change.
 */
let host = "etelectricity.com";
let stored: Record<string, unknown> = {};

vi.mock("next/headers", () => ({ headers: async () => ({ get: (k: string) => (k === "host" ? host : null) }) }));

const org = () => ({
  id: "org-1",
  name: "Fixture Electric",
  phone: null,
  email: null,
  license: null,
  logo_url: null,
  city: null,
  state: null,
  updated_at: "2026-09-01T12:00:00Z",
  settings: getOrgSettings({ public_handle: "fixture", custom_domain: "etelectricity.com", estimating_mode: "catalog", ...stored }),
});
vi.mock("@/lib/public-org", async (orig) => ({
  ...(await orig<typeof import("@/lib/public-org")>()),
  getPublicOrgByHandle: async (h: string) => (h === "fixture" ? org() : null),
  getPublicOrgByDomain: async (h: string) => (h.replace(/^www\./, "") === "etelectricity.com" ? org() : null),
}));

const POSTS = [
  { path: "blog/panel-upgrades", title: "Panel <Upgrades>", description: "Why & when", published_at: "2026-08-20T10:00:00Z", updated_at: "2026-08-21T10:00:00Z" },
];
const PAGES = [{ slug: "about", updated_at: "2026-08-10T10:00:00Z" }];
vi.mock("@/lib/supabase/server", () => ({
  createServiceClient: () => ({
    from: (table: string) => {
      const rows = table === "site_posts" ? POSTS : table === "site_pages" ? PAGES : [];
      const q: any = { select: () => q, eq: () => q, order: () => q, limit: async () => ({ data: rows, error: null }) };
      return q;
    },
  }),
}));
vi.mock("@/lib/public-posts", () => ({ getPublicPosts: async () => POSTS }));

const { GET: sitemap } = await import("./route");
const { GET: rss } = await import("../site-rss/route");

const SITEMAP_TODAY = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://etelectricity.com/</loc><lastmod>2026-09-01</lastmod></url>
  <url><loc>https://etelectricity.com/estimate/fixture</loc><lastmod>2026-09-01</lastmod></url>
  <url><loc>https://etelectricity.com/blog</loc><lastmod>2026-08-21</lastmod></url>
  <url><loc>https://etelectricity.com/blog/panel-upgrades</loc><lastmod>2026-08-21</lastmod></url>
  <url><loc>https://etelectricity.com/about</loc><lastmod>2026-08-10</lastmod></url>
</urlset>`;

const RSS_TODAY = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Fixture Electric — Articles</title>
    <link>https://etelectricity.com/blog</link>
    <description>Guides and articles from Fixture Electric.</description>
    <item>
      <title>Panel &lt;Upgrades&gt;</title>
      <link>https://etelectricity.com/blog/panel-upgrades</link>
      <guid isPermaLink="true">https://etelectricity.com/blog/panel-upgrades</guid>
      <description>Why &amp; when</description>
      <pubDate>Thu, 20 Aug 2026 10:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>`;

beforeEach(() => {
  host = "etelectricity.com";
  stored = {};
});

describe("the sitemap", () => {
  it("no switches stored (every company today): exactly today's sitemap", async () => {
    expect(await (await sitemap()).text()).toBe(SITEMAP_TODAY);
  });

  it("Website on, stored: exactly today's sitemap", async () => {
    stored = { features: { website: true } };
    expect(await (await sitemap()).text()).toBe(SITEMAP_TODAY);
  });

  it("Website off: a valid, empty urlset for that company's host, not even its home page", async () => {
    stored = { features: { website: false } };
    const xml = await (await sitemap()).text();
    expect(xml).toBe(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">

</urlset>`);
  });

  it("Site Chat off changes nothing here", async () => {
    stored = { features: { site_chat: false } };
    expect(await (await sitemap()).text()).toBe(SITEMAP_TODAY);
  });
});

describe("the RSS feed", () => {
  it("no switches stored: exactly today's feed", async () => {
    const res = await rss(new Request("https://etelectricity.com/site-rss"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(RSS_TODAY);
  });

  it("Website off: 404 on the company's own domain, and ?handle= can't reach it either", async () => {
    stored = { features: { website: false } };
    expect((await rss(new Request("https://etelectricity.com/site-rss"))).status).toBe(404);
    host = "app.contractornorth.com";
    expect((await rss(new Request("https://app.contractornorth.com/site-rss?handle=fixture"))).status).toBe(404);
  });
});
