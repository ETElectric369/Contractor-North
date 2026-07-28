# ET Electric — Technical SEO Report

**Site:** etelectricity.com · **Sister site:** tahoedeck.com
**Prepared:** 27 July 2026
**Method:** source-code review plus live HTTP requests against the production sites. Every claim below is backed by either a `file:line` reference or a quoted live response. Anything not verified that way is explicitly labelled as inference or listed as an open question.

**Who this is for:** an outside SEO professional reviewing the site. Section 6 exists specifically so you don't spend billable hours re-auditing things that were checked, and Section 7 lists decisions that look like defects but are deliberate — please read it before recommending changes.

---

## 1. Verdict

**The site is technically sound where it counts, and the Search Console alert that prompted this review is mostly benign.**

All nine URLs the site asks Google to index return HTTP 200, each with exactly one absolute self-referencing canonical tag, a single `<h1>`, a unique hand-written title and meta description, and valid LocalBusiness structured data. Host normalisation — `www` → apex, `http` → `https`, trailing slash, and the old `etelectric369.com` domain — is complete and path-preserving. Unknown URLs return real 404s rather than the soft-404 redirects common on small-business sites. The four service pages are measurably *not* near-duplicates of one another.

The defects found were at the edges of the site rather than inside it: internal platform routes reachable from the public domain, a settings field holding the wrong kind of Google link, and an unoptimised logo. Those have been fixed and deployed (Section 4). What remains for a reviewer is listed in Section 5, and it is short.

---

## 2. The Search Console alert, explained

On 27 July 2026 Search Console reported *"New reasons prevent pages from being indexed"* on etelectricity.com, citing **"Page with redirect"** and **"Duplicate without user-selected canonical"**, affecting 4 pages.

### What the two messages actually mean

**"Page with redirect."** Google requested a URL and was told the content lives elsewhere. Google follows the arrow, indexes the destination, and files the original under this label. **This is not an error.** It is Google reporting that it did not index a URL *separately* because you told it not to. Every site that has ever moved a page has these. It is only a problem when a URL is redirecting that you meant to have indexed.

**"Duplicate without user-selected canonical."** Google found the same content at more than one URL, and the page carried **no tag declaring which URL is official**, so Google picked one itself. The phrase *"without user-selected canonical"* is the diagnostic detail: a page that *does* declare a canonical is filed under a different label entirely ("Alternate page with proper canonical tag"). So the pages in this bucket serve real content with no `<link rel="canonical">` at all.

### An important correction

Going in, the working assumption was that these redirects were the deliberate merge of 14 thin articles into one pillar guide. **That merge is real, it is working correctly, and it is entirely on tahoedeck.com — not on this domain.** Verified live:

```
https://tahoedeck.com/blog-1-1/redwood      →  308  →  /blog-1-1/top-wood-options-for-decking
https://etelectricity.com/blog-1-1/redwood  →  404
```

A direct query of the `site_redirects` table returns 13 rows, **all** owned by the Tahoe Deck organisation. ET Electric has **zero**. The code that issues those redirects filters on the organisation resolved from the request hostname, so it cannot fire on etelectricity.com.

*If anyone offers the article merge as the explanation for this alert, one `curl` disproves it.*

### Every redirect that actually exists on etelectricity.com

This is the complete candidate list for "Page with redirect," all verified live:

| Pattern | Example | Response |
|---|---|---|
| www → apex | `www.etelectricity.com/panel-upgrades` | 308 → `etelectricity.com/panel-upgrades` |
| http → https | `http://etelectricity.com/about` | 308 → `https://…/about` |
| trailing slash removed | `/about/` | 308 → `/about` |
| old domain → new | `etelectric369.com/about` | 308 → `etelectricity.com/about` |
| old builder prefix | `/p/about` | 301 → `/about` |
| legacy CMS slugs → homepage | `/contact`, `/services`, `/gallery`, `/portfolio`, `/reviews`, `/faq`, `/about-us`, `/shop`, and similar | 308 → `/` |
| legacy multi-segment | `/services/anything`, `/shop/anything` | 301 → `/` |

**The most likely explanation, and it requires no action:** if the Search Console property is a **Domain property** (`etelectricity.com`) rather than a **URL-prefix property** (`https://etelectricity.com/`), then `www.` and `http://` variants fall inside the property, and every one of them is a "Page with redirect." Four such URLs is exactly the order of magnitude to expect. **Check this first** — it is question 2 in Section 8.

