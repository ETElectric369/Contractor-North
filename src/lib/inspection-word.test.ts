import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { appointmentTypeLabel } from "@/lib/statuses";
import { bookingTitle, KIND_LABEL } from "@/lib/schedule/work-shape";
import { apptEventBody } from "@/lib/gcal-map";
import { DOCK } from "@/lib/dock";
import { FEATURES } from "@/lib/features";
import { PILE_DEFS } from "@/lib/action-items/piles";

/**
 * ONE WORD FOR THE SITE VISIT, AND IT IS THE STORED ONE: INSPECTION.
 *
 * THE WORD WENT OUT AND CAME BACK — READ THIS BEFORE YOU "TIDY" IT AGAIN.
 *   · 2026-10-02 (W2-10, 8c3e9bc5, cn-v1034): every screen was swept to "Walk-Through". The stored
 *     type stayed 'inspection', so a display word now sat on top of a different stored word.
 *   · 2026-10-03, Erik, reading the page: "im still see walk-throughs as a bucket when everything is
 *     about inspections and to be called Inspections, i think i had bugs about this." Reversed.
 *
 * AND HIS REASONS OUTLIVE HIS PREFERENCE, which is why this file exists rather than a sed:
 *   · THE STORED WORD IS ALREADY 'inspection' (44 rows in production, statuses.ts names the count).
 *     A display word over a different stored word is what produced the bug: My Day's Not Closed Out
 *     row capitalised the type by hand and printed "Inspection" while every other screen said
 *     Walk-Through. Shown word == stored word kills that whole class (visit-word.test.ts).
 *   · THE CITY'S WAS NEVER AT RISK. It is the separate type `final_inspection`, labelled Final
 *     Inspection, living on the job's permit — so reserving the word "inspection" for it protected
 *     nothing and cost the site visit its name.
 *   · THE PAGE IS /inspections, with Inspections in the dock. The bucket said Walk-Throughs on it.
 *
 * WORDS ONLY, BOTH TIMES. Nothing in the database moved: not the stored type 'inspection', not the
 * stored WorkKind 'walkthrough' (pinned by inquiries_work_kind_known, 0230/0232), not the function
 * save_walkthrough_capture (0356), not the route, not one stored title.
 */
