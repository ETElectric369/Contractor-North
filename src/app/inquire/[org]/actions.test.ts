import { describe, it, expect, vi, beforeEach } from "vitest";
import { standIn, type Row } from "@/lib/inquiries/public-stand-in.test-support";

/**
 * /inquire's submit hands THIS browser the id of the lead it wrote (cn-v1180, audit A6), and the
 * office alert opens that lead's own file (A2). submit_inquiry returns nothing, so the row is read
 * back: this company, this door, the last two minutes, the exact values just sent. On a stand-in that
 * honours filters and column lists, with the RPC writing the row the way the function does.
 */
const svc = vi.hoisted(() => ({ client: null as any }));
const sent = vi.hoisted(() => ({ calls: [] as any[] }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/rate-limit", () => ({ rateLimited: vi.fn(async () => false), clientIp: () => "203.0.113.9" }));
vi.mock("@/lib/supabase/server", () => ({ createServiceClient: () => svc.client, createClient: vi.fn() }));
vi.mock("@/lib/push", () => ({ orgStaffIds: vi.fn(async () => ["p-owner"]) }));
vi.mock("@/lib/notifications", () => ({ notifyPeople: vi.fn(async (...a: any[]) => void sent.calls.push(a)) }));

const { submitPublicInquiry } = await import("./actions");

const ORG = "0a0a0a0a-0000-4000-8000-000000000001";
const OTHER = "0b0b0b0b-0000-4000-8000-000000000002";
const now = () => new Date().toISOString();

function world(leads: Row[], features: Record<string, boolean> = {}, written: { message?: (m: string | null) => string | null } = {}) {
  let n = 0;
  const db = standIn(
    {
      organizations: [
        { id: ORG, settings: { features } },
        { id: OTHER, settings: {} },
      ],
      inquiries: leads,
    },
    {
      // The function's own insert (0092): trimmed values, source public_form, status new.
      submit_inquiry: (a) => {
        db.tables.inquiries.push({
          id: `written-${++n}`,
          org_id: a.p_org,
          name: String(a.p_name).trim().slice(0, 200),
          email: a.p_email ?? null,
          phone: a.p_phone ?? null,
          // left(btrim(p_message), 2000): CHARACTERS, as the database counts them (0092).
          message: written.message
            ? written.message(a.p_message == null ? null : String(a.p_message))
            : a.p_message == null
              ? null
              : Array.from(String(a.p_message).trim()).slice(0, 2000).join("") || null,
          source: "public_form",
          status: "new",
          created_at: now(),
        });
        // A newer row lands in the same instant: another company's, and another visitor's here.
        db.tables.inquiries.push(
          { id: "other-company", org_id: OTHER, name: "Theo Vance", phone: "555-0109", email: null, message: null, source: "public_form", created_at: now() + "z" },
          { id: "other-visitor", org_id: ORG, name: "Casey Loam", phone: "555-0108", email: null, message: null, source: "public_form", created_at: now() + "z" },
        );
        return {};
      },
    },
  );
  svc.client = db.client;
  return db;
}

beforeEach(() => {
  sent.calls = [];
});

describe("submitPublicInquiry hands back the lead it wrote", () => {
  it("the id is this submit's row, never a newer row of another visitor or another company", async () => {
    const db = world([]);
    const res = await submitPublicInquiry(ORG, { name: "  Dana Rook ", phone: "555-0102", message: "Panel upgrade" });
    expect(res).toEqual({ ok: true, leadId: "written-1" });
    const readBack = db.log.find((l) => l.table === "inquiries" && l.op === "select");
    expect(readBack?.filters).toEqual(expect.arrayContaining([`org_id=${ORG}`, "source=public_form"]));
  });

  it("the office alert opens that lead's own file (Leads on), My Day with Leads off", async () => {
    world([]);
    await submitPublicInquiry(ORG, { name: "Dana Rook", phone: "555-0102" });
    await vi.waitFor(() => expect(sent.calls).toHaveLength(1));
    expect(sent.calls[0][3].url).toBe("/leads/written-1");
    expect(sent.calls[0][3].body).toContain("Dana Rook");

    sent.calls = [];
    world([], { leads: false });
    await submitPublicInquiry(ORG, { name: "Dana Rook", phone: "555-0102" });
    await vi.waitFor(() => expect(sent.calls).toHaveLength(1));
    expect(sent.calls[0][3].url).toBe("/planner");
  });

  it("the honeypot still gets the silent fake success, with no id and no write", async () => {
    const db = world([]);
    expect(await submitPublicInquiry(ORG, { hp: "x", name: "bot", phone: "555-0100" })).toEqual({ ok: true });
    expect(db.tables.inquiries).toEqual([]);
  });
});

describe("skeptic #83 (S8) · the read-back compares the way the database stored it", () => {
  it("a long message with emoji in it is still this submit's row", async () => {
    world([]);
    const long = "🦺 Larkspur deck stairs ".repeat(120); // over 2,000 characters, and far more UTF-16 units
    const res = await submitPublicInquiry(ORG, { name: "Dana Rook", phone: "555-0102", message: long });
    expect(res).toEqual({ ok: true, leadId: "written-1" });
  });

  it("when nothing is read back, the bell's fallback names only this door's own rows, never an office lead", async () => {
    // The row is written in words the read-back cannot match, and an office lead lands newer still.
    const db = world([], {}, { message: () => "changed by the database" });
    db.tables.inquiries.push({ id: "office-lead", org_id: ORG, name: "Theo Vance", phone: null, email: null, message: "Snowbell remodel", source: "office", created_at: new Date(Date.now() + 1000).toISOString() });
    const res = await submitPublicInquiry(ORG, { name: "Dana Rook", phone: "555-0102", message: "Panel upgrade" });
    expect(res).toEqual({ ok: true });
    await vi.waitFor(() => expect(sent.calls).toHaveLength(1));
    expect(sent.calls[0][3].body).not.toContain("Theo Vance");
    expect(sent.calls[0][3].body).not.toContain("Snowbell");
    const fallback = db.log.filter((l) => l.table === "inquiries" && l.op === "select").at(-1);
    expect(fallback?.filters).toEqual(expect.arrayContaining([`org_id=${ORG}`, "source=public_form"]));
  });
});
