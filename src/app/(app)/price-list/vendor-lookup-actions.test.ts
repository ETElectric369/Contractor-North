import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * LOOK UP and READ A PHOTO OR SCAN (vendor import, Phase 2), through the REAL server actions and the
 * REAL meter (ai-cost's recordAiUsage, aiSpendExceeded and costOf). Stubbed: the model and its web
 * search (a scripted client, so no paid call is ever made), the tenant database the staff guard hands
 * back, and the service client's ai_usage ledger (record_ai_usage's upsert, emulated).
 *
 * Every name, number and site is made up: a real vendor list never goes in this repo (it is public).
 */

type Row = Record<string, any>;
type Params = { model: string; tools?: any[]; messages: any[]; system?: string; max_tokens: number };

const db = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  ledger: [] as Row[],
  staff: true,
  orgId: "org-1",
  clock: 0,
  calls: [] as { model: string; tools?: any[]; messages: any[] }[],
  respond: null as null | ((p: any, n: number) => any),
  noKey: false,
}));

const today = () => new Date().toISOString().slice(0, 10);
const stamp = () => `2026-09-25T21:00:${String(++db.clock).padStart(2, "0")}.000000+00:00`;

/** The tenant database, RLS as 0296 writes it: the org sees its own rows; only staff write. */
function tenantClient() {
  return {
    from(table: string) {
      let op: "select" | "insert" | "update" = "select";
      let payload: Row | Row[] | null = null;
      let wantRows = false;
      const filters: ((r: Row) => boolean)[] = [];
      const run = (): { data: any; error: any } => {
        const all = (db.tables[table] ??= []);
        const hit = all.filter((r) => r.org_id === db.orgId).filter((r) => filters.every((f) => f(r)));
        if (op === "select") return { data: hit.map((r) => ({ ...r })), error: null };
        if (!db.staff) return { data: wantRows ? [] : null, error: null };
        const t = stamp();
        if (op === "insert") {
          const rows = [payload as Row | Row[]].flat().map((p, i) => ({ id: `${table}-${all.length + i + 1}`, org_id: db.orgId, archived: false, created_at: t, updated_at: t, ...p }));
          all.push(...rows);
          return { data: wantRows ? rows.map((r) => ({ ...r })) : null, error: null };
        }
        for (const r of hit) Object.assign(r, payload, { updated_at: t });
        return { data: wantRows ? hit.map((r) => ({ ...r })) : null, error: null };
      };
      const chain: any = {
        select: () => ((wantRows = true), chain),
        insert: (p: Row | Row[]) => ((op = "insert"), (payload = p), chain),
        update: (p: Row) => ((op = "update"), (payload = p), chain),
        eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), chain),
        in: (c: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[c])), chain),
        order: () => chain,
        limit: () => chain,
        maybeSingle: async () => {
          const r = run();
          return { data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data, error: r.error };
        },
        then: (res: (v: unknown) => void, rej: (e: unknown) => void) => {
          try {
            res(run());
          } catch (e) {
            rej(e);
          }
        },
      };
      return chain;
    },
  };
}

