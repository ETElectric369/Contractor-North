import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * THE PAGE REACHES NORTH'S OWN TEAM (cn-v1136): platform_admins → their profiles, active ones only,
 * one notifyPeople (the bell line, then the push) per admin with a company under the bug_watch kind;
 * an admin with no company is skipped and counted (the bell line needs an org); a failed read throws.
 */
const db = vi.hoisted(() => ({
  admins: { data: [] as { user_id: string }[], error: null as unknown },
  profiles: { data: [] as { id: string; org_id: string | null; active: boolean | null }[], error: null as unknown },
  seen: [] as { table: string; cols: string; filter?: unknown }[],
}));
const notify = vi.hoisted(() => ({ fn: vi.fn(async () => ({ bell: true, pushed: [] as string[] })) }));

vi.mock("@/lib/supabase/server", () => ({
  createServiceClient: () => ({
    from: (table: string) => ({
      select: (cols: string) => {
        const row = { table, cols } as { table: string; cols: string; filter?: unknown };
        db.seen.push(row);
        const answer = table === "platform_admins" ? db.admins : db.profiles;
        const q = {
          in: (_col: string, ids: string[]) => {
            row.filter = ids;
            return q;
          },
          then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(answer).then(ok, bad),
        };
        return q;
      },
    }),
  }),
}));
vi.mock("@/lib/notifications", () => ({ notifyPeople: notify.fn }));

import { alertPlatformAdmins, platformAdminProfiles } from "./platform-alert";

const ORG = "6f1c2a3e-9b4d-4c5e-8f6a-1b2c3d4e5f60";

beforeEach(() => {
  db.admins = { data: [{ user_id: "erik" }, { user_id: "gone" }, { user_id: "orgless" }], error: null };
  db.profiles = {
    data: [
      { id: "erik", org_id: ORG, active: true },
      { id: "gone", org_id: ORG, active: false },
      { id: "orgless", org_id: null, active: null },
    ],
    error: null,
  };
  db.seen = [];
  notify.fn.mockClear();
});

describe("platformAdminProfiles", () => {
  it("reads platform_admins, then those profiles, and drops the inactive", async () => {
    expect(await platformAdminProfiles()).toEqual([
      { id: "erik", org_id: ORG },
      { id: "orgless", org_id: null },
    ]);
    expect(db.seen).toEqual([
      { table: "platform_admins", cols: "user_id" },
      { table: "profiles", cols: "id, org_id, active", filter: ["erik", "gone", "orgless"] },
    ]);
  });

  it("no admins listed: nobody, and no profiles read", async () => {
    db.admins = { data: [], error: null };
    expect(await platformAdminProfiles()).toEqual([]);
    expect(db.seen).toHaveLength(1);
  });

  it("a failed read THROWS — the caller files it", async () => {
    db.admins = { data: null as never, error: { message: "permission denied for table platform_admins" } };
    await expect(platformAdminProfiles()).rejects.toEqual({ message: "permission denied for table platform_admins" });
    db.admins = { data: [{ user_id: "erik" }], error: null };
    db.profiles = { data: null as never, error: { message: "profiles unreachable" } };
    await expect(platformAdminProfiles()).rejects.toEqual({ message: "profiles unreachable" });
  });
});

describe("alertPlatformAdmins", () => {
  it("one notifyPeople per active admin with a company, under bug_watch, to /bugs; the orgless one is counted as skipped", async () => {
    const r = await alertPlatformAdmins({ where: "stripe:webhook:refused", message: "signature matched no secret", reopened: false });
    expect(r).toEqual({ sent: 1, skipped: 1 });
    expect(notify.fn).toHaveBeenCalledTimes(1);
    expect(notify.fn).toHaveBeenCalledWith(ORG, ["erik"], "bug_watch", {
      title: "Blocker: stripe:webhook:refused",
      body: "signature matched no secret",
      url: "/bugs",
    });
  });

  it("a blocker that is back says so, and the body is the message's first 120 characters", async () => {
    const long = "x".repeat(300);
    await alertPlatformAdmins({ where: "email:send", message: long, reopened: true });
    const [, , , n] = notify.fn.mock.calls[0] as unknown as [string, string[], string, { title: string; body: string }];
    expect(n.title).toBe("Blocker Is Back: email:send");
    expect(n.body).toHaveLength(120);
  });

  it("an escalation — a known error that is a blocker for the first time (skeptic #42, S2) — is titled as a first blocker, even when the row also reopened", async () => {
    await alertPlatformAdmins({ where: "cron-gcal-sync", message: "m", reopened: false, escalated: true });
    await alertPlatformAdmins({ where: "cron-gcal-sync", message: "m", reopened: true, escalated: true });
    const titles = notify.fn.mock.calls.map((c) => (c as unknown as [string, string[], string, { title: string }])[3].title);
    expect(titles).toEqual(["Blocker: cron-gcal-sync", "Blocker: cron-gcal-sync"]);
  });

  it("answers sent 0 when no admin has a company, so the caller can say nobody was paged (S7)", async () => {
    db.profiles = { data: [{ id: "erik", org_id: null, active: true }], error: null };
    expect(await alertPlatformAdmins({ where: "x", message: "m", reopened: false })).toEqual({ sent: 0, skipped: 1 });
    expect(notify.fn).not.toHaveBeenCalled();
  });

  it("the inactive admin is never addressed", async () => {
    await alertPlatformAdmins({ where: "x", message: "m", reopened: false });
    const ids = notify.fn.mock.calls.flatMap((c) => (c as unknown as [string, string[]])[1]);
    expect(ids).not.toContain("gone");
  });

  it("a failed admins read throws through", async () => {
    db.admins = { data: null as never, error: { message: "down" } };
    await expect(alertPlatformAdmins({ where: "x", message: "m", reopened: false })).rejects.toEqual({ message: "down" });
    expect(notify.fn).not.toHaveBeenCalled();
  });
});
