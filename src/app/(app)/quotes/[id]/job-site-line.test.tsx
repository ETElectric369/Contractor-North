import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * THE ESTIMATE'S JOB SITE LINE (cn-v1158). The owner, 2026-11-10, pricing a unit for a customer that
 * owns two complexes at two addresses: "we need to have sites available to pick from on the estimate
 * sheet, it might already be in place just not visible". It was half in place: the estimate had its
 * own address columns and every reader ranked them first, but no screen showed or wrote them.
 *
 * The line is drawn here in each state it has, with its sheet. The sheet's stand-in draws its
 * contents whether or not it is open (and says which), so a test can read what Change Job Site would
 * offer; what a render cannot do (a tap, a save on the wire) is driven in lib/quote-site.test.ts
 * (the rule) and quotes/set-quote-site.test.ts (the write), and pinned at the source below.
 * Every name and street here is invented.
 */
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));
vi.mock("@/components/ui/modal", () => ({
  Modal: ({ open, title, children, footer }: { open?: boolean; title: ReactNode; children: ReactNode; footer?: ReactNode }) =>
    createElement("section", { "data-modal": "", "data-open": String(!!open) }, createElement("h2", null, title), children, footer),
  ModalActions: ({ saveLabel, disabled, saving }: { saveLabel?: string; disabled?: boolean; saving?: boolean }) =>
    createElement("footer", null, createElement("button", { "data-save": "", disabled: !!disabled || !!saving }, saveLabel)),
}));
vi.mock("../actions", () => ({ setQuoteSite: vi.fn() }));

import { JobSiteLine, type JobSiteData } from "./job-site-line";
import { LangProvider } from "@/components/lang-provider";
import { words as qt } from "@/lib/words/quotes";

const cust = { address: "12 Thistlewood Way", unit: null, city: "Testville", state: "CA", zip: "96161" };
const lead = { address: "16 Larkspur Circle", unit: null, city: "Testville", state: "CA", zip: "96161" };
const ownSite = { address: "40 Snowbell Court", unit: "14", city: "Testville", state: "CA", zip: "96161" };
const jobSite = { address: "9 Bayberry Lane", unit: null, city: "Testville", state: "CA", zip: "96161" };
/** The customer's other jobs, newest first, as the estimate's page reads them. */
const otherJobs = [
  { id: "j3", job_number: "J-031", name: "40 Snowbell #14", ...ownSite },
  { id: "j2", job_number: "J-020", name: "9 Bayberry", ...jobSite },
];
const theJob = { id: "j1", job_number: "J-040", name: "9 Bayberry" };

