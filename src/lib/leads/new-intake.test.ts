import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  LEAD_VISIT_COLUMNS,
  NEW_INTAKE_COUNT_CAP,
  NOT_SOLD_STATUS,
  STANDING_IDS_PER_REQUEST,
  STANDING_ROW_CAP,
  countNewIntake,
  isOpenLead,
  leadStage,
  loadNewIntake,
  newIntakeOnly,
  pickWentUnanswered,
  readStanding,
  standingFor,
  visitStands,
  type LeadVisitRow,
} from "./new-intake";

/**
 * NEW INTAKE (cn-v1170): which leads are on the Leads list. The rule is pure and the reader is run
 * against a stand-in client that records every call, so the columns, the filters and the company
 * fence are pinned without a database.
 */

/** The caller's clock in every test below, and a time on each side of it. */
const NOW = Date.parse("2026-11-19T20:00:00Z");
const AHEAD = "2026-11-21T17:00:00Z";
const GONE_BY = "2026-11-18T17:00:00Z";

describe("visitStands", () => {
  it.each([
    ["scheduled", null, true],
    ["proposed", null, true],
    ["completed", null, true],
    ["completed", "won", true],
    ["scheduled", "", true],
    ["completed", "lost", false],
    ["completed", "no_bid", false],
    ["scheduled", "lost", false],
    ["cancelled", null, false],
    ["cancelled", "won", false],
    // a state the rule has not been taught stands for nothing: the lead is offered, never hidden
    ["on_hold", null, false],
    [null, null, false],
    ["completed", "some_new_ending", false],
  ] as const)("status %s, ending %s -> %s", (status, outcome, expected) => {
    // a time still ahead, so the pick-a-time rule below is not what decides these
    expect(visitStands({ status, outcome, starts_at: AHEAD }, NOW)).toBe(expected);
  });

  it("a booked or finished visit stands whatever its time: only a pick request runs out", () => {
    expect(visitStands({ status: "scheduled", outcome: null, starts_at: GONE_BY }, NOW)).toBe(true);
    expect(visitStands({ status: "scheduled", outcome: null, starts_at: null }, NOW)).toBe(true);
    expect(visitStands({ status: "completed", outcome: null, starts_at: GONE_BY }, NOW)).toBe(true);
  });

  it("a visit waiting on the customer's pick stands only until the first time offered goes by", () => {
    expect(visitStands({ status: "proposed", outcome: null, starts_at: AHEAD }, NOW)).toBe(true);
    expect(visitStands({ status: "proposed", outcome: null, starts_at: GONE_BY }, NOW)).toBe(false);
    // the very minute counts as gone by, and a request with no time on it cannot be waited on
    expect(visitStands({ status: "proposed", outcome: null, starts_at: new Date(NOW).toISOString() }, NOW)).toBe(false);
    expect(visitStands({ status: "proposed", outcome: null, starts_at: null }, NOW)).toBe(false);
    expect(visitStands({ status: "proposed", outcome: null, starts_at: "not a date" }, NOW)).toBe(false);
  });

  it("pickWentUnanswered is exactly that: proposed, no ending, its time gone by", () => {
    expect(pickWentUnanswered({ status: "proposed", outcome: null, starts_at: GONE_BY }, NOW)).toBe(true);
    expect(pickWentUnanswered({ status: "proposed", outcome: null, starts_at: AHEAD }, NOW)).toBe(false);
    expect(pickWentUnanswered({ status: "proposed", outcome: "lost", starts_at: GONE_BY }, NOW)).toBe(false);
    expect(pickWentUnanswered({ status: "scheduled", outcome: null, starts_at: GONE_BY }, NOW)).toBe(false);
  });
});

