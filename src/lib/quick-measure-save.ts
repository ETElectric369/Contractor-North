import { createClient } from "@/lib/supabase/client";
import { prepareImageForUpload } from "@/lib/image-prep";
import { jobFilePath } from "@/lib/job-file-upload";
import { uploadRefusal } from "@/lib/upload-words";
import { discardScan } from "@/lib/native-scan";
import { captureId, MAX_MEASURES, parseInspectorCapture, type CaptureMeasure, type CapturePatch } from "@/lib/inspection/capture";
import { measuredRowLabelIn } from "@/lib/inspection/measured-label";
import { stampFigure } from "@/lib/measure-stamp";
import type { Words } from "@/lib/lang-words";
import {
  clearMeasureFigure,
  dropHeldModel,
  measureStore,
  patchHeldModel,
  releaseHeldModel,
  rememberMeasureVisit,
  type HeldModel,
  type MeasureFigure,
} from "@/lib/quick-measure";
import { uploadJobPhotos } from "@/app/(app)/jobs/[id]/upload-job-photos";
import { addDocument, deleteDocument } from "@/app/(app)/jobs/actions";
import { addInspectionPhotos, createInspectionNow, removeInspectionPhoto, saveInspectionCapture } from "@/app/(app)/appointments/actions";

/**
 * WHERE A RESULT OF MEASURE FROM THE + IS SAVED (cn-v1160): a job's Photos, a job's papers, or a new
 * inspection. Client code, and nothing here is a new writer: every write goes through a door that
 * already exists (uploadJobPhotos, addDocument, createInspectionNow, addInspectionPhotos,
 * saveInspectionCapture; and, to
 * take back what a discard overtook, deleteDocument and removeInspectionPhoto), and the files go up
 * the way the Inspector and the job's own pages send theirs.
 *
 * WHAT THIS FILE ADDS IS THE ORDER, AND WHAT A SECOND TAP REPEATS:
 *
 *   · A 3D model costs minutes to make and is 40 to 130 MB. Its file goes up, THEN the row that
 *     points at it is written, and ONLY THEN does the phone's own copy go and the + let go of it.
 *     Two faults leave it held, and the next tap does a different thing for each: the file did not
 *     upload (the tap sends it again), or the file is up and the row failed (the tap writes the row
 *     alone, never a second upload).
 *   · Start an Inspection with It makes a visit once and ADDS to it, never replaces: the visit it
 *     fills may not be empty by then (a retry after he opened the visit and took photos on it, a
 *     late answer after he went to it), and a capture patch that names a whole section replaces
 *     what is stored. So the file goes on through the visit's own append (addInspectionPhotos), its
 *     placement as one key (photo_meta merges by key), and a figure's row is added to the rows the
 *     visit holds as read just before. A retry fills the visit the first try made, and a visit
 *     that took a result is never offered to another.
 *   · ONE SAVE OF A MODEL AT A TIME. A save still on its way is joined, never doubled (the sheet can
 *     be closed and opened again while a hundred megabytes are going up).
 *   · AN ANSWER LOST ON THE WAY BACK IS NOT A NO. A save that threw in a dead zone may have landed,
 *     so before a row is written a second time, and before a file is taken back out of storage, the
 *     record it belongs to is asked whether it already points at that file.
 *
 * A save is never called saved on a guess: each door's own answer is read back, and only then does
 * the store let go of what was saved (and only of THAT result: one opened since is not this save's
 * to clear).
 *
 * THE WORDS ARE HANDED IN (a file under src/lib imports no catalog): the reader's translator for
 * what he is told, the English one for what is stored. A stored label, the figure drawn on a picture
 * and a document's name are records, and records stay English, as the Inspector's stored labels do.
 */

export type SaveWords = {
  lang?: string | null;
  /** The reader's translator: translator(lang). */
  t: Words;
  /** The English catalog, translator("en"): what is stored is a record. */
  en: Words;
};

/** Which kind of place took it. */
export type SaveDoor = "job" | "inspection";

