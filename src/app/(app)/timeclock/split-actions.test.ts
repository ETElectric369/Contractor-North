import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * THE APP HALF OF "A SPLIT IS A CUT" (0288), pinned without a database.
 *
 * The money laws live in the database functions and are proven there (split-into-entries.db-suite).
 * What lives HERE is what the doors do around them: which function they call and with what, the
 * sentence a refusal becomes, the link a cross-job refusal carries to the invoice, the claim a
 * same-job split carries said out loud, and the doors that must no longer touch the old table at
 * all. The fake below refuses any statement it was not told about, so "the old split table is
 * never touched" is enforced by construction: an unrouted query throws by name.
 */

const state = vi.hoisted(() => ({ client: null as any, staff: true }));
const spies = vi.hoisted(() => ({ notify: [] as any[] }));

vi.mock("@/lib/staff-guard", () => ({
  requireStaff: vi.fn(async () =>
    state.staff ? { supabase: state.client, userId: "user-1", orgId: "org-1" } : { error: "Office staff only." },
  ),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => state.client),
  createServiceClient: vi.fn(() => state.client),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));
vi.mock("@/lib/notifications", () => ({ createNotifications: vi.fn(async (...a: any[]) => void spies.notify.push(a)) }));
vi.mock("@/lib/push", () => ({ sendPushToProfiles: vi.fn(async () => {}), orgStaffIds: vi.fn(async () => ["office-1", "user-1"]) }));
vi.mock("../schedule/actions", () => ({ setJobCrew: vi.fn(async () => ({ ok: true })) }));

import {
  clockOut,
  completeAutoClockOut,
  geoClockOut,
  joinTimeEntries,
  moveTimeEntryCut,
  shiftClaim,
  splitTimeEntry,
  switchJob,
} from "./actions";
import { AUTO_CONFIRMED_CRUMB } from "./close-math";

type Q = { table: string; verb: "select" | "insert" | "update" | "delete" | "rpc"; cols: string; payload?: any; filters: any[] };
type Reply = { data?: any; error?: any } | undefined;

function fakeSupabase(route: (q: Q) => Reply, calls: Q[]) {
  const answer = (q: Q) => {
    const r = route(q);
    if (r === undefined) throw new Error(`unrouted: ${q.table}.${q.verb} [${q.cols}] ${JSON.stringify(q.payload ?? null)}`);
    return { data: r.data ?? null, error: r.error ?? null };
  };
  return {
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
    rpc(fn: string, args: any) {
      const q: Q = { table: `rpc:${fn}`, verb: "rpc", cols: "", payload: args, filters: [] };
      calls.push(q);
      return Promise.resolve(answer(q));
    },
    from(table: string) {
      const q: Q = { table, verb: "select", cols: "", filters: [] };
      calls.push(q);
      const chain: any = {
        select(cols?: string) { if (q.verb === "select") q.cols = cols ?? ""; return chain; },
        insert(p: any) { q.verb = "insert"; q.payload = p; return chain; },
        update(p: any) { q.verb = "update"; q.payload = p; return chain; },
        delete() { q.verb = "delete"; return chain; },
        single() { return Promise.resolve(answer(q)); },
        maybeSingle() { return Promise.resolve(answer(q)); },
        then(resolve: any, reject: any) {
          try { resolve(answer(q)); } catch (e) { reject?.(e); }
        },
      };
      for (const m of ["eq", "neq", "in", "is", "not", "gt", "gte", "lt", "lte", "or", "overlaps", "order", "limit", "contains"]) {
        chain[m] = (...args: any[]) => { q.filters.push([m, ...args]); return chain; };
      }
      return chain;
    },
  };
}

const ENTRY = "0c7fae89-0000-4000-8000-000000000001";
const RIGHT = "2f468f0d-0000-4000-8000-000000000002";
const RHODESIA = "a0000000-0000-4000-8000-00000000033a";
const HERRINGBONE = "a0000000-0000-4000-8000-00000000011b";
const INV48 = "e4800000-0000-4000-8000-000000000048";