describe("isOpenLead + leadStage", () => {
  it("open means not converted and not Not Sold", () => {
    expect(isOpenLead({ status: "new", converted_at: null })).toBe(true);
    expect(isOpenLead({ status: "contacted" })).toBe(true);
    expect(isOpenLead({ status: NOT_SOLD_STATUS, converted_at: null })).toBe(false);
    expect(isOpenLead({ status: "quoted", converted_at: "2026-11-01T00:00:00Z" })).toBe(false);
  });

  it("the stamps outrank the visits", () => {
    expect(leadStage({ status: "new" }, false)).toBe("open");
    expect(leadStage({ status: "contacted" }, true)).toBe("standing");
    expect(leadStage({ status: NOT_SOLD_STATUS }, true)).toBe("notSold");
    expect(leadStage({ status: NOT_SOLD_STATUS }, false)).toBe("notSold");
    expect(leadStage({ status: NOT_SOLD_STATUS, converted_at: "2026-11-01T00:00:00Z" }, true)).toBe("converted");
    expect(leadStage({ status: "won", converted_at: "2026-11-01T00:00:00Z" }, false)).toBe("converted");
  });
});

const visit = (
  inquiry_id: string,
  status: string,
  outcome: string | null = null,
  starts_at: string | null = AHEAD,
): LeadVisitRow => ({ inquiry_id, status, outcome, starts_at });

describe("readStanding", () => {
  it("a lead stands when any one of its visits does", async () => {
    const read = await readStanding(
      ["a", "b", "c"],
      async () => ({
        data: [visit("a", "completed", "lost"), visit("a", "scheduled"), visit("b", "completed", "lost"), visit("b", "cancelled")],
        error: null,
      }),
      NOW,
    );
    expect([...read.standing]).toEqual(["a"]);
    expect(read.unread.size).toBe(0);
    expect(read.pickPending.size).toBe(0);
  });

  it("names the leads whose pick request ran out, and never one that has something standing", async () => {
    const read = await readStanding(
      ["a", "b", "c", "d"],
      async () => ({
        data: [
          visit("a", "proposed", null, GONE_BY), // ran out, nothing else: back on the list, named
          visit("b", "proposed", null, GONE_BY), // ran out, but a later visit is booked: standing
          visit("b", "scheduled"),
          visit("c", "proposed", null, AHEAD), // still waiting on the customer: standing
          visit("d", "proposed", "lost", GONE_BY), // ended Not Sold: neither
        ],
        error: null,
      }),
      NOW,
    );
    expect([...read.standing].sort()).toEqual(["b", "c"]);
    expect([...read.pickPending]).toEqual(["a"]);
  });

  it("asks in batches of fifty ids and never repeats one", async () => {
    const ids = Array.from({ length: 120 }, (_, i) => `lead-${i}`);
    const asked: string[][] = [];
    await readStanding(
      [...ids, "lead-0", ""],
      async (batch, cap) => {
        asked.push(batch);
        expect(cap).toBe(STANDING_ROW_CAP);
        return { data: [], error: null };
      },
      NOW,
    );
    expect(asked.map((b) => b.length)).toEqual([STANDING_IDS_PER_REQUEST, STANDING_IDS_PER_REQUEST, 20]);
    expect(new Set(asked.flat()).size).toBe(120);
  });

  it("a batch that fails, throws or comes back at its cap is UNREAD, and the others still answer", async () => {
    const ids = Array.from({ length: 200 }, (_, i) => `lead-${i}`);
    let call = 0;
    const read = await readStanding(
      ids,
      async (batch) => {
        call += 1;
        if (call === 1) return { data: null, error: new Error("gateway") };
        if (call === 2) throw new Error("network");
        if (call === 3) return { data: Array.from({ length: STANDING_ROW_CAP }, () => visit(batch[0], "scheduled")), error: null };
        return { data: [visit(batch[0], "scheduled")], error: null };
      },
      NOW,
    );
    expect(read.unread.size).toBe(150);
    expect([...read.standing]).toEqual(["lead-150"]);
  });

  it("no ids, no request", async () => {
    let asked = 0;
    const read = await readStanding(
      [],
      async () => {
        asked += 1;
        return { data: [], error: null };
      },
      NOW,
    );
    expect(asked).toBe(0);
    expect(read.standing.size + read.unread.size).toBe(0);
  });
});

