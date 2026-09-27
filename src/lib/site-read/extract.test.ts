import { describe, expect, it } from "vitest";
import { extractContact, nameFromTitle, pageTextForModel, visibleText } from "./extract";

/**
 * Reading a contact card out of a page with no model. Every organization, number and address here is
 * made up (555 numbers, .example domains): real sites never go in this repo.
 */

const JSON_LD = `<!doctype html>
<html><head>
<title>Building Department | Pine County, CA</title>
<script type="application/ld+json">
{"@context":"https://schema.org","@graph":[
  {"@type":"WebSite","name":"Pine County","url":"https://www.pinecounty.example.gov/"},
  {"@type":"BreadcrumbList","itemListElement":[{"@type":"ListItem","position":1,"name":"Home"}]},
  {"@type":["GovernmentOffice","LocalBusiness"],"name":"Pine County Building Department",
   "telephone":"+1-530-555-0142","email":"mailto:building@pinecounty.example.gov",
   "address":{"@type":"PostalAddress","streetAddress":"101 Courthouse Sq","addressLocality":"Pineville","addressRegion":"California","postalCode":"96000"},
   "openingHoursSpecification":[
     {"@type":"OpeningHoursSpecification","dayOfWeek":["Monday","Tuesday","Wednesday","Thursday","Friday"],"opens":"08:00","closes":"17:00"},
     {"@type":"OpeningHoursSpecification","dayOfWeek":"https://schema.org/Saturday","opens":"09:00","closes":"12:30"}
   ],
   "contactPoint":{"@type":"ContactPoint","telephone":"(530) 555-0143","contactType":"inspections"}}
]}
</script>
</head><body><header><a href="tel:5305550142">Call us</a></header><p>Welcome.</p></body></html>`;

const META_ONLY = `<html><head>
<meta property="og:site_name" content="Sierra Valley Electric Co-op">
<meta property="og:title" content="Home">
<meta property="business:contact_data:street_address" content="200 Power Line Rd">
<meta property="business:contact_data:locality" content="Loyalton">
<meta property="business:contact_data:region" content="CA">
<meta property="business:contact_data:postal_code" content="96118">
<meta property="business:contact_data:phone_number" content="530.555.0170">
<meta property="business:contact_data:email" content="service@svec-coop.example">
<title>Home</title>
</head><body><div>Keeping the lights on.</div></body></html>`;

const LINKS_ONLY = `<html><head><title>Home | Ridge Line Electric Supply</title></head><body>
<nav><a href="tel:+15305550150" class="phone">Call</a></nav>
<main><p>Wire, breakers and panels, same-day.</p>
<a href="mailto:webmaster@hostingco.example">Site by HostingCo</a>
<a href='mailto:Sales@RidgeLineElectric.example?subject=Quote%20request'>Email Sales</a>
<a href="tel:530-555-0199">Warehouse</a></main>
<footer><a href="tel:(530)%20555-0150">Call</a></footer>
</body></html>`;

const MESSY = `<HTML><head><title>Welcome to Plumas &amp; Sierra Supply &#8211; Quincy</title>
<script>var fake = "(999) 555-1234"; var dsn = "abc123@o123.ingest.sentry.io";</script>
<script type="application/ld+json">{"@type": "Organization", "name": "broken" "oops"}</script garbage>
<style>.x{content:"(530) 555-0000"}</style>
</head>
<body><div class=wrap><p>Serving the valley since 1972<br>
<!-- <a href="tel:5305559999">old number</a> -->
<b>Phone:</b> (530) 555-0110 &middot; <b>Fax:</b> (530) 555-0111<br>
Order #5305550100 ships today.
<address>123 Main St., Suite 200<br>Quincy, CA 95971</address>
<p>Office hours: Monday - Friday, 8:00 a.m. to 5:00 p.m.
<p>Questions? counter@plumas-sierra.example or <img src="logo@2x.png">
<table><tr><td>unclosed
</body>`;

