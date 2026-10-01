import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * CLEAR THE DATE (the visit page's Unschedule) WAS A DEAD DOOR (found on production, 2026-09-27):
 * it writes starts_at = null and 0042 held the column NOT NULL, so every press came back with
 * Postgres' words. 0368 lets a visit wait for a day (src/lib/dateless-visit.integration.test.ts proves
 * it on the database); until it lands, the refusal is said plainly and the visit keeps its date.
 */
const db = vi.hoisted(() => ({ writes: [] as { table: string; patch: any }[], refuse: null as null | { code: string; message: string } }));

vi.mock("@/lib/staff-guard", () => ({ requireStaff: vi.fn(async () => ({ supabase: client(), userId: "office-1", orgId: "org-1" })) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/calendar-sync", () => ({ pushCalendarItem: vi.fn(async () => {}), deleteCalendarItem: vi.fn(async () => {}) }));
vi.mock("@/lib/push", () => ({ sendPushToProfiles: vi.fn(async () => {}) }));
vi.mock("@/lib/notifications", () => ({ notifyPeople: vi.fn(async () => ({ bell: true, pushed: [] })) }));

import { unscheduleAppointment } from "./actions";

function client() {
  return {
    from(table: string) {
      let patch: any = null;
      const b: any = {
        update(p: any) {
          patch = p;
          return b;
        },
        select: () => b,
        eq: () => b,
        in: () => b,
        then(ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) {
          const run = () => {
            if (table === "appointments" && patch && "starts_at" in patch && db.refuse) return { data: null, error: db.refuse };
            if (patch) db.writes.push({ table, patch });
            return { data: [{ id: "a1" }], error: null };
          };
          return Promise.resolve(run()).then(ok, bad);
        },
      };
      return b;
    },
  };
}

beforeEach(() => {
  db.writes = [];
  db.refuse = null;
});

describe("Clear The Date", () => {
  it("with 0368: the date and the end clear, a pending pick-a-time link is withdrawn", async () => {
    expect(await unscheduleAppointment("a1")).toEqual({ ok: true });
    expect(db.writes[0]).toMatchObject({ table: "appointments", patch: { starts_at: null, ends_at: null } });
    expect(db.writes.some((w) => w.table === "schedule_proposals" && w.patch.status === "cancelled")).toBe(true);
  });

  it("before 0368 (23502, the NOT NULL from 0042): plain words, never Postgres', and nothing else is written", async () => {
    db.refuse = { code: "23502", message: 'null value in column "starts_at" of relation "appointments" violates not-null constraint' };
    const res = await unscheduleAppointment("a1");
    expect(res.ok).toBe(false);
    expect(res.error).toBe("A visit can't wait without a day until a quick database update is done. Its date is unchanged.");
    expect(res.error).not.toMatch(/null value|constraint|starts_at/);
    expect(db.writes).toEqual([]);
  });

  it("the readers with no date range sort a waiting visit last and say Waiting For A Day, never a blank or 1970", () => {
    const read = (f: string) => readFileSync(join(process.cwd(), f), "utf8");
    const search = read("src/app/api/search/route.ts");
    expect(search).toContain('.order("starts_at", { ascending: false, nullsFirst: false })');
    expect(search).toContain('a.starts_at ? formatDate(a.starts_at) : "Waiting For A Day"');
    expect(search).toContain(": `/appointments/${a.id}`");
    const walks = read("src/app/(app)/inspections/page.tsx");
    expect(walks).toContain('.order("starts_at", { ascending: false, nullsFirst: false })');
    expect(walks).toContain("<span>Waiting For A Day</span>");
    expect(read("src/app/(app)/appointments/[id]/page.tsx")).toContain("<span>Waiting For A Day</span>");
    expect(read("src/app/(app)/jobs/[id]/page.tsx")).toContain('a.starts_at ? formatDateTime(a.starts_at) : "Waiting For A Day"');
    // A waiting visit made into a job makes a job waiting for a day, not a "scheduled" one with none.
    expect(read("src/app/(app)/appointments/actions.ts")).toContain('status: appt.starts_at ? "scheduled" : "to_be_scheduled"');
  });

  it("the button says what it does, in Title Case, at 44px (no small size)", () => {
    const s = readFileSync(join(process.cwd(), "src/app/(app)/appointments/unschedule-button.tsx"), "utf8");
    expect(s).toContain('"Clear The Date"');
    expect(s).not.toContain('size="sm"');
    expect(s).toContain("Waiting For A Day");
    // On the visit page it is a ⋯ Actions row (W2-11): the same words and toast, the menu's 44px row.
    expect(s).toContain("className={ACTIONS_ROW_CLS}");
    const page = readFileSync(join(process.cwd(), "src/app/(app)/appointments/[id]/page.tsx"), "utf8");
    expect(page).toContain("{booked && a.starts_at && <UnscheduleButton id={a.id} menuItem />}");
  });
});
