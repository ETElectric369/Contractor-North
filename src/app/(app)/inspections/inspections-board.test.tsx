import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { cloneElement, createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openFirstTile } from "@/lib/inspections";

/**
 * THE INSPECTIONS PAGE AS TILES (cn-v1163; the owner, 2026-11-10: "Go on the Inspections tiles as
 * shown (Write Up, Coming Up, Needs a Day, Didn't Happen?; Filed: Completed, Lost, Cancelled)").
 *
 * The page itself is rendered against a fake database (made-up people and streets), in English and in
 * Spanish. To read a tile the page did not open first, the board the page built is drawn with that
 * tile as its first, which is what the phone does when the address's hash names it. Which tile is open
 * is a pure rule (heldPick, tappedTile, askedTile, tileHref, tileFromHash), executed here. The row's ⋯
 * is drawn as a marker carrying the moves the page handed it; the ⋯ itself is proved in its own test.
 * Node environment: renderToStaticMarkup, no effects, no document.
 */

const state = vi.hoisted(() => ({
  visits: [] as Record<string, unknown>[],
  language: undefined as string | undefined,
  features: undefined as Record<string, boolean> | undefined,
  /** Every .order() asked of the appointments read, in order. */
  orders: [] as unknown[][],
}));

/** Every read answers empty, except the visits, the signed-in person and the company. */
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
          if (prop === "order" && table === "appointments") return (...args: unknown[]) => (state.orders.push(args), q);
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
  InspectionRowMenu: ({ row }: { row: { menu: unknown } }) => createElement("span", { "data-menu": JSON.stringify(row.menu) }),
}));
vi.mock("../appointments/appointment-button", () => ({
  AppointmentButton: ({ buttonLabel }: { buttonLabel?: string }) => createElement("span", { "data-door": "book" }, buttonLabel),
}));
vi.mock("../appointments/new-inspection-button", () => ({
  NewInspectionButton: ({ schedule }: { schedule?: React.ReactNode }) => createElement("span", { "data-door": "new" }, schedule),
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
  outcome: null,
  customers: null,
  inquiries: null,
  ...over,
});

// Write Up: done, nothing written from it. The older first.
const WU_OLD = visit("wu-1", { status: "completed", starts_at: at("2026-11-03"), customers: { name: "Sam Tillery" }, location: "12 Larkspur Ln", inquiry_id: "inq-1" });
const WU_NEW = visit("wu-2", { status: "completed", title: "Attic fan", starts_at: at("2026-11-08") });
// Coming Up: still ahead. The city's Final Inspection says its type; a proposed one says pending pick.
const CU_SOON = visit("cu-1", { type: "final_inspection", title: "Final Inspection", starts_at: at("2026-11-12"), ends_at: "2026-11-12T19:00:00Z", customers: { name: "Dana Rook" }, location: "9 Snowbell Ct" });
const CU_LATER = visit("cu-2", { status: "proposed", title: "Hot tub circuit", starts_at: at("2026-11-20") });
// Needs a Day: booked with no day; the one made first is first.
const ND_NEW = visit("nd-2", { starts_at: null, created_at: at("2026-11-08"), location: "2 Catbird Way" });
const ND_OLD = visit("nd-1", { starts_at: null, created_at: at("2026-11-01"), customers: { name: "Theo Vance" }, location: "4 Bayberry Rd" });
// Didn't Happen?: its day went by, nothing captured.
const MISSED = visit("ms-1", { title: "Deck lighting", starts_at: at("2026-11-06"), customers: { name: "Casey Loam" }, location: "7 Thistlewood Dr" });
// Filed, one under each tile.
const FILED_DONE = visit("fd-1", { status: "completed", title: "Panel upgrade", job_id: "job-1", starts_at: at("2026-11-02") });
const FILED_LOST = visit("fl-1", { status: "completed", outcome: "lost", starts_at: at("2025-12-04"), customers: { name: "Sam Tillery" } });
const FILED_OFF = visit("fc-1", { status: "cancelled", title: "Service change", starts_at: null });
const OPEN = [WU_NEW, WU_OLD, CU_LATER, CU_SOON, ND_NEW, ND_OLD, MISSED];
const ALL = [...OPEN, FILED_DONE, FILED_LOST, FILED_OFF];

const decode = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
const tilesOf = (html: string) =>
  [...html.matchAll(/<button[^>]*data-tile="([^"]+)"[^>]*>([\s\S]*?)<\/button>/g)].map((m) => ({
    id: m[1],
    name: decode(/font-semibold leading-tight text-slate-900">([\s\S]*?)<\/span>/.exec(m[2])?.[1] ?? ""),
    count: /text-xl[^"]*">(\d+)</.exec(m[2])?.[1] ?? null,
    line: decode(/<span class="text-xs leading-snug text-slate-600">([\s\S]*?)<\/span>/.exec(m[2])?.[1] ?? "") || null,
    label: decode(/aria-label="([^"]*)"/.exec(m[0])?.[1] ?? ""),
    pressed: /aria-pressed="true"/.test(m[0]),
    tint: /data-tint="([^"]+)"/.exec(m[2])?.[1] ?? null,
    html: m[0],
  }));
