import { describe, it, expect, vi, beforeEach } from "vitest";
import { featurePreset } from "@/lib/features";
import { TRADE_PACKAGES } from "@/lib/trade-package";

/**
 * YOUR TRADE & PRICING, the server doors (cn-v1135): setOrgTrade, applyTradeCodes, applyTradeSwitches,
 * startTradeSheet and setEstimatingMode, driven on a recording fake of the person's client. The
 * database decides again on every write (0398 set_org_trade, 0352 set_org_feature, RLS); this pins
 * what the app SAYS and what it SENDS:
 *   - anyone but the owner is refused in words before a read happens — the trade door in its words,
 *     the pricing door in its own;
 *   - the RPC is called once with p_trade, '' for Other, and its answer is read back;
 *   - the label rule: trade_label is cleared only when it reads as a DIFFERENT known trade, and the
 *     answer names the words it cleared (never silently);
 *   - the offers are the registry diff against what the company holds, under either spelling, read
 *     after the trade landed: a failed read is said beside the landed trade, never as a refusal;
 *   - the caches drop on every path after the RPC lands, not only the happy one;
 *   - the switches door flips only the keys that differ; the sheet door never makes a second sheet;
 *   - setEstimatingMode refuses any word but research or catalog and asks the written row back.
 */
type Reply = { data?: unknown; error?: { code?: string; message: string } | null };
const state = vi.hoisted(() => ({
  role: "owner" as string,
  active: true as boolean,
  settings: {} as Record<string, unknown>,
  codes: [] as string[],
  /** The job codes read answers with this error: the offers read throws (S1). */
  codesError: null as null | { message: string },
  sheet: false,
  /** What an UPDATE … .select("id") hands back: [] is a zero-row write. */
  wrote: [{ id: "org-1" }] as { id: string }[],
  rpcReply: ((_fn: string, _args: unknown) => ({ data: null, error: null })) as (fn: string, args: any) => Reply,
  rpcCalls: [] as { fn: string; args: unknown }[],
  updates: [] as { table: string; patch: any; eqs: [string, unknown][]; selected: string[] }[],
  reads: [] as string[],
}));

function builder(table: string) {
  const eqs: [string, unknown][] = [];
  state.reads.push(table);
  const b: any = {
    select: () => b,
    eq: (k: string, v: unknown) => {
      eqs.push([k, v]);
      return b;
    },
    limit: () => b,
    maybeSingle: async () => {
      if (table === "profiles") return { data: { role: state.role, org_id: "org-1", active: state.active }, error: null };
      if (table === "organizations") return { data: { settings: state.settings }, error: null };
      if (table === "forms") return { data: state.sheet ? { id: "sheet-1" } : null, error: null };
      return { data: null, error: null };
    },
    // A read awaited as a list (the job codes).
    then: (resolve: (v: unknown) => void) =>
      resolve(
        table === "job_codes" && state.codesError
          ? { data: null, error: state.codesError }
          : { data: table === "job_codes" ? state.codes.map((code) => ({ code })) : [], error: null },
      ),
    update: (patch: unknown) => {
      const rec = { table, patch, eqs: [] as [string, unknown][], selected: [] as string[] };
      state.updates.push(rec);
      const u: any = {
        eq: (k: string, v: unknown) => {
          rec.eqs.push([k, v]);
          return u;
        },
        select: async (cols: string) => {
          rec.selected.push(cols);
          return { data: state.wrote, error: null };
        },
      };
      return u;
    },
  };
  return b;
}
const client = {
  auth: { getUser: async () => ({ data: { user: { id: "me" } } }) },
  from: (t: string) => builder(t),
  rpc: async (fn: string, args: unknown) => {
    state.rpcCalls.push({ fn, args });
    const r = state.rpcReply(fn, args);
    return { data: r.data ?? null, error: r.error ?? null };
  },
};
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => client), createServiceClient: vi.fn(() => client) }));
const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath: (...a: unknown[]) => revalidatePath(...a), revalidateTag: vi.fn() }));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));
const importPack = vi.fn(async (_key: string) => ({ ok: true, added: 3, skipped: 2 }));
vi.mock("./actions", () => ({ importTradeCodePack: (k: string) => importPack(k) }));
const starter = vi.fn(async () => ({ ok: true, id: "sheet-new" }));
vi.mock("../forms/actions", () => ({ createStarterInspectionSheet: () => starter() }));

