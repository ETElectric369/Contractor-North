import { describe, it, expect } from "vitest";
import { fakeDb } from "@/test/fake-supabase";
import { revisionOf, supersedeRevised, supersededWords } from "./revision";

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
