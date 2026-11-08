import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * SEND WITHOUT REVIEW (cn-v1155): the one switch that decides whether Email It and Text It open the
 * review sheet (off, the default) or send at once with today's words (on). It sits with the other
 * switches that gate customer email.
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("./actions", () => ({ updateOrgSettings: vi.fn(async () => ({ ok: true })) }));

import { AutomationSettings } from "./automation-settings";
import { getOrgSettings, DEFAULT_SETTINGS } from "@/lib/org-settings";

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/\s+/g, " ");

describe("Send Without Review", () => {
  it("is off by default, and a stored true reads back true", () => {
    expect(DEFAULT_SETTINGS.send_without_review).toBe(false);
    expect(getOrgSettings({}).send_without_review).toBe(false);
    expect(getOrgSettings({ send_without_review: true }).send_without_review).toBe(true);
  });

  it("has its row, with the label and the sentence", () => {
    const html = renderToStaticMarkup(createElement(AutomationSettings, { settings: getOrgSettings({}) }));
    const words = text(html);
    expect(words).toContain("Send Without Review");
    expect(words).toContain(
      "On, Email It and Text It send at once with today's words. Off, you see the address, the subject and the message first and can change them for that send.",
    );
  });
});
