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
 * WHAT ONE QUESTION ACCEPTS, and what to tell a customer it accepts.
 *
 * The `file` slot has carried an optional `accept` since it shipped, and the renderer ignored it —
 * so Andrew's "Upload your photos" question offered DWG and DXF and told a homeowner "PDF, DWG,
 * DXF or photos". A question that asks for photos should open the camera roll, not a CAD picker.
 * The org's allowlist is still the ceiling: a need can NARROW it and can never widen it.
 */
export function uploadAccept(accept?: readonly string[] | null): { attr: string; hint: string } {
  const own = (accept ?? [])
    .map((e) => String(e).replace(/^\./, "").toLowerCase())
    .filter((e) => (ALLOWED_UPLOAD_EXTS as readonly string[]).includes(e));
  const exts = own.length ? own : (ALLOWED_UPLOAD_EXTS as readonly string[]);
  const photoOnly = exts.every((e) => !["pdf", "dwg", "dxf"].includes(e));
  return {
    attr: exts.map((e) => `.${e}`).join(","),
    hint: photoOnly ? "Photos" : own.length ? exts.map((e) => e.toUpperCase()).join(", ") : "PDF, DWG, DXF or photos",
  };
}

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

/**
 * Every file path across a lead's intake answers, in answer order.
 *
 * Shared because an upload must stay reachable along the lead's whole conversion trail (Andrew's
 * plan set "disappeared" the moment his lead converted — the inbox row was the only surface that
 * showed it). Anywhere a record carries a real inquiry link, this is how it finds the files.
 */
export function intakePaths(intake: unknown): string[] {
  const answers = (intake as { intake_answers?: Record<string, unknown> } | null)?.intake_answers;
  if (!answers || typeof answers !== "object") return [];
  return Object.values(answers)
    .filter(Array.isArray)
    .flat()
    .filter((v): v is string => typeof v === "string" && v.includes("/intake/"));
}