const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("the site visit is an Inspection", () => {
  it("the type's label, the kind's chip and the dock row all say it", () => {
    expect(appointmentTypeLabel("inspection")).toBe("Inspection");
    // The KEY is the stored WorkKind, which does not change; only what it is called does.
    expect(KIND_LABEL.walkthrough).toBe("Inspection");
    const row = DOCK.find((s) => s.key === "sales")?.children.find((c) => c.id === "sl-inspections");
    expect(row).toMatchObject({ label: "Inspections", href: "/inspections" });
  });

  it("the bucket on the page, the switch and the pile all read Inspection too", () => {
    // The exact pairing Erik reported: a page called Inspections with a bucket called Walk-Throughs.
    const page = read("src/app/(app)/inspections/page.tsx");
    expect(page).toContain('title="Inspections"');
    expect(page).toContain('buttonLabel="Book An Inspection"');
    expect(FEATURES.find((f) => f.key === "leads")?.label).toBe("Leads & Inspections");
    expect(PILE_DEFS.inspections_to_write_up).toMatchObject({ label: "Inspections To Write Up", listLabel: "See All Inspections" });
  });

  it("a new inspection's stock title is the word and who it's with", () => {
    expect(bookingTitle("walkthrough", "Matt Warren")).toBe("Inspection: Matt Warren");
  });

  it("the city's inspection is told apart by its own name, not by reserving this one", () => {
    expect(appointmentTypeLabel("final_inspection")).toBe("Final Inspection");
    expect(FEATURES.find((f) => f.key === "permits")?.label).toBe("Permits & Inspections");
  });

  it("Nort gets the same word, and the type that tells the city's apart", () => {
    for (const f of ["src/lib/actions/entities/appointment.ts", "src/lib/actions/entities/inquiry.ts"]) {
      // The old stock title, which named the visit after the sheet it carried.
      expect(read(f).toLowerCase(), f).not.toContain("site inspection");
    }
    // appointment.create points the CITY'S inspection at its own type rather than at a word.
    const create = read("src/lib/actions/entities/appointment.ts");
    expect(create).toContain('Title a site visit \\"Inspection: <customer or place>\\"');
    expect(create).toContain("THE CITY'S INSPECTION IS NOT THIS: it is the separate type 'final_inspection'");
  });

  it("an Other visit reaches Google with no bracket prefix; the two inspections read their own", () => {
    const visit = { id: "a1", title: "Dentist", starts_at: "2026-10-01T16:00:00.000Z", ends_at: null, location: null, notes: null };
    expect(apptEventBody({ ...visit, type: "other" }).summary).toBe("Dentist");
    expect(apptEventBody({ ...visit, type: "other" }).summary).not.toMatch(/^\[/);
    expect(apptEventBody({ ...visit, type: "inspection", title: "Rough-in walk" }).summary).toBe("[Inspection] Rough-in walk");
    // On his phone's calendar the two are still one tap apart, because they are two types.
    expect(apptEventBody({ ...visit, type: "final_inspection", title: "Rough-in walk" }).summary).toBe("[Final Inspection] Rough-in walk");
  });

  it("the setup interview is setup, so the one word means only the site visit", () => {
    expect(read("src/lib/onboarding/help-rows.ts")).toContain('"Setup from the top. Change anything you told Nort."');
    const s = read("src/components/setup-interview.tsx");
    expect(s).toContain("Take setup again from Search Or Ask and tell me your trade");
    expect(s).toContain(">This setup</strong>");
    // Setup used to call ITSELF a walk-through — a third noun for the same word, in the one place a
    // brand-new company reads first.
    expect(s).not.toContain("Take the walk-through again");
    expect(s).not.toContain("Take the inspection again");
  });
});

/**
 * AND THE OLD WORD CANNOT COME BACK ANYWHERE.
 *
 * THIS TEST USED TO POINT THE OTHER WAY, and that is the lesson in it. On 2026-10-02 it forbade
 * "inspect" in user-facing strings, because a sweep of ~42 files had left five on-screen uses of the
 * then-old word behind (the New Estimate scope box's first line, Settings' questions paragraph and
 * its unsaved bar, the Crew plan's promise, and Nort's visit_days_ahead). The sweep caught them. One
 * day later the owner named the other word, so the arrow turns around: "walk-through" is now what
 * cannot come back, and the same sweep reads EVERY source file to make sure none of 180-odd files
 * kept speaking the language of the day before.
 *
 * WHAT COUNTS: every word a person could read or Nort could say — string literals, template chunks
 * and JSX text, by the compiler's own reading of the file, so a COMMENT never trips it. Comments are
 * deliberately exempt: a comment quoting Erik, or explaining either rename, has to be free to say
 * the old word, and a future reader needs that history to avoid undoing this by accident.
 *
 * WHAT DOESN'T COUNT: the two names the DATABASE pins, which are code and not words — the stored
 * WorkKind 'walkthrough' (inquiries.work_kind, check constraint 0230/0232) and the function
 * save_walkthrough_capture (0356). Anything else needs a line on the allowlist, with its reason.
 *
 * Test files are not swept (they carry the old word in their own history and their own fixtures);
 * nothing a person reads on screen lives in one.
 */
const ROOT = process.cwd();
const OLD_WORD = /walk.?through/i;

/** The two strings the database owns. A word a person reads is never one of these. */
const DB_NAMES: Record<string, string> = {
  walkthrough: "the stored WorkKind on inquiries.work_kind, pinned by inquiries_work_kind_known (0230/0232)",
  save_walkthrough_capture: "the function a crew lead's save goes through (0356)",
};

/**
 * True when every trace of the old word in this literal is a name the database owns.
 *
 * The WorkKind has to stand ALONE to count ("walkthrough" and nothing else) — otherwise Apple's own
 * walkthrough, which is prose, would read as a stored value. The function may sit inside SQL
 * ("select public.save_walkthrough_capture($1) as id"), so it is taken out and what remains is
 * judged: if no old word survives, there was never a word here, only code.
 */
function isDatabaseName(text: string): boolean {
  const t = text.trim();
  if (t === "walkthrough") return true;
  return !OLD_WORD.test(t.split("save_walkthrough_capture").join(""));
}

/**
 * THE OLD WORD STAYS IN THESE FILES, and the reason it stays. Everything not named here is swept.
 * A reason is required, and the test below fails an entry whose file no longer says the word — so a
 * keep cannot outlive what it was keeping.
 */
const KEEPS_THE_OLD_WORD: Record<string, string> = {
  // STORED DATA says the old word, so this code has to match what is stored.
  "src/lib/job-name.ts": "SOURCE_TAGS strips 'Walk-through: ' off a title STORED on 2026-10-02",
  "src/app/(app)/appointments/actions.ts": "the STOCK lists recognise a stock title STORED under the old word, so it still gets renamed",
  // THE WORD HE USED FOR A DAY STILL FINDS THE PAGE. Search aliases, never a label.
  "src/components/command-bar.tsx": "search aliases: whichever word a person learned still opens /inspections",
  // A DIFFERENT NOUN ALTOGETHER — not the visit, not the sheet.
  "src/components/tap-to-pay/settings-section.tsx": "Apple's own walkthrough of taking a tap: a tutorial video, a third sense",
  // NORT, told the stored value as stored (and told which word a person reads).
  "src/lib/assistant-tools.ts": "names the STORED work_kind value to Nort, and says it reads as an Inspection",
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
  if (!OLD_WORD.test(src)) return [];
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
    for (const f of ["src/app/(app)/inspections/page.tsx", "src/app/(app)/settings/page.tsx", "src/lib/plans.ts", "src/lib/dock.ts"]) {
      expect(files).toContain(f);
    }
  });

  it("the rule reads a database name as code and a label as a word", () => {
    for (const s of ["walkthrough", "save_walkthrough_capture", "select public.save_walkthrough_capture($1) as id"]) {
      expect(isDatabaseName(s), s).toBe(true);
    }
    for (const s of [
      "Book A Walk-Through",
      "Walk-Throughs To Write Up",
      "your walk-through sheet written",
      "Mark Walk-Through Done",
      "Only the office can change the walk-through.",
      "Walk-Through: Matt Warren",
      "walk-throughs / quote visits",
      "Apple&apos;s own walkthrough of taking a tap, PIN entry included.",
    ]) {
      expect(isDatabaseName(s), s).toBe(false);
    }
  });

  it("finds none outside the allowlist", () => {
    const allowed = Object.keys(KEEPS_THE_OLD_WORD);
    const hits = files
      .filter((f) => !allowed.some((a) => f === a || f.startsWith(a)))
      .flatMap((f) =>
        wordsIn(f)
          .filter((w) => OLD_WORD.test(w.text) && !isDatabaseName(w.text))
          .map((w) => `${f}:${w.line}: ${w.text.replace(/\s+/g, " ").trim().slice(0, 140)}`),
      );
    expect(hits).toEqual([]);
  }, 60_000);

  it("no allowlist entry outlives its reason: each path exists and still says the word", () => {
    for (const [p, reason] of Object.entries(KEEPS_THE_OLD_WORD)) {
      expect(reason.length, p).toBeGreaterThan(10);
      const covered = files.filter((f) => f === p || f.startsWith(p));
      expect(covered.length, `${p} covers no source file`).toBeGreaterThan(0);
      expect(covered.some((f) => wordsIn(f).some((w) => OLD_WORD.test(w.text))), `${p} no longer says it`).toBe(true);
    }
  }, 60_000);

  it("every database name on the exception list carries why it is there", () => {
    for (const [name, reason] of Object.entries(DB_NAMES)) {
      expect(reason.length, name).toBeGreaterThan(10);
      expect(OLD_WORD.test(name), name).toBe(true);
    }
  });

  it("the five surfaces the owner was reading now all say Inspection", () => {
    // The bucket and the page that disagreed, the dock row above them, and the piles that feed them.
    expect(read("src/app/(app)/inspections/page.tsx")).toContain("No open inspections");
    expect(read("src/lib/dock.ts")).toContain('label: "Inspections"');
    // Settings' sheet — the SECOND sense, the questions carried on the visit.
    expect(read("src/app/(app)/settings/page.tsx")).toContain("These are the questions your inspection asks on site");
    expect(read("src/app/(app)/settings/playbook-manager.tsx")).toContain("Your own inspection questions — what you ask yourself standing on the job");
    // What we promise to set up with a Crew customer, and Nort's own day-clustering words.
    expect(read("src/lib/plans.ts")).toContain("your inspection sheet written");
    expect(read("src/lib/assistant-tools.ts")).toContain("(inspections / quote visits, the site visit before a price)");
  });
});