/** A row's own verb: [its tag, its href, its words], or null. */
const verbOf = (row: string): [string, string, string] | null => {
  const m = /(<a [^>]*data-verb=""[^>]*>)([\s\S]*?)<\/a>/.exec(row);
  return m ? [m[1], /href="([^"]*)"/.exec(m[1])?.[1] ?? "", decode(m[2])] : null;
};
/** The open tile's region: its heading and each row's parts. */
const region = (html: string) => {
  const body = /<div id="[^"]*" role="region"[^>]*>([\s\S]*)$/.exec(html)?.[1] ?? "";
  return {
    heading: decode(/<h2[^>]*>([\s\S]*?)<\/h2>/.exec(body)?.[1] ?? ""),
    rows: [...body.matchAll(/<li [^>]*data-row="([^"]+)">([\s\S]*?)<\/li>/g)].map((m) => ({
      id: m[1],
      who: decode(/data-who="">([\s\S]*?)<\/span>/.exec(m[2])?.[1] ?? ""),
      what: decode(/data-what="">([\s\S]*?)<\/span>/.exec(m[2])?.[1] ?? ""),
      edge: decode(/data-edge="">([\s\S]*?)<\/span>/.exec(m[2])?.[1] ?? "") || null,
      verb: verbOf(m[2]),
      menu: /data-menu="([^"]*)"/.exec(m[2])?.[1]?.replace(/&quot;/g, '"') ?? null,
      html: m[2],
    })),
    text: decode(body),
    html: body,
  };
};

let InspectionsPage: (p: { searchParams: Promise<{ view?: string }> }) => Promise<unknown>;
let LangProvider: any;
let InspectionsBoard: any;
let board: typeof import("./inspections-board");
let translator: (lang: string) => (k: string) => string;
beforeAll(async () => {
  // Today is 10 Nov 2026 in the company's timezone.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-10T18:00:00Z"));
  InspectionsPage = (await import("./page")).default as any;
  LangProvider = (await import("@/components/lang-provider")).LangProvider;
  board = await import("./inspections-board");
  InspectionsBoard = board.InspectionsBoard;
  translator = (await import("@/lib/i18n")).translator as any;
}, 30_000);
afterAll(() => vi.useRealTimers());
beforeEach(() => {
  state.visits = structuredClone(ALL);
  state.language = undefined;
  state.features = undefined;
  state.orders = [];
});

