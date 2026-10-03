import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * THE INSPECTION'S TWO WRITERS, AND WHO GETS WHICH (0356; Erik, 2026-09-26: "crew leader yes tech
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
 * half of the rule is inspection-crew-lead.integration.test.ts.
 *
 * AFTER 0366 (LEAK-0227) the inspection's reads go through the two views, as the database does:
 * appointment_answers (the office reads the answers as stored, anyone else without a price) and
 * form_playbooks (a crew lead can no longer read a playbook sheet from forms itself). `views: false`
 * is a database before 0366: the views answer PGRST205 and the table is read as before. `viewError`
 * is any other failure of a view read, which is an error, never an empty row.
 */
const db = vi.hoisted(() => ({
  views: true,
  viewError: null as null | { code: string; message: string },
  /** Every relation read, in order: which reads went through a view. */
  reads: [] as string[],
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
import { answersWithoutPrices } from "@/lib/inspection/inspection-access";

const MISSING_VIEW = (name: string) => ({ code: "PGRST205", message: `Could not find the table 'public.${name}' in the schema cache` });

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
        if (q.op === "select") db.reads.push(table);
        if (table === "profiles") return { data: q.op === "select" ? { crew_lead: db.crewLead, org_id: "org-1" } : null, error: null };
        // THE VIEWS (0366), as the database answers them.
        if (table === "appointment_answers" || table === "form_playbooks") {
          if (!db.views) return { data: null, error: MISSING_VIEW(table) };
          if (db.viewError) return { data: null, error: db.viewError };
          if (table === "form_playbooks") return { data: matches(db.form) ? db.form : null, error: null };
          const row = matches(db.appt) ? { ...db.appt } : null;
          return { data: row && !db.staff ? { ...row, inspection_answers: answersWithoutPrices(row.inspection_answers) } : row, error: null };
        }
        // After 0366 a non-office reader reads a playbook sheet from forms only through the view.
        if (table === "forms") return { data: matches(db.form) && (db.staff || !db.views) ? db.form : null, error: null };
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
  db.views = true;
  db.viewError = null;
  db.reads = [];
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

  /**
   * THE DATABASE'S REFUSAL COMES BACK IN ITS OWN WORDS — WITH THE VISIT'S NAME PUT RIGHT.
   *
   * The mock says what save_walkthrough_capture ACTUALLY raises (0356 line 222, still "walk-through":
   * the migration is applied and is not edited for a word). A mock that already said "inspection" is
   * how this gap hid — it tested a sentence the real function never speaks, so the unit project
   * stayed green while a crew lead read the old word under his Save. inspectionRefusal re-says it
   * (lib/inspection/db-refusal), and nothing else about the sentence moves.
   */
  it("the database's refusal comes back in its own words, with the visit's name put right, and stops the retry", async () => {
    db.rpcResult = { data: null, error: { code: "42501", message: "Only the office, or the crew lead on this visit, can fill in the walk-through." } };
    expect(await saveInspectionCapture("appt-1", { photos: [] })).toEqual({
      ok: false,
      refused: true,
      error: "Only the office, or the crew lead on this visit, can fill in the inspection.",
    });
    expect(db.rpcCalls).toHaveLength(2); // read again once (see the race below), then said
  });

  it("a shape or size the database turns down is said in the one word too, and it is not a refusal", async () => {
    // 22023, so it goes the dbError way out of inspectionRefusal rather than the 42501 way: raw text
    // (db-error.ts hands an unrecognised sentence back on purpose), re-said all the same.
    db.rpcResult = { data: null, error: { code: "22023", message: "The walk-through's notes are too long to save in one go." } };
    expect(await saveInspectionCapture("appt-1", { notes: "x" })).toEqual({
      ok: false,
      error: "The inspection's notes are too long to save in one go.",
    });
  });

  it("a photo the office put on between his read and his save is merged on a second read, not called his removal", async () => {
    const officeNew = "org-1/appointments/appt-1/3-office-new.jpg";
    db.rpcQueue = [
      {
        // The office's photo lands after his read; the database sees it missing from his list.
        // 0356 line 255's own sentence, which still says the old word (see the refusal test above).
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
    expect(r.error).toMatch(/Crew leads can't save the inspection until the office finishes an update/);
    expect(r.error).not.toMatch(/PGRST|function/);
  });
});

describe("the inspection's reads go through the views (0366, LEAK-0227)", () => {
  it("the office's save reads the sheet and the stored answers through the views, prices and all", async () => {
    db.staff = true;
    db.appt.inspection_answers = { work: "Deck", scope: [{ code: "R1", qty: 1, price: 500 }], retired_q: "kept" };
    expect(await saveInspectionAnswers("appt-1", "sheet-1", { work: "Remodel" })).toEqual({ ok: true, id: "appt-1" });
    expect(db.reads).toContain("form_playbooks");
    expect(db.reads).toContain("appointment_answers");
    expect(db.reads).not.toContain("forms");
    // A retired answer rides forward from the stored row (read through the view).
    expect(db.updates[0].inspection_answers).toMatchObject({ work: "Remodel", retired_q: "kept" });
  });

  it("a crew lead's save reads them too, the stored answers without a price, and still saves", async () => {
    db.appt.inspection_answers = { work: "Deck", scope: [{ code: "R1", qty: 1, price: 500 }], retired_q: "kept" };
    expect(await saveInspectionAnswers("appt-1", "sheet-1", { work: "Remodel" })).toEqual({ ok: true, id: "appt-1" });
    // The sheet from the view (forms itself would not hand him a playbook sheet any more).
    expect(db.reads).not.toContain("forms");
    expect(db.reads).toContain("form_playbooks");
    expect(db.reads).toContain("appointment_answers");
    const sent = db.rpcCalls[0].args.p_answers;
    expect(sent.work).toBe("Remodel");
    expect(sent.retired_q).toBe("kept");
    // Nothing he sends back carries the office's price: he never read one.
    expect(JSON.stringify(sent)).not.toContain("price");
  });

  it("before 0366 (no views on the database): the table is read exactly as before", async () => {
    db.views = false;
    expect(await saveInspectionAnswers("appt-1", "sheet-1", { work: "Remodel" })).toEqual({ ok: true, id: "appt-1" });
    expect(db.reads).toEqual(expect.arrayContaining(["form_playbooks", "forms", "appointment_answers", "appointments"]));
    expect(db.rpcCalls[0].args.p_answers.work).toBe("Remodel");
  });

  it("a view read that fails for any other reason is an error said out loud, and nothing is saved", async () => {
    db.staff = true;
    db.viewError = { code: "57014", message: "canceling statement due to statement timeout" };
    const r = await saveInspectionAnswers("appt-1", "sheet-1", { work: "Remodel" });
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
    expect(db.updates).toEqual([]);
    expect(db.rpcCalls).toEqual([]);
    // Never the table behind the view's back: a timeout is not a missing view.
    expect(db.reads).not.toContain("forms");
    expect(db.reads).not.toContain("appointments");
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
