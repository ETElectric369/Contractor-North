import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * THE CRONS RUN ON THE COMPANY'S CLOCK (2026-11-02, the day after DST ended). Vercel's crons run in
 * UTC, so a fixed hour is tuned to one zone's half of the year: the daily cron's 15:00 UTC and the
 * reminders' 15/19/23 UTC were 8 AM / noon / 4 PM Pacific DAYLIGHT, and the fall-back moved them to
 * 7, 11 and 3 (Monday's Bug Watch digest arrived at 7:00 AM PST). Every company-facing cron is now
 * HOURLY and judges each company in its own zone (atLocalHour, src/lib/cron-orgs.ts): pinned here,
 * so a fixed UTC hour cannot come back, and each path has the route it names.
 */
type Cron = { path: string; schedule: string };
const crons = (JSON.parse(readFileSync(join(process.cwd(), "vercel.json"), "utf8")).crons ?? []) as Cron[];
const schedule = (path: string) => crons.find((c) => c.path === path)?.schedule;
const HOURLY = "0 * * * *";

describe("vercel.json crons", () => {
  it("are the six paths, each once", () => {
    expect(crons.map((c) => c.path).sort()).toEqual(
      [
        "/api/automations/daily",
        "/api/automations/reminders",
        "/api/google/sync",
        "/api/timeclock/eod-reminder",
        "/api/timeclock/long-shift",
        "/api/timeclock/nudge",
      ].sort(),
    );
  });

  it("the daily cron and the reminders are hourly: each company is handled at its own hour, never a fixed UTC one", () => {
    expect(schedule("/api/automations/daily")).toBe(HOURLY);
    expect(schedule("/api/automations/reminders")).toBe(HOURLY);
  });

  it("the three Time Clock crons stay hourly, and the calendar sync every fifteen minutes", () => {
    expect(schedule("/api/timeclock/nudge")).toBe(HOURLY);
    expect(schedule("/api/timeclock/eod-reminder")).toBe(HOURLY);
    expect(schedule("/api/timeclock/long-shift")).toBe(HOURLY);
    expect(schedule("/api/google/sync")).toBe("*/15 * * * *");
  });

  it("every path has its route file", () => {
    for (const c of crons) expect(existsSync(join(process.cwd(), "src/app", c.path, "route.ts")), c.path).toBe(true);
  });
});
