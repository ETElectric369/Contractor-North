import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const src = readFileSync("src/app/(app)/jobs/[id]/job-time-button.tsx", "utf8");

describe("the job page's clock button prints the same text on the server and in the browser (React #418)", () => {
  it("clock times use the company's timezone, never the machine's", () => {
    expect(src).not.toMatch(/toLocaleTimeString\(undefined/);
    expect(src).not.toMatch(/toLocaleString\(undefined/);
    expect(src).toContain("formatTime(iso, tz, lang)");
    expect(src).toContain("timeZone: tz");
  });
  it("the elapsed figure waits for mount: no Date.now() in the first render", () => {
    // THE PIN IS THE `now` STATE ITSELF (skeptic #60). A bare `useState(0)` was also satisfied by the
    // hours box a few lines down (`const [hours, setHours] = useState(0)`), so `now` could have gone
    // back to reading the clock in the first render with this test still green.
    expect(src).toContain("const [now, setNow] = useState(0);");
    expect(src.match(/const \[now, setNow\] = useState\(/g)).toHaveLength(1);
    expect(src).not.toMatch(/useState\(\(\) => Date\.now\(\)\)/);
    // The clock has ONE reader in this file, the `now` state's own setter (the tick's effect, after
    // mount): every Date.now() in the code, comments aside, is a setNow(Date.now()).
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    const reads = code.match(/Date\.now\(\)/g) ?? [];
    expect(reads.length).toBeGreaterThan(0);
    expect(code.match(/setNow\(Date\.now\(\)\)/g) ?? []).toHaveLength(reads.length);
    expect(code).toMatch(/useEffect\(\(\) => \{\s*if \(!openEntry\) return;\s*setNow\(Date\.now\(\)\);/);
    expect(src).toMatch(/openEntry && now > 0 \?/);
  });
});

/**
 * THE JOB PAGE'S CLOCK ASKS FOR THE END-OF-DAY REPORT TOO (cn-v1174, 6.7). The Time Clock page and My
 * Day's Now card open the report sheet after a crew lead's clock-out; the job page's dock clock called
 * the same server clock-out and never did. Same rule (lib/daily-report-rule asksForDailyReport, read by
 * the page over profiles.crew_lead and the switches), same sheet, opened only after a clock-out that
 * stood (a punch taken back asks nothing), and mounted outside every branch the clock's state flips,
 * with no key (the Modal law), portaled out of the dock's glass bar.
 */
describe("a crew lead is asked for the end-of-day report on the job page's clock (cn-v1174)", () => {
  const page = readFileSync("src/app/(app)/jobs/[id]/page.tsx", "utf8");
  const dock = readFileSync("src/app/(app)/jobs/[id]/job-action-dock.tsx", "utf8");
  const sheet = readFileSync("src/app/(app)/timeclock/daily-report-debrief.tsx", "utf8");

  it("the page decides it by the one rule, never a second copy", () => {
    expect(page).toContain('import { asksForDailyReport } from "@/lib/daily-report-rule";');
    expect(page).toContain('supabase.from("profiles").select("role, language, crew_lead").eq("id", user?.id ?? "").maybeSingle()');
    expect(page).toContain("asksReport={asksForDailyReport((meRow as any)?.crew_lead, switches.features)}");
    expect(page).not.toMatch(/crew_lead\s*===\s*true/);
    expect(dock).toContain("asksReport={asksReport}");
  });

  it("the button opens the sheet after a clock-out that was not taken back, and refreshes", () => {
    expect(src).toContain('import { DailyReportDebrief } from "../../timeclock/daily-report-debrief";');
    expect(src).toContain("const [reportOpen, setReportOpen] = useState(false);");
    expect(src).toMatch(/\(\) => clockOutCurrent\(\{\}\),\s*\(res\) => \{\s*if \(asksReport && !res\.undone\) setReportOpen\(true\);\s*router\.refresh\(\);\s*\}/);
    // Only the clock-out opens it: clock-in, switch and logged hours never do.
    expect(src.match(/setReportOpen\(true\)/g)).toHaveLength(1);
  });

  it("the sheet is mounted once, outside the clock's branches and the Modal, with no key, portaled", () => {
    const mount = "{asksReport ? <DailyReportDebrief open={reportOpen} onClose={() => setReportOpen(false)} portal /> : null}";
    expect(src).toContain(mount);
    expect(src.match(/<DailyReportDebrief/g)).toHaveLength(1);
    expect(src.indexOf(mount)).toBeGreaterThan(src.lastIndexOf("</Modal>"));
    expect(src).not.toMatch(/<DailyReportDebrief[^>]*\bkey=/);
    // The sheet takes the portal as an option; its other doors render it in place, as before.
    expect(sheet).toContain("export function DailyReportDebrief({ open, onClose, portal = false }");
    expect(sheet).toContain("portal={portal}");
  });
});
