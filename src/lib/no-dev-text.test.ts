import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

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

  it("no server action or route handler hands a person an env var, a key or a provider's error", () => {
    // The .ts half (round 2): a route handler's body and an action's `error` reach a screen too.
    // Nort's 503 said "Add ANTHROPIC_API_KEY to your environment", and a customer paying an invoice
    // was told "Add STRIPE_SECRET_KEY to enable". Only STRING LITERALS count: an identifier or a
    // process.env read is code, not words. Exempt: the platform page and its AI check, Stripe's own
    // webhook (only Stripe's servers call it), and the TTS ?diag=1 check a developer opens by URL.
    const EXEMPT = [...PLATFORM_ONLY, "src/app/api/ai-health/", "src/app/api/stripe/webhook/", "src/app/api/tts/"];
    const tsFiles = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const p = join(dir, name);
        return statSync(p).isDirectory() ? tsFiles(p) : /\.tsx?$/.test(p) && !/\.(test|db-suite)\.tsx?$/.test(p) ? [p] : [];
      });
    // The compiler's own reading of the file: a regex can't tell a template from a backtick in a regex.
    const strings = (f: string): string[] => {
      const sf = ts.createSourceFile(f, readFileSync(join(ROOT, f), "utf8"), ts.ScriptTarget.Latest, true, f.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
      const out: string[] = [];
      const walk = (n: ts.Node) => {
        if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) out.push(n.text);
        else if (ts.isTemplateExpression(n)) out.push(n.getText(sf));
        else if (ts.isJsxText(n)) out.push(n.getText(sf));
        ts.forEachChild(n, walk);
      };
      walk(sf);
      return out;
    };
    const DEV = /\b(ANTHROPIC|QBO|STRIPE|SUPABASE|NEXT_PUBLIC|OPENAI|ELEVENLABS|GOOGLE_OAUTH)_[A-Z_]+\b|\bin Vercel\b|\bthe API key\b|\bmigration \d{4}\b/;
    // A literal that IS a name is a lookup (e?.message?.includes("ANTHROPIC_API_KEY")), not words.
    const JUST_A_NAME = /^[A-Z][A-Z0-9_]+$/;
    const hits = tsFiles(join(ROOT, "src/app"))
      .map((f) => relative(ROOT, f))
      .filter((f) => !EXEMPT.some((p) => f.startsWith(p)))
      // Only a file whose text could hold a hit is worth the compiler's time.
      .filter((f) => DEV.test(visible(readFileSync(join(ROOT, f), "utf8"))))
      .flatMap((f) =>
        strings(f)
          .filter((lit) => DEV.test(visible(lit)) && !JUST_A_NAME.test(lit))
          .map((lit) => `${f}: ${lit.slice(0, 120)}`),
      );
    expect(hits).toEqual([]);
  }, 30_000);

  it("the voice door says it couldn't hear, never which provider refused", () => {
    // use-dictation shows the route's `error` to the person talking.
    const s = readFileSync(join(ROOT, "src/app/api/transcribe/route.ts"), "utf8");
    const errors = [...s.matchAll(/NextResponse\.json\(\{ error: ([^}]+) \}/g)].map((m) => m[1]);
    expect(errors.length).toBeGreaterThan(3);
    for (const e of errors) expect(e).not.toMatch(/ElevenLabs|Whisper|OpenAI|STT|key|\$\{/);
  });

  it("the AI status lives on the platform page, reading the one model setting", () => {
    const s = readFileSync(join(ROOT, "src/app/(app)/bugs/page.tsx"), "utf8");
    expect(s).toContain("isPlatformAdmin(supabase)");
    expect(s).toContain("<AiStatus configured={!!process.env.ANTHROPIC_API_KEY} model={DEFAULT_MODEL} />");
    expect(readFileSync(join(ROOT, "src/app/api/ai-health/route.ts"), "utf8")).toContain("await requirePlatformAdmin()");
  });
});