/** The board element inside the page's tree, with its props as the page built them. */
const findBoard = (node: unknown): React.ReactElement<any> | null => {
  if (Array.isArray(node)) {
    for (const n of node) {
      const found = findBoard(n);
      if (found) return found;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  if (node.type === InspectionsBoard) return node as React.ReactElement<any>;
  return findBoard((node.props as { children?: unknown }).children);
};
/** The page, drawn. With `tile`, the page's own board opens that tile first: what the phone draws when
 *  the address's hash names it (askedTile, proven below). Without it, the page's first paint. */
const render = async (q: { view?: string; tile?: string } = {}) => {
  const { tile, ...params } = q;
  let page = (await InspectionsPage({ searchParams: Promise.resolve(params) })) as React.ReactElement;
  if (tile) {
    const found = findBoard(page);
    if (!found) throw new Error("the page drew no board");
    const swap = (node: unknown): unknown =>
      node === found
        ? cloneElement(found, { defaultOpen: tile })
        : Array.isArray(node)
          ? node.map(swap)
          : isValidElement(node) && (node.props as { children?: unknown }).children !== undefined
            ? cloneElement(node as React.ReactElement<any>, {}, ...[].concat(swap((node.props as { children?: unknown }).children) as never))
            : node;
    page = swap(page) as React.ReactElement;
  }
  return renderToStaticMarkup(createElement(LangProvider, { lang: state.language === "es" ? "es" : "en" }, page));
};

/** An open view after a deed: Didn't Happen? emptied, Coming Up still holding rows. */
const OPEN_TILES_EMPTIED = [
  { id: "write_up", count: 0 },
  { id: "coming_up", count: 1 },
  { id: "needs_day", count: 0 },
  { id: "missed", count: 0 },
].map(({ id, count }) => ({
  id,
  name: id,
  label: id,
  count,
  line: null,
  rows: Array.from({ length: count }, (_, i) => ({ id: `${id}-${i}`, who: `${id} ${i}`, what: "", edge: null, href: `/appointments/${id}-${i}`, verb: null, menu: null, startsAt: null, endsAt: null })),
}));
const openFirstTileOf = (view: "open" | "filed", counts: Record<string, number>) => openFirstTile(view, counts as never, null);

describe("the switch: Open | Filed", () => {
  it("two pills, the second one says Filed (Archivadas) and still links ?view=completed", async () => {
    const html = await render();
    expect(html).toMatch(/<a [^>]*href="\/inspections\?view=completed"[^>]*>Filed<\/a>/);
    expect(html).toMatch(/<a [^>]*href="\/inspections"[^>]*>Open<\/a>/);
    state.language = "es";
    expect(await render()).toMatch(/href="\/inspections\?view=completed"[^>]*>Archivadas<\/a>/);
  });
});

describe("the tiles of each view, in order, with name, count and line", () => {
  it("Open, English: Write Up · Coming Up · Needs a Day · Didn't Happen?", async () => {
    const tiles = tilesOf(await render());
    expect(tiles.map((x) => [x.id, x.name, x.count, x.line])).toEqual([
      ["write_up", "Write Up", "2", "Oldest: 7d ago"],
      ["coming_up", "Coming Up", "2", "Next: Thu, Nov 12 · 10:00 AM"],
      ["needs_day", "Needs a Day", "2", "Oldest: 9d ago"],
      ["missed", "Didn't Happen?", "1", "Past, no notes"],
    ]);
    // The label is said whole; the open tiles wear Sales' colour.
    expect(tiles[0].label).toBe("Write Up: 2, Oldest: 7d ago");
    expect(tiles.map((x) => x.tint)).toEqual(["win_work", "win_work", "win_work", "win_work"]);
  });

  it("Open, Spanish: Por Redactar · Próximas · Falta el Día · ¿No Se Hizo?", async () => {
    state.language = "es";
    const tiles = tilesOf(await render());
    expect(tiles.map((x) => x.name)).toEqual(["Por Redactar", "Próximas", "Falta el Día", "¿No Se Hizo?"]);
    expect(tiles[3].line).toBe("Ya pasaron, sin notas");
    expect(tiles[0].line).toMatch(/^La más antigua: /);
    for (const x of tiles) expect(x.line ?? "").not.toMatch(/ago|Oldest|Next/);
  });

  it("Filed: Completed · Lost · Cancelled, plain pictures, each with its quiet line", async () => {
    const tiles = tilesOf(await render({ view: "completed" }));
    expect(tiles.map((x) => [x.id, x.name, x.count, x.line, x.tint])).toEqual([
      ["completed", "Completed", "1", "Written up", null],
      ["lost", "Lost", "1", "Didn't become work", null],
      ["cancelled", "Cancelled", "1", "Called off", null],
    ]);
    state.language = "es";
    expect(tilesOf(await render({ view: "completed" })).map((x) => x.line)).toEqual(["Redactadas", "No se volvieron trabajo", "Se cancelaron"]);
  });

  it("a tile with nothing is drawn dimmed, with no number and no line, and its label says nothing is here", async () => {
    state.visits = structuredClone([MISSED]);
    const [writeUp] = tilesOf(await render());
    expect([writeUp.count, writeUp.line, writeUp.label]).toEqual([null, null, "Write Up: nothing here"]);
    expect(writeUp.html).toMatch(/\bdisabled=""/);
  });
});

describe("the open tile's rows: who, what, one edge", () => {
  it("Write Up: oldest first; a nameless one is its title; no field notes is said in the phrase", async () => {
    const r = region(await render({ tile: "write_up" }));
    expect(r.heading).toBe("Write Up · 2");
    expect(r.rows.map((x) => [x.who, x.what, x.edge])).toEqual([
      ["Sam Tillery", "12 Larkspur Ln · no field notes", "7d ago"],
      ["Attic fan", "No field notes", "2d ago"],
    ]);
    // ONE link holds who, what and the edge, to the inspection itself.
    expect(r.rows[0].html).toMatch(/^<a [^>]*href="\/appointments\/wu-1"[^>]*>[\s\S]*data-who[\s\S]*data-edge[\s\S]*data-what[\s\S]*?<\/a>/);
  });

  it("Coming Up: soonest first; the type and the pick are words in the phrase, never a pill", async () => {
    const r = region(await render({ tile: "coming_up" }));
    expect(r.rows.map((x) => [x.who, x.what, x.edge])).toEqual([
      ["Dana Rook", "9 Snowbell Ct · Final Inspection", "Thu, Nov 12 · 10:00 AM"],
      ["Hot tub circuit", "Pending pick", "Fri, Nov 20 · 10:00 AM"],
    ]);
    expect(r.html).not.toContain("rounded-full");
  });

  it("Needs a Day: the one made first is first, its edge how long it has waited; nobody named, the street is who", async () => {
    const r = region(await render({ tile: "needs_day" }));
    expect(r.rows.map((x) => [x.who, x.what, x.edge])).toEqual([
      ["Theo Vance", "4 Bayberry Rd", "9d ago"],
      ["2 Catbird Way", "", "2d ago"],
    ]);
  });

  it("Filed: the edge is the day, the year only when it is not this year; a visit with no day has no edge", async () => {
    expect(region(await render({ view: "completed", tile: "lost" })).rows.map((x) => [x.who, x.edge])).toEqual([["Sam Tillery", "Dec 4, 2025"]]);
    expect(region(await render({ view: "completed", tile: "completed" })).rows.map((x) => [x.who, x.edge])).toEqual([["Panel upgrade", "Nov 2"]]);
    expect(region(await render({ view: "completed", tile: "cancelled" })).rows.map((x) => [x.who, x.edge])).toEqual([["Service change", null]]);
  });

  it("Spanish: the rows' own words and edges are Spanish", async () => {
    state.language = "es";
    const r = region(await render({ tile: "write_up" }));
    expect(r.heading).toBe("Por Redactar · 2");
    expect(r.rows[0].what).toBe("12 Larkspur Ln · sin notas de campo");
    expect(r.rows[1].what).toBe("Sin notas de campo");
    expect(r.rows[0].verb?.[2]).toBe("Crear Presupuesto");
    const cu = region(await render({ tile: "coming_up" }));
    expect(cu.rows[1].what).toBe("Por elegir");
    for (const x of [...r.rows, ...cu.rows]) expect(x.edge ?? "").not.toMatch(/ago|Yesterday|Today|Tomorrow|AM|PM/);
  });
});

describe("each row's doors", () => {
  /** Every row of every open tile, with its tile. */
  const everyRow = async () => {
    const out: { tile: string; row: ReturnType<typeof region>["rows"][number] }[] = [];
    for (const tile of ["write_up", "coming_up", "needs_day", "missed"]) for (const row of region(await render({ tile })).rows) out.push({ tile, row });
    for (const tile of ["completed", "lost", "cancelled"]) for (const row of region(await render({ view: "completed", tile })).rows) out.push({ tile, row });
    return out;
  };

  it("Create Estimate sits on a Write Up row only, built with the capture and the inquiry", async () => {
    const rows = await everyRow();
    expect(rows).toHaveLength(ALL.length);
    for (const { tile, row } of rows) {
      const estimate = row.verb?.[2] === "Create Estimate";
      expect(estimate, `${tile} ${row.id}`).toBe(tile === "write_up");
      if (tile !== "write_up") expect(row.html, row.id).not.toContain("/quotes/new");
    }
    const wu = rows.filter((x) => x.tile === "write_up").map((x) => x.row.verb?.[1]);
    expect(wu).toEqual(["/quotes/new?capture=wu-1&amp;inquiry=inq-1", "/quotes/new?capture=wu-2"]);
  });

  it("with Estimates off, no row has Create Estimate (the Write Up row keeps its ⋯)", async () => {
    state.features = { estimates: false };
    const r = region(await render({ tile: "write_up" }));
    expect(r.rows).toHaveLength(2);
    for (const x of r.rows) {
      expect(x.verb).toBeNull();
      expect(x.html).not.toContain("/quotes/new");
      expect(x.menu).toBe(JSON.stringify({ move: false, happened: false, lost: true, del: false }));
    }
  });

  it("a Needs a Day row says Pick a Day and goes to the schedule; nothing else does", async () => {
    for (const { tile, row } of await everyRow()) {
      if (tile === "needs_day") {
        expect(row.verb?.[1]).toBe("/schedule");
        expect(row.verb?.[2]).toBe("Pick a Day");
      } else expect(row.verb?.[2] ?? "", row.id).not.toBe("Pick a Day");
    }
  });

  it("the ⋯ each tile offers, and none on a filed row (no verb either)", async () => {
    const menu = (o: object) => JSON.stringify({ move: false, happened: false, lost: false, del: false, ...o });
    const want: Record<string, string | null> = {
      write_up: menu({ lost: true }),
      coming_up: menu({ move: true, del: true }),
      needs_day: menu({ del: true }),
      missed: menu({ move: true, happened: true, lost: true, del: true }),
      completed: null,
      lost: null,
      cancelled: null,
    };
    for (const { tile, row } of await everyRow()) {
      expect(row.menu, `${tile} ${row.id}`).toBe(want[tile]);
      if (want[tile] === null) {
        expect(row.verb).toBeNull();
        expect(row.html).not.toContain("data-doors");
      }
    }
  });

  it("the row's verb is brand text on a 44px target, never a filled button", async () => {
    const r = region(await render({ tile: "needs_day" }));
    const verb = r.rows[0].verb![0];
    expect(verb).toMatch(/\bh-11\b/);
    expect(verb).toMatch(/\btext-brand\b/);
    expect(verb).not.toMatch(/[\s"]bg-brand[\s"]|<button/);
    // The row's link is a 44px target too.
    expect(r.rows[0].html).toMatch(/^<a [^>]*class="[^"]*\bmin-h-11\b/);
  });
});

describe("which tile is open", () => {
  const COUNTS = { write_up: 0, coming_up: 3, needs_day: 1, missed: 0, completed: 2, lost: 0, cancelled: 1 };

  it("the page's first paint: the first tile with rows; it reads no tile from the search", async () => {
    expect(tilesOf(await render()).filter((x) => x.pressed).map((x) => x.id)).toEqual(["write_up"]);
    expect(tilesOf(await render({ view: "completed" })).filter((x) => x.pressed).map((x) => x.id)).toEqual(["completed"]);
    state.visits = structuredClone([MISSED, CU_SOON]);
    expect(tilesOf(await render()).filter((x) => x.pressed).map((x) => x.id)).toEqual(["coming_up"]);
    const page = readFileSync(join(process.cwd(), "src/app/(app)/inspections/page.tsx"), "utf8");
    expect(page).toContain("const defaultOpen = openFirstTile(view, counts, null);");
    expect(page).not.toMatch(/searchParams[\s\S]{0,80}\btile\b/);
  });

  it("the address: a hash, set and cleared, the path and the view kept", () => {
    const { tileHref, tileFromHash } = board;
    expect(tileHref("https://x.test/inspections?view=completed", "lost")).toBe("/inspections?view=completed#tile=lost");
    expect(tileHref("https://x.test/inspections?view=completed#tile=lost", null)).toBe("/inspections?view=completed");
    expect(tileHref("https://x.test/inspections#tile=missed", "write_up")).toBe("/inspections#tile=write_up");
    expect(tileHref("https://x.test/inspections", null)).toBe("/inspections");
    expect(tileFromHash("#tile=needs_day")).toBe("needs_day");
    expect(tileFromHash("tile=needs_day")).toBe("needs_day");
    expect(tileFromHash("")).toBeNull();
    expect(tileFromHash("#tile=")).toBeNull();
    expect(tileFromHash("#top")).toBeNull();
    // What it writes, it reads back.
    expect(tileFromHash(new URL(tileHref("https://x.test/inspections?view=completed", "cancelled"), "https://x.test").hash)).toBe("cancelled");
  });

  it("the tile the address asks for counts only when it is this view's and has rows", () => {
    const { askedTile } = board;
    expect(askedTile("open", COUNTS, "#tile=needs_day")).toBe("needs_day");
    expect(askedTile("filed", COUNTS, "#tile=cancelled")).toBe("cancelled");
    // An emptied tile, another view's tile, junk, or no hash: nothing asked, the page's pick stands.
    expect(askedTile("open", COUNTS, "#tile=missed")).toBeNull();
    expect(askedTile("open", COUNTS, "#tile=completed")).toBeNull();
    expect(askedTile("filed", COUNTS, "#tile=coming_up")).toBeNull();
    expect(askedTile("open", COUNTS, "#tile=%3Cscript%3E")).toBeNull();
    expect(askedTile("open", COUNTS, "#elsewhere")).toBeNull();
    expect(askedTile("open", COUNTS, "")).toBeNull();
  });

  it("a tap opens a tile, and a tap on the open one closes it", () => {
    const { tappedTile } = board;
    expect(tappedTile("coming_up", "needs_day")).toBe("needs_day");
    expect(tappedTile("coming_up", "coming_up")).toBeNull();
    expect(tappedTile(null, "missed")).toBe("missed");
  });

  it("the pick is held while the view is the same, re-seeded once when the view changes, then held", () => {
    const { heldPick } = board;
    const pick = { view: "open" as const, open: "needs_day" as const };
    // The same view: the same pick, whatever the page now opens first (a deed changed the counts).
    expect(heldPick(pick, "open", "coming_up")).toBe(pick);
    const closed = { view: "open" as const, open: null };
    expect(heldPick(closed, "open", "coming_up")).toBe(closed);
    // A new view: its first tile, as a new pick...
    const seeded = heldPick(pick, "filed", "completed");
    expect(seeded).toEqual({ view: "filed", open: "completed" });
    // ...stored, and held after: a later first tile (the counts moved) does not move it.
    expect(heldPick(seeded, "filed", "cancelled")).toBe(seeded);
  });

  it("an open tile with no rows left stays open and says so", () => {
    const { heldPick } = board;
    // The person opened Didn't Happen?; its last row was answered and the page read again.
    const after = OPEN_TILES_EMPTIED;
    const counts = Object.fromEntries(after.map((x) => [x.id, x.count]));
    const pageFirst = openFirstTileOf("open", counts);
    expect(pageFirst).toBe("coming_up");
    const held = heldPick({ view: "open", open: "missed" }, "open", pageFirst);
    expect(held.open).toBe("missed");
    // Drawn with the held tile open (the first render a board mounted on it would make).
    const html = renderToStaticMarkup(createElement(InspectionsBoard, { view: "open", tiles: after, defaultOpen: held.open, tz: "UTC", capped: null }));
    expect(tilesOf(html).filter((x) => x.pressed).map((x) => x.id)).toEqual(["missed"]);
    expect(region(html).heading).toBe("missed · 0");
    expect(region(html).text).toContain("Nothing here now.");
  });

  it("with nothing open the region keeps its id for the tiles' aria-controls, and is no region", () => {
    const html = renderToStaticMarkup(createElement(InspectionsBoard, { view: "open", tiles: OPEN_TILES_EMPTIED, defaultOpen: null, tz: "UTC", capped: null }));
    const controls = /aria-controls="([^"]+)"/.exec(html)?.[1];
    expect(controls).toBeTruthy();
    const wrapper = new RegExp(`<div id="${controls!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*>`).exec(html)?.[0];
    expect(wrapper).toBe(`<div id="${controls}">`);
    const open = renderToStaticMarkup(createElement(InspectionsBoard, { view: "open", tiles: OPEN_TILES_EMPTIED, defaultOpen: "coming_up", tz: "UTC", capped: null }));
    expect(open).toMatch(/<div id="[^"]+" role="region" aria-label="coming_up" data-open-tile="coming_up">/);
  });

  it("in the source: one state rule, the hash read on mount only, replaceState for a tap and a row's open, rows keyed by the visit's id alone", () => {
    const src = readFileSync(join(process.cwd(), "src/app/(app)/inspections/inspections-board.tsx"), "utf8");
    expect(src).toContain('window.history.replaceState(null, "", tileHref(window.location.href, next));');
    expect(src).not.toMatch(/router\.(replace|push)|useRouter|useSearchParams/);
    // The first render is the page's; a new view is stored once while rendering, never in an effect.
    expect(src).toContain("useState<TilePick>({ view, open: defaultOpen })");
    expect(src).toContain("const held = heldPick(pick, view, defaultOpen);");
    expect(src).toContain("if (held !== pick) setPick(held);");
    // The hash is read once, before the first paint.
    expect(src).toMatch(/useLayoutEffect\(\(\) => \{\s*const asked = askedTile\(view, counts, window\.location\.hash\);[\s\S]*?\}, \[\]\);/);
    expect(src.match(/window\.location\.hash/g)).toHaveLength(1);
    // A tap and a row's open both write through the one writer.
    expect(src).toContain("writeTile(next);");
    expect(src).toContain("const stamp = () => writeTile(open);");
    expect(src).toContain("<Link href={row.href} onClick={onOpen}");
    expect(src).toContain("<Link href={row.verb.href} onClick={onOpen}");
    expect(src).toContain("<InspectionRow key={row.id} row={row} tz={tz} onOpen={stamp} />");
    expect([...src.matchAll(/\bkey=\{/g)]).toHaveLength(1);
  });
});

