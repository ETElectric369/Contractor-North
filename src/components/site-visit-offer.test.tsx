import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * THE PICKER (cn-v1185). The owner: "offer open times". A visitor who has just sent a public form
 * sees the open times the server found and taps one; the tap books it, or comes back "just taken"
 * with fresh times, or is refused in red with the buttons still there. "None of These Work" asks the
 * office for times instead. Each screen is drawn statically from its state; each tap's next state is
 * driven through the exported step with the two server actions stood in for.
 */
const act = vi.hoisted(() => ({ pick: vi.fn(), schedule: vi.fn() }));
vi.mock("@/lib/actions/public-schedule", () => ({
  publicPickInspectionTime: (...a: unknown[]) => act.pick(...a),
  publicScheduleInspection: (...a: unknown[]) => act.schedule(...a),
}));

const W = await import("@/app/inquire/site-visit-words");
const {
  SiteVisitOffer,
  SiteVisitOfferView,
  SiteVisitDoor,
  SiteVisitDoorView,
  stateAfterPick,
  pickTime,
  giveUp,
  askForTimes,
  DIDNT_GO_THROUGH,
} = await import("./site-visit-offer");

const T1 = { at: "2026-11-24T17:00:00.000Z", label: "Tue, Nov 24 · 9:00 AM" };
const T2 = { at: "2026-11-24T18:30:00.000Z", label: "Tue, Nov 24 · 10:30 AM" };
const T3 = { at: "2026-11-25T17:00:00.000Z", label: "Wed, Nov 25 · 9:00 AM" };
const times = [T1, T2];
const where = { handle: "larkspur", leadId: "lead-1" };
const sam = { name: "Sam Tillery", phone: "555-0100", email: "sam@example.com", address: "12 Larkspur Ln" };
const noop = () => {};
const view = (state: any, busy: string | null = null) =>
  renderToStaticMarkup(createElement(SiteVisitOfferView, { state, busy, onPick: noop, onGiveUp: noop }));
const buttons = (html: string) => [...html.matchAll(/<button[^>]*>(.*?)<\/button>/g)].map((m) => ({ tag: m[0], text: m[1].replace(/<[^>]+>/g, "") }));
const esc = (s: string) => renderToStaticMarkup(createElement("span", null, s)).slice(6, -7);

beforeEach(() => {
  act.pick.mockReset();
  act.schedule.mockReset();
});

