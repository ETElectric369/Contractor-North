import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { titleCaseIn } from "../../../../tests/title-case-words";
import { happenedSaidKey, openFirst, primaryOf, rowDoors, stateWordKey } from "./list-rows";
import { translator } from "@/lib/i18n";

/**
 * THE INSPECTIONS PAGE IS ONE LIST (cn-v1171). Erik's meeting, 2026-11-19: a boxed "START
 * INSPECTION", "Remove 'Book Inspec…'", "Just a list of people/leads that Need Inspections"; and his
 * yes to the Filed side going away (a finished inspection is found in its person's file).
 *
 * The page itself is rendered against a fake database (made-up people and streets), in English and in
 * Spanish. The row's ⋯ is drawn as a marker carrying the moves the page handed it; the ⋯ itself, and
 * its one-item rule, are proved in inspection-row-menu.test. Node environment: no effects, no document.
 */

const state = vi.hoisted(() => ({
  visits: [] as Record<string, unknown>[],
  language: undefined as string | undefined,
  features: undefined as Record<string, boolean> | undefined,
  selects: [] as string[],
  /** A table whose read fails (cn-v1172: a failed read is said, never drawn as nobody). */
  failTable: null as string | null,
}));

function fakeClient() {
  const answer = (table: string): unknown[] => {
    if (table === "appointments") return state.visits;
    if (table === "profiles") return [{ id: "user-1", role: "owner", language: state.language, full_name: "The Office", org_id: "org-1", active: true }];
    if (table === "organizations") return [{ settings: { timezone: "America/Los_Angeles", ...(state.features ? { features: state.features } : {}) } }];
    return [];
  };
  const chain = (table: string) => {
    const q: any = new Proxy(
      {},
      {
        get(_t, prop) {
          const failed = state.failTable === table;
          if (prop === "then")
            return (ok: any, err: any) => Promise.resolve(failed ? { data: null, error: { message: "boom" } } : { data: answer(table), error: null }).then(ok, err);
          if (prop === "maybeSingle" || prop === "single") return async () => (failed ? { data: null, error: { message: "boom" } } : { data: answer(table)[0] ?? null, error: null });
          if (prop === "select" && table === "appointments") return (cols: string) => (state.selects.push(cols), q);
          return () => q;
        },
      },
    );
    return q;
  };
  return { auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) }, from: (table: string) => chain(table) };
}

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => fakeClient(), createServiceClient: () => fakeClient() }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`NEXT_REDIRECT ${to}`);
  },
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
  usePathname: () => "/inspections",
}));
vi.mock("@/components/toast", () => ({ useToast: () => () => {} }));
vi.mock("./inspection-row-menu", () => ({
  InspectionRowMenu: ({ row }: { row: { doors: string[] } }) => createElement("span", { "data-menu": row.doors.join(",") }),
}));

/** 10:00 in the morning, Pacific, on that day. */
const at = (day: string) => `${day}T18:00:00Z`;
const visit = (id: string, over: Record<string, unknown>) => ({
  id,
  type: "inspection",
  title: "Inspection",
  status: "scheduled",
  starts_at: at("2026-11-03"),
  ends_at: null,
  created_at: at("2026-10-20"),
  location: null,
  capture: null,
  inquiry_id: null,
  job_id: null,
  customer_id: null,
  outcome: null,
  customers: null,
  inquiries: null,
  ...over,
});

