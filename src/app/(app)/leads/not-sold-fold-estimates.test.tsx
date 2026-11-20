import { describe, it, expect, vi, beforeEach } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * THE NOT SOLD FOLD'S SECOND KIND (cn-v1172). Erik, 2026-11-19: "if they are Not Sold then the data
 * stays with them in that file for further sales reach out". After the leads marked Not Sold by hand,
 * the fold lists the leads whose estimate was declined (lib/leads/not-sold-by-estimate): a read,
 * nothing stamped on the lead. Such a row says Estimate Not Sold and has no Reopen.
 *
 * The page is rendered against a stand-in database that records each read; its open list, its rows
 * and its doors are markers (they have their own tests). Made-up people.
 */

const state = vi.hoisted(() => ({
  lang: "en" as "en" | "es",
  features: undefined as Record<string, boolean> | undefined,
  open: [] as { id: string }[],
  hand: [] as Record<string, unknown>[],
  leads: [] as Record<string, unknown>[],
  quotes: [] as Record<string, unknown>[],
  fail: null as string | null,
  calls: [] as { table: string; ops: [string, unknown[]][] }[],
}));

function fakeClient() {
  const from = (table: string) => {
    const call = { table, ops: [] as [string, unknown[]][] };
    state.calls.push(call);
    let range: [number, number] | null = null;
    let ids: string[] | null = null;
    const result = () => {
      if (state.fail === table || (state.fail === "inquiries:in" && table === "inquiries" && ids)) return { data: null, error: { message: "boom" } };
      if (table === "quotes") return { data: range ? state.quotes.slice(range[0], range[1] + 1) : state.quotes, error: null };
      if (table === "inquiries") return { data: ids ? state.leads.filter((l) => ids!.includes(l.id as string)) : state.hand, error: null };
      return { data: [], error: null };
    };
    const q: any = new Proxy(
      {},
      {
        get(_t, prop: string) {
          if (prop === "then") return (ok: any, err: any) => Promise.resolve(result()).then(ok, err);
          if (prop === "maybeSingle") return async () => ({ data: { settings: { timezone: "America/Los_Angeles" }, phone: null }, error: null });
          return (...args: unknown[]) => {
            call.ops.push([prop, args]);
            if (prop === "range") range = [args[0] as number, args[1] as number];
            if (prop === "in") ids = args[1] as string[];
            return q;
          };
        },
      },
    );
    return q;
  };
  return { from };
}

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => fakeClient() }));
vi.mock("next/navigation", () => ({ redirect: (to: string) => { throw new Error(`NEXT_REDIRECT ${to}`); } }));
vi.mock("@/lib/current-lang", () => ({ currentLang: async () => state.lang }));
vi.mock("@/lib/viewer-switches", () => ({ viewerSwitches: async () => ({ features: state.features ?? null, isOwner: true }) }));
vi.mock("@/lib/observe", () => ({ reportError: () => {} }));
vi.mock("@/lib/leads/new-intake", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/leads/new-intake")>()),
  loadNewIntake: async () => ({ leads: state.open, error: null, unread: new Set(), pickPending: new Set(), wonPending: new Set() }),
}));
vi.mock("./inquiry-modal", () => ({ InquiryModal: () => null }));
vi.mock("./inquiry-row", () => ({ InquiryRow: ({ inquiry }: { inquiry: { id: string } }) => createElement("li", { "data-open": inquiry.id }) }));
vi.mock("./referral-tally", () => ({ ReferralTally: () => null }));
vi.mock("./lead-doors", () => ({ ReopenLeadButton: ({ id }: { id: string }) => createElement("button", { "data-reopen": id }, "Reopen") }));

const { default: LeadsPage } = await import("./page");
const { NotSoldFold, NOT_SOLD_FOLD_CAP } = await import("./not-sold-fold");
const { translator } = await import("@/lib/i18n");
const { LangProvider } = await import("@/components/lang-provider");
const { titleCaseIn } = await import("../../../../tests/title-case-words");

