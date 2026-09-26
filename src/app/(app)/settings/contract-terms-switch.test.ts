import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { getOrgSettings } from "@/lib/org-settings";

/**
 * CONTRACTS & LIEN RIGHTS OFF (the switch board, 0352) in Settings: the default contract terms aren't
 * offered. Save still sends the stored terms back unchanged, and a contract already written keeps
 * the terms it was written with. On, or no switches stored: exactly today's card.
 */
vi.mock("./actions", () => ({ updateOrgSettings: vi.fn() }));
const { DocumentSettings } = await import("./document-settings");

const card = (raw: Record<string, unknown>) => renderToStaticMarkup(createElement(DocumentSettings, { settings: getOrgSettings(raw) }));

describe("the default contract terms and the Contracts switch", () => {
  it("on / not stored: today's card", () => {
    expect(card({ features: { contracts: true } })).toBe(card({}));
    expect(card({})).toContain('id="ds-cterms"');
  });
  it("off: the terms field isn't drawn; everything else on the card is", () => {
    const off = card({ features: { contracts: false } });
    expect(off).not.toContain('id="ds-cterms"');
    for (const id of ["ds-expiry", "ds-due", "ds-deposit", "ds-qterms", "ds-iterms", "ds-footer"]) expect(off).toContain(`id="${id}"`);
  });
});
