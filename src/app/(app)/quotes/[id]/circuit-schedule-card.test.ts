import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * THE ESTIMATE'S CIRCUIT CARD READS IN TITLE CASE (Panel plan, phase 0; Erik's law 2026-08-29:
 * every clickable is Title Case). Its heading, Generate From Line Items and Add Circuit; and the
 * remove control is a 44px target, not the bare 16px trash icon the app has been retiring.
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {}, push: () => {} }) }));
vi.mock("../actions", () => ({ generateCircuitSchedule: vi.fn(), saveCircuitSchedule: vi.fn() }));

import { CircuitScheduleCard } from "./circuit-schedule-card";

const buttons = (html: string) =>
  [...html.matchAll(/<button[^>]*>[\s\S]*?<\/button>/g)].map((m) => ({
    markup: m[0],
    text: m[0].replace(/<[^>]+>/g, "").trim(),
  }));

describe("the estimate's Circuit Schedule card", () => {
  it("says Circuit Schedule and Generate From Line Items when it is empty", () => {
    const html = renderToStaticMarkup(createElement(CircuitScheduleCard, { quoteId: "q1", initial: [] }));
    expect(html).toContain("Circuit Schedule");
    const labels = buttons(html).map((b) => b.text);
    expect(labels).toContain("Generate From Line Items");
    expect(labels).toContain("Add Circuit");
    expect(html).not.toContain("Generate from Line Items");
  });

  it("gives each circuit a 44px Remove Circuit target and 44px buttons", () => {
    const html = renderToStaticMarkup(
      createElement(CircuitScheduleCard, {
        quoteId: "q1",
        initial: [{ ckt: "1", description: "Kitchen small-appliance #1", wire: "12/2", breaker: "20A", load: "Countertop" }],
      }),
    );
    const remove = buttons(html).find((b) => b.markup.includes('aria-label="Remove Circuit"'));
    expect(remove?.markup).toContain("h-11 w-11");
    for (const b of buttons(html).filter((x) => x.text)) expect(b.markup).toMatch(/h-11/);
    expect(buttons(html).map((b) => b.text)).toContain("Regenerate");
  });

  it("once a job keeps its own list, says this is the proposal and links the job's Panel tab (phase 2)", () => {
    const initial = [{ ckt: "1", description: "Kitchen small-appliance #1", wire: "12/2", breaker: "20A", load: null }];
    const none = renderToStaticMarkup(createElement(CircuitScheduleCard, { quoteId: "q1", initial }));
    expect(none).not.toContain("This Is The Proposal");
    const html = renderToStaticMarkup(
      createElement(CircuitScheduleCard, { quoteId: "q1", initial, panelJob: { id: "j11", label: "J-011 13897 Herringbone" } }),
    );
    expect(html).toContain("This Is The Proposal. The Job Keeps Its Own List On The Panel Tab.");
    const link = /<a[^>]*href="\/jobs\/j11\?tab=panel"[^>]*>([\s\S]*?)<\/a>/.exec(html);
    expect(link?.[0]).toContain("min-h-[44px]");
    expect(link?.[1].replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'")).toBe("Open J-011 13897 Herringbone's Panel ");
  });
});