const data = (over: Partial<JobSiteData> = {}): JobSiteData => ({ records: {}, job: null, otherJobs: [], otherJobsFailed: false, otherJobsFull: false, ...over });
const el = (over: Partial<JobSiteData> = {}) => createElement(JobSiteLine, { quoteId: "q-40", ...data(over) });
const decode = (html: string) => html.replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/&quot;/g, '"');
const text = (html: string) => decode(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
/** The line as it stands on the page, and the sheet Change Job Site opens, apart. */
function draw(over: Partial<JobSiteData> = {}, lang: "en" | "es" | null = null) {
  const html = renderToStaticMarkup(lang ? createElement(LangProvider, { lang, children: el(over) }) : el(over));
  const at = html.indexOf("<section data-modal");
  const line = html.slice(0, at);
  const sheet = html.slice(at, html.indexOf("</section>") + "</section>".length);
  const rows = [...sheet.matchAll(/<li>(.*?)<\/li>/g)].map((m) => m[1]);
  return { html, line, sheet, rows };
}
/** The printed address, one <p> a line, in order. */
const printed = (line: string) => [...line.matchAll(/<p class="text-sm text-slate-900">(.*?)<\/p>/g)].map((m) => decode(m[1]));
const amber = (part: string) => [...part.matchAll(/<p class="[^"]*bg-amber-50[^"]*">(.*?)<\/p>/g)].map((m) => decode(m[1]));
/** The amber line under an address short of its town, on an estimate with no job (the catalog's own words). */
const NO_TOWN = qt.en.qt_siteNoTown;

describe("a customer's estimate with no address of its own", () => {
  const { line, sheet, rows } = draw({ records: { customer: cust }, otherJobs });

  it("says the address the paper prints, and that it comes from the customer", () => {
    expect(text(line)).toContain("Job Site");
    expect(printed(line)).toEqual(["12 Thistlewood Way", "Testville, CA 96161"]);
    expect(text(line)).toContain("From the customer");
    expect(amber(line)).toEqual([]);
  });

  it("offers Change Job Site: a 44px door, Title Case, and nothing about a job", () => {
    expect(line).toMatch(/<button type="button" class="[^"]*min-h-11[^"]*"><svg[^>]*>.*?<\/svg> Change Job Site<\/button>/);
    expect(line).not.toContain("Open the Job");
    expect(decode(line)).not.toContain("Use the Job's Address");
  });

  it("the sheet is shut until that door is tapped, and is named for it", () => {
    expect(sheet).toContain('data-open="false"');
    expect(sheet).toContain("<h2>Change Job Site</h2>");
    expect(text(sheet)).toContain("The estimate prints this as its job site, and a job made from it starts at this address.");
  });

  it("the rows: the customer's own address first and marked in use, then each other job's address with its unit, newest first", () => {
    expect(rows.map(text)).toEqual([
      "Use the Customer's Address 12 Thistlewood Way, Testville, CA 96161 In Use",
      "40 Snowbell Court, Unit 14, Testville, CA 96161 From J-031 · 40 Snowbell #14",
      "9 Bayberry Lane, Testville, CA 96161 From J-020 · 9 Bayberry",
    ]);
    // One tap picks: every row is one 44px button. The one in use says so to a screen reader too.
    for (const row of rows) expect(row).toMatch(/^<button type="button"[^>]*class="[^"]*min-h-11[^"]*"/);
    expect(rows.map((r) => r.includes('aria-current="true"'))).toEqual([true, false, false]);
  });

  it("then A Different Address: the app's own address box, a Unit box, and Use This Address (off until something is changed)", () => {
    expect(text(sheet)).toContain("A Different Address");
    expect(sheet).toMatch(/<label[^>]*for="js-address"[^>]*>Address<\/label>/);
    // RE-PINNED (the owner, 2026-11-10, about a unit in a complex: "it auto-populated to both positions
    // with no other way to pick the site ... nor input a unit number other than the title"). The street
    // box used to open BLANK here (value=""), so adding a unit to the customer's address meant typing the
    // street again. It opens with the address the paper prints now, its town on the grey line; the Unit
    // box is empty and waiting.
    expect(sheet).toMatch(/<input[^>]*id="js-address"[^>]*placeholder="Job address"[^>]*value="12 Thistlewood Way"/);
    expect(sheet).toContain('<p class="mt-1 text-xs text-slate-500">Testville, CA 96161</p>');
    expect(text(sheet)).toContain("Unit / Apt (optional)");
    expect(sheet).toMatch(/<input[^>]*id="js-unit"[^>]*placeholder="e\.g\. 224, Apt B"[^>]*maxLength="24"[^>]*value=""/);
    // Nothing is copied without a change: with the boxes as they opened there is nothing to save.
    expect(sheet).toMatch(/<button data-save="" disabled="">Use This Address<\/button>/);
  });
});

describe("the boxes open with the address the paper prints now, whoever's it is", () => {
  const street = (sheet: string) => sheet.match(/<input[^>]*id="js-address"[^>]*value="([^"]*)"/)?.[1];
  const unit = (sheet: string) => sheet.match(/<input[^>]*id="js-unit"[^>]*value="([^"]*)"/)?.[1];
  const town = (sheet: string) => sheet.match(/<p class="mt-1 text-xs text-slate-500">([^<]*)<\/p>/)?.[1] ?? null;

  it("the lead's address when the estimate follows its lead (it outranks the customer's), with its unit", () => {
    const { sheet } = draw({ records: { lead: { ...lead, unit: "11" }, customer: cust } });
    expect([street(sheet), unit(sheet), town(sheet)]).toEqual(["16 Larkspur Circle", "11", "Testville, CA 96161"]);
    expect(sheet).toMatch(/<button data-save="" disabled="">Use This Address<\/button>/);
  });

  it("its own when it has one, never the record it would fall back to", () => {
    const { sheet } = draw({ records: { quote: ownSite, lead, customer: cust } });
    expect([street(sheet), unit(sheet), town(sheet)]).toEqual(["40 Snowbell Court", "14", "Testville, CA 96161"]);
  });

  it("a street with no town opens as it is: no town line, and none borrowed from the customer", () => {
    const { sheet } = draw({ records: { lead: { address: "16 larkspur circle Testville" }, customer: cust } });
    expect([street(sheet), unit(sheet), town(sheet)]).toEqual(["16 larkspur circle Testville", "", null]);
  });

  it("no address anywhere: the boxes are blank, as they have to be", () => {
    const { sheet } = draw({ records: { lead: { address: null }, customer: { address: "  " } } });
    expect([street(sheet), unit(sheet), town(sheet)]).toEqual(["", "", null]);
  });
});

