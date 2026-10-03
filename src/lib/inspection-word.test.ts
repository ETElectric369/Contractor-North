import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { appointmentTypeLabel, visitTitle } from "@/lib/statuses";
import { bookingTitle, KIND_LABEL } from "@/lib/schedule/work-shape";
import { apptEventBody } from "@/lib/gcal-map";
import { DOCK } from "@/lib/dock";
import { FEATURES } from "@/lib/features";
import { PILE_DEFS } from "@/lib/action-items/piles";
import { inspectionDbWords } from "@/lib/inspection/db-refusal";

/**
 * ONE WORD FOR THE SITE VISIT, AND IT IS THE STORED ONE: INSPECTION.
 *
 * THE WORD WENT OUT AND CAME BACK — READ THIS BEFORE YOU "TIDY" IT AGAIN.
 *   · W2-10 (8c3e9bc5, written 2026-09-28, live as cn-v1034 the night of 2026-09-30): every screen
 *     was swept to "Walk-Through". The stored type stayed 'inspection', so a display word now sat on
 *     top of a different stored word.
 *   · 2026-10-03, Erik, reading the page: "im still see walk-throughs as a bucket when everything is
 *     about inspections and to be called Inspections, i think i had bugs about this." Reversed, after
 *     about three days of the other word — which is the window rows and Google events were written in.
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
 * save_walkthrough_capture (0356), not the route, not one stored row.
 *
 * WHICH LEAVES THREE THINGS THAT STILL SAY THE OTHER WORD, each answered where it is READ, never by
 * editing a row:
 *   · a TITLE stamped "Walk-Through: <who>" during those three days — lib/statuses visitTitle re-says
 *     the stock tag on every surface that prints one, and on the way out to Google;
 *   · a SENTENCE save_walkthrough_capture raises — lib/inspection/db-refusal inspectionDbWords, proved
 *     against the migration itself further down this file;
 *   · a SHEET a company created then, stored as forms.name 'Walk-Through' — left as stored on purpose,
 *     because that name is the tenant's and the rename box has to show what it will save
 *     (lib/inspection/starter-sheets says so where the name is declared).
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

  /**
   * AND A TITLE ALREADY STORED UNDER THE OTHER WORD READS TODAY'S WORD.
   *
   * From cn-v1034 (2026-09-30) to 2026-10-03 every booking door stamped "Walk-Through: <who>" into
   * appointments.title. Nothing rewrote those rows — a title is the office's to type — so Activity
   * printed both words in one line, "Inspection booked — Walk-Through: Tom Goodman", on exactly the
   * visits Erik made while testing that change. The stock tag is re-said where it is READ.
   */
  it("a stored stock title from those three days is re-said, and a title a person typed is not", () => {
    expect(visitTitle("Walk-Through: Tom Goodman")).toBe("Inspection: Tom Goodman");
    expect(visitTitle("Walk-through: Rita Moss")).toBe("Inspection: Rita Moss");
    expect(visitTitle("Walk Through — Marla Finch")).toBe("Inspection — Marla Finch");
    expect(visitTitle("Walk-Throughs")).toBe("Inspections");
    expect(visitTitle("Walk-Through")).toBe("Inspection");
    // HIS OWN WORDS ARE HIS. A tag counts only at the very front, with a separator or the end after
    // it (job-name.ts's rule), so a real title that merely contains the word is untouched.
    expect(visitTitle("Walk the attic with Tom")).toBe("Walk the attic with Tom");
    expect(visitTitle("Walkthrough video for Rita")).toBe("Walkthrough video for Rita");
    expect(visitTitle("Rough-in walk")).toBe("Rough-in walk");
    expect(visitTitle("Inspection: Tom Goodman")).toBe("Inspection: Tom Goodman");
    expect(visitTitle(null)).toBe("");
    // Every surface that PRINTS a stored title reads it through there. The edit form and the stored
    // row are deliberately NOT on this list: a display word must never be saved back.
    for (const f of [
      "src/app/(app)/activity/page.tsx",
      "src/app/(app)/inspections/page.tsx",
      "src/app/(app)/planner/page.tsx",
      "src/app/(app)/schedule/page.tsx",
      "src/app/(app)/calendar/calendar-view.tsx",
      "src/lib/action-items/query.ts",
      "src/lib/gcal-map.ts",
      "src/lib/assistant-tools.ts", // Nort reads one aloud too
    ]) {
      expect(read(f), f).toContain("visitTitle(");
    }
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
 * THIS TEST USED TO POINT THE OTHER WAY, and that is the lesson in it. On 2026-10-03 (9bfd4812, hours
 * before the reversal) it forbade "inspect" in user-facing strings, because W2-10's sweep of ~42 files
 * had left five on-screen uses of the then-old word behind (the New Estimate scope box's first line,
 * Settings' questions paragraph and its unsaved bar, the Crew plan's promise, and Nort's
 * visit_days_ahead). The sweep caught them. Later the same day the owner named the other word, so the
 * arrow turns around: "walk-through" is now what cannot come back, and the same sweep reads EVERY
 * source file to make sure none of 180-odd files kept speaking the language of the days before.
 *
 * WHAT COUNTS: every word a person could read or Nort could say — string literals, template chunks
 * and JSX text, by the compiler's own reading of the file, so a COMMENT never trips it. Comments are
 * deliberately exempt: a comment quoting Erik, or explaining either rename, has to be free to say
 * the old word, and a future reader needs that history to avoid undoing this by accident.
 *
 * AND A QUOTE OF HIS IS NOT A WORD TO SWEEP — the reversal's own sweep rewrote three of them before a
 * reviewer caught it, which turned "walk-through/inspections" into "inspection/inspections" and
 * destroyed the evidence that he uses both words for one thing. They are restored verbatim and listed
 * here so the next sweep leaves them alone:
 *   · src/app/(app)/leads/actions.ts — "if certain days are already set for walk-through/inspections…"
 *     (cn-v883, 2026-08-29);
 *   · src/app/(app)/appointments/[id]/page.tsx and src/lib/inquiries/carry-intake-answers.ts —
 *     "the walk-through starts blank" (cn-v936, 2026-09-09).
 * Both predate W2-10, so in both he chose the old word while the app said Inspection. Siblings left
 * verbatim all along: schedule/work-shape.ts, schedule/place-by-town.ts, components/time-grid.tsx.
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
 * THE OLD WORD STAYS IN THESE LITERALS, and the reason it stays. Everything else is swept.
 *
 * AN ENTRY IS A LITERAL, NEVER A FILE — that is the whole design, and it was a file list once. Five
 * whole files were exempt to protect nine strings between them, and the two biggest carried the most
 * user-facing visit copy in the app: appointments/actions.ts (45 error returns) and assistant-tools.ts
 * (every one of Nort's tool descriptions, which is where W2-10's own sweep had missed uses). Proved
 * blind: a toast reworded to "…take a photo off the walk-through." and "any walk-throughs booked"
 * added to a Nort tool description both left the entire unit project green.
 *
 * TWO SHAPES, BECAUSE A SHORT SNIPPET IS ITS OWN HOLE. A keep that is a whole value — a tag in a
 * list, a search alias — is matched WHOLE (`whole: true`), so the word on its own is kept and the
 * same word inside a sentence in that same file is not. (Matching "walk-through" as a substring
 * instead let the reworded toast above through: take the word out of a sentence and no old word is
 * left over, which exempts any sentence at all.) A keep that is one clause of a paragraph is matched
 * inside it and taken out of it; whatever old word is left over still fails, on its own line.
 *
 * A reason is required, and the test below fails an entry whose literal is no longer there — so a
 * keep cannot outlive what it was keeping.
 */
const KEEPS_THE_OLD_WORD: { file: string; text: string; whole?: true; reason: string }[] = [
  // STORED DATA says the old word, so this code has to match what is stored. A title was written
  // "Walk-Through: <who>" from cn-v1034 (2026-09-30) to 2026-10-03; those rows are untouched, and
  // lib/statuses visitTitle re-says the tag wherever one is READ.
  {
    file: "src/lib/job-name.ts",
    text: "walk-through",
    whole: true,
    reason: "a SOURCE_TAGS tag: strips 'Walk-through: ' off a title STORED between 2026-09-30 and 2026-10-03",
  },
  { file: "src/lib/job-name.ts", text: "walk through", whole: true, reason: "the same tag spelled with a space, for a title typed that way" },
  {
    file: "src/app/(app)/appointments/actions.ts",
    text: "walk-through",
    whole: true,
    reason: "a STOCK entry (twice): recognises a stock title STORED under the old word, so it still gets renamed",
  },
  // THE WORD HE USED FOR THREE DAYS STILL FINDS THE PAGE. Search aliases, never a label. Each
  // spelling is its own string, so each is its own keep.
  { file: "src/components/command-bar.tsx", text: "walk-through", whole: true, reason: "search alias: whichever word a person learned still opens /inspections" },
  { file: "src/components/command-bar.tsx", text: "walk-throughs", whole: true, reason: "the plural he would type, the same alias list" },
  { file: "src/components/command-bar.tsx", text: "walk through", whole: true, reason: "the spaced spelling, the same alias list" },
  // A DIFFERENT NOUN ALTOGETHER — not the visit, not the sheet. One clause of Apple's own sentence.
  {
    file: "src/components/tap-to-pay/settings-section.tsx",
    text: "own walkthrough of taking a tap",
    reason: "Apple's own walkthrough of taking a tap: a tutorial video, a third sense of the word",
  },
  // NORT, told the stored value as stored (and told which word a person reads). The clause, not the
  // file: every other description in assistant-tools.ts is swept.
  {
    file: "src/lib/assistant-tools.ts",
    text: "(job / service / quote / walkthrough — the stored 'walkthrough' is the site visit before a price, which a person reads as an Inspection; null means nobody tagged it yet)",
    reason: "names the STORED work_kind value to Nort, and says in the same breath that it reads as an Inspection",
  },
];

/** True when the only old words left in this literal are ones this file is allowed to keep. */
function isKept(file: string, text: string): boolean {
  const mine = KEEPS_THE_OLD_WORD.filter((k) => k.file === file);
  if (mine.some((k) => k.whole && text.trim() === k.text)) return true;
  let left = text;
  for (const k of mine) if (!k.whole) left = left.split(k.text).join("");
  return !OLD_WORD.test(left);
}

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

  it("scans the whole app, Nort included — and no file is exempt from it", () => {
    expect(files.length).toBeGreaterThan(500);
    for (const f of [
      "src/app/(app)/inspections/page.tsx",
      "src/app/(app)/settings/page.tsx",
      "src/lib/plans.ts",
      "src/lib/dock.ts",
      // THE FOUR THAT USED TO BE EXEMPT WHOLE. assistant-tools.ts is every word Nort says, and
      // appointments/actions.ts is 45 error returns about a visit; both were unreadable to this
      // sweep while the allowlist named files. Every literal in them is read now.
      "src/lib/assistant-tools.ts",
      "src/app/(app)/appointments/actions.ts",
      "src/components/command-bar.tsx",
      "src/lib/job-name.ts",
    ]) {
      expect(files).toContain(f);
    }
    // And the allowlist cannot grow back into a file list: an entry names a literal.
    for (const k of KEEPS_THE_OLD_WORD) expect(k.text.length, k.file).toBeGreaterThan(3);
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
    const hits = files.flatMap((f) =>
      wordsIn(f)
        .filter((w) => OLD_WORD.test(w.text) && !isDatabaseName(w.text) && !isKept(f, w.text))
        .map((w) => `${f}:${w.line}: ${w.text.replace(/\s+/g, " ").trim().slice(0, 140)}`),
    );
    expect(hits).toEqual([]);
  }, 60_000);

  it("no allowlist entry outlives its reason: each literal is still there, in that file", () => {
    for (const k of KEEPS_THE_OLD_WORD) {
      expect(k.reason.length, k.file).toBeGreaterThan(10);
      expect(OLD_WORD.test(k.text), `${k.file}: ${k.text} carries no old word to keep`).toBe(true);
      expect(files, `${k.file} is not a source file`).toContain(k.file);
      const found = wordsIn(k.file).some((w) => (k.whole ? w.text.trim() === k.text : w.text.includes(k.text)));
      expect(found, `${k.file} no longer says ${k.text}`).toBe(true);
    }
  }, 60_000);

  /**
   * NINE LITERALS, IN FIVE FILES, AND THOSE FILES ARE NOT OTHERWISE EXEMPT.
   *
   * Line numbers are deliberately not pinned (they move when a comment above them does); the COUNT
   * per file is, because that is what a quiet new use would change. A tenth literal in one of these
   * files fails here even if an existing entry happens to cover it — which is the hole the old
   * file-level list had: appointments/actions.ts could gain any number of them, unseen.
   */
  it("the whole allowlist is nine literals in five files, and nothing more hides behind it", () => {
    const perFile: Record<string, number> = {};
    for (const f of files) {
      const n = wordsIn(f).filter((w) => OLD_WORD.test(w.text) && !isDatabaseName(w.text)).length;
      if (n) perFile[f] = n;
    }
    expect(perFile).toEqual({
      "src/app/(app)/appointments/actions.ts": 2, // the two STOCK lists
      "src/components/command-bar.tsx": 3, // three alias spellings
      "src/components/tap-to-pay/settings-section.tsx": 1, // Apple's sentence
      "src/lib/assistant-tools.ts": 1, // list_inquiries' stored-value clause
      "src/lib/job-name.ts": 2, // two SOURCE_TAGS spellings
    });
    expect(Object.values(perFile).reduce((a, b) => a + b, 0)).toBe(9);
  }, 60_000);

  it("every database name on the exception list carries why it is there", () => {
    for (const [name, reason] of Object.entries(DB_NAMES)) {
      expect(reason.length, name).toBeGreaterThan(10);
      expect(OLD_WORD.test(name), name).toBe(true);
    }
  });

  /**
   * AND THE DATABASE'S OWN SENTENCES, WHICH NO TYPESCRIPT SWEEP CAN SEE.
   *
   * save_walkthrough_capture (0356) raises the words a crew lead reads when his save is refused:
   * inspectionRefusal hands a 42501 message straight back, dbError hands an unrecognised one back
   * raw, and the Inspector puts it on screen. Those literals are SQL, in a migration that is already
   * applied and must not be edited (check-test-db.cjs fails CI when an applied one changes), so the
   * word is put right on the way out instead (lib/inspection/db-refusal inspectionDbWords).
   *
   * THE FAILURE THIS PREVENTS, which happened: the DB suite's expectations were swept to the new word
   * while the function kept raising the old one. Five tests went red in CI only, because the suite
   * needs the test database; the unit project saw nothing, and a crew lead read "walk-through" on a
   * screen that says Inspection everywhere else. This test reads the migrations themselves, so it
   * catches both halves without a database.
   */
  const MIGRATIONS = join(ROOT, "supabase/migrations");
  /** Every sentence a migration can raise AT A PERSON. A '0356:' self-check is a deploy note to
   *  whoever is applying it, never an app screen, so those are left out by their NNNN: prefix. */
  const raisedAtPeople = (): { file: string; text: string }[] =>
    readdirSync(MIGRATIONS)
      .filter((n) => n.endsWith(".sql"))
      .flatMap((n) =>
        [...readFileSync(join(MIGRATIONS, n), "utf8").matchAll(/raise\s+exception\s+'((?:[^']|'')*)'/gi)]
          .map((m) => ({ file: n, text: m[1].split("''").join("'") }))
          .filter((r) => !/^\d{4}:/.test(r.text)),
      );

  it("every sentence the database can raise at a person says Inspection by the time it is read", () => {
    const said = raisedAtPeople().map((r) => ({ ...r, out: inspectionDbWords(r.text) }));
    expect(said.length).toBeGreaterThan(10);
    expect(said.filter((r) => OLD_WORD.test(r.out)).map((r) => `${r.file}: ${r.out}`)).toEqual([]);
    // A TRANSLATION, NEVER A REWRITE. A sentence with no old word in it comes back byte for byte —
    // db-error.ts's rule, and the reason this can sit on the generic path without eating anything.
    for (const r of said) {
      if (!OLD_WORD.test(r.text)) expect(r.out, r.file).toBe(r.text);
      expect(inspectionDbWords(r.out), r.text).toBe(r.out); // and running it again changes nothing
    }
  });

  it("the seven sentences a crew lead can actually hit read exactly like this", () => {
    // The left side is 0356's literal, the right side what he sees under his Save. Change the regex
    // and these say so.
    const pairs: [string, string][] = [
      ["Sign in with an active seat to fill in the walk-through.", "Sign in with an active seat to fill in the inspection."],
      ["That walk-through isn't one of this company's.", "That inspection isn't one of this company's."],
      [
        "Only the office, or the crew lead on this visit, can fill in the walk-through.",
        "Only the office, or the crew lead on this visit, can fill in the inspection.",
      ],
      ["Only the office can take a photo off the walk-through.", "Only the office can take a photo off the inspection."],
      [
        "A photo you put on the walk-through has to be one you took for this visit.",
        "A photo you put on the inspection has to be one you took for this visit.",
      ],
      ["That sheet isn't one of this company's walk-through sheets.", "That sheet isn't one of this company's inspection sheets."],
      ["Only the office can switch the walk-through to a different sheet.", "Only the office can switch the inspection to a different sheet."],
      // Mid-sentence and sentence-start both, so the capital follows the position and not the word.
      ["The walk-through's notes are too long to save in one go.", "The inspection's notes are too long to save in one go."],
      ["The walk-through didn't save. Reload and try again.", "The inspection didn't save. Reload and try again."],
    ];
    for (const [raw, shown] of pairs) expect(inspectionDbWords(raw), raw).toBe(shown);
    // The function's own name is CODE, and a sentence quoting it keeps it.
    expect(inspectionDbWords("save_walkthrough_capture is not on this database.")).toBe("save_walkthrough_capture is not on this database.");
  });

  it("the thirteen 0356 raises a crew lead can hit are the ones the DB suite pins", () => {
    const sql = readFileSync(join(MIGRATIONS, readdirSync(MIGRATIONS).find((n) => n.startsWith("0356_"))!), "utf8");
    const suite = readFileSync(join(ROOT, "src/lib/inspection-crew-lead.integration.test.ts"), "utf8");
    const raises = [...sql.matchAll(/raise\s+exception\s+'((?:[^']|'')*)'/gi)]
      .map((m) => m[1].split("''").join("'"))
      // isDatabaseName keeps the function's own NAME out of it: 0356's last self-check quotes
      // save_walkthrough_capture, which is code and not a word anybody reads.
      .filter((t) => OLD_WORD.test(t) && !isDatabaseName(t));
    expect(raises).toHaveLength(13);
    // Each sentence the suite compares with toBe() is the migration's own, byte for byte. A sweep
    // that rewrote the suite and left the SQL alone fails right here instead of only in CI.
    for (const expected of [...suite.matchAll(/toBe\("((?:[^"\\]|\\.)*)"\)/g)].map((m) => m[1].split('\\"').join('"'))) {
      if (!OLD_WORD.test(expected)) continue;
      expect(raises, `the suite expects a sentence 0356 does not raise: ${expected}`).toContain(expected);
      // …and what a person actually reads is the new word.
      expect(OLD_WORD.test(inspectionDbWords(expected)), expected).toBe(false);
    }
    // The one place those messages reach a screen goes through the translation.
    const actions = read("src/app/(app)/appointments/actions.ts");
    expect(actions).toContain("inspectionDbWords(error.message || CREW_OR_OFFICE)");
    expect(actions).toContain("inspectionDbWords(dbError(error))");
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
