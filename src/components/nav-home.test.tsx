import { describe, it, expect, vi, beforeEach } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const nav = vi.hoisted(() => ({ pathname: "/appointments/abc123" }));
vi.mock("next/navigation", () => ({ usePathname: () => nav.pathname }));

import { NavHome, declareNavHome, declaredNavHome, useDeclaredNavHome, watchNavHome } from "./nav-home";

/**
 * A PAGE SAYS WHERE IT LIVES IN THE DOCK (components/nav-home): the store between a page and the
 * shell. The matcher's rule is lib/dock.test.ts (activeNav, navDrawnAt); what the rail and the strip draw
 * with it is app-shell/nav-home-shell.test.tsx. Here: what is declared, who may take it back, who is
 * told, and that the server and the first paint never see it.
 */
let takeBack: Array<() => void> = [];
const declare = (id: string, pathname: string) => {
  const undo = declareNavHome(id, pathname);
  takeBack.push(undo);
  return undo;
};

beforeEach(() => {
  for (const undo of takeBack.reverse()) undo();
  takeBack = [];
  expect(declaredNavHome()).toBeNull();
  nav.pathname = "/appointments/abc123";
});

describe("the declaration", () => {
  it("names a dock row and the pathname it was made on, until it is taken back", () => {
    const undo = declare("sl-inspections", "/appointments/abc123");
    expect(declaredNavHome()).toEqual({ id: "sl-inspections", pathname: "/appointments/abc123" });
    undo();
    expect(declaredNavHome()).toBeNull();
    undo(); // a second goodbye changes nothing
    expect(declaredNavHome()).toBeNull();
  });

  it("is taken back only by the page that made it: the next page is not undone by the last one's goodbye", () => {
    const leaveFirst = declare("sl-inspections", "/appointments/abc123");
    const leaveSecond = declare("s-week", "/appointments/def456");
    leaveFirst(); // the first page's cleanup, arriving after the second page has spoken
    expect(declaredNavHome()).toEqual({ id: "s-week", pathname: "/appointments/def456" });
    leaveSecond();
    expect(declaredNavHome()).toBeNull();
  });

  it("the same page declaring the same home again (a re-render's effect) still leaves one to take back", () => {
    const first = declare("sl-inspections", "/appointments/abc123");
    first();
    const second = declare("sl-inspections", "/appointments/abc123");
    expect(declaredNavHome()).toEqual({ id: "sl-inspections", pathname: "/appointments/abc123" });
    second();
    expect(declaredNavHome()).toBeNull();
  });

  it("tells whoever is watching, each time it changes, and stops when asked", () => {
    const seen: Array<string | null> = [];
    const stop = watchNavHome(() => seen.push(declaredNavHome()?.id ?? null));
    const undo = declare("sl-inspections", "/appointments/abc123");
    undo();
    expect(seen).toEqual(["sl-inspections", null]);
    stop();
    declare("s-week", "/appointments/abc123")();
    expect(seen).toEqual(["sl-inspections", null]);
  });
});

describe("the server and the first paint", () => {
  const Probe = () => createElement("i", null, useDeclaredNavHome()?.id ?? "none");

  it("read null whatever is declared, so the shell's first render matches what the server sent", () => {
    declare("sl-inspections", "/appointments/abc123");
    expect(renderToStaticMarkup(createElement(Probe))).toBe("<i>none</i>");
  });

  it("<NavHome> draws nothing, and declares only in an effect (never while rendering, never on the server)", () => {
    expect(renderToStaticMarkup(createElement(NavHome, { id: "sl-inspections" }))).toBe("");
    expect(declaredNavHome()).toBeNull();
    const src = readFileSync(join(process.cwd(), "src/components/nav-home.tsx"), "utf8");
    // Declared on the pathname the page is standing on, re-declared when either changes, taken back on the way out.
    expect(src).toContain("useLayoutEffect(() => declareNavHome(id, pathname), [id, pathname]);");
    expect(src).toContain("return useSyncExternalStore(watchNavHome, declaredNavHome, () => null);");
  });
});
