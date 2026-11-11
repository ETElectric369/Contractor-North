import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * THE ONE RESULT SHEET OF MEASURE FROM THE + (cn-v1160). What is pinned here: which doors each place
 * gets (a job's page, on the clock, neither with Leads on or off, a visit's page with a held model),
 * that nothing is offered that cannot be done (no picture, no answer yet, a row that is owed), what a
 * save's answer becomes, that a refusal is its sentence and Done, and the two laws of the Modal it
 * stands in: never keyed, never closed and navigated in one tick. The suite has no browser, so the
 * decisions are pure functions and the drawing is a static render. Every id and name is invented.
 */

const nav = vi.hoisted(() => ({ path: "/planner" as string, push: vi.fn() }));
vi.mock("next/navigation", () => ({ usePathname: () => nav.path, useRouter: () => ({ push: nav.push, replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }) }));
const saves = vi.hoisted(() => ({ visitMadeFor: vi.fn((): string | null => null) }));
vi.mock("@/lib/quick-measure-save", () => ({
  discardModel: vi.fn(),
  finishSavingModel: vi.fn(),
  forgetFigure: vi.fn(),
  forgetMeasureVisitOf: vi.fn(),
  modelTrip: vi.fn(() => null),
  saveMeasureToJob: vi.fn(),
  saveModelToJob: vi.fn(),
  startInspectionWith: vi.fn(),
  visitMadeFor: saves.visitMadeFor,
}));
const bridge = vi.hoisted(() => ({ measureNative: vi.fn(), scan3dNative: vi.fn(), discardScan: vi.fn(async () => {}) }));
vi.mock("@/lib/native-measure", () => ({ measureNative: bridge.measureNative }));
vi.mock("@/lib/native-scan", () => ({ scan3dNative: bridge.scan3dNative, discardScan: bridge.discardScan }));

import { LangProvider } from "@/components/lang-provider";
import { FEATURE_KEYS, type FeatureMap } from "@/lib/features";
import { translator } from "@/lib/i18n";
import { words as shell } from "@/lib/words/shell";
import {
  measureStore,
  registerMeasureHost,
  resetMeasureStoreForTest,
  runQuickMeasure,
  whereIsHe,
  type HeldModel,
  type MeasureContext,
  type MeasureFigure,
  type OpenResult,
} from "@/lib/quick-measure";
import {
  QuickMeasureBody,
  QuickMeasureSheet,
  figureOnly,
  freshSitting,
  patchSitting,
  sheetAfterSave,
  sheetDoors,
  type SheetDoor,
  type SheetPlan,
} from "./quick-measure-sheet";

const ORG = "0a000000-0000-4000-8000-00000000c001";
const USER = "0d000000-0000-4000-8000-00000000f001";
const JOB = "0b000000-0000-4000-8000-00000000d001";
const CLOCK_JOB = "0b000000-0000-4000-8000-00000000d047";
const VISIT = "0c000000-0000-4000-8000-00000000e001";

const en = translator("en");
const es = translator("es");
const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");
const src = read("src/components/quick-measure-sheet.tsx");
const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/^\s*\/\/.*$/gm, "");
/** A render as a person reads it: no tags, entities as the characters they stand for. */
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

const photo = () => new File([new Uint8Array(64)], "measure-1.jpg", { type: "image/jpeg" });
const figureOf = (over: Partial<MeasureFigure> = {}): MeasureFigure => ({ mode: "length", value: 12, unit: "ft", caption: "12 ft 0 in", approx: false, photo: photo(), ...over });
const aFigure = (over: Partial<MeasureFigure> = {}): OpenResult => ({ kind: "figure", figure: figureOf(over) });
const aModel: OpenResult = { kind: "model" };
/** A held model 62 MB on the scale (only its size is read by the sheet). */
const heldOf = (over: Partial<HeldModel> = {}): HeldModel => ({
  model: { size: 62_000_000, name: "scan-3d-1.usdz" } as File,
  path: "/tmp/north-scans/scan-3d-1.usdz",
  shots: 40,
  landed: null,
  ...over,
});

const onClock: MeasureContext = { ok: true, userId: USER, orgId: ORG, punchJob: { id: CLOCK_JOB, label: "J-047 · Larkspur" } };
const offClock: MeasureContext = { ok: true, userId: USER, orgId: ORG, punchJob: null };
const allOn = Object.fromEntries(FEATURE_KEYS.map((k) => [k, true])) as FeatureMap;
const leadsOff: FeatureMap = { ...allOn, leads: false };

const onJob = whereIsHe(`/jobs/${JOB}`, false);
const nowhere = whereIsHe("/planner", false);
const onVisit = whereIsHe(`/appointments/${VISIT}`, true);
const ids = (p: SheetPlan) => p.doors.map((d) => d.id);

beforeEach(() => {
  resetMeasureStoreForTest();
  nav.path = "/planner";
  nav.push.mockReset();
  saves.visitMadeFor.mockReset();
  saves.visitMadeFor.mockReturnValue(null);
  bridge.measureNative.mockReset();
  bridge.scan3dNative.mockReset();
  bridge.discardScan.mockClear();
});

