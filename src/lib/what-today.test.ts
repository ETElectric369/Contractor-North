import { describe, it, expect } from "vitest";
import { asksWhatToday, closeSaidNothing, withWhatToday } from "./what-today";
import { asksForDailyReport } from "./daily-report-rule";
import { AUTO_CONFIRMED_CRUMB, stopCrumb } from "@/app/(app)/timeclock/close-math";
import { switchBreadcrumb } from "@/app/(app)/timeclock/switch-breadcrumb";

/**
 * "WHAT DID YOU DO TODAY?" (cn-v1190). The owner: "and for techs who are not lead lets have one
 * question with their clocout - what did you do today". Who is asked, and how the answer joins the
 * shift's note, as two tables.
 */
describe("who is asked: a tech the lead's report does not ask", () => {
  const on = { crew_payroll: true, daily_reports: true } as never;
  const off = { crew_payroll: true, daily_reports: false } as never;
  it.each([
    ["a tech who is not a lead", false, false, on, true],
    ["an office seat", true, false, on, false],
    ["an office seat while reports are off", true, false, off, false],
    ["a tech lead with Daily Reports on (he keeps the two-box report)", false, true, on, false],
    ["a tech lead with Daily Reports off (asked this one question)", false, true, off, true],
    ["an office lead with Daily Reports on", true, true, on, false],
  ])("%s", (_name, staff, lead, features, asked) => {
    const asksReport = asksForDailyReport(lead, features);
    expect(asksWhatToday({ staff, asksReport })).toBe(asked);
    // Never both sheets: the question is the other branch of the report's rule.
    if (asksReport) expect(asksWhatToday({ staff, asksReport })).toBe(false);
  });
});

describe("the answer is added to the note, never over it", () => {
  const held = "[This punch took the job off hold. Before: {\"s\":\"on_hold\"} #0123456789abcdef]";
  const stop = "[clock stopped by Sam Tillery at 5:10 PM; it had been running since 6:02 AM]";

  it("an empty note takes the answer", () => {
    expect(withWhatToday(null, "Pulled wire at Larkspur")).toBe("Pulled wire at Larkspur");
    expect(withWhatToday("", "  Pulled wire  ")).toBe("Pulled wire");
  });

  it("what is there stays whole, the clock's crumbs included, and the answer goes on its own line after it", () => {
    expect(withWhatToday(`Morning at Snowbell\n${AUTO_CONFIRMED_CRUMB}`, "Set the panel")).toBe(`Morning at Snowbell\n${AUTO_CONFIRMED_CRUMB}\nSet the panel`);
    expect(withWhatToday(stop, "Trimmed out J-901")).toBe(`${stop}\nTrimmed out J-901`);
    expect(withWhatToday(held, "Roughed in")).toBe(`${held}\nRoughed in`);
  });

  it("an empty answer adds nothing", () => {
    expect(withWhatToday("Morning at Snowbell", "")).toBe("Morning at Snowbell");
    expect(withWhatToday("Morning at Snowbell", "   ")).toBe("Morning at Snowbell");
    expect(withWhatToday(null, null)).toBe("");
  });

  it("the same answer saved twice is not doubled; a word inside a longer line is not the same answer", () => {
    const once = withWhatToday("Morning at Snowbell", "Set the panel");
    expect(withWhatToday(once, "Set the panel")).toBe(once);
    expect(withWhatToday(once, " Set the panel ")).toBe(once);
    expect(withWhatToday("Set the panel at Tupelo Panel", "Set the panel")).toBe("Set the panel at Tupelo Panel\nSet the panel");
  });
});

describe("never the same question twice: the sheet opens only when the close carried no words of his own", () => {
  const held = "[This punch took the job off hold. Before: {\"s\":\"on_hold\"} #0123456789abcdef]";
  // Each machine shape comes from its own writer, so the reader cannot drift from it.
  const switched = switchBreadcrumb("J-901 Larkspur", "2001-01-08T15:04:05.000Z");
  const stoppedByOffice = stopCrumb({ byName: "Dana Rook", atIso: "2001-01-09T01:00:00Z", runningSinceIso: "2001-01-08T14:00:00Z", newStartIso: null, tz: "America/Los_Angeles", how: "office" });
  const stoppedBySelf = stopCrumb({ byName: "Sam Tillery", atIso: "2001-01-09T15:00:00Z", runningSinceIso: "2001-01-08T14:00:00Z", newStartIso: null, tz: "America/Los_Angeles", how: "self" });

  it.each([
    ["no note at all", null],
    ["an empty note", ""],
    ["only spaces and blank lines", "  \n \n  "],
    ["only the held-job crumb", held],
    ["the held-job crumb with spaces round it", `  ${held}\n  `],
    ["only Switch Job's line", switched],
    ["only the auto clock-out's confirmation", AUTO_CONFIRMED_CRUMB],
    ["only an office stop line", stoppedByOffice],
    ["only a self-picked stop line", stoppedBySelf],
    ["several machine lines and nothing else", `${held}\n${switched}\n${AUTO_CONFIRMED_CRUMB}`],
  ])("asks after %s", (_name, notes) => {
    expect(closeSaidNothing(notes)).toBe(true);
  });

  it.each([
    ["real words", "Set the panel at Larkspur"],
    ["real words with spaces", "   Pulled wire at Snowbell  "],
    ["real words after the held-job crumb", `${held}\nSet the panel at Larkspur`],
    ["real words before Switch Job's line", `Morning at Snowbell\n${switched}`],
    ["a person's own line that starts with a bracket", "[J-902] trimmed out the kitchen"],
    ["a person's words on the same line as a machine line", `${AUTO_CONFIRMED_CRUMB} and swapped the breaker`],
  ])("does not ask after %s", (_name, notes) => {
    expect(closeSaidNothing(notes)).toBe(false);
  });
});