// Inspected, nothing written from it (the older first). The first was booked from a lead.
const WU_OLD = visit("wu-1", { status: "completed", starts_at: at("2026-11-03"), customers: { name: "Sam Tillery" }, location: "12 Larkspur Ln", inquiry_id: "inq-1" });
const WU_NEW = visit("wu-2", { status: "completed", title: "Attic fan", starts_at: at("2026-11-08") });
// Ahead: the city's Final Inspection for a customer; a proposed one waiting on the pick.
const CU_SOON = visit("cu-1", { type: "final_inspection", title: "Final Inspection", starts_at: at("2026-11-12"), customer_id: "cust-2", customers: { name: "Dana Rook" }, location: "9 Snowbell Ct" });
const CU_LATER = visit("cu-2", { status: "proposed", title: "Hot tub circuit", starts_at: at("2026-11-20") });
// No day: the one made first is first.
const ND_NEW = visit("nd-2", { starts_at: null, created_at: at("2026-11-08"), location: "2 Catbird Way" });
const ND_OLD = visit("nd-1", { starts_at: null, created_at: at("2026-11-01"), customer_id: "cust-3", customers: { name: "Theo Vance" }, location: "4 Bayberry Rd" });
// Its day went by, nothing captured.
const MISSED = visit("ms-1", { title: "Deck lighting", starts_at: at("2026-11-06"), customers: { name: "Casey Loam" }, location: "7 Thistlewood Dr" });
// Filed: on a job, and a customer's cancelled one (both in their files); three that hang on nobody.
const FILED_JOB = visit("fd-1", { status: "completed", title: "Panel upgrade", job_id: "job-1", starts_at: at("2026-11-02") });
const FILED_CUST = visit("fc-2", { status: "cancelled", title: "Sub panel", customer_id: "cust-9", starts_at: at("2026-11-01") });
// cn-v1175 (R8): a win with NO job picked is not an ending: it is on the list, asking for its job.
const NOBODY_DONE = visit("nb-1", { status: "completed", title: "Porch light", outcome: "won", starts_at: at("2026-11-04") });
const NOBODY_LOST = visit("nb-2", { status: "completed", outcome: "lost", starts_at: at("2025-12-04"), location: "5 Larkspur Ln" });
const NOBODY_OFF = visit("nb-3", { status: "cancelled", title: "Service change", starts_at: null });
const OPEN = [WU_NEW, WU_OLD, CU_LATER, CU_SOON, ND_NEW, ND_OLD, MISSED];
const FILED = [FILED_JOB, FILED_CUST, NOBODY_DONE, NOBODY_LOST, NOBODY_OFF];

const decode = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
const field = (html: string, name: string) => {
  const m = new RegExp(`data-${name}=""[^>]*>([\\s\\S]*?)</(?:span|a)>`).exec(html);
  return m ? decode(m[1]) : null;
};
/** A tag's href, whatever the order of its attributes. */
const hrefOf = (tag: string) => (/href="([^"]*)"/.exec(tag)?.[1] ?? "").replace(/&amp;/g, "&");
const rowsOf = (html: string) =>
  [...html.matchAll(/<li data-row="([^"]+)" data-state="([^"]+)"[^>]*>([\s\S]*?)<\/li>/g)].map((m) => {
    const body = m[3];
    const whoLink = /<a [^>]*data-who=""[^>]*>/.exec(body)?.[0];
    const primary = /(<a [^>]*data-primary=""[^>]*>)([\s\S]*?)<\/a>/.exec(body);
    return {
      id: m[1],
      state: m[2],
      who: field(body, "who"),
      whoHref: whoLink ? hrefOf(whoLink) : null,
      edge: field(body, "edge"),
      what: field(body, "what"),
      word: field(body, "state-word"),
      primary: primary ? [decode(primary[2]), hrefOf(primary[1])] : null,
      menu: /data-menu="([^"]*)"/.exec(body)?.[1] ?? null,
      html: body,
    };
  });