export type MeasureSaved =
  | { ok: true; door: "job"; /** A figure only: it was drawn on the picture (false: it is in the picture's name alone). */ stamped?: boolean }
  | { ok: true; door: "inspection"; visitId: string }
  | {
      ok: false;
      door: SaveDoor;
      /** What to tell him, in his own language. Null when the sheet's own state already says it (the
       *  row is owed, or he discarded it mid-save). */
      error: string | null;
      /** No second tap will change it (the file is over storage's limit). */
      final: boolean;
    };

// ── THE RECORD'S WORDS ─────────────────────────────────────────────────────────────────────────

const SAYS_APPROX = /\(approx\.\)/i;

/**
 * What a figure is called where it is stored. `rowLabel` is the visit's measurement row, exactly as
 * the Inspector writes it ("Measured length (approx.)"). `label` and `name` are for a job's photo:
 * the words over the figure on the picture, and the document's name ("Measured length 12 ft 0
 * in.jpg"). The caption of a figure off a phone with no sensor already says "(approx.)", so the
 * label beside it does not say it a second time.
 */
export function measureRecord(en: Words, f: Pick<MeasureFigure, "mode" | "approx" | "caption">): { rowLabel: string; label: string; name: string } {
  const caption = f.caption.trim();
  const label = measuredRowLabelIn(en, f.mode, f.approx && !SAYS_APPROX.test(caption));
  // A name is one line of words: nothing in it may read as a folder.
  const name = `${label} ${caption}`.replace(/[\\/]/g, "-").replace(/\s+/g, " ").trim();
  return { rowLabel: measuredRowLabelIn(en, f.mode, f.approx), label, name: `${name}.jpg` };
}

/**
 * The capture patch that follows the file onto the visit. It NEVER names `photos` (the file went on
 * through the visit's own append), so nothing he took on the visit can be replaced by it. A figure:
 * its typed row (the label English, as the Inspector's Measure writes it) ADDED to the rows the visit
 * already holds (`stored`, read just before), and not added again when a lost answer had already put
 * it there; and its picture's placement. A model: the two words the Inspector files a 3D model under.
 * The placement is one key, and photo_meta merges by key.
 */
export function inspectionPatch(
  en: Words,
  what: { kind: "figure"; figure: MeasureFigure; rowId: string } | { kind: "model" },
  path: string | null,
  stored: readonly CaptureMeasure[] = [],
): CapturePatch {
  if (what.kind === "model") return path ? { photo_meta: { [path]: { caption: "3D model", about: "3D Scan" } } } : {};
  const f = what.figure;
  const label = measureRecord(en, f).rowLabel;
  const row: CaptureMeasure = { id: what.rowId, label, value: f.value, unit: f.unit };
  return {
    ...(stored.some((m) => m.id === row.id) ? {} : { measures: [...stored, row] }),
    ...(path ? { photo_meta: { [path]: { caption: f.caption, about: label } } } : {}),
  };
}

// ── WHAT ONE RESULT REMEMBERS BETWEEN TAPS ─────────────────────────────────────────────────────

/** Kept per result (the figure, or the model's file), so a second tap repeats nothing that landed. */
type Carried = {
  /** The visit Start an Inspection with It made for THIS result. */
  visitId?: string;
  /** Its file, already up under that visit's folder: the patch is what is owed, not the file. */
  visitUpload?: { visitId: string; path: string };
  /** The typed row's id, so a retried patch writes the same row and never a twin of it. */
  rowId?: string;
};
const carried = new WeakMap<object, Carried>();
const carriedFor = (key: object): Carried => {
  let c = carried.get(key);
  if (!c) carried.set(key, (c = {}));
  return c;
};

/** The visit id this file put in the store's one slot, for whichever result it made it for. */
let mirroredVisit: string | null = null;

/**
 * The visit already made for this result (a figure, or a held model's file), or null: what a retry
 * fills instead of making a second one. The store has ONE slot for it (measureStore().visitId) and
 * two results can be on the phone at once (a model held, a figure open), so a visit this file made
 * for one result is never handed to the other: the other's patch would replace what the first had
 * saved on it. A visit in the slot that this file did not put there is taken as it stands.
 */
