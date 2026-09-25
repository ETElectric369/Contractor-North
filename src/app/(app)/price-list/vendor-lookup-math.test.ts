import { describe, expect, it } from "vitest";
import {
  applyPick,
  autoPick,
  changesFor,
  guardAnswer,
  lookupPlace,
  lookupPrice,
  nothingFoundText,
  pageKey,
  placeOfAddress,
  sourcesIn,
  type LookupAnswer,
} from "./vendor-lookup-math";

/**
 * THE NEVER-INVENT GUARD (Look Up, Phase 2). Every name, number, address and site here is made up:
 * a real vendor list never goes in this repo (it is public). 555 numbers, .example domains.
 */

/** A response's content as the web search tool returns it: results, then the model's JSON text,
 *  with one citation on it. */
function content(results: string[], cited: string[] = []) {
  return [
    { type: "server_tool_use", id: "srv_1", name: "web_search", input: { query: "Granite Peak Plumbing Truckee" } },
    {
      type: "web_search_tool_result",
      tool_use_id: "srv_1",
      content: results.map((url) => ({ type: "web_search_result", url, title: "A page", encrypted_content: "x", page_age: null })),
    },
    { type: "text", text: "{", citations: cited.map((url) => ({ type: "web_search_result_location", url, title: "A page", cited_text: "..." })) },
    // A failed search: content is an error OBJECT, not a list, and adds nothing.
    { type: "web_search_tool_result", tool_use_id: "srv_2", content: { type: "web_search_tool_result_error", error_code: "max_uses_exceeded" } },
  ];
}

const SITE = "https://granitepeakplumbing.example/contact";
const DIRECTORY = "https://www.townlistings.example/truckee/granite-peak-plumbing";

describe("where a field may come from: only the pages this response's searches returned", () => {
  it("collects every search result and every citation, and nothing else", () => {
    const s = sourcesIn(content([SITE], [DIRECTORY]));
    expect([...s.values()]).toEqual([SITE, DIRECTORY]);
  });

  it("the same page written a little differently is the same page; another page on the site is not", () => {
    expect(pageKey("https://www.granitepeakplumbing.example/contact/")).toBe(pageKey(SITE));
    expect(pageKey("http://GranitePeakPlumbing.example/contact#hours")).toBe(pageKey(SITE));
    expect(pageKey("https://granitepeakplumbing.example/about")).not.toBe(pageKey(SITE));
    expect(pageKey("javascript:alert(1)")).toBeNull();
    expect(pageKey("granitepeakplumbing.example/contact")).toBeNull();
  });
});