let calls: Q[] = [];
beforeEach(() => {
  calls = [];
  spies.notify = [];
  state.staff = true;
});

describe("splitTimeEntry", () => {
  it("calls split_time_entry with the cut, the new part's job and the lunch side, and names a carried claim", async () => {
    state.client = fakeSupabase((q) => {
      if (q.table === "jobs") return { data: { id: RHODESIA } };
      if (q.table === "rpc:split_time_entry")
        return { data: { left_id: ENTRY, right_id: RIGHT, left_hours: 4.5, right_hours: 1, carried: [{ invoice_id: INV48, invoice_number: "INV-048", status: "paid" }] } };
      if (q.table === "time_entries") return { data: [{ job_id: RHODESIA }] };
    }, calls);
    const r = await splitTimeEntry({ entry_id: ENTRY, at: "2001-07-14T23:30:00.000Z", job_id: RHODESIA, lunch_on: "left" });
    expect(r).toMatchObject({ ok: true, left_id: ENTRY, right_id: RIGHT, left_hours: 4.5, right_hours: 1 });
    expect(r.warning).toMatch(/INV-048 already bills this shift, so the new part carries that claim/);
    const rpc = calls.find((c) => c.table === "rpc:split_time_entry")!;
    expect(rpc.payload).toEqual({
      p_entry: ENTRY,
      p_at: "2001-07-14T23:30:00.000Z",
      p_right_job: RHODESIA,
      p_right_code: null,
      p_lunch_on: "left",
      p_miles_on: null,
    });
  });

  it("the Jul 14 refusal comes back in the database's words, with a way to the invoice", async () => {
    state.client = fakeSupabase((q) => {
      if (q.table === "jobs") return { data: { id: HERRINGBONE } };
      if (q.table === "rpc:split_time_entry")
        return {
          error: {
            code: "P0001",
            message: "INV-048 (paid) already bills this whole shift to Rhodesia. Moving 1 h to Herringbone would bill it twice.",
            details: `invoice:${INV48}`,
          },
        };
    }, calls);
    const r = await splitTimeEntry({ entry_id: ENTRY, at: "2001-07-14T23:30:00.000Z", job_id: HERRINGBONE });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("INV-048 (paid) already bills this whole shift to Rhodesia. Moving 1 h to Herringbone would bill it twice.");
    expect(r.invoiceHref).toBe(`/billing/${INV48}`);
  });

  it("refuses before the database with no job and no code, or a job the caller cannot see", async () => {
    state.client = fakeSupabase((q) => (q.table === "jobs" ? { data: null } : undefined), calls);
    expect(await splitTimeEntry({ entry_id: ENTRY, at: "2001-07-14T23:30:00.000Z", job_id: null })).toMatchObject({
      ok: false,
      error: "Pick a job or a time code for the new part.",
    });
    expect(await splitTimeEntry({ entry_id: ENTRY, at: "2001-07-14T23:30:00.000Z", job_id: "someone-elses" })).toMatchObject({
      ok: false,
      error: "That job isn't available.",
    });
    expect(calls.some((c) => c.verb === "rpc")).toBe(false);
  });

  it("a time code (Drive) needs no job", async () => {
    state.client = fakeSupabase((q) => {
      if (q.table === "rpc:split_time_entry") return { data: { left_id: ENTRY, right_id: RIGHT, carried: [] } };
      if (q.table === "time_entries") return { data: [] };
    }, calls);
    const r = await splitTimeEntry({ entry_id: ENTRY, at: "2001-07-14T15:00:00.000Z", job_id: null, job_code: "DRIVE" });
    expect(r.ok).toBe(true);
    expect(r.warning).toBeUndefined();
    expect(calls.find((c) => c.verb === "rpc")!.payload).toMatchObject({ p_right_job: null, p_right_code: "DRIVE" });
  });

  it("is office only", async () => {
    state.staff = false;
    state.client = fakeSupabase(() => undefined, calls);
    expect(await splitTimeEntry({ entry_id: ENTRY, at: "2001-07-14T23:30:00.000Z", job_id: RHODESIA })).toMatchObject({ ok: false });
    expect(calls).toEqual([]);
  });
});

