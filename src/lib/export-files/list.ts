import type { ListedFile } from "./collect";

/**
 * A FOLDER, WALKED — OR A FAILURE (cn-v1138). Supabase Storage lists ONE level at a time (a folder
 * comes back as an entry with id null), 1,000 per page; storage-sweep's listAll has the same loop
 * but swallows an error as the end of the list, which a janitor may do and an export may not: a
 * walk that did not come back whole is a failure here, never a shorter list, so a zip is never
 * handed over with files quietly missing.
 */
export type ListSvc = {
  storage: {
    from(bucket: string): {
      list(prefix: string, opts: { limit: number; offset: number }): PromiseLike<{ data: ListEntry[] | null; error: unknown }>;
    };
  };
};

/** storage.list's entry: `id` is null for a folder; a file's size rides in metadata. */
export type ListEntry = { name: string; id: string | null; metadata?: { size?: number | null } | null };

export const LIST_PAGE = 1000;
/** 20,000 objects per folder per walk — a bound; past it the walk is a failure, said in words. */
export const LIST_MAX_PAGES = 20;
/** How deep a walk goes under its prefix: `<org>/employees/<profile>/<file>` is two below `<org>/employees`. */
export const LIST_MAX_DEPTH = 3;

export type Walk = { ok: true; files: ListedFile[] } | { ok: false; error: unknown };

/** One level: every entry under `prefix`, every page, or a failure. */
async function listLevel(svc: ListSvc, bucket: string, prefix: string): Promise<{ ok: true; entries: ListEntry[] } | { ok: false; error: unknown }> {
  const out: ListEntry[] = [];
  for (let page = 0; page < LIST_MAX_PAGES; page++) {
    const { data, error } = await svc.storage.from(bucket).list(prefix, { limit: LIST_PAGE, offset: page * LIST_PAGE });
    if (error) return { ok: false, error };
    if (!Array.isArray(data)) return { ok: false, error: new Error("the listing returned no entries array") };
    out.push(...data);
    if (data.length < LIST_PAGE) return { ok: true, entries: out };
  }
  return { ok: false, error: new Error(`more than ${LIST_MAX_PAGES * LIST_PAGE} objects under ${bucket}/${prefix}`) };
}

/** Every FILE under `prefix` (no trailing slash), folders walked `depth` levels down, each with its
 *  whole key and its size when storage said one. */
export async function walkFolder(svc: ListSvc, bucket: string, prefix: string, depth: number = LIST_MAX_DEPTH): Promise<Walk> {
  const files: ListedFile[] = [];
  const level = await listLevel(svc, bucket, prefix);
  if (!level.ok) return level;
  for (const e of level.entries) {
    const name = String(e.name ?? "").trim();
    if (!name || name === ".emptyFolderPlaceholder") continue;
    const path = prefix ? `${prefix}/${name}` : name;
    if (e.id === null) {
      // A folder deeper than the walk goes is a FAILURE, never a folder quietly left out: the route
      // says the files could not be listed, and nothing partial is handed over.
      if (depth <= 0) return { ok: false, error: new Error(`deeper than ${LIST_MAX_DEPTH} under ${bucket}/${path}`) };
      const below = await walkFolder(svc, bucket, path, depth - 1);
      if (!below.ok) return below;
      files.push(...below.files);
      continue;
    }
    const size = e.metadata?.size;
    files.push({ path, size: typeof size === "number" && Number.isFinite(size) && size >= 0 ? size : null });
  }
  return { ok: true, files };
}
