import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * SALES > CLOSING (cn-v1172). The page (office only, the switch, a failed read, the cut, the empty
 * inbox), a row in each state in both languages, the two-tap doors and the line that outlives the
 * row, the words' Title Case, the Sales dot's wiring and the revalidations. Static renders against
 * stand-ins: the repository has no DOM, so a tap is pinned by rendering the state it leads to and by
 * the pure function that decides it.
 */

const nav = vi.hoisted(() => ({ redirected: null as string | null }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  redirect: (to: string) => {
    nav.redirected = to;
    throw new Error(`REDIRECT ${to}`);
  },
}));
vi.mock("@/app/(app)/quotes/actions", () => ({ updateQuoteStatus: vi.fn() }));
vi.mock("@/app/(app)/send-actions", () => ({ previewSend: vi.fn(), sendReviewed: vi.fn() }));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));
vi.mock("@/lib/sms", () => ({ smsReadiness: () => ({ ready: true }) }));
const db = vi.hoisted(() => ({ role: "owner" as string | null, settings: {} as Record<string, unknown>, quotes: { data: [] as unknown[], error: null as unknown }, lang: "en" }));
vi.mock("@/lib/current-lang", () => ({ currentLangFor: async () => db.lang }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "u-1" } } }) },
    from(table: string) {
      const q: any = {
        select: () => q,
        maybeSingle: async () => ({ data: table === "profiles" && db.role ? { role: db.role, active: true, organizations: { name: "Northline", settings: db.settings } } : null, error: null }),
        then: (ok: any, err: any) =>
          Promise.resolve(table === "quotes" && !(q.cols ?? "").includes("revises") ? db.quotes : { data: [], error: null }).then(ok, err),
      };
      q.select = (c: string) => ((q.cols = c), q);
      for (const m of ["eq", "in", "order", "limit"]) q[m] = () => q;
      return q;
    },
  }),
}));

const { LangProvider } = await import("@/components/lang-provider");
const { translator } = await import("@/lib/i18n");
const { words } = await import("@/lib/words/closing");
const { titleCaseIn } = await import("../../../../tests/title-case-words");
const { ClosingCard, ClosingList, afterAnswer, closingRowWords } = await import("./closing-list");
type ClosingCardRow = import("./closing-list").ClosingCardRow;
const { default: ClosingPage } = await import("./page");

const TODAY = "2026-11-19";
const TZ = "America/Los_Angeles";
const NOW = Date.parse("2026-11-19T20:00:00Z");
const html = (el: ReactElement, lang: "en" | "es" = "en") => renderToStaticMarkup(createElement(LangProvider, { lang, children: el }));

const base: ClosingCardRow = {
  id: "q-1",
  quoteNumber: "E-901",
  title: "Larkspur Panel",
  total: 1200,
  customerName: "Dana Rook",
  customerCompany: "Rook Builders",
  fileHref: "/crm/c-1",
  validUntil: null,
  state: { sinceAt: "2026-11-18T18:00:00Z", sentLogged: true, daysWaiting: 1, offer: "none", why: null },
};
const STATES: Record<string, ClosingCardRow> = {
  sentYesterday: base,
  quiet: { ...base, id: "q-2", state: { sinceAt: "2026-11-09T18:00:00Z", sentLogged: true, daysWaiting: 9, offer: "none", why: "quiet" } },
  endsSoon: { ...base, id: "q-3", validUntil: "2026-11-21", state: { ...base.state, offer: "ends_soon", why: "offer_ends" } },
  ended: { ...base, id: "q-4", validUntil: "2026-11-15", state: { ...base.state, offer: "ended", why: "offer_ended" } },
  noSend: { ...base, id: "q-5", fileHref: null, customerName: null, state: { sinceAt: "2026-11-17T18:00:00Z", sentLogged: false, daysWaiting: 1, offer: "open", why: null } },
};
const card = (row: ClosingCardRow, lang: "en" | "es" = "en", o: Record<string, unknown> = {}) =>
  html(createElement(ClosingCard, { row, ctx: { t: translator(lang), lang, todayStr: TODAY, tz: TZ }, nowMs: NOW, textReady: true, onDone: () => {}, ...o }), lang);

