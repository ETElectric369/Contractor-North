import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * CARRIED OVER, ON MY DAY AND AT THE CLOCK (cn-v1169).
 *
 * The owner, 2026-11-18: three jobs booked for the day before, nobody clocked in on anything, and
 * My Day that morning listed only the job booked for that day. Asked whether a job that slipped past
 * its day should stay on My Day with a door to do it today and be offered at clock-in: "check it and
 * go for both", then "yes to slipped jobs".
 *
 * The rule is lib/schedule/carried-over's and is tested there. Here:
 *   · Do Today's one tap (doToday): what the schedule's own move answered, in every branch;
 *   · the button as a person reads it, in both languages;
 *   · where My Day draws the group and who gets the door (pinned at the page's source: the page is a
 *     server component with a dozen reads, and no test renders it);
 *   · the order the clock's "Which Job Are You On?" sheet offers them in.
 * Names are invented.
 */
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/components/toast", () => ({ useToast: () => vi.fn() }));
vi.mock("../schedule/actions", () => ({ moveJobDay: vi.fn() }));

const { doToday, DoTodayButton } = await import("./do-today-button");
const { LangProvider } = await import("@/components/lang-provider");
const { dict, translator, fillText } = await import("@/lib/i18n");
const { localeOf } = await import("@/lib/locale");
const { shortDay } = await import("@/lib/come-back-days");
const { orderWhichJobChoices } = await import("../timeclock/which-job-choices");

const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
type Move = Parameters<typeof doToday>[0];

describe("doToday: one tap on a carried-over job", () => {
  it("moves the day it was booked for to today, through the schedule's own move, and says a kept day when there is one", async () => {
    const move = vi.fn(async () => ({ ok: true })) as unknown as Move;
    expect(await doToday(move, "job-1", "2026-11-17", "2026-11-18")).toEqual({ kind: "moved", note: null });
    expect(move).toHaveBeenCalledExactlyOnceWith("job-1", "2026-11-17", "2026-11-18", undefined);
    const kept = vi.fn(async () => ({ ok: true, note: "Kept Nov 16 where it was worked. 1 day moved to Nov 18." })) as unknown as Move;
    expect(await doToday(kept, "job-1", "2026-11-17", "2026-11-18")).toEqual({ kind: "moved", note: "Kept Nov 16 where it was worked. 1 day moved to Nov 18." });
  });

  it("a date-pick link out to the customer is an ASK, and nothing has moved", async () => {
    const move = vi.fn(async () => ({ ok: false, needsProposalConfirm: true, error: "A date-pick link is out…" })) as unknown as Move;
    expect(await doToday(move, "job-1", "2026-11-17", "2026-11-18")).toEqual({ kind: "ask" });
    expect(move).toHaveBeenCalledTimes(1);
  });

  it("the second tap withdraws the link and moves; a link still in the way then is a refusal in the server's words, never a second ask", async () => {
    const move = vi.fn(async () => ({ ok: true })) as unknown as Move;
    expect(await doToday(move, "job-1", "2026-11-17", "2026-11-18", true)).toEqual({ kind: "moved", note: null });
    expect(move).toHaveBeenCalledExactlyOnceWith("job-1", "2026-11-17", "2026-11-18", { cancelProposals: true });
    const stuck = vi.fn(async () => ({ ok: false, needsProposalConfirm: true, error: "The link could not be withdrawn." })) as unknown as Move;
    expect(await doToday(stuck, "job-1", "2026-11-17", "2026-11-18", true)).toEqual({ kind: "refused", error: "The link could not be withdrawn." });
  });

  it("a refusal carries the server's sentence; a request that never came back says so with none", async () => {
    const refused = vi.fn(async () => ({ ok: false, error: "This action is staff-only." })) as unknown as Move;
    expect(await doToday(refused, "job-1", "2026-11-17", "2026-11-18")).toEqual({ kind: "refused", error: "This action is staff-only." });
    const blank = vi.fn(async () => ({ ok: false, error: "  " })) as unknown as Move;
    expect(await doToday(blank, "job-1", "2026-11-17", "2026-11-18")).toEqual({ kind: "refused", error: null });
    const dead = vi.fn(async () => {
      throw new Error("Failed to fetch");
    }) as unknown as Move;
    expect(await doToday(dead, "job-1", "2026-11-17", "2026-11-18")).toEqual({ kind: "refused", error: null });
  });
});

