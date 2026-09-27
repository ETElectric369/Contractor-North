import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * THE WALK-THROUGH, RENDERED, FOR EACH OF ITS THREE READERS (0356; Erik, 2026-09-26: "crew leader
 * yes tech no"). Counted on the real component (the dead-door lesson: run the selector, count the
 * doors):
 *
 *   office    unchanged: the address box, the links, the price book, scope prices and their total,
 *             the photo trash, Save and Start The Estimate.
 *   crewLead  fills it in: every control live, Take / Add / Save; no price anywhere (even when a
 *             price is handed in by mistake), no price book, no Start The Estimate, no address box,
 *             no photo trash; every door he can reach is Title Case and 44px.
 *   view      a plain tech: one disabled fieldset and none of the doors that would only fail.
 */
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("../actions", () => ({
  addInspectionPhotos: vi.fn(),
  saveInspectionAnswers: vi.fn(),
  saveInspectionCapture: vi.fn(),
  setAppointmentPlace: vi.fn(),
  linkAppointmentTo: vi.fn(),
  searchLinkTargets: vi.fn(async () => []),
}));
vi.mock("../hear-actions", () => ({ hearIntoPlaybook: vi.fn() }));
vi.mock("../../forms/actions", () => ({ createStarterInspectionSheet: vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({ createClient: vi.fn() }));
// The address box is a Places widget; here it only needs to say whether it was drawn.
vi.mock("@/components/address-autocomplete", () => ({
  AddressAutocomplete: () => createElement("input", { "data-address-box": "yes" }),
}));

import { Inspector } from "./inspector";
import type { WalkthroughAccess } from "@/lib/inspection/walkthrough-access";

const SHEET = {
  id: "sheet-1",
  name: "Site walk",
  schema: [],
  playbook: {
    needs: [
      { key: "work", label: "Work", ask: "What kind of work is this?", slot: { type: "select", options: ["Deck", "Remodel"], other: true } },
      { key: "scope", label: "Scope", ask: "Which scopes?", slot: { type: "scopes" } },
      { key: "panel", label: "Panel", ask: "Which panel is it?", slot: { type: "text" } },
    ],
  },
};
// A price, handed in as if it leaked: the crew's and the tech's walk-through must not draw it.
const ANSWERS = { work: "Remodel", scope: [{ code: "R1", qty: 2, price: 517.25 }] };
const BOOK = [
  { code: "R1", description: "Remodel scope", unit: "EA", price: 517.25 },
  { code: "R2", description: "Demo", unit: "EA", price: 243.5 },
];
const PHOTO = { path: "org-1/appointments/appt-1/1-panel.jpg", url: "https://example.invalid/1-panel.jpg" };

const render = (access: WalkthroughAccess, over: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    createElement(Inspector, {
      appointmentId: "appt-1",
      orgId: "org-1",
      userId: "u-1",
      templates: [SHEET],
      priceBook: access === "office" ? BOOK : [],
      initialTemplateId: "sheet-1",
      initialAnswers: ANSWERS as never,
      initialCapture: { notes: "Meter base pulling off the wall", photos: [PHOTO.path], measures: [{ id: "m1", label: "Run", value: 40, unit: "ft" }] },
      initialPhotos: [PHOTO],
      initialLocation: "13125 Moraine Rd",
      linked: { kind: "lead", name: "Sara Cain" },
      estimateHref: access === "office" ? "/quotes/new?capture=appt-1" : null,
      access,
      ...over,
    }),
  );

const textOf = (html: string) =>
  html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&rsquo;|’/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const buttons = (html: string) =>
  [...html.matchAll(/<button[^>]*>[\s\S]*?<\/button>/g)].map((m) => ({ markup: m[0], open: m[0].match(/^<button[^>]*>/)![0], text: textOf(m[0]) }));
const TARGET = /min-h-\[44px\]|\bh-11\b|\bh-12\b|min-w-\[44px\]/;
const titleCase = (s: string) => s.split(/\s+/).filter((w) => /^[a-z]/i.test(w)).every((w) => /^[A-Z]/.test(w));
/** Any money on screen: a dollar sign, the "@ rate" of a scope row, or either book price. (The
 *  words "the office prices it" are the point, not a leak.) */
const PRICE = /\$|517|243|@/;

describe("the office: unchanged", () => {
  const html = render("office");
  it("keeps the address box, the price book, the scope prices and their total", () => {
    expect(html).toContain('data-address-box="yes"');
    expect(html).toContain("Add a line item");
    expect(html).toMatch(/Demo — \$243\.5\/EA/);
    expect(textOf(html)).toContain("$1,034.50"); // 2 × 517.25
  });
  it("keeps the photo trash, Save and Start The Estimate, and nothing is disabled", () => {
    expect(html).not.toMatch(/<fieldset[^>]*disabled/);
    expect(html).toContain("absolute right-1 top-1"); // the photo's trash
    const t = buttons(html).map((b) => b.text);
    expect(t).toContain("Save");
    expect(t).toContain("Start The Estimate");
    expect(t).toContain("Take");
    expect(t).toContain("Add");
    expect(html).toContain('href="/quotes/new?capture=appt-1"');
  });
});

describe("a crew lead on this visit: fills it in, never a price", () => {
  const html = render("crewLead");
  const t = textOf(html);

  it("says whose it is, and every control is live", () => {
    expect(t).toContain("You're the crew lead on this visit: fill it in here. The office prices it.");
    expect(html).not.toMatch(/<fieldset[^>]*disabled/);
    const doors = buttons(html).map((b) => b.text);
    for (const d of ["Save", "Take", "Add", "Just Tell Nort", "Deck", "Remodel", "Something Else", "Add A Measurement"]) expect(doors, d).toContain(d);
    // What he answered is still there to edit, and his notes and measurements are his.
    expect(html).toContain("Meter base pulling off the wall");
    expect(html).toMatch(/value="Run"/);
  });

  it("no price, no price book, no Start The Estimate, even with a price handed in", () => {
    expect(t).not.toMatch(PRICE);
    expect(html).not.toContain("Add a line item");
    expect(t).not.toMatch(/Start The Estimate/i);
    expect(html).not.toContain("/quotes/new");
    // What was picked, and how many, and whose job the price is.
    expect(t).toMatch(/R1 × 2/);
    expect(t).toContain("The office picks and prices these.");
  });

  it("the address and the links are the office's: shown, not editable", () => {
    expect(html).not.toContain('data-address-box="yes"');
    expect(t).toContain("13125 Moraine Rd");
    expect(t).toContain("Sara Cain");
    expect(buttons(html).map((b) => b.text)).not.toContain("change");
  });

  it("he adds photos and never takes one off", () => {
    expect(html).not.toContain("absolute right-1 top-1");
    expect(html).toContain(PHOTO.url);
  });

  it("the sheet can't be switched once one is saved on the visit", () => {
    const two = [SHEET, { ...SHEET, id: "sheet-2", name: "Service call" }];
    expect(render("crewLead", { templates: two })).not.toContain("Pick a sheet");
    expect(render("crewLead", { templates: two, initialTemplateId: null })).toContain("Pick a sheet");
    expect(render("office", { templates: two })).toContain("Pick a sheet");
  });

  it("every door he can reach is Title Case and 44px", () => {
    const bs = buttons(html);
    expect(bs.length).toBeGreaterThan(8);
    for (const b of bs) {
      if (/h-full w-full/.test(b.open)) continue; // a photo tile is the whole thumbnail
      expect(b.open, b.text || b.open).toMatch(TARGET);
      expect(titleCase(b.text), b.text).toBe(true);
    }
  });

  it("with no questions set up, he is told it's the office's, and notes and photos still save", () => {
    const none = textOf(render("crewLead", { templates: [], initialTemplateId: null, initialAnswers: {} }));
    expect(none).toContain("The office hasn't set up walk-through questions yet. Notes, measurements and photos below still save.");
    expect(none).not.toMatch(/Set Up My Questions/i);
  });
});

describe("a plain tech: reads it", () => {
  const html = render("view");
  const t = textOf(html);
  it("one disabled fieldset, and none of the doors that would only fail", () => {
    expect(t).toContain("Only the office can change the walk-through.");
    expect(html).toMatch(/<fieldset[^>]*disabled/);
    const doors = buttons(html).map((b) => b.text);
    for (const d of ["Save", "Take", "Add", "Start The Estimate"]) expect(doors, d).not.toContain(d);
    expect(html).not.toContain("absolute right-1 top-1");
    expect(html).not.toContain('data-address-box="yes"');
  });
  it("never a price, even with one handed in", () => {
    expect(t).not.toMatch(PRICE);
    expect(html).not.toContain("Add a line item");
  });
  it("a crew lead before 0356 gets the same read-only sheet, with the page's line", () => {
    const before = textOf(render("view", { viewNote: "Crew leads can fill this in once the office finishes an update. Until then only the office can change it." }));
    expect(before).toContain("Crew leads can fill this in once the office finishes an update.");
    expect(before).not.toContain("Only the office can change the walk-through.");
  });
});
