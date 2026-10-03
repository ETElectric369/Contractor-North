import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * ERIK'S FIRST TIMECLOCK RULE, FOUND BY USING IT (2026-10-02): he split a shift, deleted one half, and
 * the half that was left could not be rejoined. A DESTRUCTIVE EDIT TOOK AWAY THE WAY BACK.
 *
 * A split family is "the FIRST entry, and every piece whose split_from points at it" (0288). That column
 * is `on delete set null`, so deleting the first entry nulls every survivor's pointer at once: the pieces
 * still touch to the second, but splitFamilies finds no family, splitNeighbors finds no neighbours,
 * Timecards draws neither Move The Split nor Join Back Into One Shift, and join_time_entries refuses them
 * outright (0320). Nothing said so, and a delete has no Undo.
 *
 * Two fixes, pinned here: deleteTimeEntry re-roots the survivors on the earliest of them, and the door
 * says in plain words what the delete takes and names Join Back as the way to keep it — including which
 * job the joined shift would keep, because Join Back keeps the FIRST part's (0320) and the half Erik was
 * deleting was usually the first.
 */

const state = vi.hoisted(() => ({ client: null as any }));

vi.mock("@/lib/staff-guard", () => ({
  requireStaff: vi.fn(async () => ({ supabase: state.client, userId: "user-1", orgId: "org-1" })),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => state.client),
  createServiceClient: vi.fn(() => state.client),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));
vi.mock("@/lib/notifications", () => ({
  createNotifications: vi.fn(async () => {}),
  notifyPeople: vi.fn(async () => ({ bell: true, pushed: [] })),
}));
vi.mock("@/lib/push", () => ({ sendPushToProfiles: vi.fn(async () => {}), orgStaffIds: vi.fn(async () => ["office-1"]) }));
vi.mock("../schedule/actions", () => ({ setJobCrew: vi.fn(async () => ({ ok: true })) }));
// The editor is rendered below (the dead-door lesson: run the component, count the doors).
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

import { deleteTimeEntry } from "../timeclock/actions";
import { PLAIN_DELETE_CONFIRM, deleteConfirmWords } from "./delete-words";
import { EditEntryButton } from "./edit-entry-button";

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

/** The shift Erik cut twice: 7:00 on the job the app picked, then Honeysuckle, then Fernhill. */
const A = "0c7fae89-0000-4000-8000-00000000000a";
const B = "0c7fae89-0000-4000-8000-00000000000b";
const C = "0c7fae89-0000-4000-8000-00000000000c";
const BRIAN = "b0000000-0000-4000-8000-0000000000b1";
const JOB = "a0000000-0000-4000-8000-00000000011b";

const firstPiece = { paid_at: null, mileage_paid_at: null, job_id: JOB, profile_id: BRIAN, split_from: null };

/** `kin` is what the read of this shift's pieces answers with; `undefined` leaves it unrouted. */
const routes = (opts: { row?: any; kin?: Reply; deleted?: Reply; reroot?: Reply }) => (q: Q): Reply => {
  if (q.table === "invoice_items") return { data: [] };
  if (q.table === "time_entries" && q.verb === "delete") return opts.deleted ?? { data: [{ id: A }] };
  if (q.table === "time_entries" && q.verb === "update") return opts.reroot ?? { data: [{ id: C }] };
  if (q.table === "time_entries" && q.cols.includes("paid_at")) return { data: opts.row ?? firstPiece };
  if (q.table === "time_entries" && q.verb === "select") return opts.kin;
  return undefined;
};
const updateOf = (calls: Q[]) => calls.find((c) => c.table === "time_entries" && c.verb === "update");

let calls: Q[] = [];
beforeEach(() => {
  calls = [];
});

