import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { rowButtons, allDoors } from "./row-buttons";
import { AFFORDANCES, KIND_STREAM, type ActionItem } from "./types";

/**
 * A TAP OPENS THE INSPECTION, NEVER AN ESTIMATE (the owner, 2026-11-10). /quotes/new?capture= writes
 * a priced draft estimate the moment it mounts, so no row body and no row button may point at it:
 * an estimate is made only from the visit page's own Start the Estimate, a job from its ending card.
 */
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("an inspection_writeup row never points at /quotes/new", () => {
  it("the Needs You feeder's href is the visit page", () => {
    const q = strip(src("src/lib/action-items/query.ts"));
    const at = q.indexOf('kind: "inspection_writeup"');
    expect(at).toBeGreaterThan(0);
    const block = q.slice(at, q.indexOf("writeUpApptIds.add", at));
    expect(block).toContain("href: `/appointments/${a.id}`");
    expect(block).not.toContain("/quotes/new");
  });

  it("no door of the row, primary or ⋯, opens a /quotes/new page; the primary is Open the Inspection", () => {
    const item: ActionItem = {
      id: "appt-1",
      kind: "inspection_writeup",
      stream: KIND_STREAM.inspection_writeup,
      title: "Row",
      when: null,
      urgency: 1,
      done: false,
      href: "/appointments/appt-1",
      affordances: [...AFFORDANCES.inspection_writeup, "wontHappen"],
    };
    const b = rowButtons(item, { leadsOn: true, isStaff: true });
    expect(b.primary?.label).toBe("Open the Inspection");
    for (const d of allDoors(b)) if (d.act.type === "open") expect(d.act.href, d.label).not.toContain("/quotes/new");
  });

  it("the row's badge does not presume an estimate", async () => {
    const { KIND_META } = await import("./types");
    expect(KIND_META.inspection_writeup.label).toBe("To Write Up");
  });
});

describe("every other link to /quotes/new?capture= is an explicit button, never a row body", () => {
  it("the Inspections list: the link sits around a labelled Button, beside the row's own link to the visit", () => {
    const page = src("src/app/(app)/inspections/page.tsx");
    expect(page).toContain("href={`/appointments/${a.id}`}");
    // The estimate link wraps the labelled button and nothing else.
    expect(page).toMatch(/<Link href=\{estimateHref\}[^>]*>\s*<Button>[\s\S]*?ip_btn_createEstimate[\s\S]*?<\/Button>\s*<\/Link>/);
  });

  it("the visit page hands the Inspector the href for its Start the Estimate button; nothing else on it links there", () => {
    const page = strip(src("src/app/(app)/appointments/[id]/page.tsx"));
    expect(page.match(/\/quotes\/new\?capture=/g)?.length).toBe(1);
    expect(page).toContain("estimateHref=");
  });

  it("no other component builds a capture link", () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const f of require("node:fs").readdirSync(join(process.cwd(), dir), { withFileTypes: true })) {
        const rel = `${dir}/${f.name}`;
        if (f.isDirectory()) walk(rel);
        else if (/\.(ts|tsx)$/.test(f.name) && !/\.test\./.test(f.name) && strip(src(rel)).includes("/quotes/new?capture=")) hits.push(rel);
      }
    };
    walk("src");
    expect(hits.sort()).toEqual(["src/app/(app)/appointments/[id]/page.tsx", "src/app/(app)/inspections/page.tsx"]);
  });
});

/**
 * RE-PINNED 2026-11-10 (skeptic #60). The first version of this pin held only that a warning was
 * RETURNED and that the session read `res.warning`. Both were true while the warning reached nobody:
 * it went into the line under the list, and the hand-off replaced the page the moment the session was
 * quiet. And its words sent the person back through Start the Estimate, which on a visit with no lead
 * finds nothing standing and births a TWIN (the very thing this file exists to prevent). So the pins
 * now follow the sentence all the way to the eye, and hold what it says. The retry and the sink
 * report are DRIVEN in quotes/one-editor-doors.test.ts; the session's carriage in use-quote-writes.test.ts.
 */
