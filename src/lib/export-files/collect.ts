/**
 * WHICH FILES GO IN A ZIP (cn-v1138, the owner's "Your Data" door).
 *
 * Pure. The routes read the pointer rows and walk the storage folders; this turns them into REFS —
 * bucket, path, the entry's name inside the zip, and the size when a listing or a row knew it — so
 * that no two refs point at one object and no two entries are named alike.
 *
 * A POINTER IS A PATH, NEVER A URL: documents.file_url, tasks.photo_path, job_picks.file_path and a
 * visit's capture.photos all hold `<org>/…` keys on the documents bucket. A value that is not under
 * THIS company's prefix (another company's key, an old absolute URL, a ".." segment) is left out: a
 * company's zip can only ever hold the company's own objects, whatever a row says.
 *
 * ENTRY NAMES: a documents row names its file (the name the person uploaded it under); anything else
 * is named by the key's last segment with the upload stamp taken off ("1727…-panel.jpg" is
 * "panel.jpg"). A second file of the same name gets " (2)" before its extension, a third " (3)", and
 * names are compared case-insensitively because the unzipped folder lands on a Mac or Windows disk
 * where "Panel.jpg" and "panel.jpg" are one file.
 *
 * THE CAP is judged on KNOWN sizes only: a pointer with no size is not a reason to refuse; the
 * packer keeps its own running count while it downloads (pack.ts).
 */
export const FILES_CAP_BYTES = 400 * 1024 * 1024;
/** The zip format's own ceiling on entries (zip-write refuses more, so we refuse first, in words). */
export const FILES_CAP_COUNT = 65_535;

export type FileRef = { bucket: string; path: string; name: string; size: number | null };

/** A listed file with its whole key, as list.ts hands it over. */
export type ListedFile = { path: string; size: number | null };

