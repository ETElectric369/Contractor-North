/**
 * WHAT THE OFFICE TYPES FOR THE CUSTOMER'S PAGE, CHECKED BEFORE IT IS SAVED: the stretches of work
 * and the saved picks. Pure, so the rules are tested once and every door (the job page editor,
 * later Nort) says no in the same plain words.
 *
 * The database holds the same rules as CHECKs (0300), so nothing here is the only guard; this is
 * where the sentence comes from. Every patch is an allowlist of fields: a request carrying
 * org_id, job_id, removed_at or anything else is read for the fields named here and nothing more.
 */
import { isJobPhotoPath, isPickPath } from "./job-view-shape";
import {
  COMPANY_PAPER_CATEGORIES,
  categoryIsShowable,
  defaultKindFor,
  docFormat,
  isPortalDocKind,
  titleFromName,
  type PortalDocKind,
} from "./doc-kinds";

/** The one sentence every door says when a photo is not in its job's own folder (setPhotoShared,
 *  the Photos tab, and 0300's trigger in the same words). */
export const PHOTO_NOT_IN_JOB_FOLDER = "Only photos taken or uploaded on this job can be shown to the customer.";

/** The categories the editor offers first. Any other a person types is fine. */
export const PICK_CATEGORIES = [
  "Paint Color",
  "Faceplate Color",
  "Fixture",
  "Switch And Outlet",
  "Hardware",
  "Tile",
  "Flooring",
  "Appliance",
] as const;

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const HEX = /^#[0-9a-f]{6}$/i;

type Fail = { ok: false; error: string };
type Ok<T> = { ok: true; value: T };

