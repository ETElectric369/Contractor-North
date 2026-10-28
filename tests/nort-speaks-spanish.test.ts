import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bestVoice, speakable, voiceLang } from "@/lib/tts";
import { greetingPhrase, holdingWords } from "@/lib/nort/greeting";
import { CATALOGS, dict } from "@/lib/i18n";
import { words as nort } from "@/lib/words/nort";
import { recoveredLines, spotMissNote, suggestionsFor } from "@/app/(app)/assistant/assistant-chat";

/**
 * NORT HEARS AND SPEAKS SPANISH (cn-v1138). The pure halves of the wave, on their own: the spoken
 * forms of the trade's notation in Spanish (speakable), the browser voice by language (bestVoice),
 * the language the page carries to the voice (voiceLang), the greeting's words, the chat's first
 * suggestions by role and language, and the mic's language hint (voice-stream). The English in each
 * is byte for byte what it was — the older suites pin that; this one pins the Spanish beside it.
 */
const ROOT = process.cwd();
const src = (f: string) => readFileSync(join(ROOT, f), "utf8");

describe("speakable, in Spanish", () => {
  it("doc numbers speak as their Spanish type", () => {
    expect(speakable("Saved E-009 for Luis.", "es")).toContain("presupuesto 9");
    expect(speakable("INV-00080 is unpaid", "es")).toContain("factura 80");
    expect(speakable("on J-047 today", "es")).toContain("trabajo 47");
    expect(speakable("WO-001 done", "es")).toContain("orden de trabajo 1");
    expect(speakable("CO-002 signed", "es")).toContain("orden de cambio 2");
    expect(speakable("PO-003 sent", "es")).toContain("orden de compra 3");
  });

  it("units and electrical notation expand to Spanish words", () => {
    expect(speakable("pull #10 AWG", "es")).toContain("número 10");
    expect(speakable("ran 30' of 10/3 NM-B", "es")).toContain("30 pies");
    expect(speakable('6" box', "es")).toContain("6 pulgadas");
    expect(speakable("a 200A panel", "es")).toContain("200 amperios");
    expect(speakable("240V circuit", "es")).toContain("240 voltios");
    expect(speakable("12 kWh a day", "es")).toContain("12 kilovatios hora");
    expect(speakable("4/0 aluminum SER", "es")).toContain("cuatro cero aluminum");
    expect(speakable("ran 10/3 Romex", "es")).toContain("10 3 Romex");
    expect(speakable("T&M job", "es")).toContain("tiempo y materiales");
    expect(speakable("2 4S boxes", "es")).toContain("cuatro S");
    expect(speakable("worked 3.5 hrs", "es")).toContain("3.5 horas");
    expect(speakable("2 ea @ 15%", "es")).toContain("2 cada uno");
    expect(speakable("2 ea @ 15%", "es")).toContain("15 por ciento");
    expect(speakable("3 × 20", "es")).toContain("3 por 20");
    expect(speakable("200 sq ft", "es")).toContain("200 pies cuadrados");
  });

  it("money speaks in dólares, cents with 'con'", () => {
    expect(speakable("total $5,550.00", "es")).toContain("5,550 dólares");
    expect(speakable("total $5,550.00", "es")).not.toContain(".00");
    expect(speakable("$82.50 in parts", "es")).toContain("82 dólares con 50 centavos");
  });

  it("the default is English, byte for byte as before; a street name expands the same in both", () => {
    expect(speakable("Saved E-009 for John.")).toContain("estimate 9");
    expect(speakable("a 200A panel")).toContain("200 amp");
    expect(speakable("the Acacia Ct job", "es")).toContain("Acacia Court");
  });
});