export function visitMadeFor(key: object | null | undefined): string | null {
  if (!key) return null;
  const mine = carried.get(key)?.visitId;
  if (mine) return mine;
  const stored = measureStore().visitId;
  if (!stored) return null;
  return stored === mirroredVisit ? null : stored;
}

/** A visit was made for this result (or is being filled again): kept with the result, and in the
 *  store's slot when the result is still the one on the table. */
function rememberVisit(key: object, visitId: string, current: boolean) {
  carriedFor(key).visitId = visitId;
  if (!current) return;
  // The slot stays the held model's while the model has a visit of its own; a figure's stays here.
  const s = measureStore();
  const theirs = s.held && s.held.model !== key ? carried.get(s.held.model)?.visitId : undefined;
  if (theirs && s.visitId === theirs) return;
  mirroredVisit = visitId;
  if (s.visitId !== visitId) rememberMeasureVisit(visitId);
}

/** The visit took its result, or its result went somewhere else: it is nobody's to fill now. The
 *  file under it is NOT touched here (when the patch landed, the visit points at it). */
function forgetVisit(key: object, visitId: string) {
  const c = carried.get(key);
  if (c) {
    delete c.visitId;
    delete c.visitUpload;
  }
  if (mirroredVisit === visitId) mirroredVisit = null;
  if (measureStore().visitId === visitId) rememberMeasureVisit(null);
}

/**
 * THE RESULT WENT TO A VISIT SOME OTHER WAY (Save to This Visit: the Inspector took the model). The
 * visit a try at Start an Inspection with It made for it is nobody's to fill now: when the Inspector
 * hands the model back, a Try Again must start over, never fill that visit behind his back. A file
 * that try left under the visit is not touched (the visit may list it, and the Inspector's own send
 * may not have landed yet): at worst a copy nothing points at stays in storage.
 */
export function forgetMeasureVisitOf(key: object | null | undefined): void {
  const made = key ? carried.get(key)?.visitId : undefined;
  if (key && made) forgetVisit(key, made);
  // The store's one slot too, whoever put it there: the result it was kept for has gone.
  if (measureStore().visitId) rememberMeasureVisit(null);
}

/** The figure the sheet is showing is still this one. */
const showing = (figure: MeasureFigure): boolean => {
  const open = measureStore().open;
  return open?.kind === "figure" && open.figure === figure;
};
/** The model the + is holding is still this one. */
const holding = (model: File): boolean => measureStore().held?.model === model;

// ── STORAGE ────────────────────────────────────────────────────────────────────────────────────

const BUCKET = "documents";

/** Take a file back out of storage. Best effort: with no signal it stays, and no row points at it. */
async function removeUploaded(path: string): Promise<void> {
  try {
    await createClient().storage.from(BUCKET).remove([path]);
  } catch {
    // it stays
  }
}

/**
 * THE ROWS THE VISIT HOLDS NOW, so a figure's row is added to them and never replaces them. Read on
 * the visit's own id and the company's, through his own session. Null when it could not be read: a
 * failed read is never taken for an empty visit (sending one row as the whole list would wipe the
 * rest), and the save says so instead.
 */
async function storedMeasures(orgId: string, visitId: string): Promise<CaptureMeasure[] | null> {
  try {
    const { data, error } = await createClient().from("appointments").select("capture").eq("org_id", orgId).eq("id", visitId).maybeSingle();
    if (error || !data) return null;
    return parseInspectorCapture((data as { capture?: unknown }).capture ?? null).measures ?? [];
  } catch {
    return null;
  }
}

/**
 * IS THE JOB'S PAPER ROW FOR THIS FILE ALREADY DOWN? Asked of the job before the row is written a
 * second time (Finish Saving) and before the file is taken back out (a discard). True, false, or
 * null when it could not be read: null is never taken for "no". The company is named on the read
 * (a job's file lives at <company>/<job>/…, so its path says whose it is).
 */
