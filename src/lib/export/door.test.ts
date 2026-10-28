import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * THE TWO CHECKS EVERY EXPORT DOOR MAKES AFTER THE GUARD (lib/export/door, cn-v1138): a cross-site
 * fetch is refused with one sentence naming the door, and the company's downloads are counted, ten
 * an hour on one key across the three routes; anything else passes with nothing to say.
 */
const state = vi.hoisted(() => ({ limited: false, calls: [] as [string, number, number][] }));
vi.mock("@/lib/rate-limit", () => ({
  rateLimited: vi.fn(async (key: string, limit: number, window: number) => {
    state.calls.push([key, limit, window]);
    return state.limited;
  }),
}));

import { CROSS_SITE_WORDS, EXPORTS_PER_HOUR, EXPORT_WINDOW_SECONDS, TOO_MANY_DOWNLOADS_WORDS, exportDoorRefusal, exportRateKey } from "./door";

const req = (site?: string) => ({ headers: new Headers(site ? { "sec-fetch-site": site } : {}) });

beforeEach(() => {
  state.limited = false;
  state.calls = [];
});

describe("exportDoorRefusal", () => {
  it("a cross-site fetch is refused before the count, in words naming the door", async () => {
    expect(await exportDoorRefusal(req("cross-site"), "org-1")).toEqual({ status: 403, words: CROSS_SITE_WORDS });
    expect(CROSS_SITE_WORDS).toBe("Open this from Settings › Getting Paid › Your Data.");
    expect(state.calls).toEqual([]);
  });

  it("same-origin, same-site, a navigation and no header at all pass and count one download on the company's key", async () => {
    for (const site of ["same-origin", "same-site", "none", undefined]) expect(await exportDoorRefusal(req(site), "org-1"), String(site)).toBeNull();
    expect(state.calls).toEqual(Array.from({ length: 4 }, () => ["export:org-1", 10, 3600]));
    expect(exportRateKey("org-9")).toBe("export:org-9");
    expect(EXPORTS_PER_HOUR).toBe(10);
    expect(EXPORT_WINDOW_SECONDS).toBe(3600);
  });

  it("over the hour's ten: 429 in words naming when to come back", async () => {
    state.limited = true;
    expect(await exportDoorRefusal(req("same-origin"), "org-1")).toEqual({ status: 429, words: TOO_MANY_DOWNLOADS_WORDS });
    expect(TOO_MANY_DOWNLOADS_WORDS).toBe("That's enough downloads for this hour. Try again in an hour.");
  });
});
