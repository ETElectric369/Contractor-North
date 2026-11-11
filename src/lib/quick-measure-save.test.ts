import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * WHERE A RESULT OF MEASURE FROM THE + IS SAVED (cn-v1160). Every write here goes through a door that
 * already exists, so the doors are stand-ins and what is pinned is the ORDER and what a second tap
 * repeats: a model's two faults (the file did not upload; the file is up and the row is owed, with no
 * second upload), the phone's copy going only after the row, a new inspection made once and ADDED TO,
 * never replaced (the visit is a stand-in that keeps what is written to it, the way the real writers
 * merge), and a discard that takes back what nothing points at. Every id and name is invented.
 */

const h = vi.hoisted(() => ({
  /** What happened, in order: "upload:<path>", "row:<path>", "discardScan:<path>", "remove:<path>", … */
  order: [] as string[],
  uploads: [] as { bucket: string; path: string; file: File; opts: unknown }[],
  /** Answers for the next uploads, first in first out: an error object refuses, null lets it through. */
  uploadAnswers: [] as (null | { message: string; statusCode?: string })[],
  /** A gate the next upload waits behind (a save in flight). */
  uploadGate: null as null | Promise<void>,
  /** What the job's papers answer when asked whether a file already has its row. */
  papers: { rows: [] as { id: string }[], error: null as null | { message: string }, eqs: [] as [string, unknown][] },
  /** The visit as stored: what the visit's writers keep, and what a read of it answers. */
  visit: { capture: null as unknown, readError: null as null | { message: string } },
  addInspectionPhotos: vi.fn(),
  uploadJobPhotos: vi.fn(),
  addDocument: vi.fn(),
  deleteDocument: vi.fn(),
  createInspectionNow: vi.fn(),
  saveInspectionCapture: vi.fn(),
  removeInspectionPhoto: vi.fn(),
  prepareImageForUpload: vi.fn(),
  stampFigure: vi.fn(),
  measureNative: vi.fn(),
  scan3dNative: vi.fn(),
}));

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    storage: {
      from: (bucket: string) => ({
        upload: async (path: string, file: File, opts: unknown) => {
          if (h.uploadGate) await h.uploadGate;
          h.order.push(`upload:${path}`);
          const answer = h.uploadAnswers.shift() ?? null;
          if (answer) return { data: null, error: answer };
          h.uploads.push({ bucket, path, file, opts });
          return { data: { path }, error: null };
        },
        remove: async (paths: string[]) => {
          for (const p of paths) h.order.push(`remove:${p}`);
          return { data: paths.map((name) => ({ name })), error: null };
        },
      }),
    },
    from: (table: string) => {
      const chain = {
        select: () => chain,
        eq: (col: string, val: unknown) => {
          h.papers.eqs.push([col, val]);
          return chain;
        },
        limit: () => chain,
        maybeSingle: async () => {
          h.order.push(`ask:${table}`);
          if (h.visit.readError) return { data: null, error: h.visit.readError };
          return { data: { capture: h.visit.capture }, error: null };
        },
        then: (resolve: (v: unknown) => void) => {
          h.order.push(`ask:${table}`);
          resolve({ data: h.papers.error ? null : h.papers.rows, error: h.papers.error });
        },
      };
      return chain;
    },
  }),
}));
vi.mock("@/app/(app)/jobs/[id]/upload-job-photos", () => ({ uploadJobPhotos: h.uploadJobPhotos }));
vi.mock("@/app/(app)/jobs/actions", () => ({ addDocument: h.addDocument, deleteDocument: h.deleteDocument }));
vi.mock("@/app/(app)/appointments/actions", () => ({
  addInspectionPhotos: h.addInspectionPhotos,
  createInspectionNow: h.createInspectionNow,
  saveInspectionCapture: h.saveInspectionCapture,
  removeInspectionPhoto: h.removeInspectionPhoto,
}));
vi.mock("@/lib/native-scan", () => ({
  discardScan: async (path: string) => {
    h.order.push(`discardScan:${path}`);
  },
  scan3dNative: h.scan3dNative,
}));
vi.mock("@/lib/native-measure", () => ({ measureNative: h.measureNative }));
vi.mock("@/lib/image-prep", () => ({ prepareImageForUpload: h.prepareImageForUpload }));
vi.mock("@/lib/measure-stamp", () => ({ stampFigure: h.stampFigure }));

import { translator } from "@/lib/i18n";
import { MEASURED_LABEL_KEYS } from "@/lib/inspection/measured-label";
import { parseInspectorCapture, mergeCaptureSections } from "@/lib/inspection/capture";
import { MAX_MEASURES, type CaptureMeasure } from "@/lib/inspection/capture";
import { keepModelInPlus, measureStore, releaseHeldModel, rememberMeasureVisit, resetMeasureStoreForTest, runQuickMeasure, type MeasureFigure } from "@/lib/quick-measure";
import {
  discardModel,
  finishSavingModel,
  forgetFigure,
  forgetMeasureVisitOf,
  inspectionPatch,
  measureRecord,
  modelTrip,
  resetMeasureSavesForTest,
  saveMeasureToJob,
  saveModelToJob,
  startInspectionWith,
  visitMadeFor,
  type SaveWords,
} from "./quick-measure-save";

const ORG = "0a000000-0000-4000-8000-00000000c001";
const JOB = "0b000000-0000-4000-8000-00000000d001";
const OTHER_JOB = "0b000000-0000-4000-8000-00000000d002";
const VISIT = "0c000000-0000-4000-8000-00000000e001";
const SCAN_PATH = "/tmp/north-scans/scan-3d-1.usdz";

const en = translator("en");
const words: SaveWords = { lang: "en", t: en, en };
const palabras: SaveWords = { lang: "es", t: translator("es"), en };

const picture = () => new File([new Uint8Array(1200)], "measure-1731300000000.jpg", { type: "image/jpeg" });
const usdz = () => new File([new Uint8Array(4096)], "scan-3d-1.usdz", { type: "model/vnd.usdz+zip" });

/** A length off a LiDAR phone, opened in the sheet the way the + opens it. */
async function openFigure(over: Partial<MeasureFigure> = {}): Promise<MeasureFigure> {
  h.measureNative.mockResolvedValueOnce({ ok: true, mode: "length", value: 12, unit: "ft", caption: "12 ft 0 in", points: 2, lidar: true, approx: false, photo: picture(), ...over });
  await runQuickMeasure(over.mode ?? "length");
  const open = measureStore().open;
  if (open?.kind !== "figure") throw new Error("the figure did not open");
  return open.figure;
}
/** A 3D model, held by the + from the moment the scan comes back. */
async function holdModel(): Promise<File> {
  const model = usdz();
  h.scan3dNative.mockResolvedValueOnce({ ok: true, kind: "model", model, shots: 40, path: SCAN_PATH });
  await runQuickMeasure("scan", { now: 1 });
  if (!measureStore().held) throw new Error("the model is not held");
  return model;
}
const gate = () => {
  let open!: () => void;
  const waiting = new Promise<void>((resolve) => (open = resolve));
  return { waiting, open };
};