describe("the doors, for where he is", () => {
  it("the places are what the address says", () => {
    expect(onJob).toEqual({ kind: "job", jobId: JOB });
    expect(nowhere).toEqual({ kind: "nowhere" });
    expect(onVisit).toEqual({ kind: "visit" });
  });

  it("ON A JOB'S PAGE: Save to This Job, then Don't Keep It, for a figure and for a model", () => {
    const fig = sheetDoors({ place: onJob, ctx: offClock, open: aFigure(), held: null, features: allOn });
    expect(fig.doors).toEqual([{ id: "thisJob", jobId: JOB }, { id: "dontKeep" }]);
    expect(fig.lines).toEqual(["notSaved"]);
    const mod = sheetDoors({ place: onJob, ctx: offClock, open: aModel, held: heldOf(), features: allOn });
    expect(mod.doors).toEqual([{ id: "thisJob", jobId: JOB }, { id: "dontKeep" }]);
    expect(mod.lines).toEqual(["modelWaits"]);
  });

  it("on a job's page the page wins: being clocked on ANOTHER job adds no door, and no inspection is offered there", () => {
    const p = sheetDoors({ place: onJob, ctx: onClock, open: aFigure(), held: null, features: allOn });
    expect(ids(p)).toEqual(["thisJob", "dontKeep"]);
    expect(p.lines).not.toContain("onClockThere");
  });

  it("NOT ON A JOB'S PAGE BUT ON THE CLOCK: Save to that job, named, with the line that says why it is offered", () => {
    const p = sheetDoors({ place: nowhere, ctx: onClock, open: aFigure(), held: null, features: allOn });
    expect(p.doors).toEqual([{ id: "clockJob", jobId: CLOCK_JOB, job: "J-047 · Larkspur" }, { id: "inspection", retry: false }, { id: "dontKeep" }]);
    expect(p.lines).toEqual(["notSaved", "onClockThere"]);
    // With Leads & Inspections off the clocked-on job is still there.
    expect(ids(sheetDoors({ place: nowhere, ctx: onClock, open: aFigure(), held: null, features: leadsOff }))).toEqual(["clockJob", "dontKeep"]);
  });

  it("NEITHER, WITH LEADS ON: Start an Inspection with It", () => {
    const fig = sheetDoors({ place: nowhere, ctx: offClock, open: aFigure(), held: null, features: allOn });
    expect(fig.doors).toEqual([{ id: "inspection", retry: false }, { id: "dontKeep" }]);
    expect(fig.lines).toEqual(["notSaved"]);
    const mod = sheetDoors({ place: nowhere, ctx: offClock, open: aModel, held: heldOf(), features: allOn });
    expect(ids(mod)).toEqual(["inspection", "dontKeep"]);
    // No switch map at all reads as every switch on, as everywhere in the app.
    expect(ids(sheetDoors({ place: nowhere, ctx: offClock, open: aFigure(), held: null }))).toEqual(["inspection", "dontKeep"]);
  });

  it("NEITHER, WITH LEADS OFF: nothing is filed by guess. A figure says there is nowhere; a model says it waits", () => {
    const fig = sheetDoors({ place: nowhere, ctx: offClock, open: aFigure(), held: null, features: leadsOff });
    expect(fig.doors).toEqual([{ id: "dontKeep" }]);
    expect(fig.lines).toEqual(["notSaved", "nowhere"]);
    const mod = sheetDoors({ place: nowhere, ctx: offClock, open: aModel, held: heldOf(), features: leadsOff });
    expect(mod.doors).toEqual([{ id: "dontKeep" }]);
    expect(mod.lines).toEqual(["modelWaits"]);
  });

  it("A VISIT'S PAGE WITH A HELD MODEL: Save to This Visit first; the clocked-on job after it; never a new inspection from inside a visit", () => {
    const p = sheetDoors({ place: onVisit, ctx: offClock, open: aModel, held: heldOf(), features: allOn });
    expect(p.doors).toEqual([{ id: "visit" }, { id: "dontKeep" }]);
    expect(p.lines).toEqual(["modelWaits"]);
    const clocked = sheetDoors({ place: onVisit, ctx: onClock, open: aModel, held: heldOf(), features: allOn });
    expect(ids(clocked)).toEqual(["visit", "clockJob", "dontKeep"]);
    // A visit takes a model through its Inspector; a figure there is the Inspector's own button's work.
    expect(ids(sheetDoors({ place: onVisit, ctx: offClock, open: aFigure(), held: heldOf(), features: allOn }))).toEqual(["dontKeep"]);
  });

  it("Don't Keep It is always there, and always last", () => {
    for (const place of [onJob, nowhere, onVisit]) {
      for (const ctx of [onClock, offClock]) {
        for (const open of [aFigure(), aFigure({ photo: null }), aModel]) {
          for (const features of [allOn, leadsOff]) {
            const p = sheetDoors({ place, ctx, open, held: heldOf(), features });
            expect(p.doors.at(-1)).toEqual({ id: "dontKeep" });
            expect(p.doors.filter((d) => d.id === "dontKeep")).toHaveLength(1);
          }
        }
      }
    }
  });

  it("a figure off a phone with no sensor carries the line that says so", () => {
    expect(sheetDoors({ place: onJob, ctx: offClock, open: aFigure({ approx: true, caption: "12 ft 0 in (approx.)" }), held: null }).lines).toEqual(["approx", "notSaved"]);
  });

  it("A FIGURE WHOSE PICTURE DID NOT COME BACK has nothing to file on a job: no job door, the reason said, and a new inspection can still take it", () => {
    const noPic = aFigure({ photo: null });
    const job = sheetDoors({ place: onJob, ctx: onClock, open: noPic, held: null, features: allOn });
    expect(job.doors).toEqual([{ id: "dontKeep" }]);
    expect(job.lines).toEqual(["notSaved", "noPicture"]); // why, and never "nowhere" on top of it
    const out = sheetDoors({ place: nowhere, ctx: onClock, open: noPic, held: null, features: allOn });
    expect(ids(out)).toEqual(["inspection", "dontKeep"]);
    expect(out.lines).toEqual(["notSaved", "noPicture"]);
  });

  it("UNTIL THE READ ANSWERS no door is drawn (none can slide under a finger later), and what is known is still said", () => {
    const fig = sheetDoors({ place: nowhere, ctx: null, open: aFigure(), held: null, features: allOn });
    expect(fig).toEqual({ asking: true, doors: [], lines: ["notSaved"], refusal: null });
    const mod = sheetDoors({ place: onJob, ctx: null, open: aModel, held: heldOf(), features: allOn });
    expect(mod).toEqual({ asking: true, doors: [], lines: ["modelWaits"], refusal: null });
  });

  it("A READ THAT FAILED: its own words, Try Again, and no save door (every save needs the company)", () => {
    const failed: MeasureContext = { ok: false, error: en("sh_checkSignal") };
    const p = sheetDoors({ place: onJob, ctx: failed, open: aFigure(), held: null, features: allOn });
    expect(p.doors).toEqual([{ id: "askAgain" }, { id: "dontKeep" }]);
    expect(p.refusal).toBe("Check your signal and try again — nothing was lost.");
    expect(p.asking).toBe(false);
    expect(ids(sheetDoors({ place: nowhere, ctx: failed, open: aModel, held: heldOf(), features: allOn }))).toEqual(["askAgain", "dontKeep"]);
  });

  it("THE CLOCK COULD NOT BE READ: said with Try Again, never drawn as 'not on the clock'; the other doors stand", () => {
    const unread: MeasureContext = { ok: true, userId: USER, orgId: ORG, punchJob: null, punchUnread: true };
    const fig = sheetDoors({ place: nowhere, ctx: unread, open: aFigure(), held: null, features: allOn });
    expect(ids(fig)).toEqual(["inspection", "askAgain", "dontKeep"]);
    expect(fig.lines).toContain("clockUnread");
    expect(fig.refusal).toBeNull();
    const html = renderToStaticMarkup(
      <LangProvider lang="es">
        <QuickMeasureBody of={aFigure()} held={null} plan={fig} onDoor={() => {}} />
      </LangProvider>,
    );
    expect(text(html)).toContain(es("sh_measure_clockUnread"));
    // On a job's own page the clocked-on job is never offered, so nothing is missing there.
    const there = sheetDoors({ place: onJob, ctx: unread, open: aFigure(), held: null, features: allOn });
    expect(ids(there)).toEqual(["thisJob", "dontKeep"]);
    expect(there.lines).not.toContain("clockUnread");
  });

  it("THE FILE IS UP AND THE ROW IS OWED: one door, Finish Saving, wherever he is and whatever the read says", () => {
    const owed = heldOf({ landed: { jobId: JOB, path: `${ORG}/${JOB}/1-scan-3d-1.usdz`, name: "scan-3d-1.usdz" } });
    for (const place of [onJob, nowhere, onVisit]) {
      for (const ctx of [null, offClock, onClock, { ok: false as const, error: "x" }]) {
        const p = sheetDoors({ place, ctx, open: aModel, held: owed, features: allOn });
        expect(p.doors).toEqual([{ id: "finish", jobId: JOB, job: null }, { id: "dontKeep" }]);
        expect(p.lines).toEqual(["rowOwed"]);
        expect(p.asking).toBe(false);
      }
    }
    // The job is named when it is the one he is clocked on (the only job whose label the sheet has).
    const clockedThere = heldOf({ landed: { jobId: CLOCK_JOB, path: "p", name: "scan-3d-1.usdz" } });
    expect(sheetDoors({ place: nowhere, ctx: onClock, open: aModel, held: clockedThere }).doors[0]).toEqual({ id: "finish", jobId: CLOCK_JOB, job: "J-047 · Larkspur" });
  });

  it("A VISIT THAT WAS MADE AND NOT FILLED: the door is Try Again and the sheet says what happened", () => {
    const p = sheetDoors({ place: nowhere, ctx: offClock, open: aFigure(), held: null, visitId: VISIT, features: allOn });
    expect(p.doors).toEqual([{ id: "inspection", retry: true }, { id: "dontKeep" }]);
    expect(p.lines).toEqual(["notSaved", "inspectionMadeNotFilled"]);
    // Somewhere the inspection door is not drawn, the line about it is not said either.
    expect(sheetDoors({ place: onJob, ctx: offClock, open: aFigure(), held: null, visitId: VISIT }).lines).toEqual(["notSaved"]);
  });

  it("a refusal has nothing to keep, and a model the + no longer holds has nothing to offer: Done", () => {
    expect(sheetDoors({ place: onJob, ctx: onClock, open: { kind: "refused", said: "x" }, held: null })).toEqual({ asking: false, doors: [{ id: "done" }], lines: [], refusal: null });
    expect(sheetDoors({ place: onJob, ctx: onClock, open: aModel, held: null }).doors).toEqual([{ id: "done" }]);
  });
});

