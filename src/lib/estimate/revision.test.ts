import { describe, it, expect } from "vitest";
import { fakeDb } from "@/test/fake-supabase";
import { comebackOf, planKeepBoth, revisionFamily, revisionOf, supersedeRevised, supersededWords, type FamilyRow } from "./revision";

/**
 * A REVISION SUPERSEDES THE ESTIMATE IT REVISES (0391). The pointer is the intent (set at birth); the
 * status is the fact (set when the revision is accepted). Run against the thenable fake so the write is
 * seen to select what it moved. Names are stand-ins, never a customer's.
 */
const ORG = "org-1";
const world = (originalStatus: string, revises: string | null = "orig", revisionStatus = "accepted") =>
  fakeDb({
    quotes: [
      { id: "orig", org_id: ORG, quote_number: "Q-0041", status: originalStatus, revises_quote_id: null },
      { id: "rev", org_id: ORG, quote_number: "Q-0043", status: revisionStatus, revises_quote_id: revises },
    ],
  });
const statusOf = (tables: Record<string, Record<string, unknown>[]>, id: string) => tables.quotes.find((q) => q.id === id)?.status;

describe("supersedeRevised", () => {
  it("moves an ACCEPTED original to superseded and names it", async () => {
    const { sb, tables } = world("accepted");
    expect(await supersedeRevised(sb, { revisionId: "rev", orgId: ORG })).toEqual({ superseded: ["Q-0041"] });
    expect(statusOf(tables, "orig")).toBe("superseded");
    expect(statusOf(tables, "rev")).toBe("accepted");
  });
  it("moves a SENT original too (an offer the revision replaces)", async () => {
    const { sb, tables } = world("sent");
    expect(await supersedeRevised(sb, { revisionId: "rev", orgId: ORG })).toEqual({ superseded: ["Q-0041"] });
    expect(statusOf(tables, "orig")).toBe("superseded");
  });
  it("leaves a draft, a declined and an already-superseded original alone, and says nothing moved", async () => {
    for (const st of ["draft", "declined", "expired", "superseded"]) {
      const { sb, tables } = world(st);
      expect(await supersedeRevised(sb, { revisionId: "rev", orgId: ORG })).toEqual({ superseded: [] });
      expect(statusOf(tables, "orig")).toBe(st);
    }
  });
  it("only an ACCEPTED revision supersedes: Create Job on a draft revision moves nothing (the skeptic's case)", async () => {
    for (const st of ["draft", "sent", "declined"]) {
      const { sb, tables } = world("sent", "orig", st);
      expect(await supersedeRevised(sb, { revisionId: "rev", orgId: ORG })).toEqual({ superseded: [] });
      expect(statusOf(tables, "orig")).toBe("sent");
    }
  });
  it("a revision of nothing moves nothing", async () => {
    const { sb, tables } = world("accepted", null);
    expect(await supersedeRevised(sb, { revisionId: "rev", orgId: ORG })).toEqual({ superseded: [] });
    expect(statusOf(tables, "orig")).toBe("accepted");
  });
  it("a revision of a revision supersedes the whole chain, and a sibling revision too", async () => {
    const { sb, tables } = fakeDb({
      quotes: [
        { id: "q0", org_id: ORG, quote_number: "Q-0040", status: "sent", revises_quote_id: null },
        { id: "r1", org_id: ORG, quote_number: "Q-0041", status: "accepted", revises_quote_id: "q0" },
        { id: "r1b", org_id: ORG, quote_number: "Q-0042", status: "sent", revises_quote_id: "q0" }, // a sibling of r1: not r2's
        { id: "r2", org_id: ORG, quote_number: "Q-0043", status: "accepted", revises_quote_id: "r1" },
        { id: "r2b", org_id: ORG, quote_number: "Q-0044", status: "sent", revises_quote_id: "r1" }, // r2's sibling
        { id: "other", org_id: ORG, quote_number: "Q-0050", status: "accepted", revises_quote_id: null },
      ],
    });
    const res = await supersedeRevised(sb, { revisionId: "r2", orgId: ORG });
    expect(res.superseded).toEqual(["Q-0041", "Q-0040", "Q-0044"]);
    expect(statusOf(tables, "q0")).toBe("superseded");
    expect(statusOf(tables, "r1")).toBe("superseded");
    expect(statusOf(tables, "r2b")).toBe("superseded");
    expect(statusOf(tables, "r1b")).toBe("sent"); // revises q0, not r1: left to q0's own revision (r1, now superseded) — filed
    expect(statusOf(tables, "r2")).toBe("accepted");
    expect(statusOf(tables, "other")).toBe("accepted");
  });
  it("is idempotent: the second run has nothing left to move", async () => {
    const { sb } = world("accepted");
    await supersedeRevised(sb, { revisionId: "rev", orgId: ORG });
    expect(await supersedeRevised(sb, { revisionId: "rev", orgId: ORG })).toEqual({ superseded: [] });
  });
  it("is org-scoped: another company's revision id moves nothing here", async () => {
    const { sb, tables } = world("accepted");
    expect(await supersedeRevised(sb, { revisionId: "rev", orgId: "org-2" })).toEqual({ superseded: [] });
    expect(statusOf(tables, "orig")).toBe("accepted");
  });
  it("the words", () => {
    expect(supersededWords([])).toBeNull();
    expect(supersededWords(["Q-0041"])).toBe("Q-0041 is now superseded by this estimate.");
    expect(supersededWords(["Q-0041", "Q-0040", "Q-0044"])).toBe("Q-0041, Q-0040 and Q-0044 are now superseded by this estimate.");
  });
});

