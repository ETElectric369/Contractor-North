import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { heldSealOk, sealHeld } from "./held-seal";
import { HELD_CRUMB } from "./held-crumb";

/**
 * THE HELD SEAL'S OWN KEY (cn-v1139). The take-back's seal used to be keyed with the Supabase
 * service-role key alone, so rotating that key stranded every line sealed before it. Now: sign with
 * HELD_SEAL_SECRET when set, else the service key (today's behaviour until the name is pasted in);
 * verify against the current key, then HELD_SEAL_SECRET_PREVIOUS, then the service key. The values
 * below are this test's own made-up strings — never a real key, and none is hex, so "the seal holds
 * no key text" is a real check.
 */
const ENV = ["HELD_SEAL_SECRET", "HELD_SEAL_SECRET_PREVIOUS", "SUPABASE_SERVICE_ROLE_KEY"] as const;
const CURRENT = "held-seal-test-current-key-zz";
const PREVIOUS = "held-seal-test-previous-key-zz";
const SERVICE = "held-seal-test-service-key-zz";
const UNKNOWN = "held-seal-test-unknown-key-zz";

const ENTRY = "c0000000-0000-4000-8000-0000000000c1";
const JSON_LINE = JSON.stringify({ j: "a0000000-0000-4000-8000-0000000000a1", r: "waiting on the permit.", d: "2026-10-24", b: null });

/** The seal as the clock has always written it: HMAC-SHA256 of "<punch id>|<json>", hex, 16 characters. */
const sealUnder = (key: string, entryId = ENTRY, json = JSON_LINE) => createHmac("sha256", key).update(`${entryId}|${json}`).digest("hex").slice(0, 16);

const setEnv = (values: Partial<Record<(typeof ENV)[number], string>>) => {
  for (const k of ENV) delete process.env[k];
  for (const [k, v] of Object.entries(values)) process.env[k] = v;
};

let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  setEnv({});
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("sealHeld: which key signs", () => {
  it("signs with HELD_SEAL_SECRET when it is set, even with the service key beside it", () => {
    setEnv({ HELD_SEAL_SECRET: CURRENT, SUPABASE_SERVICE_ROLE_KEY: SERVICE });
    const seal = sealHeld(ENTRY, JSON_LINE);
    expect(seal).toBe(sealUnder(CURRENT));
    expect(seal).not.toBe(sealUnder(SERVICE));
  });

  it("falls back to the service key when HELD_SEAL_SECRET is not set (today's seal, byte for byte) — an empty value counts as not set", () => {
    setEnv({ SUPABASE_SERVICE_ROLE_KEY: SERVICE });
    expect(sealHeld(ENTRY, JSON_LINE)).toBe(sealUnder(SERVICE));
    setEnv({ HELD_SEAL_SECRET: "", SUPABASE_SERVICE_ROLE_KEY: SERVICE });
    expect(sealHeld(ENTRY, JSON_LINE)).toBe(sealUnder(SERVICE));
    // _PREVIOUS alone never signs: it is only ever checked against.
    setEnv({ HELD_SEAL_SECRET_PREVIOUS: PREVIOUS, SUPABASE_SERVICE_ROLE_KEY: SERVICE });
    expect(sealHeld(ENTRY, JSON_LINE)).toBe(sealUnder(SERVICE));
  });

  it("with no key at all there is no seal (no line is written: today's behaviour, never a guess)", () => {
    setEnv({});
    expect(sealHeld(ENTRY, JSON_LINE)).toBeNull();
    expect(heldSealOk(ENTRY, JSON_LINE, sealUnder(SERVICE))).toBe(false);
  });

  it("the seal is the shape the crumb's pattern reads — 16 lowercase hex characters — and holds no key text", () => {
    setEnv({ HELD_SEAL_SECRET: CURRENT, HELD_SEAL_SECRET_PREVIOUS: PREVIOUS, SUPABASE_SERVICE_ROLE_KEY: SERVICE });
    const seal = sealHeld(ENTRY, JSON_LINE)!;
    expect(seal).toMatch(/^[0-9a-f]{16}$/);
    for (const key of [CURRENT, PREVIOUS, SERVICE]) {
      expect(seal).not.toContain(key);
      // Not even a fragment of one: no four-character run of a key appears in the seal.
      for (let i = 0; i + 4 <= key.length; i++) expect(seal, `fragment "${key.slice(i, i + 4)}"`).not.toContain(key.slice(i, i + 4));
    }
    // The line as the clock writes it still parses with the crumb's own pattern.
    const line = `[This punch took the job off hold. Before: ${JSON_LINE} #${seal}]`;
    const m = HELD_CRUMB.exec(line)!;
    expect(m[1]).toBe(JSON_LINE);
    expect(m[2]).toBe(seal);
    expect(heldSealOk(ENTRY, m[1], m[2])).toBe(true);
  });
});

