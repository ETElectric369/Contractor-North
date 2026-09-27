import { describe, it, expect, vi, beforeEach } from "vitest";

// THE NORT SWITCH GOVERNS THE SETUP AI (0352). setup:converse (talkSetup), setup:talk (hearSetup)
// and setup:draft (draftMyPlaybook) never asked the switch, so a company that turned Nort off still
// paid a model to phrase its setup. Off: the plain questions, and no model call at all.
const state = vi.hoisted(() => ({
  tables: {} as Record<string, { data: unknown; error: unknown }>,
  modelCalls: 0,
  hearCalls: 0,
  overCeiling: false,
  reply: "",
}));
const QUIET_REPLY = '{"say":"Got it.","fills":[],"needs":[]}';

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("./settings/actions", () => ({ updateOrgSettings: vi.fn(async () => ({ ok: true })) }));
vi.mock("./forms/actions", () => ({ createStarterInspectionSheet: vi.fn(async () => ({ ok: true, id: "f1" })) }));
vi.mock("@/lib/ai-cost", () => ({
  recordAiUsage: vi.fn(async () => undefined),
  aiSpendExceeded: vi.fn(async () => state.overCeiling),
  currentOrgId: vi.fn(async () => "org-1"),
}));
vi.mock("@/lib/anthropic", () => ({
  DEFAULT_MODEL: "test-model",
  getAnthropic: () => ({
    messages: {
      create: vi.fn(async () => {
        state.modelCalls++;
        return { content: [{ type: "text", text: state.reply }], usage: {} };
      }),
    },
  }),
}));
vi.mock("@/lib/playbook/hear-run", () => ({
  runHear: vi.fn(async () => {
    state.hearCalls++;
    return { ok: true, answers: {}, filled: [], note: "" };
  }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "u1" } } }) },
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      for (const m of ["select", "eq", "order", "limit"]) chain[m] = () => chain;
      chain.maybeSingle = async () => state.tables[table] ?? { data: null, error: null };
      return chain;
    },
  })),
}));

import { draftMyPlaybook, hearSetup, talkSetup } from "./setup-actions";

const SHEET = [{ key: "work_type", label: "What kind of work", type: "select", options: ["Repair", "Other"] }];
const org = (nort: boolean) => ({ data: { settings: { features: { nort } } }, error: null });

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = "test-key";
  state.tables = {
    organizations: org(true),
    profiles: { data: { nort_humor: 1, nort_register: "clean" }, error: null },
    forms: { data: { id: "f1", schema: SHEET, playbook: null }, error: null },
  };
  state.modelCalls = 0;
  state.hearCalls = 0;
  state.overCeiling = false;
  state.reply = QUIET_REPLY;
});

describe("Nort off: the plain questions, and no model call", () => {
  beforeEach(() => {
    state.tables.organizations = org(false);
  });

  it("talkSetup says so in plain words and calls nothing", async () => {
    const r = await talkSetup("trade", {}, "I'm a painter");
    expect(r).toEqual({ ok: false, error: expect.stringContaining("type your answers into the boxes") });
    expect(r.ok ? "" : r.error).not.toMatch(/\bI\b/);
    expect(state.modelCalls).toBe(0);
  });

  it("hearSetup never reaches the extraction model", async () => {
    const r = await hearSetup({}, "I'm a painter out of Reno");
    expect(r.ok).toBe(false);
    expect(state.hearCalls).toBe(0);
  });

  it("draftMyPlaybook hands back the company's own questions, undrafted", async () => {
    const r = await draftMyPlaybook();
    expect(r).toMatchObject({ ok: true, formId: "f1", wasDrafted: false });
    expect(r.ok && r.needs.map((n) => n.key)).toEqual(["work_type"]);
    expect(state.modelCalls).toBe(0);
  });

  it("a settings read that fails counts as off: the plain path, never a guess", async () => {
    state.tables.organizations = { data: null, error: { message: "boom" } };
    expect((await talkSetup("trade", {}, "hi")).ok).toBe(false);
    expect((await draftMyPlaybook())).toMatchObject({ ok: true, wasDrafted: false });
    expect(state.modelCalls).toBe(0);
  });
});

describe("Nort on: the same doors as before", () => {
  it("talkSetup replies through the model", async () => {
    const r = await talkSetup("trade", {}, "I'm a painter");
    expect(r.ok).toBe(true);
    expect(state.modelCalls).toBe(1);
  });

  it("hearSetup extracts", async () => {
    expect((await hearSetup({}, "I'm a painter")).ok).toBe(true);
    expect(state.hearCalls).toBe(1);
  });

  it("draftMyPlaybook drafts", async () => {
    expect((await draftMyPlaybook()).ok).toBe(true);
    expect(state.modelCalls).toBe(1);
  });

  it("...except past this month's ceiling, where the draft door now falls back like talkSetup does", async () => {
    state.overCeiling = true;
    expect(await draftMyPlaybook()).toMatchObject({ ok: true, wasDrafted: false });
    expect(state.modelCalls).toBe(0);
  });

  it("no stored switch board reads as on (0352's read rule)", async () => {
    state.tables.organizations = { data: { settings: {} }, error: null };
    expect((await talkSetup("trade", {}, "hi")).ok).toBe(true);
    expect(state.modelCalls).toBe(1);
  });
});

/**
 * THE QUESTION ON SCREEN CAN BE ANSWERED AGAIN. The tour hands in the trade picked at sign-up and
 * promises "say it your way and I'll use your words"; the fill gate refused every answer for a key
 * already on file, so Nort repeated the new words while the old ones were kept and saved.
 */
describe("talkSetup: an answer to the question on screen replaces what was on file", () => {
  const says = (fills: unknown[]) => {
    state.reply = JSON.stringify({ say: "Got it.", fills });
  };

  it("the person's own words for their trade replace the sign-up key's words", async () => {
    says([{ key: "trade", value: "master plumber and gas fitter" }]);
    const r = await talkSetup("trade", { trade: "plumber" }, "master plumber and gas fitter, mostly");
    expect(r).toMatchObject({ ok: true, answers: { trade: "master plumber and gas fitter" }, filled: ["Your trade"] });
  });

  it("a different name replaces the one on the account", async () => {
    says([{ key: "full_name", value: "Sam Ortiz" }]);
    const r = await talkSetup("full_name", { full_name: "Sam" }, "it's Sam Ortiz");
    expect(r.ok && r.answers.full_name).toBe("Sam Ortiz");
  });

  it("chatting without answering keeps what was on file", async () => {
    says([]);
    const r = await talkSetup("trade", { trade: "plumber" }, "hello, that works");
    expect(r.ok && r.answers.trade).toBe("plumber");
  });

  it("an answer that fails the gate puts the old one back (a rate not in their words)", async () => {
    says([{ key: "labor_rate", value: 120, heard: "about a hundred" }]);
    const r = await talkSetup("labor_rate", { labor_rate: 95 }, "about a hundred");
    expect(r.ok && r.answers.labor_rate).toBe(95);
    expect(r.ok && r.filled).toEqual([]);
  });

  it("only the question on screen opens: a filled answer to another question is still never overwritten", async () => {
    says([{ key: "full_name", value: "Somebody Else" }, { key: "trade", value: "roofer" }]);
    const r = await talkSetup("trade", { full_name: "Sam", trade: "plumber" }, "Somebody Else, roofer");
    expect(r.ok && r.answers).toMatchObject({ full_name: "Sam", trade: "roofer" });
  });
});
