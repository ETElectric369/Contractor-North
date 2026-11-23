import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { InspectionDays } from "@/lib/org-settings";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {}, push() {}, replace() {} }) }));
vi.mock("./actions", () => ({ updateOrgSettings: vi.fn(async () => ({ ok: true })) }));

const { InspectionDaysSettings, inspectionDaysLines, inspectionDaysPatch } = await import("./inspection-days-settings");

/**
 * THE INSPECTION DAYS CARD TELLS THE TRUTH (cn-v1185). Each state the card can be in, drawn as the
 * page draws it: off, on with no day, on with a window shorter than one opening, on with Leads &
 * Inspections off, and the three answers of "right now" (times, nothing open, a failed read).
 */
const ALWAYS =
  "A visitor who has just sent a form on your website picks one of your open times on these days. Each opening is 90 clear minutes, never sooner than two days out, and you are told the moment they pick.";
const NO_DAY = "Tick at least one day. Nothing is offered until then.";
const SHORT = "Make To at least 90 minutes after From. Nothing is offered until then.";
const LEADS_OFF = "Leads &amp; Inspections is switched off in Settings › Features. Nothing is offered while it is off.";
const FAILED = "Couldn&#x27;t read the calendar. Reload to see the open times.";
const NOTHING = "Nothing is open on your next six inspection days.";

const ON: InspectionDays = { offer: true, days: ["tue", "thu"], start: "09:00", end: "15:00", per_day: 3 };
const draw = (saved: InspectionDays, o: { leadsOn?: boolean; preview?: Parameters<typeof InspectionDaysSettings>[0]["preview"] } = {}) =>
  renderToStaticMarkup(
    createElement(InspectionDaysSettings, { saved, leadsOn: o.leadsOn ?? true, slotMin: 90, preview: o.preview ?? null }),
  );

describe("the Inspection Days card, each state", () => {
  it("off: the controls and the one always-line, nothing about times", () => {
    const html = draw({ ...ON, offer: false });
    expect(html).toContain("Offer Open Times on Your Website");
    expect(html).toContain("At Most a Day");
    expect(html).toContain(">From<");
    expect(html).toContain(">To<");
    expect(html).toContain(ALWAYS);
    for (const l of [NO_DAY, SHORT, LEADS_OFF, FAILED, NOTHING, "Open right now"]) expect(html).not.toContain(l);
    expect(html).toContain("Save Changes");
  });

  it("the seven weekday toggles, Mon … Sun, pressed state drawn, 44px", () => {
    const html = draw(ON);
    const days = [...html.matchAll(/<button[^>]*aria-pressed="(true|false)"[^>]*>(\w+)<\/button>/g)].map((m) => [m[2], m[1]]);
    expect(days).toEqual([
      ["Mon", "false"],
      ["Tue", "true"],
      ["Wed", "false"],
      ["Thu", "true"],
      ["Fri", "false"],
      ["Sat", "false"],
      ["Sun", "false"],
    ]);
    const toggles = [...html.matchAll(/<button[^>]*aria-pressed[^>]*>/g)].map((m) => m[0]);
    expect(toggles.every((b) => /min-h-11/.test(b) && /min-w-11/.test(b))).toBe(true);
  });

  it("on with no day ticked", () => {
    const html = draw({ ...ON, days: [] }, { preview: { labels: ["Tue, Nov 24 · 9:00 AM"] } });
    expect(html).toContain(NO_DAY);
    expect(html).not.toContain("Open right now");
  });

  it("on with To not 90 minutes after From (shorter, equal-before, and backwards)", () => {
    for (const [start, end] of [["09:00", "10:29"], ["15:00", "09:00"], ["09:00", "09:00"]]) {
      const html = draw({ ...ON, start, end }, { preview: { labels: ["Tue, Nov 24 · 9:00 AM"] } });
      expect(html).toContain(SHORT);
      expect(html).not.toContain("Open right now");
    }
    expect(draw({ ...ON, start: "09:00", end: "10:30" }, { preview: { labels: [] } })).not.toContain(SHORT);
  });

  it("on with Leads & Inspections off", () => {
    const html = draw(ON, { leadsOn: false, preview: null });
    expect(html).toContain(LEADS_OFF);
    expect(html).not.toContain(NOTHING);
  });

  it("on: what a visitor would be offered right now", () => {
    expect(draw(ON, { preview: { labels: ["Tue, Nov 24 · 9:00 AM", "Tue, Nov 24 · 10:30 AM"] } })).toContain(
      "Open right now: Tue, Nov 24 · 9:00 AM, Tue, Nov 24 · 10:30 AM.",
    );
    expect(draw(ON, { preview: { labels: [] } })).toContain(NOTHING);
  });

  it("a failed read says so, never 'nothing open'", () => {
    const html = draw(ON, { preview: { failed: true } });
    expect(html).toContain(FAILED);
    expect(html).not.toContain(NOTHING);
  });

  it("boxes that differ from what is saved ask for a Save instead of showing the old answer", () => {
    const lines = inspectionDaysLines(ON, { leadsOn: true, slotMin: 90, preview: { labels: ["Tue, Nov 24 · 9:00 AM"] }, dirty: true });
    expect(lines).toEqual([ALWAYS, "Save to see what a visitor would be offered."]);
  });

  it("nothing amber on the card (no clock here)", () => {
    expect(draw(ON, { preview: { failed: true } })).not.toMatch(/amber/);
  });
});

describe("the Save posts the pinned shape", () => {
  it("five keys, the days de-duplicated in week order sun..sat", () => {
    expect(inspectionDaysPatch({ offer: true, days: ["sun", "fri", "mon", "fri"], start: "08:00", end: "12:00", per_day: 2 })).toEqual({
      inspection_days: { offer: true, days: ["sun", "mon", "fri"], start: "08:00", end: "12:00", per_day: 2 },
    });
  });

  it("the card's Save sends exactly that patch through the working day's door", () => {
    const src = readFileSync(join(process.cwd(), "src/app/(app)/settings/inspection-days-settings.tsx"), "utf8");
    expect(src).toContain("await updateOrgSettings(inspectionDaysPatch(now));");
    expect(src).toContain('if (!res.ok) return setError(res.error ?? "Could not save.");');
  });

  it("the page draws the card in Crew & Time, right under the working day, with the server's preview", () => {
    const page = readFileSync(join(process.cwd(), "src/app/(app)/settings/page.tsx"), "utf8");
    const crew = page.indexOf('label: "Crew & Time"');
    const working = page.indexOf("<SchedulingSettings", crew);
    const card = page.indexOf('<Section title="Inspection Days">', crew);
    const next = page.indexOf("<Section", working + 1);
    expect(crew).toBeGreaterThan(0);
    expect(card).toBe(next);
    expect(page).toContain("const openTimesPreview = isStaff ? await readOpenTimesPreview(supabase, profile?.org_id, settings) : null;");
    expect(page).toContain("preview={openTimesPreview}");
  });
});