async function paperIsFiled(up: { jobId: string; path: string }): Promise<boolean | null> {
  try {
    const orgId = up.path.split("/")[0] ?? "";
    const { data, error } = await createClient().from("documents").select("id").eq("org_id", orgId).eq("job_id", up.jobId).eq("file_url", up.path).limit(1);
    if (error) return null;
    return Array.isArray(data) && data.length > 0;
  } catch {
    return null;
  }
}

/**
 * A file that went up under a visit whose patch did not answer, once its result is saved somewhere
 * else or discarded. It goes through the visit's OWN door first (removeInspectionPhoto takes the
 * path off the visit's list and deletes a file that was on it), because a patch whose answer was
 * lost may have landed, and a visit must never be left pointing at a file that is gone. Only when
 * that door has answered is a file the visit never listed removed directly.
 */
async function sweepVisitUpload(key: object): Promise<void> {
  const c = carried.get(key);
  const up = c?.visitUpload;
  if (!c || !up) return;
  delete c.visitUpload;
  let off = false;
  try {
    off = (await removeInspectionPhoto(up.visitId, up.path))?.ok === true;
  } catch {
    off = false;
  }
  if (off) await removeUploaded(up.path);
}

// ── ONE SAVE OF A MODEL AT A TIME ──────────────────────────────────────────────────────────────

type Trip = { door: SaveDoor; model: File; abandoned: boolean; done: Promise<MeasureSaved> };
let trip: Trip | null = null;

/** The save of the held model that is on its way right now, for a sheet opened in the middle of it. */
export function modelTrip(): { door: SaveDoor; done: Promise<MeasureSaved> } | null {
  return trip ? { door: trip.door, done: trip.done } : null;
}

const stopped = (door: SaveDoor): MeasureSaved => ({ ok: false, door, error: null, final: false });

/** Start a model's save, or join the one already going FOR THIS MODEL (whatever door that one was
 *  for: its answer names its own door). A trip still running for a model he has since discarded is
 *  not this one's to join: its answer is a quiet stop, and a tap must never end in nothing. */
function oneTrip(door: SaveDoor, model: File, run: (mine: { abandoned: boolean }) => Promise<MeasureSaved>): Promise<MeasureSaved> {
  if (trip && trip.model === model) return trip.done;
  const mine: Trip = { door, model, abandoned: false, done: Promise.resolve(stopped(door)) };
  trip = mine;
  mine.done = run(mine).finally(() => {
    if (trip === mine) trip = null;
  });
  return mine.done;
}

// ── A FIGURE, TO A JOB'S PHOTOS ────────────────────────────────────────────────────────────────

/**
 * The figure's picture, with the figure drawn on it and in its name, filed in the job's Photos
 * through the Photos tab's own pipeline. A figure whose picture did not come back has nothing to
 * file there, and says so.
 */
export async function saveMeasureToJob(o: { orgId: string; jobId: string; figure: MeasureFigure; words: SaveWords }): Promise<MeasureSaved> {
  const { figure, words: w } = o;
  if (!figure.photo) return { ok: false, door: "job", error: w.t("sh_measure_noPicture"), final: true };
  const record = measureRecord(w.en, figure);
  const drawn = await stampFigure(figure.photo, figure.caption, record.label);
  // The stamp hands back the very file it was given when it could not draw on it.
  const stamped = drawn !== figure.photo;
  const file = new File([drawn], record.name, { type: drawn.type || "image/jpeg" });
  try {
    const filed = await uploadJobPhotos(o.orgId, o.jobId, [file]);
    // Read back what the door answered: one photo in, one path out, or it was not saved.
    if (filed.length !== 1) throw new Error("");
  } catch (e) {
    const r = uploadRefusal(e, { what: w.t("vi_theFile"), bytes: file.size, action: w.t("vi_sendSmallerFile") }, w.lang, w.t);
    return { ok: false, door: "job", error: r.sentence, final: r.final };
  }
  // A picture an earlier try at a new inspection left under a visit is nobody's now.
  void sweepVisitUpload(figure);
  const made = carried.get(figure)?.visitId;
  if (made) forgetVisit(figure, made);
  if (showing(figure)) clearMeasureFigure();
  return { ok: true, door: "job", stamped };
}