const clean = (v: unknown, max: number): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/\s+/g, " ").trim();
  return s ? s.slice(0, max) : null;
};
const cleanNote = (v: unknown, max: number): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
};
function isRealDay(ymd: string): boolean {
  if (!YMD.test(ymd)) return false;
  const d = new Date(`${ymd}T00:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === ymd;
}

export type StretchFields = { label: string; starts_on: string; ends_on: string; sort?: number };

/**
 * A stretch as typed. On an edit (`current` given) only the fields present in `patch` change, and
 * the dates are checked as the pair they will be after the edit.
 */
export function normalizeStretch(
  patch: { label?: unknown; startsOn?: unknown; endsOn?: unknown; sort?: unknown },
  current?: { label: string; starts_on: string; ends_on: string },
): Ok<Partial<StretchFields>> | Fail {
  const out: Partial<StretchFields> = {};
  if (patch.label !== undefined || !current) {
    const label = clean(patch.label, 80);
    if (!label) return { ok: false, error: "Give the stretch a name, like Rough-in or Trim." };
    out.label = label;
  }
  if (patch.startsOn !== undefined || !current) {
    const s = String(patch.startsOn ?? "");
    if (!isRealDay(s)) return { ok: false, error: "Pick the day the stretch starts." };
    out.starts_on = s;
  }
  if (patch.endsOn !== undefined || !current) {
    // A one-day stretch: no end typed means it ends the day it starts.
    const raw = clean(patch.endsOn, 10) ?? out.starts_on ?? current?.starts_on ?? "";
    if (!isRealDay(raw)) return { ok: false, error: "Pick the day the stretch ends." };
    out.ends_on = raw;
  }
  const starts = out.starts_on ?? current?.starts_on ?? "";
  const ends = out.ends_on ?? current?.ends_on ?? "";
  if (starts && ends && ends < starts) return { ok: false, error: "The stretch ends before it starts. Check the two dates." };
  if (patch.sort !== undefined) {
    const n = Number(patch.sort);
    if (Number.isFinite(n)) out.sort = Math.trunc(n);
  }
  return { ok: true, value: out };
}

export type PickFields = {
  category: string;
  brand: string | null;
  option_id: string | null;
  name: string | null;
  code: string | null;
  location: string | null;
  note: string | null;
  color_hex: string | null;
  link_url: string | null;
  file_path: string | null;
  file_kind: "image" | "pdf" | null;
  sort: number;
};
export type PickPatch = Partial<{
  category: unknown;
  brand: unknown;
  optionId: unknown;
  name: unknown;
  code: unknown;
  location: unknown;
  note: unknown;
  colorHex: unknown;
  linkUrl: unknown;
  filePath: unknown;
  fileKind: unknown;
  sort: unknown;
}>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A pick as typed. New (`isNew`): category is required. Edit: only the fields present change.
 * A file must sit under this job's own <org>/picks/<job>/ (the upload path pickFilePath builds).
 */
export function normalizePick(
  patch: PickPatch,
  where: { orgId: string; jobId: string; isNew: boolean },
): Ok<Partial<PickFields>> | Fail {
  const out: Partial<PickFields> = {};
  const has = (k: keyof PickPatch) => Object.prototype.hasOwnProperty.call(patch, k) && patch[k] !== undefined;

  if (has("category") || where.isNew) {
    const c = clean(patch.category, 60);
    if (!c) return { ok: false, error: "Say what kind of pick this is, like Paint Color or Fixture." };
    out.category = c;
  }
  if (has("brand")) out.brand = clean(patch.brand, 120);
  if (has("name")) out.name = clean(patch.name, 160);
  if (has("code")) out.code = clean(patch.code, 80);
  if (has("location")) out.location = clean(patch.location, 120);
  if (has("note")) out.note = cleanNote(patch.note, 2000);
  if (has("optionId")) {
    const id = patch.optionId === null || patch.optionId === "" ? null : String(patch.optionId);
    if (id !== null && !UUID.test(id)) return { ok: false, error: "That price-book choice isn't one we know." };
    out.option_id = id;
  }
  if (has("colorHex")) {
    const raw = clean(patch.colorHex, 7);
    const hex = raw && !raw.startsWith("#") ? `#${raw}` : raw;
    if (hex && !HEX.test(hex)) return { ok: false, error: "A swatch color is six hex digits, like #F2EFE6." };
    out.color_hex = hex ? hex.toUpperCase() : null;
  }
  if (has("linkUrl")) {
    const u = clean(patch.linkUrl, 2000);
    if (u) {
      let parsed: URL | null = null;
      try {
        parsed = new URL(u);
      } catch {
        parsed = null;
      }
      if (!parsed || parsed.protocol !== "https:" || /\s/.test(u)) {
        return { ok: false, error: "A link has to start with https:// so it opens safely for the customer." };
      }
      out.link_url = parsed.toString();
    } else out.link_url = null;
  }
  if (has("filePath") || has("fileKind")) {
    const path = patch.filePath === null || patch.filePath === "" ? null : String(patch.filePath ?? "");
    if (path === null) {
      out.file_path = null;
      out.file_kind = null;
    } else {
      if (!isPickPath(path, where.orgId, where.jobId)) return { ok: false, error: "That file isn't filed on this job's picks." };
      const kind = patch.fileKind === "image" || patch.fileKind === "pdf" ? patch.fileKind : fileKindFor(path);
      if (!kind) return { ok: false, error: "A pick can hold a picture or a PDF." };
      out.file_path = path;
      out.file_kind = kind;
    }
  }
  if (has("sort")) {
    const n = Number(patch.sort);
    if (Number.isFinite(n)) out.sort = Math.trunc(n);
  }
  return { ok: true, value: out };
}

/** image | pdf from a file name (and its type when the browser gave one); null for anything else. */
export function fileKindFor(name: string, mime?: string | null): "image" | "pdf" | null {
  const m = String(mime ?? "").toLowerCase();
  if (m === "application/pdf") return "pdf";
  if (m.startsWith("image/")) return "image";
  const n = name.toLowerCase();
  if (n.endsWith(".pdf")) return "pdf";
  if (/\.(jpe?g|png|webp|gif|heic|heif|avif)$/.test(n)) return "image";
  return null;
}

