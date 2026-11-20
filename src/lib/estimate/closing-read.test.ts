import { describe, it, expect } from "vitest";
import { CLOSING_CAP, CLOSING_COLUMNS, CLOSING_INVOICE_COLUMNS, countClosingAttention, loadClosing } from "./closing";

/**
 * THE ONE CLOSING READER, AGAINST A STAND-IN CLIENT (cn-v1172). Every read's columns are pinned, the
 * reads behind the list go in chunks of fifty ids, a failed read behind the list settles nothing and
 * logs no send (the estimate is listed, never hidden on a guess), and the list's order is the rule's.
 */

type Call = { table: string; cols: string; filters: unknown[][] };
type Answer = { data?: unknown[] | null; error?: unknown };

function stand(answer: (c: Call) => Answer) {
  const calls: Call[] = [];
  const client = {
    from(table: string) {
      const call: Call = { table, cols: "", filters: [] };
      const q: any = {
        select(c: string) {
          call.cols = c;
          calls.push(call);
          return q;
        },
        then: (ok: any, err: any) => {
          const a = answer(call);
          return Promise.resolve({ data: a.data ?? [], error: a.error ?? null }).then(ok, err);
        },
      };
      for (const m of ["eq", "in", "order", "limit"]) q[m] = (...args: unknown[]) => (call.filters.push([m, ...args]), q);
      return q;
    },
  };
  return { client: client as any, calls };
}

const TODAY = "2026-11-19";
const sentRow = (id: string, o: Record<string, unknown> = {}) => ({
  id,
  quote_number: `E-9${id.padStart(2, "0")}`,
  doc_type: "estimate",
  title: "Larkspur Panel",
  status: "sent",
  total: "1200",
  valid_until: null,
  created_at: "2026-11-01T17:00:00Z",
  job_id: null,
  customer_id: "c-1",
  inquiry_id: null,
  customers: { name: "Dana Rook", company_name: null },
  jobs: null,
  ...o,
});

