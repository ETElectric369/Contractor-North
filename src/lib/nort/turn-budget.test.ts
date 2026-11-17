import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  budgetRefusal,
  CHANGES_SPENT_SAID,
  DAY_BOOKING_WRITES,
  isDayBookingWrite,
  MAX_OTHER_WRITES_PER_TURN,
  MAX_WRITES_PER_TURN,
  outOfTimeSaid,
  roundsOutOfTime,
  STOP_ROUNDS_AFTER_MS,
  TIME_SPENT_SAID,
  turnBudget,
  WRAP_UP_AFTER_MS,
} from "./turn-budget";
import { REGISTRY } from "@/lib/actions/registry";
import { AGENT_WRITE_ALLOWED } from "@/lib/actions/agent-tools";
import { needsConsent } from "@/lib/actions/risk";
import { JOB_STATUSES } from "@/lib/job-status";

const route = readFileSync(join(process.cwd(), "src/app/api/chat/route.ts"), "utf8");

/** One write as the route would count it: ask the budget, and count it only when it may run. */
function runTurn(asks: { action: string; input?: unknown; atMs?: number }[]) {
  let writes = 0;
  let others = 0;
  const out: string[] = [];
  for (const a of asks) {
    const booking = isDayBookingWrite(a.action, a.input ?? {});
    const spent = turnBudget({ writes, others, booking, elapsedMs: a.atMs ?? 0 });
    out.push(spent);
    if (spent === "ok") {
      writes++;
      if (!booking) others++;
    }
  }
  return { out, writes, others };
}

/**
 * HOW MUCH NORT MAY CHANGE IN ONE TURN (sweep 2026-11-16). The owner booked the next day by voice
 * while driving, fourteen changes in all, and a budget of three stopped him four times to say
 * "continue". Booking a day draws on twenty now; everything else keeps the three it had. The
 * numbers, the clock beside them and what is said live in one pure file; the route asks it.
 */
