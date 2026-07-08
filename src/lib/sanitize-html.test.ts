import { describe, expect, it } from "vitest";
import { sanitizeHtml, textToHtml } from "./sanitize-html";

describe("sanitizeHtml", () => {
  it("keeps editorial markup", () => {
    const out = sanitizeHtml(`<h2>Redwood</h2><p>A <strong>premium</strong> wood.</p><ul><li>30-year life</li></ul>`);
    expect(out).toContain("<h2>Redwood</h2>");
    expect(out).toContain("<strong>premium</strong>");
    expect(out).toContain("<li>30-year life</li>");
  });

  it("keeps http image + link (with safe rel/target)", () => {
    const out = sanitizeHtml(`<img src="https://x.com/a.jpg" alt="deck"/><a href="https://x.com">link</a>`);
    expect(out).toContain(`src="https://x.com/a.jpg"`);
    expect(out).toContain(`href="https://x.com"`);
    expect(out).toContain(`rel="noopener noreferrer nofollow"`);
  });

  it("drops script/style/iframe/form entirely", () => {
    for (const p of [
      `<p>hi</p><script>alert(1)</script>`,
      `<style>p{}</style><p>hi</p>`,
      `<iframe src="https://evil"></iframe><p>hi</p>`,
      `<form action="x"><input/></form><p>hi</p>`,
    ]) {
      const out = sanitizeHtml(p);
      expect(out).toContain("<p>hi</p>");
      expect(out).not.toMatch(/<script|<style|<iframe|<form/i);
    }
  });

  // The exact bypasses the adversarial review found against the old regex sanitizer.
  it("neutralizes slash-separated event handlers (no live on* attribute)", () => {
    for (const p of [`<svg/onload=alert(1)>`, `<img/src=x/onerror=alert(1)>`, `<img src=x/onerror=alert(1)>`]) {
      const out = sanitizeHtml(p);
      expect(out).not.toMatch(/\sonerror=/i);
      expect(out).not.toMatch(/\sonload=/i);
      expect(out).not.toContain("<svg"); // svg not on the allowlist
    }
  });

  it("strips whitespace-separated event handlers", () => {
    expect(sanitizeHtml(`<p onclick="alert(1)">hi</p>`)).toBe("<p>hi</p>");
    expect(sanitizeHtml(`<img src="a.jpg" onerror='x()'/>`)).not.toMatch(/onerror/i);
  });

  it("strips javascript: urls, including entity-encoded", () => {
    expect(sanitizeHtml(`<a href="javascript:alert(1)">x</a>`)).not.toMatch(/javascript:/i);
    expect(sanitizeHtml(`<a href="jav&#97;script:alert(1)">x</a>`)).not.toMatch(/javascript:/i);
    expect(sanitizeHtml(`<a href="jav&#x0A;ascript:alert(1)">x</a>`)).not.toMatch(/javascript:/i);
  });

  it("strips style attributes (CSS exfil vector)", () => {
    expect(sanitizeHtml(`<div style="background:url(//evil?x)">hi</div>`)).not.toMatch(/style=/i);
  });

  it("drops data: and non-http image sources", () => {
    expect(sanitizeHtml(`<img src="data:text/html,<script>alert(1)</script>"/>`)).not.toMatch(/data:text\/html/i);
  });
});

describe("textToHtml", () => {
  it("paragraphs plain text and escapes tags", () => {
    expect(textToHtml("Hello world.\n\nSecond <b>para</b>.")).toBe(
      "<p>Hello world.</p>\n<p>Second &lt;b&gt;para&lt;/b&gt;.</p>",
    );
  });
  it("keeps single newlines as breaks", () => {
    expect(textToHtml("line one\nline two")).toBe("<p>line one<br/>line two</p>");
  });
});
