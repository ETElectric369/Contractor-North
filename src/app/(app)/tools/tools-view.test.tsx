import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ToolsView } from "./tools-view";

/**
 * THE TOOLS PAGE OPENS ON THE TRADE'S PACKAGES (cn-v1135): the registry's `calculators`
 * (lib/trade-package calculatorPackagesFor), not a `trade === "electrical"` of this file's own. And the
 * conduit bender is an electrician's tool: it sat in Field, so a deck builder opened on it.
 */
const html = (trade: string) => renderToStaticMarkup(createElement(ToolsView, { trade }));

describe("ToolsView", () => {
  it("a deck builder opens without the electrical package, the conduit bender included", () => {
    const h = html("deck");
    expect(h).toContain("Board feet");
    expect(h).toContain("Markup");
    expect(h).toContain("Right triangle");
    expect(h).not.toContain("Wire size picker");
    expect(h).not.toContain("Conduit offset");
    expect(h).toContain("Show Every Tool (+11)");
  });

  it("an electrician opens on all four packages", () => {
    const h = html("electrical");
    expect(h).toContain("Wire size picker");
    expect(h).toContain("Conduit offset");
    expect(h).toContain("Board feet");
    expect(h).not.toContain("Show Every Tool");
  });

  it("no trade known opens on the universal three", () => {
    const h = html("");
    expect(h).not.toContain("Wire size picker");
    expect(h).toContain("Board feet");
  });
});
