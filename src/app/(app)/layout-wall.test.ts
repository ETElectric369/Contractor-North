import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { NextRequest, NextResponse } from "next/server";
import { existsSync } from "node:fs";
import { lapseWall, LAPSED_OPEN_DOORS, PATHNAME_HEADER, SEARCH_HEADER } from "@/lib/lapse-doors";
import { accessState, BILLING_COLUMNS } from "@/lib/subscription";
import { LAPSED_DOCK, visibleDock } from "@/lib/dock";

/**
 * THE WALL AND ITS OPEN DOORS (cn-v1137), end to end without a browser: middleware writes the
 * request's path and query onto two request headers; the (app) layout, inside its pinned billing
 * gate, asks lapseWall with the one access state and does what it says. The decision is tested
 * here with real access states; the layout's wiring is source-pinned, because the layout itself
 * renders a dozen reads that are not the subject.
 */
const updateSession = vi.fn(async (req: NextRequest) => NextResponse.next({ request: req }));
vi.mock("@/lib/supabase/middleware", () => ({ updateSession: (...a: unknown[]) => (updateSession as any)(...a) }));

const { middleware } = await import("@/middleware");

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 28, 18, 0, 0);
const lapsedTrial = { id: "org-1", subscription_status: "trialing", trial_ends_at: new Date(NOW - 2 * DAY).toISOString() };
const spentGrace = {
  id: "org-1",
  subscription_status: "past_due",
  current_period_end: new Date(NOW - 20 * DAY).toISOString(),
};
const canceled = { id: "org-1", subscription_status: "canceled" };

async function run(path: string, init: { host?: string; headers?: Record<string, string> } = {}) {
  const host = init.host ?? "localhost";
  const req = new NextRequest(`http://${host}${path}`, { headers: { host, ...(init.headers ?? {}) } });
  const res = await middleware(req);
  return {
    pathnameForwarded: res.headers.get(`x-middleware-request-${PATHNAME_HEADER}`),
    searchForwarded: res.headers.get(`x-middleware-request-${SEARCH_HEADER}`),
    rewrite: res.headers.get("x-middleware-rewrite"),
    status: res.status,
  };
}

describe("middleware forwards the path and the query to the app", () => {
  afterEach(() => updateSession.mockClear());

  it("an app path: both headers reach the layout", async () => {
    const r = await run("/jobs?billing_error=Card%20declined");
    expect(updateSession).toHaveBeenCalledTimes(1);
    expect(r.pathnameForwarded).toBe("/jobs");
    expect(r.searchForwarded).toBe("?billing_error=Card%20declined");
  });

  it("no query: the search header is empty, not missing", async () => {
    const r = await run("/settings");
    expect(r.pathnameForwarded).toBe("/settings");
    expect(r.searchForwarded).toBe("");
  });

  it("a browser's own copy of the header is overwritten, never trusted", async () => {
    const r = await run("/jobs", { headers: { [PATHNAME_HEADER]: "/settings", [SEARCH_HEADER]: "?billing_error=forged" } });
    expect(r.pathnameForwarded).toBe("/jobs");
    expect(r.searchForwarded).toBe("");
  });

  it("an org site's root still rewrites to its site, and never reaches the session", async () => {
    const r = await run("/", { host: "larkspur.contractornorth.com" });
    expect(r.rewrite).toContain("/site/larkspur");
    expect(updateSession).not.toHaveBeenCalled();
  });

  it("an app route on an org host (crew signing in from the company site) carries the headers", async () => {
    const r = await run("/login", { host: "larkspur.contractornorth.com" });
    expect(updateSession).toHaveBeenCalledTimes(1);
    expect(r.pathnameForwarded).toBe("/login");
  });
});