beforeEach(() => {
  resetMeasureStoreForTest();
  resetMeasureSavesForTest();
  h.order.length = 0;
  h.uploads.length = 0;
  h.uploadAnswers.length = 0;
  h.uploadGate = null;
  h.papers.rows = [];
  h.papers.error = null;
  h.papers.eqs = [];
  h.visit.capture = null;
  h.visit.readError = null;
  for (const f of [h.uploadJobPhotos, h.addDocument, h.deleteDocument, h.createInspectionNow, h.addInspectionPhotos, h.saveInspectionCapture, h.removeInspectionPhoto, h.prepareImageForUpload, h.stampFigure, h.measureNative, h.scan3dNative]) f.mockReset();
  h.uploadJobPhotos.mockImplementation(async (org: string, job: string, files: File[]) => files.map((f) => `${org}/${job}/1-${f.name}`));
  h.addDocument.mockImplementation(async (input: { file_url: string }) => {
    h.order.push(`row:${input.file_url}`);
    return { ok: true, id: "doc-1" };
  });
  h.deleteDocument.mockImplementation(async (id: string) => {
    h.order.push(`unfile:${id}`);
    return { ok: true };
  });
  h.createInspectionNow.mockImplementation(async () => {
    h.order.push("visit");
    return { ok: true, id: VISIT };
  });
  // The visit's two writers, as the server runs them: a patch merges by section (a named section
  // replaces), the append adds to the stored list.
  h.saveInspectionCapture.mockImplementation(async (id: string, patch: Parameters<typeof mergeCaptureSections>[1]) => {
    h.order.push(`patch:${id}`);
    h.visit.capture = mergeCaptureSections(h.visit.capture, patch);
    return { ok: true, id };
  });
  h.addInspectionPhotos.mockImplementation(async (id: string, paths: string[]) => {
    for (const p of paths) h.order.push(`addPhotos:${p}`);
    const stored = parseInspectorCapture(h.visit.capture).photos;
    h.visit.capture = mergeCaptureSections(h.visit.capture, { photos: [...new Set([...stored, ...paths])] });
    return { ok: true, id };
  });
  h.removeInspectionPhoto.mockImplementation(async (id: string, path: string) => {
    h.order.push(`offVisit:${path}`);
    return { ok: true, id };
  });
  h.prepareImageForUpload.mockImplementation(async (f: File) => f);
  // Drawn: a new file comes back. (The real one hands back the same file when it cannot draw.)
  h.stampFigure.mockImplementation(async (f: File) => new File([f, new Uint8Array(8)], f.name, { type: "image/jpeg" }));
});

describe("the record's words: English, and the figure said once", () => {
  it("a length and an area are named for what they are, with the figure in the name", () => {
    expect(measureRecord(en, { mode: "length", approx: false, caption: "12 ft 0 in" })).toEqual({
      rowLabel: "Measured length",
      label: "Measured length",
      name: "Measured length 12 ft 0 in.jpg",
    });
    expect(measureRecord(en, { mode: "area", approx: false, caption: "100 sq ft" }).name).toBe("Measured area 100 sq ft.jpg");
    expect(measureRecord(en, { mode: "length", approx: false, caption: "3 ft 10.3 in" }).name).toBe("Measured length 3 ft 10.3 in.jpg");
  });

  it("a figure off a phone with no sensor says approx. once: the caption carries it, the label beside it does not repeat it", () => {
    const rec = measureRecord(en, { mode: "length", approx: true, caption: "12 ft 0 in (approx.)" });
    expect(rec.label).toBe("Measured length");
    expect(rec.name).toBe("Measured length 12 ft 0 in (approx.).jpg");
    // The visit's row is the Inspector's own label, which does say it (the row has no caption beside it).
    expect(rec.rowLabel).toBe("Measured length (approx.)");
    // A caption that does not say it leaves it to the label: said once either way.
    expect(measureRecord(en, { mode: "area", approx: true, caption: "100 sq ft" }).name).toBe("Measured area (approx.) 100 sq ft.jpg");
  });

  it("nothing in a name reads as a folder", () => {
    expect(measureRecord(en, { mode: "length", approx: false, caption: "1/2 in" }).name).toBe("Measured length 1-2 in.jpg");
  });

  it("the row label is one of the Inspector's four stored labels, so the visit draws it in the reader's language", () => {
    const stored = MEASURED_LABEL_KEYS.map((k) => en(k));
    for (const mode of ["length", "area"] as const) for (const approx of [false, true]) expect(stored).toContain(measureRecord(en, { mode, approx, caption: "1 ft" }).rowLabel);
  });
});

