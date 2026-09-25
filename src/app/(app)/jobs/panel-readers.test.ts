import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * THE READERS' DOORS, PINNED (Panel plan, phase 4). Read The Panel Photo is the crew's and the
 * office's, three reads per job per day; Read Circuits From The Plans is the office's; both only
 * ever write SUGGESTIONS, and a label check only ever changes the circuit it names while that
 * circuit still says what the reader saw. The model is a stub (never a paid call in a test), and
 * every database statement is scripted: an unscripted one throws, so each test accounts for all of
 * them.
 */

const s = vi.hoisted(() => ({
  client: null as any,
  guard: null as any,
  spent: false,
  capped: false,
  model: null as any,
  capKeys: [] as string[],
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => s.client) }));
vi.mock("@/lib/staff-guard", () => ({ requireStaff: vi.fn(async () => s.guard) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("@/lib/observe", () => ({ reportError: () => {} }));
vi.mock("@/lib/notifications", () => ({ officeRecipients: vi.fn(), ringOffice: vi.fn() }));
vi.mock("@/app/(app)/materials/actions", () => ({ addMaterialItem: vi.fn(), deleteMaterialItem: vi.fn(), ensureJobMaterialList: vi.fn() }));
vi.mock("@/lib/anthropic", () => ({ getAnthropic: () => s.model }));
vi.mock("@/lib/ai-cost", () => ({
  aiSpendExceeded: vi.fn(async () => s.spent),
  modelFor: () => "claude-opus-4-8",
  recordAiUsage: vi.fn(async () => {}),
}));
vi.mock("@/lib/rate-limit", () => ({
  rateLimited: vi.fn(async (key: string) => {
    s.capKeys.push(key);
    return s.capped;
  }),
}));

import { applyLabelCheck, keepSuggestions, readPanelPhoto, readPlanCircuits } from "./panel-actions";

const ORG = "11111111-1111-4111-8111-111111111111";
const JOB = "22222222-2222-4222-8222-222222222222";
const PHOTO = "33333333-3333-4333-8333-333333333333";
const PANEL = "44444444-4444-4444-8444-444444444444";
const PLAN = "55555555-5555-4555-8555-555555555555";
const CUST = "66666666-6666-4666-8666-666666666666";
const FRIDGE = "77777777-7777-4777-8777-777777777777";
const CHECK = "88888888-8888-4888-8888-888888888888";

type Call = { table: string; verb: string; payload?: any; filters: string[] };

function fakeSupabase(script: Record<string, any[]>, calls: Call[], storage: { downloads: string[]; blob: Blob | null }) {
  const next = (key: string) => {
    const q = script[key];
    if (!q || q.length === 0) throw new Error(`unscripted call: ${key}`);
    return q.shift();
  };
  return {
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
    storage: {
      from: () => ({
        download: async (path: string) => {
          storage.downloads.push(path);
          return storage.blob ? { data: storage.blob, error: null } : { data: null, error: { message: "gone" } };
        },
      }),
    },
    from(table: string) {
      const mine: Call = { table, verb: "select", filters: [] };
      calls.push(mine);
      const chain: any = {
        insert(payload: any) { mine.verb = "insert"; mine.payload = payload; return chain; },
        update(payload: any) { mine.verb = "update"; mine.payload = payload; return chain; },
        select() { return chain; },
        eq(c: string, v: unknown) { mine.filters.push(`eq:${c}:${v}`); return chain; },
        is(c: string, v: unknown) { mine.filters.push(`is:${c}:${v}`); return chain; },
        not(c: string, o: string, v: unknown) { mine.filters.push(`not:${c}:${o}:${v}`); return chain; },
        in(c: string, v: unknown[]) { mine.filters.push(`in:${c}:${v.join(",")}`); return chain; },
        or(e: string) { mine.filters.push(`or:${e}`); return chain; },
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
let storage: { downloads: string[]; blob: Blob | null };
function as(role: "tech" | "office", script: Record<string, any[]>, blob: Blob | null = new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: "image/jpeg" })) {
  calls = [];
  storage = { downloads: [], blob };
  const me = { data: { role, org_id: ORG, active: true, full_name: role === "tech" ? "Brian" : "Erik" }, error: null };
  s.client = fakeSupabase({ ...script, "profiles.select": [me, ...(script["profiles.select"] ?? [])] }, calls, storage);
  s.guard = role === "tech" ? { error: "This action is staff-only." } : { supabase: s.client, userId: "user-1", orgId: ORG };
}

function stubModel(reply: object) {
  const create = vi.fn(async () => ({ content: [{ type: "text", text: JSON.stringify(reply) }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 10 } }));
  s.model = { messages: { create } };
  return create;
}

const job = { data: { id: JOB, job_number: "J-011", name: "13897 Herringbone", customer_id: CUST }, error: null };
const photo = { data: { id: PHOTO, name: "panel.jpg", file_url: `${ORG}/${JOB}/1727-panel.jpg`, size_bytes: 400_000 }, error: null };
const panelRow = {
  id: PANEL, org_id: ORG, job_id: JOB, name: "Main Panel", brand: "Siemens", bus_amps: 125, main_amps: 125, spaces: 32, numbering: "top_down",
  dead_spaces: [], twin_spaces: [], photo_document_id: PHOTO, notes: null, shown_on_portal: false, removed_at: null,
};
const fridge = {
  id: FRIDGE, org_id: ORG, job_id: JOB, panel_id: PANEL, room: "Kitchen", description: "Fridge", panel_label: null, amps: 20, poles: 1, kind: null,
  space: 12, half: null, work: "reused", progress: "planned", state: "kept", source: "hand", source_row: null, removed_at: null, sort_order: 4,
};

beforeEach(() => {
  s.spent = false;
  s.capped = false;
  s.capKeys = [];
  s.model = null;
});

describe("readPanelPhoto (the crew and the office)", () => {
  it("a tech reads the panel photo: new circuits come in as suggestions, the fridge as a label check, nothing kept is touched", async () => {
    const create = stubModel({
      panel: { brand: "Siemens", main_amps: 125, spaces: 40, no_stab_spaces: [] },
      circuits: [
        { space: 1, label: "Garage", amps: 20, poles: 1 },
        { space: 12, label: "Mini Fridge", amps: 20, poles: 1 },
      ],
      unreadable: ["Space 9's label is torn off"],
    });
    as("tech", {
      "jobs.select": [job],
      "documents.select": [photo],
      "job_panels.select": [{ data: panelRow, error: null }],
      "job_circuits.select": [{ data: [fridge], error: null }, { data: { sort_order: 4 }, error: null }],
      "job_circuits.insert": [
        {
          data: [
            { id: "n1", state: "suggested", source: "photo", panel_label: "Garage" },
            { id: "n2", state: "suggested", source: "photo", source_row: { flag_for: FRIDGE } },
          ],
          error: null,
        },
      ],
    });
    const r = await readPanelPhoto(JOB, PHOTO, PANEL);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(create).toHaveBeenCalledTimes(1);
    expect(storage.downloads).toEqual([`${ORG}/${JOB}/1727-panel.jpg`]);
    expect(s.capKeys).toEqual([`panel-photo:${JOB}`]);
    const ins = calls.find((c) => c.verb === "insert")!;
    expect(ins.table).toBe("job_circuits");
    expect(ins.payload).toHaveLength(2);
    for (const p of ins.payload) {
      expect(p).toMatchObject({ job_id: JOB, panel_id: PANEL, source: "photo", source_document_id: PHOTO, state: "suggested" });
    }
    expect(ins.payload[0]).toMatchObject({ panel_label: "Garage", space: 1, work: "existing", sort_order: 5 });
    expect(ins.payload[1].source_row).toMatchObject({ flag_for: FRIDGE, check: "Panel Says Mini Fridge, Your List Says Fridge." });
    // Nothing was written over the kept fridge: no update at all.
    expect(calls.some((c) => c.verb === "update")).toBe(false);
    expect(r.message).toBe("Read 2 circuits off the photo: 1 New Suggestion, 1 Label Check. Nothing counts until you keep it.");
    expect(r.notes).toEqual(["Space 9's label is torn off"]);
    expect(r.header.map((h) => h.words)).toEqual(["Spaces: 40 (Yours Says 32)"]);
  });

  it("the fourth read of the day is refused in plain words, AFTER the photo is found and BEFORE the model", async () => {
    const create = stubModel({ circuits: [] });
    s.capped = true;
    as("tech", { "jobs.select": [job], "documents.select": [photo], "job_panels.select": [{ data: panelRow, error: null }] });
    const r = await readPanelPhoto(JOB, PHOTO, PANEL);
    expect(r).toEqual({ ok: false, error: "The panel photo has been read 3 times on this job today. The next read opens tomorrow; add the rest by hand below." });
    expect(create).not.toHaveBeenCalled();
  });

  it("a used-up AI budget is said, and neither the cap nor the model is touched", async () => {
    const create = stubModel({ circuits: [] });
    s.spent = true;
    as("office", { "jobs.select": [job], "documents.select": [photo], "job_panels.select": [{ data: panelRow, error: null }] });
    const r = await readPanelPhoto(JOB, PHOTO, PANEL);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/AI budget is used up/);
    expect(s.capKeys).toEqual([]);
    expect(create).not.toHaveBeenCalled();
  });

  it("a paper that isn't one of this job's Photos is refused before anything is downloaded (and uses no read)", async () => {
    const create = stubModel({ circuits: [] });
    as("tech", { "jobs.select": [job], "documents.select": [{ data: null, error: null }] });
    const r = await readPanelPhoto(JOB, PHOTO, PANEL);
    expect(r).toEqual({ ok: false, error: "Pick the photo from this job's Photos." });
    const doc = calls.find((c) => c.table === "documents")!;
    expect(doc.filters).toEqual(expect.arrayContaining([`eq:job_id:${JOB}`, `eq:org_id:${ORG}`, "eq:category:Photo"]));
    expect(storage.downloads).toEqual([]);
    expect(s.capKeys).toEqual([]);
    expect(create).not.toHaveBeenCalled();
  });

  it("a HEIC photo is said before the cap is spent", async () => {
    stubModel({ circuits: [] });
    as("tech", { "jobs.select": [job], "documents.select": [{ data: { ...photo.data, name: "IMG_1.HEIC", file_url: `${ORG}/${JOB}/1-IMG_1.HEIC` }, error: null }] });
    const r = await readPanelPhoto(JOB, PHOTO, PANEL);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/JPG, PNG, WebP or GIF/);
    expect(s.capKeys).toEqual([]);
  });
});

describe("readPlanCircuits (the office only)", () => {
  it("a tech is refused before anything is read", async () => {
    const create = stubModel({ circuits: [] });
    as("tech", {});
    const r = await readPlanCircuits(JOB, PLAN);
    expect(r).toEqual({ ok: false, error: "Only the office can do that." });
    expect(calls).toEqual([]);
    expect(create).not.toHaveBeenCalled();
  });

  it("a plan on another job is refused (this job's, or its customer's with no job, only)", async () => {
    stubModel({ circuits: [] });
    as("office", {
      "jobs.select": [job],
      "documents.select": [{ data: { id: PLAN, name: "plans.pdf", file_url: `${ORG}/x/plans.pdf`, job_id: "99999999-9999-4999-8999-999999999999", customer_id: CUST, category: "Plan" }, error: null }],
    });
    const r = await readPlanCircuits(JOB, PLAN);
    expect(r).toEqual({ ok: false, error: "Pick one of this job's plans." });
    expect(storage.downloads).toEqual([]);
  });

  it("the customer's plans (kept by the estimator's Upload Plans) are read into suggestions from the plans, the dense sheet named", async () => {
    stubModel({
      sheets_read: ["E-1"],
      not_counted: [{ sheet: "MPE-1", why: "too dense" }],
      circuits: [{ sheet: "E-1", ckt: "14", description: "Bath floor heat", breaker: "2P 20A" }],
    });
    as(
      "office",
      {
        "jobs.select": [job],
        "documents.select": [{ data: { id: PLAN, name: "Herringbone.pdf", file_url: `${ORG}/customers/${CUST}/1-Herringbone.pdf`, job_id: null, customer_id: CUST, category: "Plan" }, error: null }],
        "job_circuits.select": [{ data: [], error: null }, { data: null, error: null }],
        "job_panels.select": [{ data: [{ id: PANEL }], error: null }],
        "job_circuits.insert": [{ data: [{ id: "p1" }], error: null }],
      },
      new Blob([new Uint8Array([0x25, 0x50, 0x44, 0x46])], { type: "application/pdf" }),
    );
    const r = await readPlanCircuits(JOB, PLAN);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(s.capKeys).toEqual([`panel-plans:${JOB}`]);
    const ins = calls.find((c) => c.verb === "insert")!;
    expect(ins.payload[0]).toMatchObject({ source: "plan", source_document_id: PLAN, state: "suggested", description: "Bath Floor Heat", amps: 20, poles: 2, space: null, panel_id: PANEL });
    expect(ins.payload[0].source_row).toMatchObject({ sheet: "E-1", ckt: "14", document_name: "Herringbone.pdf" });
    expect(r.notes).toEqual(["MPE-1 Was Too Dense To Count."]);
    expect(r.message).toMatch(/^Read 1 circuit off Herringbone\.pdf: 1 New Suggestion\. Nothing counts until you keep it\. Sheets read: E-1\.$/);
  });
});

describe("label checks", () => {
  const check = {
    ...fridge,
    id: CHECK,
    space: null,
    state: "suggested",
    source: "photo",
    panel_label: "Mini Fridge",
    source_row: { key: "photo-flag:x", flag_for: FRIDGE, check: "Panel Says Mini Fridge, Your List Says Fridge.", use: { panel_label: "Mini Fridge" }, was: { panel_label: null } },
  };

  it("Keep never keeps a label check as a circuit (it would put the fridge on the list twice)", async () => {
    as("office", { "jobs.select": [job], "job_circuits.select": [{ data: [{ id: CHECK, source_row: check.source_row }], error: null }] });
    const r = await keepSuggestions(JOB, [CHECK]);
    expect(r).toEqual({ ok: true, rows: [], skipped: [{ id: CHECK, error: "That one is a label check, not a circuit. Use What It Says, or Not This." }] });
    expect(calls.some((c) => c.verb === "update")).toBe(false);
  });

  it("Use It writes the door label onto the fridge ONLY where it still says what the reader saw, then sets the check aside", async () => {
    as("tech", {
      "job_circuits.select": [{ data: check, error: null }],
      "job_circuits.update": [
        { data: { ...fridge, panel_label: "Mini Fridge" }, error: null },
        { data: { ...check, removed_at: "2026-09-25T10:00:00Z" }, error: null },
      ],
    });
    const r = await applyLabelCheck(CHECK);
    expect(r.ok).toBe(true);
    const [onFridge, onCheck] = calls.filter((c) => c.verb === "update");
    expect(onFridge.payload).toEqual({ panel_label: "Mini Fridge" });
    expect(onFridge.filters).toEqual(expect.arrayContaining([`eq:id:${FRIDGE}`, `eq:org_id:${ORG}`, "is:panel_label:null", `eq:job_id:${JOB}`, "is:removed_at:null"]));
    expect(onCheck.filters).toEqual(expect.arrayContaining([`eq:id:${CHECK}`, "eq:state:suggested", "is:removed_at:null"]));
    expect(onCheck.payload).toHaveProperty("removed_at");
  });

  it("if a crewmate relabelled the fridge first, nothing is overwritten and who did it is said", async () => {
    as("tech", {
      "job_circuits.select": [{ data: check, error: null }, { data: { ...fridge, panel_label: "Beer Fridge", updated_by: "user-2" }, error: null }],
      "job_circuits.update": [{ data: null, error: null }],
      "profiles.select": [{ data: { full_name: "Andrew" }, error: null }],
    });
    const r = await applyLabelCheck(CHECK);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/^Andrew just changed Kitchen Fridge\./);
    expect(calls.filter((c) => c.verb === "update")).toHaveLength(1);
  });
});
