import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { clockStateLine, CLOCK_LINE_LAW } from "@/lib/nort/clock-state";

/**
 * YOUR CLOCK RIGHT NOW (2026-10-20 01:31, Erik's phone). "Can you clock me in for 85 Larkspur?" →
 * "You're already on the clock at 85 Larkspur Court, so you're set" — no tool call; the punch he
 * remembered had been closed on the screen fifteen minutes earlier. The second time tonight a state
 * claim came from an earlier turn. The deeds law (cn-v1123) says read first; this is the structural
 * half: the route reads the caller's open punch every turn and puts it in the volatile prompt.
 */
const src = (p: string) => readFileSync(resolve(__dirname, "..", p), "utf8");
const TZ = "America/Los_Angeles";

describe("clockStateLine: the caller's own punch, said fresh", () => {
  it("no open row → NOT on the clock, with the law", () => {
    const l = clockStateLine(null, TZ);
    expect(l).toContain("YOUR CLOCK RIGHT NOW");
    expect(l).toContain("NOT on the clock.");
    expect(l).toContain(CLOCK_LINE_LAW);
  });
  it("an open punch on a job → ON the clock since <local time> on <number name>", () => {
    const l = clockStateLine({ clock_in: "2026-10-20T08:31:54.000Z", job_id: "j1", jobs: { job_number: "J-099", name: "Bayberry kitchen", address: "12 Larkspur Lane" } }, TZ);
    expect(l).toContain("ON the clock since 1:31 AM on J-099 Bayberry kitchen.");
  });
  it("a job with no name is said by its street; the join may arrive as a one-row array", () => {
    const l = clockStateLine({ clock_in: "2026-10-20T08:31:54.000Z", job_id: "j1", jobs: [{ job_number: "J-099", name: null, address: "12 Larkspur Lane" }] }, TZ);
    expect(l).toContain("on J-099 12 Larkspur Lane.");
  });
  it("a job-less punch → on no job", () => {
    const l = clockStateLine({ clock_in: "2026-10-20T08:14:53.000Z", job_id: null, jobs: null }, TZ);
    expect(l).toContain("ON the clock since 1:14 AM, on no job.");
  });
  it("a failed read is said as such, never as 'not on the clock'", () => {
    const l = clockStateLine(undefined, TZ, true);
    expect(l).toContain("could not be read for this turn");
    expect(l).toContain("read who_is_clocked_in");
    expect(l).not.toContain("NOT on the clock");
  });
});

describe("the route reads it every turn, into the volatile (per-person) block", () => {
  const r = src("src/app/api/chat/route.ts");
  it("one read of the caller's open entry, joined to its job", () => {
    expect(r).toContain('.select("clock_in, job_id, jobs(job_number, name, address)")');
    expect(r).toContain('.eq("profile_id", user.id)');
    expect(r).toContain("volatilePrompt += clockStateLine(openErr ? undefined : (openRow as OpenClockRow), orgS.timezone, !!openErr);");
  });
  it("it sits after RIGHT NOW and before the standing orders, in the volatile prompt", () => {
    const now = r.indexOf("RIGHT NOW: ${stamp}");
    const clock = r.indexOf("volatilePrompt += clockStateLine(");
    const orders = r.indexOf("volatilePrompt += standingOrders(");
    expect(now).toBeGreaterThan(0);
    expect(clock).toBeGreaterThan(now);
    expect(orders).toBeGreaterThan(clock);
  });
});
