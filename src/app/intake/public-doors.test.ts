import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * NOTHING A STRANGER TYPED MAY BE DESTROYED BY A DROPPED CONNECTION (audit 6).
 *
 * A server action is a fetch. On a public door a rejection is not a retry — it is an unhandled
 * rejection that takes the page to the error boundary, and on /intake that showed a homeowner a
 * link to the CONTRACTOR'S LOGIN after they had filled in every answer and uploaded two photos.
 * Every answer gone, and the contractor never learns the lead existed.
 *
 * These doors are the ones an unauthenticated person can reach, so they are the ones where a lost
 * submission is invisible to everybody. Asserted from source rather than by mocking a network
 * failure, because what matters is structural and a mock would test the mock.
 */
const DOORS = [
  "src/app/intake/[handle]/intake-form.tsx",
  "src/app/estimate/[handle]/configurator.tsx",
  "src/app/inquire/[org]/inquiry-form.tsx",
];

describe("every public door survives a dead connection", () => {
  it.each(DOORS)("%s wraps its submit", (rel) => {
    const src = readFileSync(join(process.cwd(), rel), "utf8");
    // The submit call and a catch beside it. Crude on purpose: a precise AST check would pass on
    // a try{} that catches the wrong thing, and this is a smoke alarm, not a proof.
    expect(src, `${rel} has no try/catch around its submit`).toMatch(/try\s*\{/);
    expect(src, `${rel} never catches`).toMatch(/\}\s*catch/);
  });

  it.each(DOORS)("%s tells the person their work is still there", (rel) => {
    const src = readFileSync(join(process.cwd(), rel), "utf8");
    // Not "Something went wrong." on its own — a stranger needs to know whether to retype it all.
    expect(src).toMatch(/try again|Try .*again|tap Send again|call us instead/i);
  });

  it("the intake door names the loss explicitly, because it is the longest form", () => {
    const src = readFileSync(join(process.cwd(), DOORS[0]), "utf8");
    expect(src).toContain("Nothing you typed is lost");
  });
});
