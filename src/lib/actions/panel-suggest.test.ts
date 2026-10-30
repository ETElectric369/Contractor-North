import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * NORT AND THE PANEL (Panel plan, phase 4): Nort FILLS, a person saves.
 *
 *   get_job_panel   Nort reads the job's panel (both the crew and the office: "what's on 7 at
 *                   Honeysuckle"), the door by space, what's waiting to be kept, and the breaker
 *                   count. No price, supplier or ticket number anywhere in it.
 *   panel.suggest   Nort's only write to the circuit list: SUGGESTIONS, source 'nort', which count
 *                   for nothing until a person taps Keep. There is no keep verb for the agent.
 */

const s = vi.hoisted(() => ({ client: null as any }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => s.client), createServiceClient: vi.fn(() => s.client) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { REGISTRY, listActions } from "./registry";
import { AGENT_WRITE_ALLOWED, agentWriteToolsForRole } from "./agent-tools";
import { needsConsent } from "./risk";
import { DATA_TOOLS, STAFF_ONLY_DATA_TOOLS, runDataTool } from "@/lib/assistant-tools";
import { FINAL_MAP, PANEL, PANEL_ID } from "@/lib/panel/__fixtures__/honeysuckle";

const ORG = "11111111-1111-4111-8111-111111111111";
const JOB = "8760a051-b6f8-4a6b-b3a5-6ac7078f9ac1";

type Call = { table: string; verb: string; payload?: any; filters: string[] };
function fakeSupabase(script: Record<string, any[]>, calls: Call[]) {
  const next = (key: string) => {
    const q = script[key];
    if (!q || q.length === 0) throw new Error(`unscripted call: ${key}`);
    return q.shift();
  };
  return {
    rpc: async (fn: string) => next(`rpc.${fn}`),
    from(table: string) {
      const mine: Call = { table, verb: "select", filters: [] };
      calls.push(mine);
      const chain: any = {
        insert(payload: any) { mine.verb = "insert"; mine.payload = payload; return chain; },
        update(payload: any) { mine.verb = "update"; mine.payload = payload; return chain; },
        select() { return chain; },
        eq(c: string, v: unknown) { mine.filters.push(`eq:${c}:${v}`); return chain; },
        is(c: string, v: unknown) { mine.filters.push(`is:${c}:${v}`); return chain; },
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
beforeEach(() => {
  calls = [];
});

describe("panel.suggest: the registry's only panel verb, a suggestion", () => {
  it("is a write any role may run, whitelisted for the agent, tier-1 (no confirm), and there is NO keep verb", () => {
    const def = REGISTRY["panel.suggest"];
    expect(def.effect).toBe("write");
    expect(def.auth).toBe("any");
    expect(AGENT_WRITE_ALLOWED.has("panel.suggest")).toBe(true);
    expect(needsConsent(def, "agent", false)).toBe(false);
    expect(listActions({ group: "panel" }).map((a) => a.name)).toEqual(["panel.suggest"]);
    for (const role of ["tech", "office", "owner"]) {
      expect(agentWriteToolsForRole(role).tools.map((t) => t.name)).toContain("panel__suggest");
    }
    expect(def.description).toMatch(/NEVER say the circuit is added, kept/);
  });

  it("'add a 20 amp for the garage freezer on Honeysuckle' lands as a suggestion from Nort and says a person keeps it", async () => {
    s.client = fakeSupabase(
      {
        "jobs.select": [{ data: { id: JOB, job_number: "J-011", name: "13897 Honeysuckle" }, error: null }],
        "job_circuits.select": [{ data: FINAL_MAP, error: null }, { data: { sort_order: 22 }, error: null }],
        "job_panels.select": [{ data: [{ id: PANEL_ID }], error: null }],
        "job_circuits.insert": [
          {
            data: [{ id: "n1", room: "Garage", description: "Freezer", panel_label: null, amps: 20, poles: 1, kind: null, state: "suggested", source: "nort", source_row: { key: "k" } }],
            error: null,
          },
        ],
      },
      calls,
    );
    const r = await REGISTRY["panel.suggest"].handler(
      REGISTRY["panel.suggest"].input.parse({ job_id: JOB, circuits: [{ room: "garage", description: "freezer", amps: 20 }] }),
      { userId: "u1", orgId: ORG, role: "tech" },
    );
    expect(r.ok).toBe(true);
    const ins = calls.find((c) => c.verb === "insert")!;
    expect(ins.payload).toEqual([
      expect.objectContaining({ job_id: JOB, panel_id: PANEL_ID, room: "Garage", description: "Freezer", amps: 20, poles: 1, state: "suggested", source: "nort", source_document_id: null, sort_order: 23 }),
    ]);
    expect(ins.payload[0].source_row).not.toHaveProperty("quote_number");
    expect(r.recorded).toBe("Suggested on 13897 Honeysuckle: 20A · 1P · Garage Freezer. Nothing counts until someone taps Keep on the job's Panel tab.");
  });

  it("a circuit already on the list is said, not suggested twice (nothing written)", async () => {
    s.client = fakeSupabase(
      {
        "jobs.select": [{ data: { id: JOB, job_number: "J-011", name: "13897 Honeysuckle" }, error: null }],
        "job_circuits.select": [{ data: FINAL_MAP, error: null }],
        "job_panels.select": [{ data: [{ id: PANEL_ID }], error: null }],
      },
      calls,
    );
    const r = await REGISTRY["panel.suggest"].handler(
      REGISTRY["panel.suggest"].input.parse({ job_id: JOB, circuits: [{ room: "Laundry", description: "Dryer", amps: 30, poles: 2 }] }),
      { userId: "u1", orgId: ORG, role: "owner" },
    );
    expect(r).toMatchObject({ ok: true, recorded: "1 is already on the list." });
    expect(calls.some((c) => c.verb === "insert")).toBe(false);
  });

  it("an amps figure that isn't a breaker size is refused in plain words before anything is read", async () => {
    s.client = fakeSupabase({ "jobs.select": [{ data: { id: JOB, job_number: "J-011", name: "13897 Honeysuckle" }, error: null }] }, calls);
    const r = await REGISTRY["panel.suggest"].handler(
      REGISTRY["panel.suggest"].input.parse({ job_id: JOB, circuits: [{ description: "Freezer", amps: 17 }] }),
      { userId: "u1", orgId: ORG, role: "tech" },
    );
    expect(r).toEqual({ ok: false, error: "Circuit 1: 17 amps isn't a breaker size. Pick 15, 20, 30…" });
  });

  it("learns the lines: a tandem 20/20 on 17 is two suggestions, 17A and 17B; a 2-pole 30 on 9 and 11 is one, on 9 with two poles", async () => {
    const back = (id: string, description: string, space: number, half: "A" | "B" | null, poles: number, amps: number) => ({
      id, room: null, description, panel_label: null, amps, poles, kind: null, space, half, state: "suggested", source: "nort", source_row: { key: id },
    });
    s.client = fakeSupabase(
      {
        "jobs.select": [{ data: { id: JOB, job_number: "J-101", name: "Larkspur" }, error: null }],
        "job_circuits.select": [{ data: [], error: null }, { data: null, error: null }],
        "job_panels.select": [{ data: [{ id: PANEL_ID }], error: null }],
        "job_circuits.insert": [
          { data: [back("n1", "Bar", 17, "A", 1, 20), back("n2", "Mini Fridge", 17, "B", 1, 20), back("n3", "Mini Split", 9, null, 2, 30)], error: null },
        ],
      },
      calls,
    );
    const def = REGISTRY["panel.suggest"];
    const r = await def.handler(
      def.input.parse({
        job_id: JOB,
        circuits: [
          { description: "Bar", space: 17, form: "tandem", amps: 20 },
          { description: "Mini Fridge", space: 17, form: "tandem", amps: 20 },
          { description: "Mini Split", spaces: [9, 11], form: "2-pole", amps: 30 },
        ],
      }),
      { userId: "u1", orgId: ORG, role: "tech" },
    );
    expect(r.ok).toBe(true);
    const ins = calls.find((c) => c.verb === "insert")!;
    expect(ins.payload).toEqual([
      expect.objectContaining({ description: "Bar", space: 17, half: "A", poles: 1, amps: 20, state: "suggested", source: "nort", panel_id: PANEL_ID }),
      expect.objectContaining({ description: "Mini Fridge", space: 17, half: "B", poles: 1, amps: 20, state: "suggested", source: "nort" }),
      expect.objectContaining({ description: "Mini Split", space: 9, half: null, poles: 2, amps: 30, state: "suggested", source: "nort" }),
    ]);
    expect(r.recorded).toBe(
      "Suggested on Larkspur: 20A · 1P · Bar on 17A; 20A · 1P · Mini Fridge on 17B; 30A · 2P · Mini Split on 9/11. Nothing counts until someone taps Keep on the job's Panel tab.",
    );
    // Still a suggestion a person keeps: no confirm card, no keep verb (the frozen agent-write set).
    expect(needsConsent(def, "agent", false)).toBe(false);
    expect(listActions({ group: "panel" }).map((a) => a.name)).toEqual(["panel.suggest"]);
  });

  it("a lone tandem with no half comes back as the question to ask, and nothing is read or written", async () => {
    s.client = fakeSupabase({ "jobs.select": [{ data: { id: JOB, job_number: "J-101", name: "Larkspur" }, error: null }] }, calls);
    const def = REGISTRY["panel.suggest"];
    const r = await def.handler(def.input.parse({ job_id: JOB, circuits: [{ description: "Bar", space: 17, form: "tandem", amps: 20 }] }), {
      userId: "u1",
      orgId: ORG,
      role: "owner",
    });
    expect(r).toEqual({ ok: false, error: "Circuit 1: which half of space 17 is it, A (the top) or B (below)?" });
    expect(calls.map((c) => c.table)).toEqual(["jobs"]);
  });

  it("a quad heard on a panel numbered bottom up hangs that panel's way: the centre at 1A, the singles 3A then 1B (model quadCentreHalf)", async () => {
    const back = (id: string, description: string, space: number, half: "A" | "B", poles: number) => ({
      id, room: null, description, panel_label: null, amps: 20, poles, kind: null, space, half, state: "suggested", source: "nort", source_row: { key: id },
    });
    s.client = fakeSupabase(
      {
        "jobs.select": [{ data: { id: JOB, job_number: "J-101", name: "Larkspur" }, error: null }],
        // Read ONCE, before the words are placed (a quad needs the numbering), and used again for the landing.
        "job_panels.select": [{ data: [{ id: PANEL_ID, numbering: "bottom_up" }], error: null }],
        "job_circuits.select": [{ data: [], error: null }, { data: null, error: null }],
        "job_circuits.insert": [{ data: [back("q1", "Garage", 3, "A", 1), back("q2", "Floor Heat", 1, "A", 2), back("q3", "Porch", 1, "B", 1)], error: null }],
      },
      calls,
    );
    const def = REGISTRY["panel.suggest"];
    const r = await def.handler(
      def.input.parse({
        job_id: JOB,
        circuits: [
          { description: "Garage", space: 1, form: "quad", poles: 1, amps: 20 },
          { description: "Floor Heat", space: 1, form: "quad", poles: 2, amps: 20 },
          { description: "Porch", space: 1, form: "quad", poles: 1, amps: 20 },
        ],
      }),
      { userId: "u1", orgId: ORG, role: "tech" },
    );
    expect(r.ok).toBe(true);
    const ins = calls.find((c) => c.verb === "insert")!;
    expect(ins.payload.map((p: any) => [p.description, p.space, p.half, p.poles])).toEqual([
      ["Garage", 3, "A", 1],
      ["Floor Heat", 1, "A", 2],
      ["Porch", 1, "B", 1],
    ]);
    expect(calls.filter((c) => c.table === "job_panels")).toHaveLength(1);
  });

  it("the agent's tool offers the form and the spaces words", () => {
    const tool = agentWriteToolsForRole("tech").tools.find((t) => t.name === "panel__suggest")!;
    const item = (tool.input_schema.properties as any).circuits.items.properties;
    expect(item.form.enum).toEqual(["single", "tandem", "2-pole", "3-pole", "quad"]);
    expect(item.spaces.type).toBe("array");
    expect(item.half.enum).toEqual(["A", "B"]);
    expect(tool.description).toMatch(/TANDEM is two circuits sharing one space/);
  });
});

describe("get_job_panel: Nort reads the panel", () => {
  it("a quad's centre 2-pole kept on 25B reads 25B/27A — the handles it truly holds — never 25B-27B", async () => {
    const centre = { ...FINAL_MAP[0], id: "centre", description: "Floor Heat", poles: 2, amps: 20, space: 25, half: "B" };
    s.client = fakeSupabase(
      {
        "jobs.select": [{ data: { id: JOB, job_number: "J-011", name: "13897 Honeysuckle" }, error: null }],
        "job_panels.select": [{ data: [PANEL], error: null }],
        "job_circuits.select": [{ data: [centre], error: null }],
        "rpc.breakers_bought_for_job": [{ data: [], error: null }],
      },
      calls,
    );
    const out = JSON.parse(await runDataTool("get_job_panel", { job_id: JOB }, s.client));
    expect(out.circuits.find((c: { id: string }) => c.id === "centre").space).toBe("25B/27A");
    expect(JSON.stringify(out)).not.toContain("25B-27B");
  });

  it("is offered to the crew as well as the office (it is not a staff-only tool)", () => {
    expect(DATA_TOOLS.some((t) => t.name === "get_job_panel")).toBe(true);
    expect(STAFF_ONLY_DATA_TOOLS.has("get_job_panel")).toBe(false);
  });

  it("answers what's on 7, what's waiting, and the breaker count, with no price, supplier or ticket anywhere", async () => {
    const placed = FINAL_MAP.map((c, i) => ({ ...c, space: i < 16 ? i + 1 : null }));
    const waiting = { ...FINAL_MAP[0], id: "sug", state: "suggested", source: "photo", description: null, panel_label: "Smokes", amps: null, kind: "afci", space: null, source_row: { key: "k", check: null } };
    s.client = fakeSupabase(
      {
        "jobs.select": [{ data: { id: JOB, job_number: "J-011", name: "13897 Honeysuckle" }, error: null }],
        "job_panels.select": [{ data: [PANEL], error: null }],
        "job_circuits.select": [{ data: [...placed, waiting], error: null }],
        "rpc.breakers_bought_for_job": [{ data: [{ description: "SIEM Q2020", qty: 8 }, { description: "SIEM Q21530CT", qty: 1 }], error: null }],
      },
      calls,
    );
    const out = JSON.parse(await runDataTool("get_job_panel", { job_id: JOB }, s.client));
    expect(out.found).toBe(true);
    expect(out.panels[0].by_space["7"]).toEqual(["Kitchen Fridge (1P 20A)"]);
    // Where each sits in the directory's words (spaceWords): a single "7", a full 2-pole "9/11".
    expect(out.circuits.find((c: { space: string | null }) => c.space === "7")).toBeTruthy();
    expect(out.circuits.every((c: { space: string | null }) => c.space == null || /^\d+[AB]?(\/\d+[AB]?)*$/.test(c.space))).toBe(true);
    expect(out.suggestions_waiting).toEqual([{ id: "sug", circuit: "Smokes", size: "1P ? AFCI", space: null, from: "From The Panel Photo", check: null }]);
    expect(out.breakers.verdict).toBe("Short One 2P 20A (Bath Floor Heat). One 1P 20A Spare.");
    expect(out.breakers.to_order).toEqual(["1 x Q220 2P 20A Breaker"]);
    expect(out.note).toMatch(/until a person taps Keep/);
    const text = JSON.stringify(out);
    expect(text).not.toMatch(/price|cost|\$|supplier|8802|bill_number|amount/i);
  });
});
