import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * THE OFF LINE (0352): a record in a switched-off feature still opens, with this on top. The owner
 * gets a 44px Turn On; anyone else is told to ask the owner and gets no button (a button that can't
 * work for them would be a dead door). Nothing renders while the feature is on.
 */
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/app/(app)/settings/features-actions", () => ({ setFeature: vi.fn(async () => ({ ok: true })) }));

import { FeatureOffLine } from "./feature-off-line";
import { ALL_ON } from "@/lib/features";

const render = (props: Parameters<typeof FeatureOffLine>[0]) => renderToStaticMarkup(createElement(FeatureOffLine, props));

describe("FeatureOffLine", () => {
  it("renders nothing while the feature is on", () => {
    expect(render({ feature: "panel_map", features: ALL_ON, isOwner: true })).toBe("");
    expect(render({ feature: "panel_map", features: ALL_ON, isOwner: false })).toBe("");
  });

  it("the owner: 'Off' with a 44px Turn On", () => {
    const html = render({ feature: "panel_map", features: { ...ALL_ON, panel_map: false }, isOwner: true });
    expect(html).toContain("Panel Map");
    expect(html).toContain(" · Off");
    expect(html).not.toContain("Ask The Owner");
    const button = html.match(/<button[^>]*>[^<]*<\/button>/)![0];
    expect(button).toContain(">Turn On<");
    expect(button).toMatch(/\bh-11\b/);
  });

  it("everyone else: 'Off · Ask The Owner', and no button", () => {
    const html = render({ feature: "panel_map", features: { ...ALL_ON, panel_map: false }, isOwner: false });
    expect(html).toContain(" · Off");
    expect(html).toContain(" · Ask The Owner");
    expect(html).not.toContain("<button");
  });

  it("a sub-switch is off while its parent is off, and says so", () => {
    const html = render({ feature: "site_chat", features: { ...ALL_ON, website: false }, isOwner: true });
    expect(html).toContain("Site Chat");
    expect(html).toContain(">Turn On<");
  });
});