describe("deleteTimeEntry on one part of a split shift", () => {
  it("THE DEFECT: deleting the first of three parts re-roots the rest instead of orphaning them", async () => {
    state.client = fakeSupabase(
      routes({ kin: { data: [{ id: B, clock_in: "2026-09-22T16:00:00Z" }, { id: C, clock_in: "2026-09-22T19:00:00Z" }] } }),
      calls,
    );
    expect(await deleteTimeEntry(A)).toEqual({ ok: true });

    // The pieces are read BEFORE the delete: afterwards their pointers are already null and nothing
    // left says whose shift they were.
    const order = calls.map((c) => `${c.table}.${c.verb}`);
    expect(order.indexOf("time_entries.select")).toBeLessThan(order.indexOf("time_entries.delete"));
    expect(order.indexOf("time_entries.delete")).toBeLessThan(order.indexOf("time_entries.update"));

    // The EARLIEST survivor becomes the family's first entry (the FK already made it one), and every
    // other piece points at it. Only the pieces this delete orphaned, and only this person's.
    const reroot = updateOf(calls)!;
    expect(reroot.payload).toEqual({ split_from: B });
    expect(reroot.filters).toContainEqual(["in", "id", [C]]);
    expect(reroot.filters).toContainEqual(["eq", "profile_id", BRIAN]);
    expect(reroot.filters).toContainEqual(["is", "split_from", null]);
    // The new root is never written: its split_how is left alone, which is what 0319's carve-out for
    // the FK's own null depends on.
    expect(reroot.payload).not.toHaveProperty("split_how");
  });

  it("the EARLIEST survivor is the new first entry, whatever order the read answered in", async () => {
    state.client = fakeSupabase(
      // Answered newest-first: picking the wrong root would point the morning at the afternoon.
      routes({ kin: { data: [{ id: C, clock_in: "2026-09-22T19:00:00Z" }, { id: B, clock_in: "2026-09-22T16:00:00Z" }] } }),
      calls,
    );
    expect(await deleteTimeEntry(A)).toEqual({ ok: true });
    const reroot = updateOf(calls)!;
    expect(reroot.payload).toEqual({ split_from: B });
    expect(reroot.filters).toContainEqual(["in", "id", [C]]);
  });

  it("two parts need no re-root: one survivor is not a split shift, and null is the truth", async () => {
    state.client = fakeSupabase(routes({ kin: { data: [{ id: B, clock_in: "2026-09-22T16:00:00Z" }] } }), calls);
    expect(await deleteTimeEntry(A)).toEqual({ ok: true });
    expect(updateOf(calls)).toBeUndefined();
  });

  it("deleting a LATER part leaves the family alone: it is not the row the others point at", async () => {
    // split_from set ⇒ this piece is not the root, so no pieces point at it and nothing is re-pointed.
    state.client = fakeSupabase(routes({ row: { ...firstPiece, split_from: A } }), calls);
    expect(await deleteTimeEntry(C)).toEqual({ ok: true });
    expect(updateOf(calls)).toBeUndefined();
    expect(calls.filter((c) => c.table === "time_entries" && c.verb === "select")).toHaveLength(1);
  });

  it("an ordinary entry is deleted with no extra write", async () => {
    state.client = fakeSupabase(routes({ kin: { data: [] } }), calls);
    expect(await deleteTimeEntry(A)).toEqual({ ok: true });
    expect(updateOf(calls)).toBeUndefined();
  });

  it("a re-root that did not land is said out loud — the entry is gone either way", async () => {
    state.client = fakeSupabase(
      routes({
        kin: { data: [{ id: B, clock_in: "2026-09-22T16:00:00Z" }, { id: C, clock_in: "2026-09-22T19:00:00Z" }] },
        reroot: { data: [] }, // zero rows: a tech's own delete, which the database refuses to re-link (0319)
      }),
      calls,
    );
    const r = await deleteTimeEntry(A);
    expect(r.ok).toBe(true);
    expect(r.warning).toContain("no longer held together as one split shift");
    expect(r.warning).toContain("Join Back");
  });

  it("a read it cannot make deletes nothing: a failed read is never an answer", async () => {
    state.client = fakeSupabase(routes({ kin: { error: { message: "boom" } } }), calls);
    expect(await deleteTimeEntry(A)).toEqual({
      ok: false,
      error: "Couldn't check whether this shift was split into parts — nothing was changed. Try again in a moment.",
    });
    expect(calls.some((c) => c.verb === "delete")).toBe(false);
  });

  /**
   * THE DEFECT the rule above was written for, on the read that gates it (review, 2026-10-03). The
   * FIRST select — the payroll locks, the job, the person and split_from — threw its error away, so a
   * statement timeout or a 5xx on it left `lock` null. Null reads as "not paid, not settled, not a
   * split shift": both payroll guards passed, the pieces read never ran, and a root with pieces was
   * deleted and orphaned anyway. The outage caused Erik's own defect, and nothing said a word.
   */
  it("THE DEFECT: a failed FIRST read deletes nothing — not the payroll guards, not the family, skipped", async () => {
    state.client = fakeSupabase(
      (q) => (q.table === "time_entries" && q.cols.includes("paid_at") ? { error: { message: "statement timeout" } } : routes({})(q)),
      calls,
    );
    expect(await deleteTimeEntry(A)).toEqual({
      ok: false,
      error: "Couldn't check this entry — nothing was changed. Try again in a moment.",
    });
    expect(calls.some((c) => c.verb === "delete")).toBe(false);
    expect(calls.some((c) => c.verb === "update")).toBe(false);
  });

  it("and a PAID entry is still refused when that read is the one that fails — the lock is never assumed open", async () => {
    // The same outage on a paid row used to delete it with its payroll lock unchecked.
    state.client = fakeSupabase(
      (q) => (q.table === "time_entries" && q.cols.includes("paid_at") ? { error: { message: "502" } } : routes({})(q)),
      calls,
    );
    expect((await deleteTimeEntry(A)).ok).toBe(false);
    expect(calls.some((c) => c.verb === "delete")).toBe(false);
  });

  it("an id this caller cannot see is said out loud, not attempted", async () => {
    state.client = fakeSupabase((q) => (q.table === "time_entries" && q.cols.includes("paid_at") ? { data: null } : routes({})(q)), calls);
    expect(await deleteTimeEntry(A)).toEqual({ ok: false, error: "That entry is no longer there — reload and try again." });
    expect(calls.some((c) => c.verb === "delete")).toBe(false);
  });
});