describe("what a save's answer becomes", () => {
  it("not saved: the door is free again and the reason is said; a reason the sheet already shows is not said twice", () => {
    expect(sheetAfterSave({ ok: false, door: "job", error: "No.", final: false }, { pathname: "/planner", t: en })).toEqual({ working: null, fault: "No.", after: null });
    expect(sheetAfterSave({ ok: false, door: "job", error: null, final: false }, { pathname: "/planner", t: en })).toEqual({ working: null, fault: null, after: null });
  });

  it("a figure in a job's Photos: the sentence, and Open Photos unless he is on that job's own page", () => {
    const away = sheetAfterSave({ ok: true, door: "job", stamped: true }, { went: CLOCK_JOB, pathname: "/planner", t: en });
    expect(away.after).toEqual({
      said: "Saved to the job's Photos. The figure is on the picture.",
      go: { to: "photos", href: `/jobs/${CLOCK_JOB}?tab=photos`, path: `/jobs/${CLOCK_JOB}` },
    });
    const there = sheetAfterSave({ ok: true, door: "job", stamped: true }, { went: JOB, pathname: `/jobs/${JOB}`, t: en });
    expect(there.after).toEqual({ said: "Saved to the job's Photos. The figure is on the picture.", go: null });
  });

  it("a picture the figure could not be drawn on is never said to carry it", () => {
    const r = sheetAfterSave({ ok: true, door: "job", stamped: false }, { went: JOB, pathname: `/jobs/${JOB}`, t: en });
    expect(r.after?.said).toBe("Saved to the job's Photos. The figure is in the picture's name.");
    expect(sheetAfterSave({ ok: true, door: "job", stamped: false }, { went: JOB, pathname: `/jobs/${JOB}`, t: es }).after?.said).toBe(
      "Guardada en las Fotos del trabajo. La medida está en el nombre de la foto.",
    );
  });

  it("a model on a job's papers: its own sentence, no link", () => {
    expect(sheetAfterSave({ ok: true, door: "job" }, { pathname: "/planner", t: en }).after).toEqual({ said: "Saved to the job's papers.", go: null });
  });

  it("a new inspection: the sentence (a page that never arrives leaves no save unsaid), and the visit's own address is where the sheet goes", () => {
    expect(sheetAfterSave({ ok: true, door: "inspection", visitId: VISIT }, { pathname: "/planner", t: en })).toEqual({
      working: null,
      fault: null,
      after: { said: "Saved on a new inspection.", go: { to: "inspection", href: `/appointments/${VISIT}`, path: `/appointments/${VISIT}` } },
    });
    expect(sheetAfterSave({ ok: true, door: "inspection", visitId: VISIT }, { pathname: "/planner", t: es }).after?.said).toBe("Se guardó en una inspección nueva.");
  });

  it("every save that landed has its sentence: none is left to a page that may not arrive", () => {
    const landed = [
      sheetAfterSave({ ok: true, door: "job", stamped: true }, { went: JOB, pathname: "/planner", t: en }),
      sheetAfterSave({ ok: true, door: "job", stamped: false }, { went: JOB, pathname: "/planner", t: en }),
      sheetAfterSave({ ok: true, door: "job" }, { pathname: "/planner", t: en }),
      sheetAfterSave({ ok: true, door: "inspection", visitId: VISIT }, { pathname: "/planner", t: en }),
    ];
    for (const r of landed) expect(r.after?.said.trim().length).toBeGreaterThan(10);
    expect(new Set(landed.map((r) => r.after?.said)).size).toBe(4);
  });
});