### The best-fitting candidate for the duplicate message

Searching for pages on this domain that serve 200 **with no canonical tag** produced exactly one, and it fits well:

```
https://etelectricity.com/offline                  200, no canonical, no noindex
https://tahoedeck.com/offline                      200, identical
https://app.contractornorth.com/offline            200, identical
https://et-electric.contractornorth.com/offline    200, identical
```

This is the app's offline fallback screen — the same content on every hostname the platform answers on, with nothing declaring a primary, titled under the software vendor's name rather than the contractor's. Google can discover it: the string `/offline` appears in the publicly fetchable `sw.js`. **This has been fixed** (Section 4).

### What is definitively not causing it

- **The nine real pages.** All declare correct self-canonicals; verified individually.
- **Case and query-string variants** (`/About`, `/about?x=1`, `/?utm_source=x`). These return 200 rather than redirecting, but they declare the correct canonical, so Google files them under a different label.

### The single highest-value next step

In Search Console: **Page indexing → click the "Page with redirect" row → Examples → Export**, and the same for the duplicate row. That yields the four exact URLs, which can be matched against the table above in about two minutes. Everything in this section is inference from code and live responses until those four strings exist.

---

## 3. Scope and evidence base

- **Live HTTP checks** against etelectricity.com, tahoedeck.com, the platform subdomains, and the app host — status codes, canonical tags, robots meta, structured data, sitemaps, robots.txt.
- **Source review** of the multi-tenant public-site engine: middleware routing, canonical and metadata generation, the sitemap and robots routes, the redirect table and its RLS policies.
- **Database inspection** of the content tables (`site_pages`, `site_posts`, `site_redirects`) across both tenants.
- **Adversarial verification.** 25 candidate findings were each handed to an independent reviewer instructed to *refute* them. **11 were refuted and discarded**; 14 survived. Only survivors appear in this report. Refuted claims included several plausible-sounding items that did not hold up against the code — this is why the report is short.

---

## 4. Found and fixed (deployed 27 July 2026)

### 4.1 Cross-tenant exposure: each site served 200 on the other's domain — **high**

The platform's internal route namespace `/site/<handle>` was reachable on the customers' own custom domains, and it resolved the organisation from the **URL segment** rather than from the request `Host`:

```
GET https://etelectricity.com/site/tahoe-deck  →  200, <title>TAHOE DECK — Custom decks, stairs & railings…
GET https://tahoedeck.com/site/et-electric     →  200, <title>ET Electric — Custom Lighting Design…
GET https://etelectricity.com/site/et-electric →  200  (a third copy of ET's own homepage)
GET https://etelectricity.com/site/by-domain   →  200  (a fourth copy)
```

The leaked pages carried a complete internal link graph, so one discovered URL exposed the whole other site.

**Mitigation that was genuinely present, stated so this isn't overclaimed:** every one of those pages emitted a *correct* cross-domain canonical pointing at the right tenant's real URL. That is why nothing collapsed. But a canonical is a hint Google may decline, and it does nothing about the 200 status, the crawl budget, or the brand problem.

**Honest calibration:** these URLs appear in no sitemap and no public link to them was found, so Google most likely never discovered them. This was a latent exposure rather than a demonstrated indexing loss, and it is almost certainly *not* among the four flagged pages — those pages *do* declare canonicals.

**The real cost was never SEO.** One contractor's full marketing site — branding, phone number, portfolio — returned 200 on the other contractor's domain.

**Fixed:** on a tenant host, any path under `/site/` now returns 404. Signed-in requests are exempt so the draft-preview links in Settings keep working; a crawler never carries a session cookie. `Disallow: /site/` was also added to robots.txt. (robots.txt is evaluated against the *requested* URL, not the internal rewrite target, so this does not affect `/about` and the other real pages.)

### 4.2 `/offline` publicly indexable on both customer domains — **medium**

Described in Section 2. **Fixed:** the page now carries `noindex, nofollow`, plus a `Disallow: /offline` line. `noindex` is the authoritative half — a `Disallow`ed URL can still be indexed URL-only from an inbound link.

### 4.3 Google Business Profile link was a personalised search URL — **high, and it was a data-entry problem**

