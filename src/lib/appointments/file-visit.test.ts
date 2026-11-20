import { describe, it, expect } from "vitest";
import { fileVisitOrder, mergeVisits, visitStateKey, isOpenFileVisit } from "./file-visit";
import { translator } from "@/lib/i18n";

/**
 * ONE WAY TO SAY A VISIT ON A PERSON'S FILE (cn-v1171): the state table over every status and outcome,
 * cancelled included; what counts as still ahead; the order; and the merge of two reads.
 */
const NOW = Date.parse("2026-11-19T17:00:00Z");
const AHEAD = "2026-11-21T17:00:00Z";
const PAST = "2026-11-18T17:00:00Z";

describe("visitStateKey: the outcome first, then cancelled, then completed, then booked", () => {
  const STATUSES = ["scheduled", "proposed", "completed", "cancelled", "mystery", null] as const;
  const OUTCOMES = [null, "", "won", "lost", "no_bid", "mystery"] as const;
  const expected = (status: string | null, outcome: string | null): string | null => {
    if (outcome === "won") return "ld_btn_fileVisitWon";
    if (outcome === "lost" || outcome === "no_bid") return "ld_btn_fileVisitNotSold";
    if (status === "cancelled") return "ld_btn_fileVisitCancelled";
    if (status === "completed") return "ld_btn_fileVisitDone";
    if (status === "scheduled" || status === "proposed") return "ld_btn_fileVisitBooked";
    return null;
  };
  for (const status of STATUSES) {
    for (const outcome of OUTCOMES) {
      it(`${status} / ${outcome}`, () => {
        expect(visitStateKey({ status, outcome })).toBe(expected(status, outcome));
      });
    }
  }
  it("the pinned rows, by hand", () => {
    expect(visitStateKey({ status: "cancelled", outcome: "lost" })).toBe("ld_btn_fileVisitNotSold");
    expect(visitStateKey({ status: "cancelled", outcome: null })).toBe("ld_btn_fileVisitCancelled");
    expect(visitStateKey({ status: "cancelled", outcome: "won" })).toBe("ld_btn_fileVisitWon");
  });
  it("every key it returns has words in both languages, and Cancelled is Cancelada", () => {
    for (const key of ["ld_btn_fileVisitWon", "ld_btn_fileVisitNotSold", "ld_btn_fileVisitCancelled", "ld_btn_fileVisitDone", "ld_btn_fileVisitBooked"]) {
      expect(translator("en")(key)).not.toBe(key);
      expect(translator("es")(key)).not.toBe(key);
    }
    expect(translator("en")("ld_btn_fileVisitCancelled")).toBe("Cancelled");
    expect(translator("es")("ld_btn_fileVisitCancelled")).toBe("Cancelada");
  });
});

describe("isOpenFileVisit: booked or waiting, not done, not ended, not cancelled", () => {
  const cases: [string | null, string | null, string | null, boolean][] = [
    ["scheduled", null, AHEAD, true],
    ["scheduled", null, null, true],
    ["scheduled", null, PAST, true],
    ["proposed", null, AHEAD, true],
    ["proposed", null, PAST, false], // the pick ran out: its lead is back on the Leads list
    ["completed", null, PAST, false],
    ["completed", "won", PAST, false],
    ["scheduled", "lost", AHEAD, false],
    ["cancelled", null, AHEAD, false],
    ["mystery", null, AHEAD, false],
  ];
  it.each(cases)("%s / %s / %s → %s", (status, outcome, starts_at, ahead) => {
    expect(isOpenFileVisit({ status, outcome, starts_at }, NOW)).toBe(ahead);
  });
});

describe("fileVisitOrder: waiting for a day on top, then newest first", () => {
  it("orders", () => {
    const v = (id: string, status: string, starts_at: string | null) => ({ id, status, starts_at });
    const out = fileVisitOrder([
      v("old", "completed", "2026-10-01T17:00:00Z"),
      v("new", "scheduled", AHEAD),
      v("waiting", "scheduled", null),
      v("cancelledNoDay", "cancelled", null),
      v("mid", "cancelled", PAST),
    ]);
    expect(out.map((x) => x.id)).toEqual(["waiting", "new", "mid", "old", "cancelledNoDay"]);
  });
  it("does not change the list it is handed", () => {
    const list = [{ id: "a", status: "scheduled", starts_at: PAST }, { id: "b", status: "scheduled", starts_at: AHEAD }];
    fileVisitOrder(list);
    expect(list.map((x) => x.id)).toEqual(["a", "b"]);
  });
});

describe("mergeVisits: each visit once", () => {
  it("keeps the first read's row and adds the rest", () => {
    const out = mergeVisits([{ id: "a", n: 1 }, { id: "b", n: 1 }], [{ id: "b", n: 2 }, { id: "c", n: 2 }]);
    expect(out).toEqual([{ id: "a", n: 1 }, { id: "b", n: 1 }, { id: "c", n: 2 }]);
  });
});
