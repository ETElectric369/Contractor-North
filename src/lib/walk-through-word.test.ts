import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { appointmentTypeLabel } from "@/lib/statuses";
import { bookingTitle, KIND_LABEL } from "@/lib/schedule/work-shape";
import { apptEventBody } from "@/lib/gcal-map";
import { DOCK } from "@/lib/dock";
import { FEATURES } from "@/lib/features";

/**
 * ONE WORD FOR THE SITE VISIT (W2-10). The visit before a price is a Walk-Through wherever staff or
 * Nort read it; "Inspection" is left to the city's inspection (the permit, the Permits & Inspections
 * switch, the legacy Final Inspection). Words only: the route (/inspections), the stored type
 * ('inspection') and every stored title stay as they are.
 */
const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("the site visit is a Walk-Through", () => {
  it("the type's label, the kind's chip and the dock row all say it", () => {
    expect(appointmentTypeLabel("inspection")).toBe("Walk-Through");
    expect(KIND_LABEL.walkthrough).toBe("Walk-Through");
    const row = DOCK.find((s) => s.key === "sales")?.children.find((c) => c.id === "sl-inspections");
    expect(row).toMatchObject({ label: "Walk-Throughs", href: "/inspections" });
  });

  it("a new walk-through's stock title is the word and who it's with", () => {
    expect(bookingTitle("walkthrough", "Matt Warren")).toBe("Walk-Through: Matt Warren");
  });

  it("the city's inspection keeps its word", () => {
    expect(appointmentTypeLabel("final_inspection")).toBe("Final Inspection");
    expect(FEATURES.find((f) => f.key === "permits")?.label).toBe("Permits & Inspections");
  });

  it("Nort's appointment and lead tools never call the site visit a site inspection", () => {
    for (const f of ["src/lib/actions/entities/appointment.ts", "src/lib/actions/entities/inquiry.ts"]) {
      expect(read(f).toLowerCase(), f).not.toContain("site inspection");
    }
    // …and appointment.create tells Nort which word means which.
    expect(read("src/lib/actions/entities/appointment.ts")).toContain(
      'Title a site visit \\"Walk-Through: <customer or place>\\"; \\"inspection\\" means the city\'s inspection on a permit.',
    );
  });

  it("an Other visit reaches Google with no bracket prefix; a walk-through reads [Walk-Through]", () => {
    const visit = { id: "a1", title: "Dentist", starts_at: "2026-10-01T16:00:00.000Z", ends_at: null, location: null, notes: null };
    expect(apptEventBody({ ...visit, type: "other" }).summary).toBe("Dentist");
    expect(apptEventBody({ ...visit, type: "other" }).summary).not.toMatch(/^\[/);
    expect(apptEventBody({ ...visit, type: "inspection", title: "Rough-in walk" }).summary).toBe("[Walk-Through] Rough-in walk");
  });

  it("the setup interview is setup, so the one word means only the site visit", () => {
    expect(read("src/lib/onboarding/help-rows.ts")).toContain('"Setup from the top. Change anything you told Nort."');
    const s = read("src/components/setup-interview.tsx");
    expect(s).toContain("Take setup again from Search Or Ask and tell me your trade");
    expect(s).toContain(">This setup</strong>");
    expect(s).not.toContain("Take the walk-through again");
  });
});

/**
 * AND THE OLD WORD CANNOT COME BACK ANYWHERE (report 04a9369a, 2026-10-02: "walk-through's are the
 * same as inspections, correct? If so, let's keep the verbiage consistent"). W2-10 renamed about 42
 * files, but the tests above only check the files they name, so five on-screen uses of the old word
 * survived where nobody had listed them: the New Estimate scope box's first line, Settings' "your
 * inspector asks" paragraph and its unsaved bar, the Crew plan's "inspection sheets written", and
 * Nort's visit_days_ahead. This sweep reads EVERY source file instead.
 *
 * WHAT COUNTS: every word a person could read or Nort could say — string literals, template chunks
 * and JSX text, by the compiler's own reading of the file, so a comment or an identifier never trips
 * it. WHAT DOESN'T: code. An identifier, enum value, column, route or import path is lowercase with
 * no spaces (inspection, is_inspection, inspection_writeup, /inspections, @/lib/inspection/capture,
 * inspect-date), and a `select` hands Postgres a comma-separated list of those. A CAPITALISED word is
 * a label, so "Inspector" and "Inspection date" are words and still count.
 *
 * THE KNOWN HOLE: a lone lowercase word ("inspection") reads as code here, so a tag or button label
 * written in lowercase would slip through. That is one more reason /inspections draws its tags from
 * one rule (lib/inspections inspectionRowTags) whose labels this sweep reads.
 */
const ROOT = process.cwd();
const WORD = /inspect/i;

/** One code token: an identifier, enum value, dotted key, kebab id, route or import path. */
const TOKEN = /^[@./]*[a-z0-9_$]+(?:[-./:?=&][a-z0-9_$]+)*[:/]?$/;

/** True when the literal is code, not words — one token, or the comma-separated column list a
 *  `select` hands Postgres ("id, schema, is_inspection, form_submissions(id)"). */
function isCode(text: string): boolean {
  const parts = text
    .trim()
    .split(/[,()]/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  return parts.length > 0 && parts.every((p) => TOKEN.test(p));
}

/**
 * THE WORD STAYS IN THESE FILES, and the reason it stays. Everything not named here is swept — which
 * is what holds the five fixes below, each in a file deliberately left off this list.
 */
const KEEPS_THE_WORD: Record<string, string> = {
  // THE CITY'S INSPECTION on a permit — a genuinely different thing, which keeps the word.
  "src/lib/features.ts": "the Permits & Inspections switch and its line",
  "src/lib/permit-options.ts": "the permit status Inspection scheduled",
  "src/lib/statuses.ts": "the legacy final_inspection type's label, Final Inspection",
  "src/lib/trade-code-packs.ts": "the Inspection / permit job-code category",
  "src/app/(app)/permits/": "a permit's inspection date, inspector and result",
  "src/app/(app)/jobs/[id]/job-permits.tsx": "the same three fields, on the job",
  "src/app/(app)/jobs/[id]/page.tsx": "the job's permit line: Inspection <date> · <inspector>",
  "src/app/(app)/jobs/[id]/job-contacts.tsx": "the Inspector job-contact role",
  "src/app/(app)/resources/": "Resources: building departments and their inspectors",
  "src/app/(app)/audits/audits-manager.tsx": "an OSHA inspector — a person, never a site visit",
  "src/app/(app)/forms/form-editor.tsx": "the sheet-name placeholder, e.g. Final Inspection",
  "src/lib/reading/proposals.ts": "an inspection report, a paper a customer hands over",
  "src/lib/playbook/starters/et-electric.ts": "Erik's own quoted notes, and the city's inspection before cover",
  // LEGACY STORED TITLES — rows already in the database say the old word, so this code must match it.
  "src/lib/job-name.ts": "SOURCE_TAGS strips 'Site inspection: ' off an old stored title",
  "src/app/(app)/appointments/actions.ts": "the STOCK title lists that recognise an old title",
  // NORT, told which word means which, or naming a person.
  "src/lib/actions/entities/": "the stored type is 'inspection', and an inspector is a contact",
  "src/lib/assistant-tools.ts": "the permit, resource and job-contact tools (visit_days_ahead is pinned below)",
  "src/lib/nort-product-map.ts": "the product map says the city keeps the word",
  "src/app/api/chat/route.ts": "Resources holds a permit office, inspector, supplier",
  "src/app/(app)/organize/": "the paperwork reader's example note, call inspector Tuesday",
};

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    // *.cases.ts is a test's fixture table (job-name's legacy stored titles), not app words.
    else if (/\.tsx?$/.test(p) && !/\.(test|cases|db-suite|db-fixture)\.tsx?$/.test(p) && !/\.d\.ts$/.test(p)) out.push(p);
  }
  return out;
}

