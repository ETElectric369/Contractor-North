import { contentDisposition } from "@/lib/download-name";

/**
 * A ZIP, STREAMED (cn-v1138). A Response whose body is a ReadableStream handing the bytes over in
 * 1 MiB slices: Vercel's 4.5 MB cap applies to a non-streamed body, and a company's whole export is
 * larger than that the day it has photos in it. No content-length (a streamed body has none to
 * promise), never cached, named both ways (lib/download-name) so an accented company name survives.
 */
export const ZIP_SLICE = 1 << 20;

export function zipResponse(bytes: Uint8Array, filename: string): Response {
  let at = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (at >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.subarray(at, Math.min(at + ZIP_SLICE, bytes.length)));
      at += ZIP_SLICE;
    },
  });
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "application/zip",
      "content-disposition": contentDisposition(filename),
      "cache-control": "no-store",
    },
  });
}
