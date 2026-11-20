import { describe, it, expect } from "vitest";
import { CLOSING_QUIET_DAYS, closingFileHref, closingState, sortClosing, type ClosingState } from "./closing";
import { QUOTE_EXPIRY_SOON_DAYS } from "@/lib/action-items/needs-you-rule";
import { quoteNoAnswerFilter } from "@/lib/action-items/due-filters";

/**
 * CLOSING: ONE RULE (cn-v1172). Erik, 2026-11-19: "a new sub-nav tab right below Estimates called
 * Closing as an inbox for estimates that havent been accepted", and "Closing is the reminder yes".
 */
const TODAY = "2026-03-20";
const q = (o: Partial<{ id: string; status: string | null; created_at: string | null; valid_until: string | null }> = {}) => ({
  id: "q1",
  status: "sent",
  created_at: "2026-03-18T17:00:00Z",
  valid_until: null,
  ...o,
});
const ask = (quote = q(), o: Partial<{ settled: boolean; lastSentAt: string | null }> = {}) =>
  closingState(quote, { settled: false, lastSentAt: null, todayStr: TODAY, ...o });

describe("closingState: who is on the Closing list", () => {
  it("a sent estimate that nothing has settled is on it", () => {
    expect(ask().closing).toBe(true);
  });

  it("an answer takes it off by itself: accepted, declined, expired, superseded, and a draft was never on", () => {
    for (const status of ["accepted", "declined", "expired", "superseded", "draft", null, "something-new"]) {
      expect(ask(q({ status })).closing, String(status)).toBe(false);
    }
  });

  it("a sent estimate the one settled rule calls settled is off it, and asks for nobody", () => {
    const s = ask(q({ created_at: "2026-01-01T17:00:00Z", valid_until: "2026-01-15" }), { settled: true });
    expect(s.closing).toBe(false);
    expect(s.needsAttention).toBe(false);
    expect(s.why).toBeNull();
  });
});

describe("closingState: the clock", () => {
  it("counts from the last send the app logged, and says the send is on record", () => {
    const s = ask(q({ created_at: "2026-03-01T17:00:00Z" }), { lastSentAt: "2026-03-17T18:30:00Z" });
    expect(s.sinceAt).toBe("2026-03-17T18:30:00Z");
    expect(s.sentLogged).toBe(true);
    expect(s.daysWaiting).toBe(2);
  });

  it("with no send on record it counts from the day it was written and never calls that a send", () => {
    const s = ask(q({ created_at: "2026-03-10T17:00:00Z" }));
    expect(s.sinceAt).toBe("2026-03-10T17:00:00Z");
    expect(s.sentLogged).toBe(false);
    expect(s.daysWaiting).toBe(9);
  });

  it("a send log it cannot read as a time is no send on record", () => {
    const s = ask(q({ created_at: "2026-03-10T17:00:00Z" }), { lastSentAt: "not-a-time" });
    expect(s.sentLogged).toBe(false);
    expect(s.sinceAt).toBe("2026-03-10T17:00:00Z");
  });

  it("an estimate sent later today has waited zero days, never a negative count", () => {
    expect(ask(q(), { lastSentAt: "2026-03-20T19:00:00Z" }).daysWaiting).toBe(0);
  });

  it("no readable day at all: no clock, and it is still on the list", () => {
    const s = ask(q({ created_at: null }));
    expect(s.closing).toBe(true);
    expect(s.sinceAt).toBeNull();
    expect(s.daysWaiting).toBeNull();
    expect(s.needsAttention).toBe(false);
  });
});

describe("closingState: does it need a person now", () => {
  it("a fresh one waits quietly: on the list, off the badge", () => {
    const s = ask(q(), { lastSentAt: "2026-03-18T17:00:00Z" });
    expect(s.closing).toBe(true);
    expect(s.needsAttention).toBe(false);
    expect(s.why).toBeNull();
  });

  it(`quiet after ${CLOSING_QUIET_DAYS} days since the last send, on the filter's own midnight`, () => {
    // Today began at 2026-03-20T00:00Z; seven days back is 2026-03-13T00:00Z.
    expect(ask(q(), { lastSentAt: "2026-03-13T00:00:00Z" }).why).toBe("quiet");
    expect(ask(q(), { lastSentAt: "2026-03-13T00:00:01Z" }).why).toBeNull();
    expect(ask(q(), { lastSentAt: "2026-03-12T23:00:00Z" }).needsAttention).toBe(true);
  });

  it("sending it again restarts the wait: an old estimate sent yesterday is not quiet", () => {
    const s = ask(q({ created_at: "2026-01-05T17:00:00Z" }), { lastSentAt: "2026-03-19T17:00:00Z" });
    expect(s.needsAttention).toBe(false);
  });

  it("with no send on record, the day it was written decides, as Needs You always measured it", () => {
    expect(ask(q({ created_at: "2026-03-01T17:00:00Z" })).why).toBe("quiet");
  });

  it(`the offer about to end asks whatever the wait: within ${QUOTE_EXPIRY_SOON_DAYS} days, today included`, () => {
    const fresh = { lastSentAt: "2026-03-19T17:00:00Z" };
    const soon = ask(q({ valid_until: "2026-03-25" }), fresh);
    expect(soon.offer).toBe("ends_soon");
    expect(soon.daysToOfferEnd).toBe(5);
    expect(soon.why).toBe("offer_ends");
    expect(ask(q({ valid_until: "2026-03-20" }), fresh).why).toBe("offer_ends");
    const open = ask(q({ valid_until: "2026-03-26" }), fresh);
    expect(open.offer).toBe("open");
    expect(open.needsAttention).toBe(false);
  });

  it("an offer that ended says so, ahead of quiet", () => {
    const s = ask(q({ created_at: "2026-01-05T17:00:00Z", valid_until: "2026-03-19" }));
    expect(s.offer).toBe("ended");
    expect(s.daysToOfferEnd).toBe(-1);
    expect(s.why).toBe("offer_ended");
  });

  it("no offer day, or one it cannot read, is no offer clock", () => {
    expect(ask(q({ valid_until: null })).offer).toBe("none");
    expect(ask(q({ valid_until: "soon" })).offer).toBe("none");
    expect(ask(q({ valid_until: "2026-03-22T00:00:00+00:00" })).offer).toBe("ends_soon");
  });
});

