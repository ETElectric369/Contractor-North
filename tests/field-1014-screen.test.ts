/**
 * NORT DRIVES THE SCREEN (field feedback 10-13, item 6). Erik, 2026-10-13: "compare how you have
 * access to my entire computer and can connect to anywhere you need to in order to complete a
 * task, thats what we are looking for with Nort inside his own safe container". The first rung is
 * the body: show_screen takes the person to a screen, rings a named spot on it, opens the avatar
 * menu, or parks Nort's box as a bar while he keeps talking. It moves and points; it never saves.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { SCREEN_CLOSE, SCREEN_OPEN, SCREEN_ROOTS, SCREEN_ROOTS_STAFF_ONLY, safeInternalHref, sanitizeScreen, screenBlocks, screenPath } from "@/lib/assistant-protocol";
import { BOX_EVENT, FIND_MS, MENU_EVENT, RING_CLASS, RING_MS, findSpot, performScreen, pointAt } from "@/lib/nort/screen-driver";
import { SCREENS, SHELL_SPOTS, literalAnchorNames, screenPaths, screenPromptBlock } from "@/lib/nort/screens";
import { DOCK } from "@/lib/dock";
import { NORT_PRODUCT_MAP } from "@/lib/nort-product-map";

const read = (p: string) => readFileSync(p, "utf8");
const ID = "0f1e2d3c-4b5a-4c6d-8e7f-9a0b1c2d3e4f";

/** Every .tsx under src/app and src/components, as one string (the anchors live in markup). */
function allMarkup(): string {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".tsx") && !p.endsWith(".test.tsx")) out.push(read(p));
    }
  };
  walk("src/app");
  walk("src/components");
  return out.join("\n");
}

