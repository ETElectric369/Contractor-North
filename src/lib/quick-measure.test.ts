import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * MEASURE FROM THE +: THE STORE AND ITS RULES (cn-v1160). No React, no phone: the two bridges are
 * stand-ins here, so what is pinned is what the store does with their answers. Where a result goes
 * (the Inspector's own flow on a visit, else the sheet), that a length is never held and a 3D model
 * is never dropped by closing, that a held model is never scanned over, and whose a held model is
 * when the app is left and somebody comes back.
 */
const bridge = vi.hoisted(() => ({
  measureNative: vi.fn(),
  scan3dNative: vi.fn(),
  discardScan: vi.fn(async (_path: string) => undefined),
}));
vi.mock("@/lib/native-measure", () => ({ measureNative: bridge.measureNative }));
vi.mock("@/lib/native-scan", () => ({ scan3dNative: bridge.scan3dNative, discardScan: bridge.discardScan }));

import {
  clearMeasureFigure,
  closeMeasureSheet,
  dropHeldModel,
  heldModel,
  heldModelOf,
  keepModelInPlus,
  measureAppLeft,
  measureHeld,
  measureHost,
  measureOwnerKey,
  measureStore,
  patchHeldModel,
  registerMeasureHost,
  rememberMeasureVisit,
  releaseHeldModel,
  reopenHeldModel,
  resetMeasureStoreForTest,
  runQuickMeasure,
  setMeasureOwner,
  subscribeMeasure,
  whereIsHe,
  type MeasureHost,
} from "./quick-measure";

const JOB = "0b9f3c2e-5a41-4d7e-9c33-1f2a6b7c8d90";
const SAM = "user-sam:org-larkspur";
const DANA = "user-dana:org-larkspur";
const PATH = "/tmp/north-scans/scan-a.usdz";

const usdz = (name = "scan-3d-1.usdz") => new File([new Uint8Array([1, 2, 3])], name, { type: "model/vnd.usdz+zip" });
const scanned = (path = PATH) => ({ ok: true as const, kind: "model" as const, model: usdz(), shots: 42, path });
const length = { ok: true as const, mode: "length" as const, value: 12, unit: "ft" as const, caption: "12 ft 0 in", points: 2, lidar: true, approx: false, photo: null };
const area = { ok: true as const, mode: "area" as const, value: 100.5, unit: "sq ft" as const, caption: "100.5 sq ft (approx.)", points: 4, lidar: false, approx: true, photo: null };
const cancelled = { ok: false as const, cancelled: true as const };
const refused = (said: string) => ({ ok: false as const, refused: said });

/** A screen that stays up until the test lets it answer. */
function screenUp<T>() {
  let answer!: (v: T) => void;
  const promise = new Promise<T>((r) => (answer = r));
  return { promise, answer };
}
const host = (over: Partial<MeasureHost> = {}): MeasureHost => ({ measure: vi.fn(), scan: vi.fn(), adoptModel: vi.fn(() => true), ...over });

/** A model in the +, as a scan from the + leaves it. */
async function scanOne(path = PATH) {
  bridge.scan3dNative.mockResolvedValueOnce(scanned(path));
  await runQuickMeasure("scan", { now: 1 });
}

beforeEach(() => {
  resetMeasureStoreForTest();
  bridge.measureNative.mockReset();
  bridge.scan3dNative.mockReset();
  bridge.discardScan.mockReset().mockResolvedValue(undefined);
});

describe("the host: a page that takes a result itself", () => {
  it("a registered provider's host is the host; unregistered, there is none", () => {
    expect(measureHost()).toBeNull();
    const h = host();
    const off = registerMeasureHost(() => h);
    expect(measureHost()).toBe(h);
    off();
    expect(measureHost()).toBeNull();
  });

  it("a provider is asked every time (it reads a ref): a reader's Inspector answers null and is no host", () => {
    let now: MeasureHost | null = null;
    registerMeasureHost(() => now);
    expect(measureHost()).toBeNull();
    now = host();
    expect(measureHost()).toBe(now);
    now = null;
    expect(measureHost()).toBeNull();
  });

  it("a provider that throws is skipped (a page mid-unmount never takes the + down), and the last one that answers wins", () => {
    const first = host();
    const last = host();
    registerMeasureHost(() => first);
    registerMeasureHost(() => {
      throw new Error("unmounting");
    });
    expect(measureHost()).toBe(first);
    const offLast = registerMeasureHost(() => last);
    registerMeasureHost(() => null);
    expect(measureHost()).toBe(last);
    // The later page goes: the earlier one is the host again.
    offLast();
    expect(measureHost()).toBe(first);
  });
});

describe("where he is", () => {
  it.each([
    // A host answered: the visit, whatever the address says.
    ["/appointments/8d1f0c8a-1b2c-4d3e-8f90-aabbccddeeff", true, { kind: "visit" }],
    [`/jobs/${JOB}`, true, { kind: "visit" }],
    [null, true, { kind: "visit" }],
    // A job's page, and anything under it; the id comes back lowercase.
    [`/jobs/${JOB}`, false, { kind: "job", jobId: JOB }],
    [`/jobs/${JOB}/`, false, { kind: "job", jobId: JOB }],
    [`/jobs/${JOB}/panel`, false, { kind: "job", jobId: JOB }],
    [`/jobs/${JOB.toUpperCase()}`, false, { kind: "job", jobId: JOB }],
    // Not a job's page.
    ["/jobs", false, { kind: "nowhere" }],
    ["/jobs/new", false, { kind: "nowhere" }],
    [`/jobs/${JOB}x`, false, { kind: "nowhere" }],
    [`/jobs/${JOB.slice(0, -1)}`, false, { kind: "nowhere" }],
    [`/print/jobs/${JOB}`, false, { kind: "nowhere" }],
    ["/planner", false, { kind: "nowhere" }],
    ["", false, { kind: "nowhere" }],
    [null, false, { kind: "nowhere" }],
    [undefined, false, { kind: "nowhere" }],
    // A visit he can only read has no host: it is not a place, and the sheet asks.
    ["/appointments/8d1f0c8a-1b2c-4d3e-8f90-aabbccddeeff", false, { kind: "nowhere" }],
  ] as const)("%s (host: %s)", (pathname, hasHost, place) => {
    expect(whereIsHe(pathname, hasHost)).toEqual(place);
  });
});

describe("a row in the + was tapped", () => {
  it("on a visit he can write, the Inspector's own function runs and no sheet opens", async () => {
    const h = host();
    registerMeasureHost(() => h);
    await runQuickMeasure("length");
    await runQuickMeasure("area");
    await runQuickMeasure("scan");
    expect(h.measure).toHaveBeenNthCalledWith(1, "length");
    expect(h.measure).toHaveBeenNthCalledWith(2, "area");
    expect(h.scan).toHaveBeenCalledTimes(1);
    expect(bridge.measureNative).not.toHaveBeenCalled();
    expect(bridge.scan3dNative).not.toHaveBeenCalled();
    expect(measureStore()).toMatchObject({ open: null, held: null, busy: null });
  });

  it("the rows wait while the Inspector's function runs, and come back even when it throws", async () => {
    const up = screenUp<void>();
    registerMeasureHost(() => host({ measure: () => up.promise }));
    const run = runQuickMeasure("length");
    expect(measureStore().busy).toBe("length");
    up.answer();
    await run;
    expect(measureStore().busy).toBeNull();

    resetMeasureStoreForTest();
    registerMeasureHost(() =>
      host({
        scan: async () => {
          throw new Error("the page went");
        },
      }),
    );
    await expect(runQuickMeasure("scan")).rejects.toThrow("the page went");
    expect(measureStore().busy).toBeNull();
  });

  it("anywhere else a length or an area opens in the sheet, said in the reader's language", async () => {
    const words = (k: string) => k;
    bridge.measureNative.mockResolvedValueOnce(length);
    await runQuickMeasure("length", { lang: "es", words });
    expect(bridge.measureNative).toHaveBeenCalledWith("length", "es", words);
    expect(measureStore().open).toEqual({ kind: "figure", figure: { mode: "length", value: 12, unit: "ft", caption: "12 ft 0 in", approx: false, photo: null } });
    expect(measureStore().busy).toBeNull();
    // A length is never held: nothing waits in the +.
    expect(measureHeld()).toBe(false);

    bridge.measureNative.mockResolvedValueOnce(area);
    await runQuickMeasure("area");
    expect(measureStore().open).toMatchObject({ kind: "figure", figure: { mode: "area", value: 100.5, unit: "sq ft", approx: true } });
  });

  it("a refusal opens the same sheet with the plugin's own sentence; a cancel says nothing", async () => {
    bridge.measureNative.mockResolvedValueOnce(refused("Camera access is off for North."));
    await runQuickMeasure("length");
    expect(measureStore().open).toEqual({ kind: "refused", said: "Camera access is off for North." });

    resetMeasureStoreForTest();
    bridge.measureNative.mockResolvedValueOnce(cancelled);
    await runQuickMeasure("area");
    expect(measureStore()).toMatchObject({ open: null, busy: null });

    bridge.scan3dNative.mockResolvedValueOnce(refused("This iPhone can't scan in 3D."));
    await runQuickMeasure("scan");
    expect(measureStore().open).toEqual({ kind: "refused", said: "This iPhone can't scan in 3D." });
    expect(measureHeld()).toBe(false);

    resetMeasureStoreForTest();
    bridge.scan3dNative.mockResolvedValueOnce(cancelled);
    await runQuickMeasure("scan");
    expect(measureStore()).toMatchObject({ open: null, held: null, busy: null });
  });

  it("a 3D model is held from the moment it comes back, and the sheet opens on it", async () => {
    const words = (k: string) => k;
    const r = scanned();
    bridge.scan3dNative.mockResolvedValueOnce(r);
    await runQuickMeasure("scan", { lang: "en", words, now: 1_762_800_000_000 });
    expect(bridge.scan3dNative).toHaveBeenCalledWith(1_762_800_000_000, "en", words);
    expect(measureStore().open).toEqual({ kind: "model" });
    expect(heldModel()).toEqual({ model: r.model, path: PATH, shots: 42, landed: null });
    expect(heldModel()?.model).toBe(r.model);
    expect(measureHeld()).toBe(true);
  });

  it("a model already held is never replaced by a new scan: the sheet opens on the one that is waiting", async () => {
    await scanOne();
    const waiting = heldModel();
    closeMeasureSheet();
    expect(measureStore().open).toBeNull();
    await runQuickMeasure("scan");
    // No second walk: the camera never opened.
    expect(bridge.scan3dNative).toHaveBeenCalledTimes(1);
    expect(heldModel()).toBe(waiting);
    expect(measureStore().open).toEqual({ kind: "model" });
    expect(bridge.discardScan).not.toHaveBeenCalled();
  });

  it("a length taken while a model waits leaves the model, and the visit made for it, alone", async () => {
    await scanOne();
    rememberMeasureVisit("visit-1");
    closeMeasureSheet();
    bridge.measureNative.mockResolvedValueOnce(length);
    await runQuickMeasure("length");
    expect(measureStore().open?.kind).toBe("figure");
    expect(heldModel()?.path).toBe(PATH);
    expect(measureStore().visitId).toBe("visit-1");
    // The figure goes when its sheet closes; the model is still there, and so is its visit.
    closeMeasureSheet();
    expect(measureStore().open).toBeNull();
    expect(heldModel()?.path).toBe(PATH);
    expect(measureStore().visitId).toBe("visit-1");
  });

  it("the visit is one slot: remembered, it is there for the retry; forgotten on purpose, it is gone", async () => {
    await scanOne();
    rememberMeasureVisit("visit-1");
    expect(measureStore().visitId).toBe("visit-1");
    // A figure saved or not kept while the model waits leaves the model's visit alone.
    bridge.measureNative.mockResolvedValueOnce(length);
    await runQuickMeasure("length");
    clearMeasureFigure();
    expect(measureStore().visitId).toBe("visit-1");
    rememberMeasureVisit(null);
    expect(measureStore().visitId).toBeNull();
  });

  it("a new figure forgets the visit that was made for the last one", async () => {
    bridge.measureNative.mockResolvedValue(length);
    await runQuickMeasure("length");
    rememberMeasureVisit("visit-1");
    await runQuickMeasure("length");
    expect(measureStore().visitId).toBeNull();
  });

  it("busy guards a second tap: one screen at a time", async () => {
    const up = screenUp<typeof length>();
    bridge.measureNative.mockReturnValueOnce(up.promise);
    const first = runQuickMeasure("length");
    expect(measureStore().busy).toBe("length");
    await runQuickMeasure("area");
    await runQuickMeasure("scan");
    expect(bridge.measureNative).toHaveBeenCalledTimes(1);
    expect(bridge.scan3dNative).not.toHaveBeenCalled();
    up.answer(length);
    await first;
    expect(measureStore().busy).toBeNull();
    // The screen is down: the next tap goes.
    bridge.measureNative.mockResolvedValueOnce(area);
    await runQuickMeasure("area");
    expect(bridge.measureNative).toHaveBeenCalledTimes(2);
  });

  it("whoever subscribed hears every change, and one listener's fault is its own", async () => {
    const heard = vi.fn();
    subscribeMeasure(() => {
      throw new Error("a listener's fault");
    });
    const off = subscribeMeasure(heard);
    bridge.measureNative.mockResolvedValueOnce(length);
    await runQuickMeasure("length");
    expect(heard.mock.calls.length).toBeGreaterThanOrEqual(3); // busy, the figure, not busy
    // The snapshot is one object between changes (useSyncExternalStore's rule).
    expect(measureStore()).toBe(measureStore());
    off();
    const before = heard.mock.calls.length;
    closeMeasureSheet();
    expect(heard.mock.calls.length).toBe(before);
  });
});

describe("the sheet's verbs", () => {
  it("closing drops a figure and the visit made for it; a model stays held with its visit", async () => {
    bridge.measureNative.mockResolvedValueOnce(length);
    await runQuickMeasure("length");
    rememberMeasureVisit("visit-1");
    closeMeasureSheet();
    expect(measureStore()).toMatchObject({ open: null, visitId: null });

    await scanOne();
    rememberMeasureVisit("visit-2");
    closeMeasureSheet();
    expect(measureStore()).toMatchObject({ open: null, visitId: "visit-2" });
    expect(heldModel()?.path).toBe(PATH);
  });

  it("3D Model · Not Saved reopens the sheet on the held model, and does nothing when none is held", async () => {
    reopenHeldModel();
    expect(measureStore().open).toBeNull();
    await scanOne();
    closeMeasureSheet();
    reopenHeldModel();
    expect(measureStore().open).toEqual({ kind: "model" });
  });

  it("a file that is up and a row that is owed is written on the held model", async () => {
    patchHeldModel({ landed: { jobId: JOB, path: "org/jobs/x/scan.usdz", name: "scan.usdz" } });
    expect(measureStore().held).toBeNull(); // nothing held: nothing to write on
    await scanOne();
    patchHeldModel({ landed: { jobId: JOB, path: "org/jobs/x/scan.usdz", name: "scan.usdz" } });
    expect(heldModel()).toMatchObject({ path: PATH, shots: 42, landed: { jobId: JOB, path: "org/jobs/x/scan.usdz", name: "scan.usdz" } });
  });

  it("released (it is saved somewhere, or the Inspector took it), the + lets go WITHOUT touching the shell's copy", async () => {
    await scanOne();
    rememberMeasureVisit("visit-1");
    releaseHeldModel();
    expect(measureStore()).toMatchObject({ held: null, visitId: null, open: null });
    expect(measureHeld()).toBe(false);
    expect(bridge.discardScan).not.toHaveBeenCalled();
  });

  it("releasing a model leaves a figure that is open where it is", async () => {
    expect(keepModelInPlus({ model: usdz(), path: PATH })).toBe(true);
    bridge.measureNative.mockResolvedValueOnce(length);
    await runQuickMeasure("length");
    releaseHeldModel();
    expect(measureStore().open?.kind).toBe("figure");
  });

  it("discarded, the + lets go and the shell's copy goes", async () => {
    await scanOne();
    await dropHeldModel();
    expect(measureStore()).toMatchObject({ held: null, open: null });
    expect(bridge.discardScan).toHaveBeenCalledTimes(1);
    expect(bridge.discardScan).toHaveBeenCalledWith(PATH);
    // Nothing held: nothing to discard.
    await dropHeldModel();
    expect(bridge.discardScan).toHaveBeenCalledTimes(1);
  });

  it("a figure saved or not kept is cleared; a model's sheet is not a figure's to clear", async () => {
    bridge.measureNative.mockResolvedValueOnce(length);
    await runQuickMeasure("length");
    rememberMeasureVisit("visit-1");
    clearMeasureFigure();
    expect(measureStore()).toMatchObject({ open: null, visitId: null });

    bridge.measureNative.mockResolvedValueOnce(refused("Camera access is off for North."));
    await runQuickMeasure("length");
    clearMeasureFigure();
    expect(measureStore().open).toBeNull();

    await scanOne();
    clearMeasureFigure();
    expect(measureStore().open).toEqual({ kind: "model" });
  });
});

describe("whose a held model is", () => {
  it("held, and this person's to see, until the app is left", async () => {
    expect(measureHeld()).toBe(false);
    expect(heldModel()).toBeNull();
    setMeasureOwner(SAM);
    await scanOne();
    expect(measureHeld()).toBe(true);
    expect(heldModel()?.path).toBe(PATH);
    expect(heldModelOf(measureStore())).toBe(heldModel());

    // The + unmounted (a sign-out is a soft navigation, and this is page memory).
    measureAppLeft();
    expect(measureStore()).toMatchObject({ left: true, open: null, busy: null });
    // Nothing is offered, and the reload guard still knows a model is in memory.
    expect(heldModel()).toBeNull();
    expect(heldModelOf(measureStore())).toBeNull();
    expect(measureHeld()).toBe(true);
    // Its row is not a door while it is hidden, and it is not scanned over either.
    reopenHeldModel();
    expect(measureStore().open).toBeNull();
    await runQuickMeasure("scan");
    expect(bridge.scan3dNative).toHaveBeenCalledTimes(1);
    expect(measureStore().open).toBeNull();
  });

  it("the same person in the same company gets it back, with the visit that was made for it", async () => {
    setMeasureOwner(SAM);
    await scanOne();
    rememberMeasureVisit("visit-1");
    measureAppLeft();
    setMeasureOwner(SAM);
    expect(measureStore()).toMatchObject({ left: false, owner: SAM, visitId: "visit-1" });
    expect(heldModel()?.path).toBe(PATH);
    expect(bridge.discardScan).not.toHaveBeenCalled();
    // Back, and its row is a door again.
    reopenHeldModel();
    expect(measureStore().open).toEqual({ kind: "model" });
  });

  it("a second person on the phone starts with nothing held, and the shell's copy of the last one's model is discarded", async () => {
    setMeasureOwner(SAM);
    await scanOne();
    rememberMeasureVisit("visit-1");
    measureAppLeft();
    setMeasureOwner(DANA);
    expect(measureStore()).toMatchObject({ held: null, visitId: null, open: null, owner: DANA, left: false });
    expect(heldModel()).toBeNull();
    expect(measureHeld()).toBe(false);
    expect(bridge.discardScan).toHaveBeenCalledTimes(1);
    expect(bridge.discardScan).toHaveBeenCalledWith(PATH);
    // And the first one does not get it back afterwards: it is gone.
    measureAppLeft();
    setMeasureOwner(SAM);
    expect(heldModel()).toBeNull();
  });

  it("the same person in ANOTHER company is somebody else", async () => {
    setMeasureOwner("user-sam:org-larkspur");
    await scanOne();
    measureAppLeft();
    setMeasureOwner("user-sam:org-snowbell");
    expect(measureHeld()).toBe(false);
    expect(bridge.discardScan).toHaveBeenCalledWith(PATH);
  });

  it("a context that did not answer names nobody: what is hidden stays hidden, and nothing is discarded", async () => {
    setMeasureOwner(SAM);
    await scanOne();
    measureAppLeft();
    setMeasureOwner(null);
    expect(measureStore()).toMatchObject({ left: true, owner: SAM });
    expect(heldModel()).toBeNull();
    expect(measureHeld()).toBe(true);
    expect(bridge.discardScan).not.toHaveBeenCalled();
  });

  it("the first name may come after the model: scanned with no signal and the app never left, it is the scanner's own", async () => {
    // Nobody named yet (the context read failed when the app opened); a scan needs no signal.
    await scanOne();
    expect(measureStore().owner).toBeNull();
    expect(heldModel()?.path).toBe(PATH);
    setMeasureOwner(SAM);
    expect(heldModel()?.path).toBe(PATH);
    expect(measureStore()).toMatchObject({ owner: SAM, left: false, open: { kind: "model" } });
    expect(bridge.discardScan).not.toHaveBeenCalled();
  });

  it("a model left behind that nobody was ever named for has nobody to go back to", async () => {
    await scanOne();
    measureAppLeft();
    setMeasureOwner(SAM);
    expect(measureHeld()).toBe(false);
    expect(heldModel()).toBeNull();
    expect(bridge.discardScan).toHaveBeenCalledWith(PATH);
    expect(measureStore()).toMatchObject({ owner: SAM, left: false });
  });

  it("a name arriving late never closes what the person on the phone has open", async () => {
    setMeasureOwner(SAM);
    await scanOne();
    measureAppLeft();
    // Somebody else is here now and has measured a length before their name arrived.
    bridge.measureNative.mockResolvedValueOnce(length);
    await runQuickMeasure("length");
    expect(measureStore().open?.kind).toBe("figure");
    setMeasureOwner(DANA);
    expect(measureStore().open?.kind).toBe("figure");
    expect(measureHeld()).toBe(false);
    expect(bridge.discardScan).toHaveBeenCalledWith(PATH);
  });

  it("with nothing held a new name simply takes over", () => {
    setMeasureOwner(SAM);
    measureAppLeft();
    setMeasureOwner(DANA);
    expect(measureStore()).toMatchObject({ owner: DANA, left: false, held: null });
    expect(bridge.discardScan).not.toHaveBeenCalled();
  });

  it("leaving closes the sheet as closing it does: a figure and its visit go, a model and its visit wait", async () => {
    bridge.measureNative.mockResolvedValueOnce(length);
    await runQuickMeasure("length");
    rememberMeasureVisit("visit-1");
    measureAppLeft();
    expect(measureStore()).toMatchObject({ open: null, visitId: null, left: true });

    resetMeasureStoreForTest();
    await scanOne();
    rememberMeasureVisit("visit-2");
    measureAppLeft();
    expect(measureStore()).toMatchObject({ open: null, visitId: "visit-2", left: true });
  });
});

describe("whose the answer is when the app was left around the screen", () => {
  it("a scan started while the last leaving is still unanswered is the scanner's own: shown at once, and the next name is its owner's", async () => {
    setMeasureOwner(SAM);
    // Sam left with nothing held; the + is back on screen and the context has not answered yet.
    measureAppLeft();
    await scanOne();
    expect(heldModel()?.path).toBe(PATH);
    expect(measureStore()).toMatchObject({ open: { kind: "model" }, left: false, owner: null });
    // Whoever the context names, it was scanned on their watch.
    setMeasureOwner(DANA);
    expect(heldModel()?.path).toBe(PATH);
    expect(measureStore().owner).toBe(DANA);
    expect(bridge.discardScan).not.toHaveBeenCalled();
  });

  it("left while the measuring screen was up: the figure is dropped, and so is a refusal", async () => {
    const up = screenUp<typeof length>();
    bridge.measureNative.mockReturnValueOnce(up.promise);
    const run = runQuickMeasure("length");
    measureAppLeft();
    up.answer(length);
    await run;
    expect(measureStore()).toMatchObject({ open: null, busy: null, left: true });

    resetMeasureStoreForTest();
    const no = screenUp<ReturnType<typeof refused>>();
    bridge.measureNative.mockReturnValueOnce(no.promise);
    const again = runQuickMeasure("area");
    measureAppLeft();
    no.answer(refused("Camera access is off for North."));
    await again;
    expect(measureStore().open).toBeNull();

    resetMeasureStoreForTest();
    const scanNo = screenUp<ReturnType<typeof refused>>();
    bridge.scan3dNative.mockReturnValueOnce(scanNo.promise);
    const third = runQuickMeasure("scan");
    measureAppLeft();
    scanNo.answer(refused("This iPhone can't scan in 3D."));
    await third;
    expect(measureStore()).toMatchObject({ open: null, held: null, busy: null });
  });

  it("left while the scanning screen was up: the model is held for the one who scanned it, hidden, with no sheet", async () => {
    setMeasureOwner(SAM);
    const up = screenUp<ReturnType<typeof scanned>>();
    bridge.scan3dNative.mockReturnValueOnce(up.promise);
    const run = runQuickMeasure("scan");
    measureAppLeft();
    up.answer(scanned());
    await run;
    expect(measureStore()).toMatchObject({ open: null, busy: null, left: true, owner: SAM });
    expect(measureHeld()).toBe(true);
    expect(heldModel()).toBeNull();
    expect(bridge.discardScan).not.toHaveBeenCalled();
    // Sam comes back: it is his again. Anybody else would never have seen it.
    setMeasureOwner(SAM);
    expect(heldModel()?.path).toBe(PATH);
  });

  it("...and when somebody else has been named by the time it comes back, it has nobody to go back to", async () => {
    setMeasureOwner(SAM);
    const up = screenUp<ReturnType<typeof scanned>>();
    bridge.scan3dNative.mockReturnValueOnce(up.promise);
    const run = runQuickMeasure("scan");
    measureAppLeft();
    setMeasureOwner(DANA);
    up.answer(scanned());
    await run;
    expect(measureStore()).toMatchObject({ held: null, open: null, busy: null, owner: DANA });
    expect(bridge.discardScan).toHaveBeenCalledWith(PATH);
  });

  it("...nor when nobody was named at the tap and somebody is by the time it comes back", async () => {
    const up = screenUp<ReturnType<typeof scanned>>();
    bridge.scan3dNative.mockReturnValueOnce(up.promise);
    const run = runQuickMeasure("scan");
    measureAppLeft();
    setMeasureOwner(DANA);
    up.answer(scanned());
    await run;
    expect(measureHeld()).toBe(false);
    expect(bridge.discardScan).toHaveBeenCalledWith(PATH);
  });
});

describe("the Inspector is leaving with a model it never sent", () => {
  it("the + takes it and offers it again: held, no sheet, no visit of anybody's", () => {
    rememberMeasureVisit("visit-1");
    const model = usdz("scan-3d-7.usdz");
    expect(keepModelInPlus({ model, path: PATH })).toBe(true);
    expect(heldModel()).toEqual({ model, path: PATH, shots: 0, landed: null });
    expect(measureStore()).toMatchObject({ open: null, visitId: null });
    expect(keepModelInPlus({ model: usdz(), path: "/tmp/north-scans/scan-b.usdz", shots: 9 })).toBe(false);
  });

  it("a + that already holds one keeps its own, and a second is not taken", async () => {
    await scanOne();
    const waiting = heldModel();
    expect(keepModelInPlus({ model: usdz(), path: "/tmp/north-scans/scan-b.usdz" })).toBe(false);
    expect(heldModel()).toBe(waiting);
  });

  it("once the app was left the + takes nothing", () => {
    measureAppLeft();
    expect(keepModelInPlus({ model: usdz(), path: PATH })).toBe(false);
    expect(measureHeld()).toBe(false);
  });

  it("the shots are kept when the Inspector knows them", () => {
    expect(keepModelInPlus({ model: usdz(), path: PATH, shots: 31 })).toBe(true);
    expect(heldModel()?.shots).toBe(31);
  });
});

describe("the owner's key", () => {
  it("is the person and the company together; a context that did not answer names nobody", () => {
    expect(measureOwnerKey({ ok: true, userId: "user-sam", orgId: "org-larkspur", punchJob: null })).toBe(SAM);
    expect(measureOwnerKey({ ok: true, userId: "user-sam", orgId: "org-larkspur", punchJob: { id: JOB, label: "J-047 · Larkspur" } })).toBe(SAM);
    expect(measureOwnerKey({ ok: false, error: "Not signed in." })).toBeNull();
  });
});