describe("the tiles' lines and edges say what is true", () => {
  it("Coming Up's Next is the first visit still ahead; with only earlier-today visits left there is no line", async () => {
    const EARLIER = visit("cu-0", { title: "Bath fan", starts_at: "2026-11-10T16:00:00Z" }); // 8:00 AM today, not closed out
    state.visits = structuredClone([EARLIER, CU_SOON]);
    const both = tilesOf(await render()).find((x) => x.id === "coming_up")!;
    expect(both.line).toBe("Next: Thu, Nov 12 · 10:00 AM");
    expect(region(await render({ tile: "coming_up" })).rows.map((x) => [x.who, x.edge])).toEqual([
      ["Bath fan", "8:00 AM"],
      ["Dana Rook", "Thu, Nov 12 · 10:00 AM"],
    ]);
    state.visits = structuredClone([EARLIER]);
    const alone = tilesOf(await render()).find((x) => x.id === "coming_up")!;
    expect([alone.count, alone.line, alone.label]).toEqual(["1", null, "Coming Up: 1"]);
  });

  it("Write Up's Oldest is the first row that has an edge (a done visit with no day sorts first and has none)", async () => {
    const NO_DAY = visit("wu-0", { status: "completed", title: "Porch light", starts_at: null });
    state.visits = structuredClone([NO_DAY, WU_OLD]);
    const r = region(await render({ tile: "write_up" }));
    expect(r.rows.map((x) => [x.who, x.edge])).toEqual([
      ["Porch light", null],
      ["Sam Tillery", "7d ago"],
    ]);
    expect(tilesOf(await render()).find((x) => x.id === "write_up")?.line).toBe("Oldest: 7d ago");
  });

  it("an age whose day is still ahead says that day, never Tomorrow", async () => {
    const EARLY = visit("wu-3", { status: "completed", title: "Sub panel", starts_at: at("2026-11-11") });
    state.visits = structuredClone([EARLY]);
    expect(region(await render({ tile: "write_up" })).rows.map((x) => x.edge)).toEqual(["Nov 11"]);
    state.language = "es";
    expect(region(await render({ tile: "write_up" })).rows.map((x) => x.edge)).toEqual(["11 nov"]);
  });

  it("a proposed visit whose day went by before today sits under Didn't Happen?, by the page's own now", async () => {
    const LATE = visit("pr-1", { status: "proposed", title: "Hot tub circuit", starts_at: at("2026-11-04") });
    state.visits = structuredClone([LATE]);
    const tiles = tilesOf(await render());
    expect(tiles.map((x) => [x.id, x.count])).toEqual([
      ["write_up", null],
      ["coming_up", null],
      ["needs_day", null],
      ["missed", "1"],
    ]);
    expect(region(await render({ tile: "missed" })).rows.map((x) => [x.who, x.what, x.edge])).toEqual([["Hot tub circuit", "Pending pick", "6d ago"]]);
  });
});