const render = async () =>
  renderToStaticMarkup(createElement(LangProvider, { lang: state.lang, children: null }, (await LeadsPage({ searchParams: Promise.resolve({}) })) as React.ReactElement));
const decode = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();
const foldRows = (html: string) =>
  [...html.matchAll(/<li class="flex flex-wrap[^"]*">([\s\S]*?)<\/li>/g)].map((m) => ({
    href: /href="([^"]+)"/.exec(m[1])?.[1] ?? null,
    reopen: /data-reopen="/.test(m[1]),
    declined: /data-by-estimate="">([^<]*)</.exec(m[1])?.[1] ?? null,
  }));
const summaryOf = (html: string) => decode(/<summary[^>]*>([\s\S]*?)<\/summary>/.exec(html)?.[1] ?? "");

const lead = (id: string, name: string) => ({ id, name, company_name: null, message: null });

beforeEach(() => {
  state.lang = "en";
  state.features = undefined;
  state.open = [{ id: "l-open" }];
  state.hand = [lead("l-hand", "Sam Tillery")];
  state.leads = [lead("l-dec", "Dana Rook"), lead("l-hand", "Sam Tillery"), lead("l-open", "Theo Vance"), lead("l-old", "Casey Loam")];
  state.quotes = [
    { inquiry_id: "l-dec", status: "declined" },
    { inquiry_id: "l-hand", status: "declined" },
    { inquiry_id: "l-open", status: "expired" },
    { inquiry_id: "l-live", status: "declined" },
    { inquiry_id: "l-live", status: "sent" },
    { inquiry_id: "l-old", status: "declined" },
  ];
  state.fail = null;
  state.calls = [];
});

describe("the page: both kinds in one fold", () => {
  it("the hand-marked first, then the declined by estimate, each once; a lead with an estimate still out is not there", async () => {
    const html = await render();
    expect(foldRows(html)).toEqual([
      { href: "/leads/l-hand", reopen: true, declined: null },
      { href: "/leads/l-dec", reopen: false, declined: "Estimate Not Sold" },
      { href: "/leads/l-old", reopen: false, declined: "Estimate Not Sold" },
    ]);
    expect(summaryOf(html)).toBe("Not Sold (3)");
  });

  it("pins the reads: every estimate of the company, with or without a lead, read whole and newest first; the leads by id in chunks of fifty", async () => {
    await render();
    const quotes = state.calls.filter((c) => c.table === "quotes");
    expect(quotes[0].ops).toEqual([
      ["select", ["inquiry_id, status, customer_id"]],
      ["order", ["updated_at", { ascending: false }]],
      ["order", ["id"]],
      ["range", [0, 999]],
    ]);
    const byId = state.calls.filter((c) => c.table === "inquiries" && c.ops.some(([op]) => op === "in"));
    expect(byId.map((c) => c.ops)).toEqual([[["select", ["id, name, company_name, message"]], ["in", ["id", ["l-dec", "l-old"]]]]]);
  });

  it("many declined: chunks of fifty, and the count and the cap cover both kinds", async () => {
    const many = Array.from({ length: 120 }, (_, i) => `l-${String(i).padStart(3, "0")}`);
    state.quotes = many.map((id) => ({ inquiry_id: id, status: "declined" }));
    state.leads = many.map((id) => lead(id, "Dana Rook"));
    const html = await render();
    const byId = state.calls.filter((c) => c.table === "inquiries" && c.ops.some(([op]) => op === "in"));
    // One hand-marked plus fifty more is one past the cap: 50 ids, then the one that says it was cut.
    expect(byId.map((c) => (c.ops.find(([op]) => op === "in")![1][1] as string[]).length)).toEqual([50]);
    expect(foldRows(html)).toHaveLength(NOT_SOLD_FOLD_CAP);
    expect(summaryOf(html)).toBe(`Not Sold (${NOT_SOLD_FOLD_CAP})`);
    expect(decode(html)).toContain("Showing the 50 most recent.");
  });

  it("Estimates off: the read is not made, the fold is the hand-marked alone", async () => {
    state.features = { estimates: false };
    const html = await render();
    expect(state.calls.some((c) => c.table === "quotes")).toBe(false);
    expect(foldRows(html).map((r) => r.href)).toEqual(["/leads/l-hand"]);
  });

  it("the hand-marked read failed: the whole fold says so, never drawn as none", async () => {
    state.fail = "inquiries";
    const html = await render();
    expect(decode(html)).toContain("The Not Sold leads couldn't load. Reload to try again.");
    expect(foldRows(html)).toEqual([]);
  });

  for (const fail of ["quotes", "inquiries:in"]) {
    it(`the estimates' part failed (${fail}): the hand-marked rows and their Reopen are drawn, with one line for the rest (cn-v1172 fixer)`, async () => {
      state.fail = fail;
      const html = await render();
      expect(foldRows(html)).toEqual([{ href: "/leads/l-hand", reopen: true, declined: null }]);
      expect(decode(html)).toContain("The leads whose estimate was not sold couldn't load. Reload to try again.");
      expect(decode(html)).not.toContain("The Not Sold leads couldn't load.");
      // No count is said while a part is unread: it would be short.
      expect(summaryOf(html)).toBe("Not Sold");
    });
  }

  it("a declined estimate whose customer accepted a duplicate with no lead on it: the lead is not in the fold (cn-v1172 fixer)", async () => {
    state.hand = [];
    state.quotes = [
      { inquiry_id: "l-dec", status: "declined", customer_id: "c-1" },
      { inquiry_id: null, status: "accepted", customer_id: "c-1" },
      { inquiry_id: "l-old", status: "declined", customer_id: "c-2" },
    ];
    const html = await render();
    expect(foldRows(html)).toEqual([{ href: "/leads/l-old", reopen: false, declined: "Estimate Not Sold" }]);
  });
});