/** Every literal a person could read, with its line, by the compiler's own reading of the file. */
function wordsIn(file: string): { line: number; text: string }[] {
  const src = readFileSync(join(ROOT, file), "utf8");
  if (!WORD.test(src)) return [];
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: { line: number; text: string }[] = [];
  const add = (n: ts.Node, text: string) => out.push({ line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, text });
  const walk = (n: ts.Node) => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) add(n, n.text);
    else if (ts.isTemplateExpression(n)) {
      add(n.head, n.head.text);
      for (const s of n.templateSpans) add(s.literal, s.literal.text);
    } else if (ts.isJsxText(n)) add(n, n.getText(sf));
    ts.forEachChild(n, walk);
  };
  walk(sf);
  return out;
}

describe("the old word cannot come back", () => {
  const files = sourceFiles(join(ROOT, "src")).map((f) => relative(ROOT, f));

  it("scans the whole app, Nort included", () => {
    expect(files.length).toBeGreaterThan(500);
    for (const f of ["src/app/(app)/quotes/new/page.tsx", "src/app/(app)/settings/page.tsx", "src/lib/plans.ts", "src/lib/assistant-tools.ts"]) {
      expect(files).toContain(f);
    }
  });

  it("the rule reads code as code and a label as a word", () => {
    for (const s of [
      "inspection",
      "is_inspection",
      "inspection_writeup",
      "/inspections",
      "/inspections?view=completed",
      "@/lib/inspection/capture",
      "../../appointments/new-inspection-button",
      "inspect-date",
      "inspect-org:",
      "inspection.answers",
      "id, name, schema, is_inspection, is_public_intake, form_submissions(id)",
      "is_inspection.eq.true,is_public_intake.eq.true",
    ]) {
      expect(isCode(s), s).toBe(true);
    }
    for (const s of [
      "From site inspection — Kitchen rewire",
      "These are the questions your inspector asks on site",
      "your inspector still asks the old questions",
      "your inspection sheets written",
      "(inspections / quote visits)",
      "Field forms — safety checklists, inspections, sign-offs.",
      "Inspector",
      "Inspection date",
      "site inspection",
    ]) {
      expect(isCode(s), s).toBe(false);
    }
  });

  it("finds none outside the allowlist", () => {
    const allowed = Object.keys(KEEPS_THE_WORD);
    const hits = files
      .filter((f) => !allowed.some((a) => f === a || f.startsWith(a)))
      .flatMap((f) =>
        wordsIn(f)
          .filter((w) => WORD.test(w.text) && !isCode(w.text))
          .map((w) => `${f}:${w.line}: ${w.text.replace(/\s+/g, " ").trim().slice(0, 140)}`),
      );
    expect(hits).toEqual([]);
  }, 60_000);

  it("no allowlist entry outlives its reason: each path exists and still says the word", () => {
    for (const [p, reason] of Object.entries(KEEPS_THE_WORD)) {
      expect(reason.length, p).toBeGreaterThan(10);
      const covered = files.filter((f) => f === p || f.startsWith(p));
      expect(covered.length, `${p} covers no source file`).toBeGreaterThan(0);
      expect(covered.some((f) => wordsIn(f).some((w) => WORD.test(w.text))), `${p} no longer says it`).toBe(true);
    }
  }, 60_000);

  it("the five the W2-10 sweep missed now say Walk-Through", () => {
    // The scope box the estimator opens from a walk-through (the same line the parked v2 editor
    // already carries, so a later merge has nothing to resolve).
    expect(read("src/app/(app)/quotes/new/page.tsx")).toContain("`From the walk-through — ${(appt as any).title}");
    // Settings' sheet: the paragraph under "What your walk-through asks", and its unsaved bar.
    expect(read("src/app/(app)/settings/page.tsx")).toContain("These are the questions your walk-through asks on site");
    expect(read("src/app/(app)/settings/playbook-manager.tsx")).toContain('"your walk-through still asks the old questions"');
    // What we promise to set up with a Crew customer.
    expect(read("src/lib/plans.ts")).toContain("your walk-through sheet written");
    // Nort's own words for the day-clustering tool. assistant-tools.ts is allowlisted for the permit,
    // resource and contact tools, so this one line is pinned by name.
    expect(read("src/lib/assistant-tools.ts")).toContain("(walk-throughs / quote visits, the site visit before a price)");
    expect(read("src/lib/assistant-tools.ts")).not.toContain("(inspections / quote visits)");
  });
});