describe("revisionOf — the revision that replaced an estimate", () => {
  it("finds an accepted (or itself superseded) revision; none when the revision was deleted or walked back", async () => {
    const { sb } = world("superseded");
    expect(await revisionOf(sb, { quoteId: "orig", orgId: ORG })).toMatchObject({ id: "rev", quote_number: "Q-0043" });
    const gone = world("superseded", "orig", "sent");
    expect(await revisionOf(gone.sb, { quoteId: "orig", orgId: ORG })).toBeNull();
  });
});

describe("revisionOf says whether the one that stands revises THIS estimate itself (Keep Both's door, cn-v1168)", () => {
  it("a revision of the estimate is direct; the tip of a longer chain is not", async () => {
    const { sb } = world("superseded");
    expect(await revisionOf(sb, { quoteId: "orig", orgId: ORG })).toEqual({ id: "rev", quote_number: "Q-0043", direct: true });
    const chain = fakeDb({
      quotes: [
        { id: "q0", org_id: ORG, quote_number: "Q-0040", status: "superseded", revises_quote_id: null },
        { id: "r1", org_id: ORG, quote_number: "Q-0041", status: "superseded", revises_quote_id: "q0" },
        { id: "r2", org_id: ORG, quote_number: "Q-0043", status: "accepted", revises_quote_id: "r1" },
      ],
    });
    expect(await revisionOf(chain.sb, { quoteId: "q0", orgId: ORG })).toEqual({ id: "r2", quote_number: "Q-0043", direct: false });
    expect(await revisionOf(chain.sb, { quoteId: "r1", orgId: ORG })).toEqual({ id: "r2", quote_number: "Q-0043", direct: true });
  });
});

/**
 * KEEP BOTH (cn-v1168). The owner, 2026-11-19, with a duplex: one quote per unit, the second made with
 * Revise on the first, both accepted by the customer, and the first "got locked and dissapeared to the
 * bottom of the list, if i wanted it gone i would have deleted it". The plan is pure: given the
 * revision's family (the revision itself left out, as the caller leaves it), which estimates come back
 * and where to. Numbers are stand-ins.
 */
const row = (id: string, status: string, revises: string | null, accepted: string | null = null, job: string | null = "job-1"): FamilyRow => ({
  id,
  quote_number: id.toUpperCase(),
  status,
  revises_quote_id: revises,
  accepted_at: accepted,
  job_id: job,
});
const DAY1 = "2026-11-01T16:00:00Z";
const DAY2 = "2026-11-02T16:00:00Z";

describe("comebackOf — where an estimate comes back to, for the plan and for the page that asks first", () => {
  it("accepted when it carries the moment it was accepted, otherwise an open offer", () => {
    expect(comebackOf(DAY1)).toBe("accepted");
    expect(comebackOf(null)).toBe("sent");
    expect(comebackOf(undefined)).toBe("sent");
    expect(comebackOf("")).toBe("sent");
  });
  it("is the rule the plan writes by: the same row comes back to the same place", () => {
    for (const won of [DAY1, null]) {
      const plan = planKeepBoth([row("orig", "superseded", null, won)], "orig");
      expect(plan.restore.map((r) => r.to)).toEqual([comebackOf(won)]);
    }
  });
});

