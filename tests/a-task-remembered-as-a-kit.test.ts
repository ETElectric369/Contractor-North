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
    expect(builder).toContain('import { kitFromTaskDetail, kitNameFromLine, kitSummary } from "@/lib/estimate/kit-from-task";');
    const breakdown = builder.slice(builder.indexOf("function TaskBreakdown("), builder.indexOf("export function QuoteBuilder("));
    expect(breakdown).toContain("Remember As A Kit");
    expect(breakdown).toContain("rememberTaskAsKit({ name: kitName, unit: kitUnit, detail: d, category: kitCategory.trim() || null })");
    // The pure rule speaks BEFORE the round trip, so the door never opens onto a refusal.
    expect(breakdown).toContain("kitFromTaskDetail(d, { name: kitName || \"kit\", unit: kitUnit })");
  });
  it("the page hands the builder the task kits by name", () => {
    const page = src("src/app/(app)/quotes/new/page.tsx");
    expect(page).toContain("taskKits={taskKits}");
  });
});

describe("the action", () => {
  const fn = body(src("src/app/(app)/price-list/kit-actions.ts"), "export async function rememberTaskAsKit(");
  it("is the office's, coerces the breakdown, applies the rule, writes through rememberKit and revalidates", () => {
    expect(fn).toContain("await requireStaff()");
    expect(fn).toContain("coerceTaskDetail(input?.detail)");
    expect(fn).toContain("kitFromTaskDetail(detail, { name: input?.name ?? \"\", unit: input?.unit ?? \"\", category: typeof input?.category === \"string\" ? input.category : null })");
    expect(fn).toContain("rememberKit(ctx.supabase, made.value)");
    expect(fn).toContain('revalidatePath("/price-list")');
  });
});

describe("the rule writes nothing silently", () => {
  const rule = src("src/lib/estimate/kit-from-task.ts");
  it("reads back the kit's and the lines' ids, links by code to live items, keeps one kit per name", () => {
    expect(rule).toMatch(/\.insert\(\{ name: value\.kit\.name, unit: value\.kit\.unit, labor_minutes: value\.kit\.labor_minutes, category: value\.kit\.category \?\? null \}\)\s*\.select\("id"\)/);
    expect(rule).toContain('from("kit_items").insert(rows).select("id")');
    expect(rule).toContain('.in("code", codes).eq("archived", false)');
    // One name, one kit — compared in code, case-blind, so his "*" is a star and not a wildcard.
    expect(rule).toContain('await sb.from("kits").select("id, name")');
    expect(rule).toContain("String(k.name ?? \"\").trim().toLowerCase() === wanted");
    expect(rule).toContain('from("kits").delete().eq("id", kitId)');
  });
});

describe("the inspector", () => {
  it("loads the task kits with the tolerant rungs and hands them over with every money field dropped", () => {
    const page = src("src/app/(app)/appointments/[id]/page.tsx");
    // The read SAYS how it went (item 3): readTaskKits over the same rungs, its state on the page, a failure in the ops sink.
    // Through the service client, scoped to the visit's company (audit v1085, carried [31]): a crew lead
    // cannot read price_list_items, so his own read came back with every book link empty and no error.
    // + "category": the scope a kit is filed under lights the Inspector's offer row (field feedback 10-13, item 2)
    expect(page).toContain('? readTaskKits((sel) => createServiceClient().from("kits").select(sel).eq("org_id", apptOrg).order("name"), "category")');
    expect(page).toContain(': Promise.resolve<TaskKitsRead>({ kits: [], rows: null, rung: 0, state: "ok" })'); // no visit to see: no read
    // The kits reach the Inspector whatever the switch says; the switch hides the PICKER (carried [39]).
    expect(page).toContain("taskKits={kitsWithoutMoney(taskKitsRead.kits)}");
    expect(page).toContain("kitsPicker={kitsOn}");
    expect(page).toContain("kitsNote={kitsOn ? kitsReadWords(taskKitsRead.state) : null}");
    expect(page).toContain('kitsUnread={taskKitsRead.state === "failed"}');
    expect(page).toContain('reportError("appointment:kits"');
  });
  it("previews a picked kit through THE expandTaskKit the estimate seeds from", () => {
    const inspector = src("src/app/(app)/appointments/[id]/inspector.tsx");
    expect(inspector).toContain('import { expandTaskKit, type TaskKit } from "@/lib/estimate/task-lines";');
    expect(inspector).toContain("expandTaskKit(t, kit, KIT_PREVIEW_PRICING)");
    expect(inspector).toContain('aria-label="Kit"');
    expect(inspector).toContain('placeholder="units"');
  });
});