The homepage's structured data is meant to tell Google *"this website is that Google Maps listing."* The stored value was a logged-in Google **search** URL:

```json
"hasMap": "https://www.google.com/search?q=ET+Electric&hl=en&mat=<session-token>&authuser=1&dlnr=1"
```

No `geo` block was emitted at all. The sister site, running **identical code**, emits one:

```json
"hasMap": "https://www.google.com/maps/place/Tahoe+Deck/@39.3657384,-120.212828,17z/data=…",
"geo": { "@type": "GeoCoordinates", "latitude": 39.3657384, "longitude": -120.212828 }
```

The coordinate parser only matches `!3d/!4d` or `@lat,lng`; a `/search?` URL matches neither, so the geo block was silently dropped. It went unnoticed because the settings screen displayed a green *"Linked to your Google Business Profile"* for any non-empty string.

**Calibration:** Google's primary association between a site and a Business Profile is the website URL set inside the GBP dashboard itself. This is a corroborating signal, not the only one — fixing it strengthens local ranking rather than creating a binding from nothing.

**Also non-SEO:** the same value is a customer-facing link in the site footer and reviews band, so visitors clicking "our Google listing" were getting a stale personalised page carrying the owner's session token.

**Fixed in code:** the settings field now validates what was pasted and says which of four states it is in — a real Maps link with coordinates, a valid short link without them, a search URL, or a non-Google URL — instead of showing a green check regardless.

**Still requires a human action (see Section 5.1):** the stored value itself must be replaced.

### 4.4 A deck configurator on an electrician's domain — **medium**

`https://etelectricity.com/estimate/et-electric` returned 200, carried the homepage's meta description byte-for-byte, and asked visitors to choose between "New deck", "Resurface", and "Railing only" — on a C-10 electrical contractor's site. The route is deck-specific by construction.

**Calibration:** the page declared a self-canonical, so it cannot be one of the four flagged URLs, and it had no discovery path — excluded from the sitemap, and the header CTA that would link it is gated on the same catalogue flag. The SEO risk was latent; the business risk was live.

**Fixed:** the route now 404s for any organisation not in catalogue mode, using the same condition the sitemap and the CTA already use, so the three cannot drift. This does not affect tahoedeck.com, where the configurator is a real lead front door.

### 4.5 Old-CMS file URLs landed on a login screen — **low**

```
/index.html, /about.html, /index.php, /default.asp  →  307  →  /login?next=…
/zzz-no-such-page                                   →  404  (correct)
```

Any single-segment path containing a dot was treated as an asset by the page resolver and fell through to the app's auth guard — putting a login screen on a customer-facing marketing domain. The SEO impact is small (both outcomes end in "not indexed"); the asymmetry and the brand impression were the real complaints.

**Fixed:** a single-segment legacy file URL now resolves to the matching page where one exists (`/about.html` → `/about`), and otherwise to a real 404 or the homepage — never to a login screen.

### 4.6 The logo bypassed the image optimiser — **low (page speed)**

Every other image on the site is served through the transform endpoint with a `srcset`. The logo was not:

```
Content-Length: 127,284 bytes  (127 KB)
```

…rendering into a 36-pixel-tall slot, twice per page (header and footer), on every public page. Through the same transform at the displayed size it is **13,098 bytes** — roughly a 10× reduction, verified by fetching both.

**Fixed:** the logo now goes through the same helper as the hero and portfolio images.

---

## 5. Open items

### 5.1 Replace the Google Business Profile link — *owner action, ~2 minutes*

Settings → Website → **Google Business Profile link**. Open the listing in Google Maps → **Share** → **Copy link**, and paste either the full `…/maps/place/…/@lat,lng,17z/data=…` form or a `maps.app.goo.gl` short link. **Never paste a URL containing `authuser=`** — that is personal to the signed-in user. The field will now confirm which kind of link it received.

**One caution before doing this:** publishing the Maps link publishes whatever coordinates the map pin carries. The business is home-based and the street address is deliberately kept off the public site (Section 7.1). Confirm the pin is somewhere you're willing to publish before saving.

### 5.2 robots.txt uses unanchored prefixes — *latent, not firing today*