describe("loadClosing", () => {
  it("reads the sent estimates with CLOSING_COLUMNS, then the four reads the rule needs, each with its own columns", async () => {
    const { client, calls } = stand((c) => (c.table === "quotes" && c.cols === CLOSING_COLUMNS ? { data: [sentRow("1", { job_id: "j-1", jobs: { status: "scheduled" } })] } : {}));
    const r = await loadClosing(client, { todayStr: TODAY, orgId: "org-1" });
    expect(r.error).toBeNull();
    expect(calls.map((c) => [c.table, c.cols])).toEqual([
      ["quotes", CLOSING_COLUMNS],
      ["invoices", CLOSING_INVOICE_COLUMNS],
      ["invoices", CLOSING_INVOICE_COLUMNS],
      ["quotes", "id, revises_quote_id, status"],
      ["sent_messages", "doc_id, sent_at"],
    ]);
    // Only sent estimates, org-scoped, the cap plus one (to know it was cut), oldest first.
    expect(calls[0].filters).toEqual(
      expect.arrayContaining([["eq", "status", "sent"], ["eq", "org_id", "org-1"], ["order", "created_at", { ascending: true }], ["limit", CLOSING_CAP + 1]]),
    );
    expect(calls[1].filters).toContainEqual(["in", "job_id", ["j-1"]]);
    expect(calls[2].filters).toContainEqual(["in", "quote_id", ["1"]]);
    expect(calls[4].filters).toContainEqual(["eq", "doc_kind", "quote"]);
    for (const c of calls) expect(c.filters, c.table).toContainEqual(["eq", "org_id", "org-1"]);
    // No money read but the estimate's own total; no follow-up day.
    expect(calls.map((c) => c.cols).join(" ")).not.toContain("follow_up_at");
  });

  it("an empty list makes no further read", async () => {
    const { client, calls } = stand(() => ({}));
    expect(await loadClosing(client, { todayStr: TODAY })).toEqual({ rows: [], cut: false, error: null, softErrors: [] });
    expect(calls).toHaveLength(1);
  });

  it("asks in chunks of fifty ids", async () => {
    const many = Array.from({ length: 73 }, (_, i) => sentRow(String(i + 1)));
    const { client, calls } = stand((c) => (c.table === "quotes" && c.cols === CLOSING_COLUMNS ? { data: many } : {}));
    const r = await loadClosing(client, { todayStr: TODAY });
    expect(r.rows).toHaveLength(73);
    const sends = calls.filter((c) => c.table === "sent_messages");
    expect(sends.map((c) => (c.filters.find((f) => f[0] === "in")![2] as string[]).length)).toEqual([50, 23]);
    // No job on any of them: no job read is asked for nothing.
    expect(calls.filter((c) => c.table === "invoices" && c.filters.some((f) => f[1] === "job_id"))).toHaveLength(0);
  });

  it("the list's own read failing is an error, never an empty list; count throws", async () => {
    const { client } = stand(() => ({ error: { message: "boom" } }));
    const r = await loadClosing(client, { todayStr: TODAY });
    expect(r.error).toEqual({ message: "boom" });
    await expect(countClosingAttention(client, { todayStr: TODAY })).rejects.toEqual({ message: "boom" });
  });

  it("a failed read behind the list settles nothing and logs no send: the estimate is listed and the error handed back", async () => {
    const { client } = stand((c) => {
      if (c.table === "quotes" && c.cols === CLOSING_COLUMNS) return { data: [sentRow("1", { job_id: "j-1", jobs: { status: "scheduled" } })] };
      if (c.table === "invoices") return { error: { message: "bills down" } };
      if (c.table === "sent_messages") return { error: { message: "log down" } };
      return {};
    });
    const r = await loadClosing(client, { todayStr: TODAY });
    expect(r.rows.map((x) => x.id)).toEqual(["1"]);
    expect(r.rows[0].state).toMatchObject({ closing: true, sentLogged: false, sinceAt: "2026-11-01T17:00:00Z" });
    expect(r.softErrors).toEqual([{ message: "bills down" }, { message: "bills down" }, { message: "log down" }]);
  });

  it("a settled estimate leaves (a bill names it); the last send is the newest; the order is the rule's", async () => {
    const { client } = stand((c) => {
      if (c.table === "quotes" && c.cols === CLOSING_COLUMNS)
        return {
          data: [
            sentRow("1"), // quiet: written Nov 1, no send logged
            sentRow("2", { created_at: "2026-11-15T17:00:00Z" }), // fresh
            sentRow("3"), // billed: settled
            sentRow("4", { created_at: "2026-11-17T17:00:00Z", valid_until: "2026-11-18" }), // offer ended
            sentRow("5", { created_at: "2026-10-01T17:00:00Z" }), // written long ago, sent again yesterday
          ],
        };
      if (c.table === "invoices" && c.filters.some((f) => f[1] === "quote_id"))
        return { data: [{ id: "inv-1", quote_id: "3", job_id: null, status: "sent", created_at: "2026-11-10T17:00:00Z", invoice_kind: "standard" }] };
      if (c.table === "sent_messages")
        return { data: [{ doc_id: "5", sent_at: "2026-10-02T17:00:00Z" }, { doc_id: "5", sent_at: "2026-11-18T17:00:00Z" }] };
      return {};
    });
    const r = await loadClosing(client, { todayStr: TODAY });
    expect(r.rows.map((x) => [x.id, x.state.why])).toEqual([
      ["1", "quiet"],
      ["4", "offer_ended"],
      ["2", null],
      ["5", null],
    ]);
    expect(r.rows.find((x) => x.id === "5")!.state).toMatchObject({ sentLogged: true, sinceAt: "2026-11-18T17:00:00Z" });
    expect(r.rows[0]).toMatchObject({ customerName: "Dana Rook", total: 1200, quote_number: "E-901" });
    expect(await countClosingAttention(client, { todayStr: TODAY })).toBe(2);
  });

  it("more than the cap: the ones written first are kept and the list says it was cut", async () => {
    const many = Array.from({ length: CLOSING_CAP + 1 }, (_, i) => sentRow(String(i + 1)));
    const { client } = stand((c) => (c.table === "quotes" && c.cols === CLOSING_COLUMNS ? { data: many } : {}));
    const r = await loadClosing(client, { todayStr: TODAY });
    expect(r.cut).toBe(true);
    expect(r.rows).toHaveLength(CLOSING_CAP);
  });
});
