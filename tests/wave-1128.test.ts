import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { costOf, tierOfUsage } from "@/lib/ai-cost";
import { PLANS } from "@/lib/plans";
import { SCREEN_ROOTS } from "@/lib/assistant-protocol";
import { SCREENS } from "@/lib/nort/screens";
import { dict } from "@/lib/i18n";

const src = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");

describe("cn-v1128 — the model move", () => {
  it("the four defaults are the 5.5 line; env overrides stay", () => {
    expect(src("src/lib/anthropic.ts")).toContain('process.env.ANTHROPIC_MODEL || "claude-opus-5-5"');
    const cost = src("src/lib/ai-cost.ts");
    expect(cost).toContain('return envOverride || "claude-opus-5-5";');
    expect(cost).toContain('process.env.ANTHROPIC_MODEL_ROUTINE || "claude-sonnet-5-5"');
    expect(cost).toContain('process.env.ANTHROPIC_MODEL_CHEAP || "claude-haiku-5-5"');
    expect(src("src/app/api/site-chat/route.ts")).toContain('process.env.SITE_CHAT_MODEL || "claude-haiku-5-5"');
    expect(src("src/app/api/ai-health/route.ts")).toContain('["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]');
  });
  it("the ledger prices every current model at list, sonnet-5 at its real price, and an unknown model never reads as cheap", () => {
    const m = { input_tokens: 1_000_000, output_tokens: 1_000_000 };
    expect(costOf("claude-opus-5-5", m)).toBeCloseTo(24, 6);
    expect(costOf("claude-sonnet-5-5", m)).toBeCloseTo(12, 6);
    expect(costOf("claude-haiku-5-5", m)).toBeCloseTo(0.6, 6);
    expect(costOf("claude-fable-5-1", m)).toBeCloseTo(60, 6);
    expect(costOf("claude-sonnet-5", m)).toBeCloseTo(12, 6);
    expect(costOf("claude-opus-4-8", m)).toBeCloseTo(30, 6);
    expect(costOf("claude-something-new", m)).toBeGreaterThanOrEqual(costOf("claude-fable-5-1", m));
  });
});

