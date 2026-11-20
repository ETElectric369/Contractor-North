import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * LEAD SOURCES (cn-v1170): the company's own list behind the lead form's Lead Source box. The parser
 * (lib/org-settings leadSourceList, read by getOrgSettings) and the Settings card, in both languages.
 */
vi.mock("./actions", () => ({ updateOrgSettings: vi.fn(async () => ({ ok: true })) }));

import { LangProvider } from "@/components/lang-provider";
import {
  DEFAULT_LEAD_SOURCES,
  DEFAULT_SETTINGS,
  LEAD_SOURCE_MAX_COUNT,
  getOrgSettings,
  leadSourceLabel,
  leadSourceList,
} from "@/lib/org-settings";
import { LeadSources } from "./lead-sources";

describe("leadSourceList", () => {
  const DEF = ["Web", "Signage", "Word of Mouth", "Referral"];
  it.each([
    ["missing", undefined, DEF],
    ["not a list", "Web", DEF],
    ["an empty list reads as the default (as payment_methods)", [], DEF],
    ["only blanks and non-strings", ["  ", 4, null, { a: 1 }], DEF],
    ["trimmed, spaces collapsed", ["  Yard   Sign ", "Referral"], ["Yard Sign", "Referral"]],
    ["one per spelling, whatever its case; the first spelling kept", ["Referral", "referral", "REFERRAL", "Web"], ["Referral", "Web"]],
    ["a company's own order is kept", ["Referral", "Web"], ["Referral", "Web"]],
  ])("%s", (_name, raw, want) => {
    expect(leadSourceList(raw)).toEqual(want);
  });

  it("cut at 60 characters and capped at the count", () => {
    expect(leadSourceList(["y".repeat(90)])).toEqual(["y".repeat(60)]);
    const many = Array.from({ length: 50 }, (_, i) => `Source ${i}`);
    expect(leadSourceList(many)).toHaveLength(LEAD_SOURCE_MAX_COUNT);
    expect(leadSourceLabel(7)).toBe("");
  });

  it("getOrgSettings reads it through the parser; the default is the four", () => {
    expect(DEFAULT_LEAD_SOURCES).toEqual(DEF);
    expect(DEFAULT_SETTINGS.lead_sources).toEqual(DEF);
    expect(getOrgSettings({}).lead_sources).toEqual(DEF);
    expect(getOrgSettings({ lead_sources: [" Truck ", "truck", ""] }).lead_sources).toEqual(["Truck"]);
    expect(getOrgSettings({ lead_sources: "garbage" }).lead_sources).toEqual(DEF);
  });
});

describe("the Settings card", () => {
  const en = () => renderToStaticMarkup(createElement(LeadSources, { sources: ["Web", "Referral"] }));
  const es = () => renderToStaticMarkup(createElement(LangProvider, { lang: "es", children: createElement(LeadSources, { sources: ["Web", "Referral"] }) }));

  it("lists the company's sources, each with its own Remove, and an Add", () => {
    const html = en();
    expect(html).toContain("Where your leads come from.");
    expect(html).toContain('aria-label="Remove Web"');
    expect(html).toContain('aria-label="Remove Referral"');
    expect(html).toContain('placeholder="Add a source…"');
    expect(html).toContain('maxLength="60"');
    expect(html).toMatch(/<\/svg> Add<\/button>/);
  });

  it("in Spanish", () => {
    const html = es();
    expect(html).toContain("De dónde vienen tus prospectos.");
    expect(html).toContain('aria-label="Quitar Web"');
    expect(html).toMatch(/<\/svg> Agregar<\/button>/);
  });

  it("saves through updateOrgSettings, checks the answer, and sits under Leads in Settings › Customers", () => {
    const card = readFileSync(join(__dirname, "lead-sources.tsx"), "utf8");
    expect(card).toContain("await updateOrgSettings({ lead_sources: next });");
    expect(card).toContain("setList(before);"); // a refused save puts the list back
    const page = readFileSync(join(__dirname, "page.tsx"), "utf8");
    expect(page).toMatch(/\{on\("leads"\) && \(\s*<Section title=\{t\("sh_leadSourcesTitle"\)\}>\s*<LeadSources sources=\{settings\.lead_sources\} \/>/);
    const customers = page.slice(page.indexOf('id: "customers"'), page.indexOf('id: "website"'));
    expect(customers).toContain("<LeadSources");
  });
});