const foldOf = (html: string) => {
  const m = /<details[^>]*>([\s\S]*?)<\/details>/.exec(html);
  if (!m) return null;
  return {
    tag: /<details[^>]*>/.exec(html)![0],
    summary: decode(/<summary[^>]*>([\s\S]*?)<\/summary>/.exec(m[1])?.[1] ?? ""),
    line: decode(/<p [^>]*>([\s\S]*?)<\/p>/.exec(m[1])?.[1] ?? ""),
    rows: [...m[1].matchAll(/<li data-fold-row="([^"]+)"[^>]*>(<a [^>]*>)([\s\S]*?)<\/a>([\s\S]*?)<\/li>/g)].map((r) => ({
      id: r[1],
      href: hrefOf(r[2]),
      text: decode(r[3]),
      ending: field(r[3], "ending"),
      // cn-v1181 (I2b): the row's Delete…, beside the link that opens it.
      del: /<button [^>]*data-fold-delete="([^"]+)"[^>]*>([\s\S]*?)<\/button>/.exec(r[4])?.slice(1, 3) ?? null,
    })),
  };
};

let InspectionsPage: (p: { searchParams: Promise<{ view?: string }> }) => Promise<unknown>;
let LangProvider: any;
beforeAll(async () => {
  // Today is 10 Nov 2026 in the company's timezone.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-10T18:00:00Z"));
  InspectionsPage = (await import("./page")).default as any;
  LangProvider = (await import("@/components/lang-provider")).LangProvider;
}, 30_000);
afterAll(() => vi.useRealTimers());
beforeEach(() => {
  state.visits = structuredClone([...OPEN, ...FILED]);
  state.language = undefined;
  state.features = undefined;
  state.selects = [];
  state.failTable = null;
});
const render = async (q: { view?: string } = {}) => {
  const page = (await InspectionsPage({ searchParams: Promise.resolve(q) })) as React.ReactElement;
  return renderToStaticMarkup(createElement(LangProvider, { lang: state.language === "es" ? "es" : "en" }, page));
};

describe("the rule for a row's buttons (list-rows)", () => {
  it("the boxed button: Create Estimate or Open Inspection when waiting on a price, else Start Inspection, never for the city's", () => {
    expect(primaryOf("write_up", { decidable: true, estimatesOn: true })).toBe("estimate");
    expect(primaryOf("write_up", { decidable: true, estimatesOn: false })).toBe("open");
    expect(primaryOf("write_up", { decidable: false, estimatesOn: true })).toBe("estimate");
    for (const s of ["coming_up", "needs_day", "missed"] as const) {
      expect(primaryOf(s, { decidable: true, estimatesOn: true })).toBe("start");
      expect(primaryOf(s, { decidable: false, estimatesOn: true })).toBe("open");
    }
  });

  it("the ⋯ by state, in order: Open (only beside Create Estimate) · Pick a Day · Move · It Happened · Not Sold · Dismiss", () => {
    const d = (s: Parameters<typeof rowDoors>[0], primary: "start" | "estimate" | "open", decidable = true, hasStart = true) => rowDoors(s, { primary, decidable, hasStart });
    // cn-v1175 (R8): a sales visit's one ending is Not Sold in every state; a work visit (the city's) keeps Dismiss.
    expect(d("coming_up", "start")).toEqual(["move", "lost"]);
    expect(d("coming_up", "open", false)).toEqual(["move", "del"]);
    expect(d("needs_day", "start", true, false)).toEqual(["pickDay", "lost"]);
    expect(d("write_up", "estimate")).toEqual(["open", "lost"]);
    expect(d("write_up", "open")).toEqual(["lost"]);
    expect(d("write_up", "estimate", false)).toEqual(["open"]);
    expect(d("write_up", "open", false)).toEqual([]);
    expect(d("missed", "start")).toEqual(["move", "happened", "lost"]);
    expect(d("missed", "open", false)).toEqual(["move", "happened", "del"]);
    // No Move without a start: there is no time of day to keep.
    expect(d("coming_up", "start", true, false)).toEqual(["lost"]);
  });

  it("cn-v1181 (I2a): a sales visit that hangs on nobody gets Dismiss… beside Not Sold while it is not done; one that belongs to somebody keeps Not Sold alone", () => {
    const d = (s: Parameters<typeof rowDoors>[0], nobody: boolean, decidable = true) => rowDoors(s, { primary: "start", decidable, hasStart: true, nobody });
    expect(d("coming_up", true)).toEqual(["move", "lost", "del"]);
    expect(d("needs_day", true)).toEqual(["pickDay", "lost", "del"]);
    expect(d("missed", true)).toEqual(["move", "happened", "lost", "del"]);
    // Inspected (it happened): Dismiss refuses a done visit, so it is never offered there.
    expect(rowDoors("write_up", { primary: "estimate", decidable: true, hasStart: true, nobody: true })).toEqual(["open", "lost"]);
    // Somebody's: the one ending stands.
    for (const s of ["coming_up", "needs_day", "missed"] as const) expect(d(s, false)).not.toContain("del");
    // A work visit is as it was, nobody's or not.
    expect(d("coming_up", true, false)).toEqual(["move", "del"]);
  });

  it("cn-v1181 (I1): Open Inspection first in every ⋯, unless the boxed button says it", () => {
    expect(openFirst(["move", "lost"], false)).toEqual(["open", "move", "lost"]);
    expect(openFirst(["open", "lost"], false)).toEqual(["open", "lost"]);
    expect(openFirst(["move", "del"], true)).toEqual(["move", "del"]);
    expect(openFirst(["open", "lost"], true)).toEqual(["lost"]);
  });
});