describe("joinTimeEntries and moveTimeEntryCut", () => {
  it("join calls join_time_entries with the two pieces in order", async () => {
    state.client = fakeSupabase((q) => {
      if (q.table === "time_entries") return { data: [{ job_id: RHODESIA }, { job_id: HERRINGBONE }] };
      if (q.table === "rpc:join_time_entries") return { data: { kept_id: ENTRY, removed_id: RIGHT, hours: 5.5, released: [] } };
    }, calls);
    expect(await joinTimeEntries({ left_id: ENTRY, right_id: RIGHT })).toEqual({ ok: true, kept_id: ENTRY, hours: 5.5 });
    expect(calls.find((c) => c.verb === "rpc")!.payload).toEqual({ p_left: ENTRY, p_right: RIGHT });
  });

  it("a join the database refuses says why", async () => {
    state.client = fakeSupabase((q) => {
      if (q.table === "time_entries") return { data: [] };
      if (q.table === "rpc:join_time_entries")
        return { error: { message: "INV-078 bills the second part and not the first, so joining them would make unbilled hours look billed." } };
    }, calls);
    const r = await joinTimeEntries({ left_id: ENTRY, right_id: RIGHT });
    expect(r).toEqual({ ok: false, error: "INV-078 bills the second part and not the first, so joining them would make unbilled hours look billed." });
  });

  it("move names every invoice whose part changed length, with both figures", async () => {
    state.client = fakeSupabase((q) => {
      if (q.table === "time_entries") return { data: [] };
      if (q.table === "rpc:move_time_entry_cut")
        return {
          data: {
            moved: true,
            left_hours: 4,
            right_hours: 1.5,
            billed: [{ invoice_id: INV48, invoice_number: "INV-048", status: "paid", entry_id: ENTRY, hours_before: 4.5, hours_after: 4 }],
          },
        };
    }, calls);
    const r = await moveTimeEntryCut({ left_id: ENTRY, right_id: RIGHT, at: "2001-07-14T23:00:00.000Z" });
    expect(r).toMatchObject({ ok: true, left_hours: 4, right_hours: 1.5 });
    expect(r.warning).toBe(
      "INV-048 bills 4.50 h of this shift and that part now reads 4.00 h. The invoice keeps its figure; adjust it by hand if the customer should pay for the difference.",
    );
    expect(calls.find((c) => c.verb === "rpc")!.payload).toEqual({ p_left: ENTRY, p_right: RIGHT, p_at: "2001-07-14T23:00:00.000Z" });
  });
});

