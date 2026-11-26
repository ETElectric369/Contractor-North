import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * SETTINGS TELLS THE TRUTH ABOUT TEXTING (2026-09-24). "Text timeclock reminders" sat ticked on an
 * org that could not send a text. Rendered here both ways, so the box can never again read "on"
 * while nothing can go out, and the Texting card names what is missing without a key in sight.
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("./actions", () => ({ updateOrgSettings: vi.fn(async () => ({ ok: true })) }));

import { SchedulingSettings } from "./scheduling-settings";
import { TextingCard } from "./texting-card";
import { AutomationSettings } from "./automation-settings";
import { getOrgSettings } from "@/lib/org-settings";
import { smsReadinessFrom } from "@/lib/sms-readiness";

// The stored choice is ON (the default), as it is on ET Electric today.
const settings = getOrgSettings({});

/** The timeclock reminders' choice (cn-v1190): its select, which option is chosen, and the words after it. */
function reminderChoice(html: string) {
  const at = html.indexOf("Timeclock Reminders Go Out By");
  const select = html.slice(html.indexOf("<select", at), html.indexOf("</select>", at) + 9);
  const chosen = (select.match(/<option value="(\w+)" selected="">/) ?? [])[1];
  const after = html.slice(html.indexOf("</select>", at), html.indexOf("</select>", at) + 1200);
  return { select, chosen, after };
}

describe("the timeclock reminders choice (cn-v1190: Push, Text or Both)", () => {
  it("one choice of three in the same card, the old checkbox gone", () => {
    const html = renderToStaticMarkup(createElement(SchedulingSettings, { settings, textReady: true }));
    const { select } = reminderChoice(html);
    expect(html).toContain('for="sc-remind-by">Timeclock Reminders Go Out By</label>');
    // A 44px tap target (h-11), not the house select's 40.
    expect(select).toMatch(/<select class="[^"]*\bh-11\b[^"]*" id="sc-remind-by"/);
    expect(select).not.toMatch(/\bh-10\b/);
    expect(select).toMatch(/<option value="push"[^>]*>Push<\/option><option value="text"[^>]*>Text<\/option><option value="both"[^>]*>Both<\/option>/);
    expect(select).not.toMatch(/ disabled=""/);
    expect(html).not.toContain("Text timeclock reminders");
  });

  it("the sentence under it says what a push is, what a text is, and the person's own switch", () => {
    const { after } = reminderChoice(renderToStaticMarkup(createElement(SchedulingSettings, { settings, textReady: true })));
    // fix-1190-B (skeptic #91 S5): the push goes to a shift begun that day, and not to one the 12-hour
    // question already asked (eod-reminder pushStillClockedIn), never "everyone still on the clock".
    expect(after).toContain(
      "A push is the \u201cstill clocked in\u201d reminder at 6 PM to everyone still clocked in from a shift that began that day (anyone the 12-hour question already asked isn&#x27;t pushed again).",
    );
    expect(after).not.toContain("everyone still on the clock");
    expect(after).toContain("7 AM");
    expect(after).toContain("the 6 PM text to techs");
    // The 12-hour question's text rides this choice, and the question itself always pushes.
    expect(after).toContain("12-hour");
    expect(after).toContain("that question always comes as a push");
    expect(after).toContain("Each person can turn off clock-out pushes in their own Settings");
  });

  it("nothing stored and the old box on (the default) reads Both; not ready says the texts aren't active yet", () => {
    const html = renderToStaticMarkup(createElement(SchedulingSettings, { settings, textReady: false }));
    const { chosen, after } = reminderChoice(html);
    expect(chosen).toBe("both");
    expect(after).toMatch(/Texts aren(&#x27;|')t active yet: they start once texting is set up\. Pick Push to keep them off\. Settings, Customers, Texting shows/);
    expect(after).not.toMatch(/They start then/);
    expect(after).toMatch(/Settings, Customers, Texting shows what(&#x27;|')s missing\./);
  });

  it("the old box ticked off reads Push; not ready says no texts go out with Push", () => {
    const html = renderToStaticMarkup(
      createElement(SchedulingSettings, { settings: { ...settings, remind_timeclock: false }, textReady: false }),
    );
    const { chosen, after } = reminderChoice(html);
    expect(chosen).toBe("push");
    expect(after).toMatch(/Texting isn(&#x27;|')t set up yet, and with Push no texts go out\. Settings, Customers, Texting shows/);
    expect(after).not.toMatch(/active yet/);
  });

  it("a stored choice is itself (Text), and ready says nothing about texting", () => {
    const html = renderToStaticMarkup(
      createElement(SchedulingSettings, { settings: { ...settings, remind_timeclock: false, remind_timeclock_by: "text" }, textReady: true }),
    );
    const { chosen, after } = reminderChoice(html);
    expect(chosen).toBe("text");
    expect(after).not.toMatch(/active yet|isn(&#x27;|')t set up/);
  });
});

describe("the Texting card", () => {
  it("not ready: says nothing is texted and lists what is missing in plain words", () => {
    const status = smsReadinessFrom({
      env: { account: false, messagingService: false, platformNumber: false },
      orgNumber: "",
      orgName: "ET Electric",
    });
    const html = renderToStaticMarkup(createElement(TextingCard, { status, number: "" }));
    expect(html).toMatch(/Texting isn(&#x27;|')t set up yet, so nothing is texted\./);
    expect(html).toContain("A texting account for the app");
    expect(html).toContain("A texting number for ET Electric");
    expect(html).toContain("Waiting on it:");
    expect(html).not.toMatch(/TWILIO|_SID|Twilio/);
  });

  it("ready: says texting is on and from which number", () => {
    const html = renderToStaticMarkup(
      createElement(TextingCard, { status: { ready: true, sender: "org_number" }, number: "+15305551234" }),
    );
    expect(html).toContain("Texting is on.");
    expect(html).toContain("your business&#x27;s own number");
    expect(html).not.toMatch(/isn(&#x27;|')t one the texting service can use/);
  });

  it("a saved number that isn't a phone number is said to be unusable, with how to write it", () => {
    const html = renderToStaticMarkup(
      createElement(TextingCard, { status: { ready: true, sender: "messaging_service" }, number: "530-555" }),
    );
    expect(html).toMatch(/The number saved here isn(&#x27;|')t one the texting service can use/);
    expect(html).toContain("+15305551234");
  });
});

describe("customer reminders", () => {
  it("say they go by email, the only channel the reminders engine has", () => {
    const html = renderToStaticMarkup(createElement(AutomationSettings, { settings }));
    expect(html).toContain("These go out by email");
    expect(html).not.toMatch(/SMS|Twilio/);
  });
});