The `Disallow` lines are bare prefixes (`Disallow: /jobs`, `/quotes`, `/team`, …). Under RFC 9309 these are prefix matches, so `Disallow: /jobs` would also block a future marketing page at `/jobs-we-do`. The page-creation guard is exact-match only, so such a page would save cleanly, route correctly, appear in the sitemap — and be blocked in robots.txt.

**Not firing today:** all 9 etelectricity.com and all 10 tahoedeck.com sitemap URLs were checked against the emitted Disallow list. Zero collisions.

**A warning about the obvious fix:** do *not* simply change `Disallow: /jobs` to `Disallow: /jobs$` plus `Disallow: /jobs/`. Google matches Disallow values against the path *and query string*, so that would leave `/jobs?status=open` and every other query-bearing app URL crawlable. The safe fix is to make the page-creation guard prefix-aware, or to emit an explicit `Allow:` line per published page — with a test asserting no published slug is matched by any Disallow rule.

### 5.3 The homepage title cannot be tuned independently of the visible headline — *capability gap*

Every other page type has a `seo_title` field that lets a title be tuned without touching visible copy. The homepage does not: its title and description are welded to the hero headline and tagline. The live title is 71 characters, above the width Google typically renders.

**Consequence is snippet display and click-through only** — title length is not a ranking factor, and Google rewrites titles at its own discretion regardless. **The actionable point for a reviewer: on this site you can tune every page's title except the homepage's.**

### 5.4 Minor

- The RSS feed is served at three URLs (`/feed`, `/rss.xml`, `/blog/rss.xml`) with identical content, and no `<link rel="alternate">` points at any of them. Harmless; the alternate link tag would be a small improvement.
- The 404 page is correct (real 404 status, `noindex`, branded body) but its `<title>` falls back to the platform's name rather than the contractor's.

---

## 6. Checked and found correct

Please don't re-audit these — each was verified individually.

**Canonical tags**
- All 9 sitemap URLs return 200 with an absolute self-referencing canonical on the correct host. Zero mismatches.
- Exactly one canonical per page; no conflicting tag between layout and page.
- **Every cross-host duplicate points its canonical at the custom domain, not at itself** — verified on the platform subdomain, the app host, and the deploy URL. This is the most common multi-tenant SEO failure and it was avoided deliberately.
- The platform subdomain's own sitemap advertises **custom-domain** URLs, not its own.
- Case and query variants return 200 with the clean canonical, so they cannot split ranking signals.
- Draft previews are `noindex` and emit no canonical of their own.

**Host and domain handling**
- `www` → apex, `http` → `https`, and trailing-slash normalisation are all 308 and **path-preserving** (`www.etelectricity.com/panel-upgrades` → `etelectricity.com/panel-upgrades`, not → homepage).
- The old-domain move is clean and path-preserving, including for blog posts.

**Content quality**
- One `<h1>` per page across all 9 URLs; unique hand-written title and meta description on each; valid JSON-LD on 8 of 9 (the blog index has none, which is fine).
- **The four service pages are not near-duplicates of each other.** A 6-gram overlap test across all nine pages found no service-to-service pair above threshold; the only matches are shared header/footer chrome. *If a reviewer claims the service pages are thin or spun, that claim is measurably false.*
- The two blog posts are not duplicates of their matching service pages.
- All images except the logo (now fixed) use responsive `srcset` with correct `sizes`, lazy loading, and descriptive alt text.

**404 and redirect hygiene**
- Unknown URLs return **real 404s** with `noindex`, not soft-404 redirects. A mass soft-404 would have been the likeliest cause of the duplicate-canonical message, and it is not happening.
- **No redirect chains** — all 13 merge redirects on tahoedeck.com resolve in exactly one hop to a 200. No loops; the write path structurally prevents them.
- No redirected URL appears in either sitemap, and no internal link points at a redirecting URL.
- No redirects are configured outside the application.

**Sitemaps and robots**
- Served per-host with an absolute `Sitemap:` line.
- No sitemap URL is blocked by any current robots rule (all 19 across both tenants checked).
- Sitemaps are per-tenant with **no cross-tenant contamination**.
- No public marketing page is accidentally `noindex`ed.

