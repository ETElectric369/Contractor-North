import { describe, it, expect } from "vitest";
import { fakeDb, type Row } from "@/test/fake-supabase";
import { FIRST_PANEL_NAME, FIRST_PANEL_SPACES, ensurePanelFor, refusedOn, spacesToHold } from "./ensure-panel";

/**
 * PANEL 1 EXISTS THE MOMENT A JOB HAS A CIRCUIT, against a fake client in the live shapes: the job's
 * first live panel or Panel 1 made now, the loose circuits moved onto it, twice-safe, and a move that
 * hits nobody counted as nothing — never an error, never passed off as a move.
 */

const ORG = "org-larkspur";
const JOB = "job-larkspur";

/** What the database fills on a new panel (0333's defaults), so a second read finds it live. */
const panelDefaults = (table: string, rows: Row[]) => {
  if (table === "job_panels") for (const r of rows) Object.assign(r, { removed_at: null, dead_spaces: [], twin_spaces: [], created_at: "2026-10-30T12:00:00Z", ...r });
  return undefined;
};

let seq = 0;
const circuit = (over: Row = {}): Row => ({
  id: `circuit-${++seq}`,
  org_id: ORG,
  job_id: JOB,
  panel_id: null,
  space: null,
  half: null,
  poles: 1,
  state: "kept",
  removed_at: null,
  ...over,
});
const panel = (over: Row = {}): Row => ({
  id: `panel-${++seq}`,
  org_id: ORG,
  job_id: JOB,
  name: "Main Panel",
  spaces: 24,
  numbering: "top_down",
  dead_spaces: [],
  twin_spaces: [],
  removed_at: null,
  created_at: "2026-10-01T00:00:00Z",
  ...over,
});

