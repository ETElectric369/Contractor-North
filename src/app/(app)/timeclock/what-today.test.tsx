import { describe, it, expect, vi, beforeEach } from "vitest";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * "WHAT DID YOU DO TODAY?" AFTER A TECH'S OWN CLOCK-OUT (cn-v1190). The owner: "and for techs who
 * are not lead lets have one question with their clocout - what did you do today".
 *
 *   · THE WRITE (addWhatTodayNote) against a stand-in that honours every filter it is given: the
 *     caller's own row in his own company, added to the note and read back; another person's row is
 *     zero rows, said; a paid row is refused; an empty answer writes nothing; the company is named.
 *   · THE SHEET, drawn in both languages: the clock already stopped (its heading), the question, one
 *     box, Save and Skip, 44px.
 *   · THE DOORS, at the source: the Time Clock and My Day's Now card open it only after a close that
 *     kept the shift, as the other branch of the report's rule; the job page's button never clocks a
 *     tech out (it sends him to the Time Clock), so it has nothing to open.
 *   · WHO READS IT: the job page's Time tab prints the note under each shift, words only.
 */
const state = vi.hoisted(() => ({ client: null as any }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => state.client),
  createServiceClient: vi.fn(() => state.client),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));
vi.mock("@/lib/notifications", () => ({ createNotifications: vi.fn(), notifyPeople: vi.fn() }));
vi.mock("@/lib/push", () => ({ sendPushToProfiles: vi.fn(), orgStaffIds: vi.fn(async () => []) }));
vi.mock("../schedule/actions", () => ({ setJobCrew: vi.fn(async () => ({ ok: true })) }));

import { addWhatTodayNote, saveEntryNotes } from "./actions";
import { WhatTodaySheet } from "./what-today-sheet";
import { LangProvider } from "@/components/lang-provider";
import { dict, type Lang } from "@/lib/i18n";
import { words } from "@/lib/words/timeclock";

const en = dict("en");
const es = dict("es");
const src = (f: string) => readFileSync(join(process.cwd(), f), "utf8");

type Row = Record<string, any>;
type Write = { table: string; payload: any; filters: [string, string, any][] };

/** A stand-in that honours eq / is on reads and writes, as PostgREST would; it records every write. */
function standIn(tables: Record<string, Row[]>, userId: string, writes: Write[]) {
  return {
    auth: { getUser: async () => ({ data: { user: { id: userId } } }) },
    from(table: string) {
      const filters: [string, string, any][] = [];
      let verb: "select" | "update" = "select";
      let payload: any = null;
      const match = () =>
        (tables[table] ?? []).filter((r) =>
          filters.every(([op, col, v]) => (op === "eq" ? r[col] === v : op === "is" ? (r[col] ?? null) === v : false)),
        );
      const run = () => {
        if (filters.some(([op]) => op !== "eq" && op !== "is")) throw new Error(`unhonoured filter on ${table}`);
        const rows = match();
        if (verb === "update") {
          writes.push({ table, payload, filters: [...filters] });
          for (const r of rows) Object.assign(r, payload);
          return { data: rows.map((r) => ({ id: r.id })), error: null };
        }
        return { data: rows, error: null };
      };
      const chain: any = {
        select() { return chain; },
        update(p: any) { verb = "update"; payload = p; return chain; },
        eq(col: string, v: any) { filters.push(["eq", col, v]); return chain; },
        is(col: string, v: any) { filters.push(["is", col, v]); return chain; },
        limit() { return chain; },
        maybeSingle() { const r = run(); return Promise.resolve({ data: (r.data as Row[])[0] ?? null, error: null }); },
        then(res: any, rej: any) { try { res(run()); } catch (e) { rej?.(e); } },
      };
      return chain;
    },
  };
}

const SAM = "p-sam-tillery";
const DANA = "p-dana-rook";
const ORG = "org-larkspur";
const OTHER_ORG = "org-snowbell";
let tables: Record<string, Row[]>;
let writes: Write[];
beforeEach(() => {
  writes = [];
  tables = {
    profiles: [
      { id: SAM, org_id: ORG, language: "en" },
      { id: DANA, org_id: ORG, language: "es" },
    ],
    time_entries: [
      { id: "e-sam", profile_id: SAM, org_id: ORG, notes: "[hours confirmed after the auto clock-out]", paid_at: null, job_id: "j-901", translated_notes: "x" },
      { id: "e-dana", profile_id: DANA, org_id: ORG, notes: null, paid_at: null, job_id: "j-902" },
      { id: "e-sam-paid", profile_id: SAM, org_id: ORG, notes: null, paid_at: "2001-01-08T00:00:00Z", job_id: "j-901" },
      { id: "e-sam-elsewhere", profile_id: SAM, org_id: OTHER_ORG, notes: null, paid_at: null, job_id: null },
    ],
  };
  state.client = standIn(tables, SAM, writes);
});
const row = (id: string) => tables.time_entries.find((r) => r.id === id)!;