describe("one list: who needs an inspection", () => {
  it("every open inspection once, in the list's order, each a card of its own; the inspected ones are on Estimates (cn-v1172)", async () => {
    const html = await render();
    const rows = rowsOf(html);
    // Estimates on (the default): inspected and waiting on a price is the Estimates page's top list.
    expect(rows.map((r) => [r.id, r.state])).toEqual([
      ["cu-1", "coming_up"],
      ["cu-2", "coming_up"],
      ["nd-1", "needs_day"],
      ["nd-2", "needs_day"],
      // cn-v1175 (R8): the win with no job picked, asking for its job (never on the Estimates page).
      ["nb-1", "write_up"],
      ["ms-1", "missed"],
    ]);
    // The Leads list's card: space between, a bold border of its own.
    expect(html).toContain('<ul class="space-y-3">');
    expect(html).toMatch(/<li data-row="cu-1" data-state="coming_up" class="flex flex-col gap-1\.5 rounded-xl border-2 border-slate-200 bg-white px-4 py-3 shadow-sm">/);
    // Nothing filed is on the list (the win with no job picked is not filed: cn-v1175, R8).
    for (const v of FILED.filter((f) => f !== NOBODY_DONE)) expect(rows.map((r) => r.id)).not.toContain(v.id);
  });

  it("English: who (a link to their file), the when, what, the state word and the boxed button", async () => {
    const rows = rowsOf(await render());
    expect(rows.map((r) => [r.who, r.whoHref, r.edge, r.what, r.word, r.primary])).toEqual([
      ["Dana Rook", "/crm/cust-2", "Thu, Nov 12 · 10:00 AM", "9 Snowbell Ct · Final Inspection", null, ["Open Inspection", "/appointments/cu-1"]],
      // cn-v1181 (I1): a name with no file opens the visit itself.
      ["Hot tub circuit", "/appointments/cu-2", "Fri, Nov 20 · 10:00 AM", "Pending pick", null, ["Start Inspection", "/appointments/cu-2"]],
      ["Theo Vance", "/crm/cust-3", "9d ago", "4 Bayberry Rd", "Needs a Day", ["Start Inspection", "/appointments/nd-1"]],
      ["2 Catbird Way", "/appointments/nd-2", "2d ago", null, "Needs a Day", ["Start Inspection", "/appointments/nd-2"]],
      // The two inspected rows (Create Estimate) are drawn on the Estimates page: quotes-two-parts.test.
      ["Porch light", "/appointments/nb-1", "6d ago", "No field notes", "Won, No Job Picked", ["Won · Start the Job", "/appointments/nb-1?won=1"]],
      ["Casey Loam", "/appointments/ms-1", "4d ago", "Deck lighting · 7 Thistlewood Dr", "Day Passed", ["Start Inspection", "/appointments/ms-1"]],
    ]);
    // cn-v1181 (I1): a name with no file is a link to the visit, never plain words nobody can open.
    const opened = rowsOf(await render()).find((r) => r.id === "cu-2")!;
    expect(opened.html).toMatch(/<a [^>]*data-who=""[^>]*>Hot tub circuit<\/a>/);
    expect(opened.html).not.toMatch(/<span class="[^"]*font-semibold[^"]*" data-who="">/);
  });

  it("Spanish: the state words, the buttons and the rows' own words", async () => {
    state.language = "es";
    const rows = rowsOf(await render());
    expect(rows.map((r) => [r.word, r.primary?.[0]])).toEqual([
      [null, "Abrir Inspección"],
      [null, "Empezar Inspección"],
      ["Falta el Día", "Empezar Inspección"],
      ["Falta el Día", "Empezar Inspección"],
      ["Ganada, Sin Trabajo Elegido", "Ganada · Empezar el Trabajo"],
      ["Ya Pasó el Día", "Empezar Inspección"],
    ]);
    expect(rows[1].what).toBe("Por elegir");
    for (const r of rows) expect(r.edge ?? "").not.toMatch(/ago|Yesterday|Today|Tomorrow|AM|PM/);
  });

  it("each row's ⋯ by state (the city's Final Inspection has no Not Sold)", async () => {
    const rows = rowsOf(await render());
    expect(Object.fromEntries(rows.map((r) => [r.id, r.menu]))).toEqual({
      // cn-v1175 (R8): the city's Final Inspection (work) keeps Dismiss; a sales visit ends Not Sold.
      // cn-v1181 (I1): Open Inspection first, except where the boxed button already says it (cu-1).
      // cn-v1181 (I2a): a sales visit that hangs on nobody has Dismiss… beside Not Sold (cu-2, nd-2, ms-1).
      "cu-1": "move,del",
      "cu-2": "open,move,lost,del",
      "nd-1": "open,pickDay,lost",
      "nd-2": "open,pickDay,lost,del",
      "nb-1": "open,lost",
      "ms-1": "open,move,happened,lost,del",
    });
  });

  it("with Estimates off a row waiting on a price says Open Inspection and Inspected, and its ⋯ is Not Sold alone", async () => {
    state.features = { estimates: false };
    const rows = rowsOf(await render());
    const wu = rows.filter((r) => r.state === "write_up");
    // cn-v1171 (skeptic #74): nothing says an estimate is needed where the company makes none.
    expect(wu.map((r) => [r.primary, r.menu, r.word])).toEqual([
      [["Open Inspection", "/appointments/wu-1"], "lost", "Inspected"],
      [["Won · Start the Job", "/appointments/nb-1?won=1"], "open,lost", "Won, No Job Picked"],
      [["Open Inspection", "/appointments/wu-2"], "lost", "Inspected"],
    ]);
    const html = await render();
    expect(html).not.toContain("/quotes/new");
    expect(html).not.toContain("Needs an Estimate");
  });

  it("the state word and It Happened's toast follow the Estimates switch, in both languages (cn-v1171, skeptic #74)", () => {
    const en = translator("en");
    const es = translator("es");
    expect(en(stateWordKey("write_up", true)!)).toBe("Needs an Estimate");
    expect(en(stateWordKey("write_up", false)!)).toBe("Inspected");
    expect(es(stateWordKey("write_up", false)!)).toBe("Inspeccionada");
    expect(en(happenedSaidKey(true))).toBe("Marked as happened. It needs an estimate now.");
    expect(en(happenedSaidKey(false))).toBe("Marked as happened.");
    expect(es(happenedSaidKey(false))).toBe("Marcada como hecha.");
    expect(stateWordKey("coming_up", false)).toBeNull();
    // The page hands each row its finished toast; the menu says it and words nothing itself.
    // cn-v1172: the row builder left the page for ./row-words, which both pages use.
    const page = readFileSync(join(process.cwd(), "src/app/(app)/inspections/row-words.ts"), "utf8");
    expect(page).toContain("happenedSaid: t(happenedSaidKey(estimatesOn)),");
    const menu = readFileSync(join(process.cwd(), "src/app/(app)/inspections/inspection-row-menu.tsx"), "utf8");
    expect(menu).toContain("markItHappened(row.id, io, row.happenedSaid)");
    expect(menu).not.toContain('io.t("ip_movedToWriteUp")');
  });

  it("the state words are plain slate, never amber, never a pill; the page has no red and no amber", async () => {
    const html = await render();
    expect(html).toMatch(/<span class="text-xs font-medium text-slate-500" data-state-word="">Needs a Day<\/span>/);
    expect(html).not.toMatch(/amber-|red-|rounded-full/);
    for (const f of ["page.tsx", "inspection-list.tsx", "row-words.ts"]) expect(readFileSync(join(process.cwd(), "src/app/(app)/inspections", f), "utf8")).not.toMatch(/amber-|red-/);
  });
});

