import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pinCard, storedCoord, storedPoint } from "./map-pin";
import { jobAddressLine } from "@/lib/timeclock/job-coordinates";

const ROOT = join(__dirname, "..", "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** A stand-in document: enough of one to build the card, and it records what was written where. */
function fakeDoc() {
  const make = (tag: string) => {
    const el: any = { tag, style: {}, kids: [] as any[], textContent: "", href: "" };
    el.append = (...n: any[]) => el.kids.push(...n);
    return el;
  };
  return { createElement: make, createTextNode: (text: string) => ({ text }) } as unknown as Document;
}

describe("the job map's pin (2026-11-16: a pin near Montreal for a job in the owner's own town)", () => {
  it("the line the map sends is the whole address, the one the fence's lookup sends", () => {
    // What the job held: the street in `address`, the town in its own three columns.
    expect(jobAddressLine({ address: "12 Larkspur Drive", city: "Snowbell", state: "CA", zip: "96000" })).toBe("12 Larkspur Drive, Snowbell, CA 96000");
    // A one-line address that already carries its town is sent as it is, the town not said twice.
    expect(jobAddressLine({ address: "12 Larkspur Drive, Snowbell, CA 96000, USA", city: "Snowbell", state: "CA", zip: "96000" })).toBe("12 Larkspur Drive, Snowbell, CA 96000, USA");
    const panel = read("src/app/(app)/schedule/map-panel.tsx");
    expect(panel).toContain("address: jobAddressLine(j)");
    expect(panel).not.toContain("address: j.address");
    for (const col of ["city", "state", "zip", "geo_lat", "geo_lng"]) expect(panel).toMatch(new RegExp(`\\.select\\("[^"]*\\b${col}\\b`));
  });

  it("a point kept on the job is used as it is, and only a whole point", () => {
    expect(storedPoint({ lat: 39.35, lng: -120.09 })).toEqual({ lat: 39.35, lng: -120.09 });
    expect(storedPoint({ lat: "39.35", lng: "-120.09" })).toEqual({ lat: 39.35, lng: -120.09 });
    expect(storedPoint({ lat: 39.35, lng: null })).toBeNull();
    expect(storedPoint({ lat: null, lng: null })).toBeNull();
    expect(storedPoint({ lat: 139.35, lng: -120.09 })).toBeNull();
    expect(storedPoint({})).toBeNull();
    expect(storedCoord("")).toBeNull();
    expect(storedCoord("north")).toBeNull();
    const map = read("src/components/jobs-map.tsx");
    // The kept point is read before anybody is asked, and a job with a point needs no address line.
    expect(map.indexOf("storedPoint(j)")).toBeGreaterThan(-1);
    expect(map.indexOf("storedPoint(j)")).toBeLessThan(map.indexOf("geocoder.geocode({ address: j.address })"));
  });

  it("the card is built as nodes: a name is text, never markup", () => {
    const hostile = '<img src=x onerror="x()">';
    const card: any = pinCard(fakeDoc(), { id: "job 1/2", name: hostile, customer: hostile }, "Open Job");
    const [name, , customer, , open] = card.kids;
    expect(name.tag).toBe("strong");
    expect(name.textContent).toBe(hostile);
    expect(customer).toEqual({ text: hostile });
    expect(open.tag).toBe("a");
    expect(open.href).toBe("/jobs/job%201%2F2");
    expect(open.textContent).toBe("Open Job →");
    // No customer, no empty line for one.
    const bare: any = pinCard(fakeDoc(), { id: "j", name: "Larkspur", customer: null }, "Open Job");
    expect(bare.kids.map((k: any) => k.tag ?? "text")).toEqual(["strong", "br", "a"]);
    // And the map hands the info window that node: no HTML string is put together from a name.
    const map = read("src/components/jobs-map.tsx");
    expect(map).toContain('info.setContent(pinCard(document, j, t("ag_cal_btn_openJob")))');
    expect(map).not.toMatch(/setContent\(\s*`/);
  });
});
