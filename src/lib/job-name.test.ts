import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  isOnlyASourceTag,
  jobNameFrom,
  jobWho,
  leadScopeWords,
  stripSourceTag,
  streetOf,
  typedNameMayBeATag,
  visitStreetOf,
  SOURCE_TAGS,
} from "./job-name";
import { bookingTitle, WORK_KINDS } from "./schedule/work-shape";
import { JOB_NAME_CASES } from "./job-name.cases";

/**
 * A JOB'S NAME IS NEVER WHERE IT CAME FROM (Erik 2026-09-27): "site inspections are labeled with the
 * tag they shouldnt carry site inspection in the job title same goes for any conversion."
 *
 * The namer itself (every tag, every separator, any case, the real names that stay, the default when
 * nothing is left), then every door that makes a job, pinned to it.
 */
describe("stripSourceTag", () => {
  const SEPARATORS = [": ", ":", " — ", "—", " – ", " - ", "- ", " · ", " | "];
  const spelled: Record<string, string> = { "walk-through": "Walk-through", "walk through": "Walk through" };

  for (const tag of SOURCE_TAGS) {
    const Tag = spelled[tag] ?? tag.replace(/\b\w/g, (c) => c.toUpperCase());
    it(`"${Tag}" comes off the front, after every separator, any case`, () => {
      for (const sep of SEPARATORS) {
        expect(stripSourceTag(`${Tag}${sep}Kitchen rewire`)).toBe("Kitchen rewire");
        expect(stripSourceTag(`${Tag.toUpperCase()}${sep}Kitchen rewire`)).toBe("Kitchen rewire");
        expect(stripSourceTag(`${Tag.toLowerCase()}${sep}Kitchen rewire`)).toBe("Kitchen rewire");
      }
      // The bare tag, or the tag and a separator, is nothing.
      expect(stripSourceTag(Tag)).toBe("");
      expect(stripSourceTag(`  ${Tag}:  `)).toBe("");
    });
  }

  it("a real name that merely contains the word stays as typed", () => {
    for (const keep of ["RV Inspection", "Final Inspection Prep", "Lead Paint Abatement", "Lead-free piping", "Quotes binder", "Visitor center lights", "Estimated panel load"]) {
      expect(stripSourceTag(keep)).toBe(keep);
    }
  });

  it("the old stock fallbacks are nothing", () => {
    expect(stripSourceTag("Job from appointment")).toBe("");
    expect(stripSourceTag("Job from Q-0012")).toBe("");
    expect(stripSourceTag("job from q0012")).toBe("");
    expect(stripSourceTag("Job from the Moss family")).toBe("Job from the Moss family");
  });

  it("a tag on a tag comes off too; spacing is tidied", () => {
    expect(stripSourceTag("Site inspection: Estimate — Kitchen  rewire")).toBe("Kitchen rewire");
    expect(stripSourceTag(null)).toBe("");
    expect(stripSourceTag(undefined)).toBe("");
  });
});

