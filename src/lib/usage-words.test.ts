import { describe, it, expect } from "vitest";
import { translator } from "@/lib/i18n";
import { usageWords } from "./usage-words";

/**
 * THE WORDS UNDER THE RING (cn-v1140): every state in both languages, the dates through Intl in the
 * person's language, the forecast on its own when there is a run-out AND the ring is at 50% or more,
 * the trial's last day, the used-up line without its call to action inside the App Store app — and
 * never a dollar, a token or an estimate as a unit.
 */
const en = translator("en");
const es = translator("es");
const base = { pct: 60, resetOn: "2026-11-01", runOutOn: null as string | null, trialEndsOn: undefined as string | undefined };

describe("usageWords — English", () => {
  it("fine: Usage, Resets Nov 1., no forecast, no trial line", () => {
    expect(usageWords({ ...base, state: "fine" }, en, "en")).toEqual({ headline: "Usage", line: "Resets Nov 1." });
  });

  it("the forecast is drawn from 50% up only: a 49% month on a fast pace has no forecast line, a 50% one does", () => {
    expect(usageWords({ ...base, pct: 49, state: "fine", runOutOn: "2026-10-28" }, en, "en")).toEqual({ headline: "Usage", line: "Resets Nov 1." });
    expect(usageWords({ ...base, pct: 50, state: "watch", runOutOn: "2026-10-28" }, en, "en").forecast).toBe("At this pace you'll run out around Oct 28.");
  });

  it("a new trial at 10% on day 1 has a run-out day (lib/usage-window computes one from the first cent) and must show no forecast", () => {
    expect(usageWords({ ...base, pct: 10, state: "fine", runOutOn: "2026-10-11", trialEndsOn: "2026-11-14" }, en, "en")).toEqual({
      headline: "Usage",
      line: "Resets Nov 1.",
      trialLine: "Your trial ends Nov 14.",
    });
    expect(usageWords({ ...base, pct: 10, state: "fine", runOutOn: "2026-10-11" }, es, "es")).toEqual({ headline: "Uso", line: "Se reinicia el 1 nov." });
  });

  it("watch with a run-out says the pace and the reset in one line, and the forecast on its own", () => {
    expect(usageWords({ ...base, state: "watch", runOutOn: "2026-10-28" }, en, "en")).toEqual({
      headline: "Usage",
      line: "At this pace you'll run out around Oct 28. Resets Nov 1.",
      forecast: "At this pace you'll run out around Oct 28.",
    });
  });

  it("watch without a run-out: most of the month is used", () => {
    expect(usageWords({ ...base, state: "watch" }, en, "en")).toEqual({ headline: "Usage", line: "Most of this month's usage is used. Resets Nov 1." });
  });

  it("almost: almost out", () => {
    expect(usageWords({ ...base, state: "almost", runOutOn: "2026-10-30" }, en, "en")).toEqual({
      headline: "Usage",
      line: "Almost out for this month. Resets Nov 1.",
      forecast: "At this pace you'll run out around Oct 30.",
    });
  });

  it("out: used up, the lighter model until the reset, the two actions — and no forecast (it is not a forecast any more)", () => {
    expect(usageWords({ ...base, pct: 100, state: "out", runOutOn: "2026-10-20" }, en, "en")).toEqual({
      headline: "Usage",
      line: "Used up for this month — Nort and the estimator run lighter until Nov 1. Add usage or upgrade.",
    });
  });

  it("out inside the App Store app (shell): the same line without \"Add usage or upgrade.\" — there is no purchase door there", () => {
    expect(usageWords({ ...base, pct: 100, state: "out" }, en, "en", { shell: true })).toEqual({
      headline: "Usage",
      line: "Used up for this month — Nort and the estimator run lighter until Nov 1.",
    });
    expect(usageWords({ ...base, pct: 100, state: "out" }, es, "es", { shell: true }).line).toBe("Se acabó por este mes: Nort y el estimador corren más ligeros hasta el 1 nov.");
    // The shell changes nothing else.
    expect(usageWords({ ...base, state: "fine" }, en, "en", { shell: true })).toEqual({ headline: "Usage", line: "Resets Nov 1." });
    expect(usageWords({ ...base, pct: 100, state: "out" }, en, "en", { shell: false }).line).toContain("Add usage or upgrade.");
  });

  it("the trial's last day rides as its own line, in the person's language", () => {
    expect(usageWords({ ...base, state: "fine", trialEndsOn: "2026-11-07" }, en, "en")).toEqual({ headline: "Usage", line: "Resets Nov 1.", trialLine: "Your trial ends Nov 7." });
    expect(usageWords({ ...base, state: "fine", trialEndsOn: "2026-11-07" }, es, "es").trialLine).toBe("Tu prueba termina el 7 nov.");
  });

  it("December resets in January", () => {
    expect(usageWords({ ...base, state: "fine", resetOn: "2027-01-01" }, en, "en").line).toBe("Resets Jan 1.");
    expect(usageWords({ ...base, state: "fine", resetOn: "2027-01-01" }, es, "es").line).toBe("Se reinicia el 1 ene.");
  });
});

describe("usageWords — Spanish", () => {
  it("every state, the dates as 1 nov", () => {
    expect(usageWords({ ...base, state: "fine" }, es, "es")).toEqual({ headline: "Uso", line: "Se reinicia el 1 nov." });
    expect(usageWords({ ...base, state: "watch", runOutOn: "2026-10-28" }, es, "es")).toEqual({
      headline: "Uso",
      line: "A este ritmo se te acaba alrededor del 28 oct. Se reinicia el 1 nov.",
      forecast: "A este ritmo se te acaba alrededor del 28 oct.",
    });
    expect(usageWords({ ...base, state: "watch" }, es, "es").line).toBe("Ya se usó la mayor parte de este mes. Se reinicia el 1 nov.");
    expect(usageWords({ ...base, state: "almost" }, es, "es").line).toBe("Casi se acaba por este mes. Se reinicia el 1 nov.");
    expect(usageWords({ ...base, state: "out" }, es, "es").line).toBe("Se acabó por este mes: Nort y el estimador corren más ligeros hasta el 1 nov. Agrega uso o mejora tu plan.");
  });
});

describe("usageWords — nothing to explain", () => {
  it("no state in either language names a dollar, a token, a credit or an estimate as a unit", () => {
    for (const [t, lang] of [[en, "en"], [es, "es"]] as const) {
      for (const state of ["fine", "watch", "almost", "out"] as const) {
        const w = usageWords({ ...base, pct: state === "out" ? 100 : 73, state, runOutOn: "2026-10-28", trialEndsOn: "2026-11-07" }, t, lang);
        const all = [w.headline, w.line, w.forecast, w.trialLine].join(" ");
        expect(all).not.toMatch(/\$|\d+ (estimates|presupuestos)|token|credit|crédito/i);
      }
    }
  });
});