// cn-v1175 (R8): THE FOLD IS NOT SOLD. Every inspection that ended without becoming work (its record says
// Not Sold, or it was cancelled) and has no person's file; each row says its own state word. A win with
// no job picked is never in it (it is on the list above, asking for its job).
describe("Not Sold: one shut fold under the list", () => {
  it("only the Not Sold and cancelled visits with no lead, no customer and no job, each to its visit, with its day and its own word", async () => {
    const fold = foldOf(await render())!;
    expect(fold.tag).not.toContain("open");
    expect(fold.summary).toBe("Not Sold (2)");
    expect(fold.line).toBe("Inspections that ended without becoming work and have no lead, customer or job to keep them. Each one says how it ended.");
    expect(fold.rows.map((r) => [r.id, r.href, r.ending])).toEqual([
      ["nb-2", "/appointments/nb-2", "Dec 4, 2025 · Not Sold"],
      ["nb-3", "/appointments/nb-3", "Cancelled"],
    ]);
    expect(fold.rows.map((r) => r.id)).not.toContain("nb-1");
    // cn-v1181 (I2b): each row opens its visit AND has Delete… beside it (the ask comes on the tap).
    expect(fold.rows.map((r) => r.del)).toEqual([
      ["nb-2", "Delete…"],
      ["nb-3", "Delete…"],
    ]);
  });

  it("Spanish", async () => {
    state.language = "es";
    const fold = foldOf(await render())!;
    expect(fold.summary).toBe("No Vendidas (2)");
    expect(fold.line).toBe("Inspecciones que terminaron sin convertirse en trabajo y no tienen prospecto, cliente ni trabajo donde guardarlas. Cada una dice cómo terminó.");
    expect(fold.rows.map((r) => r.ending?.split(" · ").pop())).toEqual(["No Vendida", "Cancelada"]);
    expect(fold.rows.map((r) => r.del?.[1])).toEqual(["Eliminar…", "Eliminar…"]);
  });

  it("no fold when nothing hangs on nobody", async () => {
    state.visits = structuredClone([...OPEN, FILED_JOB, FILED_CUST]);
    expect(foldOf(await render())).toBeNull();
  });
});

