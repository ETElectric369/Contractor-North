import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * EVERY COMPANY'S STANDING, RENDERED (cn-v1137): the name, the plan, the pill, one line from the
 * reason the server computed, the date box with Comp Until, End Comp only when the comp is the
 * column's, a failed read said where the list would be, and Title Case on every door. Rendered the
 * way this repo renders a screen in a test — react-dom/server on the real component.
 */
vi.mock("@/components/toast", () => ({ useToast: () => vi.fn() }));
vi.mock("./company-actions", () => ({ setCompedUntil: vi.fn() }));

import { CompanyList, CompanyRowView, compedUntilIso, planWord, standingLine, standingPill } from "./company-list";
import type { CompanyRow } from "./company-actions";

const ROW: CompanyRow = {
  id: "00000001-0000-4000-8000-000000000001",
  name: "Thistlewood Plumbing",
  plan: "trial",
  status: "trialing",
  active: true,
  reason: "trial",
  daysLeft: 3,
  compedBy: null,
  uncomped: { active: true, reason: "trial", daysLeft: 3, compedBy: null },
  trialEndsAt: "2026-10-31T17:00:00Z",
  periodEnd: null,
  compedUntil: null,
  stripeCustomer: false,
  createdAt: "2026-10-01T17:00:00Z",
  tz: "America/Los_Angeles",
};
const row = (o: Partial<CompanyRow>): CompanyRow => ({ ...ROW, ...o });