// ── A MODEL, TO A JOB'S PAPERS ─────────────────────────────────────────────────────────────────

/**
 * The held model to the job's folder, then the job's paper row (filed "Other", as the Inspector's
 * own copy to a job is), THEN the phone's copy goes and the + lets go: never the discard before the
 * row has landed. A model whose file is already up on this job (the row is owed) writes the row alone.
 */
export function saveModelToJob(o: { orgId: string; jobId: string; words: SaveWords }): Promise<MeasureSaved> {
  const held = measureStore().held;
  if (!held) return Promise.resolve(stopped("job"));
  return oneTrip("job", held.model, (mine) => modelToJob(held, mine, o.words, { orgId: o.orgId, jobId: o.jobId }));
}

/** Finish Saving: the file is up on its job, and this writes the row alone. Never an upload. */
export function finishSavingModel(o: { words: SaveWords }): Promise<MeasureSaved> {
  const held = measureStore().held;
  if (!held?.landed) return Promise.resolve(stopped("job"));
  return oneTrip("job", held.model, (mine) => modelToJob(held, mine, o.words, null));
}

async function modelToJob(held: HeldModel, mine: { abandoned: boolean }, w: SaveWords, to: { orgId: string; jobId: string } | null): Promise<MeasureSaved> {
  const { model } = held;
  let up = held.landed;
  // Up on one job and asked to go to another: the one door is Finish Saving, on the job that has it.
  if (up && to && up.jobId !== to.jobId) return { ok: false, door: "job", error: w.t("sh_measure_rowOwed"), final: false };

  let landed = false;
  if (up) {
    // The row was owed. The last try's answer may only have been lost: ask before writing a twin.
    landed = (await paperIsFiled(up)) === true;
  } else {
    if (!to) return stopped("job");
    // THE FILE, as it came: a model is never re-encoded.
    const path = jobFilePath(to.orgId, to.jobId, model.name);
    try {
      const { error } = await createClient().storage.from(BUCKET).upload(path, model, { upsert: false });
      if (error) throw error;
    } catch (e) {
      // Nothing is up, so nothing is owed: the same tap sends it again.
      const r = uploadRefusal(e, { what: w.t("vi_the3dModel"), bytes: model.size, action: w.t("vi_scanSmallerArea") }, w.lang, w.t);
      return { ok: false, door: "job", error: r.sentence, final: r.final };
    }
    up = { jobId: to.jobId, path, name: model.name };
    if (mine.abandoned) {
      // He discarded it while it was going up: what went up comes back out, and no row is written.
      await removeUploaded(path);
      return stopped("job");
    }
  }

  // THE ROW that makes the file a paper on the job.
  let refused: string | null = null;
  /** The row THIS save wrote (not one an earlier try had already put down). */
  let wrote: string | null = null;
  if (!landed) {
    // He discarded it while the row was still owed: the discard takes the file out, and no row is written.
    if (mine.abandoned) return stopped("job");
    try {
      const r = await addDocument({ job_id: up.jobId, name: up.name, category: "Other", file_url: up.path, size_bytes: model.size });
      if (r?.ok) {
        landed = true;
        wrote = r.id ?? null;
      } else refused = r?.error ?? null;
    } catch {
      // The connection dropped mid-save: what the sheet says is that the row is owed.
    }
  }
  if (!landed) {
    // The file is safe in storage and the phone still holds its copy. The next tap writes the row.
    if (holding(model)) patchHeldModel({ landed: up });
    return { ok: false, door: "job", error: refused, final: false };
  }

  if (mine.abandoned) {
    // HE DISCARDED IT WHILE THE ROW WAS BEING WRITTEN (the + menu's Discard, with this sheet closed on
    // a slow save). The + has let go and the phone's copy is gone, and the discard, finding no row
    // yet, may have taken the file back out: the row that has just landed would be a paper that
    // opens nothing. It comes back out through the job's own door, which takes the file it points at
    // with it. A row an EARLIER try had already put down stays: that model was saved there.
    if (wrote) {
      try {
        await deleteDocument(wrote, null, up.jobId);
      } catch {
        // it stays on the job's papers, where he can delete it
      }
    }
    return stopped("job");
  }

  // ONLY NOW, with the row down, does the phone's copy go; then the + lets go.
  await discardScan(held.path);
  if (holding(model)) releaseHeldModel();
  // A copy an earlier try at a new inspection left under a visit is nobody's now.
  void sweepVisitUpload(model);
  const made = carried.get(model)?.visitId;
  if (made) forgetVisit(model, made);
  return { ok: true, door: "job" };
}

