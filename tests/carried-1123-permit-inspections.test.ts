import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { NO_SIGNAL_LINE, settleWrite } from "@/app/(app)/jobs/[id]/permit-inspections";

/**
 * CARRIED FROM audit v1120 (fix wave cn-v1123): the Inspections card's one `run` had no catch.
 */
const ROOT = path.resolve(__dirname, "..");
const src = readFileSync(path.join(ROOT, "src/app/(app)/jobs/[id]/permit-inspections.tsx"), "utf8");

describe("Inspections card `run` has no catch; a dead-zone tap crashes the page and the Add button never comes back", () => {
  it("a rejected action is a line in words, never a throw out of the transition", async () => {
    const out = await settleWrite(Promise.reject(new Error("fetch failed")), "Couldn't save it — try again.");
    expect(out).toEqual({ error: NO_SIGNAL_LINE });
    expect(NO_SIGNAL_LINE).toContain("didn't go through");
  });

  it("a refusal still speaks in the action's own words, else the caller's fallback", async () => {
    expect(await settleWrite(Promise.resolve({ ok: false, error: "Nothing was saved — it was already passed. Reload the job." }), "x")).toEqual({
      error: "Nothing was saved — it was already passed. Reload the job.",
    });
    expect(await settleWrite(Promise.resolve({ ok: false }), "Couldn't add it — try again.")).toEqual({ error: "Couldn't add it — try again." });
    // A reply with nothing in it (a dead response) is a refusal too, not a success.
    expect(await settleWrite(Promise.resolve(undefined as unknown as { ok: boolean }), "Couldn't save it — try again.")).toEqual({
      error: "Couldn't save it — try again.",
    });
  });

  it("a write that landed hands its answer back untouched", async () => {
    const res = { ok: true, message: "Passed", next: null as string | null, href: null as string | null };
    expect(await settleWrite(Promise.resolve(res), "x")).toEqual({ res });
  });

  it("run goes through it, and the Add button comes back on a throw as well as a refusal", () => {
    expect(src).toContain("const done = await settleWrite(what, fallback);");
    expect(src).not.toContain("const res = await what;");
    // The fail path says it, then runs the caller's way back.
    expect(src).toMatch(/if \("error" in done\) \{\s*setError\(done\.error\);\s*onFail\?\.\(\);\s*return;\s*\}/);
    // The Add button hands run its reset; the old .then reset only ran when the action RESOLVED.
    expect(src).toContain('"Couldn\'t add it — try again.",\n                () => setAddedFor(null),');
    expect(src).not.toContain("if (!res?.ok) setAddedFor(null);");
  });
});