describe("a figure, to a job's Photos", () => {
  it("the picture goes through the Photos tab's own pipeline, stamped and under the record's name, and only then is the figure let go", async () => {
    const figure = await openFigure();
    const r = await saveMeasureToJob({ orgId: ORG, jobId: JOB, figure, words });
    expect(r).toEqual({ ok: true, door: "job", stamped: true });
    expect(h.stampFigure).toHaveBeenCalledWith(figure.photo, "12 ft 0 in", "Measured length");
    expect(h.uploadJobPhotos).toHaveBeenCalledTimes(1);
    const [org, job, files] = h.uploadJobPhotos.mock.calls[0] as [string, string, File[]];
    expect([org, job]).toEqual([ORG, JOB]);
    expect(files).toHaveLength(1);
    expect(files[0].name).toBe("Measured length 12 ft 0 in.jpg");
    expect(files[0].type).toBe("image/jpeg");
    expect(files[0].size).toBe(1208); // the stamped picture, not the one that came from the camera
    expect(measureStore().open).toBeNull();
  });

  it("a Spanish reader's photo is named in English all the same: a name is a record", async () => {
    const figure = await openFigure();
    await saveMeasureToJob({ orgId: ORG, jobId: JOB, figure, words: palabras });
    expect((h.uploadJobPhotos.mock.calls[0] as [string, string, File[]])[2][0].name).toBe("Measured length 12 ft 0 in.jpg");
    expect(h.stampFigure).toHaveBeenCalledWith(figure.photo, "12 ft 0 in", "Measured length");
  });

  it("a picture the figure could not be drawn on is still filed under its name, and the answer says the figure is not on it", async () => {
    h.stampFigure.mockImplementation(async (f: File) => f);
    const figure = await openFigure();
    const r = await saveMeasureToJob({ orgId: ORG, jobId: JOB, figure, words });
    expect(r).toEqual({ ok: true, door: "job", stamped: false });
    expect((h.uploadJobPhotos.mock.calls[0] as [string, string, File[]])[2][0].name).toBe("Measured length 12 ft 0 in.jpg");
  });

  it("a figure whose picture did not come back has nothing to file there: said, and nothing is sent", async () => {
    const figure = await openFigure({ photo: null });
    const r = await saveMeasureToJob({ orgId: ORG, jobId: JOB, figure, words });
    expect(r).toEqual({ ok: false, door: "job", error: en("sh_measure_noPicture"), final: true });
    expect(h.uploadJobPhotos).not.toHaveBeenCalled();
    expect(measureStore().open?.kind).toBe("figure");
  });

  it("no signal: said with the one action, and the figure is still in the sheet for the next tap", async () => {
    h.uploadJobPhotos.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const figure = await openFigure();
    const r = await saveMeasureToJob({ orgId: ORG, jobId: JOB, figure, words });
    expect(r).toEqual({ ok: false, door: "job", error: "The file didn't go: no signal. Try again where there's service.", final: false });
    expect(measureStore().open?.kind).toBe("figure");
    // ...and in Spanish for a Spanish reader.
    h.uploadJobPhotos.mockRejectedValueOnce(new TypeError("Load failed"));
    const es = await saveMeasureToJob({ orgId: ORG, jobId: JOB, figure, words: palabras });
    expect(es.ok === false && es.error).toBe("El archivo no se envió: sin señal. Inténtalo de nuevo donde haya señal.");
  });

  it("the door's own refusal is said as it came, and a door that answers with no photo filed is not called saved", async () => {
    const figure = await openFigure();
    h.uploadJobPhotos.mockRejectedValueOnce(new Error("That job isn't one of this company's."));
    expect(await saveMeasureToJob({ orgId: ORG, jobId: JOB, figure, words })).toEqual({ ok: false, door: "job", error: "That job isn't one of this company's.", final: false });
    h.uploadJobPhotos.mockResolvedValueOnce([]);
    const r = await saveMeasureToJob({ orgId: ORG, jobId: JOB, figure, words });
    expect(r).toEqual({ ok: false, door: "job", error: "Upload failed.", final: false });
    expect(measureStore().open?.kind).toBe("figure");
  });

  it("a figure opened since is not this save's to clear", async () => {
    const first = await openFigure();
    const going = gate();
    h.uploadJobPhotos.mockImplementationOnce(async () => {
      await going.waiting;
      return ["a/b/1-x.jpg"];
    });
    const saving = saveMeasureToJob({ orgId: ORG, jobId: JOB, figure: first, words });
    const second = await openFigure({ caption: "9 ft 0 in", value: 9 });
    going.open();
    expect((await saving).ok).toBe(true);
    const open = measureStore().open;
    expect(open?.kind === "figure" && open.figure).toBe(second);
  });
});

