import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { heldJobDueFilter, inquiryDueFilter, quoteFollowUpState } from "./due-filters";

/**
 * THE DAY A PERSON PICKED IS THE DAY IT COMES BACK (release/w1a seam fixes). Nort's inquiry.snooze,
 * quote.followUp and the hold picker all promise a day; Needs You has to keep it.
 *
 * The feeders filter in the database with PostgREST `.or()` strings, so these tests run those very
 * strings over rows with a small evaluator of the grammar they use (col.is.null, col.lte.v,
 * col.lt.v, col.eq.v, and(...)), the way PostgREST reads them: a comparison against null is false.
 */
type Row = Record<string, string | null>;

function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quoted = false;
  let cur = "";
  for (const ch of s) {
    if (ch === '"') quoted = !quoted;
    if (!quoted && ch === "(") depth++;
    if (!quoted && ch === ")") depth--;
    if (!quoted && depth === 0 && ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}
function term(t: string, row: Row): boolean {
  if (t.startsWith("and(")) return splitTop(t.slice(4, -1)).every((x) => term(x, row));
  if (t.startsWith("or(")) return splitTop(t.slice(3, -1)).some((x) => term(x, row));
  const [col, op, ...rest] = t.split(".");
  const v = rest.join(".").replace(/^"|"$/g, "");
  const cell = row[col] ?? null;
  if (op === "is") return v === "null" ? cell === null : false;
  if (cell === null) return false;
  if (op === "eq") return cell === v;
  if (op === "lte") return cell <= v;
  if (op === "lt") return cell < v;
  throw new Error(`unknown operator ${op}`);
}
/** Does this row pass `.or(filter)`? */
const passes = (filter: string, row: Row) => splitTop(filter).some((t) => term(t, row));

const TODAY = "2026-09-27";
const TOMORROW = "2026-09-28";
const src = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

describe("a lead on Needs You: new or contacted, it follows its follow-up day", () => {
  const due = (row: Row) => passes(inquiryDueFilter(TODAY), row);

  it("a NEW lead snoozed to tomorrow is not listed today (Nort's 'bring the Karen lead back Monday')", () => {
    expect(due({ status: "new", next_follow_up_at: TOMORROW })).toBe(false);
  });

  it("a new lead with no day, or today's, or a past day is listed: a fresh lead still shows the moment it lands", () => {
    expect(due({ status: "new", next_follow_up_at: null })).toBe(true);
    expect(due({ status: "new", next_follow_up_at: TODAY })).toBe(true);
    expect(due({ status: "new", next_follow_up_at: "2026-09-20" })).toBe(true);
  });

  it("a contacted lead reads the same rule", () => {
    expect(due({ status: "contacted", next_follow_up_at: TOMORROW })).toBe(false);
    expect(due({ status: "contacted", next_follow_up_at: TODAY })).toBe(true);
    expect(due({ status: "contacted", next_follow_up_at: null })).toBe(true);
  });

  it("the inquiry feeder filters with it, and no longer lets every 'new' lead through", () => {
    const query = src("src/lib/action-items/query.ts");
    expect(query).toContain(".or(inquiryDueFilter(todayStr))");
    expect(query).not.toContain("status.eq.new,next_follow_up_at");
  });
});

describe("the row's Snooze Until on a lead is Nort's inquiry.snooze, not a contact", () => {
  it("snooze dispatches inquiry.snooze with the day; Schedule stays the follow-up after a contact", async () => {
    const executeAction = vi.fn(async () => ({ ok: true }));
    vi.doMock("@/lib/actions/execute", () => ({ executeAction }));
    vi.doMock("next/cache", () => ({ revalidatePath: vi.fn() }));
    const { dispatchAction } = await import("./dispatch");
    expect(await dispatchAction({ kind: "inquiry", id: "i-karen", verb: "snooze", payload: { date: TOMORROW } })).toEqual({ ok: true, error: undefined });
    expect(executeAction).toHaveBeenLastCalledWith("inquiry.snooze", { id: "i-karen", date: TOMORROW }, { source: "ui" });
    await dispatchAction({ kind: "inquiry", id: "i-karen", verb: "schedule", payload: { date: TOMORROW } });
    expect(executeAction).toHaveBeenLastCalledWith("inquiry.contact", { id: "i-karen", follow_up_date: TOMORROW }, { source: "ui" });
    vi.doUnmock("@/lib/actions/execute");
    vi.doUnmock("next/cache");
  });
});

describe("an estimate's follow-up day (0366 quotes.follow_up_at, Nort's quote.followUp)", () => {
  it("a day after today keeps it off the list; today or earlier brings it back; no day leaves the old rule", () => {
    expect(quoteFollowUpState(TOMORROW, TODAY)).toBe("later");
    expect(quoteFollowUpState(TODAY, TODAY)).toBe("due");
    expect(quoteFollowUpState("2026-09-01", TODAY)).toBe("due");
    expect(quoteFollowUpState(null, TODAY)).toBe("none");
    expect(quoteFollowUpState(undefined, TODAY)).toBe("none");
  });

  it("the quote_awaiting feeder reads follow_up_at (without it before 0366) and lets the day win over the quiet rule", () => {
    const query = src("src/lib/action-items/query.ts");
    expect(query).toContain("const withDay = await read(`${base}, follow_up_at`);");
    expect(query).toContain("return withDay.error && isMissingColumn(withDay.error) ? read(base) : withDay;");
    expect(query).toContain("const followUp = quoteFollowUpState(q.follow_up_at, todayStr);");
    expect(query).toContain('if (followUp === "later") continue;');
    expect(query).toContain('if (followUp === "none" && !quiet && !expiring) continue;');
  });
});

describe("a held job comes back on the day its hold picked (0366 jobs.hold_until)", () => {
  const CUTOFF = "2026-09-20T17:00:00.000Z"; // a week before now
  const due = (row: Row) => passes(heldJobDueFilter(TODAY, CUTOFF), row);

  it("held three weeks out: not listed a week later, even though it hasn't been touched since", () => {
    expect(due({ hold_until: "2026-10-18", updated_at: "2026-09-19T15:00:00.000Z" })).toBe(false);
  });

  it("held until tomorrow: not listed today; held until today (or a past day): listed, however recently touched", () => {
    expect(due({ hold_until: TOMORROW, updated_at: "2026-09-26T15:00:00.000Z" })).toBe(false);
    expect(due({ hold_until: TODAY, updated_at: "2026-09-26T15:00:00.000Z" })).toBe(true);
    expect(due({ hold_until: "2026-09-25", updated_at: "2026-09-26T15:00:00.000Z" })).toBe(true);
  });

  it("a hold from before 0366 (no day) keeps the week-untouched rule", () => {
    expect(due({ hold_until: null, updated_at: "2026-09-19T15:00:00.000Z" })).toBe(true);
    expect(due({ hold_until: null, updated_at: "2026-09-26T15:00:00.000Z" })).toBe(false);
  });

  it("the held-job feeder uses it when the column exists, and the old read alone before 0366", () => {
    const query = src("src/lib/action-items/query.ts");
    expect(query).toContain(".or(heldJobDueFilter(todayStr, heldCutoff))");
    expect(query).toMatch(/if \(heldRes\.error && isMissingColumn\(heldRes\.error\)\) \{\s*heldRes = await supabase\s*\.from\("jobs"\)\s*\.select\(heldBase\)\s*\.eq\("status", "on_hold"\)\s*\.lt\("updated_at", heldCutoff\)/);
  });
});
