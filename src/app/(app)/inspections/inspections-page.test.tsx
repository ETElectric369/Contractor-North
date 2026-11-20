import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { titleCaseIn } from "../../../../tests/title-case-words";
import { happenedSaidKey, primaryOf, rowDoors, stateWordKey } from "./list-rows";
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
          if (prop === "then") return (ok: any, err: any) => Promise.resolve({ data: answer(table), error: null }).then(ok, err);
          if (prop === "maybeSingle" || prop === "single") return async () => ({ data: answer(table)[0] ?? null, error: null });
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
    rows: [...m[1].matchAll(/<li data-fold-row="([^"]+)">(<a [^>]*>)([\s\S]*?)<\/a><\/li>/g)].map((r) => ({
      id: r[1],
      href: hrefOf(r[2]),
      text: decode(r[3]),
      ending: field(r[3], "ending"),
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
    expect(d("coming_up", "start")).toEqual(["move", "del"]);
    expect(d("needs_day", "start", true, false)).toEqual(["pickDay", "del"]);
    expect(d("write_up", "estimate")).toEqual(["open", "lost"]);
    expect(d("write_up", "open")).toEqual(["lost"]);
    expect(d("write_up", "estimate", false)).toEqual(["open"]);
    expect(d("write_up", "open", false)).toEqual([]);
    expect(d("missed", "start")).toEqual(["move", "happened", "lost", "del"]);
    expect(d("missed", "open", false)).toEqual(["move", "happened", "del"]);
    // No Move without a start: there is no time of day to keep.
    expect(d("coming_up", "start", true, false)).toEqual(["del"]);
  });
});