describe("the fold, drawn static in both languages", () => {
  const both = [
    { id: "l1", name: "Sam Tillery", company_name: null, message: "Hot tub circuit" },
    { id: "l2", name: "Dana Rook", company_name: "Larkspur Builders", message: null, byEstimate: true },
  ];

  it("English: Reopen on the hand-marked, Estimate Not Sold in plain slate on the other, and its name opens its file", () => {
    const html = renderToStaticMarkup(createElement(NotSoldFold, { leads: both, cut: false, failed: false, t: translator("en") }));
    expect(foldRows(html)).toEqual([
      { href: "/leads/l1", reopen: true, declined: null },
      { href: "/leads/l2", reopen: false, declined: "Estimate Not Sold" },
    ]);
    expect(html).toContain('<span class="text-xs font-medium text-slate-500" data-by-estimate="">Estimate Not Sold</span>');
    expect(html).not.toMatch(/amber-|red-/);
  });

  it("Spanish", () => {
    const html = renderToStaticMarkup(createElement(LangProvider, { lang: "es", children: null }, createElement(NotSoldFold, { leads: both, cut: false, failed: false, t: translator("es") })));
    expect(foldRows(html)[1].declined).toBe("Presupuesto No Vendido");
    expect(summaryOf(html)).toBe("No Vendidos (2)");
  });

  it("the estimates' part unread, nobody hand-marked: the fold still opens and says so, in both languages", () => {
    const en = renderToStaticMarkup(createElement(NotSoldFold, { leads: [], cut: false, failed: false, estimatesFailed: true, t: translator("en") }));
    expect(decode(en)).toContain("The leads whose estimate was not sold couldn't load.");
    expect(en).not.toContain("<ul");
    const es = renderToStaticMarkup(createElement(LangProvider, { lang: "es", children: null }, createElement(NotSoldFold, { leads: [], cut: false, failed: false, estimatesFailed: true, t: translator("es") })));
    expect(decode(es)).toContain("No se pudieron cargar los prospectos cuyo presupuesto no se vendió.");
  });

  it("the words are Title Case in both languages", () => {
    for (const lang of ["en", "es"] as const) expect(titleCaseIn(translator(lang)("ld_notSoldByEstimate"), lang), lang).toBe(true);
  });
});
