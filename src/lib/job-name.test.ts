import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { jobNameFrom, jobWho, stripSourceTag, streetOf, SOURCE_TAGS } from "./job-name";
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

describe("jobNameFrom", () => {
  for (const c of JOB_NAME_CASES) {
    it(`${c.why}: "${c.title}" → "${c.want}"`, () => {
      expect(jobNameFrom({ title: c.title, customer: c.customer, street: c.street, todayStr: c.today })).toBe(c.want);
    });
  }

  it("streetOf takes the street off a one-line address", () => {
    expect(streetOf("12 Elm St, Testville, CA 96161")).toBe("12 Elm St");
    expect(streetOf(null)).toBe("");
  });

  it("every stock title bookingTitle makes is no name: the job is named who · where, never the booking", () => {
    const rita = { name: "Rita Moss", company_name: null, type: "residential" };
    for (const kind of WORK_KINDS) {
      if (kind === "job") continue; // a job booking's title is the person, no tag (kept as typed)
      for (const who of ["Rita Moss", ""]) {
        const title = bookingTitle(kind, who);
        expect(jobNameFrom({ title, customer: rita, street: "12 Elm St", todayStr: "2026-09-27" }), title).toBe("Moss · 12 Elm St");
      }
    }
  });

  it("the call form is a tag only with who/where/nothing after it", () => {
    const rita = { name: "Rita Moss", company_name: null, type: "residential" };
    const at = (title: string) => jobNameFrom({ title, customer: rita, street: "12 Elm St", todayStr: "2026-09-27" });
    expect(at("Call Rita Moss")).toBe("Moss · 12 Elm St");
    expect(at("call  rita moss")).toBe("Moss · 12 Elm St");
    expect(at("Phone call Rita Moss")).toBe("Moss · 12 Elm St");
    expect(at("Call 12 Elm St")).toBe("Moss · 12 Elm St");
    expect(at("Call box install")).toBe("Call box install");
    expect(at("Call center rewire")).toBe("Call center rewire");
    expect(at("Callback: dead outlet")).toBe("Callback: dead outlet");
  });

  it("aliases: the lead's own spelling of who is only-who too (the visit title was built from it)", () => {
    const card = { name: "Richard Test", company_name: null, type: "residential" };
    const base = { title: "Site inspection: Rich Test", customer: card, street: "12 Elm St", todayStr: "2026-09-27" };
    expect(jobNameFrom(base)).toBe("Rich Test");
    expect(jobNameFrom({ ...base, aliases: ["Rich Test"] })).toBe("Test · 12 Elm St");
    expect(jobNameFrom({ ...base, title: "Call Rich Test", aliases: ["Rich Test"] })).toBe("Test · 12 Elm St");
    // An alias never eats real words.
    expect(jobNameFrom({ ...base, title: "Site inspection: Panel swap", aliases: ["Rich Test"] })).toBe("Panel swap");
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
    // Recurring templates: the typed title as the work (not a conversion), the namer only when blank.
    { file: "src/lib/recurring-engine.ts", name: "title || jobNameFrom({ title: null" },
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

  it("createJob runs a sent name through the namer (Nort's job.create lands here)", () => {
    const src = read("src/app/(app)/schedule/actions.ts");
    expect(src).toMatch(/name = jobNameFrom\(\{ title: sentName/);
    expect(read("src/lib/actions/entities/job.ts")).toMatch(/return createJob\(fd\)/);
  });

  it("the visit page's Start The Job preview names the job the same way the door will", () => {
    const src = read("src/app/(app)/appointments/[id]/page.tsx");
    expect(src).toMatch(/previewJobName = jobNameFrom\(\{\s*title: a\.title/);
    expect(src).toMatch(/name: previewJobName/);
    expect(src).not.toMatch(/Job from appointment/);
    // Who, in the door's order: the visit's card, else the lead's card, else the lead; the rest are aliases.
    expect(src).toMatch(/jobWho\(\[a\.customer_id \? a\.customers : leadCard, a\.inquiries \?\? null\]\)/);
    expect(src).toMatch(/aliases: previewWho\.aliases/);
    const door = read("src/app/(app)/appointments/actions.ts");
    expect(door).toMatch(/jobWho\(\[card, lead\]\)/);
    expect(door).toMatch(/const customerId = appt\.customer_id \?\? lead\?\.customer_id \?\? null/);
    expect(door).toMatch(/jobNameFrom\(\{ title: appt\.title, customer: who, aliases,/);
  });

  it("a lead's job is named for the card it links to, the lead's own fields only for a card just made from them", () => {
    const src = read("src/app/(app)/leads/actions.ts");
    expect(src).toMatch(/mintedFromLead = true;/);
    expect(src).toMatch(/if \(!mintedFromLead && customerId\) \{\s*const \{ data: c \} = await supabase\.from\("customers"\)\.select\("name, company_name, type"\)\.eq\("id", customerId\)/);
    expect(src).toMatch(/customer: jobWho\(\[card, leadWho\]\)\.customer/);
  });

  it("an import names its job after the customer is found or made, from the card as stored", () => {
    const src = read("src/app/(app)/jobs/actions.ts");
    const body = src.slice(src.indexOf("export async function importJobs"));
    const named = body.indexOf("const jobName = jobNameFrom(");
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
    expect(sql).toMatch(/public\.job_name_from\(q\.title,/);
    const code = sql.slice(sql.indexOf("create or replace function public.accept_public_quote")).replace(/--.*$/gm, "");
    expect(code).not.toMatch(/'Job from '/);
  });
});