describe("the claim the split sheet states before the tap, and a move across two claims", () => {
  it("shiftClaim names the live invoice billing the shift, or none", async () => {
    state.client = fakeSupabase((q) => {
      if (q.table === "invoice_items")
        return { data: [{ source_ids: [ENTRY], invoices: { id: INV48, invoice_number: "INV-048", status: "paid", created_at: "2001-07-20T00:00:00Z" } }] };
    }, calls);
    expect(await shiftClaim(ENTRY)).toEqual({ ok: true, holder: { id: INV48, invoice_number: "INV-048" } });
    state.client = fakeSupabase((q) => (q.table === "invoice_items" ? { data: [] } : undefined), calls);
    expect(await shiftClaim(RIGHT)).toEqual({ ok: true, holder: null });
    state.staff = false;
    expect((await shiftClaim(ENTRY)).ok).toBe(false);
  });

  it("a move the database refuses across two claims carries the way to the invoice", async () => {
    state.client = fakeSupabase((q) => {
      if (q.table === "rpc:move_time_entry_cut")
        return {
          error: {
            message: "INV-048 (paid) bills the first part and not the second, so moving the split would hand billed hours to a part that could be billed again.",
            details: `invoice:${INV48}`,
          },
        };
    }, calls);
    const r = await moveTimeEntryCut({ left_id: ENTRY, right_id: RIGHT, at: "2001-07-14T22:30:00.000Z" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/^INV-048 \(paid\) bills the first part and not the second/);
    expect(r.invoiceHref).toBe(`/billing/${INV48}`);
  });

  it("a split's warning names only invoices that bill; a void one carries the id silently", async () => {
    state.client = fakeSupabase((q) => {
      if (q.table === "jobs") return { data: { id: RHODESIA } };
      if (q.table === "rpc:split_time_entry")
        return {
          data: {
            left_id: ENTRY,
            right_id: RIGHT,
            carried: [
              { invoice_id: "v", invoice_number: "INV-040", status: "void" },
              { invoice_id: INV48, invoice_number: "INV-048", status: "sent" },
            ],
          },
        };
      if (q.table === "time_entries") return { data: [{ job_id: RHODESIA }] };
    }, calls);
    const r = await splitTimeEntry({ entry_id: ENTRY, at: "2001-07-14T23:30:00.000Z", job_id: RHODESIA });
    expect(r.warning).toBe("INV-048 already bills this shift, so the new part carries that claim and will not be billed again.");
  });
});

describe("switchJob goes through switch_job", () => {
  const openRow = { id: ENTRY, org_id: "org-1", profile_id: "user-1", job_id: RHODESIA, job_code: null, notes: "pulled wire", rate_override: null };

  it("a cut returns the NEW open entry, keeps the typed note on the closing part, and hands over the fix", async () => {
    state.client = fakeSupabase((q) => {
      if (q.table === "time_entries" && q.verb === "select") return { data: openRow };
      if (q.table === "time_entries" && q.verb === "update") return { data: null };
      if (q.table === "jobs" && q.cols === "id") return { data: { id: HERRINGBONE } };
      if (q.table === "jobs") return { data: { job_number: "J-011", name: "Herringbone", org_id: "org-1" } };
      if (q.table === "rpc:switch_job") return { data: { mode: "cut", entry_id: RIGHT, closed_id: ENTRY, closed_hours: 4.25, rate_left_behind: false } };
    }, calls);
    const r = await switchJob({ entry_id: ENTRY, job_id: HERRINGBONE, notes: "pulled wire, then the panel", gps: { lat: 39.8, lng: -120.1, accuracy: 20 } });
    expect(r).toMatchObject({ ok: true, entry_id: RIGHT, mode: "cut", closed_hours: 4.25, notes: "" });
    const rpc = calls.find((c) => c.table === "rpc:switch_job")!;
    expect(rpc.payload).toMatchObject({ p_entry: ENTRY, p_job_id: HERRINGBONE, p_job_code: null });
    expect(rpc.payload.p_gps).toMatchObject({ lat: 39.8, lng: -120.1, accuracy: 20 });
    const noteSave = calls.find((c) => c.table === "time_entries" && c.verb === "update")!;
    expect(noteSave.payload).toEqual({ notes: "pulled wire, then the panel" });
    expect(noteSave.filters).toContainEqual(["eq", "id", ENTRY]);
  });

  it("a re-point with no usable fix drops the old anchor and leaves a breadcrumb", async () => {
    state.client = fakeSupabase((q) => {
      if (q.table === "time_entries" && q.verb === "select") return { data: { ...openRow, job_id: null, notes: null } };
      if (q.table === "time_entries" && q.verb === "update") return { data: null };
      if (q.table === "jobs" && q.cols === "id") return { data: { id: HERRINGBONE } };
      if (q.table === "jobs") return { data: { job_number: "J-011", name: "Herringbone", org_id: "org-1" } };
      if (q.table === "rpc:switch_job") return { data: { mode: "repointed", entry_id: ENTRY, closed_id: null, closed_hours: 0, rate_left_behind: false } };
    }, calls);
    const r = await switchJob({ entry_id: ENTRY, job_id: HERRINGBONE, gps: null });
    expect(r).toMatchObject({ ok: true, mode: "repointed", entry_id: ENTRY });
    expect(r.notes).toMatch(/^\[switched to Herringbone at .+Z\]$/);
    const write = calls.filter((c) => c.table === "time_entries" && c.verb === "update").pop()!;
    expect(write.payload).toMatchObject({ gps_in: null });
    expect(calls.find((c) => c.table === "rpc:switch_job")!.payload.p_gps).toBeNull();
  });

  it("a pay rate that stayed behind is said to the tech and put on the office's bell", async () => {
    state.client = fakeSupabase((q) => {
      if (q.table === "time_entries" && q.verb === "select") return { data: { ...openRow, rate_override: 40 } };
      if (q.table === "time_entries" && q.verb === "update") return { data: null };
      if (q.table === "jobs" && q.cols === "id") return { data: { id: HERRINGBONE } };
      if (q.table === "jobs") return { data: { job_number: "J-011", name: "Herringbone", org_id: "org-1" } };
      if (q.table === "profiles") return { data: { full_name: "Brian Taylor" } };
      if (q.table === "rpc:switch_job") return { data: { mode: "cut", entry_id: RIGHT, closed_id: ENTRY, closed_hours: 2, rate_left_behind: true } };
    }, calls);
    const r = await switchJob({ entry_id: ENTRY, job_id: HERRINGBONE, gps: null });
    expect(r.warning).toMatch(/special pay rate stays on the part before the switch/);
    expect(spies.notify).toHaveLength(1);
    expect(spies.notify[0][1]).toEqual(["office-1"]); // never the person who switched
    expect(spies.notify[0][2].title).toBe("Brian Taylor switched jobs mid-shift");
  });

  it("a lunch that moved to the new part is said", async () => {
    state.client = fakeSupabase((q) => {
      if (q.table === "time_entries" && q.verb === "select") return { data: openRow };
      if (q.table === "time_entries" && q.verb === "update") return { data: null };
      if (q.table === "jobs" && q.cols === "id") return { data: { id: HERRINGBONE } };
      if (q.table === "jobs") return { data: { job_number: "J-011", name: "Herringbone", org_id: "org-1" } };
      if (q.table === "rpc:switch_job")
        return { data: { mode: "cut", entry_id: RIGHT, closed_id: ENTRY, closed_hours: 0.17, lunch_moved: 45, rate_left_behind: false } };
    }, calls);
    const r = await switchJob({ entry_id: ENTRY, job_id: HERRINGBONE, gps: null });
    expect(r.warning).toBe("The 45-minute lunch on this shift didn't fit the part before the switch, so it moved to this part.");
  });

  it("refuses a job the caller cannot see before anything is written", async () => {
    state.client = fakeSupabase((q) => {
      if (q.table === "time_entries") return { data: openRow };
      if (q.table === "jobs") return { data: null };
    }, calls);
    expect(await switchJob({ entry_id: ENTRY, job_id: "someone-elses" })).toEqual({ ok: false, error: "That job isn't available." });
    expect(calls.some((c) => c.verb !== "select")).toBe(false);
  });
});

describe("clock-out without the breakdown", () => {
  // These close at NOW, so the running part starts a few hours ago: a clock running ten hours or
  // more needs a stated stop time (needsStatedStop), and a one-tap close of it is refused.
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

  it("a one-tap close writes only the entry, and never reads the old table", async () => {
    state.client = fakeSupabase((q) => {
      if (q.table === "time_entries" && q.verb === "select" && q.cols.startsWith("clock_in")) return { data: { clock_in: hoursAgo(6), lunch_minutes: 0, status: "open" } };
      if (q.table === "time_entries" && q.verb === "update") return { data: [{ id: ENTRY }] };
    }, calls);
    expect(await clockOut({ entry_id: ENTRY, lunch_minutes: 30, notes: "", gps: null })).toEqual({ ok: true });
    const close = calls.find((c) => c.verb === "update")!;
    expect(close.payload).toMatchObject({ lunch_minutes: 30, status: "closed" });
  });

  it("a lunch taken before the switch lands on the part before, and this part closes with none", async () => {
    const PRIOR = "b0000000-0000-4000-8000-0000000000aa";
    const switched = hoursAgo(3);
    state.client = fakeSupabase((q) => {
      if (q.table === "time_entries" && q.verb === "select" && q.cols.startsWith("clock_in, lunch")) return { data: { clock_in: switched, lunch_minutes: 0, status: "open" } };
      if (q.table === "time_entries" && q.verb === "select" && q.cols.startsWith("id, clock_in")) return { data: { id: PRIOR, clock_in: hoursAgo(5.5), clock_out: switched, lunch_minutes: 0 } };
      if (q.table === "time_entries" && q.verb === "update") return { data: [{ id: "x" }] };
    }, calls);
    const r = await clockOut({ entry_id: ENTRY, lunch_minutes: 0, lunch_on_entry_id: PRIOR, lunch_on_minutes: 30, notes: "", gps: null });
    expect(r).toEqual({ ok: true });
    const [close, prior] = calls.filter((c) => c.verb === "update");
    expect(close.payload).toMatchObject({ lunch_minutes: 0 });
    expect(prior.payload).toEqual({ lunch_minutes: 30 });
    expect(prior.filters).toContainEqual(["eq", "id", PRIOR]);
  });

  it("a lunch that cannot go on the part before stays on this one, and says so", async () => {
    state.client = fakeSupabase((q) => {
      if (q.table === "time_entries" && q.verb === "select" && q.cols.startsWith("clock_in, lunch")) return { data: { clock_in: hoursAgo(3), lunch_minutes: 0, status: "open" } };
      if (q.table === "time_entries" && q.verb === "select") return { data: null }; // not his, or not touching
      if (q.table === "time_entries" && q.verb === "update") return { data: [{ id: ENTRY }] };
    }, calls);
    const r = await clockOut({ entry_id: ENTRY, lunch_minutes: 0, lunch_on_entry_id: "elsewhere", lunch_on_minutes: 30, notes: "", gps: null });
    expect(r.ok).toBe(true);
    expect(r.warning).toMatch(/went on this part of your shift/);
    expect(calls.filter((c) => c.verb === "update")).toHaveLength(1);
    expect(calls.find((c) => c.verb === "update")!.payload).toMatchObject({ lunch_minutes: 30 });
  });

  it("a lunch longer than the part since the switch goes on the part before, when it fits there", async () => {
    const PRIOR = "b0000000-0000-4000-8000-0000000000bb";
    const switchedAt = new Date(Date.now() - 20 * 60_000).toISOString(); // a 20-minute part
    state.client = fakeSupabase((q) => {
      if (q.table === "time_entries" && q.verb === "select" && q.cols.startsWith("clock_in, lunch")) return { data: { clock_in: switchedAt, lunch_minutes: 0, status: "open" } };
      if (q.table === "time_entries" && q.verb === "select" && q.cols.startsWith("id, clock_in"))
        return { data: { id: PRIOR, clock_in: new Date(Date.parse(switchedAt) - 4 * 3_600_000).toISOString(), clock_out: switchedAt, lunch_minutes: 0 } };
      if (q.table === "time_entries" && q.verb === "update") return { data: [{ id: "x" }] };
    }, calls);
    const r = await clockOut({ entry_id: ENTRY, lunch_minutes: 30, notes: "", gps: null });
    expect(r).toEqual({ ok: true, warning: "The 30-minute lunch is longer than this part of your shift, so it went on the part before the switch." });
    const [close, prior] = calls.filter((c) => c.verb === "update");
    expect(close.payload).toMatchObject({ lunch_minutes: 0, status: "closed" });
    expect(prior.payload).toEqual({ lunch_minutes: 30 });
    expect(prior.filters).toContainEqual(["eq", "id", PRIOR]);
    const lookup = calls.find((c) => c.verb === "select" && c.cols.startsWith("id, clock_in"))!;
    expect(lookup.filters).toContainEqual(["eq", "clock_out", switchedAt]);
  });

  it("a lunch that fits no part is refused in words, and the shift keeps running", async () => {
    const started = new Date(Date.now() - 20 * 60_000).toISOString();
    state.client = fakeSupabase((q) => {
      if (q.table === "time_entries" && q.verb === "select" && q.cols.startsWith("clock_in, lunch")) return { data: { clock_in: started, lunch_minutes: 0, status: "open" } };
      if (q.table === "time_entries" && q.verb === "select") return { data: null }; // no part before
    }, calls);
    const r = await clockOut({ entry_id: ENTRY, lunch_minutes: 30, notes: "", gps: null });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/^A 30-minute lunch is longer than the (19|20) minutes on this shift\. Untick the lunch/);
    expect(r.error).toMatch(/You're still clocked in\.$/);
    expect(calls.some((c) => c.verb === "update")).toBe(false);
  });

  it("the geofence never closes a shift the monitor was not watching", async () => {
    state.client = fakeSupabase((q) => (q.table === "time_entries" ? { data: { id: RIGHT, notes: null, lunch_minutes: 0 } } : undefined), calls);
    const r = await geoClockOut(null, "2001-07-14T22:00:00.000Z", true, ENTRY);
    expect(r).toEqual({ ok: false, error: "That shift already ended; nothing was closed." });
    expect(calls.some((c) => c.verb === "update")).toBe(false);
  });
});

describe("the auto clock-out debrief", () => {
  const closedRow = { id: ENTRY, clock_in: "2001-07-14T18:30:00.000Z", clock_out: "2001-07-15T00:30:00.000Z", job_id: RHODESIA, lunch_minutes: 0, notes: "wired the kitchen" };

  it("a lunch answer is saved with the crumb that stops the prompt asking again", async () => {
    state.client = fakeSupabase((q) => {
      if (q.table === "time_entries" && q.verb === "select") return { data: closedRow };
      if (q.table === "invoice_items") return { data: [] };
      if (q.table === "time_entries" && q.verb === "update") return { data: [{ id: ENTRY }] };
    }, calls);
    expect(await completeAutoClockOut({ entry_id: ENTRY, lunch_minutes: 30 })).toEqual({ ok: true });
    expect(calls.find((c) => c.verb === "update")!.payload).toEqual({ lunch_minutes: 30, notes: `wired the kitchen\n${AUTO_CONFIRMED_CRUMB}` });
  });

  it("a tech's debrief cannot split: the office does that, and nothing is written", async () => {
    state.staff = false;
    state.client = fakeSupabase((q) => {
      if (q.table === "time_entries" && q.verb === "select") return { data: closedRow };
      if (q.table === "invoice_items") return { data: [] };
    }, calls);
    const r = await completeAutoClockOut({ entry_id: ENTRY, lunch_minutes: 30, switched: { at: "2001-07-14T23:30:00.000Z", job_id: HERRINGBONE } });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/office splits a shift/);
    expect(calls.some((c) => c.verb === "update" || c.verb === "rpc")).toBe(false);
  });

  it("the office's own debrief splits with the lunch on the part it fits, and marks both parts answered", async () => {
    state.client = fakeSupabase((q) => {
      if (q.table === "time_entries" && q.verb === "select" && q.cols.includes("notes")) return { data: closedRow };
      if (q.table === "time_entries" && q.verb === "select") return { data: [{ job_id: RHODESIA }] };
      if (q.table === "invoice_items") return { data: [] };
      if (q.table === "jobs") return { data: { id: HERRINGBONE } };
      if (q.table === "time_entries" && q.verb === "update") return { data: [{ id: "x" }] };
      if (q.table === "rpc:split_time_entry") return { data: { left_id: ENTRY, right_id: RIGHT, left_hours: 4.5, right_hours: 1, carried: [] } };
    }, calls);
    const r = await completeAutoClockOut({ entry_id: ENTRY, lunch_minutes: 30, switched: { at: "2001-07-14T23:30:00.000Z", job_id: HERRINGBONE } });
    expect(r.ok).toBe(true);
    expect(calls.find((c) => c.verb === "rpc")!.payload).toMatchObject({ p_at: "2001-07-14T23:30:00.000Z", p_right_job: HERRINGBONE, p_lunch_on: "left" });
    const updates = calls.filter((c) => c.verb === "update");
    expect(updates[updates.length - 1].payload).toEqual({ notes: AUTO_CONFIRMED_CRUMB });
    expect(updates[updates.length - 1].filters).toContainEqual(["eq", "id", RIGHT]);
  });
});