describe("the wall's decision, with real access states", () => {
  afterEach(() => vi.unstubAllEnvs());
  const wall = (org: Parameters<typeof accessState>[0], role: string | null, pathname: string | null, search?: string) =>
    lapseWall({ state: accessState(org, { nowMs: NOW }), role, pathname, search });

  it("the owner on /settings while lapsed: no redirect, the red bar's words", () => {
    expect(wall(lapsedTrial, "owner", "/settings")).toEqual({
      kind: "bar",
      words: "Your free trial has ended. Nort, texts and reminders are paused. Your customers can still pay you.",
    });
    expect(wall(spentGrace, "admin", "/settings/")).toEqual({
      kind: "bar",
      words: "Your card was not updated in time. Nort, texts and reminders are paused. Your customers can still pay you.",
    });
    expect(wall(canceled, "owner", "/analytics/accountant")).toEqual({
      kind: "bar",
      words: "Your plan has ended. Nort, texts and reminders are paused. Your customers can still pay you.",
    });
    expect(wall(canceled, "owner", "/subscribe").kind).toBe("bar");
  });

  it("the owner on /jobs → /subscribe", () => {
    expect(wall(lapsedTrial, "owner", "/jobs")).toEqual({ kind: "redirect", to: "/subscribe" });
    expect(wall(lapsedTrial, "owner", "/settingsx")).toEqual({ kind: "redirect", to: "/subscribe" });
  });

  it("a tech (or office) on /settings → /subscribe", () => {
    expect(wall(lapsedTrial, "tech", "/settings")).toEqual({ kind: "redirect", to: "/subscribe" });
    expect(wall(lapsedTrial, "office", "/settings")).toEqual({ kind: "redirect", to: "/subscribe" });
  });

  it("comped by the column or the env list: no redirect anywhere, for anyone", () => {
    const column = { ...lapsedTrial, comped_until: new Date(NOW + 30 * DAY).toISOString() };
    expect(wall(column, "tech", "/jobs")).toEqual({ kind: "open" });
    vi.stubEnv("COMPED_ORG_IDS", "other-org, ORG-1");
    expect(wall(lapsedTrial, "tech", "/jobs")).toEqual({ kind: "open" });
  });

  it("a comp that has run out is a lapse again", () => {
    const stale = { ...lapsedTrial, comped_until: new Date(NOW - DAY).toISOString() };
    expect(wall(stale, "tech", "/jobs")).toEqual({ kind: "redirect", to: "/subscribe" });
  });

  it("the header missing → redirect, even for the owner on what would be an open door", () => {
    expect(wall(lapsedTrial, "owner", null)).toEqual({ kind: "redirect", to: "/subscribe" });
  });

  it("a billing_error is carried through the redirect, and nothing else is", () => {
    expect(wall(lapsedTrial, "owner", "/jobs", "?tab=getpaid&billing_error=Card%20declined")).toEqual({
      kind: "redirect",
      to: "/subscribe?billing_error=Card%20declined",
    });
    expect(wall(lapsedTrial, "tech", "/settings", "?tab=getpaid")).toEqual({ kind: "redirect", to: "/subscribe" });
  });
});