describe("Lost only where it is an answer, and the stamped title", () => {
  it("the city's Final Inspection has no win or loss: no Lost in its ⋯, and a ⋯ with nothing left is none", async () => {
    const FINAL_MISSED = visit("fm-1", { type: "final_inspection", title: "Final Inspection", starts_at: at("2026-11-05"), customers: { name: "Theo Vance" } });
    const FINAL_DONE = visit("fw-1", { type: "final_inspection", title: "Final Inspection", status: "completed", starts_at: at("2026-11-06"), customers: { name: "Casey Loam" } });
    state.visits = structuredClone([FINAL_MISSED, FINAL_DONE]);
    const missed = region(await render({ tile: "missed" })).rows;
    expect(missed.map((x) => x.menu)).toEqual([JSON.stringify({ move: true, happened: true, lost: false, del: true })]);
    const writeUp = region(await render({ tile: "write_up" })).rows;
    expect(writeUp.map((x) => x.menu)).toEqual([null]);
    // Its Create Estimate line stands with no ⋯ beside it.
    expect(writeUp[0].html).toContain('data-doors="line"');
    expect(writeUp[0].html).not.toContain("data-menu");
  });

  it("a title the booking door stamped in English is not taken for typed words by a Spanish reader", async () => {
    const STAMPED = visit("st-1", { type: "final_inspection", title: "Final Inspection", starts_at: at("2026-11-12") });
    state.visits = structuredClone([STAMPED]);
    state.language = "es";
    const [row] = region(await render({ tile: "coming_up" })).rows;
    // Nobody named and nothing typed: the bold line is the type's own label in Spanish, and the phrase
    // does not say it again.
    const label = translator("es")("jb_apptFinalInspection");
    expect(label).not.toBe("Final Inspection");
    expect([row.who, row.what]).toEqual([label, ""]);
  });
});

