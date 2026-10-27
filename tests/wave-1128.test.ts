import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { costOf } from "@/lib/ai-cost";
import { estimateTierFor, overFullEstimateAllowance } from "@/lib/plans";
import { SCREEN_ROOTS } from "@/lib/assistant-protocol";
import { SCREENS } from "@/lib/nort/screens";

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

describe("cn-v1128 — the estimate allowance is enforced", () => {
  it("a trial runs on Handyman's line; a real tier on its own; unknown on none", () => {
    expect(estimateTierFor("trial")).toBe("handyman");
    expect(estimateTierFor("crew")).toBe("crew");
    expect(estimateTierFor("company")).toBe("company");
    expect(estimateTierFor(null)).toBeNull();
    expect(estimateTierFor("mystery")).toBeNull();
  });
  it("over the line is degrade, never refuse: 40 on Handyman, 120 on Crew, never on Company or unknown", () => {
    expect(overFullEstimateAllowance("handyman", 39)).toBe(false);
    expect(overFullEstimateAllowance("handyman", 40)).toBe(true);
    expect(overFullEstimateAllowance("crew", 120)).toBe(true);
    expect(overFullEstimateAllowance("company", 99_999)).toBe(false);
    expect(overFullEstimateAllowance(null, 99_999)).toBe(false);
  });
  it("the gate reads the count and the plan, the run ticks once after the input checks, the model rides every estimator run, and the draft says it", () => {
    const a = src("src/app/(app)/quotes/actions.ts");
    expect(a).toContain("Promise.all([fullEstimatesThisMonth(orgId), orgPlanTier(orgId)])");
    expect(a).toContain("void noteEstimateRun((org as { id?: string } | null)?.id);");
    expect(a).toContain('model: over ? modelFor("routine") : modelFor("reasoning")');
    expect(a.match(/runEstimator\([^)]*gate\.model\)/g)?.length).toBe(3);
    expect(a).toContain('const model = modelFor("reasoning");'); // the supplier read is never counted
    expect(a.match(/questions: \[\.\.\.gate\.notes, \.\.\.out\.questions\]/g)?.length).toBe(3);
    expect(a).not.toMatch(/surface: "estimator", usage[^\n]*\n?[^\n]*DEFAULT_MODEL/);
    expect(a).toContain("so this one ran on the lighter model");
  });
  it("the run tick is counted, never the model rounds; the count fails open", () => {
    const c = src("src/lib/ai-cost.ts");
    expect(c).toContain('.eq("surface", "estimator:run")');
    expect(c).toContain('p_surface: "estimator:run"');
    expect(c).toContain("if (error || !data) return 0;");
    expect(c).toContain('if (error) reportError("noteEstimateRun", error, { orgId });');
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
    const header = y.indexOf('<h2 className="text-sm font-semibold text-slate-900">Tasks &amp; Reminders</h2>');
    const link = y.indexOf('<Link href="/tasks" className="ml-auto');
    const add = y.indexOf("<AddReminderLine");
    expect(header).toBeGreaterThan(0);
    expect(link).toBeGreaterThan(header);
    expect(add).toBeGreaterThan(link);
    expect(y.slice(link, add)).toContain("All Reminders");
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