const { setOrgTrade, applyTradeCodes, applyTradeSwitches, startTradeSheet, setEstimatingMode } = await import("./features-actions");

const OWNER_WORDS = "Only the owner can change the company's trade.";
const PRICING_WORDS = "Only the owner chooses how the company prices, on the Features page in Settings.";
const NOT_SAVED = "That didn't save. Reload and try again.";
/** 0398's answer for a landed write. */
const landed = (previous: string | null, trade: string | null) => () => ({ data: { previous, trade } });
/** 0352's answer for a landed flip: the key and value asked for. */
const flipped = (_fn: string, args: { p_key: string; p_on: boolean }) => ({ data: { key: args.p_key, on: args.p_on, previous: !args.p_on } });

beforeEach(() => {
  state.role = "owner";
  state.active = true;
  state.settings = { features: featurePreset(""), timeclock_job_codes: false };
  state.codes = [];
  state.codesError = null;
  state.sheet = false;
  state.wrote = [{ id: "org-1" }];
  state.rpcReply = () => ({ data: null });
  state.rpcCalls = [];
  state.updates = [];
  state.reads = [];
  revalidatePath.mockClear();
  importPack.mockClear();
  starter.mockClear();
});

describe("anyone but the owner is refused in words, before any read or write", () => {
  it.each(["office", "admin", "tech"])("%s", async (role) => {
    state.role = role;
    state.rpcReply = landed(null, "deck");
    expect(await setOrgTrade("deck")).toEqual({ ok: false, error: OWNER_WORDS });
    expect(await applyTradeCodes("deck")).toEqual({ ok: false, error: OWNER_WORDS });
    expect(await applyTradeSwitches("deck")).toEqual({ ok: false, error: OWNER_WORDS, moved: [] });
    expect(await startTradeSheet("deck")).toEqual({ ok: false, error: OWNER_WORDS });
    // The pricing door says its own words, not the trade door's (S5).
    expect(await setEstimatingMode("catalog")).toEqual({ ok: false, error: PRICING_WORDS });
    expect(state.rpcCalls).toEqual([]);
    expect(state.updates).toEqual([]);
    expect(importPack).not.toHaveBeenCalled();
    expect(starter).not.toHaveBeenCalled();
    expect(state.reads.every((t) => t === "profiles")).toBe(true);
  });

  it("a deactivated owner is nobody", async () => {
    state.active = false;
    expect(await setOrgTrade("deck")).toEqual({ ok: false, error: "Sign in to your company first." });
    expect(state.rpcCalls).toEqual([]);
  });
});