describe("what the delete door says", () => {
  it("an ordinary entry keeps the plain question", () => {
    expect(deleteConfirmWords(null)).toBe(PLAIN_DELETE_CONFIRM);
    expect(deleteConfirmWords(null)).not.toContain("Join Back");
  });

  it("a part of a split names the hours, the job, and the way to keep them", () => {
    const said = deleteConfirmWords({ hours: 2.3233, label: "J-013 · 56 Timber Trail", keepsJob: "J-013 · 56 Timber Trail" });
    expect(said).toContain("Delete this part of the split shift?");
    expect(said).toContain("The 2.32 h on J-013 · 56 Timber Trail go with it");
    expect(said).toContain("this can't be undone");
    expect(said).toContain("Join Back Into One Shift");
  });

  it("and it names the job the joined shift would keep — the FIRST part's, which may be this one", () => {
    // Deleting the EARLIER half: joining instead puts the whole shift on the job being deleted from.
    const firstHalf = deleteConfirmWords({ hours: 0.1, label: "J-013 ARR 56", keepsJob: "J-013 ARR 56" });
    expect(firstHalf).toContain("all of it on J-013 ARR 56");
    // Deleting the LATER half: the earlier part's job is the one that survives.
    const lastHalf = deleteConfirmWords({ hours: 7.5, label: "J-011 Honeysuckle", keepsJob: "J-013 ARR 56" });
    expect(lastHalf).toContain("The 7.5 h on J-011 Honeysuckle go with it");
    expect(lastHalf).toContain("all of it on J-013 ARR 56");
  });

  it("a part whose clock is still running claims no hours it has not counted", () => {
    const said = deleteConfirmWords({ hours: null, label: "J-011 Honeysuckle", keepsJob: "J-013 ARR 56" });
    expect(said).toContain("Its time on J-011 Honeysuckle goes with it");
    expect(said).not.toMatch(/\d h\b/);
  });

  /**
   * THE DEFECT: the words named a door the screen was not showing (review, 2026-10-03). A RUNNING piece
   * — which is every second piece a Switch Job leaves behind — opens the clock-out sheet, and that sheet
   * has Delete and no Join Back at all; join_time_entries refuses a running shift outright ("Clock out
   * first", 0322). So "cancel and tap Join Back Into One Shift" sent the office to cancel and hunt for
   * a button that was not there, on a delete with no Undo. The way back is real and it is on that very
   * sheet: clock out, then join.
   */
  it("THE DEFECT: on a RUNNING piece it names clocking out first, never a button that is not on the sheet", () => {
    const said = deleteConfirmWords({ hours: null, label: "J-011 Honeysuckle", keepsJob: "J-013 ARR 56", running: true });
    expect(said).toContain("Delete this part of the split shift?");
    expect(said).toContain("Its time on J-011 Honeysuckle goes with it");
    expect(said).not.toContain("cancel and tap Join Back Into One Shift");
    expect(said).toContain("cancel and clock this shift out first");
    // The way back still names the job the joined day would keep, which is the fact that bites.
    expect(said).toContain("all of it on J-013 ARR 56");
  });

  it("a CLOSED piece still names the button, because that is the one its sheet draws", () => {
    const said = deleteConfirmWords({ hours: 2.5, label: "J-011 Honeysuckle", keepsJob: "J-013 ARR 56", running: false });
    expect(said).toContain("cancel and tap Join Back Into One Shift");
    expect(said).not.toContain("clock this shift out first");
  });

  it("and the editor asks through that one function, never its own copy of the sentence", () => {
    const code = readFileSync(new URL("./edit-entry-button.tsx", import.meta.url), "utf8");
    expect(code).toContain("confirm(deleteConfirmWords(");
    expect(code).not.toContain('confirm("Delete this time entry?');
    // The words and the door come off the SAME pieces, so they cannot drift apart again.
    expect(code).toContain("if (!prevKin && !nextKin) return null;");
    expect(code).toContain("running: isOpen,");
  });
});

