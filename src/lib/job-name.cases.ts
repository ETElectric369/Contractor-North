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
  /** Another spelling of who the words may carry (the lead's own name: jobNameFrom's aliases, the
   *  SQL twin's p_alias). */
  alias?: string | null;
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
  src("a unit complex", "Site inspection: Tahoe Test HOA", hoa, "300 West Garnet Boulevard", "300 West Garnet Boulevard #56", "56"),
  src("a unit typed with its #", null, rita, "300 West Garnet Boulevard", "300 West Garnet Boulevard #56", "#56"),
  src("a unit typed as Unit", null, rita, "300 West Garnet Boulevard", "300 West Garnet Boulevard #56", "Unit 56"),
  src("a unit typed as Apt.", null, rita, "300 West Garnet Boulevard", "300 West Garnet Boulevard #4B", "Apt. 4B"),
  src("a street that already carries the unit", null, rita, "300 West Garnet Boulevard #56", "300 West Garnet Boulevard #56", "56"),
  src("a blank unit", null, rita, "300 West Garnet Boulevard", "300 West Garnet Boulevard", "  "),
  // 3. No street: who as written, then the source's work words.
  src("an estimate's work words", "Estimate — Panel Upgrade", { name: "Marla Test", company_name: null, type: "residential" }, null, "Marla Test · Panel Upgrade"),
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
  typed("a typed name, as typed", "ARR #56", hoa, "300 West Garnet Boulevard", "ARR #56", "56"),
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
  // ...a tag and who AND where, in any order, is no name too; so is a tag and the street with its unit.
  typed("a typed tag, the person and the street", "Inspection: Rita Moss, 12 Elm St", rita, "12 Elm St", "12 Elm St"),
  typed("a typed tag, the person and the street, dashes", "Service call — Rita Moss — 12 Elm St", rita, "12 Elm St", "12 Elm St"),
  typed("a typed tag and the street with its unit", "Site inspection: 12 Elm St #4", rita, "12 Elm St", "12 Elm St #4", "4"),
  typed("a typed tag and the street with its unit spelled out", "Inspection — 12 Elm St Apt 4", rita, "12 Elm St", "12 Elm St #4", "Apt 4"),

  // The lead door's seeded estimate, "<label> — <the lead's name>", accepted with no street anywhere:
  // the name at the end is who, never work words.
  src("a seeded estimate's label and the name, no street", "New deck — Rita Moss", rita, null, "Rita Moss · New deck"),
  src("a seeded estimate's long label and the name", "Resurface — new boards, keep the frame — Rita Moss", rita, null, "Rita Moss · Resurface — new boards, keep the frame"),
  src("the name at the front, then the work", "Rita Moss — Panel swap", rita, null, "Rita Moss · Panel swap"),
  src("a business named after the work", "Panel swap — Tahoe Test HOA", hoa, null, "Tahoe Test HOA · Panel swap"),
  src("the work with a comma stays whole", "Replace the panel, add two circuits", rita, null, "Rita Moss · Replace the panel, add two circuits"),
  { ...src("the lead's own spelling (a card matched by phone)", "Estimate — rita", rita, null, "Rita Moss"), alias: "rita" },
  { ...src("the lead's own spelling after the work", "New deck — rita", rita, null, "Rita Moss · New deck"), alias: "rita" },

  // The unit is never on the name twice, however the street line already spells it.
  src("a street that spells the unit as Apt", null, rita, "12 Elm St Apt 5", "12 Elm St Apt 5", "Apt 5"),
  src("a street that spells the unit as Unit, a bare unit", null, rita, "12 Elm St Unit 4", "12 Elm St Unit 4", "4"),
  src("a street with a spaced #", null, rita, "12 Elm St # 4", "12 Elm St # 4", "4"),
  src("a street that spells the unit as Suite", null, rita, "12 Elm St Suite 200, Testville", "12 Elm St Suite 200", "Suite 200"),
  src("a street whose unit only ends in the same digit", null, rita, "12 Elm St Apt 45", "12 Elm St Apt 45 #5", "5"),

  // A PO box has no street number and street name: who and the work instead.
  src("a PO box is no street", "Panel Upgrade", rita, "PO Box 123, Testville", "Rita Moss · Panel Upgrade"),
  src("a P.O. box, no one", null, null, "P.O. Box 44 Testville CA 96118", "New Job · Sep 27"),

  // Any script: a name with no a-z in it is still who.
  src("a Cyrillic name in a visit's stock title", "Site inspection: Иван Петров", { name: "Иван Петров", company_name: null, type: "residential" }, null, "Иван Петров"),
  src("a CJK name in a call booking", "Call 李明", { name: "李明", company_name: null, type: "residential" }, null, "李明"),
  src("accents don't make two spellings", "Site inspection: Jose Garcia", { name: "José García", company_name: null, type: "residential" }, null, "José García"),
  typed("a typed tag and a Cyrillic name is no name", "Site inspection: Иван Петров", { name: "Иван Петров", company_name: null, type: "residential" }, "12 Elm St", "12 Elm St"),

  // Work words are counted in characters: an emoji is one, and is never cut in half.
  src("an emoji counts as one character", "Replace kitchen lights and add dimmers 💡", rita, null, "Rita Moss · Replace kitchen lights and add dimmers 💡"),
  src("an emoji at the front of long words", "🔌 Replace the main panel and add two new circuits", rita, null, "Rita Moss · 🔌 Replace the main panel and add two new"),
  src("a long run with no space and an emoji at the cut", "Aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa🔌more", rita, null, "Rita Moss · Aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa🔌m"),
];
