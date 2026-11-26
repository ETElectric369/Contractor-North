import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  TIMECLOCK_REMIND_BY,
  getOrgSettings,
  isTimeclockRemindBy,
  timeclockRemindersBy,
  timeclockRemindersPush,
  timeclockRemindersText,
} from "@/lib/org-settings";

/**
 * TIMECLOCK REMINDERS GO OUT BY (cn-v1190). The owner: "everyone gets the push notification and the
 * boss can choose text push or both". One rule reads the choice, healed on every read: a stored
 * value that is one of the three is itself; anything else falls back on the old "Text timeclock
 * reminders" box (off → Push, on or never touched → Both). Larkspur and Snowbell are stand-ins.
 */
describe("timeclockRemindersBy: the one read, healed", () => {
  it("a stored choice that is one of the three is itself, whatever the old box says", () => {
    for (const by of TIMECLOCK_REMIND_BY) {
      expect(timeclockRemindersBy({ remind_timeclock_by: by })).toBe(by);
      expect(timeclockRemindersBy({ remind_timeclock_by: by, remind_timeclock: false })).toBe(by);
      expect(timeclockRemindersBy({ remind_timeclock_by: by, remind_timeclock: true })).toBe(by);
    }
  });

  it("nothing stored: the old box off reads Push; on, or never touched, reads Both", () => {
    expect(timeclockRemindersBy({ remind_timeclock: false })).toBe("push");
    expect(timeclockRemindersBy({ remind_timeclock: true })).toBe("both");
    expect(timeclockRemindersBy({})).toBe("both");
    expect(timeclockRemindersBy(null)).toBe("both");
    expect(timeclockRemindersBy(undefined)).toBe("both");
  });

  it("a value from nowhere is healed the same way, never trusted", () => {
    for (const junk of ["PUSH", "sms", "", 1, true, null, ["push"], { by: "push" }]) {
      expect(timeclockRemindersBy({ remind_timeclock_by: junk, remind_timeclock: false })).toBe("push");
      expect(timeclockRemindersBy({ remind_timeclock_by: junk })).toBe("both");
    }
  });

  it("reads the same from the stored jsonb and from getOrgSettings' answer", () => {
    for (const raw of [{}, { remind_timeclock: false }, { remind_timeclock: true }, { remind_timeclock_by: "text" }, { remind_timeclock_by: "nope", remind_timeclock: false }]) {
      expect(timeclockRemindersBy(getOrgSettings(raw)), JSON.stringify(raw)).toBe(timeclockRemindersBy(raw));
    }
  });

  // EXACTLY WHAT THE OLD BOX DID (fix-1190-B, skeptic #91 "R:"): every reader at cn-v1189 asked
  // `!getOrgSettings(s).remind_timeclock`. A PRESENT falsy value (null, 0, "") texted nobody there, so
  // it must read Push here, never Both; an absent key or a truthy value texted, and reads Both.
  it.each([
    ["the box absent", {}, "both"],
    ["the box on", { remind_timeclock: true }, "both"],
    ["the box off", { remind_timeclock: false }, "push"],
    ["the box stored as null", { remind_timeclock: null }, "push"],
    ["the box stored as 0", { remind_timeclock: 0 }, "push"],
    ['the box stored as ""', { remind_timeclock: "" }, "push"],
    ["the box stored as 1", { remind_timeclock: 1 }, "both"],
    ['the box stored as "yes"', { remind_timeclock: "yes" }, "both"],
    ["the box null beside a junk choice", { remind_timeclock: null, remind_timeclock_by: "sms" }, "push"],
    ["the box null beside a real choice", { remind_timeclock: null, remind_timeclock_by: "both" }, "both"],
  ])("%s: the same answer as the old readers, raw or through getOrgSettings", (_name, raw, by) => {
    expect(timeclockRemindersBy(raw)).toBe(by);
    expect(timeclockRemindersBy(getOrgSettings(raw))).toBe(by);
    // Nobody starts getting texts: with no stored choice, texts go out exactly when the old read said so.
    if (!isTimeclockRemindBy((raw as Record<string, unknown>).remind_timeclock_by)) {
      expect(timeclockRemindersText(raw)).toBe(!!getOrgSettings(raw).remind_timeclock);
    }
  });

  it("the texts go under Text or Both; the 6 PM push under Push or Both", () => {
    expect([timeclockRemindersText({ remind_timeclock_by: "push" }), timeclockRemindersPush({ remind_timeclock_by: "push" })]).toEqual([false, true]);
    expect([timeclockRemindersText({ remind_timeclock_by: "text" }), timeclockRemindersPush({ remind_timeclock_by: "text" })]).toEqual([true, false]);
    expect([timeclockRemindersText({ remind_timeclock_by: "both" }), timeclockRemindersPush({ remind_timeclock_by: "both" })]).toEqual([true, true]);
    expect([timeclockRemindersText({ remind_timeclock: false }), timeclockRemindersPush({ remind_timeclock: false })]).toEqual([false, true]);
  });

  it("the save's check takes the three and nothing else", () => {
    for (const by of TIMECLOCK_REMIND_BY) expect(isTimeclockRemindBy(by)).toBe(true);
    for (const junk of ["Push", "sms", "", undefined, null, 0, true]) expect(isTimeclockRemindBy(junk)).toBe(false);
  });
});

/** The old box is read nowhere but inside the one rule (comments taken out; tests are not code that reads). */
describe("the old box has one reader", () => {
  const ROOT = process.cwd();
  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
    }
    return out;
  }
  const code = (text: string) =>
    text
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .map((line) => line.replace(/(^|[^:"'`\\])\/\/.*$/, "$1"))
      .join("\n");

  it("remind_timeclock (the old box) appears in code only in lib/org-settings.ts", () => {
    const hits: string[] = [];
    for (const f of walk(join(ROOT, "src"))) {
      const rel = relative(ROOT, f);
      if (/\bremind_timeclock\b(?!_)/.test(code(readFileSync(f, "utf8")))) hits.push(rel);
    }
    expect(hits).toEqual(["src/lib/org-settings.ts"]);
  });

  it("inside it, the old box is read only by timeclockRemindersBy", () => {
    const src = code(readFileSync(join(ROOT, "src/lib/org-settings.ts"), "utf8"));
    const reads = src.split("\n").filter((l) => /\.remind_timeclock\b(?!_)/.test(l));
    // PIN MOVED (fix-1190-B): a PRESENT falsy old box reads Push, exactly what the old readers did.
    expect(reads).toEqual(['  return present && !s.remind_timeclock ? "push" : "both";']);
  });
});