describe("the empty list", () => {
  it("Leads on: nobody is waiting, an inspection is scheduled from a lead, and Go to Leads", async () => {
    state.visits = [];
    const html = await render();
    expect(rowsOf(html)).toEqual([]);
    expect(decode(html)).toContain("Nobody is waiting on an inspection");
    expect(decode(html)).toContain("An inspection is scheduled from a lead.");
    expect(html).toMatch(/<a class="[^"]*" href="\/leads">Go to Leads<\/a>|<a href="\/leads" class="[^"]*">Go to Leads<\/a>/);
    state.language = "es";
    const es = decode(await render());
    expect(es).toContain("Nadie está esperando una inspección");
    expect(es).toContain("Ir a Prospectos");
  });

  it("Leads off: the existing line and no door to Leads", async () => {
    state.visits = [];
    state.features = { leads: false };
    const html = await render();
    expect(decode(html)).toContain("Nothing open right now.");
    expect(html).not.toContain('href="/leads"');
  });

  it("the fold still shows under an empty list", async () => {
    state.visits = structuredClone([NOBODY_OFF]);
    const html = await render();
    expect(rowsOf(html)).toEqual([]);
    expect(foldOf(html)?.rows.map((r) => r.id)).toEqual(["nb-3"]);
  });
});

describe("what left the page, and the read", () => {
  const src = readFileSync(join(process.cwd(), "src/app/(app)/inspections/page.tsx"), "utf8");

  it("the old Filed view's address lands on the one list", async () => {
    await expect(render({ view: "completed" })).rejects.toThrow("NEXT_REDIRECT /inspections");
  });

  it("no button in the header, no booking door and no blank Start an Inspection; no switch", async () => {
    expect(src).not.toMatch(/NewInspectionButton|AppointmentButton|view=completed|getSchedulePickerOptions/);
    expect(src).toContain('<PageHeader title={t("nv_page_inspections")} description={t("nv_desc_inspections")} />');
    const html = await render();
    expect(decode(html)).not.toMatch(/Book an Inspection|Start an Inspection|\bOpen \| Filed|>Filed</);
    expect(html).not.toMatch(/>Filed</);
  });

  it("the read names customer_id (a row's file, and the fold's nobody) and asks for no money column", async () => {
    await render();
    expect(state.selects).toHaveLength(1);
    const cols = state.selects[0].split(",").map((c) => c.trim());
    expect(cols).toContain("customer_id");
    expect(state.selects[0]).not.toMatch(/\*|amount|total|price|rate/);
  });

  it("exactly 500 read: the page says only the 500 latest are listed; 499 says nothing", async () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => visit(`v-${i}`, { starts_at: at("2026-11-12") }));
    state.visits = many(500);
    expect(decode(await render())).toContain("Showing the 500 latest inspections. Older ones are not listed.");
    state.visits = many(499);
    expect(decode(await render())).not.toContain("Showing the");
  });

  it("every new clickable is Title Case in both languages", async () => {
    const { translator } = await import("@/lib/i18n");
    for (const lang of ["en", "es"] as const) {
      const t = translator(lang);
      for (const k of ["ip_btn_startInspection", "ip_btn_openInspection", "ip_btn_goToLeads", "ip_btn_createEstimate"]) expect(titleCaseIn(t(k), lang), `${lang} ${k}`).toBe(true);
      expect(titleCaseIn(t("ip_btn_notSoldFold").replace(" ({n})", ""), lang), `${lang} fold`).toBe(true);
      // cn-v1175 (R5): the offer's two buttons, with a job named in them.
      for (const k of ["ip_btn_doneAs", "ip_btn_doneAsYes"]) expect(titleCaseIn(t(k).replace("{job}", "J-900").replace(/^¿|\?$/g, ""), lang), `${lang} ${k}`).toBe(true);
      // cn-v1181 (I2b, I3): the fold's Delete… and its deed; Won · Start the Job behind the ⋯ is the visit page's own key.
      for (const k of ["ip_btn_deleteVisit", "ip_btn_deleteVisitIt", "vi_btn_wonStartTheJob"]) expect(titleCaseIn(t(k).replace(/…$/, ""), lang), `${lang} ${k}`).toBe(true);
    }
  });
});

