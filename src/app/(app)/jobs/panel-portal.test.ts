import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * THE PANEL'S CUSTOMER-SIDE DOORS, PINNED (Panel plan, phase 5): the office's switch and Save As
 * Circuit Map. Office only; the switch is one write read back, and a job with no panel is said so;
 * Save As Circuit Map prints the directory with the office's own session, files it as a Plan, and
 * shows it as a Circuit Map REPLACING the newest circuit map there (never a guess from a name).
 * Unscripted database calls throw, so every statement is accounted for.
 */

const state = vi.hoisted(() => ({ client: null as any, guard: null as any, headers: new Map<string, string>() }));
vi.mock("@/lib/staff-guard", () => ({ requireStaff: vi.fn(async () => state.guard) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ headers: vi.fn(async () => ({ get: (k: string) => state.headers.get(k) ?? null })) }));
vi.mock("@/lib/observe", () => ({ reportError: () => {} }));
const share = vi.hoisted(() => ({ filePlan: vi.fn(), showPaper: vi.fn(), takePaperOff: vi.fn() }));
vi.mock("./portal-share-actions", () => share);

import { loadPanelPortal, saveCircuitMap, setPanelOnPortal, undoCircuitMap } from "./panel-portal-actions";

const ORG = "11111111-1111-4111-8111-111111111111";
const JOB = "22222222-2222-4222-8222-222222222222";
const NEW_DOC = "55555555-5555-4555-8555-555555555555";
const OLD_DOC = "66666666-6666-4666-8666-666666666666";
const OLDER_DOC = "77777777-7777-4777-8777-777777777777";

type Call = { table: string; verb: string; payload?: any; eqs: [string, unknown][]; is: [string, unknown][] };

function fakeSupabase(script: Record<string, any[]>, calls: Call[], storage: { uploaded: string[]; removed: string[][] }) {
  const next = (key: string) => {
    const q = script[key];
    if (!q || q.length === 0) throw new Error(`unscripted call: ${key}`);
    return q.shift();
  };
  return {
    storage: {
      from: () => ({
        upload: async (path: string) => {
          storage.uploaded.push(path);
          return next("storage.upload");
        },
        remove: async (paths: string[]) => {
          storage.removed.push(paths);
          return { error: null };
        },
      }),
    },
    from(table: string) {
      const mine: Call = { table, verb: "select", eqs: [], is: [] };
      calls.push(mine);
      const chain: any = {
        insert(payload: any) { mine.verb = "insert"; mine.payload = payload; return chain; },
        update(payload: any) { mine.verb = "update"; mine.payload = payload; return chain; },
        select() { return chain; },
        eq(col: string, val: unknown) { mine.eqs.push([col, val]); return chain; },
        neq() { return chain; },
        is(col: string, val: unknown) { mine.is.push([col, val]); return chain; },
        order() { return chain; },
        limit() { return chain; },
        maybeSingle: () => Promise.resolve(next(`${table}.${mine.verb}`)),
        then(resolve: any, reject: any) {
          try { resolve(next(`${table}.${mine.verb}`)); } catch (e) { reject?.(e); }
        },
      };
      return chain;
    },
  };
}

let calls: Call[];
let store: { uploaded: string[]; removed: string[][] };
function office(script: Record<string, any[]>) {
  calls = [];
  store = { uploaded: [], removed: [] };
  state.client = fakeSupabase(script, calls, store);
  state.guard = { supabase: state.client, userId: "user-1", orgId: ORG };
}
const JOB_ROW = { data: { id: JOB, name: "13897 Herringbone", customers: { name: "Andrew Cohen" } } };