describe("the turn's change budget", () => {
  it("is twenty for booking a day (four jobs, each a status, a day and three people) and three for the rest", () => {
    expect(MAX_WRITES_PER_TURN).toBe(20);
    expect(4 * (1 + 1 + 3)).toBe(MAX_WRITES_PER_TURN);
    expect(MAX_OTHER_WRITES_PER_TURN).toBe(3);
  });

  it("lets the day he asked for through in one turn: fourteen changes, none refused", () => {
    const crew = ["Sam", "Dana", "Theo"];
    const asks = [
      { action: "job.setStatus", input: { id: "the heater job", status: "scheduled" } },
      { action: "appointment.create", input: { job_id: "a" } },
      { action: "appointment.create", input: { job_id: "b" } },
      { action: "job.create", input: { name: "a new job" } },
      { action: "appointment.create", input: { job_id: "c" } },
      ...["a", "b", "c"].flatMap((id) => crew.map((assignee) => ({ action: "job.assign", input: { id, assignee } }))),
    ].map((a, n) => ({ ...a, atMs: 4_000 * n }));
    expect(asks).toHaveLength(14);
    const turn = runTurn(asks);
    expect(turn.out.every((s) => s === "ok")).toBe(true);
    expect(turn.others).toBe(0);
  });

  it("stops at the twenty-first write, whatever it is and whatever the clock says", () => {
    expect(turnBudget({ writes: 19, others: 0, booking: true, elapsedMs: 0 })).toBe("ok");
    expect(turnBudget({ writes: 20, others: 0, booking: true, elapsedMs: 0 })).toBe("changes_spent");
    expect(turnBudget({ writes: 20, others: 0, booking: true, elapsedMs: 999_999 })).toBe("changes_spent");
    expect(turnBudget({ writes: 500, others: 0, booking: false, elapsedMs: 0 })).toBe("changes_spent");
  });

  it("everything that is not booking a day keeps the three it had: the fourth is refused", () => {
    // Twenty facts in every crew member's prompt, twenty customers' numbers, twenty lines off an estimate.
    for (const action of ["memory.remember", "customer.update", "quote.deleteItem", "quote.updateItem", "time.addEntry", "invoice.fromJob", "quote.convertToJob", "payment.setSchedule", "lien.update"]) {
      const turn = runTurn(Array.from({ length: 20 }, () => ({ action, input: { id: "x" } })));
      expect(turn.out.slice(0, 3), action).toEqual(["ok", "ok", "ok"]);
      expect(turn.out.slice(3).every((s) => s === "changes_spent"), action).toBe(true);
      expect(turn.writes, action).toBe(3);
    }
  });

  it("three of the rest do not eat the day: booking goes on to twenty beside them", () => {
    const turn = runTurn([
      ...Array.from({ length: 4 }, () => ({ action: "customer.update", input: { id: "x" } })),
      ...Array.from({ length: 18 }, () => ({ action: "job.assign", input: { id: "j", assignee: "Sam" } })),
    ]);
    expect(turn.out.slice(0, 4)).toEqual(["ok", "ok", "ok", "changes_spent"]);
    expect(turn.out.slice(4, 21).every((s) => s === "ok")).toBe(true); // seventeen more: twenty in all
    expect(turn.out[21]).toBe("changes_spent");
    expect(turn.writes).toBe(20);
  });

  it("no turn that worked before is refused now: any three writes, of any kind, at any age", () => {
    for (const elapsedMs of [0, WRAP_UP_AFTER_MS - 1, WRAP_UP_AFTER_MS, 119_000, 10_000_000]) {
      for (const booking of [true, false]) {
        for (let writes = 0; writes < 3; writes++) {
          expect(turnBudget({ writes, others: booking ? 0 : writes, booking, elapsedMs })).toBe("ok");
        }
      }
    }
  });

  it("a write past the third is made only while the turn is young, so a long turn ends in words", () => {
    expect(turnBudget({ writes: 3, others: 0, booking: true, elapsedMs: WRAP_UP_AFTER_MS - 1 })).toBe("ok");
    expect(turnBudget({ writes: 3, others: 0, booking: true, elapsedMs: WRAP_UP_AFTER_MS })).toBe("time_spent");
    expect(turnBudget({ writes: 12, others: 1, booking: true, elapsedMs: WRAP_UP_AFTER_MS + 5_000 })).toBe("time_spent");
  });

  it("the clocks sit under the route's own wall, the loop's stop after the writes' one", () => {
    const wall = Number(/export const maxDuration = (\d+);/.exec(route)?.[1]);
    expect(wall).toBe(120);
    expect(WRAP_UP_AFTER_MS).toBe(70_000);
    expect(STOP_ROUNDS_AFTER_MS).toBe(95_000);
    expect(STOP_ROUNDS_AFTER_MS).toBeGreaterThan(WRAP_UP_AFTER_MS);
    expect(wall * 1000 - STOP_ROUNDS_AFTER_MS).toBeGreaterThanOrEqual(25_000);
    expect(roundsOutOfTime(STOP_ROUNDS_AFTER_MS - 1)).toBe(false);
    expect(roundsOutOfTime(STOP_ROUNDS_AFTER_MS)).toBe(true);
  });

  it("both refusals name the one way on, and say so as a failed tool result", () => {
    expect(CHANGES_SPENT_SAID).toContain("continue");
    expect(TIME_SPENT_SAID).toContain('"continue"');
    expect(TIME_SPENT_SAID).toContain("was not made");
    expect(JSON.parse(budgetRefusal("changes_spent"))).toEqual({ ok: false, error: CHANGES_SPENT_SAID });
    expect(JSON.parse(budgetRefusal("time_spent"))).toEqual({ ok: false, error: TIME_SPENT_SAID });
  });

  it("the person is told in their own language when the loop stops for time", () => {
    expect(outOfTimeSaid("en")).toBe('I ran out of time on that one. Say "continue" and I\'ll pick up where I left off.');
    expect(outOfTimeSaid("es")).toBe('Se me acabó el tiempo en esta. Di "continúa" y sigo donde me quedé.');
  });
});

