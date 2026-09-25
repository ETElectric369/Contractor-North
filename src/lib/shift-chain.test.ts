import { describe, it, expect, vi } from "vitest";
import { familyOf, loadShiftChains, shiftChain, shiftInfo, shiftStartMs, type ChainPiece } from "./shift-chain";

/**
 * THE SHIFT, NOT THE PIECE (audit v994 SW1). Brian clocks in at 7:00 AM on job A, switches to job B
 * at 3:00 PM (0288 cuts: A closes at 3:00, B opens at 3:00 pointing at A) and forgets to clock out.
 * Every shift-level rule reads the chain these functions build, so the chain has to be exactly the
 * touching pieces of one family and one person.
 */
const A = "a0000000-0000-4000-8000-00000000000a";
const B = "b0000000-0000-4000-8000-00000000000b";
const C = "c0000000-0000-4000-8000-00000000000c";
const BRIAN = "brian-1";
const JIMMY = "jimmy-1";
// 2001-01-01, a day nobody worked. 7:00 AM Pacific = 15:00Z.
const T = (h: number, m = 0) => new Date(Date.UTC(2001, 0, 1, 15 + h, m)).toISOString();

const head: ChainPiece = { id: A, profile_id: BRIAN, clock_in: T(0), clock_out: T(8), status: "closed", split_from: null };
const live: ChainPiece = { id: B, profile_id: BRIAN, clock_in: T(8), clock_out: null, status: "open", split_from: A };

describe("shiftChain: the touching pieces of one family and one person", () => {
  it("an entry that never switched is a shift of one", () => {
    const solo = { ...head, id: C, clock_out: null, status: "open" };
    expect(shiftChain(solo, [head, solo]).map((p) => p.id)).toEqual([C]);
  });

  it("after one Switch Job the shift starts at the first piece", () => {
    expect(shiftChain(live, [head, live]).map((p) => p.id)).toEqual([A, B]);
    expect(shiftStartMs(live, [head, live])).toBe(Date.parse(T(0)));
  });

  it("three pieces (two switches) walk all the way back", () => {
    const mid: ChainPiece = { id: B, profile_id: BRIAN, clock_in: T(4), clock_out: T(8), status: "closed", split_from: A };
    const now: ChainPiece = { id: C, profile_id: BRIAN, clock_in: T(8), clock_out: null, status: "open", split_from: A };
    const first = { ...head, clock_out: T(4) };
    expect(shiftChain(now, [now, mid, first]).map((p) => p.id)).toEqual([A, B, C]);
  });

  it("a gap ends the walk: the office moved a piece's times, so the earlier work is not this stretch", () => {
    const gapped = { ...head, clock_out: T(7) };
    expect(shiftChain(live, [gapped, live]).map((p) => p.id)).toEqual([B]);
  });

  it("a second of slack: the pieces of a switch share one instant", () => {
    const close = { ...head, clock_out: new Date(Date.parse(T(8)) - 400).toISOString() };
    expect(shiftChain(live, [close, live]).map((p) => p.id)).toEqual([A, B]);
  });

  it("another person's touching entry is never part of Brian's shift", () => {
    const jimmy = { ...head, profile_id: JIMMY };
    expect(shiftChain(live, [jimmy, live]).map((p) => p.id)).toEqual([B]);
  });

  it("a touching entry of another family is not part of the shift (a clock-out and clock-in in one second)", () => {
    const other: ChainPiece = { id: C, profile_id: BRIAN, clock_in: T(0), clock_out: T(8), status: "closed", split_from: null };
    const liveOfA = { ...live };
    // C touches B but B's family is A, and A is not in the rows handed in.
    expect(shiftChain(liveOfA, [other, liveOfA]).map((p) => p.id)).toEqual([B]);
  });

  it("familyOf is the first entry: its own id, or the one it points at", () => {
    expect(familyOf(head)).toBe(A);
    expect(familyOf(live)).toBe(A);
  });
});

describe("shiftInfo: what the shift-level rules read", () => {
  it("carries the start, the earlier pieces, and whether a step already went out on an earlier piece", () => {
    const warnedHead = { ...head, long_shift_warned_at: T(10) };
    const info = shiftInfo(live, [warnedHead, live]);
    expect(info.startIso).toBe(T(0));
    expect(info.earlier.map((p) => p.id)).toEqual([A]);
    expect(info.warned).toBe(true);
    expect(info.nudged).toBe(false);
  });
});

describe("loadShiftChains: one read, org-scoped, and a failed read is never a silent fallback", () => {
  const fakeClient = (rows: ChainPiece[] | null, error: unknown = null) => {
    const calls: any[] = [];
    const chain: any = {
      select: (cols: string) => (calls.push(["select", cols]), chain),
      or: (f: string) => (calls.push(["or", f]), chain),
      eq: (c: string, v: string) => (calls.push(["eq", c, v]), chain),
      then: (resolve: any) => resolve({ data: rows, error }),
    };
    return { client: { from: vi.fn(() => chain) } as any, calls };
  };

  it("reads nothing for clocks that never switched", async () => {
    const { client } = fakeClient([]);
    const solo = { ...live, split_from: null };
    const m = await loadShiftChains(client, [solo], "org-1");
    expect(client.from).not.toHaveBeenCalled();
    expect(m.get(B)?.startIso).toBe(T(8));
  });

  it("reads the families by their first entry, scoped to the org, and resolves each clock's start", async () => {
    const { client, calls } = fakeClient([head, live]);
    const m = await loadShiftChains(client, [live], "org-1");
    expect(calls).toContainEqual(["or", `id.in.(${A}),split_from.in.(${A})`]);
    expect(calls).toContainEqual(["eq", "org_id", "org-1"]);
    expect(m.get(B)?.startIso).toBe(T(0));
  });

  it("throws on a failed read", async () => {
    const { client } = fakeClient(null, { message: "boom" });
    await expect(loadShiftChains(client, [live], "org-1")).rejects.toMatchObject({ message: "boom" });
  });
});