describe("guardAnswer: a field with no source URL from the search is DROPPED, never shown", () => {
  const sources = sourcesIn(content([SITE, DIRECTORY]));

  it("keeps the sourced phone and website, drops a FABRICATED email that cites nothing and an address citing a page never returned", () => {
    const parsed = {
      candidates: [
        {
          phone: "530-555-0142",
          website: "granitepeakplumbing.example",
          // Fabricated: no source at all.
          email: "office@granitepeakplumbing.example",
          // Fabricated: the source is a page the search never returned.
          address: "10 Made Up Way, Truckee, CA 96161",
          sources: { phone: SITE, website: SITE, address: "https://granitepeakplumbing.example/about" },
        },
      ],
    };
    const a = guardAnswer(parsed, sources, "Granite Peak Plumbing", "Truckee");
    expect(a.found).toBe(true);
    if (!a.found) return;
    expect(a.dropped).toBe(2);
    const c = a.choices[0];
    expect(c.fields.phone).toEqual({ value: "(530) 555-0142", source: SITE });
    expect(c.fields.website).toEqual({ value: "https://granitepeakplumbing.example/", source: SITE });
    expect(c.fields.email).toBeUndefined();
    expect(c.fields.address).toBeUndefined();
    // No kept address: the place isn't taken on the model's word, and there's nothing to map.
    expect(c.place).toBe("Place Not Found");
    expect(c.maps_url).toBeNull();
    expect(c.source_url).toBe(SITE);
  });

  it("a candidate whose every field is unsourced is removed, and the answer is Nothing Found (unsourced), not an invented card", () => {
    const parsed = { candidates: [{ phone: "(530) 555-0199", email: "made@up.example", sources: {} }] };
    const a = guardAnswer(parsed, sources, "Maria Delgado", "Truckee");
    expect(a).toEqual({ found: false, why: "unsourced", dropped: 2, near: "Truckee" });
  });

  it("a malformed value is dropped even with a source: a phone that isn't ten digits, an email with no domain", () => {
    const parsed = { candidates: [{ phone: "555-01", email: "office@", website: "granitepeakplumbing.example", sources: { phone: SITE, email: SITE, website: SITE } }] };
    const a = guardAnswer(parsed, sources, "Granite Peak Plumbing", "Truckee");
    expect(a.found && Object.keys(a.choices[0].fields)).toEqual(["website"]);
    expect(a.dropped).toBe(2);
  });

  it("nothing found is a plain answer: no candidates → found false, nothing to show, nothing to save", () => {
    const a = guardAnswer({ candidates: [], none_found_reason: "No listing." }, sources, "Maria Delgado", "Truckee");
    expect(a).toEqual({ found: false, why: "nothing", dropped: 0, near: "Truckee" });
    if (a.found) return;
    expect(nothingFoundText("Maria Delgado", a, true)).toBe(
      "Nothing found for Maria Delgado near Truckee. A person's name is harder to find. Add their phone yourself or leave it blank.",
    );
    expect(guardAnswer("not json at all", sources, "X", "").found).toBe(false);
    expect(guardAnswer(null, sources, "X", "").found).toBe(false);
  });

  it("the place label is read off the kept address; the map link is built from it, never taken from the model", () => {
    const parsed = {
      candidates: [
        {
          address: "10200 Pioneer Trl, Truckee, CA 96161",
          maps_url: "https://maps.example/fabricated",
          sources: { address: DIRECTORY },
        },
      ],
    };
    const a = guardAnswer(parsed, sources, "Granite Peak Plumbing", "Truckee");
    if (!a.found) throw new Error("expected a choice");
    expect(a.choices[0].place).toBe("Truckee, CA");
    expect(a.choices[0].maps_url).toBe(
      `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent("Granite Peak Plumbing, 10200 Pioneer Trl, Truckee, CA 96161")}`,
    );
    expect(a.choices[0].source_url).toBe(DIRECTORY);
  });

  it("a map page the search itself returned is kept as the map link", () => {
    const map = "https://maps.example/place/granite-peak";
    const a = guardAnswer({ candidates: [{ address: "1 Elm St, Truckee, CA", maps_url: map, sources: { address: map } }] }, sourcesIn(content([map])), "G", "");
    expect(a.found && a.choices[0].maps_url).toBe(map);
  });
});

describe("a multi-location answer is NEVER picked for a person", () => {
  const sources = sourcesIn(content(["https://sierralumberyard.example/truckee", "https://sierralumberyard.example/reno", "https://sierralumberyard.example/quincy", "https://sierralumberyard.example/grass-valley"]));
  const multi = {
    candidates: [
      { address: "11 Brockway Rd, Truckee, CA 96161", phone: "530-555-0110", sources: { address: "https://sierralumberyard.example/truckee", phone: "https://sierralumberyard.example/truckee" } },
      { address: "22 Kietzke Ln, Reno, NV 89502", phone: "775-555-0120", sources: { address: "https://sierralumberyard.example/reno", phone: "https://sierralumberyard.example/reno" } },
      { address: "33 Main St, Quincy, CA 95971", phone: "530-555-0130", sources: { address: "https://sierralumberyard.example/quincy", phone: "https://sierralumberyard.example/quincy" } },
      { address: "44 Idaho Maryland Rd, Grass Valley, CA 95945", phone: "530-555-0140", sources: { address: "https://sierralumberyard.example/grass-valley", phone: "https://sierralumberyard.example/grass-valley" } },
    ],
  };

  it("keeps at most three, each labelled with its own place, and picks none", () => {
    const a = guardAnswer(multi, sources, "Sierra Lumber Yard", "Truckee");
    if (!a.found) throw new Error("expected choices");
    expect(a.choices.map((c) => c.place)).toEqual(["Truckee, CA", "Reno, NV", "Quincy, CA"]);
    expect(autoPick(a, false)).toBeNull();
  });

  it("exactly one choice is picked for a company, never for a person's name", () => {
    const one = guardAnswer({ candidates: [multi.candidates[0]] }, sources, "Sierra Lumber Yard", "Truckee");
    expect(autoPick(one, false)?.place).toBe("Truckee, CA");
    expect(autoPick(one, true)).toBeNull();
    expect(autoPick({ found: false, why: "nothing", dropped: 0, near: "" }, false)).toBeNull();
  });

  it("two candidates with the same phone are one choice", () => {
    const dup = { candidates: [multi.candidates[0], { ...multi.candidates[0], address: undefined, sources: { phone: "https://sierralumberyard.example/truckee" } }] };
    const a = guardAnswer(dup, sources, "Sierra Lumber Yard", "Truckee");
    expect(a.found && a.choices.length).toBe(1);
  });
});

