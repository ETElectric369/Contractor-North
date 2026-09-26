import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * NO DEVELOPER TEXT ON A SUBSCRIBER'S SCREEN (Wave 0). Settings > Connections told every company
 * to "Add QBO_CLIENT_ID, QBO_CLIENT_SECRET, and QBO_ENVIRONMENT", named ANTHROPIC_API_KEY and
 * Vercel, and printed a model id. Those are North's own settings; a contractor can do nothing
 * with them. The one place they may appear is the platform page (Bug Watch, /bugs), which only
 * North's own team can open.
 */
const ROOT = process.cwd();
const PLATFORM_ONLY = ["src/app/(app)/bugs/"];

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tsxFiles(p));
    else if (p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

/** The code a person could see: comments and process.env reads are not text on a screen. */
const visible = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/process\.env\.[A-Z0-9_]+/g, "");

describe("no environment variable names reach a company's screen", () => {
  const files = [...tsxFiles(join(ROOT, "src/app/(app)")), ...tsxFiles(join(ROOT, "src/components"))]
    .map((f) => relative(ROOT, f))
    .filter((f) => !PLATFORM_ONLY.some((p) => f.startsWith(p)));

  it("scans the app", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("names no env var outside the platform page", () => {
    const hits = files.flatMap((f) =>
      (visible(readFileSync(join(ROOT, f), "utf8")).match(/\b(ANTHROPIC|QBO|STRIPE|SUPABASE|NEXT_PUBLIC)_[A-Z_]+\b/g) ?? []).map((m) => `${f}: ${m}`),
    );
    expect(hits).toEqual([]);
  });

  it("Settings shows QuickBooks only once North can connect to it, and no AI status or model id", () => {
    const s = readFileSync(join(ROOT, "src/app/(app)/settings/page.tsx"), "utf8");
    expect(s).toContain('{qboConfigured() && (\n              <Section title="QuickBooks">');
    expect(s).not.toContain("AiStatus");
    expect(visible(s)).not.toMatch(/claude-[a-z0-9-]+/);
  });

  it("the AI status lives on the platform page, reading the one model setting", () => {
    const s = readFileSync(join(ROOT, "src/app/(app)/bugs/page.tsx"), "utf8");
    expect(s).toContain("isPlatformAdmin(supabase)");
    expect(s).toContain("<AiStatus configured={!!process.env.ANTHROPIC_API_KEY} model={DEFAULT_MODEL} />");
    expect(readFileSync(join(ROOT, "src/app/api/ai-health/route.ts"), "utf8")).toContain("await requirePlatformAdmin()");
  });
});