describe("the directive's clamp: an internal path, a bare spot name, closed enums, plain text", () => {
  it("keeps only what the phone may act on", () => {
    expect(sanitizeScreen({ path: `/jobs/${ID}?tab=costs`, anchor: "job-tabs", menu: "account", box: "bar", label: "  the Costs   tab " })).toEqual({
      path: `/jobs/${ID}?tab=costs`,
      anchor: "job-tabs",
      menu: "account",
      box: "bar",
      label: "the Costs tab",
    });
  });
  it("drops an off-origin path, a protocol-relative one and a backslash trick — never 'fixes' them", () => {
    for (const path of ["https://evil.example/jobs", "//evil.example", "/\\evil", "jobs", ""]) expect(sanitizeScreen({ path })).toEqual({});
  });
  it("a TAB, CR or LF inside the path is an escape (the URL parser strips them: '/\\t/evil.com' is '//evil.com') — refused at the root clamp too", () => {
    for (const path of ["/\t/evil.com", "/\n/evil.com", "/\r/evil.com", "/jobs\u0000", "/jobs /x", "/jobs\u007f"]) {
      expect(safeInternalHref(path), JSON.stringify(path)).toBeNull();
      expect(sanitizeScreen({ path })).toEqual({});
    }
  });
  it("a drive lands on a KNOWN screen only: a real id or 'new', the pages' own query keys, no API bounce, no login, no door-opening key", () => {
    expect(screenPath(`/jobs/${ID}?tab=costs`)).toBe(`/jobs/${ID}?tab=costs`);
    expect(screenPath("/quotes/new")).toBe("/quotes/new");
    expect(screenPath("/schedule?view=week&date=2026-10-20")).toBe("/schedule?view=week&date=2026-10-20");
    expect(screenPath("/Jobs")).toBe("/jobs");
    expect(screenPath("/planner#x")).toBe("/planner");
    for (const bad of [
      "/api/google/connect", "/api/quickbooks/connect", "/login", "/estimate/abc", "/i/token/12-thistlewood",
      "/jobs/J-047", `/jobs/${ID}/costs`, "/planner?debrief=1", "/planner?attention=1", "/schedule?new=1", "/bills?pay=1",
      `/jobs/${ID}?tab=<script>`, "/",
    ]) expect(screenPath(bad), bad).toBeNull();
    // A query value longer than 80 is cut, not refused — it is a search, not a door.
    expect(screenPath("/crm?q=" + "a".repeat(90))).toBe("/crm?q=" + "a".repeat(80));
  });
  it("a TECH is not driven to the office's screens — refused, so the model is told, never a blank page", () => {
    for (const root of SCREEN_ROOTS_STAFF_ONLY) {
      expect(screenPath(`/${root}`, false), root).toBeNull();
      expect(screenPath(`/${root}`, true), root).toBe(`/${root}`);
    }
    expect(sanitizeScreen({ path: "/billing", anchor: "owed-to-you" }, { isStaff: false })).toEqual({ anchor: "owed-to-you" });
    for (const p of ["/planner", "/jobs", "/timeclock", `/appointments/${ID}`, "/settings?tab=you"]) expect(screenPath(p, false), p).toBe(p);
  });
  it("parking the box is a VOICE move: by text the bar is dropped (the words live in the box); 'open' always passes", () => {
    expect(sanitizeScreen({ box: "bar" }, { voice: false })).toEqual({});
    expect(sanitizeScreen({ box: "bar" }, { voice: true })).toEqual({ box: "bar" });
    expect(sanitizeScreen({ box: "bar" })).toEqual({ box: "bar" });
    expect(sanitizeScreen({ box: "open" }, { voice: false })).toEqual({ box: "open" });
  });
  it("an anchor is a NAME, never a selector or a space-bearing string", () => {
    for (const anchor of ['[data-tour="x"]', "a b", ".x", "#x", "-lead", "x".repeat(81), 7]) expect(sanitizeScreen({ anchor })).toEqual({});
    for (const anchor of ["insp-photos", "task-abc_1", "dock-jobs", "x".repeat(80), " need-tasks "]) expect(sanitizeScreen({ anchor }).anchor).toBe(anchor.trim());
  });
  it("menu and box are closed lists; the label is capped and whitespace-collapsed; junk is an empty step", () => {
    expect(sanitizeScreen({ menu: "settings" })).toEqual({});
    expect(sanitizeScreen({ box: "closed" })).toEqual({});
    expect(sanitizeScreen({ box: "open" })).toEqual({ box: "open" });
    expect(sanitizeScreen({ label: "a".repeat(200) }).label).toHaveLength(120);
    expect(sanitizeScreen(null)).toEqual({});
    expect(sanitizeScreen("x")).toEqual({});
  });
});

describe("screenBlocks: every complete block, in order, the count never slipping", () => {
  it("two blocks come back in order; a half-arrived block is not yet a step", () => {
    const full = `Sure.${SCREEN_OPEN}{"path":"/jobs/${ID}"}${SCREEN_CLOSE} then ${SCREEN_OPEN}{"path":"/jobs/${ID}?tab=costs","anchor":"job-tabs"}${SCREEN_CLOSE} and ${SCREEN_OPEN}{"pa`;
    expect(screenBlocks(full)).toEqual([{ path: `/jobs/${ID}` }, { path: `/jobs/${ID}?tab=costs`, anchor: "job-tabs" }]);
  });
  it("an unparseable block is an EMPTY step, so later blocks keep their index", () => {
    const full = `${SCREEN_OPEN}{bad${SCREEN_CLOSE}${SCREEN_OPEN}{"box":"bar"}${SCREEN_CLOSE}`;
    expect(screenBlocks(full)).toEqual([{}, { box: "bar" }]);
  });
});

