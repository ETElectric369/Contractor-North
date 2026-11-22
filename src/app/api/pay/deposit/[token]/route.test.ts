import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * THE DEPOSIT DOOR (cn-v1177): GET /api/pay/deposit/<quote token> calls the ONE function
 * (ensureDepositRequestForQuoteToken, the money lane's; stood in for here) and only sends the browser
 * on. It makes nothing itself, so a second, third or tenth tap is the same answer: the one bill.
 */
const m = vi.hoisted(() => ({
  ensure: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({ ok: true, invoiceToken: "inv-tok-900", paid: false })),
  limited: false,
}));
vi.mock("@/lib/payment-request", () => ({ ensureDepositRequestForQuoteToken: m.ensure }));
vi.mock("@/lib/supabase/server", () => ({ createServiceClient: () => ({ service: true }) }));
vi.mock("@/lib/rate-limit", () => ({ rateLimited: async () => m.limited, clientIp: () => "ip" }));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));

const route = await import("./route");
const hit = (token = "tok-e900") => route.GET(new Request(`https://larkspur.example/api/pay/deposit/${token}`), { params: Promise.resolve({ token }) });

beforeEach(() => {
  m.ensure.mockClear();
  m.limited = false;
});

describe("GET /api/pay/deposit/<token>", () => {
  it("owed: 303 to that bill's own card door, never cached or indexed", async () => {
    const res = await hit();
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("https://larkspur.example/api/pay/inv-tok-900");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-robots-tag")).toContain("noindex");
    expect(m.ensure).toHaveBeenCalledWith({ service: true }, "tok-e900");
  });

  it("paid: 303 to the bill's page", async () => {
    m.ensure.mockResolvedValueOnce({ ok: true, invoiceToken: "inv-tok-900", paid: true });
    expect((await hit()).headers.get("location")).toBe("https://larkspur.example/i/inv-tok-900");
  });

  it("any refusal, or a throw: back to the estimate with ?deposit=unavailable", async () => {
    for (const why of ["not_found", "not_accepted", "no_deposit", "no_job", "no_customer", "failed"]) {
      m.ensure.mockResolvedValueOnce({ ok: false, why });
      expect((await hit()).headers.get("location")).toBe("https://larkspur.example/q/tok-e900?deposit=unavailable");
    }
    m.ensure.mockRejectedValueOnce(new Error("down"));
    expect((await hit()).headers.get("location")).toBe("https://larkspur.example/q/tok-e900?deposit=unavailable");
  });

  it("hit any number of times: each tap asks the one function, and lands on the same bill", async () => {
    const where = new Set<string | null>();
    for (let i = 0; i < 5; i++) where.add((await hit()).headers.get("location"));
    expect([...where]).toEqual(["https://larkspur.example/api/pay/inv-tok-900"]);
    expect(m.ensure).toHaveBeenCalledTimes(5);
  });

  it("rate-limited: 429, and the function is not asked", async () => {
    m.limited = true;
    expect((await hit()).status).toBe(429);
    expect(m.ensure).not.toHaveBeenCalled();
  });

  it("the file exports handlers and segment config only, and writes nothing itself", () => {
    expect(Object.keys(route).sort()).toEqual(["GET", "dynamic", "runtime"]);
    const src = readFileSync(join(process.cwd(), "src/app/api/pay/deposit/[token]/route.ts"), "utf8");
    expect(src).not.toMatch(/\.(insert|update|upsert|delete)\(|\.rpc\(/);
  });
});