describe("an estimate that carries its own job site", () => {
  const { line, sheet, rows } = draw({ records: { quote: ownSite, customer: cust }, otherJobs });

  it("prints its own, the unit on its own line under the street, and says it is set on this estimate", () => {
    expect(printed(line)).toEqual(["40 Snowbell Court", "Unit 14", "Testville, CA 96161"]);
    expect(text(line)).toContain("Set on this estimate");
    expect(text(line)).not.toContain("From the customer");
    expect(amber(line)).toEqual([]);
  });

  it("the row with that address is the one in use; the customer's row is the way back", () => {
    expect(rows.map((r) => r.includes('aria-current="true"'))).toEqual([false, true, false]);
    expect(text(rows[0])).toBe("Use the Customer's Address 12 Thistlewood Way, Testville, CA 96161");
    expect(text(rows[1])).toBe("40 Snowbell Court, Unit 14, Testville, CA 96161 From J-031 · 40 Snowbell #14 In Use");
  });

  it("the typed boxes start from the estimate's own address (he is correcting it), with its town on the grey line", () => {
    expect(sheet).toMatch(/<input[^>]*id="js-address"[^>]*value="40 Snowbell Court"/);
    expect(sheet).toMatch(/<input[^>]*id="js-unit"[^>]*value="14"/);
    expect(sheet).toContain('<p class="mt-1 text-xs text-slate-500">Testville, CA 96161</p>');
    // Nothing has changed yet, so there is nothing to save.
    expect(sheet).toMatch(/<button data-save="" disabled="">Use This Address<\/button>/);
  });

  it("an address typed by hand matches no row: none is marked", () => {
    const typed = draw({ records: { quote: { address: "3 Catbird Road", unit: null, city: "Testville", state: "CA", zip: "96161" }, customer: cust }, otherJobs });
    expect(typed.rows.some((r) => r.includes("aria-current"))).toBe(false);
    expect(text(typed.sheet)).not.toContain("In Use");
    expect(printed(typed.line)).toEqual(["3 Catbird Road", "Testville, CA 96161"]);
  });
});

