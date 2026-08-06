/**
 * WHAT A STRANGER MAY UPLOAD, and where it lands. Shared by the route that mints the signed slot,
 * the client that fills it, and the action that accepts the finished paths — one allowlist, so
 * they cannot drift into disagreeing about what is safe.
 */

export const INTAKE_BUCKET = "intake-uploads";

/** 100MB — Andrew's number, and a real plan set genuinely is that big. */
export const MAX_UPLOAD_MB = 100;

/**
 * EXTENSIONS, NOT MIME TYPES. A browser reports DWG as image/vnd.dwg, application/acad,
 * application/octet-stream or nothing at all depending on the OS, so a Content-Type allowlist
 * either rejects real drawings or accepts everything. The extension is on the name WE write into
 * the path, so it is the one part of this a caller cannot lie about after the fact.
 */
export const ALLOWED_UPLOAD_EXTS = [
  // plans + drawings
  "pdf", "dwg", "dxf",
  // photos and scans
  "jpg", "jpeg", "png", "webp", "heic", "heif",
] as const;

export const extOf = (name: string): string => {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
};

export const isAllowedUpload = (name: string): boolean =>
  (ALLOWED_UPLOAD_EXTS as readonly string[]).includes(extOf(name));

/** What the file input offers, so the picker filters before a customer waits on an upload. */
export const ACCEPT_ATTR = ALLOWED_UPLOAD_EXTS.map((e) => `.${e}`).join(",");

/**
 * A path is only acceptable if it is inside THIS org's intake folder.
 *
 * The client hands back the paths it uploaded, and a hostile client can hand back any string it
 * likes — including another tenant's folder. This is the write boundary for that: same law as
 * every other one in this codebase, applied where the value crosses.
 */
export const isOwnIntakePath = (orgId: string, path: unknown): boolean =>
  typeof path === "string" && path.startsWith(`${orgId}/intake/`) && !path.includes("..");

/** The human bit of a stored path — the original name we appended when we minted the slot. */
export const uploadDisplayName = (path: string): string => {
  const base = path.split("/").pop() ?? path;
  // `<epoch>-<uuid>-<original name>` — drop the two machine parts, keep what a person recognises.
  const m = base.match(/^\d+-[0-9a-f-]{36}-(.+)$/i);
  return m ? m[1] : base;
};