// ── EITHER, TO A NEW INSPECTION ────────────────────────────────────────────────────────────────

/**
 * Start an Inspection with It: the visit (made once), the file under the visit's own folder (sent
 * once), then the file appended to the visit and the patch that adds the rest (never replaces). Hand a `figure` for a length or an area; with none it is the held
 * model. A figure with no picture still goes, as its typed row.
 */
export function startInspectionWith(o: { orgId: string; figure?: MeasureFigure | null; words: SaveWords }): Promise<MeasureSaved> {
  if (o.figure) return inspectionWith(o.orgId, o.words, { kind: "figure", figure: o.figure }, null);
  const held = measureStore().held;
  if (!held) return Promise.resolve(stopped("inspection"));
  // Its file is already on a job and only that job's row is owed: Finish Saving is the one door.
  if (held.landed) return Promise.resolve({ ok: false, door: "inspection", error: o.words.t("sh_measure_rowOwed"), final: false });
  return oneTrip("inspection", held.model, (mine) => inspectionWith(o.orgId, o.words, { kind: "model", held }, mine));
}

async function inspectionWith(
  orgId: string,
  w: SaveWords,
  what: { kind: "figure"; figure: MeasureFigure } | { kind: "model"; held: HeldModel },
  mine: { abandoned: boolean } | null,
): Promise<MeasureSaved> {
  const fail = (error: string | null, final = false): MeasureSaved => ({ ok: false, door: "inspection", error, final });
  const key: object = what.kind === "figure" ? what.figure : what.held.model;
  const current = () => (what.kind === "figure" ? showing(what.figure) : holding(what.held.model));
  const mem = carriedFor(key);

  // 1. THE VISIT: the one a first try made for this result, else a new one. Never a second.
  let visitId = visitMadeFor(key);
  if (!visitId) {
    try {
      const made = await createInspectionNow();
      if (!made?.ok || !made.id) return fail(made?.error ?? w.t("sh_checkSignal"));
      visitId = made.id;
    } catch {
      return fail(w.t("sh_checkSignal"));
    }
  }
  rememberVisit(key, visitId, current());
  if (mine?.abandoned) return fail(null);

  // 2. THE FILE, under the visit's folder exactly as the Inspector's own upload puts it: a picture
  //    through the downscale every photo gets, a model untouched. One already up is not sent again.
  const file = what.kind === "figure" ? what.figure.photo : what.held.model;
  let path = mem.visitUpload?.visitId === visitId ? mem.visitUpload.path : null;
  if (file && !path) {
    let sending = file;
    try {
      if (file.type.startsWith("image/")) sending = await prepareImageForUpload(file);
      const safe = sending.name.replace(/[^a-zA-Z0-9._-]/g, "_");
      const at = `${orgId}/appointments/${visitId}/${Date.now()}-${safe}`;
      const { error } = await createClient().storage.from(BUCKET).upload(at, sending, { upsert: false });
      if (error) throw error;
      path = at;
      mem.visitUpload = { visitId, path };
    } catch (e) {
      const model = what.kind === "model";
      const r = uploadRefusal(
        e,
        { what: w.t(model ? "vi_the3dModel" : "vi_theFile"), bytes: sending.size, action: w.t(model ? "vi_scanSmallerArea" : "vi_sendSmallerFile") },
        w.lang,
        w.t,
      );
      return fail(r.sentence, r.final);
    }
  }
  if (mine?.abandoned) {
    await sweepVisitUpload(key);
    return fail(null);
  }

  // 3. ADDED TO THE VISIT, NEVER REPLACING WHAT IS ON IT. The visit may not be empty by now (he
  //    opened it after a failed try and took photos; a late answer lands after he went to it), and a
  //    patch that names a whole section replaces the stored one. So a figure's row joins the rows the
  //    visit holds as read just now (a visit at its cap is said, never cut); the file goes on through
  //    the visit's own append; and only its placement rides the patch, as one key.
  let stored: CaptureMeasure[] = [];
  if (what.kind === "figure") {
    if (!mem.rowId) mem.rowId = captureId();
    const now = await storedMeasures(orgId, visitId);
    if (!now) return fail(w.t("sh_checkSignal"));
    if (!now.some((m) => m.id === mem.rowId) && now.length >= MAX_MEASURES) return fail(w.t("vi_measuresFull").replace("{n}", String(MAX_MEASURES)));
    stored = now;
  }
  if (path) {
    try {
      const r = await addInspectionPhotos(visitId, [path]);
      if (!r?.ok) return fail(r?.error ?? w.t("sh_checkSignal"));
    } catch {
      return fail(w.t("sh_checkSignal"));
    }
  }
  const patch = inspectionPatch(w.en, what.kind === "figure" ? { kind: "figure", figure: what.figure, rowId: mem.rowId ?? captureId() } : { kind: "model" }, path, stored);
  if (Object.keys(patch).length) {
    try {
      const r = await saveInspectionCapture(visitId, patch);
      if (!r?.ok) return fail(r?.error ?? w.t("sh_checkSignal"));
    } catch {
      return fail(w.t("sh_checkSignal"));
    }
  }

  // 4. IT IS ON THE VISIT. The visit has something stored now, so it is never filled a second time;
  //    and only now does a model's copy on the phone go.
  forgetVisit(key, visitId);
  if (mine?.abandoned) {
    // HE DISCARDED IT WHILE THE VISIT WAS TAKING IT. The discard swept the file as one the visit had
    // not listed; the append that has since landed lists it. It comes back off the visit through the
    // visit's own door, so the visit is never left pointing at a file that is gone.
    if (path) {
      try {
        await removeInspectionPhoto(visitId, path);
      } catch {
        // the visit keeps a tile he can remove on the visit
      }
    }
    return fail(null);
  }
  if (what.kind === "model") {
    await discardScan(what.held.path);
    if (holding(what.held.model)) releaseHeldModel();
  } else if (showing(what.figure)) clearMeasureFigure();
  return { ok: true, door: "inspection", visitId };
}

