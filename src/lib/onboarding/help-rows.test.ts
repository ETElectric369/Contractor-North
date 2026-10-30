import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/tts", () => ({ unlockAudio: vi.fn() }));

import { helpRows } from "./help-rows";
import { dict, translator } from "@/lib/i18n";
import { ALL_ON } from "@/lib/features";

/**
 * THE HELP ROWS' WORDS (cn-v1139): the four rows and their lines are the shell catalog's sh_help_
 * keys, read through the translator the caller hands in. Not handed one, the rows say — byte for
 * byte — what they said before the catalog: every test that reads them in English stays green.
 */
const DONE = { full_name: "Pat Lee", trade: "Electrical", city: "Truckee", service_area: "Tahoe", labor_rate: 120 };
const open2 = { ...DONE, service_area: null, labor_rate: null };

describe("helpRows", () => {
  it("English, with no translator: the old literals, byte for byte", () => {
    const start = helpRows({ isStaff: true, onboarded: false, setup: {}, nortOn: true, features: ALL_ON });
    expect(start.map((r) => [r.label, r.sub])).toEqual([
      ["Start Here", "Nort shows you around, out loud, and asks what he needs."],
      ["Show Me How", "Why Lines, Getting Around, How a Job Runs."],
      ["Take The Setup Again", "Setup from the top. Change anything you told Nort."],
    ]);
    const quiet = helpRows({ isStaff: true, onboarded: false, setup: {}, nortOn: false, features: ALL_ON });
    expect(quiet[0].sub).toBe("A few questions about the business, and where everything lives.");
    expect(quiet[quiet.length - 1].sub).toBe("The setup questions from the top. Change any answer.");
    const finish = helpRows({ isStaff: true, onboarded: true, setup: open2, nortOn: true, features: ALL_ON })[0];
    expect(finish.label).toBe("Finish Setting Up · 2 Left");
    expect(finish.sub).toMatch(/^Still missing: .+\.$/);
    // The English translator is the same words.
    expect(helpRows({ isStaff: true, onboarded: false, setup: {}, nortOn: true, features: ALL_ON, t: translator("en") })).toEqual(start);
  });

  it("Spanish: Empieza Aquí, Terminar La Configuración · Pendiente: 2, Muéstrame Cómo, Repetir La Configuración — the same keys, requests and lessons", () => {
    const es = translator("es");
    const rows = helpRows({ isStaff: true, onboarded: true, setup: open2, nortOn: true, features: ALL_ON, t: es });
    expect(rows.map((r) => [r.key, r.label])).toEqual([
      ["finish", "Terminar La Configuración · Pendiente: 2"],
      ["lessons", "Muéstrame Cómo"],
      ["again", "Repetir La Configuración"],
    ]);
    expect(rows[0].sub).toMatch(/^Todavía falta: .+\.$/);
    expect("request" in rows[0] && rows[0].request).toBe("finish");
    expect("request" in rows[2] && rows[2].request).toBe("tour");
    // The lessons' own titles are the tour's and stay English (the office's side).
    expect("lessons" in rows[1] && rows[1].lessons.map((l) => l.label)).toEqual(["Why Lines", "Getting Around", "How a Job Runs"]);
    const start = helpRows({ isStaff: true, onboarded: false, setup: {}, nortOn: false, features: ALL_ON, t: es });
    expect(start[0]).toMatchObject({ key: "start", label: "Empieza Aquí", sub: "Unas preguntas sobre el negocio y dónde está cada cosa.", request: "questions" });
    expect(start[start.length - 1].sub).toBe("Las preguntas de configuración desde el principio. Cambia cualquier respuesta.");
    // A tech has no setup to run, in any language.
    expect(helpRows({ isStaff: false, onboarded: false, setup: {}, nortOn: true, features: ALL_ON, t: es })).toEqual([]);
  });

  it("the keys: nine sh_help_ words, the four clickables Title Case in both languages, the lines sentences", () => {
    const keys = Object.keys(dict("en")).filter((k) => k.startsWith("sh_help_"));
    expect(keys.sort()).toEqual(
      ["sh_help_again", "sh_help_againNort", "sh_help_againQuiet", "sh_help_finish", "sh_help_finishSub", "sh_help_showMeHow", "sh_help_startHere", "sh_help_startHereNort", "sh_help_startHereQuiet"].sort(),
    );
    for (const k of ["sh_help_startHere", "sh_help_finish", "sh_help_showMeHow", "sh_help_again"]) {
      for (const lang of ["en", "es"] as const) {
        for (const w of dict(lang)[k].replace(/\{\w+\}/g, "").split(/\s+/).filter(Boolean)) expect(w, `${lang}:${k}`).toMatch(/^[\p{Lu}·]/u);
      }
    }
    for (const k of ["sh_help_startHereNort", "sh_help_startHereQuiet", "sh_help_finishSub", "sh_help_againNort", "sh_help_againQuiet"]) {
      for (const lang of ["en", "es"] as const) expect(dict(lang)[k], `${lang}:${k}`).toMatch(/\.$/);
    }
  });
});