describe("a model, to a job's papers: the two faults", () => {
  it("the file, then the row, and ONLY THEN does the phone's copy go and the + let go", async () => {
    const model = await holdModel();
    const r = await saveModelToJob({ orgId: ORG, jobId: JOB, words });
    expect(r).toEqual({ ok: true, door: "job" });
    expect(h.uploads).toHaveLength(1);
    const up = h.uploads[0];
    expect(up.bucket).toBe("documents");
    expect(up.path).toMatch(new RegExp(`^${ORG}/${JOB}/\\d+-scan-3d-1\\.usdz$`));
    expect(up.file).toBe(model); // as it came: a model is never re-encoded
    expect(up.opts).toEqual({ upsert: false });
    expect(h.addDocument).toHaveBeenCalledWith({ job_id: JOB, name: "scan-3d-1.usdz", category: "Other", file_url: up.path, size_bytes: 4096 });
    expect(h.order).toEqual([`upload:${up.path}`, `row:${up.path}`, `discardScan:${SCAN_PATH}`]);
    expect(measureStore().held).toBeNull();
    expect(measureStore().open).toBeNull();
  });

  it("FAULT ONE, the file did not upload: nothing is owed, the model stays held, and the same tap sends it again", async () => {
    await holdModel();
    h.uploadAnswers.push({ message: "Failed to fetch" });
    const r = await saveModelToJob({ orgId: ORG, jobId: JOB, words });
    expect(r).toEqual({ ok: false, door: "job", error: "The 3D model didn't go: no signal. Try again where there's service.", final: false });
    expect(measureStore().held?.landed).toBeNull();
    expect(h.addDocument).not.toHaveBeenCalled();
    expect(h.order.some((x) => x.startsWith("discardScan"))).toBe(false);
    // The next tap is a second upload, because the first one never arrived.
    expect(await saveModelToJob({ orgId: ORG, jobId: JOB, words })).toEqual({ ok: true, door: "job" });
    expect(h.order.filter((x) => x.startsWith("upload:"))).toHaveLength(2);
    expect(h.uploads).toHaveLength(1);
  });

  it("a file over storage's limit is final: no second tap will change it, and the sentence names the size and the one action", async () => {
    await holdModel();
    h.uploadAnswers.push({ message: "The object exceeded the maximum allowed size", statusCode: "413" });
    const r = await saveModelToJob({ orgId: ORG, jobId: JOB, words });
    expect(r).toEqual({ ok: false, door: "job", error: "The 3D model is too big to send (0 MB). Scan a smaller area.", final: true });
    expect(measureStore().held).not.toBeNull(); // still his to let go of
  });

  it("FAULT TWO, the file is up and the row failed: the row is owed, and Finish Saving writes the row ALONE", async () => {
    await holdModel();
    h.addDocument.mockResolvedValueOnce({ ok: false, error: "That job isn't one of this company's." });
    const r = await saveModelToJob({ orgId: ORG, jobId: JOB, words });
    expect(r).toEqual({ ok: false, door: "job", error: "That job isn't one of this company's.", final: false });
    const path = h.uploads[0].path;
    expect(measureStore().held?.landed).toEqual({ jobId: JOB, path, name: "scan-3d-1.usdz" });
    // The phone's copy is NOT gone: the row has not landed.
    expect(h.order.some((x) => x.startsWith("discardScan"))).toBe(false);

    h.order.length = 0;
    expect(await finishSavingModel({ words })).toEqual({ ok: true, door: "job" });
    // No second upload: the job is asked whether the row is there, the row is written, then the copy goes.
    expect(h.order).toEqual(["ask:documents", `row:${path}`, `discardScan:${SCAN_PATH}`]);
    expect(h.uploads).toHaveLength(1);
    expect(h.addDocument).toHaveBeenLastCalledWith({ job_id: JOB, name: "scan-3d-1.usdz", category: "Other", file_url: path, size_bytes: 4096 });
    expect(measureStore().held).toBeNull();
  });

  it("a row that threw (a dead zone mid-save) is owed too, with nothing more to say than the sheet's own sentence", async () => {
    await holdModel();
    h.addDocument.mockRejectedValueOnce(new TypeError("Load failed"));
    const r = await saveModelToJob({ orgId: ORG, jobId: JOB, words });
    expect(r).toEqual({ ok: false, door: "job", error: null, final: false });
    expect(measureStore().held?.landed?.path).toBe(h.uploads[0].path);
    // Save to the same job again is the row alone as well.
    expect(await saveModelToJob({ orgId: ORG, jobId: JOB, words })).toEqual({ ok: true, door: "job" });
    expect(h.uploads).toHaveLength(1);
  });

  it("an answer lost on the way back is not a no: when the job already has the paper, Finish Saving writes no twin", async () => {
    await holdModel();
    h.addDocument.mockRejectedValueOnce(new TypeError("Load failed")); // it landed; only its answer was lost
    await saveModelToJob({ orgId: ORG, jobId: JOB, words });
    const path = h.uploads[0].path;
    h.papers.rows = [{ id: "doc-9" }];
    h.papers.eqs = [];
    h.order.length = 0;
    expect(await finishSavingModel({ words })).toEqual({ ok: true, door: "job" });
    expect(h.order).toEqual(["ask:documents", `discardScan:${SCAN_PATH}`]);
    expect(h.addDocument).toHaveBeenCalledTimes(1);
    // The question names the company, the job and the file.
    expect(h.papers.eqs).toEqual([["org_id", ORG], ["job_id", JOB], ["file_url", path]]);
  });

  it("a job that could not be asked is never taken for 'no paper': the row is still written, never the file removed", async () => {
    await holdModel();
    h.addDocument.mockResolvedValueOnce({ ok: false, error: "refused" });
    await saveModelToJob({ orgId: ORG, jobId: JOB, words });
    h.papers.error = { message: "Failed to fetch" };
    h.order.length = 0;
    expect((await finishSavingModel({ words })).ok).toBe(true);
    expect(h.order.filter((x) => x.startsWith("remove:"))).toEqual([]);
    expect(h.order.filter((x) => x.startsWith("row:"))).toHaveLength(1);
  });

  it("a model whose file is up on one job is never sent to another: the one door is Finish Saving", async () => {
    await holdModel();
    h.addDocument.mockResolvedValueOnce({ ok: false, error: "refused" });
    await saveModelToJob({ orgId: ORG, jobId: JOB, words });
    h.order.length = 0;
    const r = await saveModelToJob({ orgId: ORG, jobId: OTHER_JOB, words });
    expect(r).toEqual({ ok: false, door: "job", error: en("sh_measure_rowOwed"), final: false });
    expect(await startInspectionWith({ orgId: ORG, words })).toEqual({ ok: false, door: "inspection", error: en("sh_measure_rowOwed"), final: false });
    expect(h.order).toEqual([]);
    expect(h.createInspectionNow).not.toHaveBeenCalled();
  });

  it("ONE SAVE AT A TIME: a second tap while the file is going up joins the first, and one file goes up", async () => {
    await holdModel();
    const going = gate();
    h.uploadGate = going.waiting;
    const first = saveModelToJob({ orgId: ORG, jobId: JOB, words });
    expect(modelTrip()?.door).toBe("job");
    const second = saveModelToJob({ orgId: ORG, jobId: JOB, words });
    const third = startInspectionWith({ orgId: ORG, words }); // whatever door: its answer names its own
    going.open();
    expect(await first).toEqual({ ok: true, door: "job" });
    expect(await second).toEqual({ ok: true, door: "job" });
    expect(await third).toEqual({ ok: true, door: "job" });
    expect(h.uploads).toHaveLength(1);
    expect(h.addDocument).toHaveBeenCalledTimes(1);
    expect(h.createInspectionNow).not.toHaveBeenCalled();
    expect(modelTrip()).toBeNull();
  });

  it("A TRIP IS ITS MODEL'S: a save still running for a discarded model is never joined by the next model's tap (the skeptic's N2)", async () => {
    await holdModel();
    const going = gate();
    h.uploadGate = going.waiting;
    const old = saveModelToJob({ orgId: ORG, jobId: JOB, words });
    await discardModel();
    const fresh = await holdModel();
    const mine = saveModelToJob({ orgId: ORG, jobId: JOB, words });
    expect(mine).not.toBe(old);
    going.open();
    expect(await old).toEqual({ ok: false, door: "job", error: null, final: false });
    // The new model's own save ran: its file went up and its row was written. Never a silent tap.
    expect(await mine).toEqual({ ok: true, door: "job" });
    expect(h.uploads.some((u) => u.file === fresh)).toBe(true);
    expect(h.addDocument).toHaveBeenCalledTimes(1);
    expect(measureStore().held).toBeNull();
  });

  it("with nothing held there is nothing to save, and Finish Saving with nothing owed writes nothing", async () => {
    expect(await saveModelToJob({ orgId: ORG, jobId: JOB, words })).toEqual({ ok: false, door: "job", error: null, final: false });
    await holdModel();
    expect(await finishSavingModel({ words })).toEqual({ ok: false, door: "job", error: null, final: false });
    expect(h.order).toEqual([]);
  });
});