describe("planKeepBoth — what comes back when a revision is un-linked", () => {
  it("THE DUPLEX: the estimate it replaced comes back as accepted, with its job", () => {
    expect(planKeepBoth([row("orig", "superseded", null, DAY1)], "orig")).toEqual({
      restore: [{ id: "orig", quote_number: "ORIG", job_id: "job-1", to: "accepted" }],
      still: [],
    });
  });
  it("an estimate that was only ever an offer comes back as sent", () => {
    expect(planKeepBoth([row("orig", "superseded", null, null, null)], "orig").restore).toEqual([{ id: "orig", quote_number: "ORIG", job_id: null, to: "sent" }]);
  });
  it("a revision not accepted yet replaced nothing: nothing comes back, whatever the original's status", () => {
    for (const st of ["draft", "sent", "accepted", "declined", "expired"]) {
      expect(planKeepBoth([row("orig", st, null, st === "accepted" ? DAY1 : null)], "orig")).toEqual({ restore: [], still: [] });
    }
  });
  it("an accepted revision of the same original still replaces it: the original stays, and the plan says by what", () => {
    const plan = planKeepBoth([row("orig", "superseded", null, DAY1), row("sib", "accepted", "orig", DAY2)], "orig");
    expect(plan.restore).toEqual([]);
    expect(plan.still).toEqual([{ id: "orig", quote_number: "ORIG", by: "SIB" }]);
  });
  it("a sibling the un-linked revision had replaced comes back as the accepted price, and the original stays replaced by IT", () => {
    const plan = planKeepBoth([row("orig", "superseded", null, DAY1), row("sib", "superseded", "orig", DAY2)], "orig");
    expect(plan.restore).toEqual([{ id: "sib", quote_number: "SIB", job_id: "job-1", to: "accepted" }]);
    expect(plan.still).toEqual([{ id: "orig", quote_number: "ORIG", by: "SIB" }]);
  });
  it("of two siblings that were each accepted in turn, only the one accepted LAST comes back: two prices for one piece of work never both return", () => {
    const family = [row("orig", "superseded", null, null), row("early", "superseded", "orig", DAY1), row("late", "superseded", "orig", DAY2)];
    const plan = planKeepBoth(family, "orig");
    expect(plan.restore.map((r) => [r.id, r.to])).toEqual([["late", "accepted"]]);
    expect(plan.still).toEqual([
      { id: "early", quote_number: "EARLY", by: "LATE" },
      { id: "orig", quote_number: "ORIG", by: "LATE" },
    ]);
    // The same answer whichever order the read returned them in.
    expect(planKeepBoth([...family].reverse(), "orig").restore.map((r) => r.id)).toEqual(["late"]);
  });
  it("a sibling that was only an offer comes back as sent, and then nothing accepted replaces the original: it comes back too", () => {
    const plan = planKeepBoth([row("orig", "superseded", null, DAY1), row("sib", "superseded", "orig", null)], "orig");
    expect(plan.restore.map((r) => [r.id, r.to])).toEqual([
      ["sib", "sent"],
      ["orig", "accepted"],
    ]);
    expect(plan.still).toEqual([]);
  });
  it("THE CHAIN ABOVE: an original that comes back accepted goes on replacing what IT revised; one that comes back sent lets that one return", () => {
    // first ← orig (was accepted) ← [the un-linked revision]
    const accepted = planKeepBoth([row("first", "superseded", null, DAY1), row("orig", "superseded", "first", DAY2)], "orig");
    expect(accepted.restore.map((r) => [r.id, r.to])).toEqual([["orig", "accepted"]]);
    expect(accepted.still).toEqual([{ id: "first", quote_number: "FIRST", by: "ORIG" }]);
    // first (was accepted) ← orig (only an offer) ← [the un-linked revision]
    const offer = planKeepBoth([row("first", "superseded", null, DAY1), row("orig", "superseded", "first", null)], "orig");
    expect(offer.restore.map((r) => [r.id, r.to])).toEqual([
      ["orig", "sent"],
      ["first", "accepted"],
    ]);
  });
  it("an accepted estimate on ANOTHER branch below still replaces an ancestor", () => {
    // first ← orig ← [un-linked];  first ← cousin (accepted): first stays replaced by the cousin's line.
    const plan = planKeepBoth([row("first", "superseded", null, DAY1), row("orig", "superseded", "first", null), row("cousin", "accepted", "first", DAY2)], "orig");
    // orig is a revision of `first` beside the accepted cousin: still replaced. first has an accepted estimate below it: still replaced.
    expect(plan.restore).toEqual([]);
    expect(plan.still).toEqual([
      { id: "orig", quote_number: "ORIG", by: "COUSIN" },
      { id: "first", quote_number: "FIRST", by: "COUSIN" },
    ]);
  });
  it("only what the revision's acceptance could have moved is looked at: a superseded estimate lower in another line is not touched", () => {
    const plan = planKeepBoth([row("orig", "superseded", null, DAY1), row("sib", "sent", "orig", null), row("deep", "superseded", "sib", DAY1)], "orig");
    expect(plan.restore.map((r) => r.id)).toEqual(["orig"]);
  });
  it("an original that is not in the family, and a family that loops, both end: nothing thrown, nothing invented", () => {
    expect(planKeepBoth([row("someone", "superseded", null, DAY1)], "orig")).toEqual({ restore: [], still: [] });
    // Two estimates that each revise the other: the walk stops at the first repeat, and the plan is the
    // forward rule's own answer for that pair (the one below comes back, and goes on replacing the other).
    const loop = planKeepBoth([row("a", "superseded", "b", DAY1), row("b", "superseded", "a", DAY2)], "a");
    expect(loop).toEqual({
      restore: [{ id: "b", quote_number: "B", job_id: "job-1", to: "accepted" }],
      still: [{ id: "a", quote_number: "A", by: "B" }],
    });
  });
});