describe("the browser voice and the page's language", () => {
  const g = globalThis as any;
  afterEach(() => {
    delete g.window;
    delete g.document;
  });

  it("bestVoice prefers an es-* voice for Spanish and an en-* voice otherwise, and falls back to any voice", () => {
    const voices = [
      { name: "Monica", lang: "es-ES", localService: true },
      { name: "Samantha", lang: "en-US", localService: true },
      { name: "Paulina", lang: "es-MX", localService: false },
    ];
    g.window = { speechSynthesis: { getVoices: () => voices } };
    expect(bestVoice("es")?.name).toBe("Paulina"); // es-*, and the better score (not local)
    expect(bestVoice("en")?.name).toBe("Samantha");
    g.window = { speechSynthesis: { getVoices: () => voices.slice(1, 2) } };
    expect(bestVoice("es")?.name).toBe("Samantha"); // none in Spanish: any voice beats silence
    g.window = { speechSynthesis: { getVoices: () => [] } };
    expect(bestVoice("es")).toBeNull();
  });

  it("voiceLang reads the document's lang (what the LangProvider writes); English outside a document", () => {
    expect(voiceLang()).toBe("en");
    g.document = { documentElement: { lang: "es" } };
    expect(voiceLang()).toBe("es");
    g.document = { documentElement: { lang: "es-US" } };
    expect(voiceLang()).toBe("es");
    g.document = { documentElement: { lang: "" } };
    expect(voiceLang()).toBe("en");
  });

  it("every clip request carries the language, and the browser utterance is tagged with it", () => {
    const tts = src("src/lib/tts.ts");
    expect(tts.match(/JSON\.stringify\(\{ text: t, lang \}\)/g)?.length).toBe(2); // fetchClip and clipTwice
    expect(tts).toContain("u.lang = localeOf(lang);");
    expect(tts).toContain("constructor(onDone?: () => void, lang: Lang = voiceLang())");
  });
});

describe("the greeting, in Spanish", () => {
  it("hello by the hour, the name as it is, the question", () => {
    expect(greetingPhrase({ hour: 7, name: "Luis", lang: "es" })).toBe("Buenos días, Luis. ¿Qué necesitas?");
    expect(greetingPhrase({ hour: 19, name: "Luis", lang: "es" })).toBe("Buenas tardes, Luis. ¿Qué necesitas?");
    expect(greetingPhrase({ hour: 14, name: null, lang: "es" })).toBe("Hola. ¿Qué necesitas?");
    expect(greetingPhrase({ hour: 7, name: "Erik" })).toBe("Morning, Erik. What do you need?"); // the default: English, as before
  });

  it("what Nort is holding, one and many, with how far back it goes", () => {
    expect(greetingPhrase({ hour: 7, name: "Luis", lang: "es", holding: { reports: 0, dailyReports: [{ from: "Brian" }] } })).toBe(
      "Buenos días, Luis. Tengo el reporte del día de Brian. ¿Lo vemos ahora?",
    );
    expect(holdingWords({ reports: 0, dailyReports: [{ from: "Brian" }, { from: "Dan" }] }, "es")).toBe("los reportes del día de Brian y Dan");
    expect(holdingWords({ reports: 0, dailyReports: [{ from: "a" }, { from: "b" }, { from: "c" }] }, "es")).toBe("tres reportes del día");
    expect(holdingWords({ reports: 1, dailyReports: [], reportsBack: "julio" }, "es")).toBe("una actualización sobre cosas que reportaste, de julio");
    expect(holdingWords({ reports: 15, dailyReports: [], reportsBack: "julio" }, "es")).toBe("15 actualizaciones sobre cosas que reportaste, desde julio");
    expect(greetingPhrase({ hour: 7, name: "Luis", lang: "es", holding: { reports: 2, dailyReports: [{ from: "Brian" }] } })).toBe(
      "Buenos días, Luis. Tengo el reporte del día de Brian y dos actualizaciones sobre cosas que reportaste. ¿Lo vemos todo ahora?",
    );
    // The English, untouched.
    expect(holdingWords({ reports: 2, dailyReports: [{ from: "Brian" }], reportsBack: "July" })).toBe("Brian's daily report and two updates on things you reported, filed as far back as July");
  });
});