describe("setOrgTrade", () => {
  it("calls set_org_trade once with p_trade, reads its answer back, and hands the offers over", async () => {
    state.rpcReply = landed(null, "deck");
    const res = await setOrgTrade("deck");
    expect(state.rpcCalls).toEqual([{ fn: "set_org_trade", args: { p_trade: "deck" } }]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.previous).toBe("");
    expect(res.trade).toBe("deck");
    expect(res.offers?.key).toBe("deck");
    expect(res.offers?.menu).toBe("Deck / Carpentry");
    expect(res.offers?.codes).toEqual(TRADE_PACKAGES.deck.codes); // a company with no codes is offered them all
    expect(res.offers?.switches.map((s) => s.words)).toEqual(["Kits & Sizing By Sq Ft on", "Contracts & Lien Rights on"]);
    expect(res.offers?.hasSheet).toBe(false);
    expect(res.clearedWords).toBeNull();
    expect(res.offersError).toBeUndefined();
    expect(state.updates).toEqual([]); // the key moved in the database; nothing else was written
    expect(revalidatePath).toHaveBeenCalledWith("/settings");
    expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
  });

  it("a company holding TRBL (and svc) moved to electrical is offered the count without TROUB or SVC, no switch, and no sheet", async () => {
    state.codes = ["TRBL", "svc"];
    state.settings = { features: featurePreset("electrical"), timeclock_job_codes: true };
    state.sheet = true;
    state.rpcReply = landed("deck", "electrical");
    const res = await setOrgTrade("electrical");
    expect(res.ok).toBe(true);
    if (!res.ok || !res.offers) return expect(res).toMatchObject({ ok: true, offers: expect.anything() });
    const codes = res.offers.codes.map((c) => c.code);
    expect(codes).not.toContain("TROUB");
    expect(codes).not.toContain("SVC");
    expect(codes).toHaveLength(TRADE_PACKAGES.electrical.codes.length - 2);
    expect(res.offers.switches).toEqual([]); // already on electrical's preset
    expect(res.offers.hasSheet).toBe(true);
    // The reads are the company's own rows: org-scoped, the sheet read by is_inspection.
    expect(state.reads).toContain("job_codes");
    expect(state.reads).toContain("forms");
  });

  it("a thrown offers read still returns the landed trade, with the failure said in the offers' place (S1)", async () => {
    state.codesError = { message: "connection reset" };
    state.rpcReply = landed(null, "deck");
    const res = await setOrgTrade("deck");
    expect(res).toEqual({
      ok: true,
      previous: "",
      trade: "deck",
      clearedWords: null,
      offers: null,
      offersError: "Couldn't read what to offer — reload to see the buttons.",
    });
    expect(revalidatePath).toHaveBeenCalledWith("/settings");
    expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
  });

  it("Other (or blank) sends '' and comes back with no offers", async () => {
    state.rpcReply = landed("deck", null);
    const res = await setOrgTrade("other");
    expect(state.rpcCalls).toEqual([{ fn: "set_org_trade", args: { p_trade: "" } }]);
    expect(res).toEqual({ ok: true, previous: "deck", trade: "", clearedWords: null, offers: null });
    state.rpcCalls = [];
    expect((await setOrgTrade("  ")).ok).toBe(true);
    expect(state.rpcCalls).toEqual([{ fn: "set_org_trade", args: { p_trade: "" } }]);
  });

  it("a word that is not a trade never reaches the database; the database's own refusal comes through in its words", async () => {
    expect(await setOrgTrade("solar")).toEqual({ ok: false, error: 'There is no trade called "solar".' });
    expect(state.rpcCalls).toEqual([]);
    state.rpcReply = () => ({ error: { code: "P0001", message: OWNER_WORDS } });
    expect(await setOrgTrade("deck")).toEqual({ ok: false, error: OWNER_WORDS });
  });

  it("a stored value that isn't the one asked for is a failure; a database without 0398 gets a plain line", async () => {
    state.rpcReply = landed(null, "plumbing");
    expect(await setOrgTrade("deck")).toEqual({ ok: false, error: NOT_SAVED });
    state.rpcReply = () => ({ data: null });
    expect(await setOrgTrade("deck")).toEqual({ ok: false, error: NOT_SAVED });
    state.rpcReply = () => ({ error: { code: "PGRST202", message: "Could not find the function public.set_org_trade(p_trade) in the schema cache" } });
    expect(await setOrgTrade("deck")).toEqual({ ok: false, error: "Features need an update from North. Nothing changed." });
  });

  describe("the label rule: the company's own words are cleared only when they name a DIFFERENT known trade", () => {
    const labelWrites = () => state.updates.filter((u) => u.table === "organizations" && "trade_label" in (u.patch?.settings ?? {}));

    it("'deck builder' + plumbing → cleared, scoped to the company, the written row asked back, and the answer names the words", async () => {
      state.settings = { ...state.settings, trade_label: "deck builder", service_area: "Larkspur" };
      state.rpcReply = landed("deck", "plumbing");
      const res = await setOrgTrade("plumbing");
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.clearedWords).toBe("deck builder");
      const w = labelWrites();
      expect(w).toHaveLength(1);
      expect(w[0].patch.settings.trade_label).toBe("");
      expect(w[0].patch.settings.service_area).toBe("Larkspur"); // merged over the row as it stands
      expect(w[0].eqs).toEqual([["id", "org-1"]]);
      expect(w[0].selected).toEqual(["id"]);
    });

    it("'deck builder' + Other → cleared and returned (the words would keep telling Nort a trade the key no longer says)", async () => {
      state.settings = { ...state.settings, trade_label: "deck builder" };
      state.rpcReply = landed("deck", null);
      const res = await setOrgTrade("other");
      expect(res).toEqual({ ok: true, previous: "deck", trade: "", clearedWords: "deck builder", offers: null });
      expect(labelWrites()).toHaveLength(1);
      expect(labelWrites()[0].patch.settings.trade_label).toBe("");
    });

    it("'Plumbing, Heating & Air' + hvac → cleared, because the words read as plumbing (tradeKeyFromWords reads the first trade it finds)", async () => {
      state.settings = { ...state.settings, trade_label: "Plumbing, Heating & Air" };
      state.rpcReply = landed("plumbing", "hvac");
      const res = await setOrgTrade("hvac");
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.clearedWords).toBe("Plumbing, Heating & Air");
      expect(labelWrites()).toHaveLength(1);
    });

    it("'handyman' + general → kept (the words still fit); '' → untouched; the same trade's words → kept", async () => {
      state.settings = { ...state.settings, trade_label: "handyman" };
      state.rpcReply = landed(null, "general");
      expect((await setOrgTrade("general")).ok).toBe(true);
      expect(labelWrites()).toEqual([]);

      state.settings = { ...state.settings, trade_label: "" };
      state.rpcReply = landed("general", "deck");
      expect((await setOrgTrade("deck")).ok).toBe(true);
      expect(labelWrites()).toEqual([]);

      state.settings = { ...state.settings, trade_label: "Plumbing & Heating" };
      state.rpcReply = landed("deck", "plumbing");
      const same = await setOrgTrade("plumbing");
      expect(same.ok).toBe(true);
      if (same.ok) expect(same.clearedWords).toBeNull();
      expect(labelWrites()).toEqual([]);
    });

    it("a zero-row clear is said, with the trade already saved — and the caches still dropped, since the key moved", async () => {
      state.settings = { ...state.settings, trade_label: "deck builder" };
      state.wrote = [];
      state.rpcReply = landed("deck", "plumbing");
      const res = await setOrgTrade("plumbing");
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error).toBe(`Your trade is saved, but its old words ("deck builder") could not be cleared: ${NOT_SAVED}`);
      expect(revalidatePath).toHaveBeenCalledWith("/settings");
      expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
    });
  });

  it("a refused RPC drops no cache: nothing moved", async () => {
    state.rpcReply = () => ({ error: { code: "P0001", message: OWNER_WORDS } });
    expect((await setOrgTrade("deck")).ok).toBe(false);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("has no door that reads the offers on their own: the card gets them with the landed trade (S3)", async () => {
    const mod = await import("./features-actions");
    expect("tradeOffers" in mod).toBe(false);
  });
});