describe("what a pick changes: fills the empty, asks about the typed, saves nothing", () => {
  const sources = sourcesIn(content([SITE]));
  const a = guardAnswer(
    { candidates: [{ phone: "530-555-0142", email: "office@granitepeakplumbing.example", website: "granitepeakplumbing.example", sources: { phone: SITE, email: SITE, website: SITE } }] },
    sources,
    "Granite Peak Plumbing",
    "",
  ) as Extract<LookupAnswer, { found: true }>;
  const choice = a.choices[0];

  it("an empty field starts ticked; a typed one shows old → new unticked; the same value is left out", () => {
    const changes = changesFor({ phone: "1 (530) 555-0142", email: "bids@granitepeakplumbing.example", website: null, address: null }, choice);
    expect(changes.map((c) => [c.field, c.current, c.found.value, c.take])).toEqual([
      ["email", "bids@granitepeakplumbing.example", "office@granitepeakplumbing.example", false],
      ["website", null, "https://granitepeakplumbing.example/", true],
    ]);
  });

  it("applyPick fills only the ticked fields, and the source rides along only when something was taken", () => {
    const row = { phone: null, email: "bids@granitepeakplumbing.example", website: null, address: null };
    expect(applyPick(row, { choice, take: ["phone"] })).toEqual({
      phone: "(530) 555-0142",
      email: "bids@granitepeakplumbing.example",
      website: null,
      address: null,
      source_url: SITE,
      maps_url: null,
    });
    expect(applyPick(row, { choice, take: [] })).toMatchObject({ phone: null, source_url: null });
    expect(applyPick(row, null)).toMatchObject({ email: "bids@granitepeakplumbing.example", source_url: null });
  });
});

describe("where to search near, and the price on the button", () => {
  it("Vivian's shape: public city Truckee, no public state, a Reno NV office → Truckee alone, never 'Truckee, NV'", () => {
    const p = lookupPlace({ public_city: "Truckee", public_state: "" }, { city: "Reno", state: "NV" });
    expect(p).toEqual({ label: "Truckee", city: "Truckee", region: null, also: "Reno, NV" });
  });

  it("public state wins; the office's state is used only when the office is in the public city", () => {
    expect(lookupPlace({ public_city: "Truckee", public_state: "ca" }, { city: "Reno", state: "NV" })?.label).toBe("Truckee, CA");
    expect(lookupPlace({ public_city: "Chilcoot" }, { city: "Chilcoot", state: "CA" })).toEqual({ label: "Chilcoot, CA", city: "Chilcoot", region: "CA", also: null });
    expect(lookupPlace({}, { city: "Reno", state: "NV" })?.label).toBe("Reno, NV");
    expect(lookupPlace(null, null)).toBeNull();
  });

  it("the price before the tap", () => {
    expect(lookupPrice(1)).toBe("about $0.10");
    expect(lookupPrice(29)).toBe("about $0.10 each, about $3 total");
    expect(lookupPrice(5)).toBe("about $0.10 each, about $0.50 total");
  });

  it("reads a place off an address written the usual way, and gives up rather than guess", () => {
    expect(placeOfAddress("22 Kietzke Ln, Reno, NV 89502")).toBe("Reno, NV");
    expect(placeOfAddress("PO Box 12, south lake tahoe, ca")).toBe("South Lake Tahoe, CA");
    expect(placeOfAddress("somewhere near the lake")).toBeNull();
  });
});
