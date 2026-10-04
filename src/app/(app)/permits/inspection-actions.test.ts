import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * THE THREE DOORS ON A PERMIT'S INSPECTIONS (0378), without a database.
 *
 *   saveInspection          books one (or moves one): who, which day, which part of the day. THE GATE
 *                           NEVER REFUSES IT — both of the October job's inspections were booked for
 *                           one morning, by phone, before the town had been anywhere.
 *   recordInspectionResult  says how it went. A result with no day is refused in words (0378 refuses
 *                           it in SQL). The last pass CLOSES the permit and the sentence carries the
 *                           next step forward.
 *   deleteInspection        takes a booking off; a visit that happened is a result, never a deletion.
 *
 * Every write is checked (.select("id")): a zero-row answer is a 204 dressed as success, and this
 * proves each door says so instead.
 */
type Row = Record<string, any>;
const state = vi.hoisted(() => ({
  permits: [] as Row[],
  inspections: [] as Row[],
  writes: [] as { table: string; kind: "insert" | "update" | "delete"; patch: Row }[],
  /** Every query that ran, with the columns it filtered on: the org_id proof. */
  queries: [] as { table: string; kind: "read" | "insert" | "update" | "delete"; on: string[] }[],
  blind: false, // every write matches zero rows (a cross-org id, or it was just deleted)
  statusWriteFails: false,
  orgId: "org-1" as string | null,
  /** THE COMPANY'S TODAY the doors read the verdict against (orgTodayStr, mocked below). */
  today: "2026-10-15",
  /** The re-read of the permit's visits after the write fails (a network blip). */
  reReadFails: false,
}));

