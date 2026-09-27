import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * THE WALK-THROUGH'S TWO WRITERS, AND WHO GETS WHICH (0356; Erik, 2026-09-26: "crew leader yes tech
 * no").
 *
 *   · the office: saveInspectionCapture / saveInspectionAnswers exactly as before, an UPDATE under
 *     appointments_write, never the new function;
 *   · a crew lead ON the visit: the same cleaning, then save_walkthrough_capture, the one door the
 *     database opens to him (his photos merged so none already on the list is dropped);
 *   · anyone else (a plain tech, a crew lead on someone else's visit, a deactivated seat): refused in
 *     words, before any write, and `refused` so the autosave stops re-trying;
 *   · before 0356 is applied: a plain sentence, nothing saved, never a raw PGRST202.
 *
 * The fake client holds one appointment row, one sheet and the caller's profile; the database's own
 * half of the rule is walkthrough-crew-lead.integration.test.ts.
 */
const db = vi.hoisted(() => ({
  staff: false,
  member: { ok: true as boolean, error: "" },
  crewLead: true,
  appt: null as any,
  form: null as any,
  updates: [] as any[],
  rpcCalls: [] as { fn: string; args: any }[],
  rpcResult: { data: "appt-1" as unknown, error: null as null | { code: string; message: string } },
  /** When set, answers each call in turn (a race needs the first and second to differ). */
  rpcQueue: [] as { data: unknown; error: null | { code: string; message: string }; before?: () => void }[],
  /** Every path handed to storage's remove, in order. */
  removed: [] as string[],
}));

vi.mock("@/lib/staff-guard", () => ({
  requireStaff: vi.fn(async () =>
    db.staff ? { supabase: client(), userId: "office-1", orgId: "org-1" } : { error: "This action is staff-only." },
  ),
  requireMember: vi.fn(async () =>
    db.member.ok
      ? { supabase: client(), userId: "lead-1", orgId: "org-1", staff: db.staff, name: "Brian" }
      : { error: db.member.error },
  ),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/calendar-sync", () => ({ pushCalendarItem: vi.fn(async () => {}), deleteCalendarItem: vi.fn(async () => {}) }));
vi.mock("@/lib/push", () => ({ sendPushToProfiles: vi.fn(async () => {}) }));

import { addInspectionPhotos, removeInspectionPhoto, saveInspectionAnswers, saveInspectionCapture } from "./actions";

function client() {
  return {
    auth: { getUser: async () => ({ data: { user: { id: db.staff ? "office-1" : "lead-1" } } }) },
    storage: {
      from: () => ({
        remove: async (paths: string[]) => (db.removed.push(...paths), { data: paths.map((name) => ({ name })), error: null }),
      }),
    },
    rpc: async (fn: string, args: any) => {
      db.rpcCalls.push({ fn, args });
      const next = db.rpcQueue.shift();
      if (next) {
        next.before?.();
        return { data: next.data, error: next.error };
      }
      return db.rpcResult;
    },
    from(table: string) {
      const q: { op: string; patch?: any; filters: [string, unknown][] } = { op: "select", filters: [] };
      const matches = (row: any) => !!row && q.filters.every(([c, v]) => row[c] === v);
      const run = async () => {
        if (table === "profiles") return { data: q.op === "select" ? { crew_lead: db.crewLead, org_id: "org-1" } : null, error: null };
        if (table === "forms") return { data: matches(db.form) ? db.form : null, error: null };
        if (table === "appointments") {
          if (q.op === "update") {
            db.updates.push(q.patch);
            if (!matches(db.appt)) return { data: [], error: null };
            Object.assign(db.appt, q.patch);
            return { data: [{ id: db.appt.id }], error: null };
          }
          return { data: matches(db.appt) ? { ...db.appt } : null, error: null };
        }
        return { data: null, error: null };
      };
      const chain: any = {
        select: () => chain,
        update: (patch: any) => ((q.op = "update"), (q.patch = patch), chain),
        eq: (c: string, v: unknown) => (q.filters.push([c, v]), chain),
        maybeSingle: () => run(),
        then: (ok: any, err: any) => run().then(ok, err),
      };
      return chain;
    },
  };
}

const PHOTO_OFFICE = "org-1/appointments/appt-1/1-office.jpg";
const PHOTO_LEAD = "org-1/appointments/appt-1/2-lead.jpg";

beforeEach(() => {
  db.staff = false;
  db.member = { ok: true, error: "" };
  db.crewLead = true;
  db.appt = {
    id: "appt-1",
    org_id: "org-1",
    assigned_to: "lead-1",
    capture: { notes: "office note", measurements: "", materials: "", photos: [PHOTO_OFFICE], quote_id: "q-9" },
    inspection_template_id: "sheet-1",
    inspection_answers: { work: "Deck", scope: [{ code: "R1", qty: 1, price: 500 }] },
  };
  db.form = {
    id: "sheet-1",
    is_inspection: true,
    schema: [],
    playbook: {
      needs: [
        { key: "work", label: "Work", ask: "What work?", slot: { type: "select", options: ["Deck", "Remodel"] } },
        { key: "scope", label: "Scope", ask: "Which scopes?", slot: { type: "scopes" } },
      ],
    },
  };
  db.updates = [];
  db.rpcCalls = [];
  db.rpcResult = { data: "appt-1", error: null };
  db.rpcQueue = [];
  db.removed = [];
});

describe("the office: unchanged", () => {
  it("capture is an UPDATE under the office's policy, never the crew lead's door", async () => {
    db.staff = true;
    expect(await saveInspectionCapture("appt-1", { notes: "office again" })).toEqual({ ok: true, id: "appt-1" });
    expect(db.rpcCalls).toEqual([]);
    expect(db.updates).toHaveLength(1);
    expect(db.updates[0].capture.notes).toBe("office again");
    expect(db.updates[0].capture.quote_id).toBe("q-9");
  });

  it("a photo appended by someone who is office staff by then is the office's UPDATE, appended too", async () => {
    db.staff = true;
    const taken = "org-1/appointments/appt-1/5-taken.jpg";
    expect(await addInspectionPhotos("appt-1", [taken])).toEqual({ ok: true, id: "appt-1" });
    expect(db.rpcCalls).toEqual([]);
    expect(db.updates).toHaveLength(1);
    expect(db.updates[0].capture.photos).toEqual([PHOTO_OFFICE, taken]);
  });

  it("answers are an UPDATE, and the office may change a price", async () => {
    db.staff = true;
    const r = await saveInspectionAnswers("appt-1", "sheet-1", { work: "Remodel", scope: [{ code: "R1", qty: 2, price: 650 }] });
    expect(r).toEqual({ ok: true, id: "appt-1" });
    expect(db.rpcCalls).toEqual([]);
    expect(db.updates[0].inspection_answers).toMatchObject({ work: "Remodel", scope: [{ code: "R1", qty: 2, price: 650 }] });
  });
});

describe("the office takes one photo off, and its file with it", () => {
  it("the crew lead's own photo: off the list and out of the folder, so his save has nothing to put back", async () => {
    db.staff = true;
    db.appt.capture.photos = [PHOTO_OFFICE, PHOTO_LEAD];
    expect(await removeInspectionPhoto("appt-1", PHOTO_LEAD)).toEqual({ ok: true, id: "appt-1" });
    expect(db.rpcCalls).toEqual([]);
    expect(db.updates).toHaveLength(1);
    expect(db.updates[0].capture.photos).toEqual([PHOTO_OFFICE]);
    expect(db.removed).toEqual([PHOTO_LEAD]);
  });

  it("names one path, never a page's list: a photo added since the office's page opened stays, file and all", async () => {
    db.staff = true;
    db.appt.capture.photos = [PHOTO_OFFICE, PHOTO_LEAD];
    expect(await removeInspectionPhoto("appt-1", PHOTO_OFFICE)).toEqual({ ok: true, id: "appt-1" });
    expect(db.updates[0].capture.photos).toEqual([PHOTO_LEAD]);
    expect(db.removed).toEqual([PHOTO_OFFICE]);
  });

  it("a file outside this visit's own folder, or not on the list, comes off the list only", async () => {
    db.staff = true;
    const elsewhere = "org-1/appointments/appt-2/9-other.jpg";
    db.appt.capture.photos = [PHOTO_OFFICE, elsewhere];
    expect(await removeInspectionPhoto("appt-1", elsewhere)).toEqual({ ok: true, id: "appt-1" });
    expect(db.updates[0].capture.photos).toEqual([PHOTO_OFFICE]);
    expect(await removeInspectionPhoto("appt-1", "org-1/appointments/appt-1/never-listed.jpg")).toEqual({ ok: true, id: "appt-1" });
    expect(db.removed).toEqual([]);
  });

  it("a crew lead can't: refused before any write, no file touched", async () => {
    expect(await removeInspectionPhoto("appt-1", PHOTO_OFFICE)).toMatchObject({ ok: false, refused: true, error: expect.stringMatching(/Only the office/) });
    expect(db.rpcCalls).toEqual([]);
    expect(db.updates).toEqual([]);
    expect(db.removed).toEqual([]);
  });
});

describe("a crew lead on the visit: through save_walkthrough_capture", () => {
  it("capture: notes land, the office's photo stays on the list even if his page dropped it", async () => {
    const r = await saveInspectionCapture("appt-1", { notes: "crew notes", photos: [PHOTO_LEAD] });
    expect(r).toEqual({ ok: true, id: "appt-1" });
    expect(db.updates).toEqual([]); // no UPDATE of his own: he holds none
    expect(db.rpcCalls).toHaveLength(1);
    const { fn, args } = db.rpcCalls[0];
    expect(fn).toBe("save_walkthrough_capture");
    expect(args.p_appointment).toBe("appt-1");
    expect(args.p_capture.notes).toBe("crew notes");
    expect(args.p_capture.photos).toEqual([PHOTO_OFFICE, PHOTO_LEAD]);
    expect(args).not.toHaveProperty("p_answers");
  });

  it("answers: cleaned against the sheet like the office's, then the database's door", async () => {
    const r = await saveInspectionAnswers("appt-1", "sheet-1", { work: "Remodel", scope: [{ code: "R1", qty: 1 }], invented: "x" });
    expect(r).toEqual({ ok: true, id: "appt-1" });
    expect(db.updates).toEqual([]);
    const { fn, args } = db.rpcCalls[0];
    expect(fn).toBe("save_walkthrough_capture");
    expect(args.p_template_id).toBe("sheet-1");
    expect(args.p_answers.work).toBe("Remodel");
    expect(args.p_answers).not.toHaveProperty("invented"); // a key the sheet never declared
    expect(args).not.toHaveProperty("p_capture");
  });

  it("nothing back from the function is a failure said out loud", async () => {
    db.rpcResult = { data: null, error: null };
    expect(await saveInspectionCapture("appt-1", { notes: "x" })).toMatchObject({ ok: false, error: expect.stringMatching(/didn't save/) });
  });

  it("the database's refusal comes back in its own words, and stops the retry", async () => {
    db.rpcResult = { data: null, error: { code: "42501", message: "Only the office can fill in the walk-through." } };
    expect(await saveInspectionCapture("appt-1", { photos: [] })).toEqual({
      ok: false,
      refused: true,
      error: "Only the office can fill in the walk-through.",
    });
    expect(db.rpcCalls).toHaveLength(2); // read again once (see the race below), then said
  });

  it("a photo the office put on between his read and his save is merged on a second read, not called his removal", async () => {
    const officeNew = "org-1/appointments/appt-1/3-office-new.jpg";
    db.rpcQueue = [
      {
        // The office's photo lands after his read; the database sees it missing from his list.
        before: () => db.appt.capture.photos.push(officeNew),
        data: null,
        error: { code: "42501", message: "Only the office can take a photo off the walk-through." },
      },
      { data: "appt-1", error: null },
    ];
    expect(await saveInspectionCapture("appt-1", { photos: [PHOTO_OFFICE, PHOTO_LEAD] })).toEqual({ ok: true, id: "appt-1" });
    expect(db.rpcCalls).toHaveLength(2);
    expect(db.rpcCalls[1].args.p_capture.photos).toEqual([PHOTO_OFFICE, officeNew, PHOTO_LEAD]);
  });

  it("a photo he takes is APPENDED to the stored list: one the office took off while his page was open stays off", async () => {
    // His page opened with [office, removed]; the office has since taken `removed` off (its file is
    // still in the folder). He takes a new one: only the new one travels, and the stored list gains it.
    const removed = "org-1/appointments/appt-1/1b-removed.jpg";
    const taken = "org-1/appointments/appt-1/4-taken.jpg";
    expect(await addInspectionPhotos("appt-1", [taken])).toEqual({ ok: true, id: "appt-1" });
    expect(db.updates).toEqual([]);
    expect(db.rpcCalls).toHaveLength(1);
    expect(db.rpcCalls[0].fn).toBe("save_walkthrough_capture");
    expect(db.rpcCalls[0].args.p_capture.photos).toEqual([PHOTO_OFFICE, taken]);
    expect(db.rpcCalls[0].args.p_capture.photos).not.toContain(removed);
    expect(db.rpcCalls[0].args.p_capture.notes).toBe("office note"); // nothing else he didn't send moves
  });

  it("nothing taken is nothing to save", async () => {
    expect(await addInspectionPhotos("appt-1", [])).toEqual({ ok: true, id: "appt-1" });
    expect(db.rpcCalls).toEqual([]);
    expect(db.updates).toEqual([]);
  });

  it("before 0356 is applied: a plain sentence, nothing saved, never PGRST202", async () => {
    db.rpcResult = { data: null, error: { code: "PGRST202", message: "Could not find the function public.save_walkthrough_capture" } };
    const r = await saveInspectionAnswers("appt-1", "sheet-1", { work: "Remodel" });
    expect(r).toMatchObject({ ok: false, refused: true });
    expect(r.error).toMatch(/Crew leads can't save the walk-through until the office finishes an update/);
    expect(r.error).not.toMatch(/PGRST|function/);
  });
});

describe("everyone else is refused before any write", () => {
  const refusedWith = async (words: RegExp) => {
    const c = await saveInspectionCapture("appt-1", { notes: "x" });
    const a = await saveInspectionAnswers("appt-1", "sheet-1", { work: "Remodel" });
    for (const r of [c, a]) expect(r).toMatchObject({ ok: false, refused: true, error: expect.stringMatching(words) });
    expect(db.rpcCalls).toEqual([]);
    expect(db.updates).toEqual([]);
  };

  it("a plain tech on his own visit", async () => {
    db.crewLead = false;
    await refusedWith(/Only the office, or the crew lead on this visit/);
  });

  it("a crew lead on someone else's visit", async () => {
    db.appt.assigned_to = "someone-else";
    await refusedWith(/Only the office, or the crew lead on this visit/);
  });

  it("a crew lead whose seat was deactivated", async () => {
    db.member = { ok: false, error: "This account has been deactivated." };
    await refusedWith(/deactivated/);
  });

  it("a visit that isn't there (another company's id reads as nothing under RLS)", async () => {
    db.appt.org_id = "org-2";
    await refusedWith(/Only the office, or the crew lead on this visit/);
  });
});

describe("the refusal a crew lead may get past is exactly requireStaff's staff-only one", () => {
  it("a signed-out caller is told so, and no crew path runs", async () => {
    const guard = await import("@/lib/staff-guard");
    vi.mocked(guard.requireMember).mockClear();
    vi.mocked(guard.requireStaff).mockResolvedValueOnce({ error: "Not signed in." } as never);
    expect(await saveInspectionCapture("appt-1", { notes: "x" })).toEqual({ ok: false, error: "Not signed in." });
    expect(vi.mocked(guard.requireMember)).not.toHaveBeenCalled();
    expect(db.rpcCalls).toEqual([]);
  });
});