/** The service client: the ai_usage ledger, and record_ai_usage / ai_spend_since as 0162 writes them. */
function serviceClient() {
  return {
    async rpc(fn: string, a: Row) {
      if (fn === "record_ai_usage") {
        const key = (r: Row) => r.org_id === a.p_org_id && r.usage_date === today() && r.model === a.p_model && r.surface === a.p_surface;
        let row = db.ledger.find(key);
        if (!row) db.ledger.push((row = { org_id: a.p_org_id, usage_date: today(), model: a.p_model, surface: a.p_surface, input_tokens: 0, output_tokens: 0, cost_usd: 0, calls: 0 }));
        row.input_tokens += a.p_input;
        row.output_tokens += a.p_output;
        row.cost_usd += Number(a.p_cost_usd);
        row.calls += 1;
        return { data: null, error: null };
      }
      if (fn === "ai_spend_since") {
        return { data: db.ledger.filter((r) => r.org_id === a.p_org_id).reduce((n, r) => n + Number(r.cost_usd), 0), error: null };
      }
      return { data: null, error: { message: `no rpc ${fn}` } };
    },
    from(table: string) {
      if (table !== "ai_usage") throw new Error(`service client read ${table}`);
      const filters: ((r: Row) => boolean)[] = [];
      const chain: any = {
        select: () => chain,
        eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), chain),
        then: (res: (v: unknown) => void) => res({ data: db.ledger.filter((r) => filters.every((f) => f(r))).map((r) => ({ calls: r.calls })), error: null }),
      };
      return chain;
    },
  };
}

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));
vi.mock("@/lib/staff-guard", () => ({
  requireStaff: vi.fn(async () =>
    db.staff ? { supabase: tenantClient(), orgId: db.orgId, userId: "user-1" } : { error: "This action is staff-only." },
  ),
}));
vi.mock("@/lib/supabase/server", () => ({ createServiceClient: () => serviceClient(), createClient: async () => tenantClient() }));
vi.mock("@/lib/anthropic", () => ({
  getAnthropic: () => {
    if (db.noKey) throw new Error("ANTHROPIC_API_KEY is not set.");
    return {
      messages: {
        create: async (p: Params) => {
          db.calls.push(JSON.parse(JSON.stringify({ model: p.model, tools: p.tools, messages: p.messages })));
          if (!db.respond) throw new Error("no scripted response");
          return db.respond(p, db.calls.length);
        },
      },
    };
  },
}));

import { costOf } from "@/lib/ai-cost";
import { lookUpVendors, readVendorList } from "./vendor-lookup-actions";
import { addVendorsBatch, saveLookedUp, undoLookedUp } from "./vendor-actions";
import { rowsFromTable } from "./vendor-import-math";
import { autoPick } from "./vendor-lookup-math";

/** One scripted model response: the searches it ran, the pages they returned, and its JSON. */
function reply(o: { pages?: string[]; json?: unknown; searches?: number; stop?: string; cited?: string[] }) {
  return {
    model: "claude-sonnet-5",
    stop_reason: o.stop ?? "end_turn",
    usage: { input_tokens: 15_000, output_tokens: 900, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, server_tool_use: { web_search_requests: o.searches ?? 1 } },
    content: [
      { type: "server_tool_use", id: "srv_1", name: "web_search", input: { query: "q" } },
      { type: "web_search_tool_result", tool_use_id: "srv_1", content: (o.pages ?? []).map((url) => ({ type: "web_search_result", url, title: "t", encrypted_content: "e" })) },
      ...(o.json === undefined
        ? []
        : [{ type: "text", text: JSON.stringify(o.json), citations: (o.cited ?? []).map((url) => ({ type: "web_search_result_location", url, title: "t", cited_text: "c" })) }]),
    ],
  };
}

const SITE = "https://granitepeakplumbing.example/contact";
const lookupRow = () => db.ledger.find((r) => r.org_id === "org-1" && r.surface === "vendor-lookup");
const userText = (n: number) => String(db.calls[n]?.messages?.[0]?.content ?? "");

beforeEach(() => {
  db.staff = true;
  db.orgId = "org-1";
  db.clock = 0;
  db.calls = [];
  db.ledger = [];
  db.noKey = false;
  db.respond = null;
  db.tables = {
    organizations: [
      // Vivian's shape: public city Truckee, public state empty, the mailing address in Reno, NV.
      { id: "org-1", org_id: "org-1", settings: { public_city: "Truckee", public_state: "" }, city: "Reno", state: "NV" },
      { id: "org-2", org_id: "org-2", settings: { public_city: "Elsewhere", public_state: "OR" }, city: "Elsewhere", state: "OR" },
    ],
    price_list_item_options: [],
    price_list_vendors: [
      { id: "v-1", org_id: "org-1", name: "Granite Peak Plumbing", phone: null, email: "bids@granitepeakplumbing.example", website: null, address: null, kind: "subcontractor", archived: false, created_at: "t0", updated_at: "t0" },
      { id: "v-other", org_id: "org-2", name: "Granite Peak Plumbing", phone: "(541) 555-0100", archived: false, created_at: "t0", updated_at: "t0" },
    ],
  };
});