describe("cn-v1128 — the estimate allowance became the one usage meter (cn-v1140)", () => {
  it("the estimate count is gone from the ladder and the ledger: no estimates-per-month, no run tick, no 'estimator:run' surface", () => {
    for (const p of PLANS) expect(p).not.toHaveProperty("fullEstimatesPerMonth");
    const plans = src("src/lib/plans.ts");
    for (const gone of ["fullEstimatesPerMonth", "overFullEstimateAllowance", "estimateTierFor"]) expect(plans).not.toContain(`export function ${gone}`);
    expect(plans).not.toMatch(/fullEstimatesPerMonth:/);
    const c = src("src/lib/ai-cost.ts");
    for (const gone of ["fullEstimatesThisMonth", "noteEstimateRun"]) expect(c).not.toContain(`export async function ${gone}`);
    expect(c).not.toContain('"estimator:run"');
    expect(src("src/app/(app)/quotes/actions.ts")).not.toContain("noteEstimateRun(");
  });
  it("past 100% of the month's usage is lighter, never a refusal; under it is full", () => {
    expect(tierOfUsage({ state: "out" })).toBe("lighter");
    expect(tierOfUsage({ state: "almost" })).toBe("full");
    expect(tierOfUsage({ state: "watch" })).toBe("full");
    expect(tierOfUsage({ state: "fine" })).toBe("full");
  });
  it("the gate reads the one meter after the standing gate, the model rides every estimator run, and the draft says it in usage words with the reset day", () => {
    const a = src("src/app/(app)/quotes/actions.ts");
    expect(a).toContain("const usage = await usageFor(orgId);");
    expect(a).toContain("const tier = tierOfUsage(usage);");
    expect(a.indexOf("const gate = await aiAllowed(orgId, undefined")).toBeLessThan(a.indexOf("const usage = await usageFor(orgId);"));
    expect(a).toContain('model: tier === "lighter" ? modelFor("routine") : modelFor("reasoning")');
    expect(a.match(/runEstimator\([^)]*gate\.model\)/g)?.length).toBe(3);
    expect(a).toContain('const model = modelFor("reasoning");'); // the supplier read is a transcription, always the reasoning model
    expect(a.match(/questions: \[\.\.\.gate\.notes, \.\.\.out\.questions\]/g)?.length).toBe(3);
    expect(a).not.toMatch(/surface: "estimator", usage[^\n]*\n?[^\n]*DEFAULT_MODEL/);
    // In the caller's language, and naming no purchase door (the App Store app reaches it; Apple 3.1.1).
    expect(a).toContain("const lang = await callerLang(ctx.supabase, ctx.userId);");
    expect(a).toContain('notes.push(fillText(translator(lang)("us_estimatorLighter"), { date: shortDate(usage.resetOn, lang) }));');
    expect(a).not.toContain("Add usage or upgrade in Settings");
    expect(dict("en").us_estimatorLighter).toBe("Your company's usage for this month is used up, so this estimate runs on the lighter model until {date}.");
    expect(dict("es").us_estimatorLighter).toBe("El uso de tu empresa por este mes se agotó, así que este presupuesto corre en el modelo más ligero hasta el {date}.");
    expect(a).not.toContain("full estimates");
  });
  it("Nort's chat route picks the routine model for the lighter month on the same row it read, and says why in the volatile block", () => {
    const r = src("src/app/api/chat/route.ts");
    expect(r).toContain("const usage = await usageFor(orgId, org as UsageOrg | null);");
    expect(r).toContain('const lighter = tierOfUsage(usage) === "lighter";');
    expect(r).toContain('const model = lighter ? modelFor("routine") : isStaffCaller ? modelFor("reasoning") : modelFor("routine");');
    expect(r).toContain("USAGE: this company's usage for the month is used up, so you are running on the lighter model until ${resets}.");
    expect(r).not.toContain("add usage or upgrade"); // no purchase door in Nort's line: the App Store app has none
    expect(r.indexOf("volatilePrompt += `\\n\\nUSAGE:")).toBeGreaterThan(r.indexOf("let volatilePrompt"));
    // The gate still comes first: a lapsed company never reaches the meter.
    expect(r.indexOf("if (!gate.ok) return new Response(gate.why, { status: 429 });")).toBeLessThan(r.indexOf("const usage = await usageFor(orgId"));
  });
  it("both ceiling refusals say the true window and one action", () => {
    expect(src("src/app/api/chat/route.ts")).toContain("Nort has hit your company's AI ceiling for the last 30 days. Message us and we'll lift it.");
    expect(src("src/app/(app)/quotes/actions.ts")).toContain("Your company has hit its AI ceiling for the last 30 days. Message us and we'll lift it.");
    expect(src("src/app/(app)/quotes/actions.ts")).not.toContain("or the office can raise it");
  });
});

describe("cn-v1128 — Reminders have a standing door and Nort can drive there", () => {
  it("My Day's card header carries All Reminders unconditionally, before the add line", () => {
    const y = src("src/app/(app)/planner/your-list.tsx");
    // Since cn-v1138 the heading and the door read their words through t() (lib/words/myday; English unchanged).
    const header = y.indexOf('<h2 className="text-sm font-semibold text-slate-900">{t("md_tasksAndReminders")}</h2>');
    const link = y.indexOf('<Link href="/tasks" className="ml-auto');
    const add = y.indexOf("<AddReminderLine");
    expect(header).toBeGreaterThan(0);
    expect(link).toBeGreaterThan(header);
    expect(add).toBeGreaterThan(link);
    expect(y.slice(link, add)).toContain('t("md_allReminders")');
    expect(dict("en").md_tasksAndReminders).toBe("Tasks & Reminders");
    expect(dict("en").md_allReminders).toBe("All Reminders");
    expect(y.slice(header, link)).not.toContain("restCount");
  });
  it("tasks is a drivable root, a screen, and the product map names the full list", () => {
    expect(SCREEN_ROOTS).toContain("tasks");
    expect(SCREENS.some((s) => s.path === "/tasks" && s.name === "Reminders")).toBe(true);
    expect(src("src/lib/nort-product-map.ts")).toContain("All Reminders opens the full list, /tasks");
  });
});

describe("cn-v1128 — search comes back newest-first with live work first", () => {
  it("the four record reads order by updated_at and jobs sort by the status spine, cancelled last", () => {
    const r = src("src/app/api/search/route.ts");
    expect(r.match(/\.order\("updated_at", \{ ascending: false \}\)/g)?.length).toBe(4);
    expect(r).toContain("liveFirst(jobs.data ?? []).slice(0, 6)");
    expect(r).toContain("JOB_STATUS_PRIORITY[a.status");
  });
});