/** A document with a few named elements, enough for the finder and the ring. */
type FakeEl = {
  name?: string;
  id?: string;
  w: number;
  h: number;
  top: number;
  bottom: number;
  classList: Set<string>;
  scrolled: number;
  offsetWidth: number;
  getBoundingClientRect: () => { width: number; height: number; top: number; bottom: number };
  scrollIntoView: () => void;
};
function el(o: Partial<FakeEl> & { name?: string; id?: string }): FakeEl {
  const e: FakeEl = {
    w: 100,
    h: 40,
    top: 10,
    bottom: 50,
    classList: new Set<string>(),
    scrolled: 0,
    offsetWidth: 100,
    getBoundingClientRect: () => ({ width: e.w, height: e.h, top: e.top, bottom: e.bottom }),
    scrollIntoView: () => {
      e.scrolled++;
    },
    ...o,
  };
  // classList with the DOM's verbs.
  const set = e.classList;
  (e as unknown as { classList: unknown }).classList = { add: (c: string) => set.add(c), remove: (c: string) => set.delete(c), has: (c: string) => set.has(c) };
  (e as unknown as { has: (c: string) => boolean }).has = (c: string) => set.has(c);
  return e;
}
function fakeWindow(els: FakeEl[], innerHeight = 800) {
  const events: { type: string; detail: unknown }[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const cleared: number[] = [];
  const doc = {
    querySelectorAll: (sel: string) => {
      const m = /\[data-tour="([^"]+)"\]/.exec(sel);
      return m ? els.filter((e) => e.name === m[1]) : [];
    },
    getElementById: (id: string) => els.find((e) => e.id === id) ?? null,
  };
  const win = {
    document: doc,
    innerHeight,
    dispatchEvent: (e: Event) => {
      events.push({ type: e.type, detail: (e as CustomEvent).detail });
      return true;
    },
    setTimeout: (fn: () => void, ms: number) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    clearTimeout: (id: number) => {
      cleared.push(id);
    },
  };
  return { win: win as unknown as Window, events, timers, cleared, runTimers: () => { const t = timers.splice(0); t.forEach((x) => x.fn()); } };
}
const hasRing = (e: FakeEl) => (e as unknown as { has: (c: string) => boolean }).has(RING_CLASS);