describe("what the sheet remembers belongs to its sitting", () => {
  it("the same sitting takes a change; a newer one starts from nothing; an older one changes nothing", () => {
    const one = patchSitting(freshSitting(1), 1, { working: "job" });
    expect(one).toEqual({ ...freshSitting(1), working: "job" });
    // An answer for sitting 1 that comes back during sitting 2 lands nowhere.
    const two = patchSitting(one, 2, { ctx: offClock });
    expect(two).toEqual({ ...freshSitting(2), ctx: offClock });
    expect(two.working).toBeNull();
    expect(patchSitting(two, 1, { fault: "late" })).toBe(two);
  });
});

describe("the figure, and the words beside it", () => {
  it("(approx.) is taken off the figure: it is said as a sentence, in his language", () => {
    expect(figureOnly("12 ft 0 in (approx.)")).toBe("12 ft 0 in");
    expect(figureOnly("100 sq ft (approx.)")).toBe("100 sq ft");
    expect(figureOnly("3 ft 10.3 in")).toBe("3 ft 10.3 in");
  });
});

describe("the sheet's inside, as it is drawn", () => {
  const draw = (o: { of: OpenResult; held?: HeldModel | null; plan: SheetPlan | null; lang?: "en" | "es" } & Partial<Parameters<typeof QuickMeasureBody>[0]>) => {
    const { lang = "en", held = null, ...rest } = o;
    return renderToStaticMarkup(
      <LangProvider lang={lang}>
        <QuickMeasureBody held={held} onDoor={() => {}} {...rest} />
      </LangProvider>,
    );
  };
  const buttons = (html: string) => [...html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)].map((m) => text(m[1]));

  it("on a job's page: the figure large, Not saved yet, Save to This Job and Don't Keep It, in that order", () => {
    const of = aFigure();
    const html = draw({ of, plan: sheetDoors({ place: onJob, ctx: offClock, open: of, held: null, features: allOn }), src: "blob:picture" });
    expect(html).toContain('<img src="blob:picture" alt="12 ft 0 in"');
    expect(html).toMatch(/<p class="text-3xl[^"]*">12 ft 0 in<\/p>/);
    expect(text(html)).toContain("Not saved yet.");
    expect(buttons(html)).toEqual(["Save to This Job", "Don't Keep It"]);
    expect(text(html)).not.toContain("Start an Inspection with It");
  });

  it("on the clock: Save to the job by its label, why it is offered, then a new inspection", () => {
    const of = aFigure();
    const html = draw({ of, plan: sheetDoors({ place: nowhere, ctx: onClock, open: of, held: null, features: allOn }) });
    expect(buttons(html)).toEqual(["Save to J-047 · Larkspur", "Start an Inspection with It", "Don't Keep It"]);
    expect(text(html)).toContain("Save to J-047 · Larkspur You're on the clock there.");
    // The first door is the filled one; the last is never drawn as a save.
    const cls = [...html.matchAll(/<button\b[^>]*class="([^"]*)"/g)].map((m) => m[1]);
    expect(cls[0]).toContain("bg-[rgb(var(--glass-ink))]");
    expect(cls[1]).toContain("bg-slate-100");
    expect(cls[2]).not.toMatch(/bg-\[rgb\(var\(--glass-ink\)\)\]|bg-slate-100/);
    // Every door is a 44px target, and a long job label wraps instead of running off the sheet.
    for (const c of cls) {
      expect(c).toContain("min-h-11");
      expect(c).toContain("w-full");
      expect(c).toContain("whitespace-normal");
    }
  });

  it("neither, Leads on: Start an Inspection with It. Leads off: the sentence that says there is nowhere, and only Don't Keep It", () => {
    const of = aFigure();
    const on = draw({ of, plan: sheetDoors({ place: nowhere, ctx: offClock, open: of, held: null, features: allOn }) });
    expect(buttons(on)).toEqual(["Start an Inspection with It", "Don't Keep It"]);
    const off = draw({ of, plan: sheetDoors({ place: nowhere, ctx: offClock, open: of, held: null, features: leadsOff }) });
    expect(buttons(off)).toEqual(["Don't Keep It"]);
    expect(text(off)).toContain("Nothing is open to save it to. Open the job it belongs to, then measure there.");
  });

  it("a visit's page with a held model: its size, that it waits in the +, Save to This Visit", () => {
    const held = heldOf();
    const html = draw({ of: aModel, held, plan: sheetDoors({ place: onVisit, ctx: offClock, open: aModel, held, features: allOn }) });
    expect(text(html)).toContain("The 3D model is ready (62 MB).");
    expect(text(html)).toContain("It waits in + until you save it or discard it.");
    expect(buttons(html)).toEqual(["Save to This Visit", "Don't Keep It"]);
  });

  it("a phone with no sensor: the figure without its English mark, and the sentence that says it is close, not exact", () => {
    const of = aFigure({ approx: true, caption: "12 ft 0 in (approx.)" });
    const html = draw({ of, plan: sheetDoors({ place: onJob, ctx: offClock, open: of, held: null }) });
    expect(html).toMatch(/<p class="text-3xl[^"]*">12 ft 0 in<\/p>/);
    expect(text(html)).toContain("Close, not exact: this phone has no LiDAR sensor.");
    const spanish = draw({ of, plan: sheetDoors({ place: onJob, ctx: offClock, open: of, held: null }), lang: "es" });
    expect(text(spanish)).toContain("Aproximada, no exacta: este teléfono no tiene sensor LiDAR.");
    expect(text(spanish)).not.toContain("(approx.)");
  });

  it("no picture: no <img>, the reason, and no job door", () => {
    const of = aFigure({ photo: null });
    const html = draw({ of, plan: sheetDoors({ place: onJob, ctx: offClock, open: of, held: null }), src: null });
    expect(html).not.toContain("<img");
    expect(text(html)).toContain("The picture didn't come back, so there is nothing to file on a job. Read the figure here.");
    expect(buttons(html)).toEqual(["Don't Keep It"]);
  });

  it("the row is owed: the sentence, and Finish Saving named for the job when the sheet knows its label", () => {
    const owed = heldOf({ landed: { jobId: JOB, path: "p", name: "scan-3d-1.usdz" } });
    const html = draw({ of: aModel, held: owed, plan: sheetDoors({ place: nowhere, ctx: offClock, open: aModel, held: owed }) });
    expect(text(html)).toContain("The model is up, but the job didn't take it. Tap Finish Saving.");
    expect(buttons(html)).toEqual(["Finish Saving to the Job", "Don't Keep It"]);
    const there = heldOf({ landed: { jobId: CLOCK_JOB, path: "p", name: "scan-3d-1.usdz" } });
    expect(buttons(draw({ of: aModel, held: there, plan: sheetDoors({ place: nowhere, ctx: onClock, open: aModel, held: there }) }))).toEqual([
      "Finish Saving to J-047 · Larkspur",
      "Don't Keep It",
    ]);
    // The sentence names the button by the words every form of it starts with, in both languages.
    for (const t of [en, es]) {
      const named = t("sh_measure_rowOwed").match(/(?:Tap|Toca) (.+)\.$/)![1];
      expect(t("sh_btn_measureFinishSavingJob").startsWith(named)).toBe(true);
      expect(t("sh_btn_measureFinishSaving").startsWith(named)).toBe(true);
    }
  });

  it("a visit made and not filled: the sentence, and the door it names", () => {
    const of = aFigure();
    const html = draw({ of, plan: sheetDoors({ place: nowhere, ctx: offClock, open: of, held: null, visitId: VISIT, features: allOn }) });
    expect(text(html)).toContain("The inspection was started, but this didn't save on it. Tap Try Again.");
    expect(buttons(html)).toEqual(["Try Again", "Don't Keep It"]);
  });

  it("still asking: no door at all. A read that failed: its words and Try Again", () => {
    const of = aFigure();
    const asking = draw({ of, plan: sheetDoors({ place: nowhere, ctx: null, open: of, held: null }) });
    expect(buttons(asking)).toEqual([]);
    expect(asking).toContain("animate-spin");
    const failed = draw({ of, plan: sheetDoors({ place: nowhere, ctx: { ok: false, error: en("sh_checkSignal") }, open: of, held: null }) });
    expect(text(failed)).toContain("Check your signal and try again — nothing was lost.");
    expect(buttons(failed)).toEqual(["Try Again", "Don't Keep It"]);
  });

  it("while a save is out: its own door says Saving…, and every door is held", () => {
    const of = aFigure();
    const plan = sheetDoors({ place: nowhere, ctx: onClock, open: of, held: null, features: allOn });
    const html = draw({ of, plan, working: "inspection" });
    expect(buttons(html)).toEqual(["Save to J-047 · Larkspur", "Saving…", "Don't Keep It"]);
    expect(html.match(/<button\b[^>]*\bdisabled=""/g)).toHaveLength(3);
    expect(buttons(draw({ of, plan, working: "job" }))).toEqual(["Saving…", "Start an Inspection with It", "Don't Keep It"]);
  });

  it("a save that failed says why, where the doors are, and the doors are all still there", () => {
    const of = aFigure();
    const html = draw({ of, plan: sheetDoors({ place: onJob, ctx: offClock, open: of, held: null }), fault: "The file didn't go: no signal. Try again where there's service." });
    expect(html).toContain('role="alert"');
    expect(text(html)).toContain("The file didn't go: no signal. Try again where there's service.");
    expect(buttons(html)).toEqual(["Save to This Job", "Don't Keep It"]);
  });

  it("saved: the figure stays, the sentence, no door to save it again, and the way to where it went", () => {
    const of = aFigure();
    const there = draw({ of, plan: null, src: "blob:picture", after: { said: en("sh_measure_savedToPhotos"), go: null } });
    expect(text(there)).toContain("12 ft 0 in");
    expect(text(there)).toContain("Saved to the job's Photos. The figure is on the picture.");
    expect(text(there)).not.toContain("Not saved yet.");
    expect(buttons(there)).toEqual([]);
    expect(there).not.toContain("<a ");
    const away = draw({ of, plan: null, after: { said: en("sh_measure_savedToPhotos"), go: { to: "photos", href: `/jobs/${CLOCK_JOB}?tab=photos`, path: `/jobs/${CLOCK_JOB}` } } });
    expect(away).toMatch(new RegExp(`<a [^>]*href="/jobs/${CLOCK_JOB}\\?tab=photos"[^>]*>Open Photos</a>`));
    // A new inspection: said in words while its page is on its way, with the door to it for when it does not arrive.
    const went = sheetAfterSave({ ok: true, door: "inspection", visitId: VISIT }, { pathname: "/planner", t: en }).after;
    const visit = draw({ of, plan: null, after: went });
    expect(visit).toContain('role="status"');
    expect(text(visit)).toContain("Saved on a new inspection.");
    expect(visit).toMatch(new RegExp(`<a [^>]*href="/appointments/${VISIT}"[^>]*>Open the Inspection</a>`));
    expect(buttons(visit)).toEqual([]);
    // A model keeps its own head once saved (the + has let go of it by then; the sheet still says what it was).
    const model = draw({ of: aModel, held: heldOf(), plan: null, after: { said: en("sh_measure_savedModel"), go: null } });
    expect(text(model)).toContain("The 3D model is ready (62 MB).");
    expect(text(model)).toContain("Saved to the job's papers.");
    expect(text(model)).not.toContain("It waits in +");
  });

  it("letting go of a model is a second step: the question in the Inspector's own words, and no door behind it", () => {
    const held = heldOf();
    const html = draw({ of: aModel, held, plan: sheetDoors({ place: onJob, ctx: offClock, open: aModel, held }), confirming: true });
    expect(text(html)).toContain("Discard the kept 3D model? The room would need scanning again.");
    expect(buttons(html)).toEqual([]);
  });

  it("in Spanish every word is the catalog's, the job's label as it is stored", () => {
    const of = aFigure();
    const html = draw({ of, plan: sheetDoors({ place: nowhere, ctx: onClock, open: of, held: null, features: allOn }), lang: "es" });
    expect(buttons(html)).toEqual(["Guardar en J-047 · Larkspur", "Iniciar una Inspección con Esto", "No Guardar"]);
    expect(text(html)).toContain("Aún sin guardar.");
    expect(text(html)).toContain("Estás en el reloj ahí.");
    const job = draw({ of, plan: sheetDoors({ place: onJob, ctx: offClock, open: of, held: null }), lang: "es" });
    expect(buttons(job)).toEqual(["Guardar en Este Trabajo", "No Guardar"]);
  });

  it("a door's tap hands back the door it was drawn from", () => {
    // The body is drawn from its plan and nothing else: what it offers is exactly what sheetDoors decided.
    const plan = sheetDoors({ place: nowhere, ctx: onClock, open: aFigure(), held: null, features: allOn });
    const drawnIds: SheetDoor["id"][] = ["visit", "thisJob", "clockJob", "finish", "inspection", "askAgain", "dontKeep"];
    expect(plan.doors.every((d) => drawnIds.includes(d.id))).toBe(true);
    for (const id of drawnIds) expect(code).toContain(`{door("${id}")}`);
  });
});

