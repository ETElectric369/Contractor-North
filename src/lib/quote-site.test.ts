import { describe, it, expect, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { pickSite, siteLines, type SiteParts } from "./site-address";
import {
  QUOTE_SITE_CAPS,
  SITE_CHOICE_JOBS_CAP,
  SITE_JOBS_READ_LIMIT,
  cleanQuoteSite,
  commitQuoteSite,
  quoteSiteCandidates,
  quoteSiteChoices,
  quoteSiteRecordsNow,
  quoteSiteView,
  siteBoxesDiffer,
  siteBoxesFrom,
  siteBoxesPicked,
  siteBoxesReady,
  siteBoxesTyped,
  siteBoxesWrite,
  siteChoiceInUse,
  siteChoicesShort,
  siteJobsReadFull,
  siteKey,
  siteOneLine,
  sitePartsOf,
  siteWriteFor,
  siteWritten,
  siteWrittenStands,
  type OtherJobSite,
  type QuoteSiteRecords,
  type SiteBoxes,
  type SiteWritten,
} from "./quote-site";

/**
 * THE ESTIMATE'S JOB SITE, AS A RULE (cn-v1158). The owner, 2026-11-10, pricing a unit for a customer
 * that owns two complexes at two addresses: "we need to have sites available to pick from on the
 * estimate sheet". This is the rule with no screen and no database: which address an estimate prints
 * (one ordered list, read by the print page AND the estimate's page), what the picker offers, what a
 * tap writes, and what the server takes as a typed site. Every name and street here is invented.
 */
const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

const own: SiteParts = { address: "40 Snowbell Court", unit: "14", city: "Testville", state: "CA", zip: "96161" };
const jobSite: SiteParts = { address: "9 Bayberry Lane", unit: null, city: "Testville", state: "CA", zip: "96161" };
const leadSite: SiteParts = { address: "16 Larkspur Circle", unit: null, city: "Testville", state: "CA", zip: "96161" };
const custSite: SiteParts = { address: "12 Thistlewood Way", unit: null, city: "Testville", state: "CA", zip: "96161" };

describe("quoteSiteCandidates: the one ordered list", () => {
  it("the estimate's own, then the job's, the lead's, the customer's", () => {
    const list = quoteSiteCandidates({ quote: own, job: jobSite, lead: leadSite, customer: custSite });
    expect(list.map((c) => c.source)).toEqual(["quote", "job", "lead", "customer"]);
    // Each record is handed on untouched: the very object, never a copy or a tidied one.
    expect(list[0].parts).toBe(own);
    expect(list[1].parts).toBe(jobSite);
    expect(list[2].parts).toBe(leadSite);
    expect(list[3].parts).toBe(custSite);
  });

  it.each([
    ["all four", { quote: own, job: jobSite, lead: leadSite, customer: custSite }, "quote"],
    ["no own address", { quote: { address: null }, job: jobSite, lead: leadSite, customer: custSite }, "job"],
    ["a blank own address is no address", { quote: { address: "   " }, job: null, lead: leadSite, customer: custSite }, "lead"],
    ["only the customer", { quote: null, job: null, lead: null, customer: custSite }, "customer"],
    ["a lead with no street falls to the customer", { lead: { address: "", city: "Testville" }, customer: custSite }, "customer"],
  ] as const)("%s → %s", (_name, records, source) => {
    expect(pickSite(quoteSiteCandidates(records))?.source).toBe(source);
  });

  it("nothing anywhere is no site", () => {
    expect(pickSite(quoteSiteCandidates({}))).toBeNull();
    expect(pickSite(quoteSiteCandidates({ quote: null, job: null, lead: null, customer: null }))).toBeNull();
  });

  it("THE PRINT PAGE DID NOT CHANGE BY A BYTE: the list it used to write inline picks the same site, row for row", () => {
    // The print page hands in the WHOLE estimate row and its three embeds exactly as it read them,
    // extra columns and all. This is its old inline list, kept here as the witness.
    const inline = (q: Record<string, unknown>) =>
      pickSite([
        { source: "quote", parts: q as never },
        { source: "job", parts: (q as { jobs?: never }).jobs },
        { source: "lead", parts: (q as { inquiries?: never }).inquiries },
        { source: "customer", parts: (q as { customers?: never }).customers },
      ]);
    const shared = (q: Record<string, unknown>) =>
      pickSite(
        quoteSiteCandidates({
          quote: q as never,
          job: (q as { jobs?: never }).jobs,
          lead: (q as { inquiries?: never }).inquiries,
          customer: (q as { customers?: never }).customers,
        }),
      );
    const person = { name: "Dana Rook", company_name: null, email: null, phone: "(530) 555-0100" };
    const rows: Record<string, unknown>[] = [
      { id: "q1", quote_number: "E-040", title: "Unit 14 panel", ...own, jobs: jobSite, inquiries: { ...person, ...leadSite }, customers: { ...person, ...custSite } },
      { id: "q2", quote_number: "E-041", address: null, unit: null, city: null, state: null, zip: null, jobs: jobSite, inquiries: null, customers: { ...person, ...custSite } },
      { id: "q3", quote_number: "E-042", address: "", jobs: null, inquiries: { ...person, ...leadSite }, customers: { ...person, ...custSite } },
      { id: "q4", quote_number: "E-043", address: null, jobs: null, inquiries: null, customers: { ...person, ...custSite } },
      { id: "q5", quote_number: "E-044", address: null, jobs: null, inquiries: null, customers: null },
      { id: "q6", quote_number: "E-045", address: null, jobs: { address: null }, inquiries: { ...person, address: "16 larkspur circle Testville", city: null, state: null, zip: null }, customers: { ...person, address: null } },
      { id: "q7", quote_number: "E-046", address: "  40 Snowbell Court  ", unit: " 14 ", city: "", state: "", zip: "", jobs: null, inquiries: null, customers: null },
      // An embed that arrived as a list (a to-many read by mistake) has no address of its own: skipped by both.
      { id: "q8", quote_number: "E-047", address: null, jobs: [jobSite], inquiries: null, customers: { ...person, ...custSite } },
    ];
    for (const q of rows) {
      expect(shared(q), String(q.id)).toEqual(inline(q));
      expect(siteLines(shared(q)), String(q.id)).toEqual(siteLines(inline(q)));
    }
    // …and the table is not vacuous: every source wins somewhere, and one row has no site at all.
    expect(rows.map((q) => shared(q)?.source ?? null)).toEqual(["quote", "job", "lead", "customer", null, "lead", "quote", "customer"]);
  });
});

describe("sitePartsOf: five columns and nothing else", () => {
  it("drops everything that is not the address, and keeps a hole a hole", () => {
    expect(sitePartsOf({ ...own, name: "Sam Tillery", phone: "(530) 555-0100", notes: "gate code" } as never)).toEqual(own);
    expect(sitePartsOf({ address: "9 Bayberry Lane" })).toEqual({ address: "9 Bayberry Lane", unit: null, city: null, state: null, zip: null });
    expect(sitePartsOf(null)).toBeNull();
    expect(sitePartsOf(undefined)).toBeNull();
  });
});

describe("siteKey: when two addresses are the same address", () => {
  it("the street, the unit, the city and the zip, trimmed and lower-cased, a run of spaces read as one", () => {
    expect(siteKey({ address: "  40 SNOWBELL  Court ", unit: " 14 ", city: "testville", zip: "96161 " })).toBe(siteKey(own));
    // The state is not part of it: a row often carries the city and zip without it.
    expect(siteKey({ ...own, state: null })).toBe(siteKey(own));
  });

  it("no street, no key", () => {
    expect(siteKey(null)).toBe("");
    expect(siteKey(undefined)).toBe("");
    expect(siteKey({ address: "   ", unit: "14", city: "Testville", zip: "96161" })).toBe("");
  });

  it("a different unit, city or zip is a different address", () => {
    expect(siteKey({ ...own, unit: "15" })).not.toBe(siteKey(own));
    expect(siteKey({ ...own, unit: null })).not.toBe(siteKey(own));
    expect(siteKey({ ...own, city: "Otherton" })).not.toBe(siteKey(own));
    expect(siteKey({ ...own, zip: "96162" })).not.toBe(siteKey(own));
  });

  it("EXACT ON PURPOSE: two spellings of one place are never guessed to be the same", () => {
    expect(siteKey({ ...own, address: "40 Snowbell Ct" })).not.toBe(siteKey(own));
    expect(siteKey({ ...own, unit: "#14" })).not.toBe(siteKey(own));
    expect(siteKey({ ...own, unit: "Unit 14" })).not.toBe(siteKey(own));
    expect(siteKey({ ...own, address: "40 Snowbell Court." })).not.toBe(siteKey(own));
  });

  it("a part cannot leak into its neighbour (street 'a' + unit 'b c' is not street 'a b' + unit 'c')", () => {
    expect(siteKey({ address: "40 Snowbell", unit: "Court 14" })).not.toBe(siteKey({ address: "40 Snowbell Court", unit: "14" }));
  });
});

describe("siteOneLine", () => {
  it("the street, the unit, then the town; no second town when the street line already ends in one", () => {
    expect(siteOneLine(own)).toBe("40 Snowbell Court, Unit 14, Testville, CA 96161");
    expect(siteOneLine({ address: "9 Bayberry Lane" })).toBe("9 Bayberry Lane");
    expect(siteOneLine({ address: "9 Bayberry Lane, Testville, CA 96161", city: "Testville", state: "CA", zip: "96161" })).toBe("9 Bayberry Lane, Testville, CA 96161");
    expect(siteOneLine(null)).toBe("");
  });
});

describe("quoteSiteView: what the Job Site line says", () => {
  it.each([
    ["its own address wins", { quote: own, lead: leadSite, customer: custSite }, "quote"],
    ["no own address: the lead's", { lead: leadSite, customer: custSite }, "lead"],
    ["no lead address: the customer's", { lead: { address: null }, customer: custSite }, "customer"],
    ["on a job with no own address: the job's", { job: jobSite, lead: leadSite, customer: custSite }, "job"],
    ["on a job with its own address: its own still outranks the job's", { quote: own, job: jobSite, customer: custSite }, "quote"],
    ["on a job that has no address: the customer's shows through", { job: { address: null }, customer: custSite }, "customer"],
  ] as const)("%s", (_name, records, source) => {
    const v = quoteSiteView(records);
    expect(v.source).toBe(source);
    // The line shows exactly what the paper prints: the same call the print page makes.
    expect(v.site).toEqual(pickSite(quoteSiteCandidates(records)));
  });

  it("no address anywhere: no site, no source, and nothing to call incomplete", () => {
    expect(quoteSiteView({})).toEqual({ site: null, source: null, incomplete: false, jobDiffers: false });
  });

  it("NOTHING IS COMPUTED FOR NOBODY: it answers four things, and a statement on the line reads each one", () => {
    // It used to answer seven. hasOwn, fallback and fallbackSource were read by no statement outside this
    // file, so they went with their cases (a value nobody reads is a hole: the day it is wrong, nothing
    // says so). What the estimate falls back to is asked where it is used: quoteSiteChoices' row that
    // follows, and siteBoxesFrom.
    const answers = Object.keys(quoteSiteView({ quote: own, job: jobSite, lead: leadSite, customer: custSite })).sort();
    expect(answers).toEqual(["incomplete", "jobDiffers", "site", "source"]);
    const line = read("src/app/(app)/quotes/[id]/job-site-line.tsx");
    for (const answer of answers) expect(line.split(`view.${answer}`).length - 1, answer).toBeGreaterThanOrEqual(1);
  });

  it("a street with no town is incomplete; a line that carries its own town is not", () => {
    expect(quoteSiteView({ lead: { address: "16 larkspur circle Testville" } }).incomplete).toBe(true);
    expect(quoteSiteView({ quote: { address: "40 Snowbell Court", unit: "14" } }).incomplete).toBe(true);
    expect(quoteSiteView({ quote: own }).incomplete).toBe(false);
    expect(quoteSiteView({ customer: { address: "12 Thistlewood Way, Testville, CA 96161" } }).incomplete).toBe(false);
  });

  it("THE JOB DIFFERS only when the estimate has its own address and the job has another", () => {
    // A job born from the estimate starts with the estimate's address: the same, so nothing to say.
    expect(quoteSiteView({ quote: own, job: { ...own } }).jobDiffers).toBe(false);
    expect(quoteSiteView({ quote: own, job: { ...own, address: " 40 snowbell  court" } }).jobDiffers).toBe(false);
    // Somebody corrected the unit on the job: the paper (the estimate's own) and the job now disagree.
    expect(quoteSiteView({ quote: own, job: { ...own, unit: "15" } }).jobDiffers).toBe(true);
    expect(quoteSiteView({ quote: own, job: jobSite }).jobDiffers).toBe(true);
    // No own address: the estimate follows the job, whatever the job says.
    expect(quoteSiteView({ job: jobSite, customer: custSite }).jobDiffers).toBe(false);
    // A job with no address of its own has nothing to disagree with.
    expect(quoteSiteView({ quote: own, job: { address: null } }).jobDiffers).toBe(false);
    expect(quoteSiteView({ quote: own }).jobDiffers).toBe(false);
  });
});

describe("quoteSiteChoices: what the picker offers", () => {
  const job = (id: string, number: string, name: string, parts: SiteParts): OtherJobSite => ({ id, job_number: number, name, ...parts });

  it("a customer with other jobs: the customer's own address first (it follows), then each other address, in the order read", () => {
    const rows = quoteSiteChoices({
      customer: custSite,
      otherJobs: [job("j3", "J-031", "40 Snowbell #14", own), job("j2", "J-020", "9 Bayberry", jobSite)],
    });
    expect(rows.map((r) => [r.from, r.follows, r.parts.address, r.parts.unit])).toEqual([
      ["customer", true, "12 Thistlewood Way", null],
      ["job", false, "40 Snowbell Court", "14"],
      ["job", false, "9 Bayberry Lane", null],
    ]);
    expect(rows[1].job).toEqual({ id: "j3", job_number: "J-031", name: "40 Snowbell #14" });
    expect(rows[0].job).toBeUndefined();
    expect(new Set(rows.map((r) => r.key)).size).toBe(3);
  });

  it("one row per address: three jobs at one unit are one row, named after the first handed in (the newest)", () => {
    const rows = quoteSiteChoices({
      customer: custSite,
      otherJobs: [job("j9", "J-044", "40 Snowbell #14", own), job("j5", "J-031", "Snowbell 14 lights", { ...own, address: "40 snowbell court " }), job("j1", "J-012", "Snowbell", own)],
    });
    expect(rows).toHaveLength(2);
    expect(rows[1].job?.id).toBe("j9");
  });

  it("each unit at one street is its own row", () => {
    const rows = quoteSiteChoices({ customer: custSite, otherJobs: [job("j1", "J-001", "Snowbell 14", own), job("j2", "J-002", "Snowbell 15", { ...own, unit: "15" }), job("j3", "J-003", "Snowbell", { ...own, unit: null })] });
    expect(rows.slice(1).map((r) => r.parts.unit)).toEqual(["14", "15", null]);
  });

  it("a job at the customer's own address adds no row, and a job with no street is skipped", () => {
    const rows = quoteSiteChoices({ customer: custSite, otherJobs: [job("j1", "J-001", "Thistlewood", { ...custSite }), job("j2", "J-002", "No address yet", { address: "  " }), job("j3", "J-003", "Bayberry", jobSite)] });
    expect(rows.map((r) => r.parts.address)).toEqual(["12 Thistlewood Way", "9 Bayberry Lane"]);
  });

  it("two spellings of one place stay two rows: nothing is guessed", () => {
    const rows = quoteSiteChoices({ customer: null, otherJobs: [job("j1", "J-001", "a", own), job("j2", "J-002", "b", { ...own, address: "40 Snowbell Ct" })] });
    expect(rows.map((r) => r.parts.address)).toEqual(["40 Snowbell Court", "40 Snowbell Ct"]);
    // A customer with no address on file: no row follows, every row is a copy.
    expect(rows.every((r) => !r.follows)).toBe(true);
  });

  it("the other addresses are capped, and the cap counts addresses, not jobs", () => {
    const many = Array.from({ length: 30 }, (_, i) => job(`j${i}`, `J-${100 + i}`, `Catbird ${i}`, { address: `${i + 1} Catbird Road`, city: "Testville", zip: "96161" }));
    // Two jobs at every address: thirty jobs, fifteen addresses.
    const doubled = many.flatMap((j, i) => (i < 15 ? [j, { ...j, id: `${j.id}-again` }] : []));
    expect(SITE_CHOICE_JOBS_CAP).toBe(8);
    expect(quoteSiteChoices({ customer: custSite, otherJobs: many })).toHaveLength(1 + 8);
    expect(quoteSiteChoices({ customer: custSite, otherJobs: doubled }).slice(1).map((r) => r.parts.address)).toEqual(Array.from({ length: 8 }, (_, i) => `${i + 1} Catbird Road`));
    expect(quoteSiteChoices({ customer: custSite, otherJobs: many, cap: 2 })).toHaveLength(3);
  });

  it("an estimate made out to a lead with no customer: the lead's address, and it follows", () => {
    expect(quoteSiteChoices({ lead: leadSite, customer: null })).toEqual([
      { key: siteKey(leadSite), from: "lead", follows: true, parts: { address: "16 Larkspur Circle", unit: null, city: "Testville", state: "CA", zip: "96161" } },
    ]);
  });

  it("a lead AND a customer: the lead outranks the customer on the paper, so the lead's row follows and the customer's is a copy", () => {
    const rows = quoteSiteChoices({ lead: leadSite, customer: custSite, otherJobs: [job("j1", "J-001", "Bayberry", jobSite)] });
    expect(rows.map((r) => [r.from, r.follows])).toEqual([["lead", true], ["customer", false], ["job", false]]);
    // What it follows is what the paper prints with no address of its own: one rule for both.
    expect(quoteSiteView({ lead: leadSite, customer: custSite }).source).toBe("lead");
  });

  it("a lead with no address: the customer's row is the one that follows; the same address on both is one row", () => {
    expect(quoteSiteChoices({ lead: { address: null }, customer: custSite }).map((r) => [r.from, r.follows])).toEqual([["customer", true]]);
    expect(quoteSiteChoices({ lead: { ...custSite }, customer: custSite }).map((r) => [r.from, r.follows])).toEqual([["lead", true]]);
  });

  it("nobody has an address: nothing to offer", () => {
    expect(quoteSiteChoices({})).toEqual([]);
    expect(quoteSiteChoices({ lead: { address: "" }, customer: { address: null }, otherJobs: [] })).toEqual([]);
    expect(quoteSiteChoices({ customer: custSite, otherJobs: null })).toHaveLength(1);
  });

  it("a row carries the address AS IT IS ON FILE, trimmed: never re-spelled, an empty part null", () => {
    const [row] = quoteSiteChoices({ customer: null, otherJobs: [job("j1", "J-001", "a", { address: "  40 Snowbell  Court ", unit: " ", city: " Testville ", state: "", zip: " 96161" })] });
    expect(row.parts).toEqual({ address: "40 Snowbell  Court", unit: null, city: "Testville", state: null, zip: "96161" });
  });
});

describe("siteChoiceInUse and siteWriteFor: the mark, and what a tap writes", () => {
  const rows = quoteSiteChoices({ customer: custSite, otherJobs: [{ id: "j3", job_number: "J-031", name: "40 Snowbell #14", ...own }] });
  const [follow, copy] = rows;

  it("an estimate with no address of its own is on the row it follows", () => {
    expect(siteChoiceInUse(rows, null)).toBe(follow.key);
    expect(siteChoiceInUse(rows, { address: " " })).toBe(follow.key);
  });

  it("one with its own is on the copy row that has the same address", () => {
    expect(siteChoiceInUse(rows, own)).toBe(copy.key);
    expect(siteChoiceInUse(rows, { ...own, address: "40 snowbell court" })).toBe(copy.key);
  });

  it("an address typed by hand matches no row", () => {
    expect(siteChoiceInUse(rows, { address: "3 Catbird Road", city: "Testville", zip: "96161" })).toBeNull();
  });

  it("an own address that merely EQUALS the customer's is still a copy: the follow row stays tappable, which is how it goes back to following", () => {
    expect(siteChoiceInUse(rows, { ...custSite })).toBeNull();
  });

  it("no rows, nothing in use", () => {
    expect(siteChoiceInUse([], null)).toBeNull();
    expect(siteChoiceInUse([], own)).toBeNull();
  });

  it("the row it follows CLEARS the estimate's own address; every other row writes its address", () => {
    expect(siteWriteFor(follow)).toBeNull();
    expect(siteWriteFor(copy)).toEqual({ address: "40 Snowbell Court", unit: "14", city: "Testville", state: "CA", zip: "96161" });
  });
});

describe("siteChoicesShort: a short list says it is short", () => {
  const job = (i: number): OtherJobSite => ({ id: `j${i}`, job_number: `J-${100 + i}`, name: `Catbird ${i}`, address: `${i + 1} Catbird Road`, city: "Testville", zip: "96161" });
  const jobs = (n: number) => Array.from({ length: n }, (_, i) => job(i));

  it("the read's limit is one number, 30, and a read that long is full: there may be older jobs it never reached", () => {
    expect(SITE_JOBS_READ_LIMIT).toBe(30);
    expect(siteJobsReadFull(jobs(30))).toBe(true);
    expect(siteJobsReadFull(jobs(31))).toBe(true);
    expect(siteJobsReadFull(jobs(29))).toBe(false);
    expect(siteJobsReadFull([])).toBe(false);
    expect(siteJobsReadFull(null)).toBe(false);
    expect(siteJobsReadFull(undefined)).toBe(false);
  });

  it("not short: every address handed in has its row", () => {
    expect(siteChoicesShort({})).toBe(false);
    expect(siteChoicesShort({ customer: custSite })).toBe(false);
    expect(siteChoicesShort({ customer: custSite, otherJobs: jobs(3) })).toBe(false);
    // Exactly as many addresses as the picker lists: all eight are shown, nothing was left out.
    expect(siteChoicesShort({ customer: custSite, otherJobs: jobs(SITE_CHOICE_JOBS_CAP) })).toBe(false);
    expect(siteChoicesShort({ customer: custSite, otherJobs: jobs(SITE_CHOICE_JOBS_CAP), readFull: false })).toBe(false);
  });

  it("CUT BY THE CAP: a ninth different address found no row", () => {
    expect(siteChoicesShort({ customer: custSite, otherJobs: jobs(SITE_CHOICE_JOBS_CAP + 1) })).toBe(true);
    expect(siteChoicesShort({ customer: custSite, otherJobs: jobs(29) })).toBe(true);
    expect(siteChoicesShort({ otherJobs: jobs(3), cap: 2 })).toBe(true);
    expect(siteChoicesShort({ otherJobs: jobs(2), cap: 2 })).toBe(false);
  });

  it("the cap counts ADDRESSES: more jobs at addresses already listed, or with no street, leave nothing out", () => {
    const eight = jobs(SITE_CHOICE_JOBS_CAP);
    const again = eight.map((j) => ({ ...j, id: `${j.id}-again` }));
    const noStreet: OtherJobSite = { id: "j-none", job_number: "J-900", name: "No address yet", address: "  " };
    const atTheCustomers: OtherJobSite = { id: "j-home", job_number: "J-901", name: "Thistlewood", ...custSite };
    expect(siteChoicesShort({ customer: custSite, otherJobs: [...eight, ...again, noStreet, atTheCustomers] })).toBe(false);
    // …and the list it describes is the list the picker draws: the same eight rows either way.
    expect(quoteSiteChoices({ customer: custSite, otherJobs: [...eight, ...again, noStreet, atTheCustomers] })).toEqual(quoteSiteChoices({ customer: custSite, otherJobs: eight }));
    // One more address after all of that is a cut.
    expect(siteChoicesShort({ customer: custSite, otherJobs: [...eight, ...again, noStreet, job(40)] })).toBe(true);
  });

  it("THE READ CAME BACK FULL: short whatever the rows are, because the jobs it never read may hold another address", () => {
    expect(siteChoicesShort({ customer: custSite, otherJobs: jobs(2), readFull: true })).toBe(true);
    // Thirty jobs at ONE address: one row, nothing cut by the cap, and still short of the customer's whole history.
    const sameUnit = Array.from({ length: SITE_JOBS_READ_LIMIT }, (_, i) => ({ ...job(0), id: `same-${i}` }));
    expect(quoteSiteChoices({ customer: custSite, otherJobs: sameUnit })).toHaveLength(2);
    expect(siteChoicesShort({ customer: custSite, otherJobs: sameUnit })).toBe(false);
    expect(siteChoicesShort({ customer: custSite, otherJobs: sameUnit, readFull: siteJobsReadFull(sameUnit) })).toBe(true);
    expect(siteChoicesShort({ customer: custSite, otherJobs: jobs(2), readFull: null })).toBe(false);
  });

  it("asking whether the list is short changes nothing about the list", () => {
    const of = { lead: leadSite, customer: custSite, otherJobs: jobs(12) };
    const before = quoteSiteChoices(of);
    expect(siteChoicesShort(of)).toBe(true);
    expect(quoteSiteChoices(of)).toEqual(before);
    expect(before).toHaveLength(2 + SITE_CHOICE_JOBS_CAP);
  });
});

describe("siteBoxes…: A Different Address while it is being typed", () => {
  const BLANK: SiteBoxes = { street: "", unit: "", city: "", state: "", zip: "" };
  const OWN: SiteBoxes = { street: "40 Snowbell Court", unit: "14", city: "Testville", state: "CA", zip: "96161" };

  describe("siteBoxesFrom: how the boxes open", () => {
    const LEAD: SiteBoxes = { street: "16 Larkspur Circle", unit: "", city: "Testville", state: "CA", zip: "96161" };
    const CUST: SiteBoxes = { street: "12 Thistlewood Way", unit: "", city: "Testville", state: "CA", zip: "96161" };

    it("the estimate's own address, which is the thing being corrected, whatever else is on file", () => {
      expect(siteBoxesFrom({ quote: own })).toEqual(OWN);
      expect(siteBoxesFrom({ quote: own, lead: leadSite, customer: custSite })).toEqual(OWN);
    });

    it("trimmed, as it is on file; a zip kept as a number is read as written; a missing part is an empty box", () => {
      expect(siteBoxesFrom({ quote: { address: "  40 Snowbell Court ", unit: " 14 ", city: " Testville", state: "CA ", zip: 96161 as never } })).toEqual(OWN);
      expect(siteBoxesFrom({ quote: { address: "9 Bayberry Lane", unit: null, city: undefined, state: null, zip: null } })).toEqual({ ...BLANK, street: "9 Bayberry Lane" });
      // Not re-spelled: two spaces inside a street stay two spaces (only a KEY reads them as one).
      expect(siteBoxesFrom({ quote: { address: "40  Snowbell Court" } }).street).toBe("40  Snowbell Court");
    });

    // RE-PINNED (the owner, 2026-11-10, about an estimate for a unit in a complex: "it auto-populated to
    // both positions with no other way to pick the site ... nor input a unit number other than the
    // title"). These five cases used to open BLANK whatever the lead and the customer held: "the lead's
    // and the customer's are rows to tap, never a start to type over". But a unit is the commonest
    // change, and with blank boxes "same street, add a unit" meant typing the street again. The boxes
    // open with the address the paper prints NOW: the estimate's own, else the lead's, else the customer's.
    it.each([
      ["no own address", null],
      ["nothing handed in", undefined],
      ["an empty row", {}],
      ["a street of spaces", { address: "   ", unit: "14", city: "Testville", state: "CA", zip: "96161" }],
      ["a unit and a town with no street (a row with no street is no address)", { address: null, unit: "14", city: "Testville", state: "CA", zip: "96161" }],
    ])("%s: the boxes open with the address it falls back to (the lead's, else the customer's), and blank only when there is none", (_name, parts) => {
      const quote = parts as SiteParts | null | undefined;
      expect(siteBoxesFrom({ quote, lead: leadSite, customer: custSite })).toEqual(LEAD);
      expect(siteBoxesFrom({ quote, lead: { address: " " }, customer: custSite })).toEqual(CUST);
      expect(siteBoxesFrom({ quote, customer: custSite })).toEqual(CUST);
      expect(siteBoxesFrom({ quote, lead: leadSite })).toEqual(LEAD);
      // No address anywhere: nothing to start from.
      expect(siteBoxesFrom({ quote })).toEqual(BLANK);
      expect(siteBoxesFrom({ quote, lead: { address: null, city: "Testville" }, customer: { address: "", unit: "3" } })).toEqual(BLANK);
    });

    it("it is the address the paper prints: the same record, whole, that the Job Site line shows (for an estimate with no job)", () => {
      const tables: QuoteSiteRecords[] = [
        { quote: own, lead: leadSite, customer: custSite },
        { lead: leadSite, customer: custSite },
        { lead: { address: null }, customer: custSite },
        { lead: { ...leadSite, unit: "11" } },
        { lead: { address: "16 larkspur circle Testville" }, customer: custSite },
        {},
      ];
      for (const records of tables) {
        const printed = quoteSiteView(records).site;
        expect(siteBoxesFrom(records)).toEqual({ street: printed?.address ?? "", unit: printed?.unit ?? "", city: printed?.city ?? "", state: printed?.state ?? "", zip: printed?.zip ?? "" });
      }
      // WHOLE: a lead's street is never opened with the customer's town under it (pickSite is all-or-nothing).
      expect(siteBoxesFrom({ lead: { address: "16 larkspur circle" }, customer: custSite })).toEqual({ ...BLANK, street: "16 larkspur circle" });
    });

    it("NEVER THE JOB'S: the sheet exists only for an estimate with no job, so a job's record handed in is not read", () => {
      expect(siteBoxesFrom({ job: jobSite })).toEqual(BLANK);
      expect(siteBoxesFrom({ job: jobSite, customer: custSite })).toEqual(CUST);
      expect(siteBoxesFrom({ quote: own, job: jobSite })).toEqual(OWN);
    });

    it("NOTHING IS COPIED WITHOUT A CHANGE: boxes that open with the customer's address have nothing to save until something differs", () => {
      const start = siteBoxesFrom({ customer: custSite });
      // The address box reports the street it opened with; that is not typing.
      const opened = siteBoxesTyped(start, start.street);
      expect(siteBoxesReady(opened, start)).toBe(false);
      expect(siteBoxesReady({ ...opened, unit: " " }, start)).toBe(false);
      expect(siteBoxesReady({ ...opened, unit: "14" }, start)).toBe(true);
    });
  });

  describe("siteBoxesTyped: a change in the street box", () => {
    it("typing over a street drops the town it was picked with, and keeps the unit", () => {
      expect(siteBoxesTyped(OWN, "40 Snowbell Cour")).toEqual({ street: "40 Snowbell Cour", unit: "14", city: "", state: "", zip: "" });
      expect(siteBoxesTyped(OWN, "")).toEqual({ street: "", unit: "14", city: "", state: "", zip: "" });
    });

    it("text that did not change changes nothing: the very same boxes come back", () => {
      // The address box reports its value once on its own when it mounts, and again after a pick.
      expect(siteBoxesTyped(OWN, "40 Snowbell Court")).toBe(OWN);
      expect(siteBoxesTyped(BLANK, "")).toBe(BLANK);
    });

    it("a town once dropped stays dropped: typing the old street back does not bring it home", () => {
      const over = siteBoxesTyped(OWN, "40 Snowbell Cour");
      expect(siteBoxesTyped(over, "40 Snowbell Court")).toEqual({ street: "40 Snowbell Court", unit: "14", city: "", state: "", zip: "" });
    });

    it("it is the text as typed: a space is a keystroke, and is not trimmed out from under the cursor", () => {
      expect(siteBoxesTyped(BLANK, "9 Bayberry ").street).toBe("9 Bayberry ");
    });

    it("the boxes handed in are never changed in place", () => {
      const before = { ...OWN };
      siteBoxesTyped(OWN, "9 Bayberry Lane");
      expect(OWN).toEqual(before);
    });
  });

  describe("siteBoxesPicked: a pick from the suggestions", () => {
    const picked = { formatted: "9 Bayberry Lane, Elsewhere, NV 89501, USA", line1: "9 Bayberry Lane", city: "Elsewhere", state: "NV", zip: "89501" };

    it("the street and its town arrive together; the unit is the person's and stays", () => {
      expect(siteBoxesPicked(OWN, picked)).toEqual({ street: "9 Bayberry Lane", unit: "14", city: "Elsewhere", state: "NV", zip: "89501" });
      expect(siteBoxesPicked(BLANK, picked)).toEqual({ street: "9 Bayberry Lane", unit: "", city: "Elsewhere", state: "NV", zip: "89501" });
    });

    it("a place with no town on it leaves no town behind from the street before", () => {
      expect(siteBoxesPicked(OWN, { line1: "9 Bayberry Lane", city: "", state: null, zip: undefined })).toEqual({ street: "9 Bayberry Lane", unit: "14", city: "", state: "", zip: "" });
      expect(siteBoxesPicked(OWN, { line1: "9 Bayberry Lane" })).toEqual({ street: "9 Bayberry Lane", unit: "14", city: "", state: "", zip: "" });
    });

    it("the text change that follows a pick is not typing: the town just picked is kept, whichever arrives first", () => {
      // The pick, then the box reporting its new text (the order the address box sends them in).
      const after = siteBoxesPicked(siteBoxesTyped(BLANK, "9 Bay"), picked);
      expect(siteBoxesTyped(after, picked.line1)).toBe(after);
      expect(after.city).toBe("Elsewhere");
      // The other order ends in the same boxes.
      expect(siteBoxesPicked(siteBoxesTyped(siteBoxesTyped(BLANK, "9 Bay"), picked.line1), picked)).toEqual(after);
    });

    it("typing after a pick drops the picked town again", () => {
      const after = siteBoxesPicked(BLANK, picked);
      expect(siteBoxesTyped(after, "9 Bayberry Lane Rear")).toEqual({ street: "9 Bayberry Lane Rear", unit: "", city: "", state: "", zip: "" });
    });
  });

  describe("siteBoxesDiffer and siteBoxesReady: when there is something to save", () => {
    it("as they opened, there is nothing to save", () => {
      expect(siteBoxesDiffer(OWN, OWN)).toBe(false);
      expect(siteBoxesReady(OWN, OWN)).toBe(false);
      expect(siteBoxesDiffer(BLANK, BLANK)).toBe(false);
      expect(siteBoxesReady(BLANK, BLANK)).toBe(false);
    });

    it("space around a value is not a change", () => {
      expect(siteBoxesDiffer({ ...OWN, street: " 40 Snowbell Court ", unit: "14 " }, OWN)).toBe(false);
      expect(siteBoxesReady({ ...OWN, unit: " 14" }, OWN)).toBe(false);
      expect(siteBoxesDiffer({ ...BLANK, street: "   " }, BLANK)).toBe(false);
    });

    it.each(["street", "unit", "city", "state", "zip"] as const)("a different %s is a change", (box) => {
      expect(siteBoxesDiffer({ ...OWN, [box]: "x" }, OWN)).toBe(true);
      expect(siteBoxesReady({ ...OWN, [box]: "x" }, OWN)).toBe(true);
    });

    it("capitals are a change: a street is saved as it is spelled", () => {
      expect(siteBoxesDiffer({ ...OWN, street: "40 snowbell court" }, OWN)).toBe(true);
    });

    it("a change with no street is not ready: the boxes replace an address, they never blank one", () => {
      expect(siteBoxesDiffer({ ...OWN, street: "" }, OWN)).toBe(true);
      expect(siteBoxesReady({ ...OWN, street: "" }, OWN)).toBe(false);
      expect(siteBoxesReady({ ...OWN, street: "   " }, OWN)).toBe(false);
      // A unit typed with no street has nowhere to stand.
      expect(siteBoxesReady({ ...BLANK, unit: "14" }, BLANK)).toBe(false);
    });

    it("the first street typed into blank boxes is ready", () => {
      expect(siteBoxesReady(siteBoxesTyped(BLANK, "9 Bayberry Lane"), BLANK)).toBe(true);
    });
  });

  describe("siteBoxesWrite: what the boxes send", () => {
    it("the five parts, trimmed, under the names the action reads", () => {
      expect(siteBoxesWrite({ street: " 40 Snowbell Court ", unit: " 14 ", city: " Testville ", state: " CA ", zip: " 96161 " })).toEqual({
        address: "40 Snowbell Court",
        unit: "14",
        city: "Testville",
        state: "CA",
        zip: "96161",
      });
    });

    it("the server takes what they send: an empty box lands as null", () => {
      expect(cleanQuoteSite(siteBoxesWrite({ ...BLANK, street: "9 Bayberry Lane" }))).toEqual({
        ok: true,
        site: { address: "9 Bayberry Lane", unit: null, city: null, state: null, zip: null },
      });
      // …and the boxes are not the gate: blank boxes are still refused by the server.
      expect(cleanQuoteSite(siteBoxesWrite(BLANK))).toEqual({ ok: false, why: "address" });
    });
  });

  describe("the three things a person does there", () => {
    it("ADDING A UNIT to the customer's address: Change Job Site, type the unit, Use This Address, and the street is never typed", () => {
      // The estimate has no address of its own and prints its customer's: the boxes open with it.
      const start = siteBoxesFrom({ customer: custSite });
      const opened = siteBoxesTyped(start, start.street);
      const withUnit = { ...opened, unit: "14" };
      expect(siteBoxesReady(withUnit, start)).toBe(true);
      // What is written is the customer's street and town with the unit: the estimate's OWN address now.
      const clean = cleanQuoteSite(siteBoxesWrite(withUnit));
      expect(clean).toEqual({ ok: true, site: { address: "12 Thistlewood Way", unit: "14", city: "Testville", state: "CA", zip: "96161" } });
      if (clean.ok) {
        const after = quoteSiteView({ quote: clean.site, customer: custSite });
        expect(after.source).toBe("quote");
        expect(after.incomplete).toBe(false);
        expect(siteLines(after.site)).toEqual(["12 Thistlewood Way", "Unit 14", "Testville, CA 96161"]);
      }
    });

    it("typing over the street that opened still drops its town: the lead's town never stands under another street", () => {
      const start = siteBoxesFrom({ lead: leadSite });
      const typed = siteBoxesTyped(start, "9 Bayberry Lane");
      expect(typed).toEqual({ street: "9 Bayberry Lane", unit: "", city: "", state: "", zip: "" });
    });

    it("correcting the unit of a complex keeps the street and its town", () => {
      const start = siteBoxesFrom({ quote: own });
      // The address box reports the street it opened with; that is not typing.
      const opened = siteBoxesTyped(start, start.street);
      const fixed = { ...opened, unit: "15" };
      expect(siteBoxesReady(fixed, start)).toBe(true);
      expect(cleanQuoteSite(siteBoxesWrite(fixed))).toEqual({ ok: true, site: { address: "40 Snowbell Court", unit: "15", city: "Testville", state: "CA", zip: "96161" } });
    });

    it("a street typed by hand and never picked saves with no town, and the line can tell", () => {
      const start = siteBoxesFrom({ quote: own });
      const typed = siteBoxesTyped(start, "9 Bayberry Lane");
      expect(siteBoxesReady(typed, start)).toBe(true);
      const clean = cleanQuoteSite(siteBoxesWrite(typed));
      expect(clean).toEqual({ ok: true, site: { address: "9 Bayberry Lane", unit: "14", city: null, state: null, zip: null } });
      // No town from the street before is left on it, and the saved estimate reads as having none.
      if (clean.ok) expect(quoteSiteView({ quote: clean.site, customer: custSite }).incomplete).toBe(true);
    });
  });
});

describe("cleanQuoteSite: a site as the server takes it", () => {
  it("each part trimmed, an empty one null", () => {
    expect(cleanQuoteSite({ address: "  40 Snowbell Court ", unit: " 14 ", city: " Testville", state: "CA ", zip: " 96161 " })).toEqual({
      ok: true,
      site: { address: "40 Snowbell Court", unit: "14", city: "Testville", state: "CA", zip: "96161" },
    });
    expect(cleanQuoteSite({ address: "9 Bayberry Lane", unit: "", city: "   ", state: null, zip: undefined })).toEqual({
      ok: true,
      site: { address: "9 Bayberry Lane", unit: null, city: null, state: null, zip: null },
    });
    expect(cleanQuoteSite({ address: "9 Bayberry Lane" })).toEqual({ ok: true, site: { address: "9 Bayberry Lane", unit: null, city: null, state: null, zip: null } });
  });

  it("a zip or a unit sent as a number is read as written", () => {
    expect(cleanQuoteSite({ address: "9 Bayberry Lane", unit: 14, zip: 96161 })).toEqual({ ok: true, site: { address: "9 Bayberry Lane", unit: "14", city: null, state: null, zip: "96161" } });
  });

  it.each([
    ["no street", { address: "   ", unit: "14", city: "Testville" }],
    ["no street at all", { unit: "14" }],
    ["an empty thing", {}],
    ["a string", "40 Snowbell Court"],
    ["a list", ["40 Snowbell Court"]],
    ["a number", 40],
    ["nothing", undefined],
    ["null (only the action reads null, as a clear)", null],
    ["a street that is not text", { address: { line: "40 Snowbell Court" } }],
  ])("%s is refused for want of an address", (_name, input) => {
    expect(cleanQuoteSite(input)).toEqual({ ok: false, why: "address" });
  });

  it("a part past its cap is refused whole, never cut; at the cap it is taken", () => {
    for (const col of Object.keys(QUOTE_SITE_CAPS) as (keyof typeof QUOTE_SITE_CAPS)[]) {
      const cap = QUOTE_SITE_CAPS[col];
      const base = { address: "9 Bayberry Lane", unit: "", city: "", state: "", zip: "" };
      expect(cleanQuoteSite({ ...base, [col]: "x".repeat(cap + 1) }), col).toEqual({ ok: false, why: "long" });
      const at = cleanQuoteSite({ ...base, [col]: "x".repeat(cap) });
      expect(at.ok, col).toBe(true);
      if (at.ok) expect(at.site[col], col).toHaveLength(cap);
      // Spaces around it are not the address: the cap is on what would be stored.
      expect(cleanQuoteSite({ ...base, [col]: `  ${"x".repeat(cap)}  ` }).ok, col).toBe(true);
    }
    // Too long says so even when there is no street: the long part is the thing to fix first.
    expect(cleanQuoteSite({ address: "", unit: "x".repeat(QUOTE_SITE_CAPS.unit + 1) })).toEqual({ ok: false, why: "long" });
  });

  it("the caps are roomy enough for a row already on file, and only keep out a pasted page", () => {
    expect(QUOTE_SITE_CAPS.address).toBeGreaterThanOrEqual(200);
    expect(QUOTE_SITE_CAPS.unit).toBeGreaterThanOrEqual(24); // the Unit box itself stops typing at 24
    expect(QUOTE_SITE_CAPS.zip).toBeGreaterThanOrEqual(10); // 96161-1234
    expect(Math.max(...Object.values(QUOTE_SITE_CAPS))).toBeLessThanOrEqual(500);
  });
});

describe("commitQuoteSite: the tap is the save", () => {
  const FALLBACK = "Couldn't save.";

  it("a row's address goes to the action once, as it is, and the answer is ok", async () => {
    const action = vi.fn(async () => ({ ok: true }));
    const site = { address: "40 Snowbell Court", unit: "14", city: "Testville", state: "CA", zip: "96161" };
    expect(await commitQuoteSite("q1", site, { setQuoteSite: action, fallbackError: FALLBACK })).toEqual({ ok: true });
    expect(action).toHaveBeenCalledTimes(1);
    expect(action).toHaveBeenCalledWith("q1", site);
  });

  it("a clear is sent as null, never as an empty address", async () => {
    const action = vi.fn(async () => ({ ok: true }));
    await commitQuoteSite("q1", null, { setQuoteSite: action, fallbackError: FALLBACK });
    expect(action).toHaveBeenCalledWith("q1", null);
  });

  it("a refusal is the server's own sentence; one with no sentence, or a call that throws, says the fallback", async () => {
    const said = "This estimate is already on a job, and the job owns its site. Change the address on the job.";
    expect(await commitQuoteSite("q1", null, { setQuoteSite: async () => ({ ok: false, error: said }), fallbackError: FALLBACK })).toEqual({ ok: false, error: said });
    expect(await commitQuoteSite("q1", null, { setQuoteSite: async () => ({ ok: false }), fallbackError: FALLBACK })).toEqual({ ok: false, error: FALLBACK });
    const dropped = async () => {
      throw new Error("offline");
    };
    expect(await commitQuoteSite("q1", null, { setQuoteSite: dropped, fallbackError: FALLBACK })).toEqual({ ok: false, error: FALLBACK });
  });
});

describe("siteWritten…: the line and the sheet read what was just saved", () => {
  // A save closes the sheet and asks the page to read itself again; that read lands a moment later.
  // Until it does the page's records are the old ones, so the line said Saved beside the address just
  // replaced, and the sheet opened again in that moment started from it. The write is remembered and
  // read in the records' place until the page's own read arrives.
  const typed = { address: " 9 Bayberry Lane ", unit: "3", city: "", state: "", zip: "" };
  const stored = { address: "9 Bayberry Lane", unit: "3", city: null, state: null, zip: null };

  describe("siteWritten: remembering a save that landed", () => {
    it("the address is kept as the SERVER stores it (cleanQuoteSite, the one rule both ends share), against the page's own key at the tap", () => {
      expect(siteWritten(null, typed)).toEqual({ was: "", own: stored });
      expect(siteWritten(own, typed)).toEqual({ was: siteKey(own), own: stored });
      const sent = cleanQuoteSite(typed);
      expect(sent.ok && sent.site).toEqual(siteWritten(own, typed)!.own);
      // A row's address is already in that shape and is kept as it is.
      expect(siteWritten(undefined, { ...jobSite })!.own).toEqual({ address: "9 Bayberry Lane", unit: null, city: "Testville", state: "CA", zip: "96161" });
    });

    it("a clear is remembered as no address of its own", () => {
      expect(siteWritten(own, null)).toEqual({ was: siteKey(own), own: null });
      expect(siteWritten({ address: "  " }, null)).toEqual({ was: "", own: null });
    });

    it("something the server would not have taken is not remembered at all: the line waits for the page, as it used to", () => {
      expect(siteWritten(own, { address: "   ", unit: "3" })).toBeNull();
      expect(siteWritten(own, { address: "x".repeat(QUOTE_SITE_CAPS.address + 1) })).toBeNull();
      expect(siteWritten(own, {})).toBeNull();
    });
  });

  describe("siteWrittenStands and quoteSiteRecordsNow: until the page's own read arrives", () => {
    const records: QuoteSiteRecords = { quote: own, lead: leadSite, customer: custSite };
    const set = siteWritten(own, typed)!;
    const cleared = siteWritten(own, null)!;

    it.each<[string, SiteParts | null | undefined, SiteWritten | null | undefined, boolean]>([
      ["no save remembered", own, null, false],
      ["no save remembered (undefined)", own, undefined, false],
      ["the page still has the address it had at the tap", own, set, true],
      ["…spelled with other capitals and spaces: the same address, so still the old read", { ...own, address: " 40 SNOWBELL  court" }, set, true],
      ["the page's read arrived with the address written", stored, set, false],
      ["the page's read arrived with a different address altogether (somebody else's change)", jobSite, set, false],
      ["the page's read arrived with no own address at all", null, set, false],
      ["a clear, and the page still has the old address", own, cleared, true],
      ["a clear, and the page's read arrived without it", { address: null }, cleared, false],
      ["no own address at the tap, and the page still has none", null, siteWritten(null, typed), true],
      ["no own address at the tap, and the page's read arrived with the one written", stored, siteWritten(null, typed), false],
    ])("%s", (_name, pageOwn, written, stands) => {
      expect(siteWrittenStands(pageOwn, written)).toBe(stands);
      const now = quoteSiteRecordsNow({ ...records, quote: pageOwn }, written);
      // While it stands the estimate's own address is the one WRITTEN; once it does not, the page's own, untouched.
      expect(now.quote).toEqual(stands ? written!.own : pageOwn);
      // Nothing else is ever touched: the lead's, the customer's and the job's are the page's.
      expect(now.lead).toBe(leadSite);
      expect(now.customer).toBe(custSite);
    });

    it("with no save standing the very records handed in come back (not a copy)", () => {
      expect(quoteSiteRecordsNow(records, null)).toBe(records);
      expect(quoteSiteRecordsNow({ ...records, quote: stored }, set)).not.toBe(records);
      const moved = { ...records, quote: stored };
      expect(quoteSiteRecordsNow(moved, set)).toBe(moved);
      // The records handed in are never changed in place.
      const before = { ...records };
      quoteSiteRecordsNow(records, set);
      expect(records).toEqual(before);
    });

    it("THE LINE: Saved stands beside the NEW address, from where it was written, before the page's read lands", () => {
      // He set the estimate (which printed its lead's address) to a typed one.
      const page: QuoteSiteRecords = { lead: leadSite, customer: custSite };
      const written = siteWritten(page.quote, typed);
      const view = quoteSiteView(quoteSiteRecordsNow(page, written));
      expect(view.source).toBe("quote");
      expect(siteLines(view.site)).toEqual(["9 Bayberry Lane", "Unit 3"]);
      // Without the remembered write the line would still say the lead's address.
      expect(quoteSiteView(page).source).toBe("lead");
      // The page's read arrives: the same address, now from the page itself.
      const arrived = quoteSiteRecordsNow({ ...page, quote: stored }, written);
      expect(arrived.quote).toBe(stored);
      expect(siteLines(quoteSiteView(arrived).site)).toEqual(["9 Bayberry Lane", "Unit 3"]);
    });

    it("THE ROWS: In Use moves with the write, and going back to the row it follows un-marks the copy", () => {
      const rows = quoteSiteChoices({ customer: custSite, otherJobs: [{ id: "j3", job_number: "J-031", name: "40 Snowbell #14", ...own }] });
      const [follow, copy] = rows;
      const page: QuoteSiteRecords = { customer: custSite };
      // He tapped the job's row: the copy row is in use at once, though the page still has no own address.
      const picked = siteWritten(page.quote, siteWriteFor(copy));
      expect(siteChoiceInUse(rows, quoteSiteRecordsNow(page, picked).quote)).toBe(copy.key);
      expect(siteChoiceInUse(rows, page.quote)).toBe(follow.key);
      // Later, from a page that has the copy, he taps the row it follows: that row is in use at once.
      const withCopy: QuoteSiteRecords = { quote: own, customer: custSite };
      const back = siteWritten(withCopy.quote, siteWriteFor(follow));
      expect(siteChoiceInUse(rows, quoteSiteRecordsNow(withCopy, back).quote)).toBe(follow.key);
    });

    it("THE SHEET: opened again before the page's read lands, the boxes start from what was just saved, so Use This Address is not live on the old address", () => {
      const page: QuoteSiteRecords = { quote: own, customer: custSite };
      const written = siteWritten(page.quote, typed);
      const start = siteBoxesFrom(quoteSiteRecordsNow(page, written));
      expect(start).toEqual({ street: "9 Bayberry Lane", unit: "3", city: "", state: "", zip: "" });
      // The boxes as they were when the save went out are exactly that start: nothing to save again.
      expect(siteBoxesReady({ street: " 9 Bayberry Lane ", unit: "3", city: "", state: "", zip: "" }, start)).toBe(false);
      // From the old props they would have opened on the address just replaced.
      expect(siteBoxesFrom(page).street).toBe("40 Snowbell Court");
      // After a clear they open on what the estimate follows now, not on the address just cleared.
      expect(siteBoxesFrom(quoteSiteRecordsNow(page, siteWritten(page.quote, null))).street).toBe("12 Thistlewood Way");
    });

    it("a save that changes only what the key does not read (a capital, the state) goes on being read from the write: it is what was stored", () => {
      const respelled = { ...own, unit: "14" as string | null, address: "40 Snowbell COURT", state: "NV" };
      const written = siteWritten(own, respelled)!;
      expect(written.was).toBe(siteKey(respelled));
      // The key cannot tell the old read from the new one, so the write stands either way; both say the same thing.
      expect(quoteSiteRecordsNow({ quote: own }, written).quote).toEqual(written.own);
      expect(quoteSiteRecordsNow({ quote: respelled }, written).quote).toEqual(respelled);
    });
  });
});

describe("the print page and the estimate's page read the one list", () => {
  const lib = read("src/lib/quote-site.ts");
  const printPage = read("src/app/print/quote/[id]/page.tsx");
  const line = read("src/app/(app)/quotes/[id]/job-site-line.tsx");
  const estimatePage = read("src/app/(app)/quotes/[id]/page.tsx");

  it("the print page picks its site through quoteSiteCandidates, and keeps no list of its own", () => {
    expect(printPage).toContain('import { quoteSiteCandidates } from "@/lib/quote-site";');
    expect(printPage).toMatch(/site=\{pickSite\(\s*quoteSiteCandidates\(\{\s*quote: q as never,\s*job: \(q as \{ jobs\?: never \}\)\.jobs,\s*lead: \(q as \{ inquiries\?: never \}\)\.inquiries,\s*customer: \(q as \{ customers\?: never \}\)\.customers,\s*\}\),\s*\)\}/);
    expect(printPage).not.toMatch(/source: "(quote|job|lead|customer)"/);
  });

  it("the estimate's Job Site line shows quoteSiteView, which is pickSite over the same list", () => {
    // Re-pinned (it was `quoteSiteView(records)`): the records it views are the page's own with ONE change,
    // the estimate's own address read from a save the page has not drawn yet (quoteSiteRecordsNow below).
    // The list and its order are untouched: the same four records go through the same pickSite.
    expect(line).toContain("const now = quoteSiteRecordsNow(records, written);");
    expect(line).toContain("const view = quoteSiteView(now);");
    expect(line).toContain("siteLines(view.site)");
    expect(lib).toContain("const site = pickSite(quoteSiteCandidates(records));");
    // The line keeps no order of its own either: no second list, and no pickSite of its own.
    expect(line).not.toMatch(/source: "(quote|job|lead|customer)"/);
    expect(line).not.toContain("pickSite(");
  });

  it("the estimate's page hands the line the four records, each as its five address columns", () => {
    expect(estimatePage).toContain("records: { quote: sitePartsOf(q), job: sitePartsOf(q.jobs), lead: sitePartsOf(q.inquiry), customer: sitePartsOf(q.customers) },");
  });

  it("the order is written down once in the app: no other file under src names the estimate's own address as a candidate", () => {
    expect(lib.match(/\{ source: "quote", parts: of\.quote \},\s*\{ source: "job", parts: of\.job \},\s*\{ source: "lead", parts: of\.lead \},\s*\{ source: "customer", parts: of\.customer \},/)).not.toBeNull();
    // Every non-test file under src, read whole. The public /q page gets its candidates already
    // ordered by the database (public_quote) and names only the customer; nothing else may start a
    // list of its own with the estimate's address, or the screen and the paper could part ways again.
    const src = join(process.cwd(), "src");
    const naming: string[] = [];
    let files = 0;
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) {
          files += 1;
          // A candidate's own `source`, never the tail of another name (an invoice line's import_source).
          if (/(?<![\w$])source:\s*["']quote["']/.test(readFileSync(p, "utf8"))) naming.push(relative(process.cwd(), p));
        }
      }
    };
    walk(src);
    expect(files).toBeGreaterThan(500); // the walk really read the app
    expect(naming).toEqual(["src/lib/quote-site.ts"]);
  });

  it("the page's read of the customer's jobs and the test of whether it came back full share ONE number", () => {
    expect(estimatePage).toContain(".limit(SITE_JOBS_READ_LIMIT)");
    expect(estimatePage).not.toMatch(/\.limit\(30\)/);
    expect(estimatePage).toContain("otherJobsFull: siteJobsReadFull(otherJobs),");
    expect(lib).toContain("(rows?.length ?? 0) >= SITE_JOBS_READ_LIMIT");
  });

  it("the rule carries no words: a file under src/lib imports no catalog", () => {
    expect(lib).not.toMatch(/from "@\/lib\/(i18n|words)/);
    expect([...lib.matchAll(/from "([^"]+)"/g)].map((m) => m[1])).toEqual(["@/lib/site-address"]);
  });
});