describe("the empty states and a read cut short", () => {
  it("nothing open: today's empty state with Leads on (and its New Inspection door), no tiles", async () => {
    state.visits = structuredClone([FILED_DONE]);
    const html = await render();
    expect(tilesOf(html)).toEqual([]);
    expect(decode(html)).toContain("No open inspections");
    expect(decode(html)).toContain("Start one from a lead, book one, or tap Start an Inspection when you're already there.");
    expect(html.match(/data-door="new"/g)).toHaveLength(2);
    state.features = { leads: false };
    const off = await render();
    expect(decode(off)).toContain("Nothing open right now.");
    expect(off).not.toContain('data-door="new"');
  });

  it("nothing filed: today's empty state, no tiles; Spanish too", async () => {
    state.visits = structuredClone(OPEN);
    const html = await render({ view: "completed" });
    expect(tilesOf(html)).toEqual([]);
    expect(decode(html)).toContain("Nothing filed away yet");
    state.language = "es";
    expect(decode(await render({ view: "completed" }))).toContain("Aún no hay nada archivado");
  });

  it("the cap never cuts a visit waiting for a day: the read takes them first, then the latest by date", async () => {
    await render();
    expect(state.orders).toEqual([["starts_at", { ascending: false, nullsFirst: true }]]);
    // The read's order is not the screen's: a waiting visit read first still sits under Needs a Day,
    // oldest first, with how long it has waited.
    state.visits = structuredClone([ND_NEW, ND_OLD, CU_LATER, WU_OLD]);
    const r = region(await render({ tile: "needs_day" }));
    expect(r.rows.map((x) => [x.id, x.edge])).toEqual([
      ["nd-1", "9d ago"],
      ["nd-2", "2d ago"],
    ]);
  });

  it("exactly 500 read: the board says only the 500 latest are listed; 499 says nothing", async () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => visit(`v-${i}`, { starts_at: at("2026-11-12") }));
    state.visits = many(500);
    expect(decode(await render())).toContain("Showing the 500 latest inspections. Older ones are not listed.");
    state.language = "es";
    expect(decode(await render())).toContain("Se muestran las 500 inspecciones más recientes. Las más antiguas no aparecen.");
    state.language = undefined;
    state.visits = many(499);
    expect(decode(await render())).not.toContain("Showing the 500");
  });
});

