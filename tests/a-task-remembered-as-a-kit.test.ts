import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A PRICED TASK IS REMEMBERED AS A KIT, AND A KIT IS A TASK ON THE NEXT VISIT (W4, cn-v1076).
 *
 * One rule writes the kit (lib/estimate/kit-from-task); one select shape reads task kits
 * (lib/estimate/task-kits); one expansion prices them (expandTaskKit) on the Inspector's preview
 * and on the estimate's seed. These pins read the source so a door cannot quietly fall off the
 * rule; the rules themselves are tested in their own files.
 */
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const body = (text: string, fn: string): string => {
  const at = text.indexOf(fn);
  expect(at, `${fn} not found`).toBeGreaterThan(-1);
  const next = text.indexOf("\nexport ", at + fn.length);
  return text.slice(at, next === -1 ? undefined : next);
};

describe("the door on the estimate", () => {
  const builder = src("src/app/(app)/quotes/new/quote-builder.tsx");
  it("sits inside the task breakdown and calls the one action with the line's own breakdown", () => {
    expect(builder).toContain('import { rememberTaskAsKit } from "../../price-list/kit-actions";');
    expect(builder).toContain('import { kitFromTaskDetail, kitNameFromLine } from "@/lib/estimate/kit-from-task";');
    const breakdown = builder.slice(builder.indexOf("function TaskBreakdown("), builder.indexOf("export function QuoteBuilder("));
    expect(breakdown).toContain("Remember As A Kit");
    expect(breakdown).toContain("rememberTaskAsKit({ name: kitName, unit: kitUnit, detail: d })");
    // The pure rule speaks BEFORE the round trip, so the door never opens onto a refusal.
    expect(breakdown).toContain("kitFromTaskDetail(d, { name: kitName || \"kit\", unit: kitUnit })");
  });
  it("the page hands the builder the task kits by name", () => {
    const page = src("src/app/(app)/quotes/new/page.tsx");
    expect(page).toContain("taskKits={taskKits.map(({ id, name, unit }) => ({ id, name, unit }))}");
  });
});

describe("the action", () => {
  const fn = body(src("src/app/(app)/price-list/kit-actions.ts"), "export async function rememberTaskAsKit(");
  it("is the office's, coerces the breakdown, applies the rule, writes through rememberKit and revalidates", () => {
    expect(fn).toContain("await requireStaff()");
    expect(fn).toContain("coerceTaskDetail(input?.detail)");
    expect(fn).toContain("kitFromTaskDetail(detail, { name: input?.name ?? \"\", unit: input?.unit ?? \"\" })");
    expect(fn).toContain("rememberKit(ctx.supabase, made.value)");
    expect(fn).toContain('revalidatePath("/price-list")');
  });
});

describe("the rule writes nothing silently", () => {
  const rule = src("src/lib/estimate/kit-from-task.ts");
  it("reads back the kit's and the lines' ids, links by code to live items, keeps one kit per name", () => {
    expect(rule).toMatch(/\.insert\(\{ name: value\.kit\.name, unit: value\.kit\.unit, labor_minutes: value\.kit\.labor_minutes \}\)\s*\.select\("id"\)/);
    expect(rule).toContain('from("kit_items").insert(rows).select("id")');
    expect(rule).toContain('.in("code", codes).eq("archived", false)');
    expect(rule).toContain('.ilike("name", likeLiteral(value.kit.name))');
    expect(rule).toContain('from("kits").delete().eq("id", kitId)');
  });
});

describe("the inspector", () => {
  it("loads the task kits with the tolerant rungs and hands them over with every money field dropped", () => {
    const page = src("src/app/(app)/appointments/[id]/page.tsx");
    expect(page).toContain('firstThatWorks(taskKitSelectRungs().map((sel) => () => supabase.from("kits").select(sel).order("name")))');
    expect(page).toContain("taskKits={kitsWithoutMoney(taskKitsFrom(taskKitsRead.data))}");
  });
  it("previews a picked kit through THE expandTaskKit the estimate seeds from", () => {
    const inspector = src("src/app/(app)/appointments/[id]/inspector.tsx");
    expect(inspector).toContain('import { expandTaskKit, type TaskKit } from "@/lib/estimate/task-lines";');
    expect(inspector).toContain("expandTaskKit(t, kit, KIT_PREVIEW_PRICING)");
    expect(inspector).toContain('aria-label="Kit"');
    expect(inspector).toContain('placeholder="units"');
  });
});

describe("the seed", () => {
  it("hands the task kits to taskLines, so a task with a kit prices from it", () => {
    const page = src("src/app/(app)/quotes/new/page.tsx");
    expect(page).toContain('firstThatWorks(taskKitSelectRungs().map((sel) => () => supabase.from("kits").select(sel).order("name")))');
    expect(page).toContain("const taskKitMap = new Map(taskKits.map((k) => [k.id, k]));");
    expect(page).toMatch(/taskLines\(g\.tasks, \{ book: taskBook, rate: seedRate, pricing: seedPricing, kits: taskKitMap, group: g\.label \}\)/);
  });
});

describe("the kit manager says what a task kit is", () => {
  it("shows the hours per unit on the kit and lets Edit Kit set them; updateKit writes them", () => {
    const manager = src("src/app/(app)/price-list/kits-manager.tsx");
    expect(manager).toContain("Task · {hoursPerUnitText(Number(k.labor_minutes))} per {k.unit || \"ea\"}");
    expect(manager).toContain("Hours Per Unit");
    expect(manager).toContain("labor_minutes: hours === null ? null : Math.round(hours * 60), unit: unit.trim() || null");
    const update = body(src("src/app/(app)/price-list/kit-actions.ts"), "export async function updateKit(");
    expect(update).toContain("patch.labor_minutes =");
    expect(update).toContain("patch.unit =");
    expect(update).toContain('.update(patch)');
    expect(src("src/app/(app)/price-list/page.tsx")).toContain('taskKitSelectRungs("category")');
  });
});