/** True when `raw` is a storage key under this company's own prefix: no URL, no "..", no empty tail. */
export function isOwnPath(orgId: string, raw: unknown): raw is string {
  if (typeof raw !== "string") return false;
  const s = raw.trim();
  if (!s || /^[a-z]+:\/\//i.test(s) || s.startsWith("/")) return false;
  if (!s.startsWith(`${orgId}/`)) return false;
  const parts = s.split("/");
  if (parts.some((p) => p === "" || p === "..")) return false;
  return parts.length >= 2;
}

/** A visit's photo keys, whichever shape the capture holds them in (a list of keys, or of {path}). */
export function capturePhotoPaths(capture: unknown): string[] {
  const photos = (capture as { photos?: unknown } | null)?.photos;
  if (!Array.isArray(photos)) return [];
  return photos
    .map((p) => (typeof p === "string" ? p : typeof p === "object" && p !== null ? (p as { path?: unknown }).path : null))
    .filter((p): p is string => typeof p === "string" && !!p.trim())
    .map((p) => p.trim());
}

/**
 * EVERY FILE AN INSPECTION SHEET HOLDS. appointments.inspection_answers is one flat object keyed by
 * the sheet's slot keys (lib/playbook); a FILE slot's value is a list of storage keys the inspector
 * wrote under `<org>/appointments/<id>/` (appointments/[id]/inspector.tsx, the same shape the public
 * intake door stores). Every other slot is a word, a number, a list of words or a task's object, so
 * a value is a file only when it is a key under THIS company's prefix: a bare string, each string of
 * a list, or a {path} / {paths: […]} the way a capture holds photos. Defensive on purpose — a slot
 * that is not a file never becomes a pointer, and a stranger's key never does.
 */
export function inspectionAnswerPaths(orgId: string, answers: unknown): string[] {
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const take = (v: unknown) => {
    if (!isOwnPath(orgId, v)) return;
    const key = v.trim();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(key);
  };
  const look = (v: unknown) => {
    if (typeof v === "string") return take(v);
    if (Array.isArray(v)) return v.forEach(look);
    if (v && typeof v === "object") {
      const o = v as { path?: unknown; paths?: unknown };
      if (typeof o.path === "string") take(o.path);
      if (Array.isArray(o.paths)) o.paths.forEach(look);
    }
  };
  for (const v of Object.values(answers as Record<string, unknown>)) look(v);
  return out;
}

const basename = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

/** What a key's last segment is called once the upload's millisecond stamp comes off. */
export function nameFromKey(path: string): string {
  const base = basename(path);
  const unstamped = base.replace(/^\d{10,}-/, "");
  return unstamped || base;
}

/** A name a person typed, made safe as one zip entry segment: no slashes (they would be folders),
 *  none of the characters Windows refuses in a file name (< > : " | ? *), no control characters;
 *  empty falls back to the key's own name. */
export function entrySegment(raw: string | null | undefined, path: string): string {
  const typed = String(raw ?? "")
    .replace(/[\\/]/g, "-")
    .replace(/[<>:"|?*]/g, "")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "");
  return typed || nameFromKey(path);
}

/** A row's name for its file, when the row names a file it carries an extension for and the typed
 *  name has none: "Driver license" + "…-scan.pdf" → "Driver license.pdf". */
export function nameWithExtension(typed: string | null | undefined, path: string): string {
  const seg = entrySegment(typed, path);
  const keyName = nameFromKey(path);
  const ext = /\.[A-Za-z0-9]{1,8}$/.exec(keyName)?.[0] ?? "";
  if (ext && !/\.[A-Za-z0-9]{1,8}$/.test(seg)) return `${seg}${ext}`;
  return seg;
}

/** Every entry name made unique, case-insensitively: a repeat gets " (2)", " (3)", … before the
 *  extension of its last segment. Order kept. */
export function uniqueNames<T extends { name: string }>(refs: readonly T[]): T[] {
  const taken = new Set<string>();
  const out: T[] = [];
  for (const r of refs) {
    let name = r.name;
    if (taken.has(name.toLowerCase())) {
      const slash = name.lastIndexOf("/");
      const dir = slash >= 0 ? name.slice(0, slash + 1) : "";
      const last = slash >= 0 ? name.slice(slash + 1) : name;
      const dot = last.lastIndexOf(".");
      const ext = dot > 0 ? last.slice(dot) : "";
      // A stem that already carries " (n)" is suffixed on its base, never "panel (2) (2)".
      const stem = (dot > 0 ? last.slice(0, dot) : last).replace(/ \(\d+\)$/, "");
      for (let n = 2; ; n++) {
        const next = `${dir}${stem} (${n})${ext}`;
        if (!taken.has(next.toLowerCase())) {
          name = next;
          break;
        }
      }
    }
    taken.add(name.toLowerCase());
    out.push(name === r.name ? r : { ...r, name });
  }
  return out;
}

/** Refs with no two on one object: the first mention of a bucket + path wins (its name, its size),
 *  though a later mention fills in a size the first did not know. */
export function dedupeRefs(refs: readonly FileRef[]): FileRef[] {
  const byKey = new Map<string, FileRef>();
  for (const r of refs) {
    const key = `${r.bucket}\u0000${r.path}`;
    const had = byKey.get(key);
    if (!had) byKey.set(key, { ...r });
    else if (had.size == null && r.size != null) had.size = r.size;
  }
  return Array.from(byKey.values());
}

/** What is known of the sizes, summed; a ref with no size counts nothing. */
export function knownBytes(refs: readonly FileRef[]): number {
  return refs.reduce((s, r) => s + (r.size != null && Number.isFinite(r.size) && r.size > 0 ? r.size : 0), 0);
}

/** True when the KNOWN sizes already pass the cap, or there are more entries than one zip can hold. */
export function overCap(refs: readonly FileRef[]): boolean {
  return refs.length > FILES_CAP_COUNT || knownBytes(refs) > FILES_CAP_BYTES;
}

/**
 * ONE JOB'S FILES: its documents rows (named by the row), its own folder on the documents bucket
 * (what was uploaded there, named or not), its tasks' photos, its visits' photos and sheet files
 * (and everything in each visit's folder, named or not), and its picks' pictures. Entries are
 * flat: `<name>`.
 */
export function jobFileRefs(p: {
  orgId: string;
  jobId: string;
  documents: readonly { name?: string | null; file_url?: string | null; size_bytes?: number | null }[];
  picks: readonly { file_path?: string | null }[];
  tasks: readonly { photo_path?: string | null; done_photo_path?: string | null }[];
  appointments: readonly { capture?: unknown; inspection_answers?: unknown }[];
  /** The job's own folder (`<org>/<job>/`) on the documents bucket, walked. */
  listing: readonly ListedFile[];
  /** Each of the job's visits' folders (`<org>/appointments/<visit>/`) on the documents bucket, walked. */
  visits?: readonly ListedFile[];
}): FileRef[] {
  const { orgId } = p;
  const refs: FileRef[] = [];
  const own = (path: unknown): path is string => isOwnPath(orgId, path);

  for (const d of p.documents) {
    if (!own(d.file_url)) continue;
    const path = d.file_url.trim();
    const size = typeof d.size_bytes === "number" && d.size_bytes > 0 ? d.size_bytes : null;
    refs.push({ bucket: "documents", path, name: nameWithExtension(d.name, path), size });
  }
  for (const f of p.listing) {
    if (!own(f.path)) continue;
    refs.push({ bucket: "documents", path: f.path.trim(), name: nameFromKey(f.path), size: f.size });
  }
  for (const t of p.tasks) {
    for (const path of [t.photo_path, t.done_photo_path]) {
      if (own(path)) refs.push({ bucket: "documents", path: path.trim(), name: nameFromKey(path), size: null });
    }
  }
  for (const a of p.appointments) {
    for (const path of capturePhotoPaths(a.capture)) {
      if (own(path)) refs.push({ bucket: "documents", path, name: nameFromKey(path), size: null });
    }
    for (const path of inspectionAnswerPaths(orgId, a.inspection_answers)) refs.push({ bucket: "documents", path, name: nameFromKey(path), size: null });
  }
  for (const f of p.visits ?? []) {
    if (!own(f.path)) continue;
    refs.push({ bucket: "documents", path: f.path.trim(), name: nameFromKey(f.path), size: f.size });
  }
  for (const k of p.picks) {
    if (own(k.file_path)) refs.push({ bucket: "documents", path: k.file_path.trim(), name: nameFromKey(k.file_path), size: null });
  }
  return uniqueNames(dedupeRefs(refs));
}

/** The folders the company zip is sorted into: `<folder>/<name>`. */
export const COMPANY_FOLDERS = {
  employees: "Employees",
  insurance: "Insurance",
  organize: "Organized",
  intake: "Intake",
  visits: "Visits",
  branding: "Branding",
  avatars: "Branding/Avatars",
  leads: "Lead Uploads",
} as const;

/** The person's folder under Employees: their name when the roster knows the id, else the id's first
 *  eight characters (never a 36-character folder). */
function personFolder(profileId: string | null | undefined, people: ReadonlyMap<string, string>): string {
  const id = String(profileId ?? "").trim();
  const known = id ? people.get(id) : undefined;
  if (known) return known;
  return id ? id.slice(0, 8) : "Unknown";
}

/**
 * THE COMPANY'S OWN FILES: the crew's documents (one folder per person), the insurance papers, what
 * Organize My filed, what leads sent through the intake form, every visit's photos and sheet files
 * (Visits/<visit id>/ — every visit, a lead's as much as a job's, so no visit is missed; a job's
 * zip carries its own visits too), the logo / portfolio / avatars, and what the site chat's leads
 * uploaded. Entries are `<folder>/<name>`.
 *
 * Each listing is a walk of the folder; the rows are the names and a belt against a capped walk (a
 * file a row points at is in even when the walk missed it).
 */
export function companyFileRefs(p: {
  orgId: string;
  employeeDocs: readonly { profile_id?: string | null; name?: string | null; file_url?: string | null }[];
  people: readonly { id: string; full_name?: string | null }[];
  organized: readonly { title?: string | null; file_url?: string | null }[];
  listings: {
    /** documents `<org>/employees/<profile>/…` */
    employees: readonly ListedFile[];
    /** documents `<org>/insurance/…` */
    insurance: readonly ListedFile[];
    /** documents `<org>/organize/…` */
    organize: readonly ListedFile[];
    /** intake-uploads `<org>/intake/…` */
    intake: readonly ListedFile[];
    /** documents `<org>/appointments/<visit>/…` (the inspector's photos and sheet files) */
    appointments: readonly ListedFile[];
    /** branding `<org>/…` (logo-*, portfolio-*, avatars/*) */
    branding: readonly ListedFile[];
    /** lead-uploads `<org>/…` */
    leads: readonly ListedFile[];
  };
}): FileRef[] {
  const { orgId } = p;
  const own = (path: unknown): path is string => isOwnPath(orgId, path);
  const people = new Map<string, string>();
  for (const person of p.people) {
    const name = entrySegment(person.full_name, "");
    if (person.id && name && name !== "Unknown") people.set(person.id, name);
  }
  const docName = new Map<string, string>();
  for (const d of p.employeeDocs) if (own(d.file_url) && String(d.name ?? "").trim()) docName.set(d.file_url.trim(), nameWithExtension(d.name, d.file_url));
  const orgName = new Map<string, string>();
  for (const o of p.organized) if (own(o.file_url) && String(o.title ?? "").trim()) orgName.set(o.file_url.trim(), nameWithExtension(o.title, o.file_url));

  const refs: FileRef[] = [];
  const add = (bucket: string, path: string, folder: string, name: string, size: number | null) =>
    refs.push({ bucket, path, name: `${folder}/${name}`, size });

  // Employees: `<org>/employees/<profile>/<file>` → Employees/<Person>/<name>.
  const employeeFolder = (path: string) => `${COMPANY_FOLDERS.employees}/${personFolder(path.split("/")[2], people)}`;
  for (const d of p.employeeDocs) {
    if (!own(d.file_url)) continue;
    const path = d.file_url.trim();
    const folder = `${COMPANY_FOLDERS.employees}/${personFolder(d.profile_id ?? path.split("/")[2], people)}`;
    add("documents", path, folder, docName.get(path) ?? nameFromKey(path), null);
  }
  for (const f of p.listings.employees) {
    if (!own(f.path)) continue;
    const path = f.path.trim();
    add("documents", path, employeeFolder(path), docName.get(path) ?? nameFromKey(path), f.size);
  }
  for (const f of p.listings.insurance) {
    if (own(f.path)) add("documents", f.path.trim(), COMPANY_FOLDERS.insurance, nameFromKey(f.path), f.size);
  }
  for (const o of p.organized) {
    if (!own(o.file_url)) continue;
    const path = o.file_url.trim();
    add("documents", path, COMPANY_FOLDERS.organize, orgName.get(path) ?? nameFromKey(path), null);
  }
  for (const f of p.listings.organize) {
    if (!own(f.path)) continue;
    const path = f.path.trim();
    add("documents", path, COMPANY_FOLDERS.organize, orgName.get(path) ?? nameFromKey(path), f.size);
  }
  for (const f of p.listings.intake) {
    if (own(f.path)) add("intake-uploads", f.path.trim(), COMPANY_FOLDERS.intake, nameFromKey(f.path), f.size);
  }
  // Visits: `<org>/appointments/<visit>/<file>` → Visits/<visit>/<name>; a file straight under the
  // appointments folder (no visit segment) lands in Visits/ itself.
  for (const f of p.listings.appointments) {
    if (!own(f.path)) continue;
    const path = f.path.trim();
    const parts = path.split("/");
    const visit = parts.length >= 4 ? parts[2] : "";
    add("documents", path, visit ? `${COMPANY_FOLDERS.visits}/${visit}` : COMPANY_FOLDERS.visits, nameFromKey(path), f.size);
  }
  for (const f of p.listings.branding) {
    if (!own(f.path)) continue;
    const path = f.path.trim();
    const folder = path.split("/")[1] === "avatars" ? COMPANY_FOLDERS.avatars : COMPANY_FOLDERS.branding;
    add("branding", path, folder, nameFromKey(path), f.size);
  }
  for (const f of p.listings.leads) {
    if (own(f.path)) add("lead-uploads", f.path.trim(), COMPANY_FOLDERS.leads, nameFromKey(f.path), f.size);
  }
  return uniqueNames(dedupeRefs(refs));
}