describe("the sheet, mounted once by the +", () => {
  const mount = (lang: "en" | "es" = "en") =>
    renderToStaticMarkup(
      <LangProvider lang={lang}>
        <QuickMeasureSheet features={allOn} />
      </LangProvider>,
    );

  it("draws nothing while no result is open", () => {
    expect(mount()).toBe("");
  });

  it("A REFUSAL: the plugin's own sentence, and Done", async () => {
    bridge.measureNative.mockResolvedValueOnce({ ok: false, refused: "Measure needs the North app on an iPhone." });
    await runQuickMeasure("length");
    expect(measureStore().open).toEqual({ kind: "refused", said: "Measure needs the North app on an iPhone." });
    const html = mount();
    expect(html).toMatch(/<h2[^>]*>Lidar<\/h2>/);
    expect(html).toContain('role="alert"');
    expect(text(html)).toContain("Measure needs the North app on an iPhone.");
    const buttons = [...html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)].map((m) => text(m[1])).filter(Boolean);
    expect(buttons).toEqual(["Done"]);
    expect(text(mount("es"))).toContain("Listo");
    // Nothing of a refusal can be lost by closing: no two-tap guard, no door to save.
    expect(text(html)).not.toContain("Don't Keep It");
  });

  it("a figure: the sheet opens on it at once, titled, with no door until the read has answered", async () => {
    bridge.measureNative.mockResolvedValueOnce({ ok: true, mode: "length", value: 12, unit: "ft", caption: "12 ft 0 in", points: 2, lidar: true, approx: false, photo: photo() });
    await runQuickMeasure("length");
    const html = mount();
    expect(html).toMatch(/<h2[^>]*>Measurement<\/h2>/);
    expect(text(html)).toContain("12 ft 0 in");
    expect(text(html)).toContain("Not saved yet.");
    expect(text(html)).not.toContain("Save to");
    expect(mount("es")).toMatch(/<h2[^>]*>Medida<\/h2>/);
    // NO DONE UNDER AN UNSAVED FIGURE while the sheet is asking: an empty list of doors is not "only
    // Done", and a Done there would let the figure go in one tap, past the Modal's two-tap guard.
    const buttons = [...html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)].map((m) => text(m[1])).filter(Boolean);
    expect(buttons).not.toContain("Done");
    expect(code).toContain('const onlyDone = !!L.after || !plan || (plan.doors.length > 0 && plan.doors.every((d) => d.id === "done"));');
  });

  it("a model: titled for what it is, with its size, held from the moment it came back", async () => {
    bridge.scan3dNative.mockResolvedValueOnce({ ok: true, kind: "model", model: new File([new Uint8Array(2_500_000)], "scan-3d-1.usdz"), shots: 40, path: "/tmp/north-scans/scan-3d-1.usdz" });
    await runQuickMeasure("scan", { now: 1 });
    expect(measureStore().held).not.toBeNull();
    const html = mount();
    expect(html).toMatch(/<h2[^>]*>3D Model<\/h2>/);
    expect(text(html)).toContain("The 3D model is ready (2.5 MB).");
    expect(text(html)).toContain("It waits in + until you save it or discard it.");
  });

  it("on a visit's page the place is the visit only while its Inspector answers", () => {
    const off = registerMeasureHost(() => ({ measure: () => {}, scan: () => {}, adoptModel: () => true }));
    expect(whereIsHe(`/appointments/${VISIT}`, true)).toEqual({ kind: "visit" });
    off();
    // A visit he can only read registers no host: it is nowhere, and the sheet asks.
    expect(whereIsHe(`/appointments/${VISIT}`, false)).toEqual({ kind: "nowhere" });
  });
});