describe("Look Up: refused before any money is spent", () => {
  it("a tech (or anyone not staff) is refused, and the model is never called", async () => {
    db.staff = false;
    db.respond = () => reply({ json: { candidates: [] } });
    expect(await lookUpVendors({ names: [{ name: "Granite Peak Plumbing" }] })).toEqual({ ok: false, error: "This action is staff-only." });
    expect(db.calls).toEqual([]);
    expect(db.ledger).toEqual([]);
  });

  it("more than five names in one call is refused (the browser sends five at a time)", async () => {
    db.respond = () => reply({ json: { candidates: [] } });
    const res = await lookUpVendors({ names: ["A", "B", "C", "D", "E", "F"].map((name) => ({ name })) });
    expect(res).toEqual({ ok: false, error: "Look up at most 5 names at a time." });
    expect(db.calls).toEqual([]);
  });

  it("a company past the month's $150 AI allowance is refused, and nothing is charged", async () => {
    db.ledger.push({ org_id: "org-1", usage_date: today(), model: "claude-opus-4-8", surface: "chat", cost_usd: 150, calls: 400 });
    db.respond = () => reply({ json: { candidates: [] } });
    const res = await lookUpVendors({ names: [{ name: "Granite Peak Plumbing" }] });
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error).toMatch(/used this month's AI allowance, so nothing was looked up and nothing was charged/);
    expect(db.calls).toEqual([]);
  });

  it("THE DAILY CAP: 98 lookups today leaves 2, so a chunk of 5 is refused whole and says how many are left", async () => {
    db.ledger.push({ org_id: "org-1", usage_date: today(), model: "claude-sonnet-5", surface: "vendor-lookup", cost_usd: 9.8, calls: 98 });
    db.respond = () => reply({ json: { candidates: [] } });
    const res = await lookUpVendors({ names: ["A Co", "B Co", "C Co", "D Co", "E Co"].map((name) => ({ name })) });
    expect(res).toEqual({
      ok: false,
      leftToday: 2,
      error: "Only 2 more lookups can run today (the most is 100 a day), so these 5 weren't looked up. Look up 2 at a time, or the rest tomorrow.",
    });
    expect(db.calls).toEqual([]);
  });

  it("at 100 today, nothing more runs", async () => {
    db.ledger.push({ org_id: "org-1", usage_date: today(), model: "claude-sonnet-5", surface: "vendor-lookup", cost_usd: 10, calls: 100 });
    db.respond = () => reply({ json: { candidates: [] } });
    const res = await lookUpVendors({ names: [{ name: "A Co" }] });
    expect(res).toMatchObject({ ok: false, leftToday: 0 });
    expect(!res.ok && res.error).toMatch(/looked up 100 vendors today, the most in a day/);
    expect(db.calls).toEqual([]);
  });

  it("the cap counts only THIS org's lookups TODAY: another org's, yesterday's and chat's don't", async () => {
    db.ledger.push(
      { org_id: "org-2", usage_date: today(), model: "claude-sonnet-5", surface: "vendor-lookup", cost_usd: 1, calls: 500 },
      { org_id: "org-1", usage_date: "2026-09-24", model: "claude-sonnet-5", surface: "vendor-lookup", cost_usd: 1, calls: 100 },
      { org_id: "org-1", usage_date: today(), model: "claude-opus-4-8", surface: "chat", cost_usd: 1, calls: 300 },
    );
    db.respond = () => reply({ json: { candidates: [] } });
    const res = await lookUpVendors({ names: [{ name: "A Co" }, { name: "B Co" }] });
    expect(res).toMatchObject({ ok: true, leftToday: 98 });
    expect(db.calls.length).toBe(2);
  });

  it("no API key: said in words, nothing called", async () => {
    db.noKey = true;
    const res = await lookUpVendors({ names: [{ name: "A Co" }] });
    expect(res).toEqual({ ok: false, error: "Looking vendors up isn't switched on for your account yet. Add the details yourself for now." });
  });
});