/**
 * A BOUNDARY IS TWO CLOSED PIECES THAT TOUCH — the other half of the same hole.
 *
 * splitNeighbors only asks that `next` STARTS where this piece ends, so the `next` of a closed first
 * piece is the RUNNING clock a Switch Job opened. Timecards packed its clock_out with String(null) —
 * the string "null", which is truthy — so the editor drew Join Back Into One Shift on a boundary
 * join_time_entries can only refuse (0322), and Move The Split on a piece with no end to slide to.
 */
describe("the split tools are only drawn where they can work", () => {
  const prev = {
    id: "0c7fae89-0000-4000-8000-00000000000p",
    clock_in: "2026-09-22T14:00:00Z",
    clock_out: "2026-09-22T17:00:00Z",
    label: "J-013 ARR 56",
    job_id: "a0000000-0000-4000-8000-00000000033a",
    job_code: null,
    lunch_minutes: 0,
    miles: 0,
  };
  /** The piece on screen: 10:00 to 1:00, cut from the one before it. */
  const middle = {
    id: B,
    profile_id: BRIAN,
    clock_in: "2026-09-22T17:00:00Z",
    clock_out: "2026-09-22T20:00:00Z",
    lunch_minutes: 0,
    job_id: JOB,
    job_code: null,
    notes: null,
    miles: 0,
    status: "closed",
    split_from: prev.id,
    profiles: { full_name: "Brian Taylor" },
    job: { job_number: "J-011", name: "Honeysuckle" },
  };
  const renderEditor = (neighbors: unknown) =>
    renderToStaticMarkup(
      createElement(EditEntryButton, {
        entry: middle as any,
        jobCodes: [],
        jobs: [],
        members: [{ id: BRIAN, full_name: "Brian Taylor" }],
        isStaff: true,
        initialOpen: true,
        hideTrigger: true,
        tz: "America/Los_Angeles",
        neighbors: neighbors as any,
        viewerId: BRIAN,
      }),
    );

  it("THE DEFECT: the next piece is the running clock, so neither door is drawn on that boundary", () => {
    const html = renderEditor({ prev: null, next: { ...prev, id: C, clock_in: "2026-09-22T20:00:00Z", clock_out: null, label: "J-012 Larkspur" } });
    expect(html).not.toContain("Join Back Into One Shift");
    expect(html).not.toContain("Move The Split");
    expect(html).not.toContain("Split from the part after");
    // The shift itself still opens and can still be split: nothing else was taken away.
    expect(html).toContain("Split This Shift");
  });

  it("two closed pieces that touch still get both doors, on both sides", () => {
    const after = { ...prev, id: C, clock_in: "2026-09-22T20:00:00Z", clock_out: "2026-09-22T22:00:00Z", label: "J-012 Larkspur" };
    const html = renderEditor({ prev, next: after });
    expect(html).toContain("Split from the part before");
    expect(html).toContain("Split from the part after");
    expect(html.split("Join Back Into One Shift").length - 1).toBe(2);
  });

  it("and Timecards stops telling the editor a running neighbour is closed", () => {
    const page = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
    expect(page).not.toContain("clock_out: String(r.clock_out),");
    expect(page).toContain("clock_out: r.clock_out ? String(r.clock_out) : null,");
  });
});