describe("ensurePanelFor", () => {
  it("makes Panel 1 once (24 spaces, top down), moves the loose circuits onto it, and the second call writes nothing", async () => {
    const loose = [circuit({ space: 3 }), circuit({ state: "suggested" }), circuit({ space: 5, half: "A" })];
    const db = fakeDb({ job_panels: [], job_circuits: loose }, { onInsert: panelDefaults });

    const first = await ensurePanelFor(db.sb, { orgId: ORG, jobId: JOB });
    expect(first.created).toBe(true);
    expect(first.adopted).toBe(3);
    expect(first.left).toBe(0);
    expect(db.inserted.job_panels).toHaveLength(1);
    expect(db.inserted.job_panels[0]).toMatchObject({ org_id: ORG, job_id: JOB, name: FIRST_PANEL_NAME, spaces: FIRST_PANEL_SPACES, numbering: "top_down" });
    expect(first.panel.name).toBe("Panel 1");
    expect(db.tables.job_circuits.every((c) => c.panel_id === first.panelId)).toBe(true);
    // WHICH ones moved, for the tab to set their panel too, and the job's live panels (one now).
    expect([...first.adoptedIds].sort()).toEqual(loose.map((c) => c.id).sort());
    expect(first.livePanels).toBe(1);

    const second = await ensurePanelFor(db.sb, { orgId: ORG, jobId: JOB });
    expect(second).toMatchObject({ panelId: first.panelId, created: false, adopted: 0, adoptedIds: [], left: 0 });
    expect(db.inserted.job_panels).toHaveLength(1);
  });

  it("finds the job's first live panel and never makes another; a taken-off panel doesn't count", async () => {
    const live = panel({ name: "Main Panel" });
    const db = fakeDb({
      job_panels: [panel({ removed_at: "2026-10-02T00:00:00Z" }), live, panel({ job_id: "another-job" })],
      job_circuits: [circuit({ space: 7 })],
    });
    const r = await ensurePanelFor(db.sb, { orgId: ORG, jobId: JOB });
    expect(r).toMatchObject({ panelId: live.id, created: false, adopted: 1, left: 0 });
    expect(db.inserted.job_panels).toBeUndefined();
  });

  it("sizes a new panel to hold a circuit already past space 24 (a 2-pole on 29 runs to 31: 32 spaces)", async () => {
    const db = fakeDb({ job_panels: [], job_circuits: [circuit({ space: 29, poles: 2 }), circuit({ space: 40, removed_at: "2026-10-03T00:00:00Z" })] }, { onInsert: panelDefaults });
    const r = await ensurePanelFor(db.sb, { orgId: ORG, jobId: JOB });
    expect(db.inserted.job_panels[0].spaces).toBe(32);
    expect(r.adopted).toBe(2); // the taken-off one moves too (Undo puts it back on the panel)…
    expect(r.left).toBe(0); // …and is never counted as anybody's to place
    expect(spacesToHold([])).toBe(24);
    expect(spacesToHold([{ space: 83, half: null, poles: 2, removed_at: null }])).toBe(84);
  });

  it("leaves a kept circuit the panel would refuse (No Stab, past the end) where it is, and says how many", async () => {
    const p = panel({ spaces: 24, dead_spaces: [9] });
    const db = fakeDb({
      job_panels: [p],
      job_circuits: [
        circuit({ space: 9 }), // No Stab
        circuit({ space: 23, poles: 2 }), // runs to 25, past the end
        circuit({ space: 9, state: "suggested" }), // a suggestion moves: the guard checks it when it is kept
        circuit({ space: 11 }),
      ],
    });
    const r = await ensurePanelFor(db.sb, { orgId: ORG, jobId: JOB });
    expect(r).toMatchObject({ created: false, adopted: 2, left: 2 });
    expect(db.tables.job_circuits.filter((c) => c.panel_id === p.id).map((c) => c.space)).toEqual([9, 11]);
    expect(refusedOn(p as never, { id: "x", space: 9, half: null, poles: 1, state: "kept", removed_at: null })).toBe(true);
    expect(refusedOn(p as never, { id: "x", space: 9, half: null, poles: 1, state: "suggested", removed_at: null })).toBe(false);
  });

  it("with several panels, moves nothing: which panel a loose circuit is on is a person's pick", async () => {
    const first = panel({ name: "Main Panel" });
    const db = fakeDb({ job_panels: [first, panel({ name: "Sub Panel", created_at: "2026-10-05T00:00:00Z" })], job_circuits: [circuit(), circuit({ removed_at: "2026-10-06T00:00:00Z" })] });
    const r = await ensurePanelFor(db.sb, { orgId: ORG, jobId: JOB });
    expect(r).toMatchObject({ panelId: first.id, created: false, adopted: 0, left: 1 });
    expect(db.tables.job_circuits.every((c) => c.panel_id === null)).toBe(true);
  });

  it("a move that hits nobody (a crewmate placed them first) is zero moved, not an error", async () => {
    const p = panel();
    const db = fakeDb(
      { job_panels: [p], job_circuits: [circuit(), circuit()] },
      {
        onUpdate: (table) => {
          // Between the read and the write, someone else put both on another panel.
          if (table === "job_circuits") for (const c of db.tables.job_circuits) c.panel_id = "someone-elses-panel";
          return undefined;
        },
      },
    );
    const r = await ensurePanelFor(db.sb, { orgId: ORG, jobId: JOB });
    expect(r).toMatchObject({ panelId: p.id, adopted: 0, left: 2 });
  });

  it("when the database refuses the batch, each is tried alone and only the refused one stays", async () => {
    const p = panel();
    let calls = 0;
    const db = fakeDb(
      { job_panels: [p], job_circuits: [circuit(), circuit(), circuit()] },
      // The batch (call 1) is refused, then the second circuit on its own (call 3).
      { onUpdate: () => (++calls === 1 || calls === 3 ? { code: "23514", message: "Space 9 has no stab (No Stab). Pick another space." } : undefined) },
    );
    const r = await ensurePanelFor(db.sb, { orgId: ORG, jobId: JOB });
    expect(calls).toBe(4);
    expect(r).toMatchObject({ adopted: 2, left: 1 });
  });

  it("two calls racing to make Panel 1: the one that loses the unique name reads the winner's panel back", async () => {
    const winner = panel({ name: "Panel 1" });
    const db = fakeDb(
      { job_panels: [], job_circuits: [circuit()] },
      {
        onInsert: (table) => {
          if (table !== "job_panels") return undefined;
          db.tables.job_panels.push(winner);
          return { code: "23505", message: 'duplicate key value violates unique constraint "job_panels_one_name_per_job"' };
        },
      },
    );
    const r = await ensurePanelFor(db.sb, { orgId: ORG, jobId: JOB });
    expect(r).toMatchObject({ panelId: winner.id, created: false, adopted: 1, left: 0 });
  });

  it("a read or a refused insert throws in words, with the database's answer as its cause", async () => {
    const boom = { message: "permission denied for table job_panels", code: "42501" };
    const failing = {
      from: () => {
        const q: Record<string, unknown> = {};
        for (const k of ["select", "eq", "is", "order", "limit", "in", "update", "insert"]) q[k] = () => q;
        q.maybeSingle = () => q;
        q.then = (resolve: (v: unknown) => void) => resolve({ data: null, error: boom });
        return q;
      },
    };
    await expect(ensurePanelFor(failing as never, { orgId: ORG, jobId: JOB })).rejects.toThrow("The job's panel couldn't be read.");

    const refused = fakeDb({ job_panels: [], job_circuits: [] }, { onInsert: () => ({ code: "42501", message: "That job isn't in your book." }) });
    const err = await ensurePanelFor(refused.sb, { orgId: ORG, jobId: JOB }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("Panel 1 couldn't be added to the job.");
    expect((err as Error & { cause?: unknown }).cause).toMatchObject({ code: "42501" });
  });
});