describe("what counts as booking a day", () => {
  it("every name on the list is a write Nort has, and none of them needs a yes first", () => {
    for (const name of DAY_BOOKING_WRITES) {
      expect(AGENT_WRITE_ALLOWED.has(name), name).toBe(true);
      const def = REGISTRY[name as keyof typeof REGISTRY];
      expect(def.effect, name).toBe("write");
      expect(needsConsent(def, "agent", false), name).toBe(false);
    }
    expect([...DAY_BOOKING_WRITES].sort()).toEqual(
      ["appointment.create", "appointment.linkCustomer", "customer.create", "job.assign", "job.create", "job.move", "job.scheduleDay", "job.setStatus", "task.assign", "task.create", "task.setDue"].sort(),
    );
  });

  it("the writes the review named are not on it", () => {
    for (const name of ["memory.remember", "customer.update", "quote.deleteItem", "quote.updateItem", "quote.setStatus", "quote.convertToJob", "time.addEntry", "invoice.fromJob", "invoice.fromQuote", "payment.setSchedule", "lien.update", "task.complete"]) {
      expect(AGENT_WRITE_ALLOWED.has(name), name).toBe(true); // a real write of his, and still three a turn
      expect(isDayBookingWrite(name, { id: "x" }), name).toBe(false);
    }
  });

  it("a status books only when it keeps the job in flight: cancelling is counted with the rest", () => {
    for (const status of ["to_be_scheduled", "scheduled", "in_progress", "on_hold"]) {
      expect(isDayBookingWrite("job.setStatus", { id: "j", status }), status).toBe(true);
    }
    for (const status of JOB_STATUSES.filter((s) => !["to_be_scheduled", "scheduled", "in_progress", "on_hold"].includes(s))) {
      expect(isDayBookingWrite("job.setStatus", { id: "j", status }), status).toBe(false);
    }
    expect(JOB_STATUSES).toContain("cancelled");
    for (const input of [{ id: "j" }, { id: "j", status: "Scheduled" }, { id: "j", status: " scheduled" }, { id: "j", status: 3 }, { id: "j", status: null }, null, undefined, "scheduled"]) {
      expect(isDayBookingWrite("job.setStatus", input), JSON.stringify(input)).toBe(false);
    }
    // Twenty cancellations in one turn is what this keeps at three.
    const turn = runTurn(Array.from({ length: 20 }, () => ({ action: "job.setStatus", input: { id: "j", status: "cancelled" } })));
    expect(turn.writes).toBe(3);
  });

  it("an assign books only when it adds a person: clearing a crew is counted with the rest", () => {
    expect(isDayBookingWrite("job.assign", { id: "j", assignee: "Sam Tillery" })).toBe(true);
    for (const assignee of [null, "", "   ", undefined, 7]) {
      expect(isDayBookingWrite("job.assign", { id: "j", assignee }), String(assignee)).toBe(false);
    }
    // True in code: an empty assignee is the handler's "clear the whole crew".
    const job = readFileSync(join(process.cwd(), "src/lib/actions/entities/job.ts"), "utf8");
    expect(job).toContain("if (!i.assignee) return setJobCrew(job.id, []);");
    const turn = runTurn(Array.from({ length: 20 }, () => ({ action: "job.assign", input: { id: "j", assignee: null } })));
    expect(turn.writes).toBe(3);
  });
});

/**
 * WHAT THE BUDGET IS THE BELT UNDER. Its file says which of Nort's writes stop at a confirm card
 * and that none sends to a customer. Those are the walls a bigger budget leans on, so they are
 * read from the registry here, not trusted from a comment.
 */
