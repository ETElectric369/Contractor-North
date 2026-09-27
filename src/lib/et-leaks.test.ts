import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import * as sample from "@/app/(app)/doc-studio/sample-data";
import { COMPANY } from "@/lib/company";
import { companyFromOrg } from "@/components/doc-letterhead";

/**
 * NO COMPANY SEES ANOTHER'S NAME (Wave 0). ET Electric is the fixture, never the rule: its crew,
 * customer, supplier, town, tagline and license format were showing on every company's screens,
 * and its tagline printed under every company's name on every invoice and estimate.
 */
/** What a person could see: comments name the people who asked for things, and that's fine. */
const src = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
const ET_WORDS = /Whitney|Arnoso|Truckee|Tahoe|\bErik\b|\bBrian\b|Consolidated|Integrity|TECL|1156091/;

describe("Document Studio's sample paper names nobody real", () => {
  it("has no real crew, customer, supplier or town", () => {
    expect(JSON.stringify(sample)).not.toMatch(ET_WORDS);
    expect(sample.SAMPLE_INVOICE_ITEMS.slice(0, 2).map((i) => i.description)).toEqual(["Labor — Lead", "Labor — Helper"]);
  });

  it("prints sample numbers and the sample title", () => {
    const s = src("src/app/(app)/doc-studio/studio.tsx");
    expect(s).not.toContain("INV-061");
    expect(s).not.toContain("E-030");
    expect(s).not.toMatch(ET_WORDS);
  });
});

describe("a company's paper says only what the company said", () => {
  it("prints no default tagline", () => {
    expect(COMPANY.tagline).toBe("");
    expect(companyFromOrg({ name: "Main Street Builders" } as never).tagline).toBe("");
  });
});

describe("no placeholder shows a real account, license, branch or town", () => {
  // A user copies a placeholder as if it were a format: Erik's CED account number, his branch and
  // his license number were sitting in empty boxes on every company's screens.
  it("every placeholder in the app is a neutral example", () => {
    const walk = (d: string): string[] =>
      readdirSync(d).flatMap((n) => {
        const p = join(d, n);
        return statSync(p).isDirectory() ? walk(p) : p.endsWith(".tsx") ? [p] : [];
      });
    const hits = [...walk(join(process.cwd(), "src/app")), ...walk(join(process.cwd(), "src/components"))].flatMap((f) =>
      (readFileSync(f, "utf8").match(/placeholder=(\{[^}]*\}|"[^"]*")/g) ?? [])
        .filter((p) => /TR-34426|8802|Truckee|Sunnyvale|Tahoe|Washoe|NV Energy|1156091|\bCED\b/.test(p))
        .map((p) => `${f.split("/src/")[1]}: ${p}`),
    );
    expect(hits).toEqual([]);
  });
});

describe("Nort says who built it without saying it runs someone else's company", () => {
  it("built by an electrical contractor, for contractors", async () => {
    const { ASSISTANT_SYSTEM_PROMPT } = await import("@/lib/anthropic");
    expect(ASSISTANT_SYSTEM_PROMPT).toContain("built by Erik Taylor, an electrical contractor, with Claude to help contractors run their business.");
    expect(ASSISTANT_SYSTEM_PROMPT).not.toContain("to help run his contracting business");
  });
});

describe("a purchase order names no supplier until a person does", () => {
  it("New PO starts empty, and neither the PO page nor Nort's tool falls back to CED", () => {
    expect(src("src/app/(app)/purchasing/new-po-button.tsx")).toContain('useState("")');
    expect(src("src/app/(app)/purchasing/actions.ts")).not.toContain('"CED"');
    expect(src("src/app/(app)/purchasing/[id]/po-detail.tsx")).not.toContain("CED");
    expect(src("src/lib/actions/entities/purchaseOrder.ts")).not.toContain("CED");
  });
});

describe("sign-up, sign-in and Settings carry North's mark and plain labels", () => {
  it("onboarding: the dome asset, no trade icon, no tagline, a made-up example company", () => {
    const s = src("src/app/onboarding/page.tsx");
    expect(s).not.toContain("Zap");
    expect(s).toContain('src="/icon-192.png"');
    expect(s).not.toMatch(ET_WORDS);
  });

  it("login and the landing page: no ET tagline or trade icon", () => {
    expect(src("src/app/login/page.tsx")).not.toContain("Integrity");
    const landing = src("src/app/page.tsx");
    expect(landing).not.toContain("Integrity");
    expect(landing).not.toContain("Zap");
  });

  it("Settings says License #, and no placeholder is a real license", () => {
    expect(src("src/app/(app)/settings/org-settings-form.tsx")).not.toContain("TECL");
    expect(src("src/app/(app)/settings/splash-settings.tsx")).not.toMatch(ET_WORDS);
  });

  it("the Sales Tax card's example names no real town", () => {
    const s = src("src/app/(app)/settings/tax-rates-manager.tsx");
    expect(s).not.toMatch(ET_WORDS);
    expect(s).not.toMatch(/\bReno\b/);
  });

  it("the Playbook starters say what they are, not whose they are", async () => {
    const { PLAYBOOK_STARTERS } = await import("@/lib/playbook/starters");
    for (const st of PLAYBOOK_STARTERS) expect(st.blurb, st.key).not.toMatch(/Whitney|Truckee|Tahoe|\bErik|\bChris|\bhis\b/);
  });
});

describe("a supplier's terms are the supplier's own", () => {
  it("the supplier card never states one supplier's discount day as every supplier's", () => {
    // The parser reads the day printed on each paper (ced-invoice-parse dayOfFollowingMonth); a
    // sentence naming "the tenth" told a 15th-of-the-month supplier, or one with no discount, CED's terms.
    const s = src("src/app/(app)/bills/supplier-invoices-card.tsx");
    expect(s).not.toMatch(/tenth of the month|takes a cut off every invoice/);
  });
});

describe("a deck company's customers are asked about a region only when the company priced one", () => {
  it("the configurator, the office generator and the site chat gate the TRPA question on deckAsksTrpa", () => {
    const conf = src("src/app/estimate/[handle]/configurator.tsx");
    expect(conf.indexOf("deckAsksTrpa(rates) &&")).toBeGreaterThan(-1);
    expect(conf.indexOf("deckAsksTrpa(rates) &&")).toBeLessThan(conf.indexOf("Lake Tahoe basin"));
    const gen = src("src/app/(app)/quotes/new/deck-generator-panel.tsx");
    expect(gen.indexOf("deckAsksTrpa(rates) &&")).toBeGreaterThan(-1);
    expect(gen.indexOf("deckAsksTrpa(rates) &&")).toBeLessThan(gen.indexOf("Tahoe basin"));
    const chat = src("src/app/api/site-chat/route.ts");
    expect(chat).toContain("deckTool(asksTrpa)");
    expect(chat).toContain('${asksTrpa ? ", and whether it\'s in the Tahoe/TRPA basin" : ""}');
  });
});