describe("Start an Inspection with It: a visit made once, ADDED TO and never replaced", () => {
  it("a figure: the visit, the picture under the visit's own folder, the visit read, the picture APPENDED, then one patch with the row and the placement (never `photos`)", async () => {
    const figure = await openFigure();
    const r = await startInspectionWith({ orgId: ORG, figure, words });
    expect(r).toEqual({ ok: true, door: "inspection", visitId: VISIT });
    expect(h.createInspectionNow).toHaveBeenCalledTimes(1);
    expect(h.createInspectionNow).toHaveBeenCalledWith();
    // The Inspector's own path for a visit's file, and a picture goes through the downscale every photo gets.
    expect(h.prepareImageForUpload).toHaveBeenCalledWith(figure.photo);
    const path = h.uploads[0].path;
    expect(h.uploads[0].bucket).toBe("documents");
    expect(path).toMatch(new RegExp(`^${ORG}/appointments/${VISIT}/\\d+-measure-1731300000000\\.jpg$`));
    expect(h.uploads[0].opts).toEqual({ upsert: false });

    expect(h.addInspectionPhotos).toHaveBeenCalledWith(VISIT, [path]);
    expect(h.saveInspectionCapture).toHaveBeenCalledTimes(1);
    const [id, patch] = h.saveInspectionCapture.mock.calls[0] as [string, ReturnType<typeof inspectionPatch>];
    expect(id).toBe(VISIT);
    expect(Object.keys(patch).sort()).toEqual(["measures", "photo_meta"]);
    expect(patch.measures).toEqual([{ id: expect.any(String), label: "Measured length", value: 12, unit: "ft" }]);
    expect(patch.photo_meta).toEqual({ [path]: { caption: "12 ft 0 in", about: "Measured length" } });
    expect(h.order).toEqual(["visit", `upload:${path}`, "ask:appointments", `addPhotos:${path}`, `patch:${VISIT}`]);
    // The visit's read names the visit and the company.
    expect(h.papers.eqs).toEqual(expect.arrayContaining([["org_id", ORG], ["id", VISIT]]));
    expect(parseInspectorCapture(h.visit.capture).photo_meta).toEqual({ [path]: { caption: "12 ft 0 in", about: "Measured length" } });
    // Saved: the figure is let go, and the visit is nobody's to fill again.
    expect(measureStore().open).toBeNull();
    expect(measureStore().visitId).toBeNull();
    expect(visitMadeFor(figure)).toBeNull();
  });

  it("the patch never names `photos`, and ADDS its row to what the visit holds: nothing on the visit is replaced", async () => {
    const figure = await openFigure({ approx: true, lidar: false, caption: "12 ft 0 in (approx.)" } as Partial<MeasureFigure>);
    const his: CaptureMeasure = { id: "his-1", label: "Panel to meter", value: 7, unit: "ft" };
    const visit = { photos: ["o/appointments/v/0-his.jpg", "o/appointments/v/1-measure.jpg"], measures: [his], photo_meta: { "o/appointments/v/0-his.jpg": { caption: "Meter base" } } };
    const patch = inspectionPatch(en, { kind: "figure", figure, rowId: "row-1" }, "o/appointments/v/1-measure.jpg", [his]);
    expect(patch).not.toHaveProperty("photos");
    const stored = parseInspectorCapture(mergeCaptureSections(visit, patch));
    expect(stored.measures).toEqual([his, { id: "row-1", label: "Measured length (approx.)", value: 12, unit: "ft" }]);
    expect(stored.photos).toEqual(visit.photos);
    expect(stored.photo_meta).toEqual({
      "o/appointments/v/0-his.jpg": { caption: "Meter base" },
      "o/appointments/v/1-measure.jpg": { caption: "12 ft 0 in (approx.)", about: "Measured length (approx.)" },
    });
    // A row a lost answer had already put there is not added twice; a model's patch is its placement alone.
    expect(inspectionPatch(en, { kind: "figure", figure, rowId: "his-1" }, null, [his])).toEqual({});
    expect(inspectionPatch(en, { kind: "model" }, "o/appointments/v/2-scan.usdz")).toEqual({ photo_meta: { "o/appointments/v/2-scan.usdz": { caption: "3D model", about: "3D Scan" } } });
  });

  it("A RETRY REUSES ITS VISIT: the visit made, the fill failed, and the next tap fills THAT visit, sends no second file and writes the same row", async () => {
    const figure = await openFigure();
    h.saveInspectionCapture.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const first = await startInspectionWith({ orgId: ORG, figure, words });
    expect(first).toEqual({ ok: false, door: "inspection", error: en("sh_checkSignal"), final: false });
    // The visit is remembered, with the result and in the store's slot, and the figure is still open.
    expect(measureStore().visitId).toBe(VISIT);
    expect(visitMadeFor(figure)).toBe(VISIT);
    expect(measureStore().open?.kind).toBe("figure");

    const second = await startInspectionWith({ orgId: ORG, figure, words });
    expect(second).toEqual({ ok: true, door: "inspection", visitId: VISIT });
    expect(h.createInspectionNow).toHaveBeenCalledTimes(1);
    expect(h.uploads).toHaveLength(1);
    const [a, b] = h.saveInspectionCapture.mock.calls as [string, ReturnType<typeof inspectionPatch>][];
    expect(a[0]).toBe(VISIT);
    expect(b[0]).toBe(VISIT);
    expect(b[1]).toEqual(a[1]); // the same row id, the same path: a patch that had landed unheard is repeated, never doubled
  });

  it("a file that did not go up leaves the visit made, and the retry sends the file to the same visit", async () => {
    const figure = await openFigure();
    h.uploadAnswers.push({ message: "Load failed" });
    const first = await startInspectionWith({ orgId: ORG, figure, words });
    expect(first).toEqual({ ok: false, door: "inspection", error: "The file didn't go: no signal. Try again where there's service.", final: false });
    expect(visitMadeFor(figure)).toBe(VISIT);
    expect(h.saveInspectionCapture).not.toHaveBeenCalled();
    expect((await startInspectionWith({ orgId: ORG, figure, words })).ok).toBe(true);
    expect(h.createInspectionNow).toHaveBeenCalledTimes(1);
    expect(h.uploads).toHaveLength(1);
    expect(h.uploads[0].path).toContain(`/appointments/${VISIT}/`);
  });

  it("a visit already in the store's slot is the one filled: no second visit is made", async () => {
    const figure = await openFigure();
    rememberMeasureVisit(VISIT);
    expect((await startInspectionWith({ orgId: ORG, figure, words })).ok).toBe(true);
    expect(h.createInspectionNow).not.toHaveBeenCalled();
    expect((h.saveInspectionCapture.mock.calls[0] as [string])[0]).toBe(VISIT);
  });

  it("a visit that could not be made says the door's own words, and nothing is sent", async () => {
    const figure = await openFigure();
    h.createInspectionNow.mockResolvedValueOnce({ ok: false, error: "This action is staff-only." });
    expect(await startInspectionWith({ orgId: ORG, figure, words })).toEqual({ ok: false, door: "inspection", error: "This action is staff-only.", final: false });
    h.createInspectionNow.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    expect(await startInspectionWith({ orgId: ORG, figure, words: palabras })).toEqual({ ok: false, door: "inspection", error: translator("es")("sh_checkSignal"), final: false });
    expect(h.uploads).toHaveLength(0);
    expect(visitMadeFor(figure)).toBeNull();
  });

  it("a visit's refusal of the patch is not called saved", async () => {
    const figure = await openFigure();
    h.saveInspectionCapture.mockResolvedValueOnce({ ok: false, error: "That appointment couldn't be found." });
    const r = await startInspectionWith({ orgId: ORG, figure, words });
    expect(r).toEqual({ ok: false, door: "inspection", error: "That appointment couldn't be found.", final: false });
    expect(measureStore().open?.kind).toBe("figure");
  });

  it("a figure with no picture still goes, as its typed row alone", async () => {
    const figure = await openFigure({ photo: null });
    expect((await startInspectionWith({ orgId: ORG, figure, words })).ok).toBe(true);
    expect(h.uploads).toHaveLength(0);
    const patch = (h.saveInspectionCapture.mock.calls[0] as [string, ReturnType<typeof inspectionPatch>])[1];
    expect(Object.keys(patch)).toEqual(["measures"]);
    expect(patch.measures?.[0]).toMatchObject({ label: "Measured length", value: 12, unit: "ft" });
  });

  it("a model: untouched, filed as the Inspector files one, and the phone's copy goes only after the patch", async () => {
    const model = await holdModel();
    const r = await startInspectionWith({ orgId: ORG, words });
    expect(r).toEqual({ ok: true, door: "inspection", visitId: VISIT });
    expect(h.prepareImageForUpload).not.toHaveBeenCalled();
    const path = h.uploads[0].path;
    expect(h.uploads[0].file).toBe(model);
    expect(path).toMatch(new RegExp(`^${ORG}/appointments/${VISIT}/\\d+-scan-3d-1\\.usdz$`));
    expect(h.addInspectionPhotos).toHaveBeenCalledWith(VISIT, [path]);
    expect(h.saveInspectionCapture).toHaveBeenCalledWith(VISIT, { photo_meta: { [path]: { caption: "3D model", about: "3D Scan" } } });
    expect(h.order).toEqual(["visit", `upload:${path}`, `addPhotos:${path}`, `patch:${VISIT}`, `discardScan:${SCAN_PATH}`]);
    expect(measureStore().held).toBeNull();
    expect(measureStore().visitId).toBeNull();
  });

  it("a model whose patch failed stays held with its visit, and the retry is the patch alone", async () => {
    const model = await holdModel();
    h.saveInspectionCapture.mockResolvedValueOnce({ ok: false, error: "refused" });
    expect((await startInspectionWith({ orgId: ORG, words })).ok).toBe(false);
    expect(measureStore().held).not.toBeNull();
    expect(h.order.some((x) => x.startsWith("discardScan"))).toBe(false);
    expect(visitMadeFor(model)).toBe(VISIT);
    h.order.length = 0;
    expect((await startInspectionWith({ orgId: ORG, words })).ok).toBe(true);
    // No second upload: the append again (it adds nothing twice), then the placement.
    const path = h.uploads[0].path;
    expect(h.order).toEqual([`addPhotos:${path}`, `patch:${VISIT}`, `discardScan:${SCAN_PATH}`]);
    expect(parseInspectorCapture(h.visit.capture).photos).toEqual([path]);
  });

  it("TWO RESULTS ON THE PHONE: a figure never fills the visit made for a held model, and the model's visit stays its own", async () => {
    const model = await holdModel();
    h.saveInspectionCapture.mockResolvedValueOnce({ ok: false, error: "refused" });
    await startInspectionWith({ orgId: ORG, words }); // the model's visit is made and not filled
    expect(measureStore().visitId).toBe(VISIT);

    const figure = await openFigure();
    expect(visitMadeFor(figure)).toBeNull();
    const SECOND = "0c000000-0000-4000-8000-00000000e002";
    h.createInspectionNow.mockResolvedValueOnce({ ok: true, id: SECOND });
    expect(await startInspectionWith({ orgId: ORG, figure, words })).toEqual({ ok: true, door: "inspection", visitId: SECOND });
    expect(h.createInspectionNow).toHaveBeenCalledTimes(2);
    // The model's retry still fills its own visit, with the file it already sent there.
    expect(measureStore().visitId).toBe(VISIT);
    expect(visitMadeFor(model)).toBe(VISIT);
    h.order.length = 0;
    expect(await startInspectionWith({ orgId: ORG, words })).toEqual({ ok: true, door: "inspection", visitId: VISIT });
    expect(h.order).toEqual([`addPhotos:${h.uploads[0].path}`, `patch:${VISIT}`, `discardScan:${SCAN_PATH}`]);
  });
});

