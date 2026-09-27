import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/components/snap-or-note", () => ({ SnapOrNoteProvider: () => null, openSnapOrNote: vi.fn() }));

import { GlobalQuickAdd, QuickAddMenu, STUCK_MS, plusOpens, quickAddActions, quickAddGo } from "./global-quick-add";
import { ALL_ON, type FeatureMap } from "@/lib/features";

/**
 * THE + (W1-11: eight rows to six) AND THE SWITCH BOARD (0352). The office: Snap Or Note first, then
 * New Lead, New Job, New Appointment, New Estimate, New Invoice; a switched-off feature's row goes.
 * The crew: the + is Snap Or Note itself, and no typed verb is his.
 */
const off = (...keys: (keyof FeatureMap)[]) => ({ ...ALL_ON, ...Object.fromEntries(keys.map((k) => [k, false])) }) as FeatureMap;
const labels = (isStaff: boolean, f?: FeatureMap) => quickAddActions(isStaff, f).map((a) => a.label);
const words = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const rows = (html: string) => Array.from(html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)).map((m) => words(m[1]));

describe("quickAddActions", () => {
  it("the office, everything on (or no map): the five typed verbs, New Customer and New Reminder cut", () => {
    const five = ["New Lead", "New Job", "New Appointment", "New Estimate", "New Invoice"];
    expect(labels(true, ALL_ON)).toEqual(five);
    expect(labels(true)).toEqual(five);
    expect(labels(true)).not.toContain("New Customer");
    expect(labels(true)).not.toContain("New Reminder");
  });

  it("a tech gets no typed verb at all: his + is Snap Or Note", () => {
    expect(labels(false)).toEqual([]);
    expect(labels(false, off("leads", "estimates"))).toEqual([]);
    expect(plusOpens(false)).toBe("snap-or-note");
    expect(plusOpens(true)).toBe("menu");
  });

  it("Leads off: no New Lead; Estimates off: no New Estimate; the rest stay", () => {
    expect(labels(true, off("leads"))).toEqual(["New Job", "New Appointment", "New Estimate", "New Invoice"]);
    expect(labels(true, off("estimates"))).toEqual(["New Lead", "New Job", "New Appointment", "New Invoice"]);
  });
});

describe("the + on screen", () => {
  it("the office's menu: Snap Or Note is the first row, then the verbs, every row 44px", () => {
    const html = renderToStaticMarkup(createElement(QuickAddMenu, { isStaff: true, onSnap: () => {}, onGo: () => {} }));
    expect(rows(html)).toEqual(["Snap Or Note", "New Lead", "New Job", "New Appointment", "New Estimate", "New Invoice"]);
    for (const b of html.match(/<button[^>]*>/g) ?? []) expect(b).toContain("min-h-11");
    // A switch that is off removes only its own row.
    const leadsOff = renderToStaticMarkup(createElement(QuickAddMenu, { isStaff: true, features: off("leads"), onSnap: () => {}, onGo: () => {} }));
    expect(rows(leadsOff)).toEqual(["Snap Or Note", "New Job", "New Appointment", "New Estimate", "New Invoice"]);
  });

  it("a tech's + opens the paper door itself (no one-row menu), and names it; the office's + is Quick Add; both 44px", () => {
    const tech = renderToStaticMarkup(createElement(GlobalQuickAdd, { isStaff: false }));
    expect(tech).toMatch(/<button[^>]*aria-label="Snap Or Note"/);
    expect(tech).not.toContain('aria-haspopup="menu"');
    const office = renderToStaticMarkup(createElement(GlobalQuickAdd, { isStaff: true, placement: "topbar" }));
    expect(office).toMatch(/<button[^>]*aria-label="Quick Add"[^>]*aria-haspopup="menu"/);
    for (const html of [tech, office]) expect(html).toMatch(/<button[^>]*class="[^"]*\bh-11 w-11\b/);
  });

  it("the floating button is gone: no drag, no saved position", () => {
    const src = readFileSync(join(process.cwd(), "src/components/global-quick-add.tsx"), "utf8");
    for (const gone of ["cn_quickadd_pos", "localStorage", "onPointerDown", "setPointerCapture", '"fab"']) expect(src).not.toContain(gone);
    // The top bar still compiles unchanged: placement is accepted (and ignored).
    expect(src).toContain('placement?: "topbar";');
  });
});

describe("the tap that did nothing, twice (triage 2026-09-27)", () => {
  it("no signal: the tap says so in words and doesn't try", () => {
    expect(quickAddGo({ online: false, lastFailed: false, stuck: false, label: "New Job" })).toEqual({
      way: "offline",
      said: "No signal right now, so New Job can't open. Tap it again once you have a bar or two.",
    });
    // Even right after a failure: no signal is said first.
    expect(quickAddGo({ online: false, lastFailed: true, stuck: false, label: "New Job" }).way).toBe("offline");
  });

  it("a page that failed to load is really retried on the next tap: a full load", () => {
    expect(quickAddGo({ online: true, lastFailed: true, stuck: false, label: "New Job" })).toEqual({ way: "full" });
    expect(quickAddGo({ online: true, lastFailed: false, stuck: true, label: "New Job" })).toEqual({ way: "full" });
    expect(quickAddGo({ online: true, lastFailed: false, stuck: false, label: "New Job" })).toEqual({ way: "soft" });
    expect(STUCK_MS).toBeGreaterThanOrEqual(5000);
  });

  it("the + hears the shell's failed navigation, and a full load is window.location.assign", () => {
    const src = readFileSync(join(process.cwd(), "src/components/global-quick-add.tsx"), "utf8");
    expect(src).toContain('window.addEventListener("cn:navigation-failed", onFail);');
    expect(src).toContain("window.location.assign(a.href);");
    expect(src).toContain("navigator.onLine !== false");
  });

  it("the sentence is said in the menu, where the tap was", () => {
    const html = renderToStaticMarkup(
      createElement(QuickAddMenu, { isStaff: true, onSnap: () => {}, onGo: () => {}, said: "No signal right now, so New Job can't open. Tap it again once you have a bar or two." }),
    );
    expect(html).toMatch(/role="status"[^>]*>No signal right now, so New Job can(&#x27;|')t open/);
  });
});