describe("a row, in each state, in both languages", () => {
  it("sent yesterday: who opens the file, the business, the total, the estimate as a link, Sent with a running clock, three doors", () => {
    const h = card(STATES.sentYesterday);
    expect(h).toContain('href="/crm/c-1"');
    expect(h).toContain("Dana Rook");
    expect(h).toContain("Rook Builders");
    expect(h).toContain("$1,200.00");
    expect(h).toContain('href="/quotes/q-1"');
    expect(h).toContain("E-901 · Larkspur Panel");
    expect(h).toContain("Sent Nov 18");
    expect(h).toContain("data-clock");
    expect(h).toContain("1d 2h");
    for (const d of ["Accepted", "Not Sold", "Send Again"]) expect(h).toContain(d);
    expect(h).not.toContain("amber");
    expect(card(STATES.sentYesterday, "es")).toContain("Enviado el 18 nov");
    expect(card(STATES.sentYesterday, "es")).toContain("Enviar de Nuevo");
  });

  it("quiet: a slate line that names no number (it would lag the clock beside it), no amber", () => {
    const h = card(STATES.quiet);
    expect(h).toContain("No answer in a week or more");
    expect(h).not.toMatch(/No answer in \d/);
    expect(h).not.toContain("amber");
    expect(card(STATES.quiet, "es")).toContain("Sin respuesta en una semana o más");
    // The key carries no slot in either language (cn-v1172 fixer).
    expect(words.en.cl_quiet).not.toContain("{");
    expect(words.es.cl_quiet).not.toContain("{");
  });

  it("the offer ending soon and ended are the only amber on the page, with the day", () => {
    expect(card(STATES.endsSoon)).toContain('data-offer="amber"');
    expect(card(STATES.endsSoon)).toContain("Offer ends Nov 21");
    expect(card(STATES.ended)).toContain("Offer ended Nov 15");
    expect(card(STATES.ended, "es")).toContain("La oferta venció el 15 nov");
    expect(card(STATES.noSend)).toContain('data-offer="slate"');
  });

  it("no send on record: said, never called Sent, and no clock; no file means plain words", () => {
    const h = card(STATES.noSend);
    expect(h).toContain("No send on record");
    expect(h).not.toContain("Sent ");
    expect(h).not.toContain("data-clock");
    expect(h).toContain("No name on it");
    expect(h).not.toContain('href="/crm');
    expect(card(STATES.noSend, "es")).toContain("Sin envío registrado");
  });

  it("the words are pure: closingRowWords says each state", () => {
    const ctx = { t: translator("en"), lang: "en", todayStr: TODAY, tz: TZ };
    expect(closingRowWords(STATES.quiet, ctx)).toEqual({ sent: "Sent Nov 9", quiet: "No answer in a week or more", offer: null });
    expect(closingRowWords(STATES.ended, ctx).offer).toEqual({ text: "Offer ended Nov 15", amber: true });
  });
});

