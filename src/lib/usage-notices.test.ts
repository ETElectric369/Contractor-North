import { describe, it, expect } from "vitest";
import { translator } from "@/lib/i18n";
import { usageNoticeKey, usageNoticeKind, usageNoticeWords } from "./usage-notices";

/**
 * THE USAGE NOTICES' KEYS AND WORDS (cn-v1140): one key per month per threshold so the cron tells
 * each once (claim_billing_notice is the lock), keyed on the PERCENT (a watch by pace at 50–79% is
 * no notice), under 80 claims nothing, the words in both languages with the reset day in them, the
 * titles Title Case.
 */
const en = translator("en");
const es = translator("es");
const titleCase = (s: string) =>
  s
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => /^[\p{Lu}\p{N}&\/+·(]/u.test(w));

describe("usageNoticeKey", () => {
  const m = (pct: number, state: "fine" | "watch" | "almost" | "out", monthKey = "2026-10") => ({ pct, state, monthKey });

  it("the key is the PERCENT's: 80 and 90 share the month's 80 key, 100 is the 100 key, under 80 is nothing", () => {
    expect(usageNoticeKey(m(80, "watch"))).toBe("usage_80:2026-10");
    expect(usageNoticeKey(m(90, "almost"))).toBe("usage_80:2026-10");
    expect(usageNoticeKey(m(99, "almost"))).toBe("usage_80:2026-10");
    expect(usageNoticeKey(m(100, "out"))).toBe("usage_100:2026-10");
    expect(usageNoticeKey(m(40, "fine"))).toBeNull();
    expect(usageNoticeKey(m(79, "watch"))).toBeNull();
    // A new month is a new key: November's 80 is told again.
    expect(usageNoticeKey(m(80, "watch", "2026-11"))).toBe("usage_80:2026-11");
  });

  it("a watch BY PACE (50–79% with a run-out day) is the ring's color, never a notice: nothing is claimed and the month's 80 stamp is kept for the real 80%", () => {
    expect(usageNoticeKey(m(55, "watch"))).toBeNull();
    expect(usageNoticeKey(m(50, "watch"))).toBeNull();
    expect(usageNoticeKey(m(79, "watch"))).toBeNull();
    // Out is out whichever word the state carries.
    expect(usageNoticeKey(m(100, "almost"))).toBe("usage_100:2026-10");
  });

  it("the kind is read back from a key the ledger holds; a billing key is not a usage notice", () => {
    expect(usageNoticeKind("usage_80:2026-10")).toBe("80");
    expect(usageNoticeKind("usage_100:2026-12")).toBe("100");
    expect(usageNoticeKind("trial_3")).toBeNull();
    expect(usageNoticeKind("usage_80")).toBeNull();
    expect(usageNoticeKind("usage_50:2026-10")).toBeNull();
  });
});

describe("usageNoticeWords", () => {
  const window = { resetOn: "2026-11-01" };

  it("80, English: the title and the body with the reset day and the nothing-stops line", () => {
    expect(usageNoticeWords("usage_80:2026-10", window, en, "en")).toEqual({
      title: "Usage: 80% Of This Month",
      body: "Most of this month's usage is used. It resets Nov 1. Nothing stops: past 100%, Nort and the estimator run lighter until then.",
    });
  });

  it("100, English: used up, the lighter model until the reset, the one door", () => {
    expect(usageNoticeWords("usage_100:2026-10", window, en, "en")).toEqual({
      title: "Usage: Used Up For This Month",
      body: "This month's usage is used up, so Nort and the estimator run on the lighter model until Nov 1. Add usage or upgrade in Settings › Getting Paid.",
    });
  });

  it("both in Spanish, the date as 1 nov", () => {
    expect(usageNoticeWords("usage_80:2026-10", window, es, "es")).toEqual({
      title: "Uso: 80% De Este Mes",
      body: "Ya se usó la mayor parte de este mes. Se reinicia el 1 nov. Nada se detiene: pasado el 100%, Nort y el estimador corren más ligeros hasta entonces.",
    });
    expect(usageNoticeWords("usage_100:2026-10", window, es, "es")).toEqual({
      title: "Uso: Agotado Por Este Mes",
      body: "El uso de este mes se agotó, así que Nort y el estimador corren en el modelo más ligero hasta el 1 nov. Agrega uso o mejora tu plan en Ajustes › Cobros.",
    });
  });

  it("the titles are Title Case in both languages; a key that is not a usage notice answers null", () => {
    for (const key of ["usage_80:2026-10", "usage_100:2026-10"]) {
      expect(titleCase(usageNoticeWords(key, window, en, "en")!.title)).toBe(true);
      expect(titleCase(usageNoticeWords(key, window, es, "es")!.title)).toBe(true);
    }
    expect(usageNoticeWords("lapsed", window, en, "en")).toBeNull();
  });

  it("no notice names a dollar or a count of estimates", () => {
    for (const key of ["usage_80:2026-10", "usage_100:2026-10"]) {
      for (const [t, lang] of [[en, "en"], [es, "es"]] as const) {
        const w = usageNoticeWords(key, window, t, lang)!;
        expect(`${w.title} ${w.body}`).not.toMatch(/\$|\d+ (estimates|presupuestos)|token/i);
      }
    }
  });
});