describe("the visit it fills may not be empty by then: nothing on it is ever replaced (the skeptic's B1)", () => {
  const HIS_PHOTO = `${ORG}/appointments/${VISIT}/5-his-panel.jpg`;
  const HIS_ROW: CaptureMeasure = { id: "his-row", label: "Panel to meter", value: 7, unit: "ft" };
  /** He opened the visit and worked on it: a photo with its caption, and a measurement. */
  const heUsedTheVisit = () => {
    h.visit.capture = mergeCaptureSections(h.visit.capture, { photos: [HIS_PHOTO], photo_meta: { [HIS_PHOTO]: { caption: "Panel" } }, measures: [HIS_ROW] });
  };

  it("(a) A RETRY AFTER HE USED THE VISIT: the model's upload failed, he took photos on the visit, Try Again keeps every one of them", async () => {
    await holdModel();
    h.uploadAnswers.push({ message: "Load failed" });
    expect((await startInspectionWith({ orgId: ORG, words })).ok).toBe(false);
    heUsedTheVisit();
    expect(await startInspectionWith({ orgId: ORG, words })).toEqual({ ok: true, door: "inspection", visitId: VISIT });
    const path = h.uploads[0].path;
    const stored = parseInspectorCapture(h.visit.capture);
    expect(stored.photos).toEqual([HIS_PHOTO, path]);
    expect(stored.measures).toEqual([HIS_ROW]);
    expect(stored.photo_meta).toEqual({ [HIS_PHOTO]: { caption: "Panel" }, [path]: { caption: "3D model", about: "3D Scan" } });
    for (const [, patch] of h.saveInspectionCapture.mock.calls as [string, object][]) expect(patch).not.toHaveProperty("photos");
  });

  it("(a) the same for a figure: its row joins his rows, its picture joins his photos", async () => {
    const figure = await openFigure();
    h.saveInspectionCapture.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    expect((await startInspectionWith({ orgId: ORG, figure, words })).ok).toBe(false);
    heUsedTheVisit();
    expect((await startInspectionWith({ orgId: ORG, figure, words })).ok).toBe(true);
    const stored = parseInspectorCapture(h.visit.capture);
    expect(stored.measures).toEqual([HIS_ROW, { id: expect.any(String), label: "Measured length", value: 12, unit: "ft" }]);
    // His photo stays; the picture (appended on the first try, whose patch then failed) is there once.
    expect(stored.photos.sort()).toEqual([HIS_PHOTO, h.uploads[0].path].sort());
    expect(stored.photo_meta?.[HIS_PHOTO]).toEqual({ caption: "Panel" });
  });

  it("(b) A MODEL SAVED TO A VISIT AND HANDED BACK is never Tried Again into the visit an earlier try made", async () => {
    const model = await holdModel();
    h.saveInspectionCapture.mockResolvedValueOnce({ ok: false, error: "refused" });
    await startInspectionWith({ orgId: ORG, words });
    expect(visitMadeFor(model)).toBe(VISIT);
    // Save to This Visit: the Inspector takes it, the + lets go and forgets the visit made for it.
    releaseHeldModel();
    forgetMeasureVisitOf(model);
    expect(measureStore().visitId).toBeNull();
    // ...and the Inspector hands it back (it left the visit before the model went up).
    expect(keepModelInPlus({ model, path: SCAN_PATH })).toBe(true);
    expect(visitMadeFor(model)).toBeNull();
    const SECOND = "0c000000-0000-4000-8000-00000000e002";
    h.createInspectionNow.mockResolvedValueOnce({ ok: true, id: SECOND });
    expect(await startInspectionWith({ orgId: ORG, words })).toEqual({ ok: true, door: "inspection", visitId: SECOND });
    expect(h.createInspectionNow).toHaveBeenCalledTimes(2);
  });

  it("(c) A LATE ANSWER: Back while the model goes up, he opens the visit and adds to it, and what lands after keeps it all", async () => {
    await holdModel();
    const going = gate();
    h.uploadGate = going.waiting;
    const saving = startInspectionWith({ orgId: ORG, words });
    await vi.waitFor(() => expect(h.createInspectionNow).toHaveBeenCalledTimes(1));
    heUsedTheVisit();
    going.open();
    expect((await saving).ok).toBe(true);
    const stored = parseInspectorCapture(h.visit.capture);
    expect(stored.photos).toEqual([HIS_PHOTO, h.uploads[0].path]);
    expect(stored.measures).toEqual([HIS_ROW]);
    expect(stored.photo_meta?.[HIS_PHOTO]).toEqual({ caption: "Panel" });
  });

  it("a visit at its cap of measurements is said in his words, and nothing is written to it", async () => {
    const figure = await openFigure();
    const full = Array.from({ length: MAX_MEASURES }, (_, i) => ({ id: `m-${i}`, label: `Row ${i}`, value: i, unit: "ft" }));
    h.visit.capture = mergeCaptureSections(null, { measures: full });
    rememberMeasureVisit(VISIT);
    const r = await startInspectionWith({ orgId: ORG, figure, words: palabras });
    expect(r).toEqual({ ok: false, door: "inspection", error: translator("es")("vi_measuresFull").replace("{n}", String(MAX_MEASURES)), final: false });
    expect(r.ok === false && r.error).toContain("50");
    expect(h.addInspectionPhotos).not.toHaveBeenCalled();
    expect(h.saveInspectionCapture).not.toHaveBeenCalled();
  });

  it("a visit that could not be read is never taken for an empty one: said, and nothing is written", async () => {
    const figure = await openFigure();
    h.visit.readError = { message: "Failed to fetch" };
    expect(await startInspectionWith({ orgId: ORG, figure, words })).toEqual({ ok: false, door: "inspection", error: en("sh_checkSignal"), final: false });
    expect(h.addInspectionPhotos).not.toHaveBeenCalled();
    expect(h.saveInspectionCapture).not.toHaveBeenCalled();
  });

  it("a row a lost answer had already put on the visit is not added twice", async () => {
    const figure = await openFigure({ photo: null });
    h.saveInspectionCapture.mockImplementationOnce(async (id: string, patch: Parameters<typeof mergeCaptureSections>[1]) => {
      h.visit.capture = mergeCaptureSections(h.visit.capture, patch);
      throw new TypeError("Load failed"); // it landed; the answer did not
    });
    expect((await startInspectionWith({ orgId: ORG, figure, words })).ok).toBe(false);
    expect((await startInspectionWith({ orgId: ORG, figure, words })).ok).toBe(true);
    expect(parseInspectorCapture(h.visit.capture).measures).toHaveLength(1);
    expect(h.saveInspectionCapture).toHaveBeenCalledTimes(1);
  });
});

