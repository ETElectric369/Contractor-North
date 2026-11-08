/**
 * PATCHES FOR A TEST'S ZIP: the shapes zip-write.ts never writes (an encrypted entry, a trailing
 * comment, a size the directory lies about), put onto buildZip's output by walking the format, so a
 * reader test can meet them without a second writer. Every patch returns a copy.
 */

/** Finds the named entry's central header (and its local header) and lets the patch write into both. */
export function patchZipEntry(zip: Uint8Array, name: string, patch: (v: DataView, central: number, local: number) => void): Uint8Array {
  const out = new Uint8Array(zip);
  const v = new DataView(out.buffer);
  const eocd = out.length - 22; // buildZip writes no comment, so the end record is the last 22 bytes
  const count = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  for (let n = 0; n < count; n++) {
    const nameLen = v.getUint16(p + 28, true);
    const extraLen = v.getUint16(p + 30, true);
    const commentLen = v.getUint16(p + 32, true);
    const entryName = new TextDecoder().decode(out.subarray(p + 46, p + 46 + nameLen));
    if (entryName === name) {
      patch(v, p, v.getUint32(p + 42, true));
      return out;
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`no entry named ${name}`);
}

/** The encrypted flag (general-purpose bit 0) on one entry, in both of its headers. */
export function withEncryptedEntry(zip: Uint8Array, name: string): Uint8Array {
  return patchZipEntry(zip, name, (v, central, local) => {
    v.setUint16(central + 8, v.getUint16(central + 8, true) | 1, true);
    v.setUint16(local + 6, v.getUint16(local + 6, true) | 1, true);
  });
}

/** The uncompressed size the directory CLAIMS for one entry, whatever the part really inflates to. */
export function withDeclaredSize(zip: Uint8Array, name: string, size: number): Uint8Array {
  return patchZipEntry(zip, name, (v, central, local) => {
    v.setUint32(central + 24, size, true);
    v.setUint32(local + 22, size, true);
  });
}

/** A comment after the end record, the way an archiver's note sits at the end of a zip. Apply it last. */
export function withZipComment(zip: Uint8Array, comment: string): Uint8Array {
  const bytes = new TextEncoder().encode(comment);
  const out = new Uint8Array(zip.length + bytes.length);
  out.set(zip, 0);
  out.set(bytes, zip.length);
  new DataView(out.buffer).setUint16(zip.length - 22 + 20, bytes.length, true);
  return out;
}