describe("an estimate that is already on a job", () => {
  it("shows the job's site, from the job, with a door to the job and NO way to change it here", () => {
    const { line, sheet, rows } = draw({ records: { job: jobSite, customer: cust }, job: theJob, otherJobs });
    expect(printed(line)).toEqual(["9 Bayberry Lane", "Testville, CA 96161"]);
    expect(text(line)).toContain("From the job");
    expect(line).toMatch(/<a class="[^"]*min-h-11[^"]*" href="\/jobs\/j1">Open the Job<\/a>/);
    expect(line).not.toContain("Change Job Site");
    expect(decode(line)).not.toContain("Use the Job's Address");
    expect(amber(line)).toEqual([]);
    // No picker: the sheet stays shut and holds no rows, even when other jobs were handed in.
    expect(sheet).toContain('data-open="false"');
    expect(rows).toEqual([]);
  });

  it("carrying its own address that is still the job's: nothing to say, nothing to do", () => {
    const { line } = draw({ records: { quote: ownSite, job: { ...ownSite }, customer: cust }, job: theJob });
    expect(printed(line)).toEqual(["40 Snowbell Court", "Unit 14", "Testville, CA 96161"]);
    expect(text(line)).toContain("Set on this estimate");
    expect(amber(line)).toEqual([]);
    expect(decode(line)).not.toContain("Use the Job's Address");
    expect(line).toContain("Open the Job");
  });

  it("carrying its own address after the job's was changed: it says both, in amber, and offers the one way back", () => {
    const { line } = draw({ records: { quote: ownSite, job: jobSite, customer: cust }, job: theJob });
    // What the paper prints is still the estimate's own: the line never pretends otherwise.
    expect(printed(line)).toEqual(["40 Snowbell Court", "Unit 14", "Testville, CA 96161"]);
    expect(amber(line)).toEqual(["This estimate prints its own address. The job's is 9 Bayberry Lane, Testville, CA 96161."]);
    // 44px, like every door on the line (the Button's own default height).
    expect(decode(line)).toMatch(/<button class="[^"]*\bh-11\b[^"]*">Use the Job's Address<\/button>/);
    expect(line).not.toContain("Change Job Site");
  });

  it("a job with no address anywhere: said in amber, and the door is the job", () => {
    const { line } = draw({ records: { job: { address: null } }, job: theJob });
    expect(amber(line)).toEqual(["No job site yet. This estimate prints without one."]);
    expect(line).toContain('href="/jobs/j1"');
    expect(line).not.toContain("Change Job Site");
  });
});

describe("an estimate made out to a lead (the address used to be drawn on the customer card)", () => {
  it("says the lead's address, the job site it prints until it has its own or a job", () => {
    const { line, rows } = draw({ records: { lead } });
    expect(printed(line)).toEqual(["16 Larkspur Circle", "Testville, CA 96161"]);
    expect(text(line)).toContain("From the lead");
    // With no customer there are no other jobs to list: the lead's row, in use.
    expect(rows.map(text)).toEqual(["Use the Lead's Address 16 Larkspur Circle, Testville, CA 96161 In Use"]);
  });

  it("a unit rides on its own line", () => {
    expect(printed(draw({ records: { lead: { ...lead, unit: "11" } } }).line)).toEqual(["16 Larkspur Circle", "Unit 11", "Testville, CA 96161"]);
  });

  it("a street typed with no town shows as typed, and the hole is said in amber", () => {
    const { line } = draw({ records: { lead: { address: "16 larkspur circle Testville", unit: null, city: null, state: null, zip: null } } });
    expect(printed(line)).toEqual(["16 larkspur circle Testville"]);
    // RE-PINNED: it said "No town on this address. The paper prints it without a city, state or zip.",
    // which is not true of an address with part of its town (the paper prints the part there is), and
    // named nothing to do. It says what is true and the ONE action: this sheet's suggestions.
    expect(amber(line)).toEqual([NO_TOWN]);
    expect(text(line)).toContain("From the lead");
  });

  it("a lead AND a customer: the lead's address prints (it outranks the customer's), and the customer's is a row to copy", () => {
    const { line, rows } = draw({ records: { lead, customer: cust }, otherJobs });
    expect(text(line)).toContain("From the lead");
    expect(rows.map(text)).toEqual([
      "Use the Lead's Address 16 Larkspur Circle, Testville, CA 96161 In Use",
      "12 Thistlewood Way, Testville, CA 96161 The Customer's Address",
      "40 Snowbell Court, Unit 14, Testville, CA 96161 From J-031 · 40 Snowbell #14",
      "9 Bayberry Lane, Testville, CA 96161 From J-020 · 9 Bayberry",
    ]);
  });
});

describe("no job site at all, and no town", () => {
  it("nothing anywhere: said in amber, in words, with the door to set one", () => {
    const { line, sheet, rows } = draw({ records: { lead: { address: null }, customer: { address: "  " } } });
    expect(amber(line)).toEqual(["No job site yet. This estimate prints without one."]);
    expect(printed(line)).toEqual([]);
    expect(line).not.toContain("lucide-map-pin");
    expect(line).toContain("Change Job Site");
    // Nothing on file to tap: the sheet is the address box alone.
    expect(rows).toEqual([]);
    expect(sheet).toContain('id="js-address"');
  });

  it("a street with no town is amber wherever it comes from; a line that carries its own town is not", () => {
    expect(amber(draw({ records: { quote: { address: "40 Snowbell Court", unit: "14" } } }).line)).toEqual([NO_TOWN]);
    expect(amber(draw({ records: { customer: { address: "12 Thistlewood Way" } } }).line)).toEqual([NO_TOWN]);
    expect(amber(draw({ records: { customer: { address: "12 Thistlewood Way, Testville, CA 96161" } } }).line)).toEqual([]);
  });

  it("PART of a town is missing too, and the sentence is true of it: a city with no zip, a zip with no state", () => {
    // The paper prints "Testville" under this street, so "prints it without a city" was false here.
    const cityOnly = draw({ records: { customer: { address: "12 Thistlewood Way", city: "Testville" } } });
    expect(printed(cityOnly.line)).toEqual(["12 Thistlewood Way", "Testville"]);
    expect(amber(cityOnly.line)).toEqual([NO_TOWN]);
    expect(amber(draw({ records: { lead: { address: "16 Larkspur Circle", city: "Testville", zip: "96161" } } }).line)).toEqual([NO_TOWN]);
    expect(NO_TOWN).toBe("Part of this address's town is missing (city, state or zip). Change Job Site and pick a suggestion to fill it in.");
  });

  it("ON A JOB the one action is the job: the sheet is not offered there, so the sentence never points at it", () => {
    const onJob = draw({ records: { job: { address: "9 Bayberry Lane", city: "Testville" }, customer: cust }, job: theJob });
    expect(amber(onJob.line)).toEqual(["Part of this address's town is missing (city, state or zip). Fix the address on the job."]);
    expect(onJob.line).not.toContain("Change Job Site");
    expect(onJob.line).toContain('href="/jobs/j1"');
    // Its own short address on a job: the same one action (the job owns the site).
    const ownOnJob = draw({ records: { quote: { address: "40 Snowbell Court", unit: "14" }, job: { address: "40 Snowbell Court", unit: "14" } }, job: theJob });
    expect(amber(ownOnJob.line)).toEqual(["Part of this address's town is missing (city, state or zip). Fix the address on the job."]);
    // And with no job the sentence names the door that IS on the line.
    const noJob = draw({ records: { customer: { address: "12 Thistlewood Way" } } });
    expect(amber(noJob.line)).toEqual([NO_TOWN]);
    expect(noJob.line).toContain("Change Job Site");
  });
});

describe("a short list says it is short", () => {
  const SHORT = "Showing this customer's most recent addresses. Type any other one below.";
  const quiet = (sheet: string) => [...sheet.matchAll(/<p class="text-xs text-slate-500">([^<]*)<\/p>/g)].map((m) => decode(m[1]));
  const job = (i: number) => ({ id: `c${i}`, job_number: `J-${100 + i}`, name: `Catbird ${i}`, address: `${i + 1} Catbird Road`, unit: null, city: "Testville", state: "CA", zip: "96161" });
  const jobs = (n: number) => Array.from({ length: n }, (_, i) => job(i));

  it("says nothing when every address read has its row", () => {
    expect(quiet(draw({ records: { customer: cust }, otherJobs }).sheet)).toEqual([]);
    expect(quiet(draw({ records: { customer: cust }, otherJobs: jobs(8) }).sheet)).toEqual([]);
    expect(quiet(draw({ records: { customer: cust } }).sheet)).toEqual([]);
  });

  it("the picker's cap left an address out: one quiet line under the rows, pointing at the boxes below", () => {
    const { sheet, rows } = draw({ records: { customer: cust }, otherJobs: jobs(9) });
    expect(rows).toHaveLength(1 + 8);
    expect(quiet(sheet)).toEqual([SHORT]);
    // Under the rows and over A Different Address: where the eye is when the address is not in the list.
    expect(sheet.indexOf(SHORT.slice(0, 20))).toBeGreaterThan(sheet.lastIndexOf("</li>"));
    expect(sheet.indexOf(SHORT.slice(0, 20))).toBeLessThan(sheet.indexOf("A Different Address"));
    // Quiet: not amber, not an alert. It is a fact about the list, not a failure.
    expect(amber(sheet)).toEqual([]);
    expect(sheet).not.toMatch(/role="alert"/);
  });

  it("the page's read came back full: the same line, even when the rows it made are few", () => {
    const { sheet, rows } = draw({ records: { customer: cust }, otherJobs, otherJobsFull: true });
    expect(rows).toHaveLength(3);
    expect(quiet(sheet)).toEqual([SHORT]);
  });

  it("never on a job (there is no list there), and never beside a read that FAILED (that has its own sentence)", () => {
    const onJob = draw({ records: { job: jobSite, customer: cust }, job: theJob, otherJobs: jobs(12), otherJobsFull: true });
    expect(quiet(onJob.sheet)).toEqual([]);
    const failed = draw({ records: { customer: cust }, otherJobs: [], otherJobsFailed: true });
    expect(quiet(failed.sheet)).toEqual([]);
    expect(amber(failed.sheet)).toHaveLength(1);
  });

  it("in Spanish", () => {
    expect(quiet(draw({ records: { customer: cust }, otherJobs: jobs(9) }, "es").sheet)).toEqual(["Se muestran las direcciones más recientes de este cliente. Escribe cualquier otra abajo."]);
  });
});

describe("the customer's earlier jobs could not be read", () => {
  it("is SAID in the picker, never shown as no other addresses", () => {
    const { sheet, rows, line } = draw({ records: { customer: cust }, otherJobs: [], otherJobsFailed: true });
    expect(amber(sheet)).toEqual(["The addresses from this customer's earlier jobs could not be loaded. Reload the page to see them."]);
    // What could be read is still offered.
    expect(rows.map(text)).toEqual(["Use the Customer's Address 12 Thistlewood Way, Testville, CA 96161 In Use"]);
    // The line itself is fine: the address it prints did not depend on that read.
    expect(amber(line)).toEqual([]);
  });

  it("is not said when the read went through, with or without other jobs", () => {
    expect(amber(draw({ records: { customer: cust }, otherJobs }).sheet)).toEqual([]);
    expect(amber(draw({ records: { customer: cust } }).sheet)).toEqual([]);
  });
});

describe("in Spanish", () => {
  it("the line and the sheet read the catalog's Spanish, the doors Title Case, and the address stays the paper's", () => {
    const { line, sheet, rows } = draw({ records: { customer: cust }, otherJobs }, "es");
    expect(text(line)).toContain("Sitio de Trabajo");
    expect(text(line)).toContain("Del cliente");
    expect(line).toMatch(/<\/svg> Cambiar el Sitio de Trabajo<\/button>/);
    expect(sheet).toContain("<h2>Cambiar el Sitio de Trabajo</h2>");
    expect(rows.map(text)).toEqual([
      "Usar la Dirección del Cliente 12 Thistlewood Way, Testville, CA 96161 En Uso",
      // What the PAPER prints: the estimate is English paper, so "Unit 14" stays.
      "40 Snowbell Court, Unit 14, Testville, CA 96161 De J-031 · 40 Snowbell #14",
      "9 Bayberry Lane, Testville, CA 96161 De J-020 · 9 Bayberry",
    ]);
    const words = text(sheet);
    expect(words).toContain("Otra Dirección");
    expect(words).toContain("Unidad / Depto (opcional)");
    expect(sheet).toMatch(/<label[^>]*for="js-address"[^>]*>Dirección<\/label>/);
    expect(sheet).toContain('placeholder="Dirección del trabajo"');
    expect(sheet).toContain('placeholder="ej. 224, Depto B"');
    expect(sheet).toContain(">Usar Esta Dirección</button>");
    for (const english of ["Job Site", "Change Job Site", "Use the", "In Use", "A Different Address", "From ", "Unit / Apt", "Use This Address"]) expect(text(line + sheet).replace(/Unit 14/g, ""), english).not.toContain(english);
  });

  it("the amber sentences, the lead's and the job's words", () => {
    expect(amber(draw({}, "es").line)).toEqual(["Aún no hay sitio de trabajo. Este presupuesto se imprime sin uno."]);
    // Re-pinned with the English: what is true (part of the town is missing), and the one action, by where it can be fixed.
    expect(amber(draw({ records: { lead: { address: "16 larkspur circle" } } }, "es").line)).toEqual([
      "A esta dirección le falta parte de la ciudad (ciudad, estado o código postal). Usa Cambiar el Sitio de Trabajo y elige una sugerencia para completarla.",
    ]);
    expect(amber(draw({ records: { job: { address: "9 Bayberry Lane" } }, job: theJob }, "es").line)).toEqual([
      "A esta dirección le falta parte de la ciudad (ciudad, estado o código postal). Corrige la dirección en el trabajo.",
    ]);
    const led = draw({ records: { lead, customer: cust } }, "es");
    expect(text(led.line)).toContain("Del prospecto");
    expect(led.rows.map(text)).toEqual(["Usar la Dirección del Prospecto 16 Larkspur Circle, Testville, CA 96161 En Uso", "12 Thistlewood Way, Testville, CA 96161 La Dirección del Cliente"]);
    const onJob = draw({ records: { quote: ownSite, job: jobSite }, job: theJob }, "es");
    expect(text(onJob.line)).toContain("Fijado en este presupuesto");
    expect(amber(onJob.line)).toEqual(["Este presupuesto imprime su propia dirección. La del trabajo es 9 Bayberry Lane, Testville, CA 96161."]);
    expect(onJob.line).toContain(">Usar la Dirección del Trabajo</button>");
    expect(onJob.line).toContain(">Abrir el Trabajo</a>");
    expect(text(draw({ records: { job: jobSite }, job: theJob }, "es").line)).toContain("Del trabajo");
    expect(amber(draw({ records: { customer: cust }, otherJobsFailed: true }, "es").sheet)).toEqual([
      "No se pudieron cargar las direcciones de los trabajos anteriores de este cliente. Recarga la página para verlas.",
    ]);
  });

  it("English is the default: no provider and the 'en' provider draw the same bytes", () => {
    expect(draw({ records: { customer: cust }, otherJobs }, "en").html).toBe(draw({ records: { customer: cust }, otherJobs }).html);
  });
});

describe("what a render cannot do, pinned at the source", () => {
  const src = readFileSync(join(__dirname, "job-site-line.tsx"), "utf8");
  const editor = readFileSync(join(__dirname, "../estimate-editor.tsx"), "utf8");
  const page = readFileSync(join(__dirname, "page.tsx"), "utf8");

  it("ONE write door: a row, the typed address and the job's all save through the one tested rule", () => {
    expect(src).toContain('const res = await commitQuoteSite(quoteId, site, { setQuoteSite, fallbackError: t("qt_couldntSave") });');
    expect(src.split("commitQuoteSite(").length - 1).toBe(1);
    expect(src.split("setQuoteSite").length - 1).toBe(2); // its import, and the one call above
    // A row writes what the rule says it writes (null for the row it follows); the row in use writes nothing.
    expect(src).toMatch(/if \(choice\.key === inUse\) \{\s*closeSheet\(\);\s*return;\s*\}\s*save\(siteWriteFor\(choice\)\);/);
    expect(src).toContain("save(siteBoxesWrite(boxes));");
    // Use the Job's Address clears the estimate's own.
    expect(src).toMatch(/<Button variant="outline" onClick=\{\(\) => save\(null\)\} disabled=\{pending\}>\s*\{t\("qt_btn_useJobAddress"\)\}/);
  });

  it("Saving, then Saved or the server's sentence: a refusal keeps the sheet open, a save closes it", () => {
    const save = src.slice(src.indexOf("function save("), src.indexOf("function openSheet("));
    // Re-pinned: one statement stands between the refusal and the close now, the write being remembered
    // (the next case). A refusal still returns before it; a save still closes, says Saved and asks the page to read again.
    expect(save).toMatch(/if \(!res\.ok\) \{\s*setError\(res\.error \?\? t\("qt_couldntSave"\)\);\s*return;\s*\}\s*(?:\/\/[^\n]*\n\s*)*setWritten\(siteWritten\(atTheTap, site\)\);\s*setOpen\(false\);\s*setSaved\(true\);\s*router\.refresh\(\);/);
    // While the write is out the sheet cannot be closed out from under its answer, and it says Saving.
    expect(src).toContain("holdOpen={pending}");
    expect(src).toContain("saving={pending}");
    expect(src).toMatch(/\{pending && \(\s*<p role="status"[^>]*>\s*\{t\("qt_btn_saving"\)\}/);
    expect(src).toMatch(/\{saved && \(\s*<span role="status"[^>]*>\s*\{t\("qt_btn_saved"\)\}/);
    // The refusal is drawn in the sheet, and on the line when there is no sheet for it to land in
    // (Use the Job's Address has none; Back can close the sheet on a write that is still out).
    expect(src).toMatch(/\{error && \(\s*<p role="alert"/);
    expect(src).toMatch(/\{error && !open && \(\s*<p role="alert"/);
  });

  it("THE LINE AND THE SHEET READ WHAT WAS JUST SAVED: the write is remembered with state, read in the records' place, and forgotten once the page's read moves on", () => {
    // Until the page's own read lands the props are the OLD address: the line said Saved beside it, and
    // the sheet opened again in that moment started from it. The rule is lib/quote-site's (siteWritten,
    // siteWrittenStands, quoteSiteRecordsNow: table-tested there); this is only its wiring.
    expect(src).toContain("const [written, setWritten] = useState<SiteWritten | null>(null);");
    const save = src.slice(src.indexOf("function save("), src.indexOf("function openSheet("));
    // Held against the page's own address AT THE TAP, taken before the write goes out…
    expect(save.indexOf("const atTheTap = records.quote;")).toBeGreaterThan(-1);
    expect(save.indexOf("const atTheTap = records.quote;")).toBeLessThan(save.indexOf("start(async () => {"));
    // …and remembered only when the save landed: a refusal returns first.
    expect(save.indexOf("setWritten(")).toBeGreaterThan(save.indexOf("return;"));
    expect(src.split("setWritten(").length - 1).toBe(2); // the save, and the forgetting below
    // ONE set of records for everything the line draws: the address, the row in use, how the boxes open.
    expect(src).toContain("const now = quoteSiteRecordsNow(records, written);");
    expect(src).toContain("const view = quoteSiteView(now);");
    expect(src).toContain("const inUse = siteChoiceInUse(choices, now.quote);");
    expect(src).toContain("const boxesStart = siteBoxesFrom(now);");
    // Nothing below the hooks still reads the page's own address directly, except the save's "at the tap".
    const body = src.slice(src.indexOf("const now = quoteSiteRecordsNow("));
    expect(body.split("records.quote").length - 1).toBe(1);
    // FORGOTTEN, not just passed over: a later read that landed back on the old address must not revive it.
    expect(src).toMatch(/useEffect\(\(\) => \{\s*if \(written && !siteWrittenStands\(records\.quote, written\)\) setWritten\(null\);\s*\}, \[records\.quote, written\]\);/);
  });

  it("Cancel changes nothing and leaves nothing behind: every way out is the one closeSheet, which writes nothing", () => {
    const close = src.slice(src.indexOf("function closeSheet("), src.indexOf("function pick("));
    // Shut, and the refusal read in the sheet goes with it: it must not turn up on the line as news.
    expect(close).toMatch(/function closeSheet\(\) \{\s*setOpen\(false\);\s*setError\(null\);\s*\}/);
    expect(close).not.toMatch(/save\(|start\(|commitQuoteSite|setBoxes|router\./);
    // Cancel, the X, a tap outside, Escape and Back all go through it.
    expect(src).toContain("<ModalActions onCancel={closeSheet} onSave={saveTyped}");
    expect(src).toContain("onClose={closeSheet}");
    // Outside closeSheet the sheet is shut in one place only: a save that landed.
    expect(src.split("setOpen(false)").length - 1).toBe(2);
    // What was typed and walked away from is gone the next time the sheet opens: the boxes go back to how
    // they open, which is the address the paper prints now (lib/quote-site siteBoxesFrom).
    expect(src).toMatch(/function openSheet\(\) \{\s*setBoxes\(boxesStart\);\s*setError\(null\);\s*setSaved\(false\);\s*setOpen\(true\);\s*\}/);
    expect(src).toContain("useState<SiteBoxes>(() => siteBoxesFrom(records));");
  });

  it("THE SHEET IS NEVER REMOUNTED: no key on the Modal, on anything around it, or on the address box inside it", () => {
    expect(src).not.toMatch(/<Modal[^>]*\skey=/);
    expect(src).not.toMatch(/<AddressAutocomplete[^>]*\skey=/);
    // The only keys in the file are a list's own: the printed lines and the rows.
    expect([...src.matchAll(/\skey=\{([^}]+)\}/g)].map((m) => m[1])).toEqual(["i", "choice.key"]);
    // An estimate that gains a job while the sheet is open shuts it; it is not unmounted.
    expect(src).toContain("open={open && !job}");
  });

  it("the address box is the app's own, used as New Job and Edit Job use it: a pick fills the street, city, state and zip", () => {
    expect(src).toContain('import { AddressAutocomplete } from "@/components/address-autocomplete";');
    const box = src.slice(src.indexOf("<AddressAutocomplete"), src.indexOf("/>", src.indexOf("<AddressAutocomplete")));
    expect(box).toMatch(/\bstreetOnly\b/);
    expect(box).toContain("onTextChange={(v) => setBoxes((b) => siteBoxesTyped(b, v))}");
    expect(box).toContain("onResolved={(p) => setBoxes((b) => siteBoxesPicked(b, p))}");
  });

  it("the one estimate editor draws the line directly under the customer card's own contents, on a saved estimate only", () => {
    expect(editor).toContain('import { JobSiteLine, type JobSiteData } from "./[id]/job-site-line";');
    expect(editor).toMatch(
      /\{savedPage && savedId && \(\s*<Card className="mb-6">\s*<CardContent className="py-5">\s*<CustomerSelect quoteId=\{savedId\} customer=\{savedPage\.customer\} lead=\{savedPage\.lead\} customers=\{savedPage\.customers\} \/>\s*\{\/\*[\s\S]*?\*\/\}\s*<div className="mt-4 border-t border-slate-100 pt-4">\s*<JobSiteLine quoteId=\{savedId\} \{\.\.\.savedPage\.site\} \/>\s*<\/div>\s*<\/CardContent>\s*<\/Card>\s*\)\}/,
    );
    expect(editor.split("<JobSiteLine").length - 1).toBe(1);
  });

  it("the estimate's page reads what the line needs: the job's five columns, and the customer's other jobs newest first", () => {
    expect(page).toContain("jobs(id, job_number, name, address, unit, city, state, zip)");
    const read = page.slice(page.indexOf("q.customer_id && !q.job_id"), page.indexOf("]);", page.indexOf("q.customer_id && !q.job_id")));
    // Re-pinned: the limit is lib/quote-site's own number (it was a bare 30), so "did the read come back full?" is
    // asked of the same number the read was cut at.
    expect(read).toMatch(/\.from\("jobs"\)\s*\.select\("id, job_number, name, address, unit, city, state, zip"\)\s*\.eq\("customer_id", q\.customer_id\)\s*\.not\("address", "is", null\)\s*\.order\("created_at", \{ ascending: false \}\)\s*\.limit\(SITE_JOBS_READ_LIMIT\)/);
    // No customer, or already on a job: there is no picker to fill, so nothing is asked.
    expect(read).toContain(": Promise.resolve({ data: null, error: null }),");
    // A failed read is filed and SAID; it never becomes an empty list that reads as "none".
    expect(page).toContain('if (otherJobsErr) reportError("quotes/[id]:otherJobs", otherJobsErr, { quoteId: id });');
    expect(page).toContain("otherJobsFailed: !!otherJobsErr,");
    // A read that came back FULL is said too (the picker's quiet line): older jobs may hold another address.
    expect(page).toContain("otherJobsFull: siteJobsReadFull(otherJobs),");
    expect(page).toContain("job: q.job_id ? { id: q.job_id, job_number: q.jobs?.job_number ?? null, name: q.jobs?.name ?? null } : null,");
  });

  it("every word on it is the catalog's, in both languages, and the retired lead-address sentence is gone from both", () => {
    const keys = [...new Set([...src.matchAll(/"((?:qt|ag)_[A-Za-z_]+)"/g)].map((m) => m[1]))];
    expect(keys.length).toBeGreaterThanOrEqual(20);
    const mine = keys.filter((k) => k.startsWith("qt_"));
    for (const k of mine) {
      expect(qt.en[k], k).toBeTruthy();
      expect(qt.es[k], k).toBeTruthy();
    }
    // The Unit box and the door to the job are New Job's and the agenda's own words, read from their catalog.
    expect(keys.filter((k) => k.startsWith("ag_")).sort()).toEqual(["ag_btn_openTheJob", "ag_rail_optional", "ag_rail_unitApt", "ag_rail_unitExample"]);
    expect(qt.en).not.toHaveProperty("qt_leadNoAddress");
    expect(qt.es).not.toHaveProperty("qt_leadNoAddress");
    expect(qt.files).toContain("src/app/(app)/quotes/[id]/job-site-line.tsx");
  });
});