describe("the write-up stamp is not silent (saveQuote)", () => {
  it("reads its row count, is tried twice, and a failure that stands is filed by ids only and returned as the warning", () => {
    const a = strip(src("src/app/(app)/quotes/actions.ts"));
    const at = a.indexOf("if (input.capture_appointment_id) {");
    expect(at).toBeGreaterThan(0);
    const block = a.slice(at, a.indexOf("if (inquiryId) {", at));
    expect(block).toContain('for (let attempt = 0; attempt < 2 && tied === "failed"; attempt++) {');
    expect(block).toMatch(/\.update\(\{ capture: \{ \.\.\.existing, quote_id: quote\.id \}, updated_at: [^\n]*\}\)\s*\.eq\("id", appt\.id\)\s*\.select\("id"\);/);
    // The capture is read INSIDE the loop: the second try never writes the first try's copy back.
    expect(block.indexOf('.select("id, capture")')).toBeGreaterThan(block.indexOf("for (let attempt"));
    expect(block).toContain('reportError("saveQuote:stamp", why ?? new Error("the stamp did not land"), { quoteId: quote.id, appointmentId: input.capture_appointment_id });');
    expect(block).toContain('stampWarning = await ws.say("qs_stampNotLinked");');
    expect(a).toContain("...(stampWarning ? { warning: stampWarning } : {})");
  });

  it("the warning is carried to where it is READ: held on its own in the session, said as a sticky toast that outlasts the hand-off", () => {
    const writes = strip(src("src/app/(app)/quotes/use-quote-writes.ts"));
    expect(writes).toContain("...(res.warning ? { warning: res.warning } : {}),");
    expect(writes).not.toContain("said: res.warning"); // the line under the list went with the page
    const editor = strip(src("src/app/(app)/quotes/estimate-editor.tsx"));
    expect(editor).toMatch(/if \(!state\.warning \|\| warned\.current === state\.warning\) return;\s*warned\.current = state\.warning;\s*toast\(state\.warning, "info", undefined, \{ sticky: true \}\);/);
    // It needs no place in the hand-off's stash: the toasts are the app LAYOUT's, which the navigation
    // from /quotes/new to /quotes/<id> does not remount, and a sticky one stays until Got It.
    expect(src("src/app/(app)/layout.tsx")).toContain("<ToastProvider>{children}</ToastProvider>");
    const toasts = src("src/components/toast.tsx");
    expect(toasts).toContain("if (sticky) return;");
    // The effect is not gated on the hand-off's quiet: it fires when the sentence lands.
    const effect = editor.slice(editor.indexOf("const warned = useRef<string | null>(null);"), editor.indexOf("const handedOff = useRef(false);"));
    expect(effect).toContain("}, [state.warning, toast]);");
    expect(effect).not.toContain("quiet");
  });

  it("the sentence says what is true, in both languages, and never sends anyone back through Start the Estimate", async () => {
    const { translator } = await import("@/lib/i18n");
    const en = translator("en")("qs_stampNotLinked");
    const es = translator("es")("qs_stampNotLinked");
    expect(en).toBe(
      "The estimate is saved, but it could not be tied to its inspection, so the inspection can still show as waiting to be written up. Do not start another estimate from that inspection. When this estimate is settled, mark the inspection Won or Lost on its own page.",
    );
    expect(es).toBe(
      "El presupuesto se guardó, pero no se pudo enlazar con su inspección, así que la inspección puede seguir apareciendo como pendiente de redactar. No empieces otro presupuesto desde esa inspección. Cuando este presupuesto se resuelva, marca la inspección como Ganada o Perdida en su propia página.",
    );
    // The door it must never name, by the visit page's own words for it in each language.
    expect(en).not.toContain(translator("en")("vi_btn_startTheEstimate"));
    expect(es).not.toContain(translator("es")("vi_btn_startTheEstimate"));
    expect(translator("es")("vi_btn_startTheEstimate")).toBe("Empezar el Presupuesto");
    // The two words it does name are the visit page's own (its ending doors), in each language.
    for (const lang of ["en", "es"] as const) {
      const t = translator(lang);
      expect(t("qs_stampNotLinked")).toContain(t("vp_won"));
      expect(t("qs_stampNotLinked")).toContain(t("vp_lost"));
    }
    // Spanish: an estimate is a presupuesto here, never a cotización.
    expect(es).not.toMatch(/cotizaci[oó]n/i);
  });

  it("why the old remedy was wrong: with no backlink the new-estimate door finds nothing standing behind the visit", () => {
    const page = strip(src("src/app/(app)/quotes/new/page.tsx"));
    expect(page).toContain("const standing = await liveEstimateBehindVisit(supabase, captureQuoteId((appt as any).capture));");
    expect(page).toContain("if (standing) redirect(`/quotes/${standing}`);");
  });
});
