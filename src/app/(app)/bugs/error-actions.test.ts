import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * THE ERROR SINK'S DOORS ARE NORTH'S OWN (cn-v1136, 0399). Every caught failure files itself; only
 * a platform admin reads the list or marks a row, through platform_set_error_status — writes are
 * RPC-only. A failed read is said beside empty rows (cn-v1130's rule), the gate's nothing is a plain
 * nothing, a company's name comes back through platform_org_label once per distinct company, and a
 * row the RPC answers false for is said in words, never reported as marked (the silent-write law).
 *
 * TWO READS (skeptic #42, S4): the OPEN non-trace rows (new or triaged, level not trace) up to
 * PostgREST's cap of 1,000, and the REST (fixed or ignored, or any trace) at 300 — so a storm of
 * traces can never crowd an open error off the page the badge still counts. A label the RPC could
 * not give is filed under bug-watch:org-label and said as "Unknown Company" (N4).
 */
const state = vi.hoisted(() => ({
  ctx: null as any,
  open: { data: null as unknown[] | null, error: null as null | { message: string } },
  rest: { data: null as unknown[] | null, error: null as null | { message: string } },
  rpc: { data: true as unknown, error: null as null | { code?: string; message?: string } },
  labels: {} as Record<string, string | null | { error: { message: string } }>,
  rpcCalls: [] as { fn: string; args: any }[],
  reads: [] as { table: string; cols: string; filters: [string, ...unknown[]][]; order: unknown; limit: number }[],
  reportError: vi.fn(),
}));
vi.mock("@/lib/platform-admin", () => ({ requirePlatformAdmin: vi.fn(async () => state.ctx) }));
vi.mock("@/lib/observe", () => ({ reportError: state.reportError }));

import { listErrorEvents, setErrorEventStatus, OPEN_ERRORS_LIMIT, REST_ERRORS_FILTER, UNKNOWN_COMPANY } from "./error-actions";

/** A pretend viewer's client: every chain is recorded with its filters; `.or` marks the rest read, `.in` the open one. */
function client() {
  return {
    from: (table: string) => {
      const rec = { table, cols: "", filters: [] as [string, ...unknown[]][], order: null as unknown, limit: 0 };
      const chain: any = {
        select: (cols: string) => {
          rec.cols = cols;
          return chain;
        },
        in: (col: string, vals: unknown[]) => {
          rec.filters.push(["in", col, vals]);
          return chain;
        },
        neq: (col: string, val: unknown) => {
          rec.filters.push(["neq", col, val]);
          return chain;
        },
        or: (filter: string) => {
          rec.filters.push(["or", filter]);
          return chain;
        },
        order: (col: string, opts: unknown) => {
          rec.order = { col, ...(opts as object) };
          return chain;
        },
        limit: (n: number) => {
          rec.limit = n;
          state.reads.push({ ...rec });
          const isRest = rec.filters.some(([m]) => m === "or");
          return Promise.resolve(isRest ? state.rest : state.open);
        },
      };
      return chain;
    },
    rpc: (fn: string, args: any) => {
      state.rpcCalls.push({ fn, args });
      if (fn === "platform_org_label") {
        const l = state.labels[args.p_org];
        if (l && typeof l === "object") return Promise.resolve({ data: null, error: l.error });
        return Promise.resolve({ data: l ?? null, error: null });
      }
      return Promise.resolve(state.rpc);
    },
  };
}

const ROW = {
  id: "e1",
  title: "could not connect to server",
  culprit: "app-layout:bug-count",
  level: "error",
  status: "new",
  event_count: 3,
  first_seen: "2026-10-26T10:00:00Z",
  last_seen: "2026-10-27T10:00:00Z",
  org_id: "o1",
  payload: { where: "app-layout:bug-count", message: "could not connect to server", extra: null },
  last_payload: null,
};

beforeEach(() => {
  state.ctx = { supabase: client(), userId: "admin" };
  state.open = { data: null, error: null };
  state.rest = { data: null, error: null };
  state.rpc = { data: true, error: null };
  state.labels = {};
  state.rpcCalls = [];
  state.reads = [];
  state.reportError.mockClear();
});

const COLS = "id, title, culprit, level, status, event_count, first_seen, last_seen, org_id, payload, last_payload";

describe("listErrorEvents: rows beside the read's error", () => {
  it("the gate: anyone but a platform admin gets nothing, and no error — and no read is made", async () => {
    state.ctx = { error: "Only North's own team can do that." };
    expect(await listErrorEvents()).toEqual({ rows: [], error: null, openCapped: false });
    expect(state.reads).toEqual([]);
  });

  it("a failed read — either of the two — is NOT an empty list: no rows, and the database's sentence in English", async () => {
    state.open = { data: null, error: { message: "could not connect to server" } };
    state.rest = { data: [ROW], error: null };
    expect(await listErrorEvents()).toEqual({ rows: [], error: "could not connect to server", openCapped: false });
    state.open = { data: [ROW], error: null };
    state.rest = { data: null, error: { message: "permission denied for table error_events" } };
    const refused = await listErrorEvents();
    expect(refused.rows).toEqual([]);
    expect(refused.error).toContain("You don't have access");
  });

  it("TWO reads under the viewer's own client (S4): the open non-trace rows up to PostgREST's 1,000, then the closed-or-trace rest at 300, each newest sighting first", async () => {
    state.open = { data: [ROW], error: null };
    await listErrorEvents();
    expect(OPEN_ERRORS_LIMIT).toBe(1000);
    expect(REST_ERRORS_FILTER).toBe("status.in.(fixed,ignored),level.eq.trace");
    expect(state.reads).toEqual([
      {
        table: "error_events",
        cols: COLS,
        filters: [
          ["in", "status", ["new", "triaged"]],
          ["neq", "level", "trace"],
        ],
        order: { col: "last_seen", ascending: false },
        limit: 1000,
      },
      {
        table: "error_events",
        cols: COLS,
        filters: [["or", "status.in.(fixed,ignored),level.eq.trace"]],
        order: { col: "last_seen", ascending: false },
        limit: 300,
      },
    ]);
  });

  it("the two reads are merged, open first, a row once by id; openCapped only when exactly the cap came back", async () => {
    const open = Array.from({ length: 3 }, (_, i) => ({ ...ROW, id: `open-${i}` }));
    const rest = [
      { ...ROW, id: "closed-1", status: "fixed" },
      { ...ROW, id: "trace-1", level: "trace" },
      { ...ROW, id: "open-1" }, // a twin the database should never send: kept once
    ];
    state.open = { data: open, error: null };
    state.rest = { data: rest, error: null };
    const r = await listErrorEvents();
    expect(r.rows.map((x) => x.id)).toEqual(["open-0", "open-1", "open-2", "closed-1", "trace-1"]);
    expect(r.openCapped).toBe(false);
    state.open = { data: Array.from({ length: 1000 }, (_, i) => ({ ...ROW, id: `open-${i}` })), error: null };
    state.rest = { data: [], error: null };
    const capped = await listErrorEvents();
    expect(capped.rows).toHaveLength(1000);
    expect(capped.openCapped).toBe(true);
  });

  it("a good read maps the rows, both payloads riding along, and carries no error", async () => {
    state.open = { data: [ROW], error: null };
    state.labels = { o1: "Pinecone Electric" };
    expect(await listErrorEvents()).toEqual({
      openCapped: false,
      rows: [
        {
          id: "e1",
          title: "could not connect to server",
          culprit: "app-layout:bug-count",
          level: "error",
          status: "new",
          event_count: 3,
          first_seen: "2026-10-26T10:00:00Z",
          last_seen: "2026-10-27T10:00:00Z",
          org: "Pinecone Electric",
          payload: { where: "app-layout:bug-count", message: "could not connect to server", extra: null },
          last_payload: null,
        },
      ],
      error: null,
    });
  });

  it("company labels: one platform_org_label per DISTINCT company; a row with no company stays null; a null label stays null", async () => {
    state.open = {
      data: [
        { ...ROW, id: "e1", org_id: "o1" },
        { ...ROW, id: "e2", org_id: "o1" },
        { ...ROW, id: "e3", org_id: "o2" },
        { ...ROW, id: "e4", org_id: null },
      ],
      error: null,
    };
    state.labels = { o1: "Pinecone Electric", o2: null };
    const { rows, error } = await listErrorEvents();
    expect(error).toBeNull();
    expect(rows.map((r) => r.org)).toEqual(["Pinecone Electric", "Pinecone Electric", null, null]);
    const labelCalls = state.rpcCalls.filter((c) => c.fn === "platform_org_label");
    expect(labelCalls).toHaveLength(2);
    expect(labelCalls.map((c) => c.args)).toEqual([{ p_org: "o1" }, { p_org: "o2" }]);
    expect(state.reportError).not.toHaveBeenCalled();
  });

  it("a label the RPC could not give is filed under bug-watch:org-label with the company and said as Unknown Company — never a silent null (N4)", async () => {
    state.open = { data: [{ ...ROW, id: "e1", org_id: "o1" }, { ...ROW, id: "e2", org_id: "o2" }], error: null };
    state.labels = { o1: { error: { message: "permission denied for function platform_org_label" } }, o2: "Blue Heron Decks" };
    const { rows, error } = await listErrorEvents();
    expect(error).toBeNull();
    expect(UNKNOWN_COMPANY).toBe("Unknown Company");
    expect(rows.map((r) => r.org)).toEqual(["Unknown Company", "Blue Heron Decks"]);
    expect(state.reportError).toHaveBeenCalledTimes(1);
    expect(state.reportError).toHaveBeenCalledWith("bug-watch:org-label", { message: "permission denied for function platform_org_label" }, { orgId: "o1" });
  });
});

describe("setErrorEventStatus: one RPC door, platform admins only", () => {
  it("refuses a company's owner in words, and never reaches the RPC", async () => {
    state.ctx = { error: "Only North's own team can do that." };
    expect(await setErrorEventStatus("e1", "fixed")).toEqual({ ok: false, error: "Only North's own team can do that." });
    expect(state.rpcCalls).toEqual([]);
  });

  it("never writes a status the page can't show", async () => {
    expect(await setErrorEventStatus("e1", "banana")).toEqual({ ok: false, error: "Unknown status." });
    expect(await setErrorEventStatus("e1", "")).toEqual({ ok: false, error: "Unknown status." });
    expect(state.rpcCalls).toEqual([]);
  });

  it("each of the four words goes through platform_set_error_status", async () => {
    for (const status of ["new", "triaged", "fixed", "ignored"]) {
      expect(await setErrorEventStatus("e1", status)).toEqual({ ok: true });
    }
    expect(state.rpcCalls).toEqual(
      ["new", "triaged", "fixed", "ignored"].map((s) => ({ fn: "platform_set_error_status", args: { p_id: "e1", p_status: s } })),
    );
  });

  it("the RPC's false — the row is not there — is said, never reported as marked", async () => {
    state.rpc = { data: false, error: null };
    expect(await setErrorEventStatus("e1", "fixed")).toEqual({ ok: false, error: "That row isn't there any more." });
  });

  it("the RPC's own refusal is said in English", async () => {
    state.rpc = { data: null, error: { message: "Only North's own team can mark an error." } };
    expect(await setErrorEventStatus("e1", "fixed")).toEqual({ ok: false, error: "Only North's own team can mark an error." });
    state.rpc = { data: null, error: { message: "permission denied for function platform_set_error_status" } };
    const res = await setErrorEventStatus("e1", "fixed");
    expect(res.ok).toBe(false);
    expect(res.error).toContain("You don't have access");
  });
});
