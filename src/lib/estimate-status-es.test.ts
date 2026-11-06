import { describe, it, expect } from "vitest";
import { QUOTE_STATUSES, estimateStatusLabel } from "@/lib/statuses";
import { formatDateTimeTz } from "@/lib/tz";
import { kitFromTaskDetail, kitSummary } from "@/lib/estimate/kit-from-task";
import { runCalc } from "@/lib/electrical-calc";
import { syncWords } from "@/lib/estimate/sync-job-tasks";
import { dict, translator } from "@/lib/i18n";

/**
 * THE ESTIMATES' FOUNDATION IN SPANISH (cn-v1145). An estimate's status reads in the signed-in person's
 * language through lib/statuses estimateStatusLabel — English, the default, is the raw value every badge
 * printed before ("draft"); Spanish is the catalog's house word through the caller's translator. The
 * libraries quotes/actions leans on keep their English inline and read qs_lib_… only when handed one.
 */
const es = translator("es");

describe("estimateStatusLabel", () => {
  it("English is the raw value, byte for byte, with or without a translator", () => {
    for (const s of QUOTE_STATUSES) {
      expect(estimateStatusLabel(s)).toBe(s);
      expect(estimateStatusLabel(s, "en", translator("en"))).toBe(s);
      expect(dict("en")[`qt_status_${s}`]).toBe(s);
    }
  });

  it("Spanish is the house word, lowercase like the English", () => {
    expect(QUOTE_STATUSES.map((s) => estimateStatusLabel(s, "es", es))).toEqual(["borrador", "enviado", "aceptado", "rechazado", "vencido", "reemplazado"]);
  });

  it("an unknown status reads as itself in both languages; Spanish with no translator is English", () => {
    expect(estimateStatusLabel("archived", "es", es)).toBe("archived");
    expect(estimateStatusLabel("archived")).toBe("archived");
    expect(estimateStatusLabel("", "es", es)).toBe("");
    expect(estimateStatusLabel("draft", "es")).toBe("draft");
  });

  it("the caller's translator is the one read", () => {
    const words = (k: string) => `<${k}>`;
    expect(estimateStatusLabel("sent", "es", words)).toBe("<qt_status_sent>");
  });
});

describe("formatDateTimeTz takes the reader's language", () => {
  const at = "2026-11-05T23:00:00Z";
  it("English is unchanged", () => {
    expect(formatDateTimeTz(at, "America/Los_Angeles")).toBe(formatDateTimeTz(at, "America/Los_Angeles", "en"));
    expect(formatDateTimeTz(at, "America/Los_Angeles")).toMatch(/^Nov 5, 3:00\sPM$/);
  });
  it("Spanish reads es-US: the day before the month, the half of the day as \"p. m.\"", () => {
    const out = formatDateTimeTz(at, "America/Los_Angeles", "es");
    expect(out).toMatch(/^5 nov/);
    expect(out).toMatch(/3:00 p\. m\.$/);
  });
});

describe("the libraries' sentences: English inline, Spanish through the caller's words", () => {
  const detail = { labor: [], materials: [], units: null } as never;
  it("a kit refusal", () => {
    const en = kitFromTaskDetail(detail, { name: "Footing", unit: "ea" });
    expect(en).toEqual({ ok: false, error: "Give the task its hours first — a kit remembers your hours per unit." });
    expect(kitFromTaskDetail(detail, { name: "", unit: "ea" }, "es", es)).toEqual({ ok: false, error: "Ponle un nombre al kit." });
    expect(kitFromTaskDetail(detail, { name: "Footing", unit: "ea" }, "es", es)).toEqual({ ok: false, error: "Primero ponle sus horas a la tarea — un kit recuerda tus horas por unidad." });
  });

  it("the kit's summary", () => {
    const v = { kit: { name: "Footing", unit: "footing", labor_minutes: 120, category: null }, items: [{ code: null, description: "Concrete", quantity: 4, unit: "ea", unit_price: 0, sort_order: 0, qty_round: "none" as const }] };
    expect(kitSummary(v, 7)).toBe("2 h and Concrete ×4 per footing (from this line's ×7)");
    expect(kitSummary(v, 1)).toBe("2 h and Concrete ×4 per footing (this line is one unit)");
    expect(kitSummary(v, 7, "es", es)).toBe("2 h y Concrete ×4 por footing (de los ×7 de esta línea)");
  });

  it("a calc refusal", () => {
    expect(JSON.parse(runCalc("calc_conduit_fill", { conductors: [{ size_awg: "99", count: 1 }] })).error).toBe('Unknown wire size "99".');
    expect(JSON.parse(runCalc("calc_conduit_fill", { conductors: [{ size_awg: "99", count: 1 }] }, "es", es)).error).toBe('Calibre de cable desconocido "99".');
  });

  it("the job's list sentence, with Spanish agreeing with the count", () => {
    const r = { inserted: 1, rekeyed: 2, removed: 0, kept: 0, timed: 0, keptNames: [], leftOff: [], twice: [], sizeSet: true, sizeNow: 120 };
    expect(syncWords(r)).toBe("The job's list follows the estimate: 1 task added · 2 matched · the job's length is now 2 h.");
    expect(syncWords(r, undefined, "es", es)).toBe("La lista del trabajo sigue al presupuesto: 1 tarea agregada · 2 emparejadas · la duración del trabajo ahora es 2 h.");
  });
});
