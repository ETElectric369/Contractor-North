import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Send To QuickBooks shows only when THIS company has connected (Wave 0): qboConfigured only says
// North can reach Intuit, so every company's invoice menu offered it, connected or not.
const state = vi.hoisted(() => ({ calls: 0, row: null as { realm_id: string | null } | null, error: null as unknown, orgs: [] as string[] }));
vi.mock("@/lib/supabase/server", () => ({
  createServiceClient: () => {
    state.calls += 1;
    const chain: any = {
      select: () => chain,
      eq: (_col: string, v: string) => {
        state.orgs.push(v);
        return chain;
      },
      maybeSingle: async () => ({ data: state.row, error: state.error }),
    };
    return { from: () => chain };
  },
}));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));

import { qboConnected } from "./quickbooks";

const saved = { id: process.env.QBO_CLIENT_ID, secret: process.env.QBO_CLIENT_SECRET };
beforeEach(() => {
  state.calls = 0;
  state.row = null;
  state.error = null;
  state.orgs = [];
  process.env.QBO_CLIENT_ID = "id";
  process.env.QBO_CLIENT_SECRET = "secret";
});
afterEach(() => {
  process.env.QBO_CLIENT_ID = saved.id;
  process.env.QBO_CLIENT_SECRET = saved.secret;
});

describe("qboConnected", () => {
  it("is false, without a database call, when North can't reach QuickBooks at all", async () => {
    delete process.env.QBO_CLIENT_ID;
    expect(await qboConnected("org-1")).toBe(false);
    expect(state.calls).toBe(0);
  });

  it("is false with no company", async () => {
    expect(await qboConnected(null)).toBe(false);
    expect(state.calls).toBe(0);
  });

  it("is false when this company has not connected", async () => {
    expect(await qboConnected("org-1")).toBe(false);
    expect(state.orgs).toEqual(["org-1"]);
  });

  it("is true only when this company's row carries a realm", async () => {
    state.row = { realm_id: "9130" };
    expect(await qboConnected("org-1")).toBe(true);
    state.row = { realm_id: null };
    expect(await qboConnected("org-1")).toBe(false);
  });

  it("is false when the read fails", async () => {
    state.row = { realm_id: "9130" };
    state.error = { message: "boom" };
    expect(await qboConnected("org-1")).toBe(false);
  });

  it("gates the invoice page's QuickBooks row", () => {
    const s = readFileSync(join(process.cwd(), "src/app/(app)/billing/[id]/page.tsx"), "utf8");
    expect(s).toContain("{qboOn && <QboInvoiceButton menuItem id={inv.id} />}");
    expect(s).not.toContain("qboConfigured()");
  });
});