describe("the chat door's words", () => {
  it("the first suggestions are a tech's or the office's, in the person's language; an unknown role sees the tech's", () => {
    expect(suggestionsFor("tech", "en")).toEqual(["Clock me in on the job I'm at.", "What's on my list today?", "Where's the materials list for this job?", "What's my next job?"]);
    expect(suggestionsFor("tech", "es")).toEqual(["Márcame entrada en el trabajo donde estoy.", "¿Qué hay en mi lista de hoy?", "¿Dónde está la lista de materiales de este trabajo?", "¿Cuál es mi siguiente trabajo?"]);
    expect(suggestionsFor("owner", "en")).toEqual(["Start an estimate — I'll tell you what's on it.", "What's on the schedule this week?", "Which invoices are still unpaid?", "Show me my open estimates and their totals."]);
    expect(suggestionsFor("office", "es")[2]).toBe("¿Qué facturas siguen sin pagar?");
    expect(suggestionsFor(null, "en")).toEqual(suggestionsFor("tech", "en"));
    for (const role of ["tech", "owner"]) for (const lang of ["en", "es"] as const) expect(suggestionsFor(role, lang)).toHaveLength(4);
    // The residual lines and the spot-miss note follow the language too; their English is the old text.
    expect(recoveredLines({ text: "", confirm: null, stale: true }, true, "es").map((l) => l.content)).toEqual([dict("es").nt_expiredConfirm, dict("es").nt_screenStepsLost]);
    expect(spotMissNote(null, "es")).toBe("No encontré ese punto en esta pantalla.");
    expect(spotMissNote("la pestaña Costos", "es")).toBe("No encontré la pestaña Costos en esta pantalla.");
  });

  it("the role reaches the chat from the shell, and the mic starts with the person's language", () => {
    expect(src("src/components/app-shell/topbar.tsx")).toContain("role={p?.role ?? null}");
    expect(src("src/components/global-assistant.tsx")).toContain("glass role={role}");
    expect(src("src/components/global-assistant.tsx")).toContain("speech.startListening(localeOf(lang));");
    expect(src("src/components/global-assistant.tsx")).toContain("const lang = voiceLang();"); // off the document at the tap, never a stale closure
    expect(src("src/app/(app)/assistant/assistant-chat.tsx").match(/speech\.startListening\(localeOf\(lang\)\)/g)?.length).toBe(2); // startMic and confirmListen
    const vs = src("src/lib/voice-stream.ts");
    expect(vs).toContain('if (turnLang) fd.append("lang", turnLang);');
    expect(vs).not.toContain("_lang?: string");
  });

  it("the catalog names its screens and holds the chrome in both languages, Title Case on the doors", () => {
    expect(nort.files).toEqual(["src/app/(app)/assistant/assistant-chat.tsx", "src/app/(app)/assistant/error.tsx", "src/lib/nort/greeting.ts", "src/app/api/transcribe/route.ts"]);
    expect(CATALOGS.some((c) => c.prefix === "nt_")).toBe(true);
    expect(Object.keys(nort.en).length).toBeGreaterThanOrEqual(100);
    for (const k of ["nt_saveEstimate", "nt_saveDraft", "nt_send", "nt_newChat", "nt_yesDoIt", "nt_cancel", "nt_endConversation", "nt_reload", "nt_restart", "nt_restarting", "nt_view"]) {
      for (const lang of ["en", "es"] as const) {
        const words = dict(lang)[k].split(/\s+/).filter((w) => /\p{L}/u.test(w));
        expect(words.every((w) => w[0] === w[0].toUpperCase()), `${lang} ${k} "${dict(lang)[k]}"`).toBe(true);
      }
    }
    expect(dict("en").nt_dropped).toBe("The connection dropped before Nort's answer arrived — Reload to check for it, or ask again.");
    expect(dict("es").nt_dropped).toMatch(/^Se cortó la conexión/);
  });
});

describe("voice-stream remembers the turn's language", () => {
  beforeEach(() => vi.resetModules());
  it("an es-US start is Spanish, a start with no tag keeps it, en-US is English", async () => {
    vi.doMock("@/app/report-client-error", () => ({ reportClientError: vi.fn(async () => {}) }));
    vi.doMock("@/lib/nort/trace", () => ({ trace: vi.fn(), flushTrace: vi.fn() }));
    const v = await import("@/lib/voice-stream");
    expect(v.turnLanguage()).toBeNull();
    v.startListening("es-US"); // no mic here: it returns false, but the language is remembered first
    expect(v.turnLanguage()).toBe("es");
    v.startListening();
    expect(v.turnLanguage()).toBe("es");
    v.startListening("en-US");
    expect(v.turnLanguage()).toBe("en");
  });
});
