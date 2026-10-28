import { describe, it, expect } from "vitest";
import { deflateRawSync } from "node:zlib";
import { unzip, text } from "@/test/unzip";
import { PACK_AT_A_TIME, packFiles } from "./pack";
import type { FileRef } from "./collect";

/**
 * THE PACKER (cn-v1138): eight downloads in flight at a time, every ref attempted so the count is
 * honest, any failure → no zip and the real counts, the running bytes capped, the entries named as
 * the refs say and read back by the test's own zip reader.
 */
const ref = (i: number, name = `${i}.txt`): FileRef => ({ bucket: "documents", path: `org-1/j/${i}`, name, size: null });

type Obj = { bytes?: string; fail?: boolean; throws?: boolean };

/** A storage fake that records how many downloads are in flight at once. */
function storage(objects: Record<string, Obj>, delayMs = 2) {
  let inFlight = 0;
  let peak = 0;
  const order: string[] = [];
  const svc = {
    storage: {
      from: (bucket: string) => ({
        download: async (path: string) => {
          order.push(`${bucket}:${path}`);
          inFlight++;
          peak = Math.max(peak, inFlight);
          await new Promise((r) => setTimeout(r, delayMs));
          inFlight--;
          const o = objects[path];
          if (!o) return { data: null, error: { message: "Object not found" } };
          if (o.throws) throw new Error("socket hang up");
          if (o.fail) return { data: null, error: { message: "boom" } };
          return { data: new Blob([new TextEncoder().encode(o.bytes ?? "")]), error: null };
        },
      }),
    },
  };
  return { svc, peak: () => peak, order };
}

describe("packFiles", () => {
  it("downloads eight at a time, never more, and the zip holds every entry under its ref's name", async () => {
    const objects: Record<string, Obj> = {};
    const refs: FileRef[] = [];
    for (let i = 0; i < 20; i++) {
      objects[`org-1/j/${i}`] = { bytes: `file ${i}` };
      refs.push(ref(i));
    }
    const s = storage(objects);
    const got = await packFiles(s.svc, refs, {});
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(PACK_AT_A_TIME).toBe(8);
    expect(s.peak()).toBe(8);
    expect(s.order).toHaveLength(20);
    const entries = unzip(got.bytes);
    expect(entries.map((e) => e.name)).toEqual(refs.map((r) => r.name));
    expect(entries.map((e) => text(e.data))).toEqual(refs.map((_, i) => `file ${i}`));
    expect(got.files).toBe(20);
    expect(got.raw).toBe(refs.reduce((n, _, i) => n + `file ${i}`.length, 0));
  });

  it("one object that could not be read means NO zip, with the real counts; every ref was still tried", async () => {
    const s = storage({ "org-1/j/0": { bytes: "a" }, "org-1/j/1": { fail: true }, "org-1/j/2": { bytes: "c" } });
    expect(await packFiles(s.svc, [ref(0), ref(1), ref(2)], {})).toEqual({ ok: false, failed: 1, total: 3 });
    expect(s.order).toHaveLength(3);
  });

  it("a download that throws and an object that is not there both count as failed", async () => {
    const s = storage({ "org-1/j/0": { throws: true }, "org-1/j/1": { bytes: "b" } });
    expect(await packFiles(s.svc, [ref(0), ref(1), ref(2)], {})).toEqual({ ok: false, failed: 2, total: 3 });
  });

  it("folders in a name are folders in the zip; deflate is used when it shrinks a file and the bytes read back the same", async () => {
    const big = "the same words over and over ".repeat(200);
    const s = storage({ "org-1/j/0": { bytes: big }, "org-1/j/1": { bytes: "x" } });
    const got = await packFiles(s.svc, [ref(0, "Employees/Larkspur/notes.txt"), ref(1, "Insurance/x.txt")], {
      deflate: (b) => new Uint8Array(deflateRawSync(b)),
      modified: new Date(Date.UTC(2026, 9, 28, 9, 30, 0)),
    });
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    const entries = unzip(got.bytes);
    expect(entries.map((e) => [e.name, e.method])).toEqual([
      ["Employees/Larkspur/notes.txt", 8],
      ["Insurance/x.txt", 0],
    ]);
    expect(text(entries[0].data)).toBe(big);
  });

  it("the running bytes past the cap stop the packing and say so, without a count of failures", async () => {
    const s = storage({ "org-1/j/0": { bytes: "a".repeat(60) }, "org-1/j/1": { bytes: "b".repeat(60) }, "org-1/j/2": { bytes: "c" } }, 0);
    const got = await packFiles(s.svc, [ref(0), ref(1), ref(2)], { capBytes: 100, atATime: 1 });
    expect(got).toEqual({ ok: false, overCap: true, total: 3 });
    // The third was never asked for once the cap was passed.
    expect(s.order).toEqual(["documents:org-1/j/0", "documents:org-1/j/1"]);
  });

  it("no refs is an empty zip, not a failure (the routes refuse before this)", async () => {
    const s = storage({});
    const got = await packFiles(s.svc, [], {});
    expect(got.ok).toBe(true);
    if (got.ok) expect(unzip(got.bytes)).toEqual([]);
  });
});