const list = (rows: CompanyRow[], readError: string | null = null) => renderToStaticMarkup(createElement(CompanyList, { initial: rows, readError }));
const one = (r: CompanyRow) => renderToStaticMarkup(createElement(CompanyRowView, { row: r, onComp: () => {}, onEndComp: () => {} }));
const doorWords = (s: string) => [...s.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((m) => m[1].replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'").trim());
const titleCase = (label: string) => label.split(/\s+/).every((w) => /^[A-Z0-9×(]/.test(w));

describe("the line from the reason", () => {
  it("trial: Trial Ends <Mon D> (N Days), Today and 1 Day said as such, no end date said", () => {
    expect(standingLine(row({ reason: "trial", daysLeft: 3 }))).toBe("Trial Ends Oct 31 (3 Days)");
    expect(standingLine(row({ reason: "trial", daysLeft: 1 }))).toBe("Trial Ends Oct 31 (1 Day)");
    expect(standingLine(row({ reason: "trial", daysLeft: 0 }))).toBe("Trial Ends Oct 31 (Today)");
    expect(standingLine(row({ reason: "trial", daysLeft: null, trialEndsAt: null }))).toBe("Trial (No End Date)");
    // The company's own calendar: 11 PM Pacific on the 31st is still the 31st.
    expect(standingLine(row({ reason: "trial", daysLeft: 3, trialEndsAt: "2026-11-01T06:30:00Z" }))).toBe("Trial Ends Oct 31 (3 Days)");
    expect(standingLine(row({ reason: "trial", daysLeft: 3, trialEndsAt: "2026-11-01T06:30:00Z", tz: "America/New_York" }))).toBe("Trial Ends Nov 1 (3 Days)");
  });

  it("grace, comped (by the column with its date, by env), active, the three lapses, unknown", () => {
    expect(standingLine(row({ reason: "grace", daysLeft: 7 }))).toBe("Grace: 7 Days Left");
    expect(standingLine(row({ reason: "grace", daysLeft: 1 }))).toBe("Grace: 1 Day Left");
    expect(standingLine(row({ reason: "comped", compedBy: "column", compedUntil: "2027-02-01T07:59:59Z" }))).toBe("Comped Until Jan 31, 2027");
    expect(standingLine(row({ reason: "comped", compedBy: "env", compedUntil: null }))).toBe("Comped By Env");
    expect(standingLine(row({ reason: "active" }))).toBe("Active");
    expect(standingLine(row({ reason: "trial_ended" }))).toBe("Lapsed: Trial Ended");
    expect(standingLine(row({ reason: "grace_spent" }))).toBe("Lapsed: Card Not Updated");
    expect(standingLine(row({ reason: "canceled" }))).toBe("Lapsed: Canceled");
    expect(standingLine(row({ reason: "unknown" }))).toBe("Unknown");
  });

  it("the pill: Comped purple, Active green, Trial blue, Grace amber, Lapsed red, Unknown grey — from the one palette", () => {
    expect(standingPill("comped")).toEqual({ word: "Comped", tone: "purple" });
    expect(standingPill("active")).toEqual({ word: "Active", tone: "green" });
    expect(standingPill("trial")).toEqual({ word: "Trial", tone: "blue" });
    expect(standingPill("grace")).toEqual({ word: "Grace", tone: "amber" });
    for (const r of ["trial_ended", "grace_spent", "canceled"] as const) expect(standingPill(r)).toEqual({ word: "Lapsed", tone: "red" });
    expect(standingPill("unknown")).toEqual({ word: "Unknown", tone: "slate" });
    expect(one(row({ reason: "canceled" }))).toMatch(/bg-red-100[^"]*">Lapsed</);
    expect(one(row({ reason: "comped", compedBy: "column", compedUntil: "2027-02-01T07:59:59Z" }))).toMatch(/bg-purple-100[^"]*">Comped</);
  });

  it("the plan's word: a tier's name, Trial, No Plan, or the stored word", () => {
    expect(planWord("crew")).toBe("Crew");
    expect(planWord("handyman")).toBe("Handyman");
    expect(planWord("company")).toBe("Company");
    expect(planWord("trial")).toBe("Trial");
    expect(planWord(null)).toBe("No Plan");
    expect(planWord("Legacy Monthly")).toBe("Legacy Monthly");
  });
});

describe("the comp's instant", () => {
  it("a picked calendar day ends at the last second of that day in the company's zone", () => {
    expect(compedUntilIso("2026-11-30", "America/Los_Angeles")).toBe("2026-12-01T07:59:59.000Z"); // PST
    expect(compedUntilIso("2026-07-15", "America/Los_Angeles")).toBe("2026-07-16T06:59:59.000Z"); // PDT
    expect(compedUntilIso("2026-11-30", "America/New_York")).toBe("2026-12-01T04:59:59.000Z");
    // The spring-forward day is 23 hours long and still ends at its own midnight.
    expect(compedUntilIso("2027-03-14", "America/Los_Angeles")).toBe("2027-03-15T06:59:59.000Z");
    // And the row then reads the day that was picked.
    expect(standingLine(row({ reason: "comped", compedBy: "column", compedUntil: compedUntilIso("2026-11-30", "America/Los_Angeles") }))).toBe("Comped Until Nov 30, 2026");
    // Month's end rolls over.
    expect(compedUntilIso("2026-12-31", "UTC")).toBe("2026-12-31T23:59:59.000Z");
  });

  it("anything that is not a calendar day is no instant", () => {
    expect(compedUntilIso("", "America/Los_Angeles")).toBeNull();
    expect(compedUntilIso("11/30/2026", "America/Los_Angeles")).toBeNull();
    expect(compedUntilIso("2026-11-30T00:00", "America/Los_Angeles")).toBeNull();
  });
});

describe("a row", () => {
  it("the name, the plan, the pill, the line, since-when and the card, the date box, Comp Until", () => {
    const s = one(row({ plan: "crew", stripeCustomer: true }));
    expect(s).toContain(">Thistlewood Plumbing<");
    expect(s).toContain(">Crew<");
    expect(s).toContain(">Trial<");
    expect(s).toContain(">Trial Ends Oct 31 (3 Days)<");
    // "Stripe Customer", never "Card On File": the customer is minted at Checkout before any card (S11).
    expect(s).toContain(">Since Oct 1, 2026 · Stripe Customer<");
    expect(s).not.toContain("Card On File");
    expect(s).toContain('type="date"');
    expect(s).toContain('aria-label="Comp Until Date"');
    expect(doorWords(s)).toEqual(["Comp Until"]);
    // No date picked yet: the door waits.
    expect(s).toMatch(/<button[^>]*disabled=""[^>]*>Comp Until<\/button>/);
    expect(one(row({ stripeCustomer: false }))).toContain(">Since Oct 1, 2026<");
  });

  it("a comp until a day that has passed is refused before the row moves (skeptic #43, S11): the server's own words, no optimistic row", () => {
    const src = readFileSync(join(process.cwd(), "src/app/(app)/bugs/company-list.tsx"), "utf8");
    const refusal = src.indexOf('if (untilIso && Date.parse(untilIso) <= Date.now()) {\n      toast("Pick a day after today.", "error");\n      return;\n    }');
    const optimistic = src.indexOf("const after: CompanyRow = untilIso");
    expect(refusal).toBeGreaterThan(0);
    expect(optimistic).toBeGreaterThan(refusal);
    expect(src).toContain('{row.stripeCustomer ? " · Stripe Customer" : ""}');
  });

  it("End Comp only when the comp is the column's — not for an env comp, not for anyone else", () => {
    expect(doorWords(one(row({ reason: "comped", compedBy: "column", compedUntil: "2027-02-01T07:59:59Z" })))).toEqual(["Comp Until", "End Comp"]);
    expect(doorWords(one(row({ reason: "comped", compedBy: "env" })))).toEqual(["Comp Until"]);
    expect(doorWords(one(row({ reason: "active" })))).toEqual(["Comp Until"]);
    expect(doorWords(one(row({ reason: "canceled" })))).toEqual(["Comp Until"]);
  });
});

describe("the list, the empty state and the failed read", () => {
  it("one row per company, in the order the server gave", () => {
    const s = list([row({ id: "a", name: "Bayberry Builders" }), row({ id: "b", name: "Catbird Electric", reason: "active" })]);
    expect((s.match(/<li/g) ?? []).length).toBe(2);
    expect(s.indexOf("Bayberry Builders")).toBeLessThan(s.indexOf("Catbird Electric"));
  });

  it("no companies: said, not blank", () => {
    const s = list([]);
    expect(s).toContain("No companies yet");
    expect(s).not.toContain("<li");
  });

  it("a failed read is said where the list would be, with the reason, and no row and no empty state", () => {
    const s = list([row({ id: "a" })], "organizations could not be read: could not connect to server");
    expect(s).toContain("Couldn&#x27;t read the companies");
    expect(s).toContain("organizations could not be read: could not connect to server");
    expect(s).not.toContain("<li");
    expect(s).not.toContain("No companies yet");
  });
});

describe("Title Case on every door", () => {
  it("Comp Until, End Comp, and every button the list renders", () => {
    const s = list([row({ id: "a" }), row({ id: "b", reason: "comped", compedBy: "column", compedUntil: "2027-02-01T07:59:59Z" })]);
    const words = doorWords(s);
    expect(words).toEqual(["Comp Until", "Comp Until", "End Comp"]);
    for (const w of words) expect(titleCase(w), w).toBe(true);
    for (const w of ["Comped By Env", "Lapsed: Trial Ended", "Lapsed: Card Not Updated", "Lapsed: Canceled", "Trial (No End Date)"]) expect(titleCase(w), w).toBe(true);
  });
});

describe("Bug Watch mounts the companies under the errors", () => {
  it("the page reads the companies and hands the list its rows and the read's error, between the errors and the AI key", () => {
    const page = readFileSync(join(process.cwd(), "src/app/(app)/bugs/page.tsx"), "utf8");
    expect(page).toContain("const companies = await listCompanies();");
    expect(page).toContain("<CompanyList initial={companies.rows} readError={companies.error} />");
    expect(page).toContain(">Companies</h2>");
    expect(page.indexOf("<ErrorList")).toBeLessThan(page.indexOf("<CompanyList"));
    expect(page.indexOf("<CompanyList")).toBeLessThan(page.indexOf("<AiStatus"));
  });

  it("the failed-read branch comes before the empty state in the source, and the standing is never re-derived here", () => {
    const src = readFileSync(join(process.cwd(), "src/app/(app)/bugs/company-list.tsx"), "utf8");
    expect(src.indexOf("{readError ? (")).toBeLessThan(src.indexOf("No companies yet"));
    expect(src).toContain('title="Couldn\'t read the companies" description={readError}');
    // The one rule lives in lib/subscription; the component imports nothing from it.
    expect(src).not.toMatch(/from "@\/lib\/subscription"/);
    expect(src).not.toMatch(/\b(accessState|trialDaysLeft\w*|graceDaysLeft\w*|hasActiveAccess)\(/);
  });
});