const fetchMock = vi.fn();
beforeEach(() => {
  state.headers = new Map([["host", "app.example.com"], ["x-forwarded-proto", "https"], ["cookie", "sb=office-session"]]);
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  share.filePlan.mockReset();
  share.showPaper.mockReset();
  share.takePaperOff.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

const PDF = new Uint8Array(2048).fill(37);
const pdfResponse = () => new Response(PDF, { status: 200, headers: { "content-type": "application/pdf" } });

describe("Show The Panel On Their Page", () => {
  it("a tech is refused before anything is read", async () => {
    state.guard = { error: "This action is staff-only." };
    expect(await setPanelOnPortal(JOB, true)).toEqual({ ok: false, error: "Only the office can do that." });
    expect(await saveCircuitMap(JOB)).toEqual({ ok: false, error: "Only the office can do that." });
    expect(await loadPanelPortal(JOB)).toEqual({ ok: false, error: "Only the office can do that." });
  });

  it("turns every live panel on the job on, in this org, and reads it back", async () => {
    office({
      "jobs.select": [JOB_ROW],
      "job_panels.update": [{ data: [{ id: "p1", name: "Main Panel", shown_on_portal: true }, { id: "p2", name: "Garage Sub", shown_on_portal: true }], error: null }],
    });
    const r = await setPanelOnPortal(JOB, true);
    expect(r).toEqual({ ok: true, panels: [{ id: "p1", name: "Main Panel", shown: true }, { id: "p2", name: "Garage Sub", shown: true }] });
    const up = calls.find((c) => c.verb === "update")!;
    expect(up.payload).toEqual({ shown_on_portal: true });
    expect(up.eqs).toEqual(expect.arrayContaining([["job_id", JOB], ["org_id", ORG]]));
    expect(up.is).toEqual([["removed_at", null]]);
  });

  it("no panel on the job: said so, never a silent 'on'", async () => {
    office({ "jobs.select": [JOB_ROW], "job_panels.update": [{ data: [], error: null }] });
    expect(await setPanelOnPortal(JOB, true)).toEqual({ ok: false, error: "This job has no panel yet. Add it on the Panel tab first." });
  });

  it("a write the database didn't take (it came back still off) is a failure, not a save", async () => {
    office({ "jobs.select": [JOB_ROW], "job_panels.update": [{ data: [{ id: "p1", name: "Main Panel", shown_on_portal: false }], error: null }] });
    const r = await setPanelOnPortal(JOB, true);
    expect(r.ok).toBe(false);
  });

  it("another org's job is not in your book", async () => {
    office({ "jobs.select": [{ data: null }] });
    expect(await setPanelOnPortal(JOB, true)).toEqual({ ok: false, error: "That job isn't in your book." });
  });
});

describe("the Customer Page tab's preview", () => {
  it("reads only the directory's columns and hands back exactly the customer's shape", async () => {
    office({
      "jobs.select": [JOB_ROW],
      "job_panels.select": [{ data: [{ id: "p1", name: "Main Panel", brand: "Siemens", main_amps: 125, spaces: 32, numbering: "top_down", dead_spaces: [], shown_on_portal: false }], error: null }],
      "job_circuits.select": [
        {
          data: [{ id: "c1", panel_id: "p1", room: "Kitchen", description: "Kitchen And Living", panel_label: "Entry Lights", amps: 15, poles: 1, kind: null, space: 7, half: null, work: "reused", state: "kept", removed_at: null, sort_order: 1 }],
          error: null,
        },
      ],
      "job_shared_documents.select": [{ data: [], error: null }],
    });
    const r = await loadPanelPortal(JOB);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.panels).toEqual([{ id: "p1", name: "Main Panel", shown: false }]);
    expect(r.preview[0].circuits).toEqual([{ space: 7, half: null, poles: 1, amps: 15, kind: null, room: "Kitchen", label: "Entry Lights", feeds: "Kitchen And Living", isNew: false }]);
    expect(r.circuitMap).toBeNull();
    // Kept circuits only.
    expect(calls.find((c) => c.table === "job_circuits")!.eqs).toEqual(expect.arrayContaining([["state", "kept"]]));
  });
});

describe("Save As Circuit Map", () => {
  const ready = (extra: Record<string, any[]> = {}) => ({
    "jobs.select": [JOB_ROW],
    "job_circuits.select": [{ count: 22, error: null }],
    "organizations.select": [{ data: { settings: { timezone: "America/Los_Angeles" } } }],
    "storage.upload": [{ error: null }],
    ...extra,
  });

  it("prints the directory with the office's session, files it as a Plan, and shows it as a Circuit Map replacing the newest one", async () => {
    office(
      ready({
        "job_shared_documents.select": [
          {
            data: [
              // A chain: OLD replaced OLDER; OLD is the newest on the page.
              { document_id: OLDER_DOC, title: "Circuit Map (Plan Scans)", replaces_document_id: null, shared_at: "2026-09-01T00:00:00Z" },
              { document_id: OLD_DOC, title: "Final Circuit Map", replaces_document_id: OLDER_DOC, shared_at: "2026-09-25T07:00:00Z" },
            ],
            error: null,
          },
        ],
      }),
    );
    fetchMock.mockResolvedValueOnce(pdfResponse());
    share.filePlan.mockResolvedValueOnce({ ok: true, paper: { id: NEW_DOC } });
    share.showPaper.mockResolvedValueOnce({ ok: true, row: { document_id: NEW_DOC, title: "Circuit Map", kind: "circuit_map", replaces_document_id: OLD_DOC } });

    const r = await saveCircuitMap(JOB);
    expect(r).toMatchObject({ ok: true, documentId: NEW_DOC, title: "Circuit Map", replaced: "Final Circuit Map" });
    if (!r.ok) return;
    expect(r.message).toBe(`Saved as the circuit map on Andrew Cohen's page. It replaces "Final Circuit Map", so Andrew Cohen sees only the new one.`);

    // The same print page as Print Panel Directory, through the PDF engine, as the office.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://app.example.com/api/pdf/panel/${JOB}?m=0.5`);
    expect(init.headers).toEqual({ cookie: "sb=office-session" });
    // Into the job's own folder, then filed as a Plan through the plans door.
    expect(store.uploaded).toHaveLength(1);
    expect(store.uploaded[0]).toMatch(new RegExp(`^${ORG}/${JOB}/\\d+-Circuit_Map\\.pdf$`));
    expect(share.filePlan).toHaveBeenCalledWith(JOB, { path: store.uploaded[0], name: expect.stringMatching(/^Circuit Map .+\.pdf$/), sizeBytes: PDF.length });
    // The kind is this door's word; it replaces the newest map (not the one already replaced).
    expect(share.showPaper).toHaveBeenCalledWith(NEW_DOC, { kind: "circuit_map", title: "Circuit Map", replaces: OLD_DOC });
    expect(store.removed).toEqual([]);
  });

  it("the first circuit map on the page replaces nothing", async () => {
    office(ready({ "job_shared_documents.select": [{ data: [], error: null }] }));
    fetchMock.mockResolvedValueOnce(pdfResponse());
    share.filePlan.mockResolvedValueOnce({ ok: true, paper: { id: NEW_DOC } });
    share.showPaper.mockResolvedValueOnce({ ok: true, row: { document_id: NEW_DOC, title: "Circuit Map" } });
    const r = await saveCircuitMap(JOB);
    expect(r).toMatchObject({ ok: true, replaced: null, message: "Saved as the circuit map on Andrew Cohen's page, under Plans And Drawings." });
    expect(share.showPaper).toHaveBeenCalledWith(NEW_DOC, { kind: "circuit_map", title: "Circuit Map" });
  });

  it("no kept circuits: nothing to print, said before anything is rendered", async () => {
    office({ "jobs.select": [JOB_ROW], "job_circuits.select": [{ count: 0, error: null }] });
    expect(await saveCircuitMap(JOB)).toEqual({ ok: false, error: "There are no kept circuits on this job yet, so there is no map to save." });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("the print fails: its reason is said, nothing is uploaded or filed", async () => {
    office({ "jobs.select": [JOB_ROW], "job_circuits.select": [{ count: 22, error: null }] });
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "Busy rendering — try again in a moment." }), { status: 429, headers: { "content-type": "application/json" } }));
    expect(await saveCircuitMap(JOB)).toEqual({ ok: false, error: "The directory couldn't be printed: Busy rendering — try again in a moment." });
    expect(store.uploaded).toEqual([]);
    expect(share.filePlan).not.toHaveBeenCalled();
  });

  it("filing refused: the uploaded file is taken back out, never orphaned", async () => {
    office(ready());
    fetchMock.mockResolvedValueOnce(pdfResponse());
    share.filePlan.mockResolvedValueOnce({ ok: false, error: "It uploaded but wasn't filed on the job. Try again." });
    expect(await saveCircuitMap(JOB)).toEqual({ ok: false, error: "It uploaded but wasn't filed on the job. Try again." });
    expect(store.removed).toEqual([[store.uploaded[0]]]);
    expect(share.showPaper).not.toHaveBeenCalled();
  });

  it("filed but not shown: says it is in the job's Plans and why it isn't on their page", async () => {
    office(ready({ "job_shared_documents.select": [{ data: [], error: null }] }));
    fetchMock.mockResolvedValueOnce(pdfResponse());
    share.filePlan.mockResolvedValueOnce({ ok: true, paper: { id: NEW_DOC } });
    share.showPaper.mockResolvedValueOnce({ ok: false, error: "Only the office decides what the customer sees." });
    expect(await saveCircuitMap(JOB)).toEqual({
      ok: false,
      documentId: NEW_DOC,
      error: "Saved in the job's Plans, but it didn't go on Andrew Cohen's page: Only the office decides what the customer sees.",
    });
  });

  it("Undo takes it off their page; the older map shows again", async () => {
    share.takePaperOff.mockResolvedValueOnce({ ok: true, row: { document_id: NEW_DOC, replaces_document_id: OLD_DOC } });
    expect(await undoCircuitMap(NEW_DOC)).toEqual({ ok: true, message: "Taken off their page. The older circuit map shows again. The file stays in the job's Plans." });
    expect(share.takePaperOff).toHaveBeenCalledWith(NEW_DOC);
  });
});
