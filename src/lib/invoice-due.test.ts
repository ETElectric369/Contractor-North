import { describe, it, expect } from "vitest";
import { dueDateIsoFromSettings, defaultDueDateIsoForOrg } from "@/lib/invoice-due";
import { todayStrInTz } from "@/lib/tz";

const TZ = "America/Los_Angeles";

describe("dueDateIsoFromSettings — today (org tz) + net terms at org noon", () => {
  it("net 30 lands 30 org-local days out, stamped at local noon", () => {
    const now = new Date("2026-07-20T18:00:00Z"); // 11 AM Pacific
    const iso = dueDateIsoFromSettings({ timezone: TZ, invoice_due_days: 30 }, now);
    expect(todayStrInTz(TZ, new Date(iso))).toBe("2026-08-19");
    expect(new Date(iso).toISOString()).toBe("2026-08-19T19:00:00.000Z"); // noon PDT
  });

  it("net terms come from the org setting", () => {
    const now = new Date("2026-07-20T18:00:00Z");
    const iso = dueDateIsoFromSettings({ timezone: TZ, invoice_due_days: 7 }, now);
    expect(todayStrInTz(TZ, new Date(iso))).toBe("2026-07-27");
  });

  it("unset/0 net terms fall back to Net 30", () => {
    const now = new Date("2026-07-20T18:00:00Z");
    const iso = dueDateIsoFromSettings({ timezone: TZ, invoice_due_days: 0 }, now);
    expect(todayStrInTz(TZ, new Date(iso))).toBe("2026-08-19");
  });

  it("counts from the ORG's today, not the server's UTC today", () => {
    // 8 PM Pacific on July 20 is already July 21 in UTC. Net 1 must be July 21 local,
    // not July 22 — the same clock rule the overdue tracker judges against.
    const now = new Date("2026-07-21T03:00:00Z");
    const iso = dueDateIsoFromSettings({ timezone: TZ, invoice_due_days: 1 }, now);
    expect(todayStrInTz(TZ, new Date(iso))).toBe("2026-07-21");
  });
});

describe("defaultDueDateIsoForOrg — org scoping for the service-role cron", () => {
  function fakeOrgs(rows: { id: string; settings: unknown }[]) {
    const seen: { column?: string; value?: string } = {};
    const client = {
      from() {
        const builder: any = {
          select: () => builder,
          eq: (column: string, value: string) => {
            seen.column = column;
            seen.value = value;
            return builder;
          },
          maybeSingle: async () => ({
            data: (seen.value ? rows.filter((r) => r.id === seen.value) : rows)[0] ?? null,
            error: null,
          }),
        };
        return builder;
      },
    };
    return { client, seen };
  }

  it("with an orgId, reads THAT org's settings (the cron sees every org's row)", async () => {
    const { client, seen } = fakeOrgs([
      { id: "org-a", settings: { timezone: "America/New_York", invoice_due_days: 45 } },
      { id: "org-b", settings: { timezone: TZ, invoice_due_days: 15 } },
    ]);
    const iso = await defaultDueDateIsoForOrg(client, "org-b");
    expect(seen).toEqual({ column: "id", value: "org-b" });
    // 15 days out in org-b's tz — NOT org-a's 45, which an unfiltered read would have grabbed.
    const expected = dueDateIsoFromSettings({ timezone: TZ, invoice_due_days: 15 });
    expect(iso).toBe(expected);
  });

  it("without an orgId (user client, RLS-scoped) it reads the single visible org", async () => {
    const { client, seen } = fakeOrgs([{ id: "org-a", settings: { timezone: TZ, invoice_due_days: 30 } }]);
    const iso = await defaultDueDateIsoForOrg(client);
    expect(seen.column).toBeUndefined();
    expect(iso).toBe(dueDateIsoFromSettings({ timezone: TZ, invoice_due_days: 30 }));
  });

  it("an unreadable org row still yields a due date (defaults), never null", async () => {
    const { client } = fakeOrgs([]);
    const iso = await defaultDueDateIsoForOrg(client, "org-missing");
    expect(new Date(iso).toString()).not.toBe("Invalid Date");
  });
});