/** Where a pick's picture or PDF is uploaded: the office-only <org>/picks/<job>/ prefix (0300). */
export function pickFilePath(orgId: string, jobId: string, fileName: string, now = Date.now()): string {
  const safe = (fileName || "file").replace(/[^a-zA-Z0-9._-]/g, "_").replace(/\.{2,}/g, ".").slice(-80);
  return `${orgId}/picks/${jobId}/${now}-${safe}`;
}

// ── the plans and drawings the office shows (0326) ─────────────────────────────────────────────

/** The one sentence every door says when a paper that is not a photo sits outside its job's
 *  folder (0326's stamp says it in the same words). */
export const PAPER_NOT_IN_JOB_FOLDER = "Only papers uploaded on this job can be shown to the customer.";

/**
 * Why this paper can't go on the customer's page, in the same words as 0326's stamp, or null when
 * it can. The database says all of this again (and also refuses paper that is tied to a bill or a
 * supplier invoice, which only it can see in full); this is where the office's sentence comes from
 * before a round trip.
 */
export function paperRefusal(doc: { category: string | null; file_url: string | null; job_id: string | null }, orgId: string): string | null {
  const cat = String(doc.category ?? "").trim();
  if ((COMPANY_PAPER_CATEGORIES as readonly string[]).includes(cat)) {
    return `A ${cat.toLowerCase()} is the company's own paper and is never shown to the customer.`;
  }
  if (!cat) return "Give this paper a category first (Photo, Plan, Permit or Other). Only those can be shown to the customer.";
  if (!categoryIsShowable(cat)) return `Only a photo, a plan, a permit or another job paper can be shown to the customer, not a ${cat}.`;
  if (!doc.job_id || !doc.file_url) return "That paper is not filed on a job.";
  if (!isJobPhotoPath(doc.file_url, orgId, doc.job_id)) return cat === "Photo" ? PHOTO_NOT_IN_JOB_FOLDER : PAPER_NOT_IN_JOB_FOLDER;
  return null;
}

export type SharedPaperFields = { kind: PortalDocKind; title: string; replaces_document_id: string | null };
export type SharedPaperPatch = Partial<{ kind: unknown; title: unknown; replaces: unknown }>;

/**
 * What the office chose for a paper on the customer's page: its kind, its title and the older
 * paper it replaces. New (`isNew`): kind and title start from the paper when not given. Edit: only
 * the fields sent change. A photo kind is a picture: a PDF shown as a Photo would be a broken tile.
 */
export function normalizeSharedPaper(
  patch: SharedPaperPatch,
  paper: { id: string; name: string | null; category: string | null; file_url: string | null },
  isNew: boolean,
): Ok<Partial<SharedPaperFields>> | Fail {
  const out: Partial<SharedPaperFields> = {};
  const has = (k: keyof SharedPaperPatch) => Object.prototype.hasOwnProperty.call(patch, k) && patch[k] !== undefined;
  if (has("kind") || isNew) {
    const kind = has("kind") ? patch.kind : defaultKindFor(paper.category);
    if (!isPortalDocKind(kind)) {
      return { ok: false, error: "Pick what this paper is: a plan, a circuit map, a drawing, a permit, a rendering, a 3D scan or a document." };
    }
    if (kind === "photo" && docFormat(paper.file_url) !== "image") {
      return { ok: false, error: "Only a picture can show as a photo. Pick Plan, Drawing or Document for this one." };
    }
    out.kind = kind;
  }
  if (has("title") || isNew) {
    const t = clean(patch.title, 120) ?? (isNew ? titleFromName(paper.name) || null : null);
    if (!t) return { ok: false, error: "Give it a title the customer will read, like Circuit Map or Main Floor Plan." };
    out.title = t;
  }
  if (has("replaces")) {
    const r = patch.replaces === null || patch.replaces === "" ? null : String(patch.replaces);
    if (r !== null && !UUID.test(r)) return { ok: false, error: "That older paper isn't one we know." };
    if (r !== null && r === paper.id) return { ok: false, error: "A paper can't replace itself." };
    out.replaces_document_id = r;
  }
  return { ok: true, value: out };
}
