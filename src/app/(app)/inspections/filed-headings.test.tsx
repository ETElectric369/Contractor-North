import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { cloneElement, createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * THE FILED PILE HAS THREE TILES, AND LOST IS ONE OF THEM (cn-v1158; found by the review of cn-v1157).
 *
 * The Didn't Happen? tile asks about a visit that was scheduled, is past and holds no notes, and one
 * of its answers is Lost. The answer is the visit's outcome; its status stays 'scheduled'. The page
 * once split the filed pile on STATUS alone, anything not cancelled under "Completed & written up", so
 * a visit that never happened was filed as completed and written up. The owner's rule: a visit that
 * did not become work is LOST, everywhere. So which tile a filed row sits under is by outcome, whatever
 * the status (lib/inspections filedUnder, through tileInspections), and the Filed view draws
 * Completed, Lost, Cancelled, in that order; a tile with nothing in it is drawn dimmed with no number.
 *
 * This renders THE PAGE ITSELF against a fake database (made-up people and streets), in English and
 * in Spanish, opening each tile through the board the page built, with that tile first (what the
 * phone draws when the address's hash names it, the way Back lands on one). The row's ⋯
 * is drawn as a marker carrying the moves the page handed it: this is about the tiles and which rows
 * sit under each.
 */

const state = vi.hoisted(() => ({
  visits: [] as Record<string, unknown>[],
  language: undefined as string | undefined,
}));

/** Every read answers empty, except the visits, the signed-in person and the company. */
function fakeClient() {
  const answer = (table: string): unknown[] => {
    if (table === "appointments") return state.visits;
    if (table === "profiles") return [{ id: "user-1", role: "owner", language: state.language, full_name: "The Office", org_id: "org-1", active: true }];
    if (table === "organizations") return [{ settings: { timezone: "America/Los_Angeles" } }];
    return [];
  };
  const chain = (table: string) => {
    const q: any = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "then") return (ok: any, err: any) => Promise.resolve({ data: answer(table), error: null }).then(ok, err);
          if (prop === "maybeSingle" || prop === "single") return async () => ({ data: answer(table)[0] ?? null, error: null });
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
// The row's ⋯, as a marker carrying the moves the page offered on that row.
vi.mock("./inspection-row-menu", () => ({
  InspectionRowMenu: ({ row }: { row: { menu: unknown } }) => createElement("span", { "data-menu": JSON.stringify(row.menu) }),
}));
vi.mock("../appointments/appointment-button", () => ({
  AppointmentButton: ({ buttonLabel }: { buttonLabel?: string }) => createElement("span", { "data-door": "book" }, buttonLabel),
}));
vi.mock("../appointments/new-inspection-button", () => ({
  NewInspectionButton: ({ schedule }: { schedule?: React.ReactNode }) => createElement("span", { "data-door": "new" }, schedule),
}));

const at = (day: string) => `${day}T18:00:00Z`;
/** A visit as the page's own select hands it over; completed, with nothing settling it, unless said. */
const visit = (id: string, over: Record<string, unknown>) => ({
  id,
  type: "inspection",
  title: "Inspection",
  status: "completed",
  starts_at: at("2026-11-03"),
  ends_at: null,
  created_at: at("2026-10-20"),
  location: null,
  capture: null,
  inquiry_id: null,
  job_id: null,
  outcome: null,
  customers: null,
  inquiries: null,
  ...over,
});

// Became work: on a job. And one somebody marked Won.
const WRITTEN_UP = visit("done-1", { title: "Panel upgrade", job_id: "job-1", starts_at: at("2026-11-07"), customers: { name: "Sam Tillery" }, location: "12 Larkspur Ln" });
const WON = visit("won-1", { title: "Hot tub circuit", outcome: "won", starts_at: at("2026-11-06") });
// THE ROW THIS IS ABOUT: scheduled, past, nothing on it, answered Lost from the Didn't Happen? tile.
// Its stock title gives way to who (bold) and where (the phrase under it).
const NEVER_HAPPENED = visit("lost-missed", { status: "scheduled", outcome: "lost", starts_at: at("2026-11-05"), customers: { name: "Dana Rook" }, location: "9 Snowbell Ct" });
// Happened, and the bid was lost.
const LOST_BID = visit("lost-done", { title: "Garage subpanel", outcome: "lost", starts_at: at("2026-11-04"), customers: { name: "Theo Vance" }, location: "4 Bayberry Rd" });
// Called off AND marked lost: the answer outranks the status.
const LOST_AND_CANCELLED = visit("lost-cancelled", { title: "Car charger", status: "cancelled", outcome: "lost", starts_at: at("2026-11-02"), customers: { name: "Casey Loam" }, location: "7 Thistlewood Dr" });
// The old word for the same ending (0205): a few rows still hold it.
const NO_BID = visit("no-bid", { title: "Deck lighting", outcome: "no_bid", starts_at: at("2026-11-01") });
// Called off, and nobody said it was lost.
const CALLED_OFF = visit("cancelled-1", { title: "Service change", status: "cancelled", starts_at: at("2026-10-30"), location: "2 Catbird Way" });
const ALL = [WRITTEN_UP, WON, NEVER_HAPPENED, LOST_BID, LOST_AND_CANCELLED, NO_BID, CALLED_OFF];

const decode = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;|&#39;/g, "'").replace(/\s+/g, " ").trim();
/** The tiles as drawn: id, name, the number (null when none is drawn), pressed. */
const tilesOf = (html: string) =>
  [...html.matchAll(/<button[^>]*data-tile="([^"]+)"[^>]*>([\s\S]*?)<\/button>/g)].map((m) => ({
    id: m[1],
    name: decode(/font-semibold leading-tight text-slate-900">([\s\S]*?)<\/span>/.exec(m[2])?.[1] ?? ""),
    count: /text-xl[^"]*">(\d+)</.exec(m[2])?.[1] ?? null,
    pressed: /aria-pressed="true"/.test(m[0]),
  }));
/** The open tile's region: its heading, the who of each row in order, and its own markup. */
const region = (html: string) => {
  const m = /<div id="[^"]*" role="region"[^>]*>([\s\S]*)$/.exec(html);
  const body = m?.[1] ?? "";
  return {
    heading: decode(/<h2[^>]*>([\s\S]*?)<\/h2>/.exec(body)?.[1] ?? ""),
    rows: [...body.matchAll(/data-who="">([\s\S]*?)<\/span>/g)].map((x) => decode(x[1])),
    html: body,
  };
};

let InspectionsPage: (p: { searchParams: Promise<{ view?: string }> }) => Promise<unknown>;
let InspectionsBoard: unknown;
let LangProvider: (p: { lang: "en" | "es"; children: React.ReactNode }) => React.ReactElement;
beforeAll(async () => {
  // The page asks the clock which visits are past: a fixed one, after every fixture's day.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-10T18:00:00Z"));
  InspectionsPage = (await import("./page")).default as any;
  InspectionsBoard = (await import("./inspections-board")).InspectionsBoard;
  LangProvider = (await import("@/components/lang-provider")).LangProvider as any;
}, 30_000);
afterAll(() => vi.useRealTimers());
beforeEach(() => {
  state.visits = structuredClone(ALL);
  state.language = undefined;
});

/** The page's tree with its board opening `tile` first; every other element as the page built it. */
const openOn = (node: unknown, tile: string): unknown => {
  if (Array.isArray(node)) return node.map((n) => openOn(n, tile));
  if (!isValidElement(node)) return node;
  if (node.type === InspectionsBoard) return cloneElement(node as React.ReactElement<any>, { defaultOpen: tile });
  const kids = (node.props as { children?: unknown }).children;
  return kids === undefined ? node : cloneElement(node as React.ReactElement<any>, {}, ...([] as React.ReactNode[]).concat(openOn(kids, tile) as React.ReactNode));
};
const render = async (view?: "completed", tile?: string) => {
  let page = (await InspectionsPage({ searchParams: Promise.resolve(view ? { view } : {}) })) as React.ReactElement;
  if (tile) page = openOn(page, tile) as React.ReactElement;
  return renderToStaticMarkup(createElement(LangProvider, { lang: state.language === "es" ? "es" : "en", children: page }));
};
/** Each filed tile opened in turn: its name, and the who of its rows. */
const filedRows = async () => {
  const out: [string, string[]][] = [];
  for (const id of ["completed", "lost", "cancelled"]) {
    const html = await render("completed", id);
    const tile = tilesOf(html).find((x) => x.id === id)!;
    out.push([tile.name, tile.pressed ? region(html).rows : []]);
  }
  return out;
};

describe("the filed tiles: Completed, Lost, Cancelled", () => {
  it("English: the three tiles in that order, each row under the one its OUTCOME names", async () => {
    const html = await render("completed");
    expect(tilesOf(html).map((x) => [x.id, x.name, x.count])).toEqual([
      ["completed", "Completed", "2"],
      ["lost", "Lost", "4"],
      ["cancelled", "Cancelled", "1"],
    ]);
    expect(await filedRows()).toEqual([
      ["Completed", ["Sam Tillery", "Hot tub circuit"]],
      // Whatever the status: still scheduled, completed, cancelled; lost and the old no_bid alike.
      ["Lost", ["Dana Rook", "Theo Vance", "Casey Loam", "Deck lighting"]],
      ["Cancelled", ["Service change"]],
    ]);
  });

  it("Spanish: Terminadas, Perdidas, Canceladas, over the same rows, with no English tile name left", async () => {
    state.language = "es";
    const rows = await filedRows();
    expect(rows).toEqual([
      ["Terminadas", ["Sam Tillery", "Hot tub circuit"]],
      ["Perdidas", ["Dana Rook", "Theo Vance", "Casey Loam", "Deck lighting"]],
      ["Canceladas", ["Service change"]],
    ]);
    for (const [name] of rows) expect(name).not.toMatch(/Lost|Cancelled|Completed|written/);
  });

  it("the visit that never happened is not filed as completed and written up, in either language", async () => {
    for (const lang of [undefined, "es"]) {
      state.language = lang;
      expect(region(await render("completed", "completed")).html, String(lang)).not.toContain('href="/appointments/lost-missed"');
      expect(region(await render("completed", "lost")).html, String(lang)).toContain('href="/appointments/lost-missed"');
    }
  });

  it("every filed row is drawn once, under one tile", async () => {
    const seen: string[] = [];
    for (const id of ["completed", "lost", "cancelled"]) {
      const html = region(await render("completed", id)).html;
      for (const v of ALL) if (html.includes(`href="/appointments/${v.id}"`)) seen.push(String(v.id));
      for (const v of ALL) expect(html.split(`href="/appointments/${v.id}"`).length - 1, `${id} ${v.id}`).toBeLessThanOrEqual(1);
    }
    expect(seen.sort()).toEqual(ALL.map((v) => String(v.id)).sort());
  });
});

describe("a tile with no rows is drawn dimmed, with no number", () => {
  /** The tiles that have a number, by name. */
  const counted = async () => tilesOf(await render("completed")).filter((x) => x.count !== null).map((x) => x.name);

  it("only lost rows: Lost alone", async () => {
    state.visits = structuredClone([NEVER_HAPPENED, NO_BID]);
    expect(await counted()).toEqual(["Lost"]);
    state.language = "es";
    expect(await counted()).toEqual(["Perdidas"]);
  });

  it("nothing lost: Completed and Cancelled, and no number on Lost between them", async () => {
    state.visits = structuredClone([WRITTEN_UP, WON, CALLED_OFF]);
    expect(await counted()).toEqual(["Completed", "Cancelled"]);
    state.language = "es";
    expect(await counted()).toEqual(["Terminadas", "Canceladas"]);
  });

  it("only one tile at a time, each of the other two", async () => {
    state.visits = structuredClone([WRITTEN_UP]);
    expect(await counted()).toEqual(["Completed"]);
    state.visits = structuredClone([CALLED_OFF]);
    expect(await counted()).toEqual(["Cancelled"]);
  });

  it("a cancelled visit marked Lost empties Cancelled, not Lost", async () => {
    state.visits = structuredClone([LOST_AND_CANCELLED]);
    expect(await counted()).toEqual(["Lost"]);
  });

  it("nothing filed at all: the empty state, and no tile", async () => {
    state.visits = [];
    const html = await render("completed");
    expect(tilesOf(html)).toEqual([]);
    expect(decode(html)).toContain("Nothing filed away yet");
  });
});

describe("the rows keep their own row and doors", () => {
  it("a filed row opens its visit and carries no button: no Create Estimate, no verb, no ⋯", async () => {
    for (const id of ["completed", "lost", "cancelled"]) {
      const r = region(await render("completed", id));
      expect(r.html, id).not.toMatch(/<button/);
      expect(r.html, id).not.toContain("/quotes/new");
      expect(r.html, id).not.toContain("data-verb");
      expect(r.html, id).not.toContain("data-menu");
    }
    expect(region(await render("completed", "lost")).html).toContain('href="/appointments/lost-done"');
  });

  it("the cancelled visit under Lost still says it was cancelled, on its own row; under Cancelled the tile says it", async () => {
    const lost = region(await render("completed", "lost"));
    expect(decode(lost.html).match(/\bcancelled\b/g)).toHaveLength(1);
    const cancelled = region(await render("completed", "cancelled"));
    // The rows say no "cancelled" of their own: the tile's name and its heading already do.
    expect(decode(cancelled.html.replace(/<h2[\s\S]*?<\/h2>/, "")).match(/\bcancelled\b/gi)).toBeNull();
    expect(cancelled.heading).toBe("Cancelled · 1");
    state.language = "es";
    const perdidas = region(await render("completed", "lost"));
    expect(decode(perdidas.html).match(/\bcancelada\b/g)).toHaveLength(1);
  });

  it("the open view: the answered visit is in none of the open tiles; one nobody answered still asks", async () => {
    const unanswered = visit("missed-1", { status: "scheduled", title: "Attic fan", starts_at: at("2026-11-06") });
    state.visits = structuredClone([...ALL, unanswered]);
    const html = await render();
    expect(tilesOf(html).map((x) => [x.id, x.count])).toEqual([
      ["write_up", null],
      ["coming_up", null],
      ["needs_day", null],
      ["missed", "1"],
    ]);
    const r = region(html);
    expect([r.heading, r.rows]).toEqual(["Didn't Happen? · 1", ["Attic fan"]]);
    // Its answers are still the row's: in its ⋯, It Happened and Lost beside Move and Delete.
    expect(r.html).toContain(`data-menu="${JSON.stringify({ move: true, happened: true, lost: true, del: true }).replace(/"/g, "&quot;")}"`);
  });
});

describe("in the source: ONE rule decides the tile", () => {
  const page = readFileSync(join(process.cwd(), "src/app/(app)/inspections/page.tsx"), "utf8");

  it("each row is placed once by tileInspections (filedUnder within it); the page tests no status and no outcome of its own", () => {
    expect(page).toMatch(/import \{[^}]*\btileInspections\b[^}]*\} from "@\/lib\/inspections";/);
    expect(page).toContain("const byTile = tileInspections({ toWriteUp, upcoming, missed, filed }, now, tz);");
    expect(page).not.toMatch(/\.status\s*[!=]==\s*"cancelled"/);
    expect(page).not.toMatch(/\.outcome\b/);
    // The filed tiles are drawn in the library's order (FILED_TILES), never a list of the page's own.
    expect(page).toContain("tilesOf(view).map(");
  });

  it("the page reads the outcome with its rows: the column is in its select, beside the status", () => {
    // The projection law: filedUnder can only name Lost for a row whose read brought the answer back.
    const cols = (/\.from\("appointments"\)\s*\.select\(\s*"([^"]*)"/.exec(page)?.[1] ?? "").split(/,\s*/);
    expect(cols).toContain("outcome");
    expect(cols).toContain("status");
  });

  it("the tile's words: Lost and Perdidas, a pile's name beside Terminadas and Canceladas; the row's answer stays Perdida", async () => {
    const { translator } = await import("@/lib/i18n");
    expect(translator("en")("ip_btn_tileLost")).toBe("Lost");
    expect(translator("es")("ip_btn_tileLost")).toBe("Perdidas");
    expect(translator("es")("ip_btn_lost")).toBe("Perdida");
    expect(translator("es")("ip_btn_tileCancelled")).toBe("Canceladas");
    expect(translator("es")("ip_btn_tileCompleted")).toBe("Terminadas");
  });
});
