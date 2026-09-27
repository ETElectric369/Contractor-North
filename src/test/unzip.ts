import { inflateRawSync } from "node:zlib";

/**
 * A TEST'S OWN ZIP READER, written from the format and not from zip-write.ts, so a writer bug can't
 * hide behind a reader that shares it. Reads the central directory from the end record, then each
 * entry through its local header; checks the CRC-32 against node:zlib's own.
 */
export type Unzipped = { name: string; method: number; flags: number; crc: number; data: Uint8Array };

export function unzip(b: Uint8Array): Unzipped[] {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let eocd = -1;
  for (let i = b.length - 22; i >= 0; i--) {
    if (v.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("no end of central directory");
  const count = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  const out: Unzipped[] = [];
  for (let n = 0; n < count; n++) {
    if (v.getUint32(p, true) !== 0x02014b50) throw new Error("bad central header");
    const flags = v.getUint16(p + 8, true);
    const method = v.getUint16(p + 10, true);
    const crc = v.getUint32(p + 16, true);
    const compSize = v.getUint32(p + 20, true);
    const size = v.getUint32(p + 24, true);
    const nameLen = v.getUint16(p + 28, true);
    const extraLen = v.getUint16(p + 30, true);
    const commentLen = v.getUint16(p + 32, true);
    const lo = v.getUint32(p + 42, true);
    const name = new TextDecoder().decode(b.subarray(p + 46, p + 46 + nameLen));
    if (v.getUint32(lo, true) !== 0x04034b50) throw new Error("bad local header");
    if (v.getUint32(lo + 14, true) !== crc) throw new Error("local and central CRC differ");
    const start = lo + 30 + v.getUint16(lo + 26, true) + v.getUint16(lo + 28, true);
    const body = b.subarray(start, start + compSize);
    const data = method === 0 ? new Uint8Array(body) : method === 8 ? new Uint8Array(inflateRawSync(body)) : null;
    if (!data) throw new Error(`unknown method ${method}`);
    if (data.length !== size) throw new Error(`${name}: size ${data.length} is not the declared ${size}`);
    out.push({ name, method, flags, crc, data });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

export const text = (u: Uint8Array) => new TextDecoder().decode(u);