describe("the write: the caller's own shift, added to its note, read back", () => {
  it("adds the answer after what is there, names the person and the company, and drops the stale translation", async () => {
    const res = await addWhatTodayNote({ entry_id: "e-sam", answer: "  Set the panel at Larkspur  " });
    expect(res).toEqual({ ok: true, id: "e-sam" });
    expect(row("e-sam").notes).toBe("[hours confirmed after the auto clock-out]\nSet the panel at Larkspur");
    expect(row("e-sam").translated_notes).toBeNull();
    expect(writes).toHaveLength(1);
    expect(writes[0].filters).toEqual([
      ["eq", "id", "e-sam"],
      ["eq", "profile_id", SAM],
      ["eq", "org_id", ORG],
      ["is", "paid_at", null],
    ]);
  });

  it("the same answer twice is written once", async () => {
    await addWhatTodayNote({ entry_id: "e-sam", answer: "Set the panel" });
    const again = await addWhatTodayNote({ entry_id: "e-sam", answer: "Set the panel" });
    expect(again.ok).toBe(true);
    expect(writes).toHaveLength(1);
  });

  it("an empty answer writes nothing", async () => {
    expect(await addWhatTodayNote({ entry_id: "e-sam", answer: "   " })).toEqual({ ok: true });
    // Not even a refusal: an empty box is Skip, whatever the shift.
    expect(await addWhatTodayNote({ entry_id: "e-dana", answer: "" })).toEqual({ ok: true });
    expect(writes).toHaveLength(0);
  });

  it("another person's shift is zero rows, said in one sentence, and nothing is written", async () => {
    const res = await addWhatTodayNote({ entry_id: "e-dana", answer: "Set the panel" });
    expect(res).toEqual({ ok: false, error: en.tc_wtNoShift });
    expect(row("e-dana").notes).toBeNull();
    expect(writes).toHaveLength(0);
  });

  it("his own row filed under another company is not his here", async () => {
    const res = await addWhatTodayNote({ entry_id: "e-sam-elsewhere", answer: "Set the panel" });
    expect(res).toEqual({ ok: false, error: en.tc_wtNoShift });
    expect(writes).toHaveLength(0);
  });

  it("a paid shift is refused in one sentence", async () => {
    const res = await addWhatTodayNote({ entry_id: "e-sam-paid", answer: "Set the panel" });
    expect(res).toEqual({ ok: false, error: en.tc_wtPaid });
    expect(writes).toHaveLength(0);
  });

  it("answers in the caller's language", async () => {
    state.client = standIn(tables, DANA, writes);
    const res = await addWhatTodayNote({ entry_id: "e-sam", answer: "Set the panel" });
    expect(res).toEqual({ ok: false, error: es.tc_wtNoShift });
  });

  it("a write that matched nothing is said, never a quiet ok", async () => {
    // The row is paid between the read and the write: the write's own filter finds nothing.
    const base = standIn(tables, SAM, writes);
    state.client = {
      ...base,
      from(t: string) {
        const c = base.from(t);
        const update = c.update;
        c.update = (p: any) => { row("e-sam").paid_at = "2001-01-08T00:00:00Z"; return update(p); };
        return c;
      },
    };
    const res = await addWhatTodayNote({ entry_id: "e-sam", answer: "Set the panel" });
    expect(res).toEqual({ ok: false, error: en.tc_wtNoShift });
  });
});

const inLang = (lang: Lang, el: ReactElement) => renderToStaticMarkup(createElement(LangProvider, { lang } as Parameters<typeof LangProvider>[0], el));
const sheet = (lang: Lang) => inLang(lang, createElement(WhatTodaySheet, { open: true, entryId: "e-sam", onClose: () => {} }));