// ── NOT KEEPING IT ─────────────────────────────────────────────────────────────────────────────

/**
 * He discarded the held model. A save still on its way for it is told to stop; anything of it in
 * storage that nothing points at comes back out (its file on a job whose row is owed, or under a
 * visit whose patch never landed); then the + lets go and the phone's copy goes. A file the job
 * turns out to have a paper for is left where it is: that model is saved there.
 *
 * A save that was told to stop reads that at each step, the last one included: a row or a patch
 * that lands AFTER the discard is taken back out by the save itself (modelToJob, inspectionWith),
 * so a discard never leaves a paper or a visit pointing at a file that is gone.
 */
export async function discardModel(): Promise<void> {
  const held = measureStore().held;
  if (held) {
    if (trip && trip.model === held.model) trip.abandoned = true;
    if (held.landed && (await paperIsFiled(held.landed)) === false) await removeUploaded(held.landed.path);
    await sweepVisitUpload(held.model);
  }
  await dropHeldModel();
}

/**
 * A figure was not kept (the sheet closed on it). Nothing of a figure is held, but a try at Start an
 * Inspection with It may have put its picture under a visit before the patch failed: that file goes.
 * The visit itself stays (he was told it was started).
 */
export async function forgetFigure(figure: MeasureFigure): Promise<void> {
  await sweepVisitUpload(figure);
}

/** Test seam: this file's own memory back to its start. Never called by the app. */
export function resetMeasureSavesForTest(): void {
  trip = null;
  mirroredVisit = null;
}
