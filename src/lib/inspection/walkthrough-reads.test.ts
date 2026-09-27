import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { isMissingView, readViaView, WALKTHROUGH_VIEWS } from "./walkthrough-access";

/**
 * WALK-THROUGH PRICES STAY IN THE OFFICE (LEAK-0227, 0366), in the code.
 *
 * 0366 revokes appointments.inspection_answers from the signed-in role (every signed-in person, the
 * office included, is that one role), and keeps a non-office reader off a playbook form (forms_read).
 * So after it runs, a page that selects either straight from its table breaks, or reads what it must
 * not. These pins hold every read to the two views, through readViaView, which falls back to the table
 * ONLY while a view isn't on the database yet and never swallows any other failure.
 */
const ROOT = join(process.cwd(), "src");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && !/\.test-util\.ts$/.test(name)) out.push(p);
  }
  return out;
}

/** Every `.from("<table>")` chain in the app, up to its end, whitespace squashed. */
function chains(table: string): { file: string; chain: string }[] {
  const out: { file: string; chain: string }[] = [];
  const re = new RegExp(`\\.from\\(\\s*["'\`]${table}["'\`]\\s*\\)`, "g");
  for (const f of walk(ROOT)) {
    const t = readFileSync(f, "utf8");
    for (const m of t.matchAll(re)) {
      const rest = t.slice(m.index!, m.index! + 1500);
      let depth = 0;
      let end = rest.length;
      for (let i = 0; i < rest.length; i++) {
        const ch = rest[i];
        if ("([{".includes(ch)) depth++;
        else if (")]}".includes(ch)) {
          depth--;
          if (depth < 0) {
            end = i;
            break;
          }
        } else if (ch === ";" && depth <= 0) {
          end = i;
          break;
        }
      }
      out.push({ file: relative(ROOT, f), chain: rest.slice(0, end).replace(/\s+/g, " ") });
    }
  }
  return out;
}

