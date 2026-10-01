/**
 * THE BLANK SCREEN (Erik, 2026-10-01): his Money tab drew the shell, the bottom nav and nothing
 * else, in the truck, minutes after a deploy. No error reached the sink, because the failure is
 * that the page's javascript never loads at all.
 *
 * THE MECHANISM. The page cache is deliberately NOT version-keyed (audit 8: keying it wiped every
 * visited page on every deploy, nine in one day, so the dead-zone fallback was empty exactly when a
 * tech needed it). But the STATIC cache IS version-keyed, and `activate` deletes every static cache
 * but the current one. So after a deploy the page cache still holds html from the OLD build, and
 * that html names /_next/static chunks that no longer exist in any cache. One flaky navigation on
 * 5G is all it takes to serve it: the shell paints, nothing hydrates, blank screen, no dead end
 * worse in the app.
 *
 * THE RULE THIS PINS: a cached page is stamped with the build that cached it, and the offline
 * fallback serves one back ONLY if that stamp is the build now running. Otherwise /offline, which
 * is honest about what happened. The dead-zone benefit is kept for the common case (a page he
 * visited during THIS build's session) and the blank screen is impossible.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { APP_VERSION } from "./version";

const SW = readFileSync("public/sw.js", "utf8");

describe("the service worker never serves a page that cannot run", () => {
  it("stamps every cached page with the build that cached it", () => {
    expect(SW).toContain("PAGE_VERSION_HEADER");
    expect(SW).toMatch(/headers\.set\(PAGE_VERSION_HEADER, VERSION\)/);
  });

  it("serves a cached page back ONLY when its stamp is the running build", () => {
    expect(SW).toMatch(/cached\.headers\.get\(PAGE_VERSION_HEADER\) === VERSION/);
  });

  it("falls through to the offline page rather than a page from an older build", () => {
    const fallback = SW.slice(SW.indexOf('req.mode === "navigate"'));
    expect(fallback).toContain('caches.match("/offline")');
    // The old shape — any cached page wins — must not come back.
    expect(SW).not.toMatch(/caches\.match\(req\)\.then\(\(cached\) => cached \|\| caches\.match\("\/offline"\)\)/);
  });

  it("keeps the page cache unversioned, so a deploy does not empty the dead-zone fallback", () => {
    expect(SW).toMatch(/const PAGE_CACHE = "pages";/);
    expect(SW).not.toMatch(/const PAGE_CACHE = `pages-\$\{VERSION\}`/);
  });

  it("the worker's VERSION is the app's version, so the stamp means something", () => {
    const m = SW.match(/const VERSION = "(cn-v\d+)"/);
    expect(m?.[1]).toBe(APP_VERSION);
  });

  it("still never serves stale html when the network works (network-first)", () => {
    const nav = SW.slice(SW.indexOf('req.mode === "navigate"'));
    // fetch(req) comes BEFORE any cache read on this arm.
    expect(nav.indexOf("fetch(req)")).toBeLessThan(nav.indexOf("PAGE_CACHE"));
  });
});
