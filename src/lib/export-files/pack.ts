import { buildZip, type DeflateRaw, type ZipFile } from "@/lib/zip-write";
import { FILES_CAP_BYTES, type FileRef } from "./collect";

/**
 * THE FILES, DOWNLOADED AND ZIPPED — WHOLE OR NOT AT ALL (cn-v1138).
 *
 * Eight objects in flight at a time (a job can hold hundreds of photos; one at a time would run
 * into the route's five minutes, all at once would run into the bucket's patience). Every ref is
 * attempted so the failure can say the real count — "3 of 40 files could not be read" — and ANY
 * failure means no zip: an export with a photo quietly missing is the thing a person would never
 * notice until the day they needed it.
 *
 * The cap is kept here too, on the bytes actually read, because a pointer row seldom knows its
 * file's size: past it the packing stops and says so, rather than building a zip the function
 * cannot hold in memory.
 */
export const PACK_AT_A_TIME = 8;

export type PackSvc = {
  storage: { from(bucket: string): { download(path: string): PromiseLike<{ data: Blob | null; error: unknown }> } };
};

export type PackResult =
  | { ok: true; bytes: Uint8Array; files: number; raw: number }
  | { ok: false; failed: number; total: number }
  | { ok: false; overCap: true; total: number };

export async function packFiles(
  svc: PackSvc,
  refs: readonly FileRef[],
  opts: { deflate?: DeflateRaw; modified?: Date; capBytes?: number; atATime?: number } = {},
): Promise<PackResult> {
  const cap = opts.capBytes ?? FILES_CAP_BYTES;
  const total = refs.length;
  const data: (Uint8Array | null)[] = new Array(total).fill(null);
  let next = 0;
  let failed = 0;
  let raw = 0;
  let overCap = false;

  async function worker() {
    while (!overCap) {
      const i = next++;
      if (i >= total) return;
      const ref = refs[i];
      try {
        const { data: blob, error } = await svc.storage.from(ref.bucket).download(ref.path);
        if (error || !blob) {
          failed++;
          continue;
        }
        const bytes = new Uint8Array(await blob.arrayBuffer());
        raw += bytes.length;
        if (raw > cap) {
          overCap = true;
          return;
        }
        data[i] = bytes;
      } catch {
        failed++;
      }
    }
  }

  const lanes = Math.max(1, Math.min(opts.atATime ?? PACK_AT_A_TIME, total));
  await Promise.all(Array.from({ length: lanes }, () => worker()));

  if (overCap) return { ok: false, overCap: true, total };
  if (failed > 0) return { ok: false, failed, total };
  const files: ZipFile[] = refs.map((r, i) => ({ name: r.name, data: data[i] ?? new Uint8Array(0) }));
  const bytes = buildZip(files, { deflate: opts.deflate, modified: opts.modified });
  return { ok: true, bytes, files: total, raw };
}