// THE MID-SHIFT AUTOSAVE WRITES ONLY THE CALLER'S OWN UNPAID ROW (fix-1190-B, skeptic #91 S7). Its one
// caller is the Time Clock panel's autosave of the person's own open row; row security alone let an
// office seat overwrite anyone's note in the company, paid rows included, and a zero-row write said ok.
describe("saveEntryNotes: the caller's own unpaid shift in his company, read back", () => {
  it("saves his own unpaid row, naming the person, the company and not-paid on the write", async () => {
    const res = await saveEntryNotes("e-sam", "Roughed in at Larkspur", null);
    expect(res).toEqual({ ok: true });
    expect(row("e-sam").notes).toBe("Roughed in at Larkspur");
    const w = writes.find((x) => x.table === "time_entries")!;
    expect(w.filters).toEqual(
      expect.arrayContaining([
        ["eq", "id", "e-sam"],
        ["eq", "profile_id", SAM],
        ["eq", "org_id", ORG],
        ["is", "paid_at", null],
      ]),
    );
  });

  it("another person's row is zero rows, said, and left as it was", async () => {
    const res = await saveEntryNotes("e-dana", "Wiped", null);
    expect(res).toEqual({ ok: false, error: en.tc_wtNoShift });
    expect(row("e-dana").notes).toBeNull();
  });

  it("an office seat cannot write a crew member's note either", async () => {
    state.client = standIn(tables, DANA, writes);
    const res = await saveEntryNotes("e-sam", "Wiped", null);
    expect(res).toEqual({ ok: false, error: es.tc_wtNoShift });
    expect(row("e-sam").notes).toBe("[hours confirmed after the auto clock-out]");
  });

  it("a paid row of his own is zero rows, said as paid", async () => {
    const res = await saveEntryNotes("e-sam-paid", "Late note", null);
    expect(res).toEqual({ ok: false, error: en.tc_wtPaid });
    expect(row("e-sam-paid").notes).toBeNull();
  });

  it("his own row filed under another company is not written here", async () => {
    const res = await saveEntryNotes("e-sam-elsewhere", "Wrong company", null);
    expect(res).toEqual({ ok: false, error: en.tc_wtNoShift });
    expect(row("e-sam-elsewhere").notes).toBeNull();
  });

  // cn-v1192: the box shows the note without the clock's sealed line, so the autosave must keep it.
  it("keeps the clock's sealed line first, exactly as stored, and never writes it twice", async () => {
    const line = "[This punch took the job off hold. Before: {\"j\":\"j-901\",\"r\":null,\"d\":null,\"b\":null} #0123456789abcdef]";
    row("e-sam").notes = line;
    expect(await saveEntryNotes("e-sam", "Roughed in at Larkspur", null)).toEqual({ ok: true });
    expect(row("e-sam").notes).toBe(`${line}\nRoughed in at Larkspur`);
    // The box never shows the line, but a copy pasted back is not doubled; an emptied box keeps the line alone.
    expect(await saveEntryNotes("e-sam", `${line}\nSet the panel`, null)).toEqual({ ok: true });
    expect(row("e-sam").notes).toBe(`${line}\nSet the panel`);
    expect(await saveEntryNotes("e-sam", "", null)).toEqual({ ok: true });
    expect(row("e-sam").notes).toBe(line);
  });

  it("the autosave reads a not-ok answer as not saved: nothing shown, the next change tries again", () => {
    const p = src("src/app/(app)/timeclock/timeclock-panel.tsx");
    expect(p).toContain("saveEntryNotes(openEntry.id, notes, null)\n        .then((r) => {\n          if (r.ok) lastSavedNotes.current = notes;\n        })");
  });
});

describe("the sheet: the clock already stopped, one question, one box, Save and Skip", () => {
  it.each([
    ["en", "Clocked Out", "What did you do today?", "Save", "Skip"],
    ["es", "Salida Marcada", "¿Qué hiciste hoy?", "Guardar", "Omitir"],
  ] as const)("%s", (lang, heading, question, save, skip) => {
    const html = sheet(lang);
    expect(html).toContain(heading);
    expect(html).toContain(question);
    expect(html.match(/<textarea/g)?.length).toBe(1);
    expect(html).toMatch(new RegExp(`h-11[^"]*"[^>]*>${save}</button>`));
    expect(html).toMatch(new RegExp(`h-11[^"]*"[^>]*>${skip}</button>`));
    expect(html).toContain("min-h-[44px]");
    expect(html).not.toContain(lang === "en" ? "Guardar" : ">Save<");
  });

  it("is closed when not open", () => {
    expect(inLang("en", createElement(WhatTodaySheet, { open: false, entryId: null, onClose: () => {} }))).not.toContain("What did you do today?");
  });

  it("names its screen in the catalog, never keyed, Try Again after a failed save", () => {
    expect(words.files).toContain("src/app/(app)/timeclock/what-today-sheet.tsx");
    const s = src("src/app/(app)/timeclock/what-today-sheet.tsx");
    expect(s).not.toMatch(/\bkey=/);
    expect(s).toContain('saveLabel={error ? t("sh_tryAgain") : t("sh_save")}');
    expect(s).toContain('cancelLabel={t("tc_skip")}');
    expect(en.sh_tryAgain).toBe("Try Again");
    expect(es.sh_tryAgain).toBe("Intentar de Nuevo");
  });
});

