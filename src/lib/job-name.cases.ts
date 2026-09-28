/**
 * The cases both namers answer: src/lib/job-name.ts jobNameFrom (job-name.test.ts) and its SQL twin
 * public.job_name_from, 0369 (job-name.integration.test.ts). Same input, same name, or the public
 * estimate accept and the office's accept name the same job two ways. Synthetic people and streets.
 */
export type JobNameCase = {
  why: string;
  title: string | null;
  customer: { name?: string | null; company_name?: string | null; type?: string | null } | null;
  street: string | null;
  today: string;
  want: string;
};

const rita = { name: "Rita Moss", company_name: null, type: "residential" };
const T = "2026-09-27";

export const JOB_NAME_CASES: JobNameCase[] = [
  // The stock titles: a tag and the person is no name; the default says who and where.
  { why: "a visit's stock title", title: "Site inspection: Rita Moss", customer: rita, street: "12 Elm St", today: T, want: "Moss · 12 Elm St" },
  { why: "an old booking, em dash", title: "Service call — Rita Moss", customer: rita, street: "12 Elm St", today: T, want: "Moss · 12 Elm St" },
  { why: "the lead door's seeded estimate", title: "Estimate — Rita Moss", customer: rita, street: "12 Elm St", today: T, want: "Moss · 12 Elm St" },
  { why: "a quote booking", title: "Quote: Rita Moss", customer: rita, street: null, today: T, want: "Moss" },
  { why: "a tag and the street", title: "Inspection — 12 Elm St", customer: rita, street: "12 Elm St", today: T, want: "Moss · 12 Elm St" },
  { why: "a tag and the whole address line", title: "Site visit: 12 Elm St, Testville, CA", customer: null, street: "12 Elm St", today: T, want: "12 Elm St" },
  { why: "a business by its own name", title: "Walk-through: Tahoe Test HOA", customer: { name: "Pat Lee", company_name: "Tahoe Test HOA", type: "commercial" }, street: "300 Test Blvd", today: T, want: "Tahoe Test HOA · 300 Test Blvd" },
  // The phone-call booking's stock title has no separator (bookingTitle "call"): who/where/nothing after "Call".
  { why: "a phone-call booking", title: "Call Rita Moss", customer: rita, street: "12 Elm St", today: T, want: "Moss · 12 Elm St" },
  { why: "a phone-call booking with no name", title: "Call Visit", customer: rita, street: "12 Elm St", today: T, want: "Moss · 12 Elm St" },
  { why: "a phone call and the street", title: "Phone call 12 Elm St", customer: null, street: "12 Elm St", today: T, want: "12 Elm St" },
  { why: "call with a separator", title: "Call: Rita Moss", customer: rita, street: null, today: T, want: "Moss" },
  { why: "call is the work when real words follow", title: "Call box install", customer: rita, street: "12 Elm St", today: T, want: "Call box install" },
  { why: "a phone call's words after the tag", title: "Phone call — Panel swap", customer: rita, street: "12 Elm St", today: T, want: "Panel swap" },
  // The work's own words, with the tag taken off.
  { why: "the words after the tag", title: "Service call — Panel swap", customer: rita, street: "12 Elm St", today: T, want: "Panel swap" },
  { why: "every separator: colon", title: "Estimate: Kitchen rewire", customer: null, street: null, today: T, want: "Kitchen rewire" },
  { why: "every separator: en dash", title: "Estimate – Kitchen rewire", customer: null, street: null, today: T, want: "Kitchen rewire" },
  { why: "every separator: hyphen", title: "Estimate - Kitchen rewire", customer: null, street: null, today: T, want: "Kitchen rewire" },
  { why: "every separator: middle dot", title: "Lead · Kitchen rewire", customer: null, street: null, today: T, want: "Kitchen rewire" },
  { why: "any case", title: "SITE INSPECTION:  kitchen rewire", customer: null, street: null, today: T, want: "kitchen rewire" },
  { why: "a person with no card, no match", title: "Site inspection: Rich Test", customer: null, street: null, today: T, want: "Rich Test" },
  { why: "a tag on a tag", title: "Site inspection: Visit", customer: rita, street: "12 Elm St", today: T, want: "Moss · 12 Elm St" },
  // A real name that merely contains the word stays.
  { why: "RV Inspection is the work", title: "RV Inspection", customer: rita, street: "12 Elm St", today: T, want: "RV Inspection" },
  { why: "Lead Paint is the work", title: "Lead Paint Abatement", customer: null, street: null, today: T, want: "Lead Paint Abatement" },
  { why: "a hyphen glued to the word is not a separator", title: "Lead-free piping", customer: null, street: null, today: T, want: "Lead-free piping" },
  { why: "a tag word inside a longer word", title: "Inspections Plus retrofit", customer: null, street: null, today: T, want: "Inspections Plus retrofit" },
  { why: "the customer's name typed as the name, no tag", title: "Rita Moss", customer: rita, street: "12 Elm St", today: T, want: "Rita Moss" },
  // Nothing left: the default.
  { why: "the bare tag", title: "Inspection", customer: rita, street: "12 Elm St", today: T, want: "Moss · 12 Elm St" },
  { why: "the old appointment fallback", title: "Job from appointment", customer: rita, street: null, today: T, want: "Moss" },
  { why: "the old quote fallback", title: "Job from Q-0012", customer: null, street: "12 Elm St", today: T, want: "12 Elm St" },
  { why: "no title, no one, nowhere", title: null, customer: null, street: null, today: T, want: "New Job · Sep 27" },
  { why: "a blank title on another day", title: "  ", customer: null, street: "  ", today: "2026-03-05", want: "New Job · Mar 5" },
  { why: "a suffix is not a last name", title: "Visit", customer: { name: "Bob Moss Jr.", company_name: null, type: "residential" }, street: null, today: T, want: "Moss" },
];
