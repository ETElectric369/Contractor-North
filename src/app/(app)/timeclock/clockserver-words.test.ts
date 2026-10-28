import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * THE TIME CLOCK'S SERVER WORDS IN THE PERSON'S LANGUAGE (cn-v1138, builder T2).
 *
 * Every pure module the clock's doors share (lib/long-shift, close-math, which-job-choices,
 * clock-told, claim-words) takes an additive `lang` and answers from the cs_ catalog: a Spanish
 * caller reads Spanish, an English caller reads exactly what the code said before, and the English
 * constants other doors import are the catalog's English. The narrow-space hack became a normalizer
 * (plainSpaces). The "Which Job Are You On?" headline is ONE key (tc_whichJobHeadline) wherever this
 * builder's files say it. The stored records (the switch breadcrumb, the stop crumb, the sealed
 * held line) stay English, because other code reads them back by their words.
 */
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("./which-job-actions", () => ({
  whichJobChoices: vi.fn(async () => ({ ok: true, jobs: [], isStaff: false })),
  putPunchOnJob: vi.fn(async () => ({ ok: true })),
}));

import { dict, fillText, translator } from "@/lib/i18n";
import {
  CEILING_REFUSAL,
  CEILING_REFUSAL_ASK_OFFICE,
  LONG_SHIFT_HOURS,
  LONG_SHIFT_PHRASE,
  MAX_SHIFT_HOURS,
  MAX_SHIFT_PHRASE,
  PICK_WITHIN_CEILING,
  UNDO_PUNCH_SENTENCE,
  ceilingRefusal,
  ceilingRefusalAskOffice,
  longShiftPhrase,
  maxShiftPhrase,
  pickWithinCeiling,
  plainSpaces,
  stopProblem,
  undoPunchSentence,
} from "@/lib/long-shift";
import { durationSpan, lunchOnPriorAllowed, placeLunch, stopCrumb } from "./close-math";
import {
  ON_HOLD_WHY,
  choicesUnavailable,
  jobsDidntLoadSentence,
  noJobsToOffer,
  onHoldWhy,
  orderWhichJobChoices,
  pickOutcome,
  punchStillOn,
  sheetAfterLoad,
  type ChoiceJob,
} from "./which-job-choices";
import { CHANGE_JOB_LABEL, UNREAD_JOB_LABEL, appChoseSentence, changeJobLabel, replayTold, tellAppChose, unreadJobLabel } from "./clock-told";
import { billedPartMoved, claimedMoveRefusal, claimedPersonRefusal } from "./claim-words";
import { WhichJobSheetView } from "../planner/which-job";
import { switchBreadcrumb } from "./switch-breadcrumb";
import { codeOnly } from "@/lib/migration-body.test-util";

const en = dict("en");
const es = dict("es");
const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const H = 3_600_000;

describe("plainSpaces: the narrow-space hack is a normalizer", () => {
  it("turns the narrow no-break space (U+202F) and the no-break space (U+00A0) into plain ones and leaves plain ones alone", () => {
    expect(plainSpaces("1:37 PM")).toBe("1:37 PM");
  });

  it("writes the Spanish meridiem without its dots, so a sentence that ends on a clock keeps its own period", () => {
    expect(plainSpaces("1:37 p.m.")).toBe("1:37 pm");
    expect(plainSpaces("1:37 p.\u00A0m.")).toBe("1:37 pm");
    expect(plainSpaces("8:00 a.m. a 5:00 p.m.")).toBe("8:00 am a 5:00 pm");
    expect(plainSpaces("5:00 p.m., sin almuerzo")).toBe("5:00 pm, sin almuerzo");
    // Only the meridiem: a word that happens to start with a dotted p or m is left alone.
    expect(plainSpaces("p.m.x")).toBe("p.m.x");
    expect(plainSpaces("1:37 PM")).toBe("1:37 PM");
    expect(plainSpaces("a b c d")).toBe("a b c d");
  });
});