describe("nobody reads appointments.inspection_answers from the table", () => {
  const appts = chains("appointments");

  it("finds the appointment reads (so an empty scan can never pass)", () => {
    expect(appts.length).toBeGreaterThan(40);
  });

  it("no select names inspection_answers, filters on it, or asks for every column", () => {
    const bad = appts.filter(({ chain }) => {
      const selects = [...chain.matchAll(/\.select\(\s*([^)]*)\)/g)].map((m) => m[1]);
      return (
        selects.some((s) => /inspection_answers|\*/.test(s)) ||
        // .select() with nothing selects every column: the revoked one included.
        /\.(insert|update|upsert)\([^]*?\)\s*\.select\(\s*\)/.test(chain) ||
        /\.(not|eq|is|filter|contains)\(\s*["']inspection_answers/.test(chain)
      );
    });
    expect(bad).toEqual([]);
  });

  it("the four readers go through appointment_answers", () => {
    for (const f of ["app/(app)/appointments/[id]/page.tsx", "app/(app)/appointments/actions.ts", "app/(app)/quotes/new/page.tsx", "app/(app)/jobs/panel-actions.ts"]) {
      expect(read(f), f).toMatch(/readViaView(?:<[\s\S]*?>)?\(\s*[\w.]+,\s*"answers",/);
    }
  });
});

describe("the tech-facing walk-through reads a sheet's playbook only through form_playbooks", () => {
  const forms = chains("forms");

  it("the visit page, the walk-through's save and the voice fill never select a playbook from forms", () => {
    for (const f of ["app/(app)/appointments/[id]/page.tsx", "app/(app)/appointments/actions.ts", "app/(app)/appointments/hear-actions.ts"]) {
      const direct = forms.filter((c) => c.file === f && /playbook/.test(c.chain));
      expect(direct, f).toEqual([]);
      expect(read(f), f).toMatch(/readViaView(?:<[\s\S]*?>)?\(\s*[\w.]+,\s*"sheets",/);
    }
  });

  it("the page hands anyone but the office the sheets without money, and the answers without prices (a second layer)", () => {
    const page = read("app/(app)/appointments/[id]/page.tsx");
    expect(page).toContain("templates={viewerIsStaff ? (sheets ?? []) : sheetsWithoutMoney(sheets ?? [])}");
    expect(page).toMatch(/viewerIsStaff\s*\?\s*\(inspection\?\.inspection_answers \?\? \{\}\)\s*:\s*answersWithoutPrices\(/);
  });

  it("a walk-through it couldn't read is said, and no sheet is drawn to save over it", () => {
    const page = read("app/(app)/appointments/[id]/page.tsx");
    expect(page).toContain("const walkthroughUnread = unread(sheetsRead) || unread(answersRead);");
    expect(page).toMatch(/\{walkthroughUnread \? \(\s*<p[^>]*>\{WALKTHROUGH_UNREAD\}<\/p>\s*\) : \(\s*<Inspector/);
  });
});

describe("readViaView: the view, or the table only while the view is missing", () => {
  type Reply = { data: unknown; error: unknown };
  const fake = (replies: Record<string, Reply>) => {
    const asked: string[] = [];
    return {
      asked,
      from(rel: string) {
        asked.push(rel);
        const r = replies[rel] ?? { data: null, error: { code: "?", message: `unrouted ${rel}` } };
        return { select: () => ({ eq: () => ({ maybeSingle: async () => r }) }) };
      },
    };
  };
  const q = (from: any) => from.select("inspection_answers").eq("id", "a1").maybeSingle();

  it("the view answers: its rows, and the table is never asked", async () => {
    const db = fake({ appointment_answers: { data: { inspection_answers: { a: 1 } }, error: null } });
    expect(await readViaView(db, "answers", q)).toEqual({ data: { inspection_answers: { a: 1 } }, error: null, via: "view" });
    expect(db.asked).toEqual(["appointment_answers"]);
  });

  it("the view isn't there yet (PGRST205 / 42P01): the table, as before 0366", async () => {
    for (const code of ["PGRST205", "42P01"]) {
      const db = fake({
        appointment_answers: { data: null, error: { code, message: "missing" } },
        appointments: { data: { inspection_answers: { b: 2 } }, error: null },
      });
      expect(await readViaView(db, "answers", q), code).toEqual({ data: { inspection_answers: { b: 2 } }, error: null, via: "table" });
      expect(db.asked).toEqual(["appointment_answers", "appointments"]);
    }
  });

  it("any other failure is the failure: never the table, never an empty row", async () => {
    for (const error of [{ code: "42501", message: "permission denied" }, { code: "57014", message: "timeout" }, { code: "PGRST116", message: "x" }]) {
      const db = fake({ form_playbooks: { data: null, error }, forms: { data: { schema: [] }, error: null } });
      expect(await readViaView(db, "sheets", q)).toEqual({ data: null, error, via: "view" });
      expect(db.asked).toEqual(["form_playbooks"]);
    }
  });

  it("names the two views 0366 made, for the tables they stand in for", () => {
    expect(WALKTHROUGH_VIEWS).toEqual({
      answers: { view: "appointment_answers", table: "appointments" },
      sheets: { view: "form_playbooks", table: "forms" },
    });
    expect(isMissingView({ code: "PGRST205" })).toBe(true);
    expect(isMissingView({ code: "42703" })).toBe(false);
    expect(isMissingView(null)).toBe(false);
  });

  it("the migration made exactly those views", () => {
    const sql = readFileSync(
      join(process.cwd(), "supabase/migrations", readdirSync(join(process.cwd(), "supabase/migrations")).find((n) => n.startsWith("0366_"))!),
      "utf8",
    );
    expect(sql).toContain("create or replace view public.appointment_answers");
    expect(sql).toContain("create or replace view public.form_playbooks");
    expect(sql).toContain("revoke select on public.appointments from authenticated, anon;");
  });
});
