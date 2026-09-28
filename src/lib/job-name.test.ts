import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { jobNameFrom, stripSourceTag, streetOf, SOURCE_TAGS } from "./job-name";
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
    { file: "src/lib/recurring-engine.ts", name: "jobNameFrom({ title" }, // recurring templates
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
    expect(src).toMatch(/name: jobNameFrom\(\{\s*title: a\.title/);
    expect(src).not.toMatch(/Job from appointment/);
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