describe("not keeping it", () => {
  it("a model nothing was sent for: the + lets go and the phone's copy goes, and storage is not touched", async () => {
    await holdModel();
    await discardModel();
    expect(h.order).toEqual([`discardScan:${SCAN_PATH}`]);
    expect(measureStore().held).toBeNull();
  });

  it("a model whose file is up with no row: the job is asked, the file comes back out FIRST, then the + lets go", async () => {
    await holdModel();
    h.addDocument.mockResolvedValueOnce({ ok: false, error: "refused" });
    await saveModelToJob({ orgId: ORG, jobId: JOB, words });
    const path = h.uploads[0].path;
    h.order.length = 0;
    await discardModel();
    expect(h.order).toEqual(["ask:documents", `remove:${path}`, `discardScan:${SCAN_PATH}`]);
    expect(measureStore().held).toBeNull();
  });

  it("a file the job turns out to have a paper for is left where it is; so is one the job could not be asked about", async () => {
    await holdModel();
    h.addDocument.mockRejectedValueOnce(new TypeError("Load failed"));
    await saveModelToJob({ orgId: ORG, jobId: JOB, words });
    h.papers.rows = [{ id: "doc-9" }];
    h.order.length = 0;
    await discardModel();
    expect(h.order).toEqual(["ask:documents", `discardScan:${SCAN_PATH}`]);

    resetMeasureStoreForTest();
    await holdModel();
    h.addDocument.mockRejectedValueOnce(new TypeError("Load failed"));
    await saveModelToJob({ orgId: ORG, jobId: JOB, words });
    h.papers.rows = [];
    h.papers.error = { message: "Failed to fetch" };
    h.order.length = 0;
    await discardModel();
    expect(h.order).toEqual(["ask:documents", `discardScan:${SCAN_PATH}`]);
  });

  it("a file left under a visit whose patch never answered goes through the visit's own door, then out of storage", async () => {
    await holdModel();
    h.saveInspectionCapture.mockRejectedValueOnce(new TypeError("Load failed"));
    await startInspectionWith({ orgId: ORG, words });
    const path = h.uploads[0].path;
    h.order.length = 0;
    await discardModel();
    expect(h.removeInspectionPhoto).toHaveBeenCalledWith(VISIT, path);
    expect(h.order).toEqual([`offVisit:${path}`, `remove:${path}`, `discardScan:${SCAN_PATH}`]);
  });

  it("when the visit's door does not answer, the file is left alone: never a visit pointing at a file that is gone", async () => {
    const figure = await openFigure();
    h.saveInspectionCapture.mockRejectedValueOnce(new TypeError("Load failed"));
    await startInspectionWith({ orgId: ORG, figure, words });
    h.removeInspectionPhoto.mockRejectedValueOnce(new TypeError("Load failed"));
    h.order.length = 0;
    await forgetFigure(figure);
    expect(h.order).toEqual([]);
    // ...and a figure with nothing sent has nothing to take back.
    await forgetFigure(await openFigure());
    expect(h.order).toEqual([]);
  });

  it("a model discarded while its file is going up: what went up comes back out, and no row is written", async () => {
    await holdModel();
    const going = gate();
    h.uploadGate = going.waiting;
    const saving = saveModelToJob({ orgId: ORG, jobId: JOB, words });
    await discardModel();
    expect(measureStore().held).toBeNull();
    going.open();
    expect(await saving).toEqual({ ok: false, door: "job", error: null, final: false });
    const path = h.uploads[0].path;
    expect(h.order).toEqual([`discardScan:${SCAN_PATH}`, `upload:${path}`, `remove:${path}`]);
    expect(h.addDocument).not.toHaveBeenCalled();
  });

  it("DISCARDED WHILE THE ROW WAS BEING WRITTEN: the row that lands after the discard comes back out through the job's own door", async () => {
    await holdModel();
    const writing = gate();
    h.addDocument.mockImplementationOnce(async (input: { file_url: string }) => {
      await writing.waiting;
      h.order.push(`row:${input.file_url}`);
      return { ok: true, id: "doc-7" };
    });
    const saving = saveModelToJob({ orgId: ORG, jobId: JOB, words });
    await vi.waitFor(() => expect(h.addDocument).toHaveBeenCalledTimes(1));
    const path = h.uploads[0].path;
    // The + menu's Discard, with the sheet closed on a slow save.
    await discardModel();
    expect(measureStore().held).toBeNull();
    writing.open();
    expect(await saving).toEqual({ ok: false, door: "job", error: null, final: false });
    expect(h.deleteDocument).toHaveBeenCalledWith("doc-7", null, JOB);
    // The phone's copy went once, with the discard: the save does not say saved, and discards nothing twice.
    expect(h.order).toEqual([`upload:${path}`, `discardScan:${SCAN_PATH}`, `row:${path}`, "unfile:doc-7"]);
  });

  it("the same while Finish Saving's row is out: the discard took the file, so the late row is never left pointing at nothing", async () => {
    await holdModel();
    h.addDocument.mockResolvedValueOnce({ ok: false, error: "refused" });
    await saveModelToJob({ orgId: ORG, jobId: JOB, words });
    const path = h.uploads[0].path;
    const writing = gate();
    h.addDocument.mockImplementationOnce(async (input: { file_url: string }) => {
      await writing.waiting;
      h.order.push(`row:${input.file_url}`);
      return { ok: true, id: "doc-8" };
    });
    h.order.length = 0;
    const finishing = finishSavingModel({ words });
    await vi.waitFor(() => expect(h.addDocument).toHaveBeenCalledTimes(2));
    await discardModel();
    writing.open();
    expect(await finishing).toEqual({ ok: false, door: "job", error: null, final: false });
    expect(h.order).toEqual(["ask:documents", "ask:documents", `remove:${path}`, `discardScan:${SCAN_PATH}`, `row:${path}`, "unfile:doc-8"]);
  });

  it("a row an EARLIER try had already put down is not this save's to take back: that model was saved there", async () => {
    await holdModel();
    h.addDocument.mockRejectedValueOnce(new TypeError("Load failed"));
    await saveModelToJob({ orgId: ORG, jobId: JOB, words });
    // The lost answer had landed: the job has the paper. Finish Saving is asking when he discards.
    h.papers.rows = [{ id: "doc-9" }];
    h.order.length = 0;
    const finishing = finishSavingModel({ words });
    await discardModel();
    expect(await finishing).toEqual({ ok: false, door: "job", error: null, final: false });
    expect(h.deleteDocument).not.toHaveBeenCalled();
    expect(h.order.filter((x) => x.startsWith("remove:") || x.startsWith("row:"))).toEqual([]);
    expect(h.order.filter((x) => x.startsWith("discardScan:"))).toEqual([`discardScan:${SCAN_PATH}`]);
  });

  it("DISCARDED WHILE THE VISIT WAS TAKING IT: the patch that lands after the discard is undone through the visit's own door", async () => {
    await holdModel();
    const writing = gate();
    h.saveInspectionCapture.mockImplementationOnce(async (id: string) => {
      await writing.waiting;
      h.order.push(`patch:${id}`);
      return { ok: true, id };
    });
    const saving = startInspectionWith({ orgId: ORG, words });
    await vi.waitFor(() => expect(h.saveInspectionCapture).toHaveBeenCalledTimes(1));
    const path = h.uploads[0].path;
    h.order.length = 0;
    await discardModel();
    expect(measureStore().held).toBeNull();
    writing.open();
    expect(await saving).toEqual({ ok: false, door: "inspection", error: null, final: false });
    // Off the visit twice: the discard's sweep (the visit had not listed it yet), then the save, once
    // its patch had landed and listed it. The phone's copy went once.
    expect(h.order).toEqual([`offVisit:${path}`, `remove:${path}`, `discardScan:${SCAN_PATH}`, `patch:${VISIT}`, `offVisit:${path}`]);
    expect(h.removeInspectionPhoto).toHaveBeenLastCalledWith(VISIT, path);
  });

  it("a save that ends after a NEW model is held does not let go of the new one", async () => {
    await holdModel();
    const going = gate();
    h.uploadGate = going.waiting;
    const saving = saveModelToJob({ orgId: ORG, jobId: JOB, words });
    // The store starts over (another person on the phone) and a new scan is held before the save ends.
    resetMeasureStoreForTest();
    const fresh = await holdModel();
    going.open();
    await saving;
    expect(measureStore().held?.model).toBe(fresh);
  });
});