describe("jobNameFrom: street number and name, as always (Erik 2026-09-28)", () => {
  for (const c of JOB_NAME_CASES) {
    it(`${c.why}: ${c.typed !== null ? `typed "${c.typed}"` : `words "${c.words}"`} → "${c.want}"`, () => {
      expect(
        jobNameFrom({ typed: c.typed, sourceWords: c.words, customer: c.customer, street: c.street, unit: c.unit, aliases: [c.alias], todayStr: c.today }),
      ).toBe(c.want);
    });
  }

  it("streetOf takes the street off a one-line address", () => {
    expect(streetOf("12 Elm St, Testville, CA 96161")).toBe("12 Elm St");
    expect(streetOf(null)).toBe("");
  });

  it("visitStreetOf: a visit booked at only a town has no street, so the job is who, never the town", () => {
    const place = { city: "Testville", state: "CA", zip: "96161" };
    expect(visitStreetOf("12 Elm St, Testville, CA 96161", place)).toBe("12 Elm St");
    expect(visitStreetOf("Testville, CA 96161", place)).toBe("");
    expect(visitStreetOf("Testville", { city: "Testville" })).toBe("");
    expect(visitStreetOf("CA 96161", { state: "CA", zip: "96161" })).toBe("");
    expect(visitStreetOf("96161", {})).toBe("");
    // The shape alone, when the visit's own columns are blank.
    expect(visitStreetOf("Testville, CA 96161", {})).toBe("");
    expect(visitStreetOf("Testville, CA", {})).toBe("");
    // A street line stays a street, with or without its town.
    expect(visitStreetOf("12 Elm St", {})).toBe("12 Elm St");
    expect(visitStreetOf("12 Elm St, Testville", place)).toBe("12 Elm St");
    expect(visitStreetOf(null, place)).toBe("");
    const rita = { name: "Rita Moss", company_name: null, type: "residential" };
    const name = (location: string) =>
      jobNameFrom({ sourceWords: "Site inspection: Rita Moss", customer: rita, street: visitStreetOf(location, place), todayStr: "2026-09-27" });
    expect(name("Testville, CA 96161")).toBe("Rita Moss");
    expect(name("12 Elm St, Testville, CA 96161")).toBe("12 Elm St");
  });

  it("isOnlyASourceTag: a bare tag or old fallback, nothing else", () => {
    for (const t of ["Service call", "Inspection", "  walk-through ", "Estimate:", "Job from appointment"]) expect(isOnlyASourceTag(t), t).toBe(true);
    for (const t of ["", "RV Inspection", "12 Elm St", "Service call — Panel swap", "Call box install"]) expect(isOnlyASourceTag(t), t).toBe(false);
  });

  it("a tag and a who/where part with real work between keeps the work", () => {
    const rita = { name: "Rita Moss", company_name: null, type: "residential" };
    expect(jobNameFrom({ sourceWords: "Site inspection: Rita Moss — Panel swap", customer: rita, todayStr: "2026-09-27" })).toBe("Rita Moss · Panel swap");
    // A typed name with real words stays as typed, tag and all.
    expect(jobNameFrom({ typed: "Site inspection: Rita Moss — Panel swap", customer: rita, street: "12 Elm St", todayStr: "2026-09-27" })).toBe(
      "Site inspection: Rita Moss — Panel swap",
    );
  });

  it("every stock title bookingTitle makes is no name: the job is the street, else the person, never the booking", () => {
    const rita = { name: "Rita Moss", company_name: null, type: "residential" };
    for (const kind of WORK_KINDS) {
      for (const who of ["Rita Moss", ""]) {
        const title = bookingTitle(kind, who);
        expect(jobNameFrom({ sourceWords: title, customer: rita, street: "12 Elm St", todayStr: "2026-09-27" }), title).toBe("12 Elm St");
        if (kind === "job") continue; // a job booking's title is the person, no tag
        expect(jobNameFrom({ sourceWords: title, customer: rita, street: null, todayStr: "2026-09-27" }), title).toBe("Rita Moss");
        expect(jobNameFrom({ typed: title, customer: rita, street: null, todayStr: "2026-09-27" }), title).toBe("Rita Moss");
      }
    }
  });

  it("a typed call form is no name only with who/where/nothing after it", () => {
    const rita = { name: "Rita Moss", company_name: null, type: "residential" };
    const at = (typed: string) => jobNameFrom({ typed, customer: rita, street: "12 Elm St", todayStr: "2026-09-27" });
    expect(at("Call Rita Moss")).toBe("12 Elm St");
    expect(at("call  rita moss")).toBe("12 Elm St");
    expect(at("Phone call Rita Moss")).toBe("12 Elm St");
    expect(at("Call 12 Elm St")).toBe("12 Elm St");
    expect(at("Call box install")).toBe("Call box install");
    expect(at("Call center rewire")).toBe("Call center rewire");
    expect(at("Callback: dead outlet")).toBe("Callback: dead outlet");
  });

  it("a typed name wins over a source's words; a source's words never win over the street", () => {
    const rita = { name: "Rita Moss", company_name: null, type: "residential" };
    const base = { customer: rita, street: "12 Elm St", todayStr: "2026-09-27" };
    expect(jobNameFrom({ ...base, typed: "Garage subpanel", sourceWords: "Estimate — Panel Upgrade" })).toBe("Garage subpanel");
    expect(jobNameFrom({ ...base, typed: "Inspection", sourceWords: "Estimate — Panel Upgrade" })).toBe("12 Elm St");
    expect(jobNameFrom({ ...base, street: null, typed: "Inspection", sourceWords: "Estimate — Panel Upgrade" })).toBe("Rita Moss · Panel Upgrade");
  });

  it("aliases: the lead's own spelling of who is only-who too (the visit title was built from it)", () => {
    const card = { name: "Richard Test", company_name: null, type: "residential" };
    const base = { sourceWords: "Site inspection: Rich Test", customer: card, street: null, todayStr: "2026-09-27" };
    expect(jobNameFrom(base)).toBe("Richard Test · Rich Test");
    expect(jobNameFrom({ ...base, aliases: ["Rich Test"] })).toBe("Richard Test");
    expect(jobNameFrom({ ...base, sourceWords: "Call Rich Test", aliases: ["Rich Test"] })).toBe("Richard Test");
    // An alias never eats real words.
    expect(jobNameFrom({ ...base, sourceWords: "Site inspection: Panel swap", aliases: ["Rich Test"] })).toBe("Richard Test · Panel swap");
    // With a street, the street, whatever the title.
    expect(jobNameFrom({ ...base, street: "12 Elm St" })).toBe("12 Elm St");
  });

  it("typedNameMayBeATag: only a blank, tagged or call-led name needs who and where read", () => {
    for (const t of ["", "  ", "Inspection", "Site inspection: Rita Moss", "Call Rita Moss", "Job from appointment"]) expect(typedNameMayBeATag(t), t).toBe(true);
    for (const t of ["RV Inspection", "Garage subpanel", "ARR #56"]) expect(typedNameMayBeATag(t), t).toBe(false);
  });

  it("leadScopeWords: the project type's head, else a one-line short message, never a paragraph", () => {
    expect(leadScopeWords({ projectType: "resurface", projectTypeLabel: "Resurface — new boards, keep the frame" })).toBe("Resurface");
    expect(leadScopeWords({ projectType: "repair", projectTypeLabel: "Repair (rot, damage, loose boards)" })).toBe("Repair");
    expect(leadScopeWords({ projectType: "new_deck", projectTypeLabel: "New deck", message: "3-way switches" })).toBe("New deck");
    expect(leadScopeWords({ projectType: "unsure", projectTypeLabel: "Not sure — I need help", message: "3-way switches" })).toBe("3-way switches");
    expect(leadScopeWords({ message: "  3-way   switches " })).toBe("3-way switches");
    expect(leadScopeWords({ message: "We bought the house last spring and the kitchen lights flicker whenever the fridge runs" })).toBe("");
    expect(leadScopeWords({ message: "Hot tub\ncircuit" })).toBe("");
    expect(leadScopeWords({})).toBe("");
  });
});