describe("heldSealOk: which keys verify, in which order", () => {
  it("a seal from the current key verifies; a seal from the previous key still verifies while _PREVIOUS is kept", () => {
    setEnv({ HELD_SEAL_SECRET: CURRENT, HELD_SEAL_SECRET_PREVIOUS: PREVIOUS, SUPABASE_SERVICE_ROLE_KEY: SERVICE });
    expect(heldSealOk(ENTRY, JSON_LINE, sealUnder(CURRENT))).toBe(true);
    expect(heldSealOk(ENTRY, JSON_LINE, sealUnder(PREVIOUS))).toBe(true);
    // A line sealed before HELD_SEAL_SECRET existed (under the service key) restores too.
    expect(heldSealOk(ENTRY, JSON_LINE, sealUnder(SERVICE))).toBe(true);
  });

  it("the service key is still honoured for a seal written before the rotation, with or without a _PREVIOUS", () => {
    setEnv({ HELD_SEAL_SECRET: CURRENT, SUPABASE_SERVICE_ROLE_KEY: SERVICE });
    expect(heldSealOk(ENTRY, JSON_LINE, sealUnder(SERVICE))).toBe(true);
    // No HELD_SEAL_SECRET yet, a _PREVIOUS pasted early: both the service key's seal and the previous key's verify.
    setEnv({ HELD_SEAL_SECRET_PREVIOUS: PREVIOUS, SUPABASE_SERVICE_ROLE_KEY: SERVICE });
    expect(heldSealOk(ENTRY, JSON_LINE, sealUnder(SERVICE))).toBe(true);
    expect(heldSealOk(ENTRY, JSON_LINE, sealUnder(PREVIOUS))).toBe(true);
  });

  it("a seal from an unknown key does not verify, and a dropped _PREVIOUS stops verifying the old seal", () => {
    setEnv({ HELD_SEAL_SECRET: CURRENT, HELD_SEAL_SECRET_PREVIOUS: PREVIOUS, SUPABASE_SERVICE_ROLE_KEY: SERVICE });
    expect(heldSealOk(ENTRY, JSON_LINE, sealUnder(UNKNOWN))).toBe(false);
    // The week is over: _PREVIOUS is gone, and the service key has been rotated too.
    setEnv({ HELD_SEAL_SECRET: CURRENT, SUPABASE_SERVICE_ROLE_KEY: "held-seal-test-rotated-service-zz" });
    expect(heldSealOk(ENTRY, JSON_LINE, sealUnder(PREVIOUS))).toBe(false);
    expect(heldSealOk(ENTRY, JSON_LINE, sealUnder(SERVICE))).toBe(false);
    expect(heldSealOk(ENTRY, JSON_LINE, sealUnder(CURRENT))).toBe(true);
  });

  it("a tampered seal does not verify: one character changed, another punch's id, the line's JSON edited, the wrong length", () => {
    setEnv({ HELD_SEAL_SECRET: CURRENT, HELD_SEAL_SECRET_PREVIOUS: PREVIOUS, SUPABASE_SERVICE_ROLE_KEY: SERVICE });
    const good = sealUnder(CURRENT);
    const flipped = (good[0] === "0" ? "1" : "0") + good.slice(1);
    expect(heldSealOk(ENTRY, JSON_LINE, flipped)).toBe(false);
    expect(heldSealOk("some-other-punch", JSON_LINE, good)).toBe(false);
    expect(heldSealOk(ENTRY, JSON_LINE.replace("waiting on the permit.", "typed by a tech"), good)).toBe(false);
    expect(heldSealOk(ENTRY, JSON_LINE, good.slice(0, 15))).toBe(false);
    expect(heldSealOk(ENTRY, JSON_LINE, good + "0")).toBe(false);
    expect(heldSealOk(ENTRY, JSON_LINE, "")).toBe(false);
    expect(heldSealOk(ENTRY, JSON_LINE, "0000000000000000")).toBe(false);
    expect(heldSealOk(ENTRY, JSON_LINE, good.toUpperCase())).toBe(false);
    expect(heldSealOk(ENTRY, JSON_LINE, good)).toBe(true);
  });
});

describe("the module keeps the key to itself", () => {
  const src = readFileSync(join(process.cwd(), "src/lib/held-seal.ts"), "utf8");

  it("is server-only, compares in constant time, and never logs, reports or returns a key", () => {
    expect(src.startsWith('import "server-only";')).toBe(true);
    expect(src).toContain("timingSafeEqual(");
    expect(src).not.toMatch(/console\.|reportError|new Error\(/);
    // Only the two doors are exported: a seal, or yes/no. The key readers stay private.
    expect(src.match(/^export /gm)).toHaveLength(2);
    expect(src).toContain("export function sealHeld(");
    expect(src).toContain("export function heldSealOk(");
  });

  it("the timeclock actions seal and verify through it, and read no key of their own any more", () => {
    const actions = readFileSync(join(process.cwd(), "src/app/(app)/timeclock/actions.ts"), "utf8");
    expect(actions).toContain('import { heldSealOk, sealHeld } from "@/lib/held-seal";');
    expect(actions).toContain("heldSealOk(entryId, m[1], m[2])");
    expect(actions).toContain("sealHeld(entryId, json)");
    expect(actions).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
    expect(actions).not.toContain("createHmac");
  });
});
