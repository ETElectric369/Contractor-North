import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * THE ERROR SINK, RENDERED (cn-v1136): the tabs with the New count, the level pill, the repeat count,
 * the company and culprit, the two dates, Details unfolding the first sighting (and Latest only when
 * it differs), the doors each status offers, a failed read said with no count, and Title Case on every
 * door. Rendered the way this repo renders a screen in a test — react-dom/server on the real
 * component (the dead-door lesson) — with the row's own component carrying the open state.
 */
vi.mock("@/components/toast", () => ({ useToast: () => vi.fn() }));
vi.mock("./error-actions", () => ({ setErrorEventStatus: vi.fn() }));

import { ErrorList, ErrorRow, TABS, actionsFor, countNew, detailBlocks, levelPill, shownErrors } from "./error-list";
import type { ErrorEvent } from "./error-actions";

const ROW: ErrorEvent = {
  id: "e1",
  title: "could not connect to server",
  culprit: "app-layout:bug-count",
  level: "error",
  status: "new",
  event_count: 1,
  first_seen: "2026-10-26T17:00:00Z",
  last_seen: "2026-10-27T17:00:00Z",
  org: null,
  payload: { where: "app-layout:bug-count", message: "could not connect to server", extra: null },
  last_payload: null,
};
const row = (o: Partial<ErrorEvent>): ErrorEvent => ({ ...ROW, ...o });