describe("lib/long-shift: the one refusal, the ceiling and the take-back, in the caller's language", () => {
  it("the English constants other doors import are the catalog's English", () => {
    expect(UNDO_PUNCH_SENTENCE).toBe(en.cs_undoPunchSentence);
    expect(undoPunchSentence("en")).toBe(UNDO_PUNCH_SENTENCE);
    expect(MAX_SHIFT_PHRASE).toBe(`${MAX_SHIFT_HOURS} hours`);
    expect(LONG_SHIFT_PHRASE).toBe(`more than ${LONG_SHIFT_HOURS} hours`);
    expect(PICK_WITHIN_CEILING).toBe(`Pick a time between clock-in and now, within ${MAX_SHIFT_HOURS} hours.`);
    expect(CEILING_REFUSAL.you).toBe(ceilingRefusal("you", "en"));
    expect(CEILING_REFUSAL.he).toBe(ceilingRefusal("he", "en"));
    expect(CEILING_REFUSAL_ASK_OFFICE).toBe(ceilingRefusalAskOffice("en"));
    expect(CEILING_REFUSAL_ASK_OFFICE).toMatch(/^That's more than 18 hours after you clocked in\. .* the office has to enter it\.$/);
  });

  it("a Spanish caller reads Spanish, with the same numbers in the same slots", () => {
    expect(undoPunchSentence("es")).toBe(es.cs_undoPunchSentence);
    expect(undoPunchSentence("es")).not.toBe(UNDO_PUNCH_SENTENCE);
    expect(maxShiftPhrase("es")).toBe(`${MAX_SHIFT_HOURS} horas`);
    expect(longShiftPhrase("es")).toBe(`más de ${LONG_SHIFT_HOURS} horas`);
    expect(pickWithinCeiling("es")).toBe(`Elige una hora entre la entrada y ahora, dentro de ${MAX_SHIFT_HOURS} horas.`);
    expect(ceilingRefusal("you", "es")).toBe(fillText(es.cs_ceilingRefusalYou, { max: `${MAX_SHIFT_HOURS} horas` }));
    expect(ceilingRefusalAskOffice("es")).toContain(ceilingRefusal("you", "es"));
    expect(ceilingRefusalAskOffice("es")).not.toMatch(/office has to enter/);
  });

  it("stopProblem answers in the caller's language and English when none is given", () => {
    const now = Date.parse("2001-01-02T01:00:00.000Z");
    const start = now - 3 * H;
    expect(stopProblem({ startMs: NaN, stopMs: now, nowMs: now, lunchMin: 0, who: "he" })).toBe("Pick a stop time.");
    expect(stopProblem({ startMs: NaN, stopMs: now, nowMs: now, lunchMin: 0, who: "he", lang: "es" })).toBe(es.cs_pickAStopTime);
    expect(stopProblem({ startMs: start, stopMs: now + 2 * H, nowMs: now, lunchMin: 0, who: "you", lang: "es" })).toBe(es.cs_timeHasntHappened);
    expect(stopProblem({ startMs: start, stopMs: now, nowMs: now, lunchMin: 4 * 60, who: "you", lang: "es" })).toBe(es.cs_lunchLongerThanShift);
    expect(stopProblem({ startMs: start, stopMs: now, nowMs: now, lunchMin: 4 * 60, who: "you" })).toBe("The lunch is longer than the shift.");
    // Past the ceiling: the refusal in the caller's voice and language.
    expect(stopProblem({ startMs: now - 19 * H, stopMs: now, nowMs: now, lunchMin: 0, who: "he", lang: "es" })).toBe(ceilingRefusal("he", "es"));
    expect(stopProblem({ startMs: now - 19 * H, stopMs: now, nowMs: now, lunchMin: 0, who: "he" })).toBe(CEILING_REFUSAL.he);
    // A stop before the start names the clock-in on the company's clock in the caller's language (no narrow space).
    const early = stopProblem({ startMs: start, stopMs: start - H, nowMs: now, lunchMin: 0, who: "you", tz: "America/Los_Angeles", lang: "es" })!;
    expect(early).toMatch(/^Elige una hora de salida después de las /);
    expect(early).not.toMatch(/[  ]/);
    expect(stopProblem({ startMs: start, stopMs: start - H, nowMs: now, lunchMin: 0, who: "you", tz: "America/Los_Angeles" })).toBe("Pick a stop time after 2:00 PM.");
  });
});

describe("close-math: the lunch rules and the duration span, in the caller's language", () => {
  const tz = "America/Los_Angeles";
  it("durationSpan refuses in Spanish for a Spanish caller and in the same English as before otherwise", () => {
    const nowMs = Date.parse("2001-01-02T01:00:00.000Z");
    expect(durationSpan({ workDate: "not a day", hours: 4, lunchMin: 0, tz, nowMs })).toEqual({ ok: false, error: "I couldn't read that date." });
    expect(durationSpan({ workDate: "not a day", hours: 4, lunchMin: 0, tz, nowMs, lang: "es" })).toEqual({ ok: false, error: es.cs_couldntReadDate });
    expect(durationSpan({ workDate: "2001-02-01", hours: 4, lunchMin: 0, tz, nowMs, lang: "es" })).toEqual({ ok: false, error: es.cs_dayHasntHappened });
    expect(durationSpan({ workDate: "2001-02-01", hours: 4, lunchMin: 0, tz, nowMs })).toEqual({ ok: false, error: en.cs_dayHasntHappened });
  });

  it("lunchOnPriorAllowed and placeLunch say why in the caller's language", () => {
    expect(lunchOnPriorAllowed({ lunchOnPrior: true, lunch: 30, existingHere: 45 }).warning).toBe("This part already has a 45-minute lunch on it, so it stays here.");
    expect(lunchOnPriorAllowed({ lunchOnPrior: true, lunch: 30, existingHere: 45, lang: "es" }).warning).toBe(fillText(es.cs_partAlreadyHasLunch, { min: "45" }));
    // A lunch longer than a 20-minute part with no part before: refused, in words.
    const here = { clock_in: "2001-01-01T21:00:00.000Z", clock_out: "2001-01-01T21:20:00.000Z" };
    const enRefusal = placeLunch({ hereLunch: 30, priorLunch: 0, priorId: null, here, prior: null, refuse: true });
    const esRefusal = placeLunch({ hereLunch: 30, priorLunch: 0, priorId: null, here, prior: null, refuse: true, lang: "es" });
    expect(enRefusal.ok).toBe(false);
    expect(esRefusal.ok).toBe(false);
    if (!enRefusal.ok && !esRefusal.ok) {
      expect(enRefusal.error).toMatch(/^A 30-minute lunch is longer than the 20 minutes on this shift\. Untick the lunch, or ask the office to fix it on Timecards\.$/);
      expect(esRefusal.error).toBe(
        fillText(es.cs_lunchLongerRefusal, { min: "30", worked: "20", unit: es.cs_minutes, part: es.cs_thisShift, paid: "" }),
      );
      expect(esRefusal.error).not.toMatch(/Untick the lunch/);
    }
  });

  it("the stop crumb is a stored record and stays English whatever the language", () => {
    const crumb = stopCrumb({ how: "office", byName: "Erik", atIso: "2001-01-02T01:00:00.000Z", runningSinceIso: "2001-01-01T21:37:00.000Z", newStartIso: null, tz });
    expect(crumb).toMatch(/^\[clocked out by Erik on .+; it had been running since Jan 1, 1:37 PM\]$/);
    expect(switchBreadcrumb("41 Larkspur", "2001-01-01T21:37:00.000Z")).toMatch(/^\[switched to 41 Larkspur at /);
  });
});

describe("which-job-choices: the sheet's own sentences in the caller's language", () => {
  const where = { moment: "in" as const };
  it("English callers read exactly what they read before", () => {
    expect(noJobsToOffer(false)).toBe(en.cs_noJobsAskTech);
    expect(noJobsToOffer(true, "move")).toBe(en.cs_noJobsMoveStaff);
    expect(punchStillOn(where)).toBe("still on no job");
    expect(jobsDidntLoadSentence(where)).toBe(en.cs_jobsDidntLoadAsk);
    expect(choicesUnavailable(false)).toBe(en.cs_choicesUnavailableAsk);
    expect(ON_HOLD_WHY).toBe("On hold: picking it takes it off hold");
    expect(onHoldWhy("en")).toBe(ON_HOLD_WHY);
  });

  it("a Spanish caller reads Spanish at every door of the sheet", () => {
    expect(noJobsToOffer(false, "in", "es")).toBe(es.cs_noJobsAskTech);
    expect(noJobsToOffer(true, "in", "es")).toBe(es.cs_noJobsAskStaff);
    expect(punchStillOn(where, "es")).toBe(es.cs_stillOnNoJob);
    expect(punchStillOn({ moment: "move", from: { label: "41 Larkspur" } }, "es")).toBe("sigue en 41 Larkspur");
    expect(jobsDidntLoadSentence(where, "es")).toBe(es.cs_jobsDidntLoadAsk);
    expect(choicesUnavailable(false, "es")).toBe(es.cs_choicesUnavailableAsk);
    expect(onHoldWhy("es")).toBe(es.cs_onHoldWhy);
    expect(sheetAfterLoad({ ok: true, jobs: [], isStaff: false }, { confirmInline: false, moment: "in", lang: "es" })).toEqual({ close: true, sentence: es.cs_noJobsAskTech });
  });

  it("the why under a job row follows the language", () => {
    const todayStr = "2001-01-01";
    const tz = "America/Los_Angeles";
    const jobs: ChoiceJob[] = [
      { id: "j1", job_number: "J-028", name: "Larkspur deck", address: "41 Larkspur", status: "in_progress", scheduled_start: null, scheduled_end: null, created_at: "2000-12-01T00:00:00.000Z", customers: null },
      { id: "j2", job_number: "J-030", name: "Snowbell panel", address: "7 Snowbell", status: "on_hold", scheduled_start: null, scheduled_end: null, created_at: "2000-12-02T00:00:00.000Z", customers: null },
    ];
    // j2 is on today's schedule by its segment and on hold: it goes last and its why says so.
    const base = { jobs, lastJobId: "j1", segToday: new Set<string>(["j2"]), hasSegments: new Set<string>(["j2"]), todayStr, tz, codesOn: false };
    const enWhy = orderWhichJobChoices(base).map((o) => o.why);
    const esWhy = orderWhichJobChoices({ ...base, lang: "es" }).map((o) => o.why);
    expect(enWhy).toContain("Where you worked last");
    expect(enWhy).toContain(ON_HOLD_WHY);
    expect(esWhy).toContain(es.cs_whereYouWorkedLast);
    expect(esWhy).toContain(es.cs_onHoldWhy);
  });

  it("pickOutcome's sentences follow the language, English unchanged", async () => {
    const job = { id: "j1", label: "41 Larkspur" };
    const landed = await pickOutcome(async () => ({ ok: true }), "e1", job, where, "es");
    expect(landed).toMatchObject({ kind: "placed", sentence: "Tu marcación está en 41 Larkspur." });
    const offline = await pickOutcome(async () => { throw new Error("offline"); }, "e1", job, where, "es");
    expect(offline).toEqual({ kind: "refused", sentence: fillText(es.cs_noConnectionPunchStill, { still: es.cs_stillOnNoJob, orSkip: es.cs_orSkip }) });
    const offlineEn = await pickOutcome(async () => { throw new Error("offline"); }, "e1", job, where);
    expect(offlineEn).toEqual({ kind: "refused", sentence: "No connection, so the punch is still on no job. Try again when you have a bar or two, or skip." });
  });
});

describe("clock-told: the sentence the app says about the job it chose, in the caller's language", () => {
  it("the English constants are the catalog's English and the Spanish differs", () => {
    expect(UNREAD_JOB_LABEL).toBe(en.cs_unreadJobLabel);
    expect(unreadJobLabel("en")).toBe(UNREAD_JOB_LABEL);
    expect(unreadJobLabel("es")).toBe(es.cs_unreadJobLabel);
    expect(CHANGE_JOB_LABEL).toBe("Change The Job");
    expect(changeJobLabel("es")).toBe("Cambiar El Trabajo");
    // The English sentence is asserted through the catalog: clock-told.test.ts refuses a second copy of its words.
    expect(appChoseSentence("41 Larkspur", "schedule")).toBe(fillText(en.cs_appChoseSentence, { label: "41 Larkspur", because: en.cs_fromTodaysSchedule }));
    expect(appChoseSentence("41 Larkspur", "schedule")).toMatch(/^Your punch is on 41 Larkspur\. /);
    expect(appChoseSentence("41 Larkspur", "schedule", "es")).toBe("Tu marcación está en 41 Larkspur. La app lo eligió del calendario de hoy — cámbialo si estás en otro lugar.");
    expect(appChoseSentence("41 Larkspur", "only-job", "es")).toContain(es.cs_becauseOnlyJob);
  });

  it("tellAppChose and replayTold carry the language through", () => {
    const res = { ok: true, id: "e1", jobPick: { chosenBy: "app" as const, id: "j1", from: "schedule" as const, label: "41 Larkspur" } };
    expect(tellAppChose(res, "es")?.sentence).toMatch(/^Tu marcación está en 41 Larkspur\./);
    expect(tellAppChose(res, "es")?.say).toContain("Cambiar El Trabajo");
    expect(tellAppChose(res)?.say).toContain("Change The Job");
    expect(replayTold(res, "es").told?.sentence).toMatch(/^Tu marcación está en 41 Larkspur\./);
    expect(replayTold(res).told?.sentence).toMatch(/^Your punch is on 41 Larkspur\./);
  });
});

describe("claim-words: the invoice refusals in the caller's language", () => {
  const holder = { id: "inv-1", invoice_number: "INV-078" };
  it("English unchanged, Spanish for a Spanish caller", () => {
    expect(claimedMoveRefusal(holder)).toBe("INV-078 already bills this shift — void or adjust that invoice before moving its hours to another job. Nothing was changed.");
    expect(claimedMoveRefusal(holder, "es")).toBe(fillText(es.cs_claimedMoveRefusal, { invoice: "INV-078" }));
    expect(claimedPersonRefusal(holder, "Brian", "es")).toBe(fillText(es.cs_claimedPersonRefusal, { invoice: "INV-078", whose: fillText(es.cs_asPersonsHours, { name: "Brian" }) }));
    // A holder with no number is "an invoice" / "una factura", lowercase at the head as it always was.
    expect(claimedPersonRefusal({ id: "inv-2", invoice_number: null }, null)).toMatch(/^an invoice already bills this shift — /);
    expect(claimedPersonRefusal({ id: "inv-2", invoice_number: null }, null, "es")).toMatch(/^una factura ya factura este turno — /);
    expect(billedPartMoved(holder, 5, 4.5)).toBe("INV-078 bills 5.00 h of this shift and that part now reads 4.50 h. The invoice keeps its figure; adjust it by hand if the customer should pay for the difference.");
    expect(billedPartMoved(holder, 5, 4.5, "es")).toMatch(/^INV-078 factura 5\.00 h de este turno y esa parte ahora marca 4\.50 h\./);
  });
});

describe("the Which Job sheet renders in the language it is handed, with no hook of its own", () => {
  const jobs = [
    { id: "j28", label: "41 Larkspur", why: "Donde trabajaste la última vez" },
    { id: "j30", label: "7 Snowbell" },
  ];
  const props = (lang: "en" | "es") => ({ moment: "in" as const, state: { phase: "ready" as const, jobs, isStaff: false }, lang, onPick: vi.fn(), onSkip: vi.fn() });
  it("Spanish: the headline is the Time Clock's own key, the Skip door is Title Case, the rows are the jobs", () => {
    const html = renderToStaticMarkup(createElement(WhichJobSheetView, props("es")));
    expect(html).toContain(es.tc_whichJobHeadline);
    expect(html).toContain("Omitir, La Oficina Elige");
    expect(html).toContain("41 Larkspur");
    expect(html).not.toContain("Skip, The Office Will Pick");
    expect(html).not.toContain("Which Job Are You On?");
  });
  it("English, and the default with no language, read as before", () => {
    const html = renderToStaticMarkup(createElement(WhichJobSheetView, props("en")));
    expect(html).toContain("Which Job Are You On?");
    expect(html).toContain("Skip, The Office Will Pick");
    const plain = WhichJobSheetView({ moment: "in", state: { phase: "loading" }, onPick: vi.fn(), onSkip: vi.fn() });
    expect(renderToStaticMarkup(plain)).toContain("Finding your jobs…");
  });
});

describe("source pins: one key for the headline, the catalog behind every door, the records left English", () => {
  const files = [
    "src/app/(app)/planner/which-job.tsx",
    "src/app/(app)/timeclock/actions.ts",
    "src/app/(app)/timeclock/which-job-actions.ts",
    "src/app/(app)/timeclock/which-job-choices.ts",
    "src/app/(app)/timeclock/clock-told.ts",
    "src/components/offline-drain.tsx",
  ];
  it("no file of this builder's spells the headline itself: the sheet reads tc_whichJobHeadline", () => {
    for (const f of files) {
      const src = codeOnly(read(f));
      expect(src, f).not.toMatch(/Which [Jj]ob [Aa]re [Yy]ou [Oo]n\?/);
    }
    expect(read("src/app/(app)/planner/which-job.tsx")).toContain('title={t("tc_whichJobHeadline")}');
    expect(en.tc_whichJobHeadline).toBe("Which Job Are You On?");
    expect(translator("es")("tc_whichJobHeadline")).not.toBe("Which Job Are You On?");
  });

  it("the offline drain and the Which Job sheet read the person's language and hand it down", () => {
    const drain = read("src/components/offline-drain.tsx");
    expect(drain).toContain("const lang = useLang();");
    expect(drain).toContain("replayTold(res, lang)");
    expect(drain).toContain('toLocaleTimeString(localeOf(lang), { hour: "numeric", minute: "2-digit" })');
    for (const key of ["cs_gotIt", "cs_theseNeverFiled", "cs_serverWouldntAccept", "cs_clearIt", "cs_checkTimecardFirst", "cs_hide", "cs_details"]) expect(drain).toContain(`t("${key}")`);
    expect(drain).toContain('fillText(t(blocked === 1 ? "cs_blockedOne" : "cs_blockedMany"), { n: String(blocked) })');
    const sheet = read("src/app/(app)/planner/which-job.tsx");
    expect(sheet).toContain("sheetAfterLoad(r, { confirmInline, moment, lang })");
    expect(sheet).toContain("jobsDidntLoadSentence(where, lang)");
    expect(sheet).toContain("pickOutcome((eid, jid) => putPunchOnJob(eid, jid, fromId), entryId, job, where, lang)");
    expect(sheet).toContain("lang={lang}");
  });

  it("the server reads the caller's language once per door and keeps the records English", () => {
    const a = read("src/app/(app)/timeclock/actions.ts");
    expect(a).toContain('select("org_id, language")'); // the punch's own read carries it
    expect(a).toContain('select("org_id, full_name, language")'); // the daily report's own read carries it
    expect(a).toContain("const lang = input.lang ?? (await callerLang(supabase, user.id));"); // clockOut takes it from a door that read it
    expect(a).toContain("const lang = input.lang ?? (await callerLang(supabase, ctx.userId));"); // stopShift too; the caller's id is in hand
    expect(a).toContain('if (!user) return { ok: false, error: en("cs_notSignedIn") };'); // nobody to read a language for
    // The clock-out words (lib/long-shift) are read in the caller's language at every door (cn-v1138, S4).
    expect(a).toContain("const said = clockedOutWords(ownerFull, self, lang);");
    expect(a).toContain("const w = clockedOutWords(fullName, isSelf, lang);");
    expect(a).toContain("door: clockDoorWords(fullName, { self: isSelf, lang }).clockOut,");
    expect(a).toContain("verb: clockedOutWords(ownerName, false, lang).clockOutVerb,");
    expect(a).toContain("door: clockDoorWords(ownerName, { lang }).clockOut,");
    expect(a).toContain("clockedOutWords(owner?.full_name, stored.profile_id === ctx.userId, lang).clockOutFirst");
    expect(a).not.toMatch(/clockedOutWords\([^)]*\)(?<!lang\))\./); // no door reads them without a language
    expect(a).not.toMatch(/const is = isSelf \? "are" : "is";/); // the verb is the catalog's (cs_is…)
    // A member with no name is "A crew member" whole, never "A" (the firstName of that phrase).
    expect(a).toContain('const first = stopName ? firstName(stopName, l) : tl("cs_aCrewMember");');
    // The language read for a push names the company (lang-of's org argument).
    expect(a).toContain("langOf(supabase, [stored.profile_id], stored.org_id)");
    expect(a).toContain("return plainSpaces(d.toLocaleTimeString(localeOf(lang), { timeZone: tz, hour: \"numeric\", minute: \"2-digit\" }));");
    expect(a).not.toMatch(/\.replace\(\/[  ]\/g, " "\)/); // the hack is gone: plainSpaces is the one normalizer
    expect(a).not.toContain('"en-US"');
    // The stored records.
    expect(a).toContain('? "closed automatically from the last GPS fix at the job site — nobody answered the prompt"');
    expect(a).toContain("title: `Daily report from ${name}`,");
    expect(a).toContain('label: jobId ? labelMap.get(jobId) ?? "a job" : "No job set",');
    expect(a).toContain("switchBreadcrumb(label, nowIso)");
    expect(a).toContain('const label = labelFor("en");');
    // The pushes that leave the caller's hands are written per reader (the function forms).
    expect(a).toContain('createNotifications(stored.org_id, [stored.profile_id], (l) => ({ type: "clock_stopped", ...words(l) })),');
    expect(a).toContain('sendPushToProfiles([stored.profile_id], "clock_out", words(memberLang)),');
    expect(a).toContain('await notifyPeople((me as { org_id?: string | null } | null)?.org_id ?? null, [user.id], "clock_out", (l) => {');
    expect(a).toContain('if (!open) return { ok: false, error: t("cs_notClockedIn"), ended: true };');
    const w = read("src/app/(app)/timeclock/which-job-actions.ts");
    expect(w).toContain('select("role, language")');
    expect(w).toContain("const t = translator(await callerLang(supabase, user.id));");
    const c = read("src/app/(app)/timeclock/crew-actions.ts");
    expect(c).toContain("langOf(supabase, [profileId], job.org_id)");
    expect(c).toContain("const t = translator(await callerLang(supabase, ctx.userId));");
    expect(c).toContain('await createNotifications(job.org_id, [profileId], (lang) => ({ type: "assigned", ...words(lang) }));');
    expect(c).toContain('await sendPushToProfiles([profileId], "assigned", words(memberLang));');
    const cm = read("src/app/(app)/timeclock/close-math.ts");
    expect(cm).toContain('toLocaleDateString("en-US", { timeZone: input.tz })'); // the stored stop crumb compares days in English, as a record
    const ls = read("src/lib/long-shift.ts");
    expect(ls).toContain('export function plainSpaces(s: string): string {');
    expect(ls).toContain('return s.replace(/[\\u202F\\u00A0]/g, " ").replace(/\\b([ap])\\.\\s?m\\.(?!\\w)/gi, "$1m");');
  });
});