describe("the two laws of the Modal it stands in, pinned in the source", () => {
  it("NEVER KEYED: the file carries no key at all, and draws its doors one by one so it needs none", () => {
    expect(src).not.toMatch(/\bkey=/);
    expect(code).not.toMatch(/\.map\(/);
  });

  it("ONE Modal, always mounted, opened and closed by its `open` alone", () => {
    expect(code.match(/<Modal[\s>]/g)).toHaveLength(1);
    expect(code).toContain("open={show}");
    // Never drawn behind a condition (a Modal that is unmounted and mounted again is a remount).
    expect(code).not.toMatch(/&&\s*\(?\s*<Modal[\s>]/);
    expect(code).not.toMatch(/\?\s*\(?\s*<Modal[\s>]/);
    const fn = code.slice(code.indexOf("export function QuickMeasureSheet("), code.indexOf("function Note("));
    expect(fn.match(/\breturn \(\s*<Modal/g)).toHaveLength(1);
    expect(fn).not.toMatch(/return null/);
  });

  it("a figure is guarded while it is unsaved, and a write that is out holds the sheet for its answer", () => {
    expect(code).toContain('dirty={s.open?.kind === "figure" && !L.after}');
    expect(code).toContain("holdOpen={L.working !== null}");
  });

  it("NEVER CLOSED AND NAVIGATED IN ONE TICK: the push goes out with the sheet up, and the sheet goes when the address has changed", () => {
    expect(code.match(/router\.push\(/g)).toHaveLength(1);
    const land = code.slice(code.indexOf("const land = async"), code.indexOf("const toVisit = async"));
    const afterPush = land.slice(land.indexOf("router.push("));
    expect(afterPush).not.toMatch(/endSitting\(|closeMeasureSheet\(|close\(/);
    // The one place the sheet goes after a navigation waits for the address.
    expect(code).toMatch(/if \(going && pathname === going\) endSitting\(\);/);
  });

  it("reads the store the way the + does, and asks who is on the phone through the one route, in its own words", () => {
    expect(code).toContain("useSyncExternalStore(subscribeMeasure, measureStore, measureStore)");
    // A route, never a server action (Next queues one client's actions behind each other), and a
    // failure is the reader's own catalog sentence.
    expect(code.match(/await askMeasureContext\(t\("sh_checkSignal"\)\)/g)).toHaveLength(1);
    expect(src).not.toMatch(/quick-measure-actions|measureContext\(\)/);
    // What is this person's to see is the store's own rule (a model hidden when the app was left is not).
    expect(code).toContain("const heldNow = heldModelOf(s);");
    expect(code).not.toMatch(/\.left\b/);
  });

  it("WHO IS NAMED: the read's key goes to the store, and NEVER from an answer that outlived the sheet", () => {
    // A sign-out is a soft navigation: the + (and this sheet) unmount, and somebody else may be on
    // the phone when a read asked before it answers. Naming the one who left would un-hide what the
    // leaving hid, for whoever is here now.
    expect(code).toMatch(/const c = await askMeasureContext\(t\("sh_checkSignal"\)\);\s*if \(live\.current\) setMeasureOwner\(measureOwnerKey\(c\)\);/);
    expect(code.match(/setMeasureOwner\(/g)).toHaveLength(1);
    expect(code).toMatch(/const live = useRef\(true\);\s*useEffect\(\(\) => \{\s*live\.current = true;\s*return \(\) => \{\s*live\.current = false;\s*\};\s*\}, \[\]\);/);
    // The same answer opens no page: a save that lands after the app was left has nowhere to land.
    const land = code.slice(code.indexOf("const land = async"), code.indexOf("const toVisit = async"));
    expect(land).toContain("if (!live.current || now.current !== n) return;");
    expect(land.indexOf("if (!live.current || now.current !== n) return;")).toBeLessThan(land.indexOf("router.push("));
  });

  it("A READ THAT ANSWERS AFTER THE SHEET SAID IT COULD NOT is not drawn on its own: doors never arrive under Try Again and Don't Keep It", () => {
    const askFor = code.slice(code.indexOf("const askFor = "), code.indexOf("const warm = useRef"));
    expect(askFor).toMatch(/saidLate = true;/);
    expect(askFor).toContain("if (!saidLate) patch(n, { ctx: c });");
    // The one other place a read's answer is drawn is the sitting's start, before its first paint.
    expect(code.match(/patch\(n, \{ ctx: [a-z.]+ \}\)/g)).toEqual(["patch(n, { ctx: c })", "patch(n, { ctx: w.got })"]);
    // And until an answer is drawn there is no door at all (sheetDoors, above): nothing to slide.
    expect(sheetDoors({ place: nowhere, ctx: null, open: aFigure(), held: null }).doors).toEqual([]);
  });

  it("letting go of a model: the question's two answers are the + menu's own words, and both wait while the discard is out", () => {
    const foot = code.slice(code.indexOf("footer={"), code.indexOf("{of && ("));
    expect(foot).toContain('{t("sh_btn_measureKeepModel")}');
    expect(foot).toContain('{t("vi_btn_discardKept3dModel")}');
    expect(foot.match(/disabled=\{L\.working !== null\}/g)).toHaveLength(3); // Keep It, Discard, and Done
    for (const t of [en, es]) {
      expect(t("sh_btn_measureKeepModel")).not.toBe("sh_btn_measureKeepModel");
      expect(t("vi_btn_discardKept3dModel")).not.toBe("vi_btn_discardKept3dModel");
    }
    // A figure's Don't Keep It is the discard he was told about: it closes, with no second step.
    const onDoor = code.slice(code.indexOf("const onDoor = "), code.indexOf("const of = show"));
    expect(onDoor).toMatch(/case "dontKeep":\s*if \(open\.kind === "model"\) return patch\(n, \{ confirming: true, fault: null \}\);\s*return close\(\);/);
  });

  it("Save to This Visit hands the model to the Inspector and only lets go: the phone's copy is the Inspector's to discard", () => {
    const toVisit = code.slice(code.indexOf("const toVisit = async"), code.indexOf("const discard = async"));
    expect(toVisit).toContain("host.adoptModel({ model: held.model, path: held.path, shots: held.shots })");
    expect(toVisit).toContain("releaseHeldModel();");
    expect(toVisit).not.toMatch(/discardModel\(|discardScan\(|dropHeldModel\(/);
    expect(toVisit.indexOf("releaseHeldModel();")).toBeGreaterThan(toVisit.indexOf("if (!took)"));
    // The visit an earlier Start an Inspection with It made for this model goes with it: a model the
    // Inspector hands back must never Try Again into that visit (the skeptic's B1 b).
    expect(toVisit).toContain("forgetMeasureVisitOf(held.model);");
    expect(toVisit.indexOf("forgetMeasureVisitOf(held.model);")).toBeGreaterThan(toVisit.indexOf("if (!took)"));
  });
});

describe("the words", () => {
  it("the sheet is one of the shell catalog's screens (the leak scan reads it), and every key it uses is in both languages", () => {
    expect(shell.files).toContain("src/components/quick-measure-sheet.tsx");
    const used = [...new Set([...code.matchAll(/\bt\("([a-z]+_[A-Za-z0-9_]+)"\)/g)].map((m) => m[1]))];
    expect(used.length).toBeGreaterThanOrEqual(20);
    for (const key of used) {
      expect(en(key), key).not.toBe(key);
      expect(es(key), key).not.toBe(key);
    }
    // The lane's own additions.
    for (const key of ["sh_btn_measureFinishSavingJob", "sh_measure_savedToPhotosNamed", "sh_measure_savedToInspection", "sh_measure_visitBusy", "sh_measure_clockUnread"]) {
      expect(shell.en[key], key).toBeTruthy();
      expect(shell.es[key], key).toBeTruthy();
      expect(shell.es[key]).not.toBe(shell.en[key]);
    }
  });

  it("a sentence that names a button names it as the button is drawn", () => {
    for (const t of [en, es]) {
      expect(t("sh_measure_visitBusy")).toContain(t("sh_btn_measureSaveToThisVisit"));
      expect(t("sh_measure_inspectionMadeNotFilled")).toContain(t("sh_tryAgain"));
      expect(t("sh_measure_modelWaits")).toContain(t("sh_btn_measureHeldModel"));
    }
  });
});
