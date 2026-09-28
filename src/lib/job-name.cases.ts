/**
 * The cases both namers answer: src/lib/job-name.ts jobNameFrom (job-name.test.ts) and its SQL twin
 * public.job_name_from, 0369 (job-name.integration.test.ts). Same input, same name, or the public
 * estimate accept and the office's accept name the same job two ways. Synthetic people and streets.
 *
 * Erik's rule (2026-09-28, final: "street number and name as always"): a typed name stays as typed
 * unless it is only a tag (or a tag and who/where); else the street number and name (" #<unit>"
 * with a unit); no street, who as written · the source's work words; neither, "New Job · Sep 27".
 */
export type JobNameCase = {
  why: string;
  /** A name a person typed (New Job / Nort, an import's job_name, a recurring template's title). */
  typed: string | null;
  /** The words a source carried (a visit's or an estimate's title, a lead's scope). */
  words: string | null;
  customer: { name?: string | null; company_name?: string | null; type?: string | null } | null;
  street: string | null;
  unit: string | null;
  today: string;
  want: string;
};

const rita = { name: "Rita Moss", company_name: null, type: "residential" };
const hoa = { name: "Pat Lee", company_name: "Tahoe Test HOA", type: "commercial" };
const T = "2026-09-27";
/** A source's words (typed: null). */
const src = (why: string, words: string | null, customer: JobNameCase["customer"], street: string | null, want: string, unit: string | null = null, today = T): JobNameCase => ({
  why,
  typed: null,
  words,
  customer,
  street,
  unit,
  today,
  want,
});
/** A typed name (words: null). */
const typed = (why: string, name: string | null, customer: JobNameCase["customer"], street: string | null, want: string, unit: string | null = null): JobNameCase => ({
  why,
  typed: name,
  words: null,
  customer,
  street,
  unit,
  today: T,
  want,
});

