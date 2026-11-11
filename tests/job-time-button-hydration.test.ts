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