describe("the layout's wiring (source pins)", () => {
  const layout = readFileSync("src/app/(app)/layout.tsx", "utf8");
  const mw = readFileSync("src/middleware.ts", "utf8");

  it("the org select builds its billing columns from the one list (BILLING_COLUMNS; projection law, skeptic #43 N4)", () => {
    expect(layout).toContain('import { hasActiveAccess, isCompedOrg, accessState, BILLING_COLUMNS } from "@/lib/subscription";');
    expect(layout).toContain('.select(`name, logo_url, ${BILLING_COLUMNS.join(", ")}, settings, address_line1, city, state, zip`)');
    for (const col of ["subscription_status", "trial_ends_at", "current_period_end", "comped_until"]) expect(BILLING_COLUMNS).toContain(col);
    // Nort's chat route reads the same way.
    const chat = readFileSync("src/app/api/chat/route.ts", "utf8");
    expect(chat).toContain('.select(`id, settings, ${BILLING_COLUMNS.join(", ")}`)');
  });

  it("the allowlist is nested INSIDE the pinned gate, after the alarm and before the grace banner", () => {
    const alarm = layout.indexOf("stripeConfigAlarm();");
    const gate = layout.indexOf("if (billingEnabled && org && !hasActiveAccess(org) && !isCompedOrg(profile.org_id)) {");
    const read = layout.indexOf("await headers()");
    const wall = layout.indexOf("lapseWall({");
    const grace = layout.indexOf("accessState({ ...org, id: profile.org_id })");
    expect(alarm).toBeGreaterThan(0);
    expect(gate).toBeGreaterThan(alarm);
    expect(read).toBeGreaterThan(gate);
    expect(wall).toBeGreaterThan(read);
    expect(grace).toBeGreaterThan(wall);
    expect(layout).toContain("pathname: h.get(PATHNAME_HEADER)");
    expect(layout).toContain("search: h.get(SEARCH_HEADER)");
    expect(layout).toContain('if (wall.kind === "redirect") redirect(wall.to);');
    expect(layout).toContain('if (wall.kind === "bar") lapseBar = wall.words;');
    // The bare redirect("/subscribe") is gone: the wall decides where (a billing_error rides along).
    expect(layout).not.toContain('redirect("/subscribe")');
  });

  it("the red bar: the words from the wall, Pick A Plan → /subscribe, and the accountant's door (S7); the grace banner stays", () => {
    expect(layout).toContain("{lapseBar && (");
    expect(layout).toMatch(/bg-red-600[^\n]*\n\s*<span>\{lapseBar\}<\/span>/);
    expect(layout).toMatch(/href="\/subscribe"[\s\S]{0,300}Pick A Plan/);
    expect(layout).toMatch(/href="\/analytics\/accountant"[\s\S]{0,300}Download For Your Accountant/);
    expect(layout).toContain("Your card was declined — update it in Settings.");
  });

  it("the grace banner is decided by THE one access rule (skeptic #43, S9): reason grace and its days, never a second grace function", () => {
    expect(layout).toContain("const standing = billingEnabled && org ? accessState({ ...org, id: profile.org_id }) : null;");
    expect(layout).toContain('const graceLeft = standing?.reason === "grace" ? (standing.daysLeft ?? 0) : 0;');
    expect(layout).not.toContain("graceDaysLeft");
    // The pinned gate literal stands exactly (stripe.test pins its distance from the alarm).
    expect(layout).toContain("if (billingEnabled && org && !hasActiveAccess(org) && !isCompedOrg(profile.org_id)) {");
  });

  /**
   * THE WALL LEAKED ON SOFT NAVIGATION (skeptic #43, S1). A hard load of /jobs redirected; a tap on
   * the dock's Jobs tile from /settings did not, because the (app) layout does not re-run on a client
   * navigation — the full dock on an open door was a map of every closed one. The layout tells the
   * shell it is lapsed and the one dock filter draws the open doors alone. No template.tsx: that
   * would be a second company read on every navigation.
   */
  it("the shell is told it is lapsed, from the red bar, through every renderer that reads the dock", () => {
    expect(layout).toContain("const lapsed = !!lapseBar;");
    expect(layout.indexOf("const lapsed = !!lapseBar;")).toBeGreaterThan(layout.indexOf('if (wall.kind === "bar") lapseBar = wall.words;'));
    expect((layout.match(/ lapsed=\{lapsed\}/g) ?? []).length).toBe(4); // Dock, Topbar, SectionSubnav, CommandBar
    expect(layout).toMatch(/<Dock [^>]*lapsed=\{lapsed\}/);
    expect(layout).toMatch(/<Topbar [^>]*lapsed=\{lapsed\}/);
    expect(layout).toMatch(/<SectionSubnav [^>]*lapsed=\{lapsed\}/);
    expect(layout).toMatch(/<CommandBar [^>]*lapsed=\{lapsed\}/);
    expect(existsSync("src/app/(app)/template.tsx")).toBe(false);
  });

  it("the lapsed dock is the wall's own open doors, one row each, Title Case — for staff and crew, whatever the switches", () => {
    const open = new Set<string>(LAPSED_OPEN_DOORS);
    // The wall matches a door by its PATH (lapsedDoorOpen); a row's ?tab= only picks the cluster, so
    // the export row (/settings?tab=getpaid, cn-v1138) is Settings' door with its own words.
    const door = (href: string | undefined) => (href ?? "").split("?")[0];
    for (const isStaff of [true, false]) {
      const sections = visibleDock({ isStaff, features: { leads: false, estimates: false } as never, lapsed: true });
      expect(sections).toEqual([LAPSED_DOCK]);
      for (const row of sections[0].children) {
        expect(open.has(door(row.href)), row.href).toBe(true);
        for (const w of row.label.split(/\s+/)) expect(w, row.label).toMatch(/^[A-Z]/);
      }
    }
    expect([...new Set(LAPSED_DOCK.children.map((r) => door(r.href)))].sort()).toEqual([...LAPSED_OPEN_DOORS].sort());
    expect(LAPSED_DOCK.children.map((r) => r.label)).toEqual(["Pick A Plan", "Settings", "Download For Your Accountant", "Download Everything"]);
    expect(LAPSED_DOCK.children.map((r) => r.href)).toEqual(["/subscribe", "/settings", "/analytics/accountant", "/settings?tab=getpaid"]);
    // Not lapsed: the dock is what it was.
    expect(visibleDock({ isStaff: true }).some((s) => s.key === "plan")).toBe(false);
  });

  it("middleware sets both headers on the request right before the session hand-off", () => {
    const set1 = mw.indexOf("request.headers.set(PATHNAME_HEADER, request.nextUrl.pathname)");
    const set2 = mw.indexOf("request.headers.set(SEARCH_HEADER, request.nextUrl.search)");
    const hand = mw.lastIndexOf("await updateSession(request");
    expect(set1).toBeGreaterThan(0);
    expect(set2).toBeGreaterThan(set1);
    expect(hand).toBeGreaterThan(set2);
  });
});
