import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeDb } from "./bank-transfer-fake.test-util";

/**
 * THE STALE-TRANSFER ALERT AND THE PLAN THAT HAS ENDED (cn-v1137, decision 3). A company whose plan
 * has ended is not told about its pending debit: its row waits, unstamped, and is said the first
 * morning after a plan is picked. The standing companies come through readActiveOrgs (mocked here:
 * the rule itself is pinned in lib/subscription and lib/cron-orgs), and the count says how many
 * transfers were passed over.
 */
const spies = vi.hoisted(() => ({
  notify: vi.fn(async (..._a: unknown[]) => undefined),
  reportError: vi.fn(),
  standing: { rows: [{ id: "org-a" }, { id: "org-b" }], lapsedSkipped: 0 } as { rows: { id: string }[]; lapsedSkipped: number },
  readFails: false,
}));
vi.mock("@/lib/push", () => ({ orgStaffIds: vi.fn(async () => ["owner-1"]) }));
vi.mock("@/lib/notifications", () => ({ notifyPeople: spies.notify }));
vi.mock("@/lib/observe", () => ({ reportError: spies.reportError }));
vi.mock("@/lib/cron-orgs", () => ({
  readActiveOrgs: vi.fn(async () => {
    if (spies.readFails) throw new Error("organizations could not be read: boom");
    return spies.standing;
  }),
}));

import { tellStaleBankTransfers } from "./bank-transfer-alerts";
import { readActiveOrgs } from "@/lib/cron-orgs";

const NOW = new Date("2026-10-28T15:00:00Z");
const stale = (id: string, org_id: string) => ({ id, org_id, invoice_id: `inv-${id}`, amount: 250, started_at: "2026-10-01T00:00:00Z", status: "pending", stale_alerted_at: null, payment_intent: `pi-${id}` });

beforeEach(() => {
  spies.notify.mockClear();
  spies.reportError.mockClear();
  spies.standing = { rows: [{ id: "org-a" }, { id: "org-b" }], lapsedSkipped: 0 };
  spies.readFails = false;
});

describe("tellStaleBankTransfers and a lapsed company", () => {
  it("every standing company's office is told, each row stamped, and the count says nobody was passed over", async () => {
    const db = fakeDb({ pending_bank_transfers: [stale("t1", "org-a"), stale("t2", "org-b")], invoices: [{ id: "inv-t1", org_id: "org-a", invoice_number: "INV-201" }, { id: "inv-t2", org_id: "org-b", invoice_number: "INV-202" }] });
    expect(await tellStaleBankTransfers(db, NOW)).toEqual({ told: 2, lapsed_skipped: 0 });
    expect(spies.notify).toHaveBeenCalledTimes(2);
    expect(db.tables.pending_bank_transfers.every((r) => r.stale_alerted_at === NOW.toISOString())).toBe(true);
    expect(readActiveOrgs).toHaveBeenCalledWith(db, "id", NOW.getTime());
  });

  it("a lapsed company's transfer is passed over — not told, not stamped — and counted; the standing one is told", async () => {
    spies.standing = { rows: [{ id: "org-a" }], lapsedSkipped: 1 };
    const db = fakeDb({ pending_bank_transfers: [stale("t1", "org-a"), stale("t2", "org-b")], invoices: [{ id: "inv-t1", org_id: "org-a", invoice_number: "INV-201" }] });
    expect(await tellStaleBankTransfers(db, NOW)).toEqual({ told: 1, lapsed_skipped: 1 });
    expect(spies.notify).toHaveBeenCalledTimes(1);
    expect(spies.notify.mock.calls[0][0]).toBe("org-a");
    expect(db.tables.pending_bank_transfers.find((r) => r.id === "t2")?.stale_alerted_at).toBeNull(); // waits for a plan
    expect(db.tables.pending_bank_transfers.find((r) => r.id === "t1")?.stale_alerted_at).toBe(NOW.toISOString());
  });

  it("nothing stale: the companies are not even read", async () => {
    const db = fakeDb({ pending_bank_transfers: [] });
    expect(await tellStaleBankTransfers(db, NOW)).toEqual({ told: 0, lapsed_skipped: 0 });
    expect(readActiveOrgs).not.toHaveBeenCalledWith(db, "id", NOW.getTime());
  });

  it("a failed companies read THROWS to the daily cron (filed as cron-stale-bank-transfers): nobody is told on a guess", async () => {
    spies.readFails = true;
    const db = fakeDb({ pending_bank_transfers: [stale("t1", "org-a")] });
    await expect(tellStaleBankTransfers(db, NOW)).rejects.toThrow("organizations could not be read: boom");
    expect(spies.notify).not.toHaveBeenCalled();
  });
});