describe("revisionFamily — the read behind the plan", () => {
  const family = () =>
    fakeDb({
      quotes: [
        { id: "first", org_id: ORG, quote_number: "Q-0040", status: "superseded", revises_quote_id: null, accepted_at: DAY1, job_id: "job-1" },
        { id: "orig", org_id: ORG, quote_number: "Q-0041", status: "superseded", revises_quote_id: "first", accepted_at: DAY2, job_id: "job-1" },
        { id: "rev", org_id: ORG, quote_number: "Q-0043", status: "accepted", revises_quote_id: "orig", accepted_at: DAY2, job_id: "job-1" },
        { id: "revs-own", org_id: ORG, quote_number: "Q-0046", status: "draft", revises_quote_id: "rev", accepted_at: null, job_id: "job-1" },
        { id: "sib", org_id: ORG, quote_number: "Q-0044", status: "sent", revises_quote_id: "orig", accepted_at: null, job_id: "job-1" },
        { id: "cousin", org_id: ORG, quote_number: "Q-0045", status: "sent", revises_quote_id: "first", accepted_at: null, job_id: null },
        { id: "stranger", org_id: ORG, quote_number: "Q-0050", status: "accepted", revises_quote_id: null, accepted_at: DAY1, job_id: "job-2" },
        { id: "theirs", org_id: "org-2", quote_number: "Q-0001", status: "accepted", revises_quote_id: "orig", accepted_at: DAY1, job_id: "job-9" },
      ],
    });
  it("reads the original, the line above it and everything that revises any of them; never the revision being un-linked, what revises IT, an unrelated estimate, or another company's", async () => {
    const { sb } = family();
    const res = await revisionFamily(sb, { originalId: "orig", leaveOut: "rev", orgId: ORG });
    expect(res.error).toBeUndefined();
    expect(res.family.map((r) => r.id).sort()).toEqual(["cousin", "first", "orig", "sib"]);
    expect(res.family.find((r) => r.id === "orig")).toEqual({ id: "orig", org_id: ORG, quote_number: "Q-0041", status: "superseded", revises_quote_id: "first", accepted_at: DAY2, job_id: "job-1" });
  });
  it("the plan made from it brings back exactly what un-linking the revision frees", async () => {
    const { sb } = family();
    const { family: rows } = await revisionFamily(sb, { originalId: "orig", leaveOut: "rev", orgId: ORG });
    const plan = planKeepBoth(rows, "orig");
    expect(plan.restore.map((r) => [r.id, r.to])).toEqual([["orig", "accepted"]]);
    expect(plan.still).toEqual([{ id: "first", quote_number: "Q-0040", by: "Q-0041" }]);
  });
  it("an original that is gone, or another company's, is an empty family", async () => {
    const { sb } = family();
    expect(await revisionFamily(sb, { originalId: "nobody", leaveOut: "rev", orgId: ORG })).toEqual({ family: [] });
    expect(await revisionFamily(sb, { originalId: "orig", leaveOut: "rev", orgId: "org-2" })).toEqual({ family: [] });
  });
});
