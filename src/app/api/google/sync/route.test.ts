import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * THE CALENDAR SYNC AND THE PLAN THAT HAS ENDED (cn-v1137, decision 3). The runner loops over
 * calendar_connections; a connection whose company's plan has ended is passed over and counted in
 * `lapsed_skipped`, the standing ones sync as before, and a failed companies read is the same filed
 * 500 as a failed connections read (never a run that syncs on a guess).
 */
const spies = vi.hoisted(() => ({
  sync: vi.fn(async (_db: unknown, conn: { org_id: string }) => ({ org_id: conn.org_id, pulled: 1 })),
  reportError: vi.fn(),
  reportBlockerAwaited: vi.fn(async () => {}),
  standing: { rows: [{ id: "org-a" }, { id: "org-b" }], lapsedSkipped: 0 } as { rows: { id: string }[]; lapsedSkipped: number },
  readFails: false,
  conns: [] as { org_id: string }[],
  connsError: null as { message: string } | null,
}));
vi.mock("@/lib/cron-guard", () => ({ requireCron: vi.fn(() => ({ supabase: db })) }));
vi.mock("@/lib/calendar-sync", () => ({ syncOrgCalendars: spies.sync }));
vi.mock("@/lib/observe", () => ({ reportError: spies.reportError }));
vi.mock("@/lib/observe-blocker", () => ({ reportBlocker: vi.fn(), reportBlockerAwaited: spies.reportBlockerAwaited }));
vi.mock("@/lib/cron-orgs", () => ({
  readActiveOrgs: vi.fn(async () => {
    if (spies.readFails) throw new Error("organizations could not be read: boom");
    return spies.standing;
  }),
}));

/** The connections read, and nothing else: `calendar_connections.select("*").eq("provider", "google")`. */
const db = {
  from: (table: string) => {
    const q: any = {
      select: () => q,
      eq: () => q,
      then: (ok: (v: unknown) => void, bad?: (e: unknown) => void) =>
        table === "calendar_connections"
          ? Promise.resolve({ data: spies.connsError ? null : spies.conns, error: spies.connsError }).then(ok, bad)
          : Promise.reject(new Error(`unrouted: ${table}`)).then(ok, bad),
    };
    return q;
  },
};

import { GET } from "./route";

const req = () => new Request("https://app.test/api/google/sync", { headers: { authorization: "Bearer x" } });

beforeEach(() => {
  spies.sync.mockClear();
  spies.reportError.mockClear();
  spies.reportBlockerAwaited.mockClear();
  spies.standing = { rows: [{ id: "org-a" }, { id: "org-b" }], lapsedSkipped: 0 };
  spies.readFails = false;
  spies.conns = [{ org_id: "org-a" }, { org_id: "org-b" }];
  spies.connsError = null;
});

describe("GET /api/google/sync and a lapsed company", () => {
  it("every standing company's connection is synced, and the run says none was passed over", async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, orgs: [{ org_id: "org-a", pulled: 1 }, { org_id: "org-b", pulled: 1 }], lapsed_skipped: 0 });
  });

  it("a connection whose company's plan has ended is passed over and counted; the standing one still syncs", async () => {
    spies.standing = { rows: [{ id: "org-a" }], lapsedSkipped: 1 };
    const res = await GET(req());
    expect(await res.json()).toEqual({ ok: true, orgs: [{ org_id: "org-a", pulled: 1 }], lapsed_skipped: 1 });
    expect(spies.sync).toHaveBeenCalledTimes(1);
    expect(spies.sync.mock.calls[0][1]).toEqual({ org_id: "org-a" });
  });

  it("one company's sync failing is filed with its id and never blocks the next", async () => {
    spies.sync.mockRejectedValueOnce(new Error("grant expired"));
    const body = await (await GET(req())).json();
    expect(body.orgs).toEqual([{ org_id: "org-a", error: "grant expired" }, { org_id: "org-b", pulled: 1 }]);
    expect(spies.reportError).toHaveBeenCalledWith("cron-gcal-sync-org", expect.any(Error), { orgId: "org-a" });
  });

  it("a failed companies read is the same filed 500 as a failed connections read: nothing synced on a guess", async () => {
    spies.readFails = true;
    const res = await GET(req());
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, error: "organizations could not be read: boom" });
    expect(spies.sync).not.toHaveBeenCalled();
    expect(spies.reportBlockerAwaited).toHaveBeenCalledWith("cron-gcal-sync", expect.objectContaining({ message: "organizations could not be read: boom" }));
    spies.readFails = false;
    spies.connsError = { message: "boom" };
    expect((await GET(req())).status).toBe(500);
  });
});