**Access control**
- No app page is publicly indexable. Every app route probed unauthenticated returns a redirect to login, never content.
- Token-gated customer documents (invoices, quotes, contracts, portals) carry **both** a robots.txt `Disallow` **and** per-page `noindex, nofollow, noarchive, nocache`. That double layer is the correct pattern for pages carrying customer data.
- No cross-tenant leak in the content layer: page and post lookups are scoped to an organisation resolved from the hostname, never from caller input.
- The redirect table has row-level security with a deny-all policy; no cross-tenant redirect is expressible.

---

## 7. Deliberate decisions — please don't "fix" these

Each item below looks like a defect and is not.

**7.1 There is no street address on the site or in the structured data.** This is a home-based business. The address block is emitted only from an explicit public city/state setting, never from the business record, specifically so the mailing address cannot leak to the public web. Service area plus map coordinates carry the local signal instead. **Do not add a NAP block with the real address.** The correct way to strengthen the local signal is §5.1 — fix the Business Profile link so coordinates populate.

**7.2 Application routes are login-gated on the marketing domain, intentionally.** The login flow is deliberately reachable on etelectricity.com so field crew can clock in from a bookmark of the company site. It returns `noindex, nofollow` and is robots-disallowed. Do not recommend blanket-404ing everything non-marketing on the tenant host — that breaks crew access.

**7.3 There is no public signup page, and there should not be one.** The platform is invite-only by design, enforced at the database level. "Add a signup CTA for SEO" is out of scope.

**7.4 The 14 merged articles.** Fourteen thin fragment pages were deliberately consolidated into one pillar guide with permanent redirects. **This is on tahoedeck.com only.** Those redirects appearing as "Page with redirect" in *that* property is the correct and desired outcome. Do not restore the fragments.

**7.5 Legacy CMS slugs redirect to the homepage rather than 404.** `/contact`, `/services`, `/gallery` and similar 301 to `/` — but only as a **last resort**, after the resolver checks for a real published page. On tahoedeck.com, which genuinely was migrated, `/contact`, `/portfolio` and `/about` all return 200 because real pages exist there. Publishing a page at that slug automatically wins the route, with no code change. *A previous reviewer suggested redirecting `/contact` to `/#contact-form` instead; that accomplishes nothing — a URL fragment is never sent to the server, so a crawler sees an identical redirect to `/`.*

**7.6 Root-slug misses return a hard 404 — recent and deliberate.** This replaced an older soft-404 bounce to the homepage. Do not revert it.

**7.7 Two blog posts and five pages is the whole content inventory, on purpose.** This is a one-person licensed shop. Depth over volume is the standing editorial decision; a recommendation to publish 30 location pages will not be acted on.

---

## 8. Open questions for the reviewer

Stated as questions rather than guesses, because they could not be determined from code or a live request.

1. **What are the four actual URLs?** Search Console → Page indexing → each reason row → Examples → Export. Everything in Section 2 is inference until those four strings exist. *Highest-value next action; takes two minutes.*

2. **Is the Search Console property a Domain property or a URL-prefix property?** If Domain, then `www.` and `http://` variants are inside it and the "Page with redirect" count is almost certainly benign host normalisation requiring no action. If URL-prefix, those variants are outside it and the redirects come from elsewhere in the Section 2 table.

3. **Was there ever a prior website on etelectricity.com?** No evidence of one was found — no legacy URL shapes, no redirect rows. If an older site existed (Wix, Squarespace, WordPress, a directory microsite), its URL patterns should be checked against the Section 2 table, because that would change which redirects Google is actually seeing.

4. **Are there inbound links pointing at URLs that now redirect?** No backlink data was available. If a supplier, directory, or trade association links to an old path, that determines whether any of these redirects deserve a specific destination instead of the homepage. Check Search Console → Links → External links, plus a third-party backlink tool.

5. **Has `/offline` actually been crawled?** Run URL Inspection on `https://etelectricity.com/offline`. If it shows as discovered or indexed, it is confirmed as the duplicate-canonical source and should be submitted for removal now that it is `noindex`ed. If Google has never seen it, the fix is preventive.

6. **Is the Google Business Profile's own "Website" field set to `https://etelectricity.com/`?** That field is the primary site↔listing binding; §5.1 only strengthens the corroborating half. It can't be read from outside and should be verified in the dashboard.

---

*Every live response quoted here was fetched on 27 July 2026. Fixes described in Section 4 were deployed the same day and can be re-verified with the commands implied by each quoted response.*
