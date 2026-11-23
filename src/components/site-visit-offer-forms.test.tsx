import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { seed } from "./seed-state.test-support";

/**
 * THE FOUR PUBLIC FORMS AND THE OFFER (cn-v1185). The two forms that already had Request a Site
 * Visit (/inquire, the deck configurator) draw the picker in place of the done sentence when the
 * request answered with times, and today's screens otherwise. The two that had no request button
 * (the hosted site's contact form, the intake form) show ONE Pick a Time for a Site Visit button on
 * their thank-you, only when the company offers times AND this submit returned its own lead id; with
 * the offer off they are exactly what they were.
 *
 * The "after the tap" screens are reached by seeding the forms' useState slots by call order
 * (seed-state.test-support): inquiry-form 10 done, 11 leadId, 14 schedDone, 16 offer; configurator
 * 4 result, then its ScheduleVisitCta 5 busy, 6 done, 8 offer; contact-form 6 done, 8 leadId;
 * intake-form 6 done, 8 leadId. A slot moved by an edit makes these fail loudly, not pass quietly:
 * each case also asserts the screen it expected to reach.
 */
vi.mock("react", async (orig) => (await import("./seed-state.test-support")).seededReact((await orig()) as never));
vi.mock("@/lib/actions/public-schedule", () => ({ publicScheduleInspection: vi.fn(), publicPickInspectionTime: vi.fn() }));
vi.mock("@/app/inquire/[org]/actions", () => ({ submitPublicInquiry: vi.fn() }));
vi.mock("@/app/estimate/[handle]/actions", () => ({ submitEstimateLead: vi.fn() }));
vi.mock("@/app/site/actions", () => ({ submitSiteContact: vi.fn() }));
vi.mock("@/app/intake/[handle]/actions", () => ({ submitIntake: vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));

const W = await import("@/app/inquire/site-visit-words");
const { InquiryForm } = await import("@/app/inquire/[org]/inquiry-form");
const { Configurator } = await import("@/app/estimate/[handle]/configurator");
const { ContactForm } = await import("@/app/site/contact-form");
const { IntakeForm } = await import("@/app/intake/[handle]/intake-form");

const times = [
  { at: "2026-11-24T17:00:00.000Z", label: "Tue, Nov 24 · 9:00 AM" },
  { at: "2026-11-24T18:30:00.000Z", label: "Tue, Nov 24 · 10:30 AM" },
];
const esc = (s: string) => renderToStaticMarkup(createElement("span", null, s)).slice(6, -7);
const draw = (slots: Record<number, unknown>, el: Parameters<typeof renderToStaticMarkup>[0]) => {
  seed(slots);
  const html = renderToStaticMarkup(el);
  seed();
  return html;
};
const HEADING = () => esc(W.PICK_A_TIME_HEADING);

describe("/inquire", () => {
  const props = { org: "org-1", brandColor: "#123456" };
  it("times -> the picker in place of the request button and its footnote", () => {
    const html = draw({ 10: true, 11: "lead-1", 16: times }, createElement(InquiryForm, props));
    expect(html).toContain("Thank you!");
    expect(html).toContain(HEADING());
    expect(html).toContain(esc(times[1].label));
    expect(html).not.toContain("Request a Site Visit");
    expect(html).not.toContain("time options to pick from");
  });
  it("no times -> today's thank-you", () => {
    const html = draw({ 10: true, 11: "lead-1" }, createElement(InquiryForm, props));
    expect(html).toContain("Request a Site Visit");
    expect(html).not.toContain(HEADING());
    const sent = draw({ 10: true, 14: W.SITE_VISIT_REQUESTED }, createElement(InquiryForm, props));
    expect(sent).toContain(esc(W.SITE_VISIT_REQUESTED));
    expect(sent).not.toContain(HEADING());
  });
});

describe("the deck configurator", () => {
  const props = { handle: "larkspur", orgName: "Larkspur Decks", brand: "#123456", rates: {}, threshold: 20000, headline: "", tagline: "" } as never;
  const big = { ok: true, showInstantPrice: false, siteInspectionRequired: true, bucket: "big", leadId: "lead-1" };
  it("times -> the picker in place of Request a Site Visit", () => {
    const html = draw({ 4: big, 8: times }, createElement(Configurator, props));
    expect(html).toContain("free on-site visit");
    expect(html).toContain(HEADING());
    expect(html).not.toContain("Request a Site Visit");
  });
  it("no times -> today's button", () => {
    const html = draw({ 4: big }, createElement(Configurator, props));
    expect(html).toContain("Request a Site Visit");
    expect(html).not.toContain(HEADING());
  });
});

describe.each([
  ["the hosted site's contact form", (offersTimes?: boolean) => createElement(ContactForm, { orgId: "org-1", brand: "#123456", heading: "Request a free estimate", ...(offersTimes === undefined ? {} : { offersTimes }) }), "Thanks — we"],
  ["the intake form", (offersTimes?: boolean) => createElement(IntakeForm, { handle: "larkspur", needs: [], orgName: "Larkspur Decks", ...(offersTimes === undefined ? {} : { offersTimes }) }), "Sent — thank you."],
] as const)("%s", (_name, form, thanks) => {
  const DONE = 6;
  const LEAD = 8;
  it("offer on and its own lead id -> ONE Pick a Time for a Site Visit button", () => {
    const html = draw({ [DONE]: true, [LEAD]: "lead-1" }, form(true));
    expect(html).toContain(thanks);
    expect(html.split(esc(W.OFFER_A_SITE_VISIT)).length - 1).toBe(1);
    expect(html).toMatch(/<button type="button" class="[^"]*min-h-\[44px\]/);
  });
  it("offer off -> no button, the thank-you exactly as without the prop", () => {
    const off = draw({ [DONE]: true, [LEAD]: "lead-1" }, form(false));
    expect(off).toContain(thanks);
    expect(off).not.toContain(esc(W.OFFER_A_SITE_VISIT));
    expect(off).toBe(draw({ [DONE]: true }, form()));
  });
  it("offer on but no lead id from this submit (a bot's fake success) -> no button", () => {
    const html = draw({ [DONE]: true }, form(true));
    expect(html).toContain(thanks);
    expect(html).not.toContain(esc(W.OFFER_A_SITE_VISIT));
  });
  it("the form itself is the same on or off", () => {
    expect(draw({}, form(true))).toBe(draw({}, form()));
  });
});

describe("the wiring the static draws cannot tap", () => {
  const src = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");
  it("the two request forms keep times only when the request answered with some", () => {
    for (const rel of ["src/app/inquire/[org]/inquiry-form.tsx", "src/app/estimate/[handle]/configurator.tsx"])
      expect(src(rel), rel).toContain("if (res.times && res.times.length > 0) { setOffer(res.times); return; }");
  });
  it("the two new doors keep only the lead id their own submit returned", () => {
    expect(src("src/app/site/contact-form.tsx")).toContain("setLeadId(res.leadId ?? null);");
    expect(src("src/app/intake/[handle]/intake-form.tsx")).toContain("setLeadId(r.leadId ?? null);");
  });
  it("the two server pages pass offersOpenTimes(settings)", () => {
    expect(src("src/app/site/org-site.tsx")).toContain("const offersTimes = offersOpenTimes(s);");
    expect(src("src/app/site/org-site.tsx")).toContain("offersTimes={offersOpenTimes(org.settings)}");
    expect(src("src/app/intake/[handle]/page.tsx")).toContain("offersTimes={offersOpenTimes(org.settings)}");
  });
});