const list = (rows: ErrorEvent[], readError: string | null = null, openCapped = false) => renderToStaticMarkup(createElement(ErrorList, { initial: rows, readError, openCapped }));
const one = (r: ErrorEvent, open = false) => renderToStaticMarkup(createElement(ErrorRow, { row: r, open, onToggle: () => {}, onStatus: () => {} }));
const doorWords = (s: string) => [...s.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((m) => m[1].replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'").trim());
const titleCase = (label: string) => label.split(/\s+/).every((w) => /^[A-Z0-9×(]/.test(w));

describe("the tabs", () => {
  it("New / Triaged / Fixed / Ignored / Traces / All, the New tab carrying its count when the read did not fail — and a trace at new is not in that count (S4)", () => {
    const s = list([row({ id: "a" }), row({ id: "b" }), row({ id: "c", status: "fixed" }), row({ id: "t", level: "trace", status: "new" })]);
    expect(s).toContain(">New (2)<");
    for (const t of ["Triaged", "Fixed", "Ignored", "Traces", "All"]) expect(s).toContain(`>${t}<`);
    expect(TABS.map((t) => t.key)).toEqual(["new", "triaged", "fixed", "ignored", "traces", "all"]);
  });

  it("the New count is the badge's error half: open non-trace rows at new (countNew)", () => {
    const rows = [row({ id: "a" }), row({ id: "b", status: "" }), row({ id: "c", status: "triaged" }), row({ id: "t", level: "trace" }), row({ id: "f", status: "fixed" })];
    expect(countNew(rows)).toBe(2);
    expect(countNew([])).toBe(0);
    expect(countNew([row({ id: "t", level: "trace" })])).toBe(0);
  });

  it("filter by status and by company (shownErrors); a trace is on Traces and All only, whatever its status", () => {
    const rows = [
      row({ id: "a", org: "Pinecone Electric" }),
      row({ id: "b", status: "triaged", org: "Blue Heron Decks" }),
      row({ id: "c", status: "ignored" }),
      row({ id: "t1", level: "trace", status: "new" }),
      row({ id: "t2", level: "trace", status: "fixed", org: "Blue Heron Decks" }),
    ];
    expect(shownErrors(rows, "new", "").map((r) => r.id)).toEqual(["a"]);
    expect(shownErrors(rows, "triaged", "").map((r) => r.id)).toEqual(["b"]);
    expect(shownErrors(rows, "ignored", "").map((r) => r.id)).toEqual(["c"]);
    expect(shownErrors(rows, "fixed", "")).toEqual([]);
    expect(shownErrors(rows, "traces", "").map((r) => r.id)).toEqual(["t1", "t2"]);
    expect(shownErrors(rows, "traces", "Blue Heron Decks").map((r) => r.id)).toEqual(["t2"]);
    expect(shownErrors(rows, "all", "").map((r) => r.id)).toEqual(["a", "b", "c", "t1", "t2"]);
    expect(shownErrors(rows, "all", "Blue Heron Decks").map((r) => r.id)).toEqual(["b", "t2"]);
    // a missing status is new, as a missing bug status is open
    expect(shownErrors([row({ id: "d", status: "" })], "new", "").map((r) => r.id)).toEqual(["d"]);
  });

  it("the open read at PostgREST's cap is said above the list, and not over a failed read", () => {
    const note = "Showing the newest 1,000 open errors.";
    expect(list([row({ id: "a" })], null, true)).toContain(note);
    expect(list([row({ id: "a" })], null, false)).not.toContain(note);
    expect(list([row({ id: "a" })], "could not connect to server", true)).not.toContain(note);
  });

  it("the tenant row appears only when two companies are on the page", () => {
    expect(list([row({ id: "a", org: "Pinecone Electric" }), row({ id: "b", org: "Pinecone Electric" })])).not.toContain("All Tenants");
    const s = list([row({ id: "a", org: "Pinecone Electric" }), row({ id: "b", org: "Blue Heron Decks" })]);
    expect(s).toContain(">All Tenants<");
    expect(s).toContain(">Pinecone Electric<");
    expect(s).toContain(">Blue Heron Decks<");
  });
});

describe("a row", () => {
  it("the level pill: Blocker red, Error amber, Trace grey — from the one palette", () => {
    expect(levelPill("blocker")).toEqual({ word: "Blocker", tone: "red" });
    expect(levelPill("error")).toEqual({ word: "Error", tone: "amber" });
    expect(levelPill("trace")).toEqual({ word: "Trace", tone: "slate" });
    expect(levelPill("")).toEqual({ word: "Error", tone: "amber" });
    expect(one(row({ level: "blocker" }))).toMatch(/bg-red-100[^"]*">Blocker</);
    expect(one(row({ level: "error" }))).toMatch(/bg-amber-100[^"]*">Error</);
    expect(one(row({ level: "trace" }))).toMatch(/bg-slate-100[^"]*">Trace</);
  });

  it("×N only past one sighting; the company before the culprit when known; the title; First · Last", () => {
    const s = one(row({ event_count: 4, org: "Pinecone Electric" }));
    expect(s).toContain(">×4<");
    expect(s).toContain(">Pinecone Electric · app-layout:bug-count<");
    expect(s).toContain(">could not connect to server<");
    expect(s).toContain(">First Oct 26, 2026 · Last Oct 27, 2026<");
    const alone = one(row({ event_count: 1 }));
    expect(alone).not.toContain("×");
    expect(alone).toContain(">app-layout:bug-count<");
  });

  it("Details closed: the first sighting is NOT on the page; open: Hide, the first sighting in a <pre>", () => {
    const closed = one(ROW);
    expect(doorWords(closed)).toContain("Details");
    expect(closed).not.toContain("<pre");
    expect(closed).not.toContain("&quot;where&quot;");
    const open = one(ROW, true);
    expect(doorWords(open)).toContain("Hide");
    expect(doorWords(open)).not.toContain("Details");
    expect(open).toContain("First Sighting");
    expect(open).toMatch(/<pre[^>]*>\{\n  &quot;where&quot;: &quot;app-layout:bug-count&quot;,\n  &quot;message&quot;: &quot;could not connect to server&quot;,\n  &quot;extra&quot;: null\n\}<\/pre>/);
    expect(open).not.toContain("Latest");
  });

  it("Latest only when the last repeat's payload is there AND differs from the first", () => {
    const first = { where: "x", message: "m", extra: null };
    expect(detailBlocks({ payload: first, last_payload: null }).map((b) => b.heading)).toEqual(["First Sighting"]);
    expect(detailBlocks({ payload: first, last_payload: { ...first } }).map((b) => b.heading)).toEqual(["First Sighting"]);
    const blocks = detailBlocks({ payload: first, last_payload: { ...first, extra: { jobId: "j1" } } });
    expect(blocks.map((b) => b.heading)).toEqual(["First Sighting", "Latest"]);
    expect(blocks[1].json).toContain('"jobId": "j1"');
    const s = one(row({ last_payload: { where: "x", message: "m", extra: { jobId: "j1" } } }), true);
    expect(s).toContain(">Latest<");
    expect((s.match(/<pre/g) ?? []).length).toBe(2);
    expect(one(row({ last_payload: ROW.payload }), true)).not.toContain("Latest");
  });

  it("the doors by status: new → Triaged, Fixed, Ignore; triaged → Fixed, Ignore; fixed or ignored → Reopen", () => {
    expect(actionsFor("new")).toEqual([{ label: "Triaged", next: "triaged" }, { label: "Fixed", next: "fixed" }, { label: "Ignore", next: "ignored" }]);
    expect(actionsFor("triaged")).toEqual([{ label: "Fixed", next: "fixed" }, { label: "Ignore", next: "ignored" }]);
    expect(actionsFor("fixed")).toEqual([{ label: "Reopen", next: "new" }]);
    expect(actionsFor("ignored")).toEqual([{ label: "Reopen", next: "new" }]);
    expect(doorWords(one(row({ status: "new" })))).toEqual(["Details", "Triaged", "Fixed", "Ignore"]);
    expect(doorWords(one(row({ status: "triaged" })))).toEqual(["Details", "Fixed", "Ignore"]);
    expect(doorWords(one(row({ status: "fixed" })))).toEqual(["Details", "Reopen"]);
    expect(doorWords(one(row({ status: "ignored" })))).toEqual(["Details", "Reopen"]);
    // a closed row's title is struck through; an open one's is not
    expect(one(row({ status: "fixed" }))).toContain("line-through");
    expect(one(row({ status: "triaged" }))).not.toContain("line-through");
  });
});

describe("the empty states and the failed read", () => {
  it("an empty New tab: Nothing new — the sink is quiet", () => {
    const s = list([]);
    expect(s).toContain("Nothing new");
    expect(s).toContain("The sink is quiet — no new errors to triage.");
    expect(s).toContain(">New<");
  });

  it("the Traces tab has its own empty words in the source (the list opens on New; the words are pinned, not rendered)", () => {
    const src = readFileSync(join(process.cwd(), "src/app/(app)/bugs/error-list.tsx"), "utf8");
    expect(src).toContain('tab === "traces" ? "No traces"');
    expect(src).toContain("No client footprints in the last fourteen days.");
  });

  it("a failed read is said where the list would be, with the database's words and no New count", () => {
    const s = list([row({ id: "a" })], "could not connect to server");
    expect(s).toContain("Couldn&#x27;t read the errors");
    expect(s).toContain("could not connect to server");
    expect(s).not.toContain("New (");
    expect(s).not.toContain("Nothing new");
    expect(s).not.toContain("<li");
  });
});

describe("Title Case on every door", () => {
  it("the tabs, the row's doors, the tenant row", () => {
    for (const t of TABS) expect(titleCase(t.label), t.label).toBe(true);
    for (const st of ["new", "triaged", "fixed", "ignored"]) for (const a of actionsFor(st)) expect(titleCase(a.label), a.label).toBe(true);
    const s = list([row({ id: "a", org: "Pinecone Electric" }), row({ id: "b", org: "Blue Heron Decks", status: "triaged" })]);
    const words = doorWords(s);
    expect(words.length).toBeGreaterThanOrEqual(6 + 3 + 2);
    for (const w of words) expect(titleCase(w), w).toBe(true);
    for (const w of doorWords(one(ROW, true))) expect(titleCase(w), w).toBe(true);
  });
});

describe("Bug Watch mounts the sink under the reports", () => {
  it("the page reads the sink and hands the list its rows and the read's error", () => {
    const page = readFileSync(join(process.cwd(), "src/app/(app)/bugs/page.tsx"), "utf8");
    expect(page).toContain("const errors = await listErrorEvents();");
    expect(page).toContain("<ErrorList initial={errors.rows} readError={errors.error} openCapped={errors.openCapped} />");
    expect(page).toContain(">Errors</h2>");
    expect(page).toContain("Every caught failure, deduped: the first sighting is kept, repeats are counted, a fixed one that returns comes back as new. Mark them as you go.");
    // the reports first, the sink second, the AI key third
    expect(page.indexOf("<BugList")).toBeLessThan(page.indexOf("<ErrorList"));
    expect(page.indexOf("<ErrorList")).toBeLessThan(page.indexOf("<AiStatus"));
  });

  it("the sink's 'Nothing new' sits behind the readError branch, and the New count is withheld on a failed read", () => {
    const src = readFileSync(join(process.cwd(), "src/app/(app)/bugs/error-list.tsx"), "utf8");
    const branch = src.indexOf("{readError ? (");
    const quiet = src.indexOf("The sink is quiet — no new errors to triage.");
    expect(branch).toBeGreaterThan(-1);
    expect(quiet).toBeGreaterThan(branch);
    expect(src).toContain('title="Couldn\'t read the errors" description={readError}');
    expect(src).toContain('t.key === "new" && !readError && newCount > 0');
  });
});