describe("Accepted and Not Sold are two taps, inline", () => {
  it("the first tap swaps the doors for one sentence and Yes / Cancel", () => {
    const a = card(STATES.quiet, "en", { initialAsk: "accepted" });
    // True whether or not the estimate is already on a job (updateQuoteStatus catches that job up).
    expect(a).toContain("Mark E-901 accepted? It goes on its job, and a job is made if it has none.");
    expect(card(STATES.quiet, "es", { initialAsk: "accepted" })).toContain("Pasa a su trabajo, y si no tiene uno, se crea.");
    expect(a).toContain(">Yes<");
    expect(a).toContain(">Cancel<");
    expect(a).not.toContain("Send Again");
    const n = card(STATES.quiet, "en", { initialAsk: "declined" });
    expect(n).toContain("Mark E-901 Not Sold? It leaves Closing and stays in the customer&#x27;s file.");
    expect(card(STATES.quiet, "es", { initialAsk: "declined" })).toContain("Sale de Cierre");
  });

  it("the second tap's answer: a refusal stays on the row in the server's words; nothing is a dropped connection; a success leaves a line", () => {
    const t = translator("en");
    expect(afterAnswer({ ok: false, error: "That estimate could not be found." }, "accepted", "E-901", t)).toEqual({ error: "That estimate could not be found." });
    expect(afterAnswer(null, "declined", "E-901", t)).toEqual({ error: "Nothing changed: the connection dropped. Try again." });
    expect(afterAnswer({ ok: true, jobId: "j-9", warning: "Check the job." }, "accepted", "E-901", t, "q-2")).toEqual({
      notice: { status: "accepted", ref: "E-901", quoteId: "q-2", jobId: "j-9", warning: "Check the job.", said: null },
    });
    // The row passes its own id, so the line has the estimate's door.
    expect(readFileSync(join(__dirname, "closing-list.tsx"), "utf8")).toContain("afterAnswer(res, status, shortRef, t, row.id)");
    expect(card(STATES.quiet, "en", { initialError: "That estimate could not be found." })).toContain('data-refusal=""');
  });

  it("the line OUTLIVES the row: the last one gone, the list draws its own empty state under the line, with the job's door", () => {
    const h = html(
      createElement(ClosingList, {
        rows: [STATES.quiet],
        nowMs: NOW,
        todayStr: TODAY,
        tz: TZ,
        textReady: true,
        initialGone: ["q-2"],
        initialNotice: { status: "accepted", ref: "E-901", quoteId: "q-2", jobId: "j-9", said: "Keep Both is on the estimate.", warning: null },
      }),
    );
    expect(h).toContain("E-901 is accepted.");
    expect(h).toContain('href="/jobs/j-9"');
    expect(h).toContain("Open the Job");
    // A second door, to the estimate itself: what the line says can send the person back to it.
    expect(h).toContain('href="/quotes/q-2"');
    expect(h).toContain("Open the Estimate");
    expect(h).toContain("No estimate is waiting on an answer.");
    expect(h).toContain('href="/quotes"');
    expect(h.indexOf("data-closing-notice")).toBeLessThan(h.indexOf("data-closing-empty"));
  });

  it("calls the estimate page's own door, never the browser's dialog", () => {
    const src = readFileSync(join(__dirname, "closing-list.tsx"), "utf8");
    expect(src).toContain('import { updateQuoteStatus } from "@/app/(app)/quotes/actions";');
    expect(src).toContain("await updateQuoteStatus(row.id, status)");
    expect(src).not.toMatch(/\b(confirm|alert)\(/);
    expect(src).toContain('<SendButton\n            kind="quote"');
  });
});

describe("the page", () => {
  beforeEach(() => {
    nav.redirected = null;
    db.role = "owner";
    db.settings = {};
    db.quotes = { data: [], error: null };
    db.lang = "en";
  });
  const page = async () => html((await ClosingPage()) as ReactElement, db.lang as "en");

  it("a tech goes to My Day", async () => {
    db.role = "tech";
    await expect(ClosingPage()).rejects.toThrow("REDIRECT /planner");
  });

  it("the header is the map's; an empty inbox has its door", async () => {
    const h = await page();
    expect(h).toContain(translator("en")("nv_page_closing"));
    expect(h).toContain("No estimate is waiting on an answer.");
    expect(h).toContain("Go to Estimates");
    expect(h).not.toContain("An estimate already sent still waits here");
  });

  it("a failed read is said, never an empty inbox", async () => {
    db.quotes = { data: null as unknown as unknown[], error: { message: "boom" } };
    const h = await page();
    expect(h).toContain("couldn&#x27;t be read just now");
    expect(h).not.toContain("No estimate is waiting on an answer.");
  });

  it("more than the cap: one line says the estimates written first are shown", async () => {
    const row = (i: number) => ({ id: `q-${i}`, quote_number: `E-9${i}`, status: "sent", total: 100, created_at: "2026-11-01T17:00:00Z", customers: { name: "Theo Vance" } });
    db.quotes = { data: Array.from({ length: 101 }, (_, i) => row(i)), error: null };
    const h = await page();
    expect(h).toContain("The 100 estimates written first are shown.");
    expect(h.match(/data-row=/g)).toHaveLength(100);
  });

  it("with Estimates off the sent ones are still listed; the page's line says only what the shell's Off line does not", async () => {
    db.settings = { features: { estimates: false } };
    db.quotes = { data: [{ id: "q-1", quote_number: "E-901", status: "sent", total: 100, created_at: "2026-11-01T17:00:00Z", customers: { name: "Casey Loam" } }], error: null };
    const h = await page();
    // The shell's Off line ("Estimates · Off", FEATURE_ROUTES has /closing) says the switch is off.
    expect(h).toContain("An estimate already sent still waits here for its answer.");
    expect(h).not.toMatch(/switched off|apagado/i);
    expect((await import("@/lib/feature-doors")).featureForPath("/closing")).toBe("estimates");
    expect(h).toContain("Casey Loam");
  });
});

describe("the words", () => {
  it("every clickable is Title Case in both languages, and the clock's units differ by language", () => {
    for (const k of Object.keys(words.en).filter((k) => k.startsWith("cl_btn_"))) {
      expect(titleCaseIn(words.en[k], "en"), words.en[k]).toBe(true);
      expect(titleCaseIn(words.es[k], "es"), words.es[k]).toBe(true);
    }
    expect(Object.keys(words.es).sort()).toEqual(Object.keys(words.en).sort());
  });
});

describe("the wiring", () => {
  const src = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

  it("the Sales dot adds the Closing estimates that need a person, office only with Estimates on, never rejecting", () => {
    const layout = src("src/app/(app)/layout.tsx");
    expect(layout).toContain('if (!isStaff || !featureOn(features, "estimates")) return 0;');
    expect(layout).toContain("return await countClosingAttention(supabase, { todayStr: todayStrInTz(tz) });");
    expect(layout).toContain('reportError("app-layout:closing-badge", e);');
    expect(layout.match(/"\/closing": await closingP/g)).toHaveLength(2);
  });

  it("every write that changes what Closing lists revalidates it", () => {
    const actions = src("src/app/(app)/quotes/actions.ts");
    const quotes = actions.match(/revalidatePath\("\/quotes"\);/g)?.length ?? 0;
    expect(quotes).toBeGreaterThan(10);
    // Beside every Estimates revalidation, and after an emailed send (which revalidates only the estimate).
    expect(actions.match(/revalidatePath\("\/quotes"\);\n\s*revalidatePath\("\/closing"\);/g)).toHaveLength(quotes);
    expect(actions).toMatch(/await markQuoteSent\(supabase, id, quote\.status\);\n\s*revalidatePath\(`\/quotes\/\$\{id\}`\);\n[^\n]*\n\s*revalidatePath\("\/closing"\);/);
    expect(actions).not.toContain("setQuoteFollowUp");
  });
});