describe("the file, pinned", () => {
  const src = readFileSync(join(process.cwd(), "src/lib/quick-measure-save.ts"), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("imports no catalog: the words are handed in", () => {
    expect(code).not.toMatch(/from\s+["']@\/lib\/(i18n|words)/);
  });

  it("writes through the doors that exist, and owns no table of its own", () => {
    for (const door of ["uploadJobPhotos", "addDocument", "deleteDocument", "createInspectionNow", "addInspectionPhotos", "saveInspectionCapture", "removeInspectionPhoto"]) expect(code).toContain(`${door}(`);
    expect(code).not.toMatch(/\.(insert|update|upsert|delete)\(/);
    // Its two reads (is the paper's row there? what rows does the visit hold?) name the company.
    expect(code.match(/\.from\("documents"\)[^;]*/)?.[0]).toContain('.eq("org_id", orgId)');
    expect(code.match(/\.from\("appointments"\)[^;]*/)?.[0]).toContain('.eq("org_id", orgId)');
    expect(code.match(/\.from\("appointments"\)[^;]*/)?.[0]).toContain('.eq("id", visitId)');
    // A patch to a visit never names its whole photo list.
    expect(code).not.toMatch(/photos:\s*\[path\]/);
  });

  it("the phone's copy goes only after the write that makes the model findable", () => {
    // Two places discard the shell's copy, and each sits after its row or its patch.
    const toJob = code.slice(code.indexOf("async function modelToJob("), code.indexOf("export function startInspectionWith("));
    expect(toJob.indexOf("addDocument(")).toBeGreaterThan(-1);
    expect(toJob.indexOf("discardScan(")).toBeGreaterThan(toJob.indexOf("addDocument("));
    expect(toJob.indexOf("releaseHeldModel(")).toBeGreaterThan(toJob.indexOf("discardScan("));
    const toVisit = code.slice(code.indexOf("async function inspectionWith("), code.indexOf("export async function discardModel("));
    expect(toVisit.indexOf("discardScan(")).toBeGreaterThan(toVisit.indexOf("saveInspectionCapture("));
    expect(code.split("discardScan(").length - 1).toBe(2);
  });
});