describe("the driver: park the box, open the menu, go there, find the spot, ring it", () => {
  let CE: typeof CustomEvent;
  beforeEach(() => {
    CE = globalThis.CustomEvent;
    if (!CE) (globalThis as unknown as { CustomEvent: unknown }).CustomEvent = class { type: string; detail: unknown; constructor(t: string, i?: { detail?: unknown }) { this.type = t; this.detail = i?.detail; } };
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    if (!CE) delete (globalThis as unknown as { CustomEvent?: unknown }).CustomEvent;
  });

  it("finds the first VISIBLE match by data-tour, then by id — the hidden dock twin is skipped", () => {
    const hidden = el({ name: "dock", w: 0, h: 0 });
    const shown = el({ name: "dock" });
    const byId = el({ id: "needs-you" });
    const { win } = fakeWindow([hidden, shown, byId]);
    expect(findSpot("dock", win.document)).toBe(shown as unknown as HTMLElement);
    expect(findSpot("needs-you", win.document)).toBe(byId as unknown as HTMLElement);
    expect(findSpot("nothing", win.document)).toBeNull();
  });

  it("box and menu are window events; a different path is pushed; the same path is not", () => {
    const { win, events } = fakeWindow([]);
    const pushed: string[] = [];
    const nav = { here: () => "/planner", push: (p: string) => pushed.push(p) };
    expect(performScreen({ box: "bar", label: "the Costs tab", menu: "account", path: "/jobs/1?tab=costs" }, nav, win)).toEqual({ moved: true, pointed: false });
    expect(events).toEqual([
      { type: BOX_EVENT, detail: { box: "bar", label: "the Costs tab" } },
      // sticky:false — the person can still close the menu the usual ways (the tour's open is sticky).
      { type: MENU_EVENT, detail: { menu: "account", open: true, sticky: false } },
    ]);
    expect(pushed).toEqual(["/jobs/1?tab=costs"]);
    expect(performScreen({ path: "/planner" }, nav, win)).toEqual({ moved: false, pointed: false });
    expect(pushed).toEqual(["/jobs/1?tab=costs"]);
  });

  it("a spot in view is rung without a scroll; one below the fold is scrolled to; the ring comes off by itself", () => {
    const inView = el({ name: "job-tabs" });
    const below = el({ name: "job-manage", top: 900, bottom: 940 });
    const { win, timers } = fakeWindow([inView, below]);
    performScreen({ anchor: "job-tabs" }, { here: () => "/jobs/1", push: () => {} }, win);
    expect(hasRing(inView)).toBe(true);
    expect(inView.scrolled).toBe(0);
    pointAt("job-manage", 0, win);
    expect(below.scrolled).toBe(1);
    expect(hasRing(below)).toBe(true);
    const off = timers.find((t) => t.ms === RING_MS);
    expect(off).toBeTruthy();
    off!.fn();
    expect(hasRing(inView)).toBe(false);
  });

  it("after a push the spot is waited for until the page ARRIVES: a same-named spot on the page we are leaving is never rung", () => {
    // needs-you is an id on Bills and a data-tour on My Day. We are on Bills, going to My Day.
    const billsCard = el({ id: "needs-you" });
    const myDayCard = el({ name: "needs-you" });
    const els: FakeEl[] = [billsCard];
    let here = "/bills";
    const { win, timers, runTimers } = fakeWindow(els);
    const r = performScreen({ path: "/planner", anchor: "needs-you" }, { here: () => here, push: (p) => { here = "/pushing"; setTimeout(() => {}, 0); void p; } }, win);
    expect(r).toEqual({ moved: true, pointed: true });
    expect(hasRing(billsCard)).toBe(false); // the first poll ran before the page changed — and did not ring Bills
    expect(timers.length).toBe(1);
    runTimers();
    expect(hasRing(billsCard)).toBe(false); // still in flight
    here = "/planner";
    els.splice(0, els.length, myDayCard);
    runTimers();
    expect(hasRing(myDayCard)).toBe(true);
    expect(hasRing(billsCard)).toBe(false);
    expect(FIND_MS).toBeGreaterThanOrEqual(4000);
  });

  it("a spot that never shows is SAID (onMiss) once the wait runs out, with the step so the words can name it", () => {
    const { win, runTimers } = fakeWindow([]);
    const missed: unknown[] = [];
    const step = { anchor: "job-tabs", label: "the tabs" };
    performScreen(step, { here: () => "/jobs/1", push: () => {} }, win, { onMiss: (s) => missed.push(s) });
    expect(missed).toEqual([]); // still polling
    vi.setSystemTime(Date.now() + 2000); // past the 1500 ms wait on a page we did not leave
    runTimers();
    expect(missed).toEqual([step]);
  });

  it("a newer move cancels an older poll, so block 1 never rings seconds after block 2 moved on", () => {
    const late = el({ name: "owed-to-you" });
    const els: FakeEl[] = [];
    const { win, runTimers } = fakeWindow(els);
    pointAt("owed-to-you", 5000, win); // block 1: not on screen yet
    pointAt("job-tabs", 5000, win); // block 2 takes over
    els.push(late); // block 1's spot shows up late
    runTimers();
    expect(hasRing(late)).toBe(false);
  });

  it("ringing the same spot twice clears the first off-timer, so the second ring gets its full time", () => {
    const spot = el({ name: "ask" });
    const { win, cleared, timers } = fakeWindow([spot]);
    pointAt("ask", 0, win);
    pointAt("ask", 0, win);
    expect(cleared).toEqual([timers.length - 1]);
  });
});