describe("the panel, drawn from its state", () => {
  it("offers: the heading, one 44px button per time, and the quiet None of These Work", () => {
    const html = view({ kind: "pick", times, taken: false, error: null });
    expect(html).toContain(esc(W.PICK_A_TIME_HEADING));
    const b = buttons(html);
    expect(b.map((x) => x.text)).toEqual([T1.label, T2.label, W.NONE_OF_THESE_WORK]);
    for (const x of b) expect(x.tag).toContain("min-h-[44px]");
    expect(html).not.toContain("text-red-600");
    expect(html).not.toContain(esc(W.TIME_JUST_TAKEN));
  });

  it("the tapped time says One Moment… and every button waits", () => {
    const b = buttons(view({ kind: "pick", times, taken: false, error: null }, T2.at));
    expect(b.map((x) => x.text)).toEqual([T1.label, "One Moment…", W.NONE_OF_THESE_WORK]);
    for (const x of b) expect(x.tag).toContain('disabled=""');
  });

  it("just taken: the sentence above the fresh buttons", () => {
    const html = view({ kind: "pick", times: [T3], taken: true, error: null });
    expect(html).toContain(esc(W.TIME_JUST_TAKEN));
    expect(buttons(html).map((x) => x.text)).toEqual([T3.label, W.NONE_OF_THESE_WORK]);
  });

  it("a refusal reads in red with the buttons still there", () => {
    const html = view({ kind: "pick", times, taken: false, error: "Online booking isn't available right now." });
    expect(html).toMatch(/<p class="[^"]*text-red-600[^"]*">Online booking isn(&#x27;|')t available right now.<\/p>/);
    expect(buttons(html)).toHaveLength(3);
  });

  it("booked: the booked sentence and nothing else", () => {
    const html = view({ kind: "booked", label: T1.label });
    expect(html).toContain(esc(W.bookedSentence(T1.label)));
    expect(buttons(html)).toHaveLength(0);
    expect(html).not.toContain(esc(W.PICK_A_TIME_HEADING));
  });

  it("requested: the one request sentence", () => {
    const html = view({ kind: "requested" });
    expect(html).toContain(esc(W.SITE_VISIT_REQUESTED));
    expect(buttons(html)).toHaveLength(0);
  });

  it("SiteVisitOffer opens on the times it was handed", () => {
    const html = renderToStaticMarkup(createElement(SiteVisitOffer, { ...where, contact: sam, times }));
    expect(html).toBe(view({ kind: "pick", times, taken: false, error: null }));
  });

  it("no amber anywhere, and the words come from site-visit-words, never retyped", () => {
    const src = readFileSync(join(process.cwd(), "src/components/site-visit-offer.tsx"), "utf8");
    expect(src).not.toMatch(/amber/);
    // As a string literal (a comment may name the words; code may not retype them).
    for (const w of [W.PICK_A_TIME_HEADING, W.NONE_OF_THESE_WORK, W.TIME_JUST_TAKEN, W.OFFER_A_SITE_VISIT, W.SITE_VISIT_REQUESTED]) {
      expect(src).not.toContain(`"${w}"`);
      expect(src).not.toContain(`>${w}<`);
    }
    expect(src).not.toMatch(/@\/lib\/i18n|@\/lib\/words/);
  });
});

describe("a tap on a time", () => {
  it("sends the lead id and the instant, and nothing typed", async () => {
    act.pick.mockResolvedValue({ ok: true, booked: { label: T1.label } });
    await pickTime(where, T1.at, times);
    expect(act.pick).toHaveBeenCalledWith({ handle: "larkspur", orgId: undefined, leadId: "lead-1", at: T1.at });
  });

  it("booked -> the booked sentence", async () => {
    act.pick.mockResolvedValue({ ok: true, booked: { label: T1.label } });
    expect(await pickTime(where, T1.at, times)).toEqual({ kind: "booked", label: T1.label });
  });

  it("taken with times -> just taken, over the FRESH times", async () => {
    act.pick.mockResolvedValue({ ok: false, taken: true, times: [T3] });
    expect(await pickTime(where, T1.at, times)).toEqual({ kind: "pick", times: [T3], taken: true, error: null });
  });

  it("ok with neither -> the request sentence", async () => {
    act.pick.mockResolvedValue({ ok: true });
    expect(await pickTime(where, T1.at, times)).toEqual({ kind: "requested" });
  });

  it("a refusal -> its sentence, the same buttons", async () => {
    act.pick.mockResolvedValue({ ok: false, error: "Too many tries." });
    expect(await pickTime(where, T1.at, times)).toEqual({ kind: "pick", times, taken: false, error: "Too many tries." });
  });

  it("a call that never came back -> try again, or call us", async () => {
    act.pick.mockRejectedValue(new Error("offline"));
    expect(await pickTime(where, T1.at, times)).toEqual({ kind: "pick", times, taken: false, error: DIDNT_GO_THROUGH });
    expect(DIDNT_GO_THROUGH).toBe("That didn't go through. Try again, or call us.");
  });

  it("stateAfterPick never reads booked from a refusal", () => {
    expect(stateAfterPick({ ok: false }, times)).toEqual({ kind: "pick", times, taken: false, error: DIDNT_GO_THROUGH });
  });
});

describe("None of These Work", () => {
  it("asks the office with noOffer, the contact and the lead id, then says the request sentence", async () => {
    act.schedule.mockResolvedValue({ ok: true });
    expect(await giveUp(where, sam, times)).toEqual({ kind: "requested" });
    expect(act.schedule).toHaveBeenCalledWith({ handle: "larkspur", orgId: undefined, leadId: "lead-1", ...sam, noOffer: true });
  });

  it("a refusal or a dropped call keeps the buttons and says so", async () => {
    act.schedule.mockResolvedValue({ ok: false, error: "Too many requests." });
    expect(await giveUp(where, sam, times)).toEqual({ kind: "pick", times, taken: false, error: "Too many requests." });
    act.schedule.mockRejectedValue(new Error("offline"));
    expect(await giveUp(where, sam, times)).toEqual({ kind: "pick", times, taken: false, error: DIDNT_GO_THROUGH });
  });
});

describe("the door on a form that had no request button", () => {
  const door = (state: any, busy = false) =>
    renderToStaticMarkup(createElement(SiteVisitDoorView, { state, busy, brand: "#123456", where, contact: sam, onAsk: noop }));

  it("one 44px button, Pick a Time for a Site Visit; busy says One Moment…", () => {
    const b = buttons(door({ kind: "idle", error: null }));
    expect(b.map((x) => x.text)).toEqual([W.OFFER_A_SITE_VISIT]);
    expect(b[0].tag).toContain("min-h-[44px]");
    expect(buttons(door({ kind: "idle", error: null }, true)).map((x) => x.text)).toEqual(["One Moment…"]);
    expect(renderToStaticMarkup(createElement(SiteVisitDoor, { ...where, contact: sam, brand: "#123456" }))).toBe(door({ kind: "idle", error: null }));
  });

  it("times -> the picker; none -> the request sentence; a refusal -> red beside the button", async () => {
    act.schedule.mockResolvedValue({ ok: true, times });
    const offered = await askForTimes(where, sam);
    expect(offered).toEqual({ kind: "offer", times });
    expect(act.schedule).toHaveBeenCalledWith({ handle: "larkspur", orgId: undefined, leadId: "lead-1", ...sam });
    expect(door(offered)).toContain(esc(W.PICK_A_TIME_HEADING));

    act.schedule.mockResolvedValue({ ok: true });
    const asked = await askForTimes(where, sam);
    expect(asked).toEqual({ kind: "requested" });
    expect(door(asked)).toContain(esc(W.SITE_VISIT_REQUESTED));

    act.schedule.mockResolvedValue({ ok: true, times: [] });
    expect(await askForTimes(where, sam)).toEqual({ kind: "requested" });

    act.schedule.mockResolvedValue({ ok: false, error: "Too many requests." });
    const refused = await askForTimes(where, sam);
    expect(refused).toEqual({ kind: "idle", error: "Too many requests." });
    expect(door(refused)).toMatch(/text-red-600">Too many requests.<\/p>/);

    act.schedule.mockRejectedValue(new Error("offline"));
    expect(await askForTimes(where, sam)).toEqual({ kind: "idle", error: DIDNT_GO_THROUGH });
  });
});

describe("F6 (skeptic #87, S10) · where to come, asked at the pick when the contact has no address", () => {
  const dana = { name: "Dana Rook", phone: "555-0101" };
  const viewAsk = (address: string, busy: string | null = null) =>
    renderToStaticMarkup(createElement(SiteVisitOfferView, { state: { kind: "pick", times, taken: false, error: null }, busy, onPick: noop, onGiveUp: noop, ask: { address, onAddress: noop } }));

  it("no address on the contact: a labelled 44px box above the times; the time buttons stay enabled", () => {
    const html = renderToStaticMarkup(createElement(SiteVisitOffer, { ...where, contact: dana, times }));
    expect(html).toBe(viewAsk(""));
    expect(html).toContain(esc(W.WHERE_SHOULD_WE_COME));
    const input = html.match(/<input[^>]*>/)?.[0] ?? "";
    expect(input).toContain(`placeholder="${W.ADDRESS_PLACEHOLDER}"`);
    expect(input).toContain('autoComplete="street-address"');
    expect(input).toContain('maxLength="300"');
    expect(input).toContain("min-h-[44px]");
    expect(input).not.toContain('disabled=""');
    expect(html.indexOf("<input")).toBeLessThan(html.indexOf(T1.label));
    for (const b of buttons(html)) expect(b.tag).not.toContain('disabled=""');
  });

  it("a contact with an address: the panel exactly as before, no box", () => {
    const html = renderToStaticMarkup(createElement(SiteVisitOffer, { ...where, contact: sam, times }));
    expect(html).not.toContain("<input");
    expect(html).toBe(view({ kind: "pick", times, taken: false, error: null }));
  });

  it("the box waits while a tap is in flight", () => {
    expect(viewAsk("4 Snowbell Rd", T1.at).match(/<input[^>]*>/)?.[0]).toContain('disabled=""');
  });

  it("a tap with fewer than five characters makes NO call and says to add the address first", async () => {
    expect(await pickTime(where, T1.at, times, { address: "  4 S " })).toEqual({ kind: "pick", times, taken: false, error: W.ADDRESS_FIRST });
    expect(act.pick).not.toHaveBeenCalled();
    expect(viewAsk("4 S").includes("text-red-600")).toBe(false);
    const red = renderToStaticMarkup(createElement(SiteVisitOfferView, { state: { kind: "pick", times, taken: false, error: W.ADDRESS_FIRST }, busy: null, onPick: noop, onGiveUp: noop, ask: { address: "", onAddress: noop } }));
    expect(red).toContain(`text-red-600">${esc(W.ADDRESS_FIRST)}</p>`);
  });

  it("a tap with an address sends it, trimmed, with the lead id and the instant", async () => {
    act.pick.mockResolvedValue({ ok: true, booked: { label: T1.label } });
    expect(await pickTime(where, T1.at, times, { address: " 4 Snowbell Rd, Truckee " })).toEqual({ kind: "booked", label: T1.label });
    expect(act.pick).toHaveBeenCalledWith({ handle: "larkspur", orgId: undefined, leadId: "lead-1", at: T1.at, address: "4 Snowbell Rd, Truckee" });
  });

  it("the panel asks only when the contact has no address, sends what was typed, and its new state is the LAST useState", () => {
    const src = readFileSync(join(process.cwd(), "src/components/site-visit-offer.tsx"), "utf8");
    expect(src).toContain('const askAddress = !String(props.contact.address ?? "").trim();');
    expect(src).toContain("pickTime(where, at, shown, askAddress ? { address } : undefined)");
    const body = src.slice(src.indexOf("export function SiteVisitOffer("), src.indexOf("export type DoorState"));
    const states = [...body.matchAll(/useState[<(]/g)].map((m) => m.index!);
    expect(body.indexOf('const [address, setAddress] = useState("")')).toBe(states[states.length - 1] - 'const [address, setAddress] = '.length);
    for (const w of [W.WHERE_SHOULD_WE_COME, W.ADDRESS_PLACEHOLDER, W.ADDRESS_FIRST]) expect(src).not.toContain(`"${w}"`);
  });
});