describe("the Do Today button, as a person reads it", () => {
  const el = () => createElement(DoTodayButton, { jobId: "job-1", bookedDay: "2026-11-17", todayStr: "2026-11-18", className: "btn" });
  it("English: Do Today, with what it does on the hover; the ask's sheet is shut until the server asks", () => {
    const html = renderToStaticMarkup(el());
    expect(html).toMatch(/<button type="button" class="btn" title="Move this job&#x27;s day to today">.*<span>Do Today<\/span><\/button>/);
    expect(html).not.toContain("date-pick link");
    expect(html).not.toContain("Withdraw");
  });
  it("Spanish: Hacer Hoy", () => {
    const html = renderToStaticMarkup(createElement(LangProvider, { lang: "es" } as never, el()));
    expect(html).toContain("<span>Hacer Hoy</span>");
    expect(html).toContain('title="Mueve el día de este trabajo a hoy"');
  });
  it("the ask is the app's own sheet with the consequence on its button, never the browser's dialog (pinned at the source)", () => {
    const code = src("src/app/(app)/planner/do-today-button.tsx");
    expect(code).not.toMatch(/window\.confirm|\bconfirm\(/);
    expect(code).toContain('footer={<ModalActions onCancel={() => setAsking(false)} onSave={() => run(true)} saveLabel={t("md_moveAndWithdraw")} saving={pending} />}');
    expect(code).toContain('<p className="text-sm text-slate-700">{t("md_doTodayLinkOut")}</p>');
    // Said, every way it can end: moved, a kept day (until read), the server's refusal or the fallback.
    expect(code).toContain('toast(out.error ?? t("md_doTodayDidntGo"), "error");');
    expect(code).toContain('toast(t("md_movedToToday"), "success");');
    expect(code).toContain('if (out.note) toast(out.note, "info", undefined, { sticky: true });');
    expect(code).toContain("router.refresh();");
  });
});

describe("the words, in both languages", () => {
  const en = dict("en");
  const es = dict("es");
  it("the group, the day line, the door and what it says", () => {
    expect([en.md_carriedOver, es.md_carriedOver]).toEqual(["Carried over", "De días anteriores"]);
    expect([en.md_bookedDay, es.md_bookedDay]).toEqual(["Booked {day}", "Agendado el {day}"]);
    expect([en.md_doToday, es.md_doToday]).toEqual(["Do Today", "Hacer Hoy"]);
    expect([en.md_doingToday, es.md_doingToday]).toEqual(["Moving…", "Moviendo…"]);
    expect([en.md_moveAndWithdraw, es.md_moveAndWithdraw]).toEqual(["Move It and Withdraw the Link", "Mover y Retirar el Enlace"]);
    expect(en.md_doTodayLinkOut).toBe("A date-pick link is out to the customer for this job. Moving the job to today withdraws that link.");
    expect(es.md_doTodayLinkOut).toBe("El cliente tiene un enlace para elegir fecha de este trabajo. Mover el trabajo a hoy retira ese enlace.");
    expect([en.md_movedToToday, es.md_movedToToday]).toEqual(["Moved to today.", "Se movió a hoy."]);
    expect(en.md_doTodayDidntGo).toBe("That didn't go through, so nothing moved. Try again.");
    expect([en.cs_bookedDay, es.cs_bookedDay]).toEqual(["Booked {day}", "Agendado el {day}"]);
  });
});

describe("My Day (pinned at the page's source)", () => {
  const page = src("src/app/(app)/planner/page.tsx");

  it("reads the caller's own carried-over jobs with the page's first reads, in the day view only, and files a read that failed", () => {
    // RE-PINNED ON PURPOSE (cn-v1175): the page reads the group; the build makes the board's cut.
    expect(page).toContain('import { loadCarriedOver } from "@/lib/schedule/carried-over";');
    expect(page).toContain(
      'view === "day"\n      ? loadCarriedOver<any>(supabase, { userId: user?.id ?? null, todayStr, tz, dayStartIso: dayStart.toISOString() })\n      : Promise.resolve({ rows: [], error: null }),',
    );
    expect(page).toContain('if (carriedR.error) reportError("planner-carried-over", new Error(carriedR.error));');
  });

  it("a carried-over job is a row of its own kind: never the job on the clock, never one already in today's list, and the day it was booked for where a time would be", () => {
    const at = page.indexOf("const carriedAgenda: Agenda[] =");
    const block = page.slice(at, page.indexOf("/* RUNNING LATE? TEXT THEM", at));
    expect(block).toContain(".filter((c) => c.job.id !== currentJob?.id && !jobMap.has(c.job.id))");
    // WHICH DAY (skeptic #72): the short weekday where a time would be, the DATE on the line under
    // the place. A weekday alone reads as today for a job booked exactly a week ago.
    expect(block).toContain('dayLabel: new Date(`${bookedDay}T12:00:00Z`).toLocaleDateString(localeOf(lang), { weekday: "short", timeZone: "UTC" }),');
    expect(block).toContain('span: fillText(t("md_bookedDay"), { day: shortDay(bookedDay, lang) }),');
    expect(block).not.toContain('weekday: "long"');
    expect(block).toContain("carried: { bookedDay },");
    expect(block).toContain("time: null,"); // not a time of today: it is not in the Earlier / Next / Later split
    expect(page).toContain('{i.dayLabel ?? (i.time ? fmtTime(i.time) : "—")}');
    // No money on the row: the loader's own columns hold none.
    expect(block).not.toMatch(/price|total|amount|rate/i);
  });

  it("Do Today is the office's door (the move is staff-only); a tech's row keeps Navigate and the job", () => {
    expect(page).toContain('{isStaff && i.carried && i.jobId && <DoTodayButton jobId={i.jobId} bookedDay={i.carried.bookedDay} todayStr={todayStr} className={navBtnCls} />}');
    expect(page.split("<DoTodayButton").length - 1).toBe(1);
    // The schedule's move is the office's by its own guard, whatever the page draws.
    const move = src("src/app/(app)/schedule/actions.ts");
    const fn = move.slice(move.indexOf("export async function moveJobDay("), move.indexOf("async function workedDaysForJob("));
    expect(fn).toContain("const ctx = await requireStaff();");
  });

  it("the row's Move to Another Day… moves the range of the day it was BOOKED for, not today's, and its sheet says that day in full", () => {
    expect(page).toContain("fromDate={i.carried?.bookedDay ?? day}");
    expect(page).toContain('subline={[i.carried ? i.span : i.time ? fmtTime(i.time) : null, i.sub].filter(Boolean).join(" · ") || null}');
  });

  it("the day words, as a reader sees them: Tue and Booked Nov 17; mar and Agendado el 17 nov", () => {
    // The two expressions the page uses, run on the owner's Tuesday (the page's own source is pinned above).
    const weekday = (ymd: string, locale: string) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString(locale, { weekday: "short", timeZone: "UTC" });
    expect(weekday("2026-11-17", localeOf("en"))).toBe("Tue");
    expect(weekday("2026-11-17", localeOf("es")).replace(".", "")).toBe("mar");
    expect(fillText(translator("en")("md_bookedDay"), { day: shortDay("2026-11-17", "en") })).toBe("Booked Nov 17");
    expect(fillText(translator("es")("md_bookedDay"), { day: shortDay("2026-11-17", "es") })).toBe("Agendado el 17 nov");
    // Exactly a week back, on the same weekday: the date still tells the two apart.
    expect(fillText(translator("en")("md_bookedDay"), { day: shortDay("2026-11-11", "en") })).toBe("Booked Nov 11");
  });

  it("AT PHONE WIDTH a carried-over row's buttons take a line of their own; every other row is as it was", () => {
    expect(page).toContain('<li key={i.key} className={`flex items-center gap-3 px-5 py-3${i.carried ? " flex-wrap sm:flex-nowrap" : ""}`}>');
    expect(page).toContain('<div className={`flex shrink-0 flex-wrap items-center justify-end gap-1${i.carried ? " basis-full sm:basis-auto" : ""}`}>');
    // One row shape in the page: nothing else wraps a whole row.
    expect(page.split("flex-wrap sm:flex-nowrap").length - 1).toBe(1);
    expect(page.split("basis-full sm:basis-auto").length - 1).toBe(1);
  });

  // RE-PINNED ON PURPOSE (cn-v1175, C2): the cut moved from this page into the build, before the piles
  // roll up, so a carried job is neither hidden inside a pile of Jobs Needing a Day nor counted by the
  // shell's badge where the board does not show it (the badge reads the same build).
  it("ONE ROW PER JOB: a job under Carried Over is left off the Needs You board by the build, through the one rule", () => {
    expect(page).toContain("const needsNow = needsYou.now;");
    expect(page).not.toContain("needsYouWithoutCarried(");
    expect(page).toMatch(/<ActionList\s+items=\{needsNow\}/);
    expect(page.split("needsYou.now").length - 1).toBe(1);
    expect(page).toContain('getActionItems({ todayStr, isStaff, userId: user?.id ?? "", tz, off: offFeatureKey(features) })');
    const query = readFileSync(join(process.cwd(), "src/lib/action-items/query.ts"), "utf8");
    expect(query).toContain("const onBoard = carried.size ? needsYouWithoutCarried(items, carried) : items;");
    expect(query.indexOf("needsYouWithoutCarried(items, carried)")).toBeLessThan(query.indexOf("rollUpPiles(sorted"));
  });

  it("the group is LAST in the Today card, under today's own rows or under the line that says today is empty", () => {
    const at = page.indexOf('<CalendarCheck className="h-4 w-4 text-brand" /> {t("md_today")}');
    const card = page.slice(at, page.indexOf("</Card>", at));
    const later = card.indexOf("{agendaRows(laterAgenda, todayStr)}");
    const empty = card.indexOf('empty(currentJob ? t("md_nothingElseToday") : t("md_nothingLeftToday"))');
    const carried = card.indexOf("{carriedAgenda.length > 0 && (");
    expect(later).toBeGreaterThan(0);
    expect(empty).toBeGreaterThan(0);
    expect(carried).toBeGreaterThan(later);
    expect(carried).toBeGreaterThan(empty);
    expect(card.slice(carried)).toContain('{t("md_carriedOver")}</div>');
    expect(card.slice(carried)).toContain("{agendaRows(carriedAgenda, todayStr)}");
    // Outside the empty-or-rows choice, so an empty day still shows what was left over.
    expect(card.slice(empty, carried)).toContain("            </>\n          )}\n");
  });

  it("the assistant's map says the group exists and what its door does", () => {
    const map = src("src/lib/nort-product-map.ts");
    expect(map).toContain("then Carried Over: a job the person is on the crew of that was booked for a day in the last week nobody worked");
    expect(map).toContain("The office's row has Do Today, which moves that day to today and keeps its hours");
    expect(map).toContain("A job listed there is left off My Day's Needs You board, unless its row there also says lines to buy.");
  });
});

describe("the clock's sheet: where a carried-over job is offered", () => {
  const job = (id: string, over: Record<string, unknown> = {}) => ({ id, job_number: id.toUpperCase(), name: `${id} site`, address: null, status: "scheduled", scheduled_start: null, scheduled_end: null, created_at: "2026-11-01T00:00:00Z", customers: { name: "Someone" }, ...over });
  const base = {
    lastJobId: null,
    segToday: new Set<string>(["today"]),
    hasSegments: new Set<string>(["today"]),
    todayStr: "2026-11-18",
    tz: "America/Los_Angeles",
    codesOn: true,
  };
  const jobs = [job("going", { status: "in_progress" }), job("slipped", { scheduled_start: "2026-11-17T22:30:00Z" }), job("today")];

  it("after today's schedule and before the rest in progress, saying the day it was booked for", () => {
    const out = orderWhichJobChoices({ ...base, jobs, carried: [{ id: "slipped", bookedDay: "2026-11-17" }] });
    expect(out.map((o) => [o.id, o.why])).toEqual([
      ["today", "On today's schedule"],
      ["slipped", "Booked Nov 17"],
      ["going", undefined],
    ]);
  });

  it("in Spanish the day reads the Spanish way", () => {
    const out = orderWhichJobChoices({ ...base, jobs, lang: "es", carried: [{ id: "slipped", bookedDay: "2026-11-17" }] });
    expect(out.find((o) => o.id === "slipped")!.why).toBe("Agendado el 17 nov");
  });

  it("without the rule's say-so a job scheduled for another day is still not offered", () => {
    expect(orderWhichJobChoices({ ...base, jobs }).map((o) => o.id)).toEqual(["today", "going"]);
    expect(orderWhichJobChoices({ ...base, jobs, carried: [] }).map((o) => o.id)).toEqual(["today", "going"]);
  });

  it("each job once, in the first group it belongs to: one he punched on last keeps that word, and several keep the rule's order", () => {
    const last = orderWhichJobChoices({ ...base, jobs, lastJobId: "slipped", carried: [{ id: "slipped", bookedDay: "2026-11-17" }] });
    expect(last.map((o) => [o.id, o.why])).toEqual([
      ["slipped", "Where you worked last"],
      ["today", "On today's schedule"],
      ["going", undefined],
    ]);
    const two = orderWhichJobChoices({
      ...base,
      jobs: [...jobs, job("monday", { scheduled_start: "2026-11-16T17:00:00Z" })],
      carried: [{ id: "slipped", bookedDay: "2026-11-17" }, { id: "monday", bookedDay: "2026-11-16" }],
    });
    expect(two.map((o) => o.id)).toEqual(["today", "slipped", "monday", "going"]);
    expect(two[2].why).toBe("Booked Nov 16");
  });

  it("on a move, the job the punch is coming off is never offered back, carried over or not", () => {
    const out = orderWhichJobChoices({ ...base, jobs, excludeJobId: "slipped", carried: [{ id: "slipped", bookedDay: "2026-11-17" }] });
    expect(out.map((o) => o.id)).toEqual(["today", "going"]);
  });

  it("a carried id whose row did not come back, or whose job has ended, is left out rather than drawn blank", () => {
    const out = orderWhichJobChoices({ ...base, jobs: [...jobs, job("done", { status: "complete" })], carried: [{ id: "ghost", bookedDay: "2026-11-17" }, { id: "done", bookedDay: "2026-11-17" }] });
    expect(out.map((o) => o.id)).toEqual(["today", "going"]);
  });
});