describe("the registry: every spot named is a real data-tour or id in the markup; every path is internal", () => {
  const markup = allMarkup();
  const settingsIds = [...read("src/app/(app)/settings/page.tsx").matchAll(/^\s*id: "([a-z-]+)"/gm)].map((m) => m[1]);
  const dockKeys = DOCK.map((s) => s.key);
  // need-<key> is NOT a family: a playbook's keys are its owner's own (the editor makes q_<time>), so a
  // literal need-… name in the registry would be a guess that CI could not tell from a real anchor.
  const families: Record<string, string[]> = { dock: dockKeys, sections: dockKeys, menu: dockKeys, settings: settingsIds };

  it.each(literalAnchorNames())("[%s] is in the markup", (name) => {
    const literal = markup.includes(`data-tour="${name}"`) || markup.includes(`id="${name}"`) || markup.includes(`barAnchor="${name}"`);
    const dash = name.indexOf("-");
    const prefix = dash > 0 ? name.slice(0, dash) : "";
    const rest = dash > 0 ? name.slice(dash + 1) : "";
    const templated = markup.includes(`data-tour={\`${prefix}-\${`) || markup.includes(`id={\`${prefix}-\${`);
    const viaFamily = !!families[prefix] && templated && families[prefix].includes(rest);
    expect(literal || viaFamily, name).toBe(true);
  });

  it("the placeholder spots name a real template each", () => {
    const inspector = read("src/app/(app)/appointments/[id]/inspector.tsx");
    expect(inspector).toContain("id={`task-${t.id}`}");
    expect(inspector).toContain("id={`need-${n.key}`}");
    expect(read("src/app/(app)/settings/settings-subnav.tsx")).toContain("data-tour={`settings-${c.id}`}");
    expect(read("src/components/app-shell/dock.tsx")).toContain("data-tour={`dock-${s.key}`}");
  });

  it("every path is a same-app absolute path; the screens the dock lists are all here", () => {
    for (const p of screenPaths()) expect(p, p).toMatch(/^\/[a-z-]+(\/<id>)?$/);
    const paths = new Set(screenPaths());
    // Every dock TILE lands somewhere Nort can drive to (the avatar menu's sections are its own).
    for (const s of DOCK) if (!s.inMenu) expect(paths.has(s.href.split("?")[0]), `${s.key} → ${s.href}`).toBe(true);
  });

  it("the clamp's screen roots ARE the registry's, both ways, and the office-only set matches", () => {
    const roots = new Set(screenPaths().map((p) => p.split("/")[1]));
    expect([...roots].sort()).toEqual([...SCREEN_ROOTS].sort());
    const staffRoots = new Set(SCREENS.filter((s) => s.staffOnly).map((s) => s.path.split("/")[1]));
    expect([...staffRoots].sort()).toEqual([...SCREEN_ROOTS_STAFF_ONLY].sort());
  });

  it("a tech's prompt names a tech's screens only — no office page, no '(office only)' mark to tempt a drive", () => {
    const tech = screenPromptBlock(false);
    expect(tech).not.toContain("(office only)");
    for (const s of SCREENS) {
      if (s.staffOnly) expect(tech).not.toContain(`- ${s.name} ${s.path}`);
      else expect(tech).toContain(`- ${s.name} ${s.path}`);
    }
    expect(tech).toContain("costs|quotes|invoices|change-orders are the office's tabs (a tech has none)");
  });

  it("the prompt block is the registry, rendered: each screen, each spot, the shell's spots, the dock's keys", () => {
    const block = screenPromptBlock();
    expect(block.startsWith("DRIVING THE SCREEN (show_screen)")).toBe(true);
    for (const s of SCREENS) {
      expect(block).toContain(`- ${s.name} ${s.path}`);
      for (const sp of s.spots ?? []) expect(block).toContain(`[${sp.name}] ${sp.say}`);
      if (s.staffOnly) expect(block).toContain(`${s.path} (office only)`);
    }
    for (const sp of SHELL_SPOTS) expect(block).toContain(`[${sp.name}]`);
    for (const k of DOCK.map((s) => s.key)) expect(block).toContain(k);
    // The law, in the words Nort reads: it moves and points, never presses.
    expect(block).toContain("you still never press a button for them");
    expect(block).toContain("it saves nothing");
    expect(block).toContain("Two moves are two calls, in order");
    // Nothing silent: the model is told what a miss looks like and what to do instead.
    expect(block).toContain("The result names what could not be used (not_used)");
    expect(block).toContain("never a job number");
    expect(block).not.toContain("lands them on My Day");
  });

  it("the product map no longer says Nort cannot take people anywhere", () => {
    expect(NORT_PRODUCT_MAP).not.toContain("you cannot press these buttons yourself");
    expect(NORT_PRODUCT_MAP).toContain("take people there and point with show_screen; you never press a button for them");
  });
});

