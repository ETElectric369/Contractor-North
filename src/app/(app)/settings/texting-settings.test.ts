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

/** The timeclock reminder's checkbox: its attributes, and the words after it. */
function reminderBox(html: string) {
  const at = html.indexOf("Text timeclock reminders");
  const input = html.slice(html.lastIndexOf("<input", at), at);
  return { input, after: html.slice(at, at + 600) };
}

describe("the timeclock reminder option", () => {
  it("not ready: shown unticked and not active, with the one line", () => {
    const html = renderToStaticMarkup(createElement(SchedulingSettings, { settings, textReady: false }));
    const { input, after } = reminderBox(html);
    expect(input).toMatch(/ disabled=""/);
    expect(input).not.toMatch(/ checked=""/);
    expect(after).toMatch(/Not active\. Texts start once texting is set up\. Settings, Customers, Texting shows what(&#x27;|')s missing\./);
  });

  it("ready: the stored choice shows, and it can be changed", () => {
    const html = renderToStaticMarkup(createElement(SchedulingSettings, { settings, textReady: true }));
    const { input, after } = reminderBox(html);
    expect(input).toMatch(/ checked=""/);
    expect(input).not.toMatch(/ disabled=""/);
    expect(after).not.toMatch(/Not active/);
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
  });
});

describe("customer reminders", () => {
  it("say they go by email, the only channel the reminders engine has", () => {
    const html = renderToStaticMarkup(createElement(AutomationSettings, { settings }));
    expect(html).toContain("These go out by email");
    expect(html).not.toMatch(/SMS|Twilio/);
  });
});
