import { describe, it, expect, vi, beforeEach } from "vitest";
import { getOrgSettings } from "@/lib/org-settings";

/**
 * THE CARD'S "RIGHT NOW" (cn-v1185): read only while the offer is on, for the signed-in company, by
 * the public door's own reader; a throw is a failed read, never "nothing open".
 */
const reader = vi.hoisted(() => ({ offers: true, times: [] as { at: string; ymd: string; hm: string }[], throws: false, calls: [] as unknown[][] }));
vi.mock("@/lib/schedule/open-times", () => ({
  offersOpenTimes: () => reader.offers,
  openInspectionTimes: async (...a: unknown[]) => {
    reader.calls.push(a);
    if (reader.throws) throw new Error("read failed");
    return reader.times;
  },
  openTimeLabel: (t: { ymd: string; hm: string }) => `${t.ymd} ${t.hm}`,
}));

const { readOpenTimesPreview } = await import("./open-times-preview");
const settings = getOrgSettings({});
const client = {} as never;

beforeEach(() => {
  reader.offers = true;
  reader.times = [];
  reader.throws = false;
  reader.calls = [];
});

describe("readOpenTimesPreview", () => {
  it("offer off: reads nothing, shows nothing", async () => {
    reader.offers = false;
    expect(await readOpenTimesPreview(client, "org-1", settings)).toBeNull();
    expect(reader.calls).toHaveLength(0);
  });

  it("no company: reads nothing", async () => {
    expect(await readOpenTimesPreview(client, null, settings)).toBeNull();
    expect(reader.calls).toHaveLength(0);
  });

  it("on: the labels, read with the caller's own client and company", async () => {
    reader.times = [{ at: "x", ymd: "2026-11-24", hm: "09:00" }];
    expect(await readOpenTimesPreview(client, "org-1", settings)).toEqual({ labels: ["2026-11-24 09:00"] });
    expect(reader.calls[0][0]).toBe(client);
    expect(reader.calls[0][1]).toBe("org-1");
  });

  it("nothing open is an empty list", async () => {
    expect(await readOpenTimesPreview(client, "org-1", settings)).toEqual({ labels: [] });
  });

  it("a throw is a failed read, never 'nothing open'", async () => {
    reader.throws = true;
    expect(await readOpenTimesPreview(client, "org-1", settings)).toEqual({ failed: true });
  });
});