describe("newIntakeOnly", () => {
  it("drops the standing leads and keeps the unread ones (offered, never hidden)", () => {
    const leads = [{ id: "a" }, { id: "b" }, { id: "c" }];
    expect(newIntakeOnly(leads, { standing: new Set(["b"]), unread: new Set(["c"]), pickPending: new Set() })).toEqual([
      { id: "a" },
      { id: "c" },
    ]);
  });
});

/** A stand-in for the Supabase client: every call on a table is recorded, and awaiting the builder
 *  resolves to that table's canned answer. */
type Call = [method: string, ...args: unknown[]];
function standIn(answers: Record<string, { data: unknown; error: unknown } | (() => { data: unknown; error: unknown })>) {
  const calls: Record<string, Call[][]> = {};
  const client = {
    from(table: string) {
      const log: Call[] = [];
      (calls[table] ??= []).push(log);
      const builder: Record<string, unknown> = {};
      for (const m of ["select", "is", "neq", "eq", "in", "order", "limit"]) {
        builder[m] = (...args: unknown[]) => {
          log.push([m, ...args]);
          return builder;
        };
      }
      builder.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => {
        const a = answers[table];
        return Promise.resolve(typeof a === "function" ? a() : a).then(resolve, reject);
      };
      return builder;
    },
  };
  return { client: client as unknown as SupabaseClient, calls };
}