describe("jobWho: one order for the door and its preview", () => {
  const card = { name: "Richard Test", company_name: null, type: "residential" };
  const lead = { name: "Rich Test", company_name: "Test Builders", type: "commercial" };
  it("the first candidate with a name or company is who; the rest are aliases", () => {
    expect(jobWho([card, lead])).toEqual({ customer: card, aliases: ["Rich Test", "Test Builders"] });
  });
  it("a missing or blank card falls through to the lead", () => {
    expect(jobWho([null, lead])).toEqual({ customer: lead, aliases: [] });
    expect(jobWho([{ name: " ", company_name: null }, lead])).toEqual({ customer: lead, aliases: [] });
    expect(jobWho([null, null])).toEqual({ customer: null, aliases: [] });
  });
});

// ── EVERY DOOR THAT MAKES A JOB USES THE ONE NAMER ─────────────────────────────────────────────────
const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
/** The `.from("jobs") .insert({ … name: X` value in a file, one per insert ("name" for the shorthand `name,`). */
const insertNames = (src: string) =>
  [...src.matchAll(/from\("jobs"\)\s*\.insert\(\{[\s\S]*?\n\s*name(?::\s*([^,\n]+))?,/g)].map((m) => (m[1] ?? "name").trim());

describe("every door that inserts a job names it with jobNameFrom", () => {
  const DOORS: { file: string; name: string }[] = [
    { file: "src/app/(app)/appointments/actions.ts", name: "jobName" }, // createJobFromAppointment (Start The Job, Make Job)
    { file: "src/app/(app)/quotes/actions.ts", name: "jobName" }, // createJobFromQuote (office accepts)
    { file: "src/app/(app)/leads/actions.ts", name: "jobName" }, // convertInquiry → estimate / job
    { file: "src/app/(app)/jobs/actions.ts", name: "jobName" }, // importJobs
    { file: "src/app/(app)/schedule/actions.ts", name: "name" }, // createJob (New Job, Timeclock quick add, Nort job.create)
    // Recurring templates: the title is a name a person typed.
    { file: "src/lib/recurring-engine.ts", name: "jobNameFrom({ typed: title" },
  ];

  it("the list is every insert into jobs in the app (a new door has to join it)", () => {
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
        const p = `${dir}/${e.name}`;
        if (e.isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(e.name) && !/\.(test|integration\.test|db-suite|cases)\.tsx?$/.test(e.name) && !/\.db-fixture\.ts$/.test(e.name)) {
          if (insertNames(read(p)).length) found.push(p);
        }
      }
    };
    walk("src");
    expect(found.sort()).toEqual(DOORS.map((d) => d.file).sort());
  });

  for (const d of DOORS) {
    it(`${d.file} names its job through the one namer`, () => {
      const src = read(d.file);
      expect(src).toMatch(/from "@\/lib\/job-name"/);
      expect(src).toMatch(/jobNameFrom\(/);
      for (const n of insertNames(src)) expect(n.startsWith(d.name)).toBe(true);
      // The old source-tag names are gone.
      expect(src).not.toMatch(/Job from appointment"|`Job from \$\{|`Job — \$\{/);
    });
  }

  it("createJob runs a sent name through the namer as typed, with the job's unit (Nort's job.create lands here)", () => {
    const src = read("src/app/(app)/schedule/actions.ts");
    expect(src).toMatch(/if \(typedNameMayBeATag\(sentName\)\)/);
    expect(src).toMatch(/name = jobNameFrom\(\{\s*typed: sentName,[\s\S]*?street: address,\s*unit: emptyToNull\(formData\.get\("unit"\)\),/);
    expect(read("src/lib/actions/entities/job.ts")).toMatch(/return createJob\(fd\)/);
    // The New Job form's live line is the same default, unit and all.
    expect(read("src/app/(app)/schedule/new-job-button.tsx")).toMatch(
      /willBeCalled = defaultJobName\(\{ customer: picked, street: form\.address, unit: form\.unit, todayStr: today \}\)/,
    );
  });

  it("the visit page's Start The Job preview names the job the same way the door will", () => {
    const src = read("src/app/(app)/appointments/[id]/page.tsx");
    expect(src).toMatch(/previewJobName = jobNameFrom\(\{\s*sourceWords: a\.title,/);
    expect(src).toMatch(/street: visitStreetOf\(a\.location, a\),\s*unit: \(a as \{ unit\?: string \| null \}\)\.unit \?\? null,/);
    expect(src).toMatch(/location, unit, city, state, zip, notes/); // PROJECTION LAW: the unit and the town are selected
    expect(src).toMatch(/name: previewJobName/);
    expect(src).not.toMatch(/Job from appointment/);
    // Who, in the door's order: the visit's card, else the lead's card, else the lead; the rest are aliases.
    expect(src).toMatch(/jobWho\(\[a\.customer_id \? a\.customers : leadCard, a\.inquiries \?\? null\]\)/);
    expect(src).toMatch(/aliases: previewWho\.aliases/);
    const door = read("src/app/(app)/appointments/actions.ts");
    expect(door).toMatch(/jobWho\(\[card, lead\]\)/);
    // The card first, else the lead's; a fresh lead's card is minted after (209451e1), which only
    // changes who the job is FOR, never the order the preview and the door say who.
    expect(door).toMatch(/let customerId = appt\.customer_id \?\? lead\?\.customer_id \?\? null/);
    expect(door).toMatch(/if \(!customerId && inquiryId\) customerId = await customerForInquiry\(supabase, inquiryId, ctx\.userId\);/);
    expect(door).toMatch(/jobNameFrom\(\{\s*sourceWords: appt\.title,\s*customer: who,\s*aliases,[\s\S]*?street: visitStreetOf\(appt\.location, appt\),\s*unit: apptUnit,/);
    expect(door).toMatch(/location, unit, city/);
    expect(door).toMatch(/unit: apptUnit, \/\/ the visit's unit is the job's/);
  });

  it("a lead's job is named for the card it links to, its street and unit, else its short scope words", () => {
    const src = read("src/app/(app)/leads/actions.ts");
    expect(src).toMatch(/mintedFromLead = true;/);
    expect(src).toMatch(/if \(!mintedFromLead && customerId\) \{\s*const \{ data: c \} = await supabase\.from\("customers"\)\.select\("name, company_name, type"\)\.eq\("id", customerId\)/);
    expect(src).toMatch(/sourceWords: leadScopeWords\(\{/);
    expect(src).toMatch(/customer: jobWho\(\[card, leadWho\]\)\.customer,\s*street: inq\.address,\s*unit: inq\.unit,/);
    expect(src).toMatch(/unit: inq\.unit \?\? null, \/\/ the lead's unit is the job's/);
  });

  it("the lead door never seeds 'Not sure — I need help' as an estimate's title", () => {
    const src = read("src/app/(app)/leads/actions.ts");
    expect(src).toMatch(/title: label && inq\.project_type !== "unsure" \? `\$\{label\} — \$\{inq\.name\}` : `Estimate — \$\{inq\.name\}`,/);
  });

  it("the Timeclock's quick add refuses a tag-only name and echoes the name the job was saved under", () => {
    const src = read("src/app/(app)/timeclock/new-job-inline.tsx");
    expect(src).toMatch(/if \(isOnlyASourceTag\(trimmed\)\) \{/);
    expect(src).toMatch(/onCreated\(\{ id: res\.id, name: res\.name \|\| trimmed \}\)/);
    expect(read("src/app/(app)/schedule/actions.ts")).toMatch(/return \{ ok: true, id: data\.id, name \};/);
  });

  it("the office's estimate accept names the job for the street and unit it inherits, the lead's spelling as who", () => {
    const src = read("src/app/(app)/quotes/actions.ts");
    expect(src).toMatch(/sourceWords: q\.title,\s*aliases: \[\(leadForName as \{ name\?: string \| null \} \| null\)\?\.name\],[\s\S]*?street: inheritedAddress\?\.address \?\? null,\s*unit: inheritedAddress\?\.unit \?\? null,/);
    expect(src).toMatch(/from\("inquiries"\)\.select\("name"\)\.eq\("id", q\.inquiry_id\)/);
    expect(src).toMatch(/unit: inheritedAddress\.unit \?\? null,/);
    expect(src.match(/select\("address, unit, city, state, zip"\)/g)?.length).toBe(2);
  });

  it("an import names its job after the customer is found or made, the sheet's job name as typed", () => {
    const src = read("src/app/(app)/jobs/actions.ts");
    const body = src.slice(src.indexOf("export async function importJobs"));
    const named = body.indexOf("const jobName = jobNameFrom({ typed: r.job_name,");
    expect(named).toBeGreaterThan(body.indexOf('.from("customers")'));
    expect(named).toBeLessThan(body.indexOf('.from("jobs")'));
    expect(body).toMatch(/select\("id, name, company_name, type"\)/);
    expect(body).toMatch(/who = \{ company_name: cname \}/);
  });

  it("the public estimate accept names it through the SQL twin (0369), never 'Job from ' || quote_number", () => {
    const dir = join(ROOT, "supabase/migrations");
    const latest = readdirSync(dir)
      .filter((n) => /\.sql$/.test(n) && /function public\.accept_public_quote/.test(readFileSync(join(dir, n), "utf8")))
      .sort()
      .pop()!;
    expect(latest).toMatch(/^0369_/);
    const sql = readFileSync(join(dir, latest), "utf8");
    // No typed name; the estimate's title as the source's words; the street's own unit.
    expect(sql).toMatch(/public\.job_name_from\(null, q\.title,/);
    expect(sql).toMatch(/case when coalesce\(site_address, ''\) <> '' then site_unit else cust\.unit end,\s*inq\.name,/);
    const code = sql.slice(sql.indexOf("create or replace function public.accept_public_quote")).replace(/--.*$/gm, "");
    expect(code).not.toMatch(/'Job from '/);
  });
});
