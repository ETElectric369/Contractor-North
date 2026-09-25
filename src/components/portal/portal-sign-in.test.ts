import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import fs from "fs";
import path from "path";
import { PortalSignIn, PortalSignOut } from "./portal-sign-in";
import type { PortalOrg } from "./portal-shell";

/**
 * THE SIGN-IN SCREEN AS IT RENDERS (0331), on a 375px phone. A static render can't measure pixels,
 * so this pins what makes 375 work: one column inside the shell's 16px gutters (px-4), no element
 * wider than the 343px left, no sideways scroller, every control a finger touches at least 44px
 * tall, the address allowed to wrap. And the words: the business's name, the masked address and
 * never the full one, Title Case buttons, and a way forward when there's no email on file.
 */
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined }) }));

const ORG: PortalOrg = {
  name: "ET Electric",
  logoUrl: "https://example.com/logo.png",
  phone: "(530) 555-0100",
  email: "office@example.com",
  license: "C-10 #1234567",
  tint: "#006d8f",
};
const never = () => new Promise<never>(() => undefined);
const render = (props: Partial<Parameters<typeof PortalSignIn>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(PortalSignIn, { org: ORG, maskedEmail: "m*******@comcast.net", send: never, check: never, ...props }),
  );
const text = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

/** Every fixed width in the markup (Tailwind w-[Npx] / min-w-[Npx] / max-w-[Npx] and inline px). */
function fixedWidths(html: string): number[] {
  const out: number[] = [];
  for (const m of html.matchAll(/(?:^|[\s"])(?:min-|max-)?w-\[(\d+)px\]/g)) out.push(Number(m[1]));
  for (const m of html.matchAll(/width:\s*(\d+)px/g)) out.push(Number(m[1]));
  return out;
}

describe("the sign-in screen at 375px", () => {
  const html = render();
  const words = text(html);

  it("says whose page it is and where the code goes, masked, with one button", () => {
    expect(words).toContain("Your page with ET Electric");
    expect(words).toContain("For your privacy, we'll email a 6-digit code to m*******@comcast.net");
    expect(words).toContain("Send My Code");
    expect(words).toContain("I Already Have A Code");
    expect(html).not.toContain("mcpowder");
    expect(html).not.toMatch(/comcast\.net"/); // never in an attribute (a mailto, a value)
  });

  it("wears the business's glass, name and logo, with Call and Email in the header", () => {
    expect(html).toContain("portal-backdrop");
    expect(html).toContain("portal-glass");
    expect(html).toContain("--glass-tint");
    expect(html).toContain('src="https://example.com/logo.png"');
    expect(html).toContain('href="tel:5305550100"');
    expect(html).toContain('href="mailto:office@example.com"');
  });

  it("fits 375: 16px gutters, one column, nothing wider than 343px, no sideways scroller", () => {
    expect(html).toMatch(/mx-auto px-4/);
    for (const w of fixedWidths(html)) expect(w).toBeLessThanOrEqual(343);
    expect(html).not.toMatch(/overflow-x-(auto|scroll)/);
    expect(html).not.toMatch(/whitespace-nowrap[^"]*w-full/);
    // The address may wrap on a narrow phone rather than push the card wider.
    expect(html).toContain("[overflow-wrap:anywhere]");
  });

  it("every button a finger touches is at least 44px tall", () => {
    // Inline links inside a sentence (the shell's "Questions? Ask … at (530) …") are prose, not controls.
    const buttons = [...html.matchAll(/<(button|a)\b[^>]*class="([^"]*)"/g)]
      .map((m) => m[2])
      .filter((cls) => !(/\bunderline\b/.test(cls) && !/inline-flex/.test(cls)));
    expect(buttons.length).toBeGreaterThanOrEqual(4);
    for (const cls of buttons) expect(cls).toMatch(/min-h-\[(4[4-9]|[5-9]\d)px\]|h-11|h-12|h-14/);
  });

  it("buttons are Title Case", () => {
    for (const label of ["Send My Code", "I Already Have A Code"]) {
      for (const word of label.split(" ")) expect(word[0]).toBe(word[0].toUpperCase());
    }
  });
});

describe("an email that isn't theirs any more: no dead end", () => {
  it("says to ask the business to update it, with Call and Email right there, on both steps", () => {
    for (const html of [render(), render({ codeSentMinutesAgo: 2 })]) {
      const words = text(html);
      expect(words).toContain("Not your email, or you don't use it anymore? Ask ET Electric to update it.");
      expect(words).toContain("Call ET Electric");
      expect(words).toContain("Email ET Electric");
      expect(html).toContain('href="mailto:office@example.com?subject=Please%20update%20my%20email"');
    }
  });
});

describe("a code already out (re-clicking the link from a text)", () => {
  const html = render({ codeSentMinutesAgo: 3 });
  const words = text(html);

  it("opens on the code box, not on a send that would cancel the code just read", () => {
    expect(words).toContain("We emailed a code to m*******@comcast.net 3 minutes ago. Enter it below.");
    expect(html).toContain('id="portal-code"');
    expect(words).toContain("Open My Page");
    expect(words).toContain("Send A New Code");
    expect(words).not.toContain("Send My Code");
  });

  it("no code out: the start, with Send My Code", () => {
    const start = text(render({ codeSentMinutesAgo: null }));
    expect(start).toContain("Send My Code");
    expect(start).not.toContain("Enter it below");
  });
});

describe("no email on file: no dead end", () => {
  const html = render({ maskedEmail: null });
  const words = text(html);

  it("says to ask the business, and offers Call and Email right there", () => {
    expect(words).toContain("Ask ET Electric to add your email so we can send your code");
    expect(words).toContain("Call ET Electric");
    expect(words).toContain("Email ET Electric");
    expect(words).not.toContain("Send My Code");
    expect(html).toMatch(/href="tel:5305550100"[^>]*class="[^"]*min-h-\[48px\]/);
    expect(html).toMatch(/href="mailto:office@example\.com\?subject=Please%20add%20my%20email"/);
  });

  it("a business with no phone and no email still says what to do", () => {
    const bare = text(render({ maskedEmail: null, org: { ...ORG, phone: null, email: null } }));
    expect(bare).toContain("Ask ET Electric to add your email");
    expect(bare).toContain("Reach them the way you usually do");
  });
});

describe("Sign Out On This Device", () => {
  it("is a 44px, Title Case button", () => {
    const html = renderToStaticMarkup(createElement(PortalSignOut, { signOut: async () => ({ ok: true }) }));
    expect(text(html)).toContain("Sign Out On This Device");
    expect(html).toContain("min-h-[44px]");
  });
});

describe("every portal page asks the door first", () => {
  // A page added under /portal/<token> that forgets the door would open with the link alone again.
  const root = path.join(__dirname, "../../app/portal/[token]");
  const pages: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === "page.tsx") pages.push(p);
    }
  };
  walk(root);

  it("finds the pages", () => {
    expect(pages.length).toBeGreaterThanOrEqual(2);
  });

  it.each(pages.map((p) => [path.relative(root, p), p]))("%s: readPortalAccess and portalGate before any read", (_rel, p) => {
    const src = fs.readFileSync(p, "utf8");
    const body = src.slice(src.indexOf("export default"));
    const gate = body.indexOf("portalGate(");
    expect(body.indexOf("readPortalAccess(")).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(-1);
    for (const reader of ["readPortal(", "read(", "readPortalJob(", ".rpc("]) {
      const at = body.indexOf(reader);
      if (at > -1) expect(at).toBeGreaterThan(gate);
    }
    // And the title: generateMetadata asks the door before it names anything.
    const meta = src.slice(src.indexOf("generateMetadata"), src.indexOf("export default"));
    expect(meta).toContain("gateTitle(");
  });
});