describe("the doors: the other branch of the report's rule, only after a close that kept the shift", () => {
  it("the Time Clock asks it after the job question, never after a punch taken back", () => {
    const p = src("src/app/(app)/timeclock/timeclock-panel.tsx");
    expect(p).toContain("const asksWhat = asksWhatToday({ staff: isStaff, asksReport: crewLead });");
    const undone = p.indexOf("if (res.undone) {");
    // PIN MOVED (fix-1190-B, S4): the branch also asks closeSaidNothing about the note this close sent.
    const asked = p.indexOf("} else if (asksWhat && closeSaidNothing(notes)) {");
    expect(undone).toBeGreaterThan(-1);
    expect(asked).toBeGreaterThan(undone);
    // Only on the success branch: after the refusal's setError, inside the else.
    expect(asked).toBeGreaterThan(p.indexOf('setError(res.error ?? t("tc_couldNotClockOut"));'));
    expect(p).toContain(": asksWhat ? (\n        <WhatTodaySheet open={whatOpen} entryId={whatEntry} onClose={() => setWhatOpen(false)} />");
  });

  it("My Day's Now card asks it the same way, and the page decides by the one rule", () => {
    const c = src("src/app/(app)/planner/now-card.tsx");
    const undone = c.indexOf("else if (res.undone) {");
    // PIN MOVED (fix-1190-B, S4): the branch also asks closeSaidNothing about the note this close sent.
    const asked = c.indexOf("} else if (asksWhat && closeSaidNothing(open.notes)) {");
    expect(undone).toBeGreaterThan(-1);
    expect(asked).toBeGreaterThan(undone);
    expect(c).toContain(": asksWhat ? (\n        <WhatTodaySheet open={whatOpen} entryId={whatEntry} onClose={() => setWhatOpen(false)} />");
    expect(src("src/app/(app)/planner/page.tsx")).toContain("asksWhat={asksWhatToday({ staff: isStaff, asksReport })}");
  });

  // NEVER THE SAME QUESTION TWICE (skeptic #91 S4): each door asks the one rule about the very note it
  // sent with this close, and opens the sheet only through that branch.
  it.each([
    ["the Time Clock", "src/app/(app)/timeclock/timeclock-panel.tsx", "notes,\n          gps,\n          miles,", "closeSaidNothing(notes)"],
    ["My Day's Now card", "src/app/(app)/planner/now-card.tsx", 'notes: open.notes ?? "",', "closeSaidNothing(open.notes)"],
  ])("%s opens the sheet only when the close carried no words of his own", (_door, file, sent, rule) => {
    const s = src(file);
    expect(s).toMatch(/import \{[^}]*\bcloseSaidNothing\b[^}]*\} from "@\/lib\/what-today";/);
    const close = s.indexOf("await clockOut({");
    // The note in the rule is the note the close sent.
    expect(s.indexOf(sent, close)).toBeGreaterThan(close);
    const branch = s.indexOf(`} else if (asksWhat && ${rule}) {`);
    expect(branch).toBeGreaterThan(close);
    // Every opening of the sheet after the close sits inside that branch (or follows the job question
    // the branch armed): no other `setWhatOpen(true)` / `setWhatAfterAsk(true)` between the close and it.
    const between = s.slice(close, branch);
    expect(between).not.toMatch(/setWhatOpen\(true\)|setWhatAfterAsk\(true\)/);
    expect(s.match(/setWhatAfterAsk\(true\)/g)?.length).toBe(1);
  });

  it("the job page's button never clocks a tech out: his tap goes to the Time Clock, which asks", () => {
    const b = src("src/app/(app)/jobs/[id]/job-time-button.tsx");
    expect(b).toMatch(/: isStaff\s+\? doClockOut\s+: \(\) => router\.push\("\/timeclock"\)/);
    expect(b).not.toContain("WhatTodaySheet");
  });
});

describe("who reads it: the job page's Time tab prints the note under each shift", () => {
  const page = src("src/app/(app)/jobs/[id]/page.tsx");
  it("one line through withoutHeldCrumb, as Timecards prints it", () => {
    expect(page).toContain('{withoutHeldCrumb(e.notes) && <p className="mt-0.5 whitespace-pre-wrap text-xs text-slate-500">{withoutHeldCrumb(e.notes)}</p>}');
    expect(page.indexOf("withoutHeldCrumb(e.notes) &&")).toBeGreaterThan(page.indexOf("{timeTabEntries.map((e) => {"));
  });
  it("a tech's rows carry no pay field to print", () => {
    const at = page.indexOf(": ((entries ?? []) as any[]).map((e) => ({");
    const proj = page.slice(at, page.indexOf("}));", at));
    expect(proj).toContain("notes: e.notes,");
    expect(proj).not.toMatch(/rate|cost|bill|amount/);
  });
});