describe("loadNewIntake", () => {
  it("reads the open leads, then their visits, and returns the ones with nothing standing", async () => {
    const { client, calls } = standIn({
      inquiries: { data: [{ id: "a", name: "Dana Rook" }, { id: "b", name: "Theo Vance" }], error: null },
      appointments: { data: [visit("b", "scheduled")], error: null },
    });
    const res = await loadNewIntake<{ id: string; name: string }>(client, "id, name");
    expect(res.error).toBeNull();
    expect(res.leads).toEqual([{ id: "a", name: "Dana Rook" }]);
    expect(res.unread.size).toBe(0);
    // the open-lead filter, and newest first by default
    expect(calls.inquiries[0]).toEqual([
      ["select", "id, name"],
      ["is", "converted_at", null],
      ["neq", "status", NOT_SOLD_STATUS],
      ["order", "created_at", { ascending: false }],
    ]);
    // the visits read: its own columns, no cancelled visit, capped; no money column anywhere
    expect(calls.appointments[0]).toEqual([
      ["select", LEAD_VISIT_COLUMNS],
      ["in", "inquiry_id", ["a", "b"]],
      ["neq", "status", "cancelled"],
      ["limit", STANDING_ROW_CAP],
    ]);
  });

  it("names the company on both reads, oldest first and bounded, when asked", async () => {
    const { client, calls } = standIn({
      inquiries: { data: [{ id: "a" }], error: null },
      appointments: { data: [], error: null },
    });
    await loadNewIntake(client, "id", { orgId: "org-1", limit: 2, oldestFirst: true });
    expect(calls.inquiries[0]).toEqual([
      ["select", "id"],
      ["is", "converted_at", null],
      ["neq", "status", NOT_SOLD_STATUS],
      ["eq", "org_id", "org-1"],
      ["order", "created_at", { ascending: true }],
      ["limit", 2],
    ]);
    expect(calls.appointments[0]).toContainEqual(["eq", "org_id", "org-1"]);
  });

  it("a failed lead read is an error and an empty list, never 'no leads'", async () => {
    const { client, calls } = standIn({ inquiries: { data: null, error: new Error("boom") }, appointments: { data: [], error: null } });
    const res = await loadNewIntake(client, "id");
    expect(res.leads).toEqual([]);
    expect(res.error).toBeInstanceOf(Error);
    expect(calls.appointments).toBeUndefined();
  });

  it("a lead whose visits could not be read stays on the list and is named", async () => {
    const { client } = standIn({
      inquiries: { data: [{ id: "a" }, { id: "b" }], error: null },
      appointments: { data: null, error: new Error("gateway") },
    });
    const res = await loadNewIntake(client, "id");
    expect(res.leads.map((l) => l.id)).toEqual(["a", "b"]);
    expect([...res.unread].sort()).toEqual(["a", "b"]);
  });

  it("says when the lead read came back at its limit, and never without one", async () => {
    const three = { data: [{ id: "a" }, { id: "b" }, { id: "c" }], error: null };
    const visits = { data: [visit("a", "scheduled")], error: null };
    const atLimit = await loadNewIntake(standIn({ inquiries: three, appointments: visits }).client, "id", { limit: 3 });
    expect(atLimit.capped).toBe(true);
    expect(atLimit.leads.map((l) => l.id)).toEqual(["b", "c"]);
    const under = await loadNewIntake(standIn({ inquiries: three, appointments: visits }).client, "id", { limit: 4 });
    expect(under.capped).toBe(false);
    const noLimit = await loadNewIntake(standIn({ inquiries: three, appointments: visits }).client, "id");
    expect(noLimit.capped).toBe(false);
  });

  it("a lead whose pick request ran out is on the list and named, by the caller's clock", async () => {
    const answers = {
      inquiries: { data: [{ id: "a" }, { id: "b" }], error: null },
      appointments: { data: [visit("a", "proposed", null, GONE_BY), visit("b", "proposed", null, AHEAD)], error: null },
    };
    const res = await loadNewIntake(standIn(answers).client, "id", { nowMs: NOW });
    expect(res.leads.map((l) => l.id)).toEqual(["a"]);
    expect([...res.pickPending]).toEqual(["a"]);
    // two days on, the second request has run out too
    const later = await loadNewIntake(standIn(answers).client, "id", { nowMs: Date.parse("2026-11-22T00:00:00Z") });
    expect(later.leads.map((l) => l.id)).toEqual(["a", "b"]);
    expect([...later.pickPending].sort()).toEqual(["a", "b"]);
  });

  it("no open lead, no visits read", async () => {
    const { client, calls } = standIn({ inquiries: { data: [], error: null }, appointments: { data: [], error: null } });
    const res = await loadNewIntake(client, "id");
    expect(res.leads).toEqual([]);
    expect(res.error).toBeNull();
    expect(calls.appointments).toBeUndefined();
  });
});

describe("countNewIntake + standingFor", () => {
  it("counts the list, reading ids only and at most the cap", async () => {
    const { client, calls } = standIn({
      inquiries: { data: [{ id: "a" }, { id: "b" }, { id: "c" }], error: null },
      // booked, not waiting on a pick: this test reads the real clock, so nothing in it may depend on the date
      appointments: { data: [visit("a", "scheduled"), visit("c", "completed", "lost")], error: null },
    });
    expect(await countNewIntake(client)).toBe(2);
    expect(calls.inquiries[0][0]).toEqual(["select", "id"]);
    expect(calls.inquiries[0]).toContainEqual(["limit", NEW_INTAKE_COUNT_CAP]);
  });

  it("throws on a failed lead read, so the caller files it and shows no badge", async () => {
    const { client } = standIn({ inquiries: { data: null, error: new Error("boom") }, appointments: { data: [], error: null } });
    await expect(countNewIntake(client)).rejects.toThrow("boom");
  });

  it("standingFor reads through the same rule", async () => {
    const { client } = standIn({ appointments: { data: [visit("a", "scheduled"), visit("b", "completed", "no_bid")], error: null } });
    const read = await standingFor(client, ["a", "b"], { nowMs: NOW });
    expect([...read.standing]).toEqual(["a"]);
  });
});