describe("the wiring, pinned", () => {
  const route = read("src/app/api/chat/route.ts");
  const chat = read("src/app/(app)/assistant/assistant-chat.tsx");
  const glass = read("src/components/global-assistant.tsx");

  it("the route offers show_screen to EVERY caller, emits the clamped block mid-stream and keeps going", () => {
    expect(route).toContain('name: "show_screen"');
    expect(route).toContain("SHOW_CARD_TOOL, SHOW_SCREEN_TOOL, FILL_SCREEN_TOOL, ...(isStaffCaller ? [REQUEST_CONTACT_TOOL] : [])");
    const h = route.slice(route.indexOf('if (tu.name === "show_screen")'), route.indexOf('if (tu.name === "open_maps")'));
    expect(h).toContain("sanitizeScreen(tu.input, { isStaff: isStaffCaller, voice: !!body.voice })");
    expect(h).toContain("emit(envelope(SCREEN_OPEN, shown, SCREEN_CLOSE))");
    expect(h).toContain("continue;");
    expect(h).not.toContain("break;");
    // What was dropped is SAID to the model, so it can say where the thing is in words instead.
    expect(h).toContain("not_used: dropped");
  });

  it("the prompt block rides in the CACHED system block, next to the product map, by role; model text cannot forge a block", () => {
    // By role AND by the caller's language since cn-v1139 (the Spanish names ride the cached block; lib/nort/screens-es.test.ts).
    expect(route).toContain("systemPrompt += `\\n\\n${NORT_PRODUCT_MAP}\\n\\n${screenPromptBlock(isStaffCaller, asLang(prof?.language))}`;");
    expect(route).toContain('import { asLang } from "@/lib/locale";');
    expect(route).not.toContain("volatilePrompt += `${screenPromptBlock");
    const onText = route.slice(route.indexOf("onText: (text) => {"), route.indexOf("if (needsRoundBreak && clean.trim())"));
    expect(onText).toContain("const clean = stripMarkerChar(text);"); // the character, not the strings (audit v1120)
    expect(onText).not.toContain(".split(SCREEN_CLOSE).join(\"\")"); // a per-chunk string match let a split marker through
  });

  it("the client strips the block from the words and performs each one once, in order, as it lands", () => {
    expect(chat).toContain('const sre = new RegExp(SCREEN_OPEN + "([\\\\s\\\\S]*?)" + SCREEN_CLOSE, "g");');
    expect(chat).toContain('.replace(nre, "").replace(wre, "").replace(sre, "")');
    expect(chat).toContain("for (const m of [DRAFT_OPEN, HUD_OPEN, STATUS_OPEN, HOLDING_OPEN, WROTE_OPEN, SCREEN_OPEN])");
    const loop = chat.slice(chat.indexOf('full = "";\n      screenDoneRef.current = 0;'), chat.indexOf("// Speak completed sentences as they land"));
    expect(loop).toContain("const moves = screenBlocks(full);");
    expect(loop).toContain("while (screenDoneRef.current < moves.length)");
    expect(loop).toContain("{ here: () => window.location.pathname + window.location.search, push: (p) => router.push(p) },");
    // A miss is said under the chat and the box comes back; so does a new card, a picker or a confirm.
    expect(loop).toContain("onMiss: (s) => {");
    expect(loop).toContain("setMissNote(spotMissNote(s.label, lang))"); // the model's label, else "that spot" — never the anchor name (cn-v1123); in the person's language (cn-v1138)
    expect(chat).toContain("const statusText = status ?? missNote ??");
    expect(chat).toContain("if (pickDir || proposal) openBox();");
    expect(chat).toContain("if (key !== lastCardRef.current) {\n            lastCardRef.current = key;\n            openBox();");
  });

  it("Nort's open of the avatar menu is not sticky; the job page names the tab STRIP, not the tab body; the Inspector follows a ?task= change", () => {
    expect(read("src/components/account-menu.tsx")).toContain("setByTour(!!d.open && d.sticky !== false);");
    const tabs = read("src/components/tabs.tsx");
    expect(tabs).toContain("{barAnchor ? <div data-tour={barAnchor}>{bar}</div> : bar}");
    expect(read("src/app/(app)/jobs/[id]/page.tsx")).toContain('barAnchor="job-tabs"');
    const insp = read("src/app/(app)/appointments/[id]/inspector.tsx");
    expect(insp).toContain("if (initialOpenTaskId && initialOpenTaskId !== seenOpenRef.current) openTask(initialOpenTaskId);");
  });

  it("Nort parks his own box WITHOUT stopping the voice; the bar reads what he is showing; the person's own handle clears it", () => {
    const park = glass.slice(glass.indexOf("const onBox = (e: Event) =>"), glass.indexOf('window.addEventListener("cn:assistant-box", onBox)'));
    expect(park).toContain("return true;");
    expect(park).not.toContain("cn:assistant-stop");
    expect(park).toContain('setParkedLabel(d.label?.trim() || "Nort")');
    // Parked at the BOTTOM, above the phone's dock: the top is where the spots he rings sit.
    expect(park).toContain("requestAnimationFrame(() => setPos(parkedPos()))");
    expect(glass).toContain('document.querySelector<HTMLElement>(".app-dock")');
    expect(park).toContain("setPos(unparkedPosRef.current ?? centeredPos())");
    expect(glass).toContain('<span className="font-semibold text-brand">NORT</span>');
    // The person's own handle: the label clears and the box goes back to where it sat before.
    expect(glass).toContain("setParkedLabel(null);\n                  if (!next && unparkedPosRef.current) {");
  });

  it("the ring is a class that comes off by itself, honours reduced motion, and never dims the page", () => {
    const css = read("src/app/globals.css");
    expect(css).toContain(".cn-nort-ring {");
    expect(css).toContain("animation: cn-nort-ring 4s ease-out both;");
    // Outline only: no box-shadow to replace .glass, no radius to square a round button.
    const ring = css.slice(css.indexOf("@keyframes cn-nort-ring"), css.indexOf("@media (prefers-reduced-motion: reduce) {\n  .cn-nort-ring"));
    expect(ring).not.toContain("box-shadow");
    expect(ring).not.toContain("border-radius");
    expect(css).toContain("@media (prefers-reduced-motion: reduce) {\n  .cn-nort-ring { animation: none; }");
    expect(RING_CLASS).toBe("cn-nort-ring");
    expect(RING_MS).toBe(4000);
  });
  it("a permit is reached through its job's Permits tab, never a /permits screen (Erik 2026-10-15 00:09: 'why couldn't you take me there directly?')", () => {
    const p = screenPromptBlock(true);
    expect(p).toContain("A job's permits, inspections, panel and work orders are TABS on the job (`/jobs/<id>?tab=permits`)");
    expect(p).toContain("there is no /permits path");
    expect(screenPath("/permits/5f0c3a2e-1b8d-4f3a-9c0d-0a1b2c3d4e5f", true)).toBeNull();
    expect(screenPath("/jobs/5f0c3a2e-1b8d-4f3a-9c0d-0a1b2c3d4e5f?tab=permits", false)).toBe("/jobs/5f0c3a2e-1b8d-4f3a-9c0d-0a1b2c3d4e5f?tab=permits");
  });

});