describe("nobody falls between Inspections and Estimates (cn-v1172)", () => {
  const lineOf = (html: string) => {
    const m = /<div data-to-estimate=""[^>]*>([\s\S]*?)<\/div>/.exec(html);
    return m ? { text: decode(/<span>([\s\S]*?)<\/span>/.exec(m[1])?.[1] ?? ""), href: hrefOf(/<a [^>]*>/.exec(m[1])?.[0] ?? ""), door: decode(/<a [^>]*>([\s\S]*?)<\/a>/.exec(m[1])?.[1] ?? "") } : null;
  };

  it("Estimates on: under the list, how many are waiting on an estimate, and Go to Estimates", async () => {
    const html = await render();
    expect(lineOf(html)).toEqual({ text: "2 inspected and waiting on an estimate.", href: "/quotes", door: "Go to Estimates" });
    // Plain slate, never amber.
    expect(/<div data-to-estimate=""[^>]*>/.exec(html)![0]).toContain("text-slate-600");
    state.language = "es";
    expect(lineOf(await render())).toEqual({ text: "2 inspeccionadas y esperando un presupuesto.", href: "/quotes", door: "Ir a Presupuestos" });
  });

  it("Estimates off: the inspected ones stay on this list in their place, and there is no line", async () => {
    state.features = { estimates: false };
    const html = await render();
    expect(rowsOf(html).map((r) => r.id)).toEqual(["cu-1", "cu-2", "nd-1", "nd-2", "wu-1", "nb-1", "wu-2", "ms-1"]);
    expect(lineOf(html)).toBeNull();
  });

  it("only inspected ones open: the empty state says nobody is waiting on an inspection, AND points at the two on Estimates", async () => {
    state.visits = structuredClone([WU_OLD, WU_NEW]);
    const html = await render();
    expect(rowsOf(html)).toEqual([]);
    expect(decode(html)).toContain("Nobody is waiting on an inspection");
    expect(lineOf(html)).toEqual({ text: "2 inspected and waiting on an estimate.", href: "/quotes", door: "Go to Estimates" });
    expect(html).toContain('href="/leads"');
  });

  it("no inspected ones: no line", async () => {
    state.visits = structuredClone([CU_SOON]);
    expect(lineOf(await render())).toBeNull();
  });

  it("the page reads through the one reader both pages use, and words its rows with the one builder", () => {
    const src = readFileSync(join(process.cwd(), "src/app/(app)/inspections/page.tsx"), "utf8");
    expect(src).toContain("readInspectionBuckets(supabase, { now })");
    expect(src).toContain("inspectionList(buckets, now, tz, { estimatesOn })");
    expect(src).toContain("inspectionRowBuilder({ t, lang, tz, now, estimatesOn })");
    expect(src).not.toMatch(/bucketInspections|from\("appointments"\)|from\("quotes"\)/);
  });
});

describe("a failed read is said, never drawn as nobody (cn-v1172)", () => {
  for (const table of ["appointments", "quotes", "invoices", "organizations"]) {
    it(`${table} unread`, async () => {
      state.failTable = table;
      const html = await render();
      expect(rowsOf(html)).toEqual([]);
      expect(decode(html)).toContain("The inspections couldn't load. Reload to try again.");
      expect(decode(html)).not.toContain("Nobody is waiting on an inspection");
      expect(foldOf(html)).toBeNull();
    });
  }

  it("Spanish", async () => {
    state.failTable = "quotes";
    state.language = "es";
    expect(decode(await render())).toContain("No se pudieron cargar las inspecciones. Recarga para intentar de nuevo.");
  });

  it("Title Case: the new door, both languages", () => {
    for (const lang of ["en", "es"] as const) expect(titleCaseIn(translator(lang)("ip_btn_goToEstimates"), lang), lang).toBe(true);
  });
});