describe("the three doors", () => {
  it("applyTradeCodes hands the TRADE KEY to the import and says how many landed", async () => {
    expect(await applyTradeCodes("plumbing")).toEqual({ ok: true, words: "Added 3 of Plumbing's codes. 2 you already had stayed as they were." });
    expect(importPack).toHaveBeenCalledWith("plumbing");
    importPack.mockResolvedValueOnce({ ok: true, added: 0, skipped: 13 });
    expect(await applyTradeCodes("plumbing")).toEqual({ ok: true, words: "You already had every one of Plumbing's codes." });
    importPack.mockResolvedValueOnce({ ok: false, error: "This action is staff-only." } as never);
    expect(await applyTradeCodes("plumbing")).toEqual({ ok: false, error: "This action is staff-only." });
  });

  it("applyTradeSwitches flips only the keys that differ, one set_org_feature each, and says what moved", async () => {
    state.rpcReply = flipped;
    const res = await applyTradeSwitches("deck");
    expect(state.rpcCalls).toEqual([
      { fn: "set_org_feature", args: { p_key: "kits", p_on: true } },
      { fn: "set_org_feature", args: { p_key: "contracts", p_on: true } },
    ]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.moved.map((s) => s.key)).toEqual(["kits", "contracts"]);
    expect(res.words).toBe("Kits & Sizing By Sq Ft on, Contracts & Lien Rights on.");

    // Already on the preset: nothing is sent, and that is said.
    state.rpcCalls = [];
    state.settings = { features: featurePreset("deck"), timeclock_job_codes: false };
    expect(await applyTradeSwitches("deck")).toEqual({ ok: true, moved: [], words: "Nothing to change." });
    expect(state.rpcCalls).toEqual([]);
  });

  it("applyTradeSwitches: a refused flip stops the run and says what had already moved", async () => {
    state.rpcReply = (fn, args) => (args.p_key === "contracts" ? { error: { code: "P0001", message: "Only the owner can turn features on or off." } } : flipped(fn, args));
    const res = await applyTradeSwitches("deck");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe("Contracts & Lien Rights on didn't land: Only the owner can turn features on or off. Kits & Sizing By Sq Ft on.");
    expect(res.moved.map((s) => s.key)).toEqual(["kits"]);
  });

  it("startTradeSheet makes the starter once, and never a second sheet", async () => {
    expect(await startTradeSheet("plumbing")).toEqual({ ok: true, words: "Started Plumbing's inspection sheet. Edit it under Settings › Inspection Sheet." });
    expect(starter).toHaveBeenCalledTimes(1);
    state.sheet = true;
    expect(await startTradeSheet("plumbing")).toEqual({ ok: true, words: "You already have an inspection sheet; it stays." });
    expect(starter).toHaveBeenCalledTimes(1);
    state.sheet = false;
    starter.mockResolvedValueOnce({ ok: false, error: "Not signed in." } as never);
    expect(await startTradeSheet("plumbing")).toEqual({ ok: false, error: "Not signed in." });
  });
});

describe("setEstimatingMode", () => {
  it("refuses any word but research or catalog, before a read", async () => {
    for (const w of ["shelf", "other", "", "Catalog"]) {
      expect(await setEstimatingMode(w), w).toEqual({ ok: false, error: "Say research or catalog." });
    }
    expect(state.updates).toEqual([]);
  });

  it("lands catalog with one scoped write, merged over the row, the written row asked back", async () => {
    state.settings = { quote_playbook: "Snowbell's habits", estimating_mode: "research" };
    expect(await setEstimatingMode("catalog")).toEqual({ ok: true, mode: "catalog" });
    expect(state.updates).toHaveLength(1);
    const u = state.updates[0];
    expect(u.table).toBe("organizations");
    expect(u.patch).toEqual({ settings: { quote_playbook: "Snowbell's habits", estimating_mode: "catalog" } });
    expect(u.eqs).toEqual([["id", "org-1"]]);
    expect(u.selected).toEqual(["id"]);
    expect(state.rpcCalls).toEqual([]); // never updateOrgSettings' staff path, never an RPC
  });

  it("a zero-row write is said, not a quiet success", async () => {
    state.wrote = [];
    expect(await setEstimatingMode("research")).toEqual({ ok: false, error: NOT_SAVED });
  });
});