describe("Look Up: every field sourced, every lookup on the ledger, nothing saved", () => {
  it("drops a FABRICATED field, keeps the sourced ones, meters the lookup with its searches, and writes no vendor", async () => {
    const before = JSON.stringify(db.tables.price_list_vendors);
    db.respond = () =>
      reply({
        searches: 3,
        pages: [SITE],
        json: {
          candidates: [
            {
              phone: "(530) 555-0142",
              website: "granitepeakplumbing.example",
              email: "invented@granitepeakplumbing.example",
              address: "10200 Pioneer Trl, Truckee, CA 96161",
              sources: { phone: SITE, website: SITE, address: SITE },
            },
          ],
        },
      });
    const res = await lookUpVendors({ names: [{ name: "Granite Peak Plumbing" }] });
    if (!res.ok) throw new Error(res.error);
    const a = res.results[0].answer;
    if (!a.found) throw new Error("expected a choice");
    expect(a.dropped).toBe(1);
    expect(Object.keys(a.choices[0].fields).sort()).toEqual(["address", "phone", "website"]);
    expect(a.choices[0].fields.email).toBeUndefined();
    expect(a.choices[0].place).toBe("Truckee, CA");
    expect(a.near).toBe("Truckee");

    // The tool as sent: 3 searches at most, near Truckee, and NOT "Truckee, NV".
    expect(db.calls[0].model).toBe("claude-sonnet-5");
    expect(db.calls[0].tools).toEqual([{ type: "web_search_20250305", name: "web_search", max_uses: 3, user_location: { type: "approximate", city: "Truckee", country: "US" } }]);
    expect(userText(0)).toContain('"Granite Peak Plumbing" near Truckee (the office is in Reno, NV)');

    // ONE ledger row for the lookup: surface vendor-lookup, one call, tokens plus 3 searches at $0.01.
    const row = lookupRow();
    expect(row).toMatchObject({ surface: "vendor-lookup", model: "claude-sonnet-5", calls: 1, input_tokens: 15_000, output_tokens: 900 });
    expect(row!.cost_usd).toBeCloseTo(costOf("claude-sonnet-5", { input_tokens: 15_000, output_tokens: 900 }) + 0.03, 6);

    // A lookup saves nothing: the vendor table is exactly as it was.
    expect(JSON.stringify(db.tables.price_list_vendors)).toBe(before);
  });

  it("a multi-location answer comes back as choices, and none is picked for the person", async () => {
    const pages = ["https://sierralumberyard.example/truckee", "https://sierralumberyard.example/reno"];
    db.respond = () =>
      reply({
        pages,
        json: {
          candidates: [
            { address: "11 Brockway Rd, Truckee, CA 96161", phone: "530-555-0110", sources: { address: pages[0], phone: pages[0] } },
            { address: "22 Kietzke Ln, Reno, NV 89502", phone: "775-555-0120", sources: { address: pages[1], phone: pages[1] } },
          ],
        },
      });
    const res = await lookUpVendors({ names: [{ name: "Sierra Lumber Yard" }] });
    if (!res.ok) throw new Error(res.error);
    const a = res.results[0].answer;
    expect(a.found && a.choices.map((c) => c.place)).toEqual(["Truckee, CA", "Reno, NV"]);
    expect(autoPick(a, false)).toBeNull();
  });

  it("nothing found is a plain answer: found false, no vendor written, and its searches are still metered", async () => {
    db.respond = () => reply({ searches: 2, pages: [], json: { candidates: [], none_found_reason: "No listing for this name." } });
    const res = await lookUpVendors({ names: [{ name: "Maria Delgado", isPerson: true }] });
    if (!res.ok) throw new Error(res.error);
    expect(res.results[0].answer).toEqual({ found: false, why: "nothing", dropped: 0, near: "Truckee" });
    expect(userText(0)).toContain("person's name, which is harder to find");
    expect(lookupRow()).toMatchObject({ calls: 1 });
    expect(lookupRow()!.cost_usd).toBeCloseTo(costOf("claude-sonnet-5", { input_tokens: 15_000, output_tokens: 900 }) + 0.02, 6);
    expect(db.tables.price_list_vendors.length).toBe(2);
  });

  it("a paused turn is resumed at most within 3 searches in all, and is one lookup on the ledger", async () => {
    db.respond = (_p, n) =>
      n === 1
        ? reply({ stop: "pause_turn", searches: 2, pages: [SITE] })
        : reply({ searches: 1, pages: [SITE], json: { candidates: [{ phone: "530-555-0142", sources: { phone: SITE } }] } });
    const res = await lookUpVendors({ names: [{ name: "Granite Peak Plumbing" }] });
    if (!res.ok) throw new Error(res.error);
    expect(db.calls.length).toBe(2);
    // The resumption may use only what's left: one more search.
    expect(db.calls[1].tools?.[0].max_uses).toBe(1);
    expect(db.calls[1].messages.map((m: { role: string }) => m.role)).toEqual(["user", "assistant"]);
    expect(res.results[0].answer.found).toBe(true);
    expect(lookupRow()).toMatchObject({ calls: 1, input_tokens: 30_000 });
    expect(lookupRow()!.cost_usd).toBeCloseTo(costOf("claude-sonnet-5", { input_tokens: 30_000, output_tokens: 1_800 }) + 0.03, 6);
  });

  it("a turn still paused after all 3 searches is not resumed (no fourth search is bought) and says it didn't finish", async () => {
    db.respond = () => reply({ stop: "pause_turn", searches: 3, pages: [SITE] });
    const res = await lookUpVendors({ names: [{ name: "Granite Peak Plumbing" }] });
    if (!res.ok) throw new Error(res.error);
    expect(db.calls.length).toBe(1);
    expect(res.results[0].answer).toMatchObject({ found: false, why: "unfinished" });
  });

  it("five names: one ledger call each, answers in the order asked, and one that fails doesn't sink the rest", async () => {
    db.respond = (p) => {
      const text = String(p.messages[0].content);
      if (text.includes("Broken Co")) throw new Error("overloaded");
      return reply({ pages: [SITE], json: { candidates: [] } });
    };
    const names = ["A Co", "B Co", "Broken Co", "D Co", "E Co"];
    const res = await lookUpVendors({ names: names.map((name) => ({ name })) });
    if (!res.ok) throw new Error(res.error);
    expect(res.results.map((r) => r.name)).toEqual(names);
    expect(res.results[2].answer).toMatchObject({ found: false, why: "failed" });
    expect(lookupRow()!.calls).toBe(4);
    expect(res.leftToday).toBe(95);
  });
});

