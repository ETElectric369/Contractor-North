import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { UsageRing } from "./usage-ring";

/**
 * THE USAGE RING (cn-v1140): one SVG with a track and a fill whose offset follows the percent, the
 * percent inside as the one number, a meter role with its label from the catalog, a stroke color
 * by state (the accent, amber, orange, red — with dark variants), the one motion-safe transition,
 * a degraded meter drawn as "—" with no value, and never a count or a dollar.
 */
const render = (props: Parameters<typeof UsageRing>[0]) => renderToStaticMarkup(createElement(UsageRing, props));
const CIRC = 2 * Math.PI * 44;

describe("UsageRing", () => {
  it("fine: the accent stroke, the percent inside, a meter with its English label, 96px by default", () => {
    const html = render({ pct: 40, state: "fine" });
    expect(html).toContain('role="meter"');
    expect(html).toContain('aria-valuemin="0"');
    expect(html).toContain('aria-valuemax="100"');
    expect(html).toContain('aria-valuenow="40"');
    expect(html).toContain('aria-label="Usage: 40% of this month"');
    expect(html).toContain('width="96"');
    expect(html).toContain('height="96"');
    expect(html).toContain('data-state="fine"');
    expect(html).toContain("stroke-[rgb(var(--glass-tint))] dark:stroke-teal-400");
    expect(html).toContain("stroke-slate-200 dark:stroke-slate-700"); // the track
    expect(html).toContain(">40%</text>");
    expect(html).toContain(`stroke-dashoffset="${CIRC * 0.6}"`);
    expect(html).toContain('stroke-linecap="round"');
    expect(html).toContain("motion-safe:transition-[stroke-dashoffset] motion-safe:duration-500");
    expect((html.match(/<circle/g) ?? []).length).toBe(2);
  });

  it("watch is amber, almost is orange, out is red — each with a dark variant, and the ink follows", () => {
    expect(render({ pct: 80, state: "watch" })).toContain("stroke-amber-500 dark:stroke-amber-400");
    expect(render({ pct: 80, state: "watch" })).toContain("text-amber-700 dark:text-amber-300");
    expect(render({ pct: 92, state: "almost" })).toContain("stroke-orange-500 dark:stroke-orange-400");
    expect(render({ pct: 100, state: "out" })).toContain("stroke-red-600 dark:stroke-red-500");
    expect(render({ pct: 100, state: "out" })).toContain("text-red-700 dark:text-red-300");
  });

  it("100% is a full ring (offset 0); 0% draws no fill and no round dot; anything past the ends is clamped and rounded", () => {
    expect(render({ pct: 100, state: "out" })).toContain('stroke-dashoffset="0"');
    const empty = render({ pct: 0, state: "fine" });
    expect(empty).toContain(`stroke-dashoffset="${CIRC}"`);
    expect(empty).toContain('stroke-linecap="butt"');
    expect(empty).toContain(">0%</text>");
    expect(render({ pct: 140, state: "out" })).toContain('aria-valuenow="100"');
    expect(render({ pct: -5, state: "fine" })).toContain('aria-valuenow="0"');
    expect(render({ pct: 33.4, state: "fine" })).toContain(">33%</text>");
    expect(render({ pct: Number.NaN, state: "fine" })).toContain(">0%</text>");
  });

  it("degraded (the meter could not be read): — inside, an empty track, no aria-valuenow, the headline as the label", () => {
    const html = render({ pct: 0, state: "fine", degraded: true });
    expect(html).toContain('role="meter"');
    expect(html).not.toContain("aria-valuenow");
    expect(html).toContain('aria-label="Usage"');
    expect(html).toContain('data-degraded="true"');
    expect(html).toContain(">—</text>");
    expect(html).not.toContain("%");
    expect(html).toContain(`stroke-dashoffset="${CIRC}"`);
    expect(html).toContain('stroke-linecap="butt"');
    // Whatever percent rode along with it is not drawn: a number nobody read is not a number.
    expect(render({ pct: 40, state: "fine", degraded: true })).toContain(">—</text>");
    expect(render({ pct: 40, state: "fine", degraded: true })).not.toContain(">40%");
    expect(render({ pct: 40, state: "fine", degraded: true })).not.toContain('aria-valuenow="40"');
    expect(render({ pct: 0, state: "fine", degraded: true, lang: "es" })).toContain('aria-label="Uso"');
    // Not degraded: the value and the percent as before.
    expect(render({ pct: 0, state: "fine", degraded: false })).toContain('aria-valuenow="0"');
    expect(render({ pct: 0, state: "fine" })).not.toContain("data-degraded");
  });

  it("Spanish: the label from the catalog", () => {
    expect(render({ pct: 55, state: "watch", lang: "es" })).toContain('aria-label="Uso: 55% de este mes"');
  });

  it("size and className are honored", () => {
    const html = render({ pct: 10, state: "fine", size: 64, className: "mx-auto" });
    expect(html).toContain('width="64"');
    expect(html).toContain('height="64"');
    expect(html).toContain('class="shrink-0 mx-auto"');
  });

  it("never a count, never a dollar, never a unit: the percent is the one number", () => {
    for (const state of ["fine", "watch", "almost", "out"] as const) {
      const text = render({ pct: 73, state }).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      expect(text).toBe("73%");
      expect(render({ pct: 73, state })).not.toMatch(/\$|estimate|token|credit/i);
    }
  });
});
