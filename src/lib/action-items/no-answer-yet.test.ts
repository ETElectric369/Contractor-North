import { describe, it, expect } from "vitest";
import { closingState, CLOSING_QUIET_DAYS } from "@/lib/estimate/closing";
import { QUOTE_EXPIRY_SOON_DAYS } from "./needs-you-rule";
import { noAnswerYetItem, type NoAnswerQuote } from "./no-answer-yet";
import { ageWords } from "./row-words";
import { sortActionItems } from "./types";

/**
 * NEEDS YOU AND THE CLOSING PAGE AGREE (cn-v1172). One table of estimates, asked both ways: Needs
 * You's No Answer Yet row is drawn exactly for the estimates the Closing page lists AND marks as
 * needing a person (the ones the Sales dot counts), with the reason the page says.
 */
const TODAY = "2026-11-19";
type Case = { q: NoAnswerQuote; settled: boolean; lastSentAt: string | null };
const q = (id: string, o: Partial<NoAnswerQuote> = {}): NoAnswerQuote => ({
  id,
  quote_number: `E-9${id}`,
  doc_type: "estimate",
  status: "sent",
  total: 800,
  valid_until: null,
  created_at: "2026-11-01T17:00:00Z",
  customerName: "Sam Tillery",
  ...o,
});

const TABLE: Case[] = [
  { q: q("01"), settled: false, lastSentAt: null }, // quiet since written, no send on record
  { q: q("02"), settled: false, lastSentAt: "2026-11-18T17:00:00Z" }, // sent again yesterday
  { q: q("03"), settled: false, lastSentAt: "2026-11-10T17:00:00Z" }, // nine days since the send
  { q: q("04", { created_at: "2026-11-17T17:00:00Z" }), settled: false, lastSentAt: null }, // fresh
  { q: q("05", { created_at: "2026-11-17T17:00:00Z", valid_until: "2026-11-21" }), settled: false, lastSentAt: null }, // offer ends soon
  { q: q("06", { created_at: "2026-11-17T17:00:00Z", valid_until: "2026-11-15" }), settled: false, lastSentAt: null }, // offer ended
  { q: q("07", { created_at: "2026-11-17T17:00:00Z", valid_until: "2027-01-15" }), settled: false, lastSentAt: null }, // offer open, fresh
  { q: q("08"), settled: true, lastSentAt: null }, // billed or replaced
  { q: q("09", { status: "accepted" }), settled: false, lastSentAt: null }, // an answer
  { q: q("10", { status: "declined", valid_until: "2026-11-01" }), settled: false, lastSentAt: null },
  { q: q("11", { created_at: null }), settled: false, lastSentAt: null }, // no readable day
  { q: q("12", { created_at: "2026-11-12T00:00:00Z" }), settled: false, lastSentAt: null }, // exactly a week, at midnight
  { q: q("13", { created_at: "2026-11-12T00:00:01Z" }), settled: false, lastSentAt: null }, // a second short of a week
];

describe("No Answer Yet is the Closing list's 'needs a person now'", () => {
  it("on one table, a row is drawn exactly when the page's rule lists it and marks it, with the page's reason", () => {
    const drawn: string[] = [];
    for (const c of TABLE) {
      const st = closingState(c.q, { settled: c.settled, lastSentAt: c.lastSentAt, todayStr: TODAY });
      const row = noAnswerYetItem(c.q, { settled: c.settled, lastSentAt: c.lastSentAt, todayStr: TODAY, tz: "America/Los_Angeles" });
      expect(!!row, c.q.id).toBe(st.closing && st.needsAttention);
      if (!row) continue;
      drawn.push(c.q.id);
      const key = { offer_ended: "ny_w_docOfferEnded", offer_ends: "ny_w_docOfferEnds", quiet: "ny_w_docNoAnswer" }[st.why!];
      expect(row.what?.key, c.q.id).toBe(key);
      expect(row.since, c.q.id).toBe(st.sinceAt);
      expect(row.dated ?? null, c.q.id).toBe(st.sentLogged ? "Sent" : null);
    }
    expect(drawn).toEqual(["01", "03", "05", "06", "12"]);
    expect(CLOSING_QUIET_DAYS).toBe(7);
    expect(QUOTE_EXPIRY_SOON_DAYS).toBeGreaterThan(0);
  });

  it("a row has no Still Waiting: Won It and Not Sold behind ⋯, and the Send sheet's facts for Send Again", () => {
    const row = noAnswerYetItem(q("06", { valid_until: "2026-11-15" }), { settled: false, lastSentAt: "2026-11-02T17:00:00Z", todayStr: TODAY })!;
    expect(row.affordances).toEqual(["do", "dismiss", "open"]);
    expect(row).toMatchObject({ kind: "quote_awaiting", who: "Sam Tillery", urgency: 2, href: "/quotes/06", amount: 800 });
    expect(row.send).toEqual({ kind: "quote", id: "06", number: "E-906", customerName: "Sam Tillery", amount: 800, lineCount: null, openHref: "/quotes/06" });
  });
  it("a row with no logged send says its age plainly, never as a send and never overdue; an offer day stays the deadline (cn-v1172 fixer)", () => {
    const ctx = { todayStr: TODAY, tz: "America/Los_Angeles" };
    // Marked Sent by hand, written on the 2nd, no offer day, no logged send: it was "17d overdue".
    const plain = noAnswerYetItem(q("01", { created_at: "2026-11-02T17:00:00Z" }), { settled: false, lastSentAt: null, ...ctx })!;
    expect(plain.dated ?? null).toBeNull();
    const said = ageWords(plain, ctx);
    expect(said).toBe("17d ago · 9:00 AM"); // the day it was written, as an age, its time beside it
    expect(said).not.toMatch(/overdue|due|sent/i);
    // It still sorts by its age among its neighbours: written on the 2nd before one written on the 10th.
    const newer = noAnswerYetItem(q("14", { created_at: "2026-11-10T17:00:00Z" }), { settled: false, lastSentAt: null, ...ctx })!;
    expect(sortActionItems([newer, plain], TODAY).map((r) => r.id)).toEqual(["01", "14"]);
    // An offer day with no logged send: the real deadline, said as one.
    const offer = noAnswerYetItem(q("06", { created_at: "2026-11-17T17:00:00Z", valid_until: "2026-11-15" }), { settled: false, lastSentAt: null, ...ctx })!;
    expect(ageWords(offer, ctx)).toBe("4d overdue");
    // A logged send still says the send's day.
    const sent = noAnswerYetItem(q("03"), { settled: false, lastSentAt: "2026-11-10T17:00:00Z", ...ctx })!;
    expect(ageWords(sent, ctx)).toBe("Sent Nov 10");
  });
});