describe("one list: who needs an inspection", () => {
  it("every open inspection once, in the list's order, each a card of its own", async () => {
    const html = await render();
    const rows = rowsOf(html);
    expect(rows.map((r) => [r.id, r.state])).toEqual([
      ["cu-1", "coming_up"],
      ["cu-2", "coming_up"],
      ["nd-1", "needs_day"],
      ["nd-2", "needs_day"],
      ["wu-1", "write_up"],
      ["wu-2", "write_up"],
      ["ms-1", "missed"],
    ]);
    // The Leads list's card: space between, a bold border of its own.
    expect(html).toContain('<ul class="space-y-3">');
    expect(html).toMatch(/<li data-row="cu-1" data-state="coming_up" class="flex flex-col gap-1\.5 rounded-xl border-2 border-slate-200 bg-white px-4 py-3 shadow-sm">/);
    // Nothing filed is on the list.
    for (const v of FILED) expect(rows.map((r) => r.id)).not.toContain(v.id);
  });

  it("English: who (a link to their file), the when, what, the state word and the boxed button", async () => {
    const rows = rowsOf(await render());
    expect(rows.map((r) => [r.who, r.whoHref, r.edge, r.what, r.word, r.primary])).toEqual([
      ["Dana Rook", "/crm/cust-2", "Thu, Nov 12 · 10:00 AM", "9 Snowbell Ct · Final Inspection", null, ["Open Inspection", "/appointments/cu-1"]],
      ["Hot tub circuit", null, "Fri, Nov 20 · 10:00 AM", "Pending pick", null, ["Start Inspection", "/appointments/cu-2"]],
      ["Theo Vance", "/crm/cust-3", "9d ago", "4 Bayberry Rd", "Needs a Day", ["Start Inspection", "/appointments/nd-1"]],
      ["2 Catbird Way", null, "2d ago", null, "Needs a Day", ["Start Inspection", "/appointments/nd-2"]],
      ["Sam Tillery", "/leads/inq-1", "7d ago", "12 Larkspur Ln · no field notes", "Needs an Estimate", ["Create Estimate", "/quotes/new?capture=wu-1&inquiry=inq-1"]],
      ["Attic fan", null, "2d ago", "No field notes", "Needs an Estimate", ["Create Estimate", "/quotes/new?capture=wu-2"]],
      ["Casey Loam", null, "4d ago", "Deck lighting · 7 Thistlewood Dr", "Day Passed", ["Start Inspection", "/appointments/ms-1"]],
    ]);
    // A name with no file is plain words, never a dead link.
    const plain = rowsOf(await render()).find((r) => r.id === "cu-2")!;
    expect(plain.html).toMatch(/<span class="[^"]*font-semibold[^"]*" data-who="">Hot tub circuit<\/span>/);
  });

  it("Spanish: the state words, the buttons and the rows' own words", async () => {
    state.language = "es";
    const rows = rowsOf(await render());
    expect(rows.map((r) => [r.word, r.primary?.[0]])).toEqual([
      [null, "Abrir Inspección"],
      [null, "Empezar Inspección"],
      ["Falta el Día", "Empezar Inspección"],
      ["Falta el Día", "Empezar Inspección"],
      ["Falta el Presupuesto", "Crear Presupuesto"],
      ["Falta el Presupuesto", "Crear Presupuesto"],
      ["Ya Pasó el Día", "Empezar Inspección"],
    ]);
    expect(rows[1].what).toBe("Por elegir");
    expect(rows[4].what).toBe("12 Larkspur Ln · sin notas de campo");
    for (const r of rows) expect(r.edge ?? "").not.toMatch(/ago|Yesterday|Today|Tomorrow|AM|PM/);
  });

  it("each row's ⋯ by state (the city's Final Inspection has no Not Sold)", async () => {
    const rows = rowsOf(await render());
    expect(Object.fromEntries(rows.map((r) => [r.id, r.menu]))).toEqual({
      "cu-1": "move,del",
      "cu-2": "move,del",
      "nd-1": "pickDay,del",
      "nd-2": "pickDay,del",
      "wu-1": "open,lost",
      "wu-2": "open,lost",
      "ms-1": "move,happened,lost,del",
    });
  });

  it("with Estimates off a row waiting on a price says Open Inspection and Inspected, and its ⋯ is Not Sold alone", async () => {
    state.features = { estimates: false };
    const rows = rowsOf(await render());
    const wu = rows.filter((r) => r.state === "write_up");
    // cn-v1171 (skeptic #74): nothing says an estimate is needed where the company makes none.
    expect(wu.map((r) => [r.primary, r.menu, r.word])).toEqual([
      [["Open Inspection", "/appointments/wu-1"], "lost", "Inspected"],
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
    const page = readFileSync(join(process.cwd(), "src/app/(app)/inspections/page.tsx"), "utf8");
    expect(page).toContain("happenedSaid: t(happenedSaidKey(estimateDoor)),");
    const menu = readFileSync(join(process.cwd(), "src/app/(app)/inspections/inspection-row-menu.tsx"), "utf8");
    expect(menu).toContain("markItHappened(row.id, io, row.happenedSaid)");
    expect(menu).not.toContain('io.t("ip_movedToWriteUp")');
  });

  it("the state words are plain slate, never amber, never a pill; the page has no red and no amber", async () => {
    const html = await render();
    expect(html).toMatch(/<span class="text-xs font-medium text-slate-500" data-state-word="">Needs a Day<\/span>/);
    expect(html).not.toMatch(/amber-|red-|rounded-full/);
    for (const f of ["page.tsx", "inspection-list.tsx"]) expect(readFileSync(join(process.cwd(), "src/app/(app)/inspections", f), "utf8")).not.toMatch(/amber-|red-/);
  });
});

describe("filed under nobody: one shut fold under the list", () => {
  it("only the filed visits with no lead, no customer and no job, each to its visit, with its day and how it ended", async () => {
    const fold = foldOf(await render())!;
    expect(fold.tag).not.toContain("open");
    expect(fold.summary).toBe("Not Filed Under Anyone (3)");
    expect(fold.line).toBe("Finished, Not Sold or cancelled inspections with no lead, customer or job to file them under.");
    expect(fold.rows.map((r) => [r.id, r.href, r.ending])).toEqual([
      ["nb-1", "/appointments/nb-1", "Nov 4 · Completed"],
      ["nb-2", "/appointments/nb-2", "Dec 4, 2025 · Not Sold"],
      ["nb-3", "/appointments/nb-3", "Cancelled"],
    ]);
  });

  it("Spanish", async () => {
    state.language = "es";
    const fold = foldOf(await render())!;
    expect(fold.summary).toBe("No Están a Nombre de Nadie (3)");
    expect(fold.rows.map((r) => r.ending?.split(" · ").pop())).toEqual(["Terminada", "No Vendida", "Cancelada"]);
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
      expect(titleCaseIn(t("ip_btn_notFiledFold").replace(" ({n})", ""), lang), `${lang} fold`).toBe(true);
    }
  });
});