describe("closingState agrees with the read Needs You makes", () => {
  // The filter is PostgREST's or-string; these are its two arms as the database evaluates them.
  const inFilter = (row: { created_at: string; valid_until: string | null }) => {
    const f = quoteNoAnswerFilter(TODAY, CLOSING_QUIET_DAYS, QUOTE_EXPIRY_SOON_DAYS);
    const created = /created_at\.lte\.([^,]+)/.exec(f)?.[1] ?? "";
    const until = /valid_until\.lte\.([^,)]+)/.exec(f)?.[1] ?? "";
    expect(created).not.toBe("");
    expect(until).not.toBe("");
    return Date.parse(row.created_at) <= Date.parse(created) || (!!row.valid_until && row.valid_until <= until);
  };

  it("everything the rule says needs a person is a row that read returns (a send is never before the estimate)", () => {
    const createds = ["2026-01-05T17:00:00Z", "2026-03-12T23:59:59Z", "2026-03-13T00:00:00Z", "2026-03-13T00:00:01Z", "2026-03-19T17:00:00Z"];
    const untils = [null, "2026-03-10", "2026-03-20", "2026-03-25", "2026-03-26", "2026-04-30"];
    const sendsAfter = [null, 0, 3 * 86_400_000, 30 * 86_400_000];
    let asked = 0;
    for (const created_at of createds) {
      for (const valid_until of untils) {
        for (const after of sendsAfter) {
          const lastSentAt = after == null ? null : new Date(Date.parse(created_at) + after).toISOString();
          const s = ask(q({ created_at, valid_until }), { lastSentAt });
          if (s.needsAttention) {
            asked++;
            expect(inFilter({ created_at, valid_until }), `${created_at} ${valid_until} ${lastSentAt}`).toBe(true);
          }
        }
      }
    }
    expect(asked).toBeGreaterThan(10);
  });
});

describe("sortClosing: the order the list is worked in", () => {
  const row = (id: string, s: Partial<ClosingState>) => ({
    id,
    state: { closing: true, sinceAt: null, sentLogged: true, daysWaiting: null, offer: "none", daysToOfferEnd: null, needsAttention: false, why: null, ...s } as ClosingState,
  });
  it("the ones that need a person first, then the longest wait; no readable day goes last in its group", () => {
    const sorted = sortClosing([
      row("fresh", { sinceAt: "2026-03-19T17:00:00Z" }),
      row("no-day", {}),
      row("older", { sinceAt: "2026-03-15T17:00:00Z" }),
      row("quiet", { sinceAt: "2026-03-01T17:00:00Z", needsAttention: true, why: "quiet" }),
      row("offer", { sinceAt: "2026-03-18T17:00:00Z", needsAttention: true, why: "offer_ends" }),
      row("ask-no-day", { needsAttention: true, why: "offer_ended" }),
    ]);
    expect(sorted.map((r) => r.id)).toEqual(["quiet", "offer", "ask-no-day", "older", "fresh", "no-day"]);
  });
  it("does not reorder the list it was handed", () => {
    const rows = [row("b", { sinceAt: "2026-03-19T17:00:00Z" }), row("a", { sinceAt: "2026-03-01T17:00:00Z" })];
    sortClosing(rows);
    expect(rows.map((r) => r.id)).toEqual(["b", "a"]);
  });
});

describe("closingFileHref: a row's name opens the person's file", () => {
  it("the customer's page first, then the lead's file, else nothing", () => {
    expect(closingFileHref({ customer_id: "c1", inquiry_id: "l1" })).toBe("/crm/c1");
    expect(closingFileHref({ customer_id: null, inquiry_id: "l1" })).toBe("/leads/l1");
    expect(closingFileHref({})).toBeNull();
  });
});