export const JOB_NAME_CASES: JobNameCase[] = [
  // 2. With a street: the street number and name, whatever the source said.
  src("a visit's stock title", "Site inspection: Rita Moss", rita, "12 Elm St", "12 Elm St"),
  src("an old booking, em dash", "Service call — Rita Moss", rita, "12 Elm St", "12 Elm St"),
  src("the lead door's seeded estimate", "Estimate — Rita Moss", rita, "12 Elm St", "12 Elm St"),
  src("a source's real work words never replace the street", "Service call — Panel swap", rita, "12 Elm St", "12 Elm St"),
  src("an estimate titled with the work, a street", "Panel Upgrade", rita, "12 Elm St", "12 Elm St"),
  src("a business at a street is the street", "Walk-through: Tahoe Test HOA", hoa, "300 Test Blvd", "300 Test Blvd"),
  src("a whole address line is cut to its street", null, rita, "12 Elm St, Testville, CA 96161", "12 Elm St"),
  src("a tag and the whole address line", "Site visit: 12 Elm St, Testville, CA", null, "12 Elm St", "12 Elm St"),
  src("a phone-call booking", "Call Rita Moss", rita, "12 Elm St", "12 Elm St"),
  src("the old quote fallback", "Job from Q-0012", null, "12 Elm St", "12 Elm St"),
  // The unit, as #<unit>, however it was typed; never twice.
  src("a unit complex", "Site inspection: Tahoe Test HOA", hoa, "300 West Lake Boulevard", "300 West Lake Boulevard #56", "56"),
  src("a unit typed with its #", null, rita, "300 West Lake Boulevard", "300 West Lake Boulevard #56", "#56"),
  src("a unit typed as Unit", null, rita, "300 West Lake Boulevard", "300 West Lake Boulevard #56", "Unit 56"),
  src("a unit typed as Apt.", null, rita, "300 West Lake Boulevard", "300 West Lake Boulevard #4B", "Apt. 4B"),
  src("a street that already carries the unit", null, rita, "300 West Lake Boulevard #56", "300 West Lake Boulevard #56", "56"),
  src("a blank unit", null, rita, "300 West Lake Boulevard", "300 West Lake Boulevard", "  "),
  // 3. No street: who as written, then the source's work words.
  src("an estimate's work words", "Estimate — Panel Upgrade", { name: "Jackie Test", company_name: null, type: "residential" }, null, "Jackie Test · Panel Upgrade"),
  src("a lead's short scope", "3-way switches", { name: "Rich Test", company_name: null, type: "residential" }, null, "Rich Test · 3-way switches"),
  src("a quote booking: a tag and the person", "Quote: Rita Moss", rita, null, "Rita Moss"),
  src("call with a separator", "Call: Rita Moss", rita, null, "Rita Moss"),
  src("the whole name, never a last name", null, rita, null, "Rita Moss"),
  src("a suffix stays, the name as written", "Visit", { name: "Bob Moss Jr.", company_name: null, type: "residential" }, null, "Bob Moss Jr."),
  src("a business by its own name", "Inspection", hoa, null, "Tahoe Test HOA"),
  src("a business and the work", "Walk-through: Pool lights", hoa, "  ", "Tahoe Test HOA · Pool lights"),
  src("a title that is only the customer", "Rita Moss", rita, null, "Rita Moss"),
  src("the old appointment fallback", "Job from appointment", rita, null, "Rita Moss"),
  src("call is the work when real words follow", "Call box install", rita, null, "Rita Moss · Call box install"),
  src("a phone call's words after the tag", "Phone call — Panel swap", rita, null, "Rita Moss · Panel swap"),
  src("a real name that merely contains the word", "RV Inspection", rita, null, "Rita Moss · RV Inspection"),
  src("a tag on a tag", "Site inspection: Estimate — Kitchen  rewire", rita, null, "Rita Moss · Kitchen rewire"),
  src("any case", "SITE INSPECTION:  kitchen rewire", rita, null, "Rita Moss · kitchen rewire"),
  src(
    "long work words are cut at a word, about 40 characters",
    "Estimate: Replace the panel, add two circuits, move the meter and patch the drywall",
    rita,
    null,
    "Rita Moss · Replace the panel, add two circuits",
  ),
  // No one and nowhere: the work alone, else New Job on the company's day.
  src("every separator: colon", "Estimate: Kitchen rewire", null, null, "Kitchen rewire"),
  src("every separator: en dash", "Estimate – Kitchen rewire", null, null, "Kitchen rewire"),
  src("every separator: hyphen", "Estimate - Kitchen rewire", null, null, "Kitchen rewire"),
  src("every separator: middle dot", "Lead · Kitchen rewire", null, null, "Kitchen rewire"),
  src("a hyphen glued to the word is not a separator", "Lead-free piping", null, null, "Lead-free piping"),
  src("a tag word inside a longer word", "Inspections Plus retrofit", null, null, "Inspections Plus retrofit"),
  src("a person with no card, no match", "Site inspection: Rich Test", null, null, "Rich Test"),
  src("no title, no one, nowhere", null, null, null, "New Job · Sep 27"),
  src("a blank title on another day", "  ", null, "  ", "New Job · Mar 5", null, "2026-03-05"),
  src("the bare tag, no one, nowhere", "Inspection", null, null, "New Job · Sep 27"),
  // 1. A name a person typed stays exactly as typed...
  typed("a typed name, as typed", "TTP #56", hoa, "300 West Lake Boulevard", "TTP #56", "56"),
  typed("a typed name that contains the word", "RV Inspection", rita, "12 Elm St", "RV Inspection"),
  typed("a typed tag and real words stay as typed", "Service call — Unit 4B", rita, "12 Elm St", "Service call — Unit 4B"),
  typed("the customer's name typed as the name", "Rita Moss", rita, "12 Elm St", "Rita Moss"),
  typed("typed spacing is tidied", "  Back   porch ", rita, "12 Elm St", "Back porch"),
  // ...unless it is only a tag, or a tag and who or where: then it is no name.
  typed("a typed bare tag", "Inspection", rita, "12 Elm St", "12 Elm St"),
  typed("a typed tag and the person", "Site inspection: Rita Moss", rita, "12 Elm St", "12 Elm St"),
  typed("a typed tag and the street", "Inspection — 12 Elm St", rita, "12 Elm St", "12 Elm St"),
  typed("a typed call and the person, no street", "Call Rita Moss", rita, null, "Rita Moss"),
  typed("a typed tag, no one, nowhere", "Walk-through", null, null, "New Job · Sep 27"),
  typed("a typed old fallback", "Job from appointment", rita, "12 Elm St", "12 Elm St"),
];
