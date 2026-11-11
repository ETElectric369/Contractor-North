import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * THE FILED PILE HAS THREE HEADINGS, AND LOST IS ONE OF THEM (cn-v1158; found by the review of cn-v1157).
 *
 * The Didn't Happen? group asks about a visit that was scheduled, is past and holds no notes, and one
 * of its two answers is Lost. The answer is the visit's outcome; its status stays 'scheduled'. The
 * page then split the filed pile on STATUS alone, anything not cancelled under "Completed & written
 * up", so a visit that never happened was filed as completed and written up. The owner's rule: a
 * visit that did not become work is LOST, everywhere. So the heading is by outcome, whatever the
 * status (lib/inspections filedUnder), and the page draws Completed & written up, Lost, Cancelled, in
 * that order, each only when it has a row.
 *
 * This renders THE PAGE ITSELF against a fake database (made-up people and streets), in English and
 * in Spanish. The page's client doors are drawn as markers: this is about the headings and which
 * rows sit under each.
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
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/components/toast", () => ({ useToast: () => () => {} }));
// The server actions behind the row's doors and the header's two buttons: never called by a render.
vi.mock("../appointments/actions", () => ({ setAppointmentOutcome: vi.fn(), wontHappenAppointment: vi.fn() }));
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
// THE ROW THIS IS ABOUT: scheduled, past, nothing on it, answered Lost from the Didn't Happen? group.
// Its stock title gives way to who and where (inspectionLabel), so that is what the row reads.
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
/** Each drawn pile: its heading, the titles of its rows in order, and its own markup. */
const piles = (html: string) =>
  [...html.matchAll(/<section>([\s\S]*?)<\/section>/g)].map((m) => ({
    heading: decode(/<h2[^>]*>([\s\S]*?)<\/h2>/.exec(m[1])?.[1] ?? ""),
    rows: [...m[1].matchAll(/<span class="truncate font-medium[^"]*">([\s\S]*?)<\/span>/g)].map((x) => decode(x[1])),
    html: m[1],
  }));

let InspectionsPage: (p: { searchParams: Promise<{ view?: string }> }) => Promise<unknown>;
beforeAll(async () => {
  // The page asks the clock which visits are past: a fixed one, after every fixture's day.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-10T18:00:00Z"));
  InspectionsPage = (await import("./page")).default as any;
}, 30_000);
afterAll(() => vi.useRealTimers());
beforeEach(() => {
  state.visits = structuredClone(ALL);
  state.language = undefined;
});

const render = async (view?: "completed") =>
  renderToStaticMarkup((await InspectionsPage({ searchParams: Promise.resolve(view ? { view } : {}) })) as React.ReactElement);

describe("the filed pile: Completed & written up, Lost, Cancelled", () => {
  it("English: the three headings in that order, each row under the one its OUTCOME names", async () => {
    const drawn = piles(await render("completed"));
    expect(drawn.map((p) => [p.heading, p.rows])).toEqual([
      ["Completed & written up", ["Panel upgrade", "Hot tub circuit"]],
      // Whatever the status: still scheduled, completed, cancelled; lost and the old no_bid alike.
      ["Lost", ["Dana Rook · 9 Snowbell Ct", "Garage subpanel", "Car charger", "Deck lighting"]],
      ["Cancelled", ["Service change"]],
    ]);
  });

  it("Spanish: Terminadas y redactadas, Perdidas, Canceladas, over the same rows, with no English heading left", async () => {
    state.language = "es";
    const drawn = piles(await render("completed"));
    expect(drawn.map((p) => [p.heading, p.rows])).toEqual([
      ["Terminadas y redactadas", ["Panel upgrade", "Hot tub circuit"]],
      ["Perdidas", ["Dana Rook · 9 Snowbell Ct", "Garage subpanel", "Car charger", "Deck lighting"]],
      ["Canceladas", ["Service change"]],
    ]);
    for (const p of drawn) expect(p.heading).not.toMatch(/Lost|Cancelled|Completed|written/);
  });

  it("the visit that never happened is no longer filed as completed and written up, in either language", async () => {
    for (const lang of [undefined, "es"]) {
      state.language = lang;
      const [completed, lost] = piles(await render("completed"));
      expect(completed.rows, String(lang)).not.toContain("Dana Rook · 9 Snowbell Ct");
      expect(completed.html, String(lang)).not.toContain('href="/appointments/lost-missed"');
      expect(lost.html, String(lang)).toContain('href="/appointments/lost-missed"');
    }
  });

  it("every filed row is drawn once, under one heading", async () => {
    const html = await render("completed");
    for (const v of ALL) expect(html.split(`href="/appointments/${v.id}"`).length - 1, String(v.id)).toBe(1);
    expect(piles(html).flatMap((p) => p.rows)).toHaveLength(ALL.length);
  });
});

describe("a group with no rows draws no heading", () => {
  const headings = async () => piles(await render("completed")).map((p) => p.heading);

  it("only lost rows: Lost alone", async () => {
    state.visits = structuredClone([NEVER_HAPPENED, NO_BID]);
    expect(await headings()).toEqual(["Lost"]);
    state.language = "es";
    expect(await headings()).toEqual(["Perdidas"]);
  });

  it("nothing lost: the two headings the page always had, and no Lost between them", async () => {
    state.visits = structuredClone([WRITTEN_UP, WON, CALLED_OFF]);
    expect(await headings()).toEqual(["Completed & written up", "Cancelled"]);
    state.language = "es";
    expect(await headings()).toEqual(["Terminadas y redactadas", "Canceladas"]);
  });

  it("only one group at a time, each of the other two", async () => {
    state.visits = structuredClone([WRITTEN_UP]);
    expect(await headings()).toEqual(["Completed & written up"]);
    state.visits = structuredClone([CALLED_OFF]);
    expect(await headings()).toEqual(["Cancelled"]);
  });

  it("a cancelled visit marked Lost empties Cancelled, not Lost", async () => {
    state.visits = structuredClone([LOST_AND_CANCELLED]);
    expect(await headings()).toEqual(["Lost"]);
  });

  it("nothing filed at all: the empty state, and no heading", async () => {
    state.visits = [];
    const html = await render("completed");
    expect(piles(html)).toEqual([]);
    expect(decode(html)).toContain("Nothing filed away yet");
  });
});

describe("the rows keep their own row and doors", () => {
  it("a filed row opens its visit and carries no button: no Create Estimate, no Didn't Happen, no Lost", async () => {
    const drawn = piles(await render("completed"));
    for (const p of drawn) {
      expect(p.html, p.heading).not.toMatch(/<button/);
      expect(p.html, p.heading).not.toContain("/quotes/new");
    }
    expect(drawn[1].html).toContain('href="/appointments/lost-done"');
  });

  it("the cancelled visit under Lost still says it was cancelled, on its own row (the row's one tag rule)", async () => {
    const [, lost, cancelled] = piles(await render("completed"));
    expect(decode(lost.html).match(/\bcancelled\b/g)).toHaveLength(1);
    expect(decode(cancelled.html).match(/\bcancelled\b/g)).toHaveLength(1);
    state.language = "es";
    const [, perdidas] = piles(await render("completed"));
    expect(decode(perdidas.html).match(/\bcancelada\b/g)).toHaveLength(1);
  });

  it("the open view: the answered visit is in none of the open piles; one nobody answered still asks", async () => {
    const unanswered = visit("missed-1", { status: "scheduled", title: "Attic fan", starts_at: at("2026-11-06") });
    state.visits = structuredClone([...ALL, unanswered]);
    const drawn = piles(await render());
    expect(drawn.map((p) => [p.heading, p.rows])).toEqual([["Didn't Happen?", ["Attic fan"]]]);
    // Its two answers are still the row's doors.
    expect([...drawn[0].html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((m) => decode(m[1]))).toEqual(["Didn't Happen", "Lost"]);
  });
});

describe("in the source: ONE rule decides the heading", () => {
  const page = readFileSync(join(process.cwd(), "src/app/(app)/inspections/page.tsx"), "utf8");

  it("each filed row is placed once by filedUnder; the page tests no status and no outcome of its own for it", () => {
    expect(page).toMatch(/import \{[^}]*\bfiledUnder\b[^}]*\} from "@\/lib\/inspections";/);
    expect(page).toContain("const filedBy: Record<FiledUnder, typeof filed> = { completed: [], lost: [], cancelled: [] };");
    expect(page).toContain("for (const r of filed) filedBy[filedUnder(r)].push(r);");
    expect(page).not.toMatch(/\.status\s*[!=]==\s*"cancelled"/);
    expect(page).not.toMatch(/\.outcome\b/);
  });

  it("the three headings are drawn in order, each behind its own rows, each from the catalog", () => {
    const order = ['filedBy.completed.length > 0 && <Section title={t("ip_completedWrittenUp")}', 'filedBy.lost.length > 0 && <Section title={t("ip_lost")}', 'filedBy.cancelled.length > 0 && <Section title={t("ip_cancelled")}'];
    const found = order.map((s) => page.indexOf(s));
    expect(found.every((i) => i > 0)).toBe(true);
    expect([...found].sort((a, b) => a - b)).toEqual(found);
  });

  it("the page reads the outcome with its rows: the column is in its select, beside the status", () => {
    // The projection law: filedUnder can only name Lost for a row whose read brought the answer back.
    const cols = (/\.from\("appointments"\)\s*\.select\(\s*"([^"]*)"/.exec(page)?.[1] ?? "").split(/,\s*/);
    expect(cols).toContain("outcome");
    expect(cols).toContain("status");
  });

  it("the heading's words: Lost and Perdidas, a pile's name beside Terminadas and Canceladas; the row's button stays Perdida", async () => {
    const { translator } = await import("@/lib/i18n");
    expect(translator("en")("ip_lost")).toBe("Lost");
    expect(translator("es")("ip_lost")).toBe("Perdidas");
    expect(translator("es")("ip_btn_lost")).toBe("Perdida");
    expect(translator("es")("ip_cancelled")).toBe("Canceladas");
  });
});
