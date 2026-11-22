import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { draftInvoiceState, heldJobState, lateInvoiceFilter, quoteNoAnswerFilter } from "./due-filters";
import { closingState } from "@/lib/estimate/closing";

/**
 * THE DAY A PERSON PICKED IS THE DAY IT COMES BACK (release/w1a seam fixes). The hold picker
 * promises a day; Needs You has to keep it. A lead has no day since cn-v1170, an estimate none since
 * cn-v1172 (the Closing list is the reminder).
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

describe("a lead has no follow-up day (cn-v1170): the Leads list is the reminder", () => {
  it("no lead filter of Needs You's own: the build reads the one rule, and no row reads a lead's day", () => {
    const query = src("src/lib/action-items/query.ts");
    expect(query).not.toContain("inquiryDueFilter");
    expect(query).not.toContain("next_follow_up_at");
    expect(src("src/lib/action-items/due-filters.ts")).not.toContain("inquiryDueFilter");
  });

  it("a lead row's verbs: Not Sold keeps the lead; there is no Snooze, no Called and no Schedule verb", async () => {
    const executeAction = vi.fn(async () => ({ ok: true }));
    vi.doMock("@/lib/actions/execute", () => ({ executeAction }));
    vi.doMock("next/cache", () => ({ revalidatePath: vi.fn() }));
    const { dispatchAction } = await import("./dispatch");
    await dispatchAction({ kind: "inquiry", id: "i-dana", verb: "dismiss" });
    expect(executeAction).toHaveBeenLastCalledWith("inquiry.markLost", { id: "i-dana" }, { source: "ui" });
    // Schedule on the row is a link to the lead's file (/leads/<id>?schedule=1), never a verb.
    for (const verb of ["snooze", "do", "schedule"] as const) {
      expect(await dispatchAction({ kind: "inquiry", id: "i-dana", verb, payload: { date: TOMORROW } }), verb).toEqual({
        ok: false,
        error: "That action isn't available here.",
      });
    }
    expect(executeAction).toHaveBeenCalledTimes(1);
    vi.doUnmock("@/lib/actions/execute");
    vi.doUnmock("next/cache");
  });
});

describe("an estimate has no follow-up day (cn-v1172: \"Closing is the reminder yes\")", () => {
  it("nothing in Needs You reads or writes it: no follow-up state, no later read, no Waiting row, no Still Waiting", () => {
    const query = src("src/lib/action-items/query.ts");
    const filters = src("src/lib/action-items/due-filters.ts");
    expect(filters).not.toContain("quoteFollowUpState");
    expect(filters).not.toContain("withFollowUp");
    expect(query).not.toContain("follow_up_at");
    expect(query).not.toContain("quoteFollowUpState");
    expect(query).not.toContain("QUOTE_QUIET_DAYS");
    expect(query).not.toMatch(/kind: "quote_awaiting",[\s\S]{0,80}backOn/);
    // The one rule decides each row, fed by the last logged send.
    expect(query).toContain(".or(quoteNoAnswerFilter(todayStr, CLOSING_QUIET_DAYS, QUOTE_EXPIRY_SOON_DAYS))");
    expect(query).toContain("lastSentAt: lastSentOf.get(String(q.id)) ?? null");
  });
});

describe("a held job comes back on the day its hold picked (0366 jobs.hold_until)", () => {
  // RE-NAMED ON PURPOSE (cn-v1179): "no_day" is still its own state; the feeder now folds it (hold-pips.test).
  it("a day after today waits in the fold; today or earlier is back; no day at all is its own state (No Day Set)", () => {
    expect(heldJobState("2026-10-18", TODAY)).toBe("later");
    expect(heldJobState(TOMORROW, TODAY)).toBe("later");
    expect(heldJobState(TODAY, TODAY)).toBe("back");
    expect(heldJobState("2026-09-25", TODAY)).toBe("back");
    expect(heldJobState(null, TODAY)).toBe("no_day");
    expect(heldJobState(undefined, TODAY)).toBe("no_day");
  });

  it("no week-untouched proxy: the feeder reads every hold and splits it by its day; before 0366 the old read alone, with no Snooze", () => {
    const query = src("src/lib/action-items/query.ts");
    expect(query).not.toContain("heldJobDueFilter");
    expect(query).toContain("const state = heldJobState(until, todayStr);");
    expect(query).toContain('if (withDay && state === "later") {');
    expect(query).toContain('affordances: withDay ? AFFORDANCES.job_on_hold : ["do", "open"]');
    expect(query).toMatch(/\.eq\("status", "on_hold"\)\.lt\("updated_at", cutoff\)/);
  });
});

describe("a pile's count is the count of its rows, not the whole population (the '· 1+' fix)", () => {
  // The feeders' per-row rules, as query.ts computes them (UTC-midnight day math from todayStr).
  const todayMs = Date.parse(TODAY);
  const days = (ms: number) => Math.floor(ms / 86_400_000);
  const lateByCode = (r: Row) => {
    const daysOverDue = r.due_date ? days(todayMs - Date.parse(r.due_date)) : null;
    const daysOld = r.created_at ? days(todayMs - Date.parse(r.created_at)) : 0;
    const pastDue = daysOverDue != null && daysOverDue > 0;
    const stale = daysOld >= 30 && !(daysOverDue != null && daysOverDue <= 0);
    return pastDue || stale;
  };
  const stamps = [
    "2026-08-01T15:00:00+00:00",
    "2026-08-28T00:00:00+00:00",
    "2026-08-28T00:00:01+00:00",
    "2026-08-27T23:59:59+00:00",
    "2026-09-20T00:00:00+00:00",
    "2026-09-20T09:30:00+00:00",
    "2026-09-19T23:00:00+00:00",
    "2026-09-26T18:00:00+00:00",
  ];
  const dates = [null, "2026-09-01", "2026-09-26", TODAY, TOMORROW, "2026-10-02", "2026-10-03", "2026-12-01"];

  it("a late invoice: the database read keeps exactly the rows the feeder shows", () => {
    const f = lateInvoiceFilter(TODAY, 30);
    for (const created_at of stamps) {
      for (const due_date of dates) {
        const r = { created_at, due_date };
        expect(passes(f, r), JSON.stringify(r)).toBe(lateByCode(r));
      }
    }
  });

  it("an estimate with no answer: the read keeps every row the Closing rule lists, whatever its last send (a send is never before it was written)", () => {
    const f = quoteNoAnswerFilter(TODAY, 7, 5);
    for (const created_at of stamps) {
      for (const valid_until of dates) {
        const r = { created_at, valid_until };
        // The filter itself: written a week ago (UTC midnight), or the offer ends within five days.
        const toExpiry = valid_until ? days(Date.parse(valid_until) - todayMs) : null;
        expect(passes(f, r), JSON.stringify(r)).toBe(Date.parse(created_at) <= todayMs - 7 * 86_400_000 || (toExpiry != null && toExpiry <= 5));
        for (const lastSentAt of [null, created_at, ...stamps.filter((t) => Date.parse(t) >= Date.parse(created_at))]) {
          const st = closingState({ id: "q", status: "sent", created_at, valid_until }, { settled: false, lastSentAt, todayStr: TODAY });
          if (st.needsAttention) expect(passes(f, r), JSON.stringify({ ...r, lastSentAt })).toBe(true);
        }
      }
    }
  });

  // A late invoice's filter is EXACT (the test above), so its read's count is the pile's count. No
  // Answer Yet's is a PRE-FILTER (cn-v1172): it keeps every row the Closing rule lists, and the rule
  // then drops rows in code (a fresh send, a settled estimate), so its pile counts what the rule kept.
  it("the feeders read with them: the late-invoice filter as the exact read, the no-answer filter as the pre-filter before the Closing rule", () => {
    const query = src("src/lib/action-items/query.ts");
    expect(query).toContain(".or(lateInvoiceFilter(todayStr, INVOICE_STALE_DAYS))");
    expect(query).toContain("quoteNoAnswerFilter(todayStr, CLOSING_QUIET_DAYS, QUOTE_EXPIRY_SOON_DAYS)");
    // A won estimate past the read is its job's Jobs Needing a Day row: never a "1+" pile of wins.
    expect(query).not.toContain("counts.won_needs_a_day = codeCount(acceptedR)");
  });
});

describe("a draft invoice's place, and whether Set Aside Until… is a door on it", () => {
  it("set aside with its job going: the fold; set aside with its job over: back on the list; neither: a plain row", () => {
    expect(draftInvoiceState("2026-10-17", "in_progress", TODAY)).toEqual({ place: "waiting", canSetAside: true });
    expect(draftInvoiceState("2026-10-17", "complete", TODAY)).toEqual({ place: "finished", canSetAside: false });
    expect(draftInvoiceState("2026-10-17", "cancelled", TODAY)).toEqual({ place: "finished", canSetAside: false });
    expect(draftInvoiceState(TODAY, "scheduled", TODAY)).toEqual({ place: "now", canSetAside: true });
    expect(draftInvoiceState(null, null, TODAY)).toEqual({ place: "now", canSetAside: true });
  });

  it("a draft on a finished job (the usual draft: finishJob drafts it) offers no Set Aside, set aside or not", () => {
    expect(draftInvoiceState(null, "complete", TODAY).canSetAside).toBe(false);
    const query = src("src/lib/action-items/query.ts");
    expect(query).toContain("const state = draftInvoiceState(until, job?.status, todayStr);");
    expect(query).toContain('affordances: state.canSetAside ? AFFORDANCES.invoice_draft : AFFORDANCES.invoice_draft.filter((v) => v !== "snooze")');
  });
});