describe("Start The Job on a visit", () => {
  it("reads the task kits when a task picked one and births through the same expansion", () => {
    const fn = body(src("src/app/(app)/appointments/actions.ts"), "export async function createJobFromAppointment(");
    expect(fn).toContain('readTaskKits((sel) => supabase.from("kits").select(sel).order("name"))');
    expect(fn).toContain("tasksFromVisit(answered, new Map((kitsRead?.kits ?? []).map((k) => [k.id, k])))");
    expect(fn).toContain('reportError("createJobFromAppointment:kits"');
    expect(fn).toContain("kitsReadWords(kitsRead.state)"); // the same words every page says
  });
});

describe("the plain kit pickers never offer a task kit", () => {
  it("the new estimate, the estimate editor and the invoice keep task kits out of Add From Kit", () => {
    expect(src("src/app/(app)/quotes/new/page.tsx")).toContain("partsKitsOnly(kits ?? [])");
    expect(src("src/app/(app)/quotes/[id]/page.tsx")).toContain("kits={(kitDoors ? partsKitsOnly(kits ?? []) : []) as never}");
    expect(src("src/app/(app)/billing/[id]/page.tsx")).toContain("kits={(kitDoors ? partsKitsOnly(kits ?? []) : []) as any}");
  });
  it("the builder keys a task's breakdown by the task, not the row, and takes the Kits switch", () => {
    const builder = src("src/app/(app)/quotes/new/quote-builder.tsx");
    expect(builder).toContain("key={it.detail.task_id || `line-${idx}`}");
    expect(src("src/app/(app)/quotes/new/page.tsx")).toContain("kitsOn={kitDoors}");
  });
  it("the units box on a kit-built line re-derives the kit through the one rule and renames the line", () => {
    const builder = src("src/app/(app)/quotes/new/quote-builder.tsx");
    const breakdown = builder.slice(builder.indexOf("function TaskBreakdown("), builder.indexOf("export function QuoteBuilder("));
    expect(breakdown).toContain("reexpandTaskDetail(d, n, fromKit, { orgDefaultPct: pricing.orgDefaultPct ?? 0, levelPct: pricing.levelPct })");
    expect(breakdown).toContain("description: lineNameWithUnits(line.description, d.units, next.units)");
    expect(breakdown).toContain('aria-label="Units"');
    // A blank mid-typing is not a count; a hand-typed Unit $ stands through the change.
    expect(breakdown).toContain("if (!fromKit || !(n > 0)) return;");
    expect(breakdown).toContain("onChange(hand ? { ...priced, unit_price: line.unit_price } : priced);");
  });
});

describe("the seed", () => {
  it("hands the task kits to taskLines, so a task with a kit prices from it", () => {
    const page = src("src/app/(app)/quotes/new/page.tsx");
    expect(page).toContain('readTaskKits((sel) => supabase.from("kits").select(sel).order("name"))');
    expect(page).toContain("const taskKits = kitsRead.kits;");
    expect(page).toContain("kitDoors && kitsReadWords(kitsRead.state) && ("); // the banner beside the price list's
    expect(page).toContain('reportError("quotes/new:kits"');
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
    expect(src("src/app/(app)/price-list/page.tsx")).toContain('readTaskKits((sel) => supabase.from("kits").select(sel).order("name"), "category")');
  });
});