describe("the words and the law", () => {
  it("Pick a Day is Needs You's own words, in both languages", () => {
    for (const lang of ["en", "es"]) expect(translator(lang)("ip_btn_pickADay"), lang).toBe(translator(lang)("ny_btn_pickADay"));
  });

  it("no red, no amber and no slate-400 in the page or the board", () => {
    for (const f of ["src/app/(app)/inspections/page.tsx", "src/app/(app)/inspections/inspections-board.tsx"]) {
      const src = readFileSync(join(process.cwd(), f), "utf8");
      expect(src, f).not.toMatch(/\b(?:[a-z]+-)?(?:red|amber)-\d/);
      expect(src, f).not.toContain("text-slate-400");
      expect(src, f).not.toMatch(/<Badge\b/);
    }
  });

  it("the capture link is built in the page and handed down as data; the board builds none", () => {
    const page = readFileSync(join(process.cwd(), "src/app/(app)/inspections/page.tsx"), "utf8");
    const board = readFileSync(join(process.cwd(), "src/app/(app)/inspections/inspections-board.tsx"), "utf8");
    expect(page.match(/\/quotes\/new\?capture=/g)).toHaveLength(1);
    expect(board).not.toContain("/quotes/new");
  });
});

describe("an age says no time of day, and a lone ⋯ takes no line", () => {
  it("a write-up, a waiting visit and a missed one say how long ago, never a clock time; a visit ahead says its time", async () => {
    const clock = /\d:\d\d|AM|PM/;
    for (const tile of ["write_up", "needs_day", "missed"]) {
      const r = region(await render({ tile }));
      expect(r.rows.length).toBeGreaterThan(0);
      for (const x of r.rows) expect(x.edge ?? "").not.toMatch(clock);
    }
    const ahead = region(await render({ tile: "coming_up" }));
    expect(ahead.rows.some((x) => clock.test(x.edge ?? ""))).toBe(true);
    // The tile's quiet line is the first row's edge, so it carries no clock time either.
    const tiles = tilesOf(await render());
    expect(tiles.find((x) => x.id === "write_up")?.line).not.toMatch(clock);
    expect(tiles.find((x) => x.id === "needs_day")?.line).not.toMatch(clock);
  });

  it("a row with its own verb has a line for its doors; a row with only a ⋯ keeps it in its corner, clear of the phrase", async () => {
    // Write Up: Create Estimate and the ⋯ share a line.
    for (const x of region(await render({ tile: "write_up" })).rows) {
      expect(x.html).toContain('data-doors="line"');
      expect(x.html).not.toContain('data-doors="corner"');
      expect(x.html).toContain("min-h-11");
    }
    // Coming Up and Didn't Happen?: a ⋯ and nothing else. No line; the row is tall enough that the ⋯
    // never stands on the edge above it, and the phrase stops short of it.
    for (const tile of ["coming_up", "missed"]) {
      for (const x of region(await render({ tile })).rows) {
        expect(x.verb).toBeNull();
        expect(x.html).toContain('<div class="absolute bottom-0 right-2" data-doors="corner">');
        expect(x.html).not.toContain('data-doors="line"');
        expect(x.html).toContain("min-h-[60px]");
        if (x.what) expect(x.html).toMatch(/pr-10" data-what=""/);
      }
    }
    // A filed row has no doors at all.
    for (const x of region(await render({ view: "completed" })).rows) expect(x.html).not.toContain("data-doors");
  });
});