function builder(table: string) {
  const eqs: Record<string, unknown> = {};
  let patch: Row | null = null;
  let inserting: Row | null = null;
  let deleting = false;
  const rowsOf = () => {
    const all = table === "permits" ? state.permits : table === "permit_inspections" ? state.inspections : [];
    return all.filter((r) => Object.entries(eqs).every(([c, v]) => r[c] === v));
  };
  const run = () => {
    state.queries.push({
      table,
      kind: inserting ? "insert" : deleting ? "delete" : patch ? "update" : "read",
      on: Object.keys(eqs),
    });
    if (inserting) {
      const row = { id: `new-${state.inspections.length + 1}`, org_id: "org-1", result: null, result_on: null, ...inserting };
      state.writes.push({ table, kind: "insert", patch: inserting });
      if (state.blind) return { data: [], error: null };
      state.inspections.push(row);
      return { data: [{ id: row.id }], error: null };
    }
    const rows = rowsOf();
    if (deleting) {
      state.writes.push({ table, kind: "delete", patch: { ...eqs } });
      if (state.blind) return { data: [], error: null };
      state.inspections = state.inspections.filter((r) => !rows.includes(r));
      return { data: rows.map((r) => ({ id: r.id })), error: null };
    }
    if (patch) {
      state.writes.push({ table, kind: "update", patch });
      if (state.statusWriteFails && table === "permits") return { data: [], error: null };
      if (state.blind) return { data: [], error: null };
      for (const r of rows) Object.assign(r, patch);
      return { data: rows.map((r) => ({ id: r.id })), error: null };
    }
    // A LOST READ of the permit's other visits: the list read (no id filter), after a write ran.
    if (state.reReadFails && table === "permit_inspections" && !eqs.id && state.writes.length) {
      return { data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } };
    }
    return { data: rows, error: null };
  };
  const b: any = {
    select: () => b,
    eq: (c: string, v: unknown) => ((eqs[c] = v), b),
    order: () => b,
    limit: () => b,
    update: (p: Row) => ((patch = p), b),
    insert: (p: Row) => ((inserting = p), b),
    delete: () => ((deleting = true), b),
    maybeSingle: async () => {
      const r = run();
      return { data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data, error: r.error };
    },
    then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(run()).then(ok, bad),
  };
  return b;
}
const client = { from: (t: string) => builder(t) };

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => client) }));
vi.mock("@/lib/staff-guard", () => ({ requireStaff: async () => ({ supabase: client, userId: "office-1", orgId: state.orgId }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
// THE COMPANY'S DAY, fixed: every door reads the verdict against it (never the day of the visit it is
// writing up), so the suite has to be able to set it to a day that is not the booked one.
vi.mock("@/lib/billing-pipeline", () => ({ orgTodayStr: async () => state.today }));

const { saveInspection, recordInspectionResult, deleteInspection } = await import("./inspection-actions");

const TOWN = "Town of Truckee";
const UTIL = "Liberty Utilities";
const THU = "2026-10-15";

const insp = (over: Row) => ({
  id: `i${over.position}`,
  org_id: "org-1",
  permit_id: "p1",
  authority: TOWN,
  scheduled_for: null,
  scheduled_window: null,
  inspector: null,
  result: null,
  result_on: null,
  notes: null,
  ...over,
});

beforeEach(() => {
  state.permits = [{ id: "p1", org_id: "org-1", permit_number: "E-1234", job_id: "j1", status: "issued" }];
  state.inspections = [];
  state.writes = [];
  state.blind = false;
  state.queries = [];
  state.statusWriteFails = false;
  state.orgId = "org-1";
  state.today = THU;
  state.reReadFails = false;
});

const lastInsert = () => state.writes.filter((w) => w.kind === "insert").at(-1)?.patch;

describe("saveInspection: booking one is never gated", () => {
  it("the first one lands at position 1 with the day and the part of the day", async () => {
    const res = await saveInspection({ permit_id: "p1", authority: TOWN, scheduled_for: THU, scheduled_window: "morning" });
    expect(res).toEqual({ ok: true, message: `${TOWN} booked` });
    expect(lastInsert()).toMatchObject({ permit_id: "p1", authority: TOWN, position: 1, scheduled_for: THU, scheduled_window: "morning" });
  });

  it("THE UTILITY IS BOOKED FOR THE SAME MORNING, WITH THE TOWN STILL OPEN IN FRONT OF IT", async () => {
    // The whole reason the gate is not on this door: he books both by phone, days ahead.
    state.inspections = [insp({ position: 1, scheduled_for: THU, scheduled_window: "morning" })];
    const res = await saveInspection({ permit_id: "p1", authority: UTIL, scheduled_for: THU, scheduled_window: "morning" });
    expect(res.ok).toBe(true);
    expect(lastInsert()).toMatchObject({ authority: UTIL, position: 2, scheduled_for: THU });
  });

  it("a morning with no day is refused in words, never by the database's check", async () => {
    const res = await saveInspection({ permit_id: "p1", authority: UTIL, scheduled_window: "morning" });
    expect(res).toEqual({ ok: false, error: "Pick the day as well — a morning needs a date on it." });
    expect(state.writes).toEqual([]);
  });

  it("no authority, no booking: somebody has to be coming", async () => {
    const res = await saveInspection({ permit_id: "p1", authority: "   ", scheduled_for: THU });
    expect(res).toEqual({ ok: false, error: "Say who is coming — the town, the county or the utility." });
    expect(state.writes).toEqual([]);
  });

  it("no day yet is fine — that is an authority you still have to phone", async () => {
    const res = await saveInspection({ permit_id: "p1", authority: UTIL });
    expect(res.ok).toBe(true);
    expect(res.message).toContain("book a day when you have one");
    expect(lastInsert()).toMatchObject({ authority: UTIL, scheduled_for: null, scheduled_window: null });
  });

  it("another company's permit is not found, and nothing is written", async () => {
    state.permits = [{ id: "p1", org_id: "org-OTHER", permit_number: "E-1234", job_id: "j1", status: "issued" }];
    expect(await saveInspection({ permit_id: "p1", authority: TOWN })).toEqual({ ok: false, error: "That permit isn't here any more." });
    expect(state.writes).toEqual([]);
  });

  it("a write nobody matched is said out loud, never reported as saved", async () => {
    state.blind = true;
    expect((await saveInspection({ permit_id: "p1", authority: TOWN })).error).toBe("Nothing was saved. Try it again.");
    state.inspections = [insp({ position: 1 })];
    expect((await saveInspection({ id: "i1", permit_id: "p1", authority: TOWN, scheduled_for: THU })).error).toBe(
      "Nothing was saved — that inspection was removed from another screen.",
    );
  });

  it("moving a booking changes that row, and never its place in the order", async () => {
    state.inspections = [insp({ position: 1, scheduled_for: THU })];
    const res = await saveInspection({ id: "i1", permit_id: "p1", authority: TOWN, scheduled_for: "2026-10-20", scheduled_window: "afternoon" });
    expect(res.ok).toBe(true);
    const w = state.writes.find((x) => x.kind === "update")!;
    expect(w.patch).toMatchObject({ authority: TOWN, scheduled_for: "2026-10-20", scheduled_window: "afternoon" });
    expect(w.patch).not.toHaveProperty("position");
  });

  it("MOVING A BOOKING NEVER ERASES WHO CAME, or the notes on it", async () => {
    // The booking form sends who / which day / which part of the day and nothing else. Fixing the day
    // on a visit that already happened used to send inspector: null and notes: null with it, and the
    // card dropped from "Town of Truckee · Passed Oct 15 · Dana" to "Town of Truckee · Passed Oct 15".
    state.inspections = [insp({ position: 1, scheduled_for: THU, result: "passed", result_on: THU, inspector: "Dana", notes: "Panel label photo" })];
    const res = await saveInspection({ id: "i1", permit_id: "p1", authority: TOWN, scheduled_for: "2026-10-20", scheduled_window: "morning" });
    expect(res.ok).toBe(true);
    const w = state.writes.find((x) => x.kind === "update")!;
    expect(w.patch).not.toHaveProperty("inspector");
    expect(w.patch).not.toHaveProperty("notes");
    expect(state.inspections[0]).toMatchObject({ inspector: "Dana", notes: "Panel label photo", scheduled_for: "2026-10-20" });
  });

  it("a name sent BLANK on purpose still clears it — fill, never overwrite, is about keys not sent", async () => {
    state.inspections = [insp({ position: 1, inspector: "Dana" })];
    await saveInspection({ id: "i1", permit_id: "p1", authority: TOWN, inspector: "" });
    expect(state.writes.find((x) => x.kind === "update")!.patch).toMatchObject({ inspector: null });
  });

  it("A RETRY IS BOOKED ON THE END AND READ IN ITS PLACE: the permit stops saying 'book another visit'", async () => {
    // Thursday's own job. Both booked for one morning; the town fails; he books the town again.
    state.inspections = [
      insp({ position: 1, authority: TOWN, scheduled_for: THU, scheduled_window: "morning", result: "failed", result_on: THU }),
      insp({ position: 2, authority: UTIL, scheduled_for: THU, scheduled_window: "morning" }),
    ];
    state.permits[0].status = "failed";
    state.today = "2026-10-16";
    const res = await saveInspection({ permit_id: "p1", authority: TOWN, scheduled_for: "2026-10-20", scheduled_window: "morning" });
    expect(res.ok).toBe(true);
    expect(lastInsert()).toMatchObject({ authority: TOWN, position: 3 });

    // Recording that retry PASSED now moves the permit on: the utility becomes the subject, and the
    // red word the chain wrote is taken back. It used to answer "Town of Truckee failed Oct 15 — book
    // another visit" to the very action that recorded the pass, and the permit stayed red forever.
    const pass = await recordInspectionResult({ id: "new-3", result: "passed", result_on: "2026-10-20" });
    expect(pass.ok).toBe(true);
    expect(pass.next).toBe(`${UTIL} was booked Oct 15 — record the inspection status`);
    expect(pass.next).not.toContain("book another visit");
    expect(state.permits[0].status).toBe("issued");
  });
});

describe("recordInspectionResult: a result needs a day, and the pass carries forward", () => {
  beforeEach(() => {
    state.inspections = [
      insp({ position: 1, authority: TOWN, scheduled_for: THU, scheduled_window: "morning" }),
      insp({ position: 2, authority: UTIL, scheduled_for: THU, scheduled_window: "morning" }),
    ];
  });

  it("no day, no result: the form cannot ask for one without the other", async () => {
    expect(await recordInspectionResult({ id: "i1", result: "passed" })).toEqual({
      ok: false,
      error: "Put the day they came on it — a result needs a date.",
    });
    expect(state.writes).toEqual([]);
  });

  /**
   * A FAILURE SAYS WHY (Erik, 2026-10-03: "Inspection Status: Passed or Failed (if failed, why)").
   * A failed inspection with no reason is a visit somebody has to make again just to learn what it
   * was for, and the correction can be neither priced nor ordered. The form shuts Save without it;
   * this is the door refusing it, because a form is a convention and a door is the boundary.
   */
  it("a failure with no reason is refused, and nothing is written", async () => {
    const before = { ...state.inspections[0] };
    const res = await recordInspectionResult({ id: "i1", result: "failed", result_on: THU });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/why it failed/i);
    expect(res.error).toMatch(/nothing was saved/i);
    expect(state.inspections[0]).toEqual(before);
  });

  it("a failure WITH a reason keeps it on the visit it explains", async () => {
    const res = await recordInspectionResult({ id: "i1", result: "failed", result_on: THU, why: "Panel not bonded" });
    expect(res.ok).toBe(true);
    expect(state.inspections[0].result).toBe("failed");
    expect(state.inspections[0].notes).toBe("Panel not bonded");
  });

  it("a PASS never wipes the reason an earlier failure left — that is why they came back", async () => {
    state.inspections[0] = { ...state.inspections[0], notes: "Panel not bonded" };
    const res = await recordInspectionResult({ id: "i1", result: "passed", result_on: THU });
    expect(res.ok).toBe(true);
    expect(state.inspections[0].notes).toBe("Panel not bonded");
  });

  it("a made-up result is refused", async () => {
    expect((await recordInspectionResult({ id: "i1", result: "sort of", result_on: THU })).error).toBe(
      "Pick the inspection status: passed, failed or cancelled.",
    );
  });

  it("the town passes: the utility is named as what is next, and the permit stays open", async () => {
    const res = await recordInspectionResult({ id: "i1", result: "passed", result_on: THU, inspector: "Dana" });
    expect(res.ok).toBe(true);
    expect(res.clear).toBe(false);
    expect(res.message).toBe(`${TOWN} passed.`);
    expect(res.next).toBe(`Waiting on ${UTIL} — Thu Oct 15, morning`);
    expect(res.href).toBe("/jobs/j1?tab=permits");
    expect(state.permits[0].status).toBe("issued"); // not this visit's word to overwrite
    expect(state.inspections[0]).toMatchObject({ result: "passed", result_on: THU, inspector: "Dana" });
  });

  it("the utility passes: the permit CLOSES, and the sentence holds in every trade", async () => {
    state.inspections[0] = { ...state.inspections[0], result: "passed", result_on: THU };
    const res = await recordInspectionResult({ id: "i2", result: "passed", result_on: THU });
    expect(res.ok).toBe(true);
    expect(res.clear).toBe(true);
    // NOT "the meter is on": that is a fact about an electrical job whose last authority is the
    // utility. A deck permit's one county inspection said it to the builder too.
    expect(res.message).toBe(`${UTIL} passed. Every inspection on permit E-1234 has passed — the job is done.`);
    expect(res.message).not.toContain("meter");
    expect(res.next).toBe("Finish the job and bill it");
    expect(res.href).toBe("/jobs/j1");
    expect(state.permits[0].status).toBe("passed"); // the door it came through is closed behind it
  });

  it("A DECK PERMIT'S ONE COUNTY INSPECTION NEVER CLAIMS A METER", async () => {
    state.permits = [{ id: "p1", org_id: "org-1", permit_number: "B-7", job_id: "j1", status: "issued" }];
    state.inspections = [insp({ position: 1, authority: "Nevada County Building", scheduled_for: THU })];
    const res = await recordInspectionResult({ id: "i1", result: "passed", result_on: THU });
    expect(res.message).toBe("Nevada County Building passed. Every inspection on permit B-7 has passed — the job is done.");
    expect(res.message).not.toContain("meter");
  });

  it("WRITTEN UP A DAY LATE, the sentence is read against TODAY — never the day they came", async () => {
    // Friday. Nothing was written up on Thursday, so he records the town for Thursday. Reading the
    // verdict against Thursday said "Waiting on Liberty Utilities — Thu Oct 15, morning" while the card
    // beside it, on the real today, read "Liberty Utilities was booked Oct 15 — record the inspection status".
    state.today = "2026-10-16";
    const res = await recordInspectionResult({ id: "i1", result: "passed", result_on: THU });
    expect(res.next).toBe(`${UTIL} was booked Oct 15 — record the inspection status`);
  });

  it("A LOST RE-READ NEVER PASSES FOR 'nothing outstanding': it says the permit was not re-checked", async () => {
    // The last pass is written, then the read of the permit's other visits errors. "No rows" read as a
    // permit with nothing left, so the chain skipped closing it, said no next step, and still reported
    // success: the permit stayed `issued` and counted open with nobody told.
    state.inspections[0] = { ...state.inspections[0], result: "passed", result_on: THU };
    state.reReadFails = true;
    const res = await recordInspectionResult({ id: "i2", result: "passed", result_on: THU });
    expect(res.ok).toBe(true);
    expect(res.clear).toBe(false);
    expect(res.message).toContain("couldn't be read");
    expect(res.message).toContain("wasn't re-checked");
    expect(res.next).toBeNull();
    expect(state.inspections[1].result).toBe("passed"); // the visit itself IS written
    expect(state.writes.filter((w) => w.table === "permits")).toEqual([]);
  });

  it("a failure still says failed even when the re-read is lost — that much this visit knows", async () => {
    state.reReadFails = true;
    const res = await recordInspectionResult({ id: "i1", result: "failed", result_on: THU, why: "Panel not bonded" });
    expect(res.ok).toBe(true);
    expect(state.permits[0].status).toBe("failed");
    expect(res.message).toContain("wasn't re-checked");
  });

  it("A FAILURE THE ROWS NO LONGER CARRY IS TAKEN BACK — the permit stops reading red", async () => {
    // The chain wrote `failed`. A later visit passed, with the utility still to come: the permit's own
    // badge read red "failed" beside a card saying "Waiting on Liberty Utilities" until the very last
    // visit passed. The two words the chain writes are the two it may take back.
    state.permits[0].status = "failed";
    state.inspections = [
      insp({ position: 1, authority: TOWN, result: "failed", result_on: THU }),
      insp({ position: 2, authority: TOWN, scheduled_for: "2026-10-20" }),
      insp({ position: 3, authority: UTIL, scheduled_for: "2026-10-22" }),
    ];
    state.today = "2026-10-20";
    const res = await recordInspectionResult({ id: "i2", result: "passed", result_on: "2026-10-20" });
    expect(res.ok).toBe(true);
    expect(state.permits[0].status).toBe("issued");
    expect(res.next).toBe(`Waiting on ${UTIL} — Thu Oct 22`);
  });

  it("a mis-tapped Failed corrected to Passed takes the word back too", async () => {
    state.permits[0].status = "failed";
    state.inspections[0] = { ...state.inspections[0], result: "failed", result_on: THU };
    await recordInspectionResult({ id: "i1", result: "passed", result_on: THU });
    expect(state.permits[0].status).toBe("issued");
  });

  it("a closed permit the chain never wrote is left exactly as the office left it", async () => {
    state.permits[0].status = "closed";
    await recordInspectionResult({ id: "i1", result: "passed", result_on: THU });
    expect(state.permits[0].status).toBe("closed");
    expect(state.writes.filter((w) => w.table === "permits")).toEqual([]);
  });

  it("a CANCELLED visit is not a failure: the permit stays open, never red", async () => {
    const res = await recordInspectionResult({ id: "i1", result: "cancelled", result_on: THU });
    expect(res.ok).toBe(true);
    expect(state.permits[0].status).toBe("issued");
    expect(res.next).toBe(`${TOWN} cancelled Oct 15 — book another visit`);
  });

  it("a failure says failed on the permit too — a failed inspection needs somebody most of all", async () => {
    const res = await recordInspectionResult({ id: "i1", result: "failed", result_on: THU, why: "Panel not bonded" });
    expect(state.permits[0].status).toBe("failed");
    expect(res.next).toBe(`${TOWN} failed Oct 15 — book another visit`);
  });

  it("the visit is recorded even when the permit's own status will not move, and it says so", async () => {
    state.statusWriteFails = true;
    state.inspections[0] = { ...state.inspections[0], result: "passed", result_on: THU };
    const res = await recordInspectionResult({ id: "i2", result: "passed", result_on: THU });
    expect(res.ok).toBe(true);
    expect(res.message).toContain('the permit still reads "issued" — set it by hand');
    expect(state.inspections[1].result).toBe("passed"); // the visit itself is written
  });

  it("a blank inspector never erases who came", async () => {
    state.inspections[0] = { ...state.inspections[0], inspector: "Dana" };
    await recordInspectionResult({ id: "i1", result: "passed", result_on: THU, inspector: "  " });
    expect(state.writes.find((w) => w.kind === "update")!.patch).not.toHaveProperty("inspector");
    expect(state.inspections[0].inspector).toBe("Dana");
  });

  it("an inspection that has gone is said, never reported as recorded", async () => {
    expect((await recordInspectionResult({ id: "nope", result: "passed", result_on: THU })).error).toBe(
      "That inspection isn't here any more.",
    );
    state.blind = true;
    expect((await recordInspectionResult({ id: "i1", result: "passed", result_on: THU })).error).toBe(
      "Nothing was saved — that inspection was removed from another screen.",
    );
  });
});

describe("deleteInspection: only a booking nobody went to", () => {
  it("removes a booking that was never going to happen", async () => {
    state.inspections = [insp({ position: 1 })];
    const res = await deleteInspection("i1", "p1");
    expect(res.ok).toBe(true);
    expect(res.message).toBe(`${TOWN} inspection removed.`);
    expect(state.inspections).toEqual([]);
  });

  it("says so when nothing was removed", async () => {
    state.inspections = [insp({ position: 1 })];
    state.blind = true;
    expect((await deleteInspection("i1", "p1")).error).toBe("Nothing was removed — it had already gone.");
  });

  it("A VISIT THAT HAPPENED IS REFUSED, in words, and nothing is deleted", async () => {
    // One tap erased the day somebody came, who came and how it went — and with it the visit in front
    // of the next authority, so the utility read as unblocked with nothing having passed.
    for (const result of ["passed", "failed", "cancelled"] as const) {
      state.writes = [];
      state.inspections = [
        insp({ position: 1, authority: TOWN, result, result_on: THU, inspector: "Dana" }),
        insp({ position: 2, authority: UTIL, scheduled_for: THU }),
      ];
      const res = await deleteInspection("i1", "p1");
      expect(res.ok).toBe(false);
      expect(res.error).toContain("already happened");
      expect(res.error).toContain("Change It");
      expect(state.writes).toEqual([]);
      expect(state.inspections).toHaveLength(2);
    }
  });

  it("taking the LAST OPEN booking off a permit whose visits all passed CLOSES the permit, and says so", async () => {
    // The card went green "every inspection passed" while the permit itself stayed `issued` and the
    // Permits chip still counted it open, with nobody told the utility never came.
    state.inspections = [
      insp({ position: 1, authority: TOWN, result: "passed", result_on: THU, inspector: "Dana" }),
      insp({ position: 2, authority: UTIL, scheduled_for: THU }),
    ];
    const res = await deleteInspection("i2", "p1");
    expect(res.ok).toBe(true);
    expect(res.clear).toBe(true);
    expect(res.next).toBe("Every inspection passed — the job is done");
    expect(res.href).toBe("/jobs/j1?tab=permits");
    expect(state.permits[0].status).toBe("passed");
  });

  it("removing one that still leaves work carries the next thing forward, and never closes the permit", async () => {
    state.inspections = [
      insp({ position: 1, authority: TOWN, scheduled_for: THU }),
      insp({ position: 2, authority: UTIL }),
    ];
    const res = await deleteInspection("i2", "p1");
    expect(res.clear).toBe(false);
    expect(res.next).toBe(`Waiting on ${TOWN} — Thu Oct 15`);
    expect(state.permits[0].status).toBe("issued");
  });

  it("a lost re-read after the removal says the permit was not re-checked", async () => {
    state.inspections = [insp({ position: 1, authority: TOWN, result: "passed", result_on: THU }), insp({ position: 2, authority: UTIL })];
    state.reReadFails = true;
    const res = await deleteInspection("i2", "p1");
    expect(res.ok).toBe(true);
    expect(res.message).toContain("couldn't be read");
    expect(state.writes.filter((w) => w.table === "permits")).toEqual([]);
  });
});

describe("every door is org-scoped and staff-only", () => {
  it("a sign-in with no company writes nothing anywhere", async () => {
    state.orgId = null;
    const no = { ok: false, error: "Your sign-in isn't attached to a company yet." };
    expect(await saveInspection({ permit_id: "p1", authority: TOWN })).toEqual(no);
    expect(await recordInspectionResult({ id: "i1", result: "passed", result_on: THU })).toEqual(no);
    expect(await deleteInspection("i1", "p1")).toEqual(no);
    expect(state.writes).toEqual([]);
  });

  it("every read and every write names org_id (three organizations share one database)", async () => {
    state.inspections = [insp({ position: 1 })];
    await recordInspectionResult({ id: "i1", result: "passed", result_on: THU });
    await saveInspection({ permit_id: "p1", authority: UTIL, scheduled_for: THU });
    await deleteInspection("i1", "p1");
    const unscoped = state.queries.filter((q) => q.kind !== "insert" && !q.on.includes("org_id"));
    expect(unscoped).toEqual([]);
    // The INSERT is the one that doesn't carry it: 0378's own trigger (set_org_id) stamps the row,
    // so a client that got it wrong could never put a visit in another company's permit.
    expect(lastInsert()).not.toHaveProperty("org_id");
  });
});
