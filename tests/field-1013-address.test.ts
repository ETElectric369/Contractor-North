/**
 * THE ADDRESS PICKER, AFTER THE CLAUDIO VISIT (Erik, 2026-10-13): "it couldnt find the address then
 * deleted what i typed … a use my location button right there would have been gold."
 *
 * The record on production said it all: location "3812 Dinah", state GA, zip 30014 under a Tahoe
 * City title — an unbiased Google pick, a thumb's touch taken as a pick, and a typed override that
 * left the pick's parts standing. Five rules, pinned here:
 *   1. every autocomplete search carries a bias: the phone's last fix, else the company's ground;
 *   2. a reverse lookup turns where the phone is into an address with its parts (Use My Location);
 *   3. a typed line keeps a pick's parts only while it still says them;
 *   4. a dropdown pick is a tap (down + up within a few pixels), never the first touch;
 *   5. the Inspector's Where writes on blur or on a pick, not every 900 ms.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { partsFromComponents, pickReverse, orgAddressLine } from "@/lib/geocode-server";
import { typedLineKeepsParts } from "@/lib/site-address";
import { addressBias, setOrgBias } from "@/lib/place-bias";

const read = (p: string) => readFileSync(p, "utf8");

describe("a reverse lookup becomes an address with its parts", () => {
  it("reads Google's long/short components into the four stored parts", () => {
    const parts = partsFromComponents([
      { long_name: "3812", short_name: "3812", types: ["street_number"] },
      { long_name: "Bayberry Road", short_name: "Bayberry Rd", types: ["route"] },
      { long_name: "Tahoe City", short_name: "Tahoe City", types: ["locality", "political"] },
      { long_name: "California", short_name: "CA", types: ["administrative_area_level_1", "political"] },
      { long_name: "96145", short_name: "96145", types: ["postal_code"] },
    ]);
    expect(parts).toEqual({ line1: "3812 Bayberry Road", city: "Tahoe City", state: "CA", zip: "96145" });
  });
  it("takes a street address over a plus code, and nothing when only a plus code answers", () => {
    const plus = { formatted_address: "8FWH+2V Tahoe City, CA", types: ["plus_code"] };
    const street = { formatted_address: "3812 Bayberry Rd, Tahoe City, CA 96145, USA", types: ["street_address"] };
    const route = { formatted_address: "Bayberry Rd, Tahoe City, CA", types: ["route"] };
    expect(pickReverse([plus, route, street])).toBe(street);
    // a bare road is not an address a job can carry: the person types the number
    expect(pickReverse([plus, route])).toBeNull();
    expect(pickReverse([plus])).toBeNull();
    expect(pickReverse(null)).toBeNull();
  });
  it("the company's ground is its street address as one line, never a city alone", () => {
    expect(orgAddressLine({ address_line1: "12 Bayberry Ct", city: "Truckee", state: "CA", zip: "96161" })).toBe("12 Bayberry Ct, Truckee, CA, 96161");
    expect(orgAddressLine({ address_line1: " ", city: "Truckee" })).toBe("");
    expect(orgAddressLine(null)).toBe("");
  });
});

describe("a typed line keeps a pick's parts only while it still says them", () => {
  it("the Claudio case: a Georgia pick's parts do not outlive a typed Tahoe street", () => {
    expect(typedLineKeepsParts("3812 Dinah", { city: null, state: "GA", zip: "30014" })).toBe(false);
  });
  it("a full line that still carries the state and zip keeps the parts; whole words only", () => {
    expect(typedLineKeepsParts("3812 Bayberry Rd, Tahoe City, CA 96145, USA", { city: "Tahoe City", state: "CA", zip: "96145" })).toBe(true);
    expect(typedLineKeepsParts("10 Bayberry Dr, Cathedral City", { city: null, state: "CA", zip: null })).toBe(false);
    // the state and zip judge, never the city: a borough stored under its postal city keeps its parts
    expect(typedLineKeepsParts("350 5th Ave, New York, NY 10118, USA", { city: "Manhattan", state: "NY", zip: "10118" })).toBe(true);
    // only a city stored → the city judges
    expect(typedLineKeepsParts("12 Bayberry Ct", { city: "Truckee", state: null, zip: null })).toBe(false);
    expect(typedLineKeepsParts("12 Bayberry Ct, Truckee", { city: "Truckee", state: null, zip: null })).toBe(true);
  });
  it("nothing stored means nothing to clear", () => {
    expect(typedLineKeepsParts("anything", { city: null, state: null, zip: null })).toBe(true);
    expect(typedLineKeepsParts("anything", null)).toBe(true);
  });
});

describe("where an address box looks first", () => {
  const g = globalThis as { localStorage?: unknown };
  let had: unknown;
  beforeEach(() => { had = g.localStorage; });
  afterEach(() => { g.localStorage = had; setOrgBias(null); });
  it("the phone's recent fix wins; else the company's ground; else nothing", () => {
    g.localStorage = undefined;
    expect(addressBias()).toBeNull();
    setOrgBias({ lat: 39.33, lng: -120.18 });
    expect(addressBias()).toEqual({ lat: 39.33, lng: -120.18 });
    const store = new Map<string, string>([["gps:last", JSON.stringify({ lat: 39.17, lng: -120.14, ts: Date.now() - 60_000 })]]);
    g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: () => {}, removeItem: () => {} };
    expect(addressBias()).toEqual({ lat: 39.17, lng: -120.14 });
    store.set("gps:last", JSON.stringify({ lat: 1, lng: 1, ts: Date.now() - 2 * 24 * 3600_000 })); // two days old: stale
    expect(addressBias()).toEqual({ lat: 39.33, lng: -120.18 });
  });
});

describe("the doors carry the rules (source pins)", () => {
  it("/api/places biases on the caller's point, a circle at Google's ceiling plus an origin", () => {
    const s = read("src/app/api/places/route.ts");
    expect(s).toContain("const BIAS_RADIUS_M = 50_000");
    expect(s).toMatch(/locationBias: \{ circle: \{ center: here, radius: BIAS_RADIUS_M \} \}, origin: here/);
    expect(s).toMatch(/typeof lat === "number" && typeof lng === "number"/);
  });
  it("/api/geocode answers ?latlng= with the place and refuses a malformed pair", () => {
    const s = read("src/app/api/geocode/route.ts");
    expect(s).toContain('searchParams.get("latlng")');
    expect(s).toContain("reverseGeocode(lat, lng)");
    expect(s).toContain('{ error: "latlng must be lat,lng" }, { status: 400 }');
    // the reverse door is a signed-in door on a public route
    expect(s).toMatch(/if \(!user\) return NextResponse\.json\(\{ error: "sign in" \}, \{ status: 401 \}\);\s*return answer\(await reverseGeocode/);
  });
  it("the geocoder treats Google's 200-with-an-error as a failure, keeps a position out of the shared cache, and has a fuse per door", () => {
    const s = read("src/lib/geocode-server.ts");
    expect(s).toContain('if (!res.ok || (data.status !== "OK" && data.status !== "ZERO_RESULTS")) result = { status: "failed" };');
    expect(s).toContain('{ cache: "no-store" as const }');
    expect(s).toContain('fuse: { key: "google-geocode-reverse:day", limit: REVERSE_CALLS_PER_DAY }');
    expect(s).toContain('fuse: { key: "google-geocode:day", limit: GEOCODE_CALLS_PER_DAY }');
    expect(s).toContain("const FAIL_TTL_MS = 60 * 1000;");
    expect(s).toContain("query: `latlng=${at}`"); // the rounded point, never the raw one
  });
  it("every address box sends the bias with its search, reports blur, and picks on a tap", () => {
    const s = read("src/components/address-autocomplete.tsx");
    expect(s).toContain("bias: addressBias()");
    expect(s.match(/onBlur=\{onBlur\}/g)?.length).toBe(2); // the keyed box and the no-key fallback
    expect(s).toContain("onPointerUp=");
    expect(s).toContain("onPointerCancel=");
    expect(s).toContain("if (e.detail === 0) choose(s);"); // keyboard and screen-reader picks
    expect(s).toContain("if (!open) downRef.current = null;");
    expect(s).toMatch(/Math\.hypot\(e\.clientX - d\.x, e\.clientY - d\.y\) < 10\) choose\(s\)/);
    expect(s).not.toMatch(/onPointerDown=\{\(e\) => \{\s*e\.preventDefault\(\);\s*choose\(s\);/);
  });
  it("the app shell hands every box the company's ground, streamed behind the shell", () => {
    const s = read("src/app/(app)/layout.tsx");
    expect(s).toContain("settings, address_line1, city, state, zip\")");
    expect(s).toMatch(/<Suspense fallback=\{null\}>\s*<OrgPlaceBiasSlot org=\{org\} \/>/);
    expect(s).toContain("const b = await orgPlaceBias(org);");
  });
  it("the Inspector's Where writes on blur or on a pick and has Use My Location", () => {
    const s = read("src/app/(app)/appointments/[id]/inspector.tsx");
    expect(s).toContain("onBlur={() => schedule()}");
    expect(s).toContain("onTextChange={(v) => { if (v !== placeRef.current) setLocatedNote(null); setPlace(v); }}");
    expect(s).not.toContain("onTextChange={(v) => { setPlace(v); schedule(); }}");
    // the leave-page flush writes the address too, and never rewrites a line a pick wrote with parts
    expect(s).toMatch(/const send = \(\) => \{[\s\S]*void setAppointmentPlace\(appointmentId, placeRef\.current\)\.catch/);
    expect(s).toContain('latestPlace.trim() !== (savedPlaceRef.current ?? "").trim()');
    // no speculation: a loose fix or a numberless road fills nothing and says the one thing to do
    expect(s).toContain("const LOCATE_SURE_M = 150;");
    expect(s).toContain("if (m > LOCATE_SURE_M) {");
    expect(s).toContain("Only sure to within ${m} m — step closer and tap again, or type the number.");
    expect(s).toContain("No street address at this spot — type the number and street.");
    expect(s).toContain("Address lookup is down — type the address.");
    expect(s).toContain("Address lookup is at its daily limit — type the address.");
    expect(s).toContain("Use My Location");
    expect(s).toContain("/api/geocode?latlng=${fix.coords.lat},${fix.coords.lng}");
    expect(s).toContain("key={whereKey}");
    // the located line is written WITH its parts, and a refusal names one action
    expect(s).toMatch(/setAppointmentPlace\(appointmentId, line, \{ city: found\.city \?\? null, state: found\.state \?\? null, zip: found\.zip \?\? null \}\)/);
    expect(s).toContain("Location is off for North — turn it on in Settings.");
  });
  it("setAppointmentPlace reads the stored parts and clears them when a typed line drops them", () => {
    const s = read("src/app/(app)/appointments/actions.ts");
    expect(s).toContain('.select("title, type, city, state, zip")');
    expect(s).toContain("const clearStale = parts === undefined && !!existing && !typedLineKeepsParts(clean, existing");
    expect(s).toContain("...(clearStale ? { city: null, state: null, zip: null } : {}),");
  });
});