describe("extractContact", () => {
  it("reads the site's own JSON-LD card first: name, phones, email, address, hours", () => {
    const { fields, weak } = extractContact(JSON_LD, "https://www.pinecounty.example.gov/building");
    expect(fields).toEqual({
      name: "Pine County Building Department",
      phones: ["(530) 555-0142", "(530) 555-0143"],
      email: "building@pinecounty.example.gov",
      street: "101 Courthouse Sq",
      city: "Pineville",
      state: "CA",
      zip: "96000",
      hours: "Mon–Fri 8 AM–5 PM; Sat 9 AM–12:30 PM",
    });
    expect(weak).toEqual([]);
  });

  it("reads meta tags when there is no JSON-LD", () => {
    const { fields, weak } = extractContact(META_ONLY, "https://svec-coop.example/");
    expect(fields).toEqual({
      name: "Sierra Valley Electric Co-op",
      phones: ["(530) 555-0170"],
      email: "service@svec-coop.example",
      street: "200 Power Line Rd",
      city: "Loyalton",
      state: "CA",
      zip: "96118",
    });
    expect(weak).toEqual([]);
  });

  it("reads tel: and mailto: links: the most-linked number first, the site's own email over a stranger's", () => {
    const { fields, weak } = extractContact(LINKS_ONLY, "https://www.ridgelineelectric.example/");
    expect(fields.phones).toEqual(["(530) 555-0150", "(530) 555-0199"]);
    expect(fields.email).toBe("sales@ridgelineelectric.example");
    // The title's name is only a guess, so a better answer may replace it.
    expect(fields.name).toBe("Ridge Line Electric Supply");
    expect(weak).toEqual(["name"]);
    expect(fields.street).toBeUndefined();
  });

  it("survives a messy page: skips scripts, styles, comments, fax lines, bare digit runs and image names", () => {
    const { fields, weak } = extractContact(MESSY, "https://plumas-sierra.example/");
    expect(fields.phones).toEqual(["(530) 555-0110"]);
    expect(fields.email).toBe("counter@plumas-sierra.example");
    expect(fields.street).toBe("123 Main St., Suite 200");
    expect(fields.city).toBe("Quincy");
    expect(fields.state).toBe("CA");
    expect(fields.zip).toBe("95971");
    expect(fields.hours).toBe("Monday - Friday, 8:00 a.m. to 5:00 p.m.");
    expect(fields.name).toBe("Plumas & Sierra Supply");
    expect(weak).toEqual(["name"]);
  });

  it("reads schema.org microdata written on the page", () => {
    const html = `<div itemscope itemtype="https://schema.org/LocalBusiness"><h1>Feather River Lumber</h1>
      <span itemprop="telephone">(530) 555-0123</span>
      <div itemprop="address" itemscope itemtype="https://schema.org/PostalAddress">
        <span itemprop="streetAddress">45 Commercial St</span>, <span itemprop="addressLocality">Portola</span>,
        <span itemprop="addressRegion">CA</span> <span itemprop="postalCode">96122</span></div></div>`;
    const { fields } = extractContact(html, "https://frl.example.com/");
    expect(fields).toMatchObject({ phones: ["(530) 555-0123"], street: "45 Commercial St", city: "Portola", state: "CA", zip: "96122" });
  });

  it("reads microdata the way it is really written: unquoted, a list of props, upper-case tags, nested words", () => {
    const html = `<P ITEMPROP=telephone>(530) 555-0124</P>
      <a class="mail" itemprop="email contactPoint" href="#"><b>desk@frl-lumber.example</b></a>
      <span data-itemprop="streetAddress">not this</span><span itemprop="streetAddress">46 Commercial St</span>
      <span itemprop="addressLocality">Portola</span>`;
    expect(extractContact(html, "https://frl.example.com/").fields).toMatchObject({
      phones: ["(530) 555-0124"],
      email: "desk@frl-lumber.example",
      street: "46 Commercial St",
      city: "Portola",
    });
  });

  it("takes a JSON-LD address written as one string, and openingHours shorthand", () => {
    const html = `<script type="application/ld+json">{"@type":"Electrician","name":"Bright Line Electric","address":"9 Oak Ave, Graeagle, CA 96103","openingHours":["Mo-Fr 07:00-15:30"],}</script>`;
    expect(extractContact(html, "https://brightline.example/").fields).toMatchObject({
      name: "Bright Line Electric",
      street: "9 Oak Ave",
      city: "Graeagle",
      state: "CA",
      zip: "96103",
      hours: "Mon–Fri 7 AM–3:30 PM",
    });
  });

  it("never takes an offered Service's name as the business's", () => {
    const html = `<script type="application/ld+json">[{"@type":"Service","name":"Panel Upgrades"},{"@type":"Organization","name":"Crest Electric"}]</script>`;
    expect(extractContact(html, "https://crest.example/").fields.name).toBe("Crest Electric");
  });

  it("gives back an empty card for a page with nothing on it, or garbage", () => {
    expect(extractContact("", "https://x.example/")).toEqual({ fields: {}, weak: [] });
    expect(extractContact("<<<>>>\u0000&#xZZ;", "not a url").fields).toEqual({});
  });

  it("ignores foreign and impossible numbers rather than mangling them", () => {
    const html = `<a href="tel:+44 20 7946 0958">UK</a><a href="tel:123-456-7890">bad</a><p>Call (530) 555-0101</p>`;
    expect(extractContact(html, "https://x.example/").fields.phones).toEqual(["(530) 555-0101"]);
  });

  it("stays fast on a page-sized run of letters with no @ in it", () => {
    const html = `<p>${"a".repeat(400_000)}</p><p>${"1".repeat(200_000)}</p>`;
    const t = Date.now();
    extractContact(html, "https://x.example/");
    expect(Date.now() - t).toBeLessThan(2000);
  });

  it.each([
    ["unclosed selects", "<select ".repeat(180_000)],
    ["unclosed comments", "<!-- ".repeat(250_000)],
    ["unclosed scripts", '<script type="application/ld+json">'.repeat(40_000)],
    ["unclosed meta quotes", '<meta content="'.repeat(90_000)],
    ["half tags", "<a <a <a ".repeat(160_000)],
    ["itemprop bait", '<span itemprop="telephone" '.repeat(50_000)],
    // ONE tag, 1.47 MB long: a pattern that looks for itemprop anywhere in a tag re-scans it per attribute.
    ["one itemprop tag", `<span ${'itemprop="telephone" '.repeat(70_000)}`],
    ["one closed itemprop tag", `<span ${'itemprop="telephone" '.repeat(70_000)}>(530) 555-0123`],
    ["street-number bait", "1 a1 Main ".repeat(140_000)],
    ["hours bait", "Mon 1-".repeat(230_000)],
  ])("stays fast on 1.5 MB of %s (a hostile page can't make it scan once per tag)", (_what, html) => {
    const t = Date.now();
    extractContact(html, "https://x.example/");
    pageTextForModel(html, "https://x.example/");
    // Well under a second alone; generous for a loaded CI box. Quadratic would be minutes.
    expect(Date.now() - t).toBeLessThan(8000);
  }, 20_000);
});

describe("nameFromTitle", () => {
  it.each([
    ["Home | Acme Electric Supply", "Acme Electric Supply"],
    ["Welcome to the Pine County Building Department", "Pine County Building Department"],
    ["Contact Us - Sierra Pacific Power", "Sierra Pacific Power"],
    ["", undefined],
  ])("%s → %s", (title, name) => {
    expect(nameFromTitle(title)).toBe(name);
  });
});

describe("page text", () => {
  it("is the words a person sees, one block per line", () => {
    expect(visibleText("<head><title>T</title></head><body><p>One</p><p>Two <b>bold</b></p><script>no()</script></body>")).toBe("One\nTwo bold");
  });

  it("for the model keeps the title, the description, and the top and bottom of a long page", () => {
    const html = `<title>Acme</title><meta name="description" content="Supply house"><body><p>TOP</p><p>${"filler ".repeat(5000)}</p><footer>Call (530) 555-0188</footer></body>`;
    const t = pageTextForModel(html, "https://acme.example/", 2000);
    expect(t.startsWith("Page address: https://acme.example/\nTitle: Acme\nDescription: Supply house\n\nTOP")).toBe(true);
    expect(t).toContain("(530) 555-0188");
    expect(t.length).toBeLessThan(2400);
  });
});