describe("Read A Photo Or Scan: only a real picture or a real PDF is ever sent", () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const PDF = new TextEncoder().encode("%PDF-1.7\n1 0 obj\n");
  const form = (bytes: Uint8Array, name: string, type: string) => {
    const fd = new FormData();
    fd.append("file", new File([bytes as unknown as BlobPart], name, { type }));
    return fd;
  };
  const listJson = { rows: [{ name: "Granite Peak Plumbing", phone: "530-555-0142" }, { name: "Coldwater Drywall" }, { name: "" }] };
  const readReply = () => ({
    model: "claude-sonnet-5",
    stop_reason: "end_turn",
    usage: { input_tokens: 1_500, output_tokens: 200 },
    content: [{ type: "text", text: JSON.stringify(listJson) }],
  });

  it("an .xlsx is refused by name, and NO document block is sent for it", async () => {
    db.respond = readReply;
    const res = await readVendorList(form(new Uint8Array([0x50, 0x4b, 3, 4]), "Vendors.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"));
    expect(res).toEqual({ ok: false, error: "Vendors.xlsx is a spreadsheet or text file. Drop it on the list instead: it's read there for free." });
    expect(db.calls).toEqual([]);
    expect(db.ledger).toEqual([]);
  });

  it("a file that calls itself a PDF but isn't one inside is refused, not sent", async () => {
    db.respond = readReply;
    const res = await readVendorList(form(new TextEncoder().encode("just text"), "Vendors.pdf", "application/pdf"));
    expect(res).toEqual({ ok: false, error: "Vendors.pdf says it's a PDF but isn't one inside, so it wasn't sent to be read." });
    expect(db.calls).toEqual([]);
  });

  it("a photo goes as an image block, is metered as vendor-list-read, and comes back as a table the preview sorts", async () => {
    db.respond = readReply;
    const res = await readVendorList(form(PNG, "list.png", "image/png"));
    if (!res.ok) throw new Error(res.error);
    const block = db.calls[0].messages[0].content[0];
    expect(block.type).toBe("image");
    expect(block.source.media_type).toBe("image/png");
    expect(db.ledger).toEqual([expect.objectContaining({ org_id: "org-1", surface: "vendor-list-read", calls: 1 })]);
    const { rows, headerSkipped } = rowsFromTable(res.table);
    expect(headerSkipped).toBe(true);
    expect(rows.map((r) => [r.name, r.phone ?? null])).toEqual([
      ["Granite Peak Plumbing", "530-555-0142"],
      ["Coldwater Drywall", null],
    ]);
    // Reading saves nothing.
    expect(db.tables.price_list_vendors.length).toBe(2);
  });

  it("a real PDF goes as a document block", async () => {
    db.respond = readReply;
    const res = await readVendorList(form(PDF, "scan.pdf", "application/pdf"));
    expect(res.ok).toBe(true);
    expect(db.calls[0].messages[0].content[0]).toMatchObject({ type: "document", source: { media_type: "application/pdf" } });
  });

  it("a tech is refused, a HEIC photo is refused by name, and neither calls the model", async () => {
    db.respond = readReply;
    expect(await readVendorList(form(new Uint8Array([0, 0, 0, 0x18]), "IMG_0001.HEIC", "image/heic"))).toEqual({
      ok: false,
      error: "IMG_0001.HEIC is a HEIC photo, which can't be read yet. Take a screenshot of it and drop that.",
    });
    db.staff = false;
    expect((await readVendorList(form(PNG, "list.png", "image/png"))).ok).toBe(false);
    expect(db.calls).toEqual([]);
  });
});