describe("the walls the budget sits under", () => {
  const defs = [...AGENT_WRITE_ALLOWED].map((name) => ({ name, def: REGISTRY[name as keyof typeof REGISTRY] }));

  it("every write Nort can make is a registry action, seventy-five of them", () => {
    expect(defs).toHaveLength(75);
    for (const { name, def } of defs) expect(def, name).toBeTruthy();
  });

  it("sixteen stop the turn for a yes, and the fifty-nine the budget counts are the rest", () => {
    const gated = defs.filter(({ def }) => needsConsent(def, "agent", false)).map(({ name }) => name);
    expect(gated).toHaveLength(16);
    expect(defs.length - gated.length).toBe(59);
    expect(gated).toEqual(
      expect.arrayContaining([
        "payment.record",
        "bill.create",
        "invoice.addItem",
        "invoice.updateItem",
        "invoice.deleteItem",
        "job.finish",
        "time.fixEntry",
        "appointment.update",
        "appointment.setStatus",
        "task.bulkComplete",
        "task.bulkReschedule",
        "memory.standingOrders",
        "memory.forget",
        "material.removeLine",
      ]),
    );
  });

  it("no write of his is a send: not by its name, and not by what its handler calls", () => {
    // The app's doors that text or email a customer. One hop only: a handler that reached one of
    // them through a function of its own would not be seen here.
    const sends = /\b(textQuote|emailQuote|sendContract|emailPortalLink|sendSms|sendEmail)\b/;
    for (const { name, def } of defs) {
      expect(name, name).not.toMatch(/send|email|sms|text|notify|message/i);
      expect(String(def.handler), name).not.toMatch(sends);
    }
    // The one handler that could have sent says, in its own call, that it does not: finishing a
    // job drafts the bill and leaves the sending to a person.
    expect(String(REGISTRY["job.finish"].handler)).toContain("sendInvoice: false");
  });
});

describe("the chat route asks the budget and holds no number of its own", () => {
  it("starts the request's clock first thing, before anything is awaited", () => {
    const post = route.slice(route.indexOf("export async function POST(req: Request) {"));
    const clock = post.indexOf("const turnStartedAt = Date.now();");
    expect(clock).toBeGreaterThan(0);
    expect(post.slice(0, clock)).not.toContain("await ");
  });

  it("asks before every registry write, with what the model asked for, this turn's counts and this request's age", () => {
    expect(route).toContain('import { budgetRefusal, isDayBookingWrite, outOfTimeSaid, roundsOutOfTime, turnBudget } from "@/lib/nort/turn-budget";');
    expect(route).toContain("const booking = isDayBookingWrite(actionName, tu.input);");
    expect(route).toContain('const spent = readOnlyAction ? "ok" : turnBudget({ writes: writeCount, others: otherWriteCount, booking, elapsedMs: Date.now() - turnStartedAt });');
    expect(route).toContain("out = budgetRefusal(spent);");
    expect(route).not.toMatch(/MAX_WRITES\s*=/);
    expect(route).not.toContain("writeCount >= ");
  });

  it("a read spends nothing, and a write is counted once, before it runs", () => {
    const ask = route.indexOf("const spent = readOnlyAction");
    const count = route.indexOf("writeCount++;");
    const other = route.indexOf("if (!booking) otherWriteCount++;");
    const run = route.indexOf('const res = await executeAction(actionName, switched.input, { source: "agent" });');
    expect(ask).toBeGreaterThan(0);
    expect(count).toBeGreaterThan(ask);
    expect(other).toBeGreaterThan(count);
    expect(run).toBeGreaterThan(other);
    expect(route.split("writeCount++").length - 1).toBe(1);
    expect(route.split("otherWriteCount++").length - 1).toBe(1);
    expect(route).toContain("if (!readOnlyAction) {\n                  writeCount++;");
  });

  it("only one place in the route runs a registry action for the model", () => {
    expect(route.split("executeAction(").length - 1).toBe(1);
  });

  it("stops asking for another round once the turn is old, says so in the person's language, and keeps the sentence", () => {
    const stop = route.indexOf("if (roundsOutOfTime(Date.now() - turnStartedAt)) {");
    const push = route.indexOf('convo.push({ role: "user", content: results });');
    expect(push).toBeGreaterThan(0);
    expect(stop).toBeGreaterThan(push);
    const block = route.slice(stop, stop + 400);
    expect(block).toContain("outOfTimeSaid(lang)");
    expect(block).toContain("assistantReply += said;");
    expect(block).toContain("emit(said);");
    expect(block).toContain("break;");
    expect(route).toContain("const lang = asLang(prof?.language);");
  });

  it("a confirm-gated action still ends the turn at its card: the budget is not what holds money", () => {
    expect(route).toContain("if (res.needsConfirm) {");
    expect(route).toContain("out = JSON.stringify({ ok: false, awaitingUserConfirmation: true });");
    expect(route).toContain("if (pendingConfirm) break;");
  });
});
