import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * THE LEAD'S FILE PAGE (cn-v1170): a lead that does not resolve is a 404, `?schedule=1` opens the
 * Schedule sheet (openSchedule), a failed visits read leaves the lead offered (open, not standing),
 * and a failed lead read is said, never a 404. The reads go to a stand-in client; LeadFile is a stub
 * that hands back its props.
 */
const db: { rows: Record<string, { data: unknown; error: unknown }> } = { rows: {} };

function builder(table: string) {
  const answer = () => db.rows[table] ?? { data: null, error: null };
  const b: Record<string, unknown> = new Proxy(
    {},
    {
      get(_t, k) {
        if (k === "then") return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(answer()).then(res, rej);
        if (k === "maybeSingle") return () => Promise.resolve(answer());
        return () => b;
      },
    },
  );
  return b;
}

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ from: (t: string) => builder(t) }) }));
vi.mock("@/lib/current-lang", () => ({ currentLang: async () => "en" }));
const sw: { features: Record<string, boolean> | null } = { features: null };
vi.mock("@/lib/viewer-switches", () => ({ viewerSwitches: async () => ({ features: sw.features, isOwner: true }) }));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("./lead-file", () => ({ LeadFile: () => null }));

import LeadFilePage from "./page";

const ID = "11111111-2222-4333-8444-555555555555";
const LEAD = { id: ID, name: "Theo Vance", status: "new", converted_at: null, customer_id: null, created_at: "2026-11-18T17:00:00Z" };

const open = (id: string, search: Record<string, string> = {}) =>
  LeadFilePage({ params: Promise.resolve({ id }), searchParams: Promise.resolve(search) }) as Promise<{ props: Record<string, unknown> }>;

beforeEach(() => {
  db.rows = {
    inquiries: { data: LEAD, error: null },
    appointments: { data: [], error: null },
    quotes: { data: [], error: null },
    jobs: { data: [], error: null },
    organizations: { data: { settings: {}, phone: null }, error: null },
  };
});

describe("the lead's file page", () => {
  it("a lead that does not resolve is notFound(), and so is an id that is not one", async () => {
    db.rows.inquiries = { data: null, error: null };
    await expect(open(ID)).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(open("not-a-lead")).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("a failed lead read is said, not a 404", async () => {
    db.rows.inquiries = { data: null, error: { message: "boom" } };
    const el = await open(ID);
    expect(el.props.children).toBeTruthy();
    expect(el.props.role).toBe("status");
  });

  it("?schedule=1 passes openSchedule; nothing else does", async () => {
    expect((await open(ID, { schedule: "1" })).props.openSchedule).toBe(true);
    expect((await open(ID)).props.openSchedule).toBe(false);
    expect((await open(ID, { schedule: "yes" })).props.openSchedule).toBe(false);
  });

  it("the stage reads the visits: a standing one, none, or a failed read (offered, never hidden)", async () => {
    db.rows.appointments = { data: [{ id: "v1", type: "inspection", status: "scheduled", outcome: null, starts_at: null, title: null }], error: null };
    expect((await open(ID)).props.stage).toBe("standing");
    db.rows.appointments = { data: null, error: { message: "boom" } };
    const el = await open(ID);
    expect(el.props.stage).toBe("open");
    expect(el.props.visits).toBeNull();
  });

  it("the switches: Estimates and Track Referrals reach the file", async () => {
    sw.features = null; // no switches stored: all on
    expect((await open(ID)).props).toMatchObject({ estimatesOn: true, referralsOn: true });
    sw.features = { leads: true, referrals: false, estimates: false };
    expect((await open(ID)).props).toMatchObject({ estimatesOn: false, referralsOn: false });
    sw.features = null;
  });
});