describe("a pick is saved only when a person presses Add or Save", () => {
  const LOOKED = { source_url: SITE, maps_url: "https://www.google.com/maps/search/?api=1&query=Granite" };

  it("Add carries a picked row's source and stamps when it was taken", async () => {
    db.tables.price_list_vendors = [];
    const res = await addVendorsBatch([{ name: "Coldwater Drywall", phone: "(530) 555-0150", ...LOOKED }, { name: "Maria Delgado", is_person: true }], "11111111-2222-4333-8444-555555555555");
    expect(res).toMatchObject({ ok: true, added: 2 });
    const [a, b] = db.tables.price_list_vendors;
    expect(a).toMatchObject({ name: "Coldwater Drywall", source_url: SITE, maps_url: LOOKED.maps_url });
    expect(Number.isNaN(Date.parse(a.looked_up_at))).toBe(false);
    expect(b.source_url ?? null).toBeNull();
    expect(b.looked_up_at).toBeUndefined();
  });

  it("Add refuses a looked-up link that isn't a web address", async () => {
    db.tables.price_list_vendors = [];
    const res = await addVendorsBatch([{ name: "Coldwater Drywall", source_url: "javascript:alert(1)" }], "11111111-2222-4333-8444-555555555555");
    expect(res.ok).toBe(false);
    expect(res.refused?.[0].why).toBe("That looked-up link isn't a web address, so nothing was saved. Look it up again.");
  });

  it("Save on a card writes only the ticked fields with where they were found; Undo puts back exactly what it replaced", async () => {
    const res = await saveLookedUp({ name: "granite peak plumbing", fields: { phone: "(530) 555-0142", website: "https://granitepeakplumbing.example/" }, ...LOOKED });
    expect(res.ok).toBe(true);
    const card = db.tables.price_list_vendors.find((r) => r.id === "v-1")!;
    expect(card).toMatchObject({ phone: "(530) 555-0142", website: "https://granitepeakplumbing.example/", email: "bids@granitepeakplumbing.example", source_url: SITE });
    expect(card.looked_up_at).toBeTruthy();
    // Another company's card with the same name is untouched.
    expect(db.tables.price_list_vendors.find((r) => r.id === "v-other")).toMatchObject({ phone: "(541) 555-0100" });
    expect(res.undo).toMatchObject({ cardId: "v-1", created: false, previous: { phone: null, website: null, source_url: null, maps_url: null, looked_up_at: null } });

    expect(await undoLookedUp(res.undo!)).toEqual({ ok: true });
    expect(db.tables.price_list_vendors.find((r) => r.id === "v-1")).toMatchObject({ phone: null, website: null, source_url: null, looked_up_at: null, email: "bids@granitepeakplumbing.example" });
  });

  it("Undo leaves a card alone once somebody has changed it since", async () => {
    const res = await saveLookedUp({ name: "Granite Peak Plumbing", fields: { phone: "(530) 555-0142" }, ...LOOKED });
    const card = db.tables.price_list_vendors.find((r) => r.id === "v-1")!;
    card.phone = "(530) 555-0000";
    card.updated_at = stamp();
    expect(await undoLookedUp(res.undo!)).toEqual({ ok: false, error: "That vendor has been changed since, so Undo left it alone." });
    expect(card.phone).toBe("(530) 555-0000");
  });

  it("Save refuses with nothing ticked, with no source, and for a tech", async () => {
    expect(await saveLookedUp({ name: "Granite Peak Plumbing", fields: {}, ...LOOKED })).toEqual({ ok: false, error: "Nothing is ticked, so nothing was saved." });
    expect((await saveLookedUp({ name: "Granite Peak Plumbing", fields: { phone: "(530) 555-0142" }, source_url: "" })).error).toBe(
      "A looked-up detail has to say where it was found. Look it up again.",
    );
    db.staff = false;
    expect((await saveLookedUp({ name: "Granite Peak Plumbing", fields: { phone: "(530) 555-0142" }, ...LOOKED })).ok).toBe(false);
    expect(db.tables.price_list_vendors.find((r) => r.id === "v-1")!.phone).toBeNull();
  });
});

describe("the screens say it in Title Case and state the price before the tap", () => {
  const src = (f: string) => readFileSync(fileURLToPath(new URL(f, import.meta.url)), "utf8");
  it("the new clickables", () => {
    const all = src("./vendor-import.tsx") + src("./vendor-choices.tsx") + src("./vendors-manager.tsx");
    for (const label of ["Look Up", "Look Up Contact Info For ${nextBatch}", "Look Up Contact Info", "Stop", "Use This One", "None Of These", "Leave Blank", "Read With Nort", "Show Choices Again", "View On Map", "Found On"]) {
      expect(all).toContain(label);
    }
    expect(all).not.toMatch(/>\s*(Look up|Use this one|None of these|Leave blank|Read with Nort)\s*</);
    // The price is on the Look Up For N button's line and beside each row's Look Up.
    expect(src("./vendor-import.tsx")).toContain("lookupPrice(nextBatch)");
    expect(src("./vendor-import.tsx")).toContain("lookupPrice(1)");
  });
});
