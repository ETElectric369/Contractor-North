import { describe, it, expect } from "vitest";
import { zipResponse, ZIP_SLICE } from "./zip-response";

/**
 * A ZIP, STREAMED (cn-v1138): the bytes come back whole and in order, in 1 MiB slices (a 2.5 MiB
 * file is three chunks), under the zip type, named both ways, never cached, with no content-length.
 */
async function chunksOf(res: Response): Promise<Uint8Array[]> {
  const out: Uint8Array[] = [];
  const reader = res.body!.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return out;
    out.push(value);
  }
}

describe("zipResponse", () => {
  it("streams the bytes back whole, 1 MiB at a time: a 2.5 MiB buffer is three chunks", async () => {
    const bytes = new Uint8Array(2.5 * ZIP_SLICE);
    for (let i = 0; i < bytes.length; i += 4099) bytes[i] = i % 251;
    const chunks = await chunksOf(zipResponse(bytes, "Harbor 2026.zip"));
    expect(chunks.map((c) => c.length)).toEqual([ZIP_SLICE, ZIP_SLICE, ZIP_SLICE / 2]);
    const joined = new Uint8Array(bytes.length);
    let at = 0;
    for (const c of chunks) {
      joined.set(c, at);
      at += c.length;
    }
    expect(Buffer.compare(Buffer.from(joined), Buffer.from(bytes))).toBe(0);
  });

  it("a small file is one chunk and an empty one is none; arrayBuffer() reads either whole", async () => {
    const small = new Uint8Array([80, 75, 3, 4, 9, 8]);
    expect((await chunksOf(zipResponse(small, "a.zip"))).map((c) => [...c])).toEqual([[80, 75, 3, 4, 9, 8]]);
    expect(new Uint8Array(await zipResponse(small, "a.zip").arrayBuffer())).toEqual(small);
    expect(await chunksOf(zipResponse(new Uint8Array(0), "a.zip"))).toEqual([]);
  });

  it("the headers: zip, attachment named both ways, no-store, and no content-length", () => {
    const res = zipResponse(new Uint8Array(3), "Électricité Nord 2026.zip");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename="Electricite Nord 2026.zip"; filename*=UTF-8''%C3%89lectricit%C3%A9%20Nord%202026.zip`);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-length")).toBeNull();
  });
});
