import { describe, expect, it } from "vitest";
import { safeInternalHref, sanitizeHudCard } from "@/lib/assistant-protocol";

/**
 * show_card's `href` (and every rows[].href) is MODEL-authored and the model reads customer-
 * controlled text, so an off-origin URL here would render a tappable next/link to an attacker's
 * page inside the PWA — where standalone display shows no address bar. Only internal absolute paths
 * may survive; everything else must drop to no-link. This pins that boundary (server + render both).
 */
describe("safeInternalHref — HUD card link guard", () => {
  it("accepts same-app absolute paths", () => {
    expect(safeInternalHref("/jobs/abc")).toBe("/jobs/abc");
    expect(safeInternalHref("/crm/123?tab=x")).toBe("/crm/123?tab=x");
    expect(safeInternalHref("  /invoices/9  ")).toBe("/invoices/9");
  });

  it("rejects every off-origin / trick form → null (consumer renders plain text)", () => {
    expect(safeInternalHref("https://et-electric-billing.com/pay")).toBeNull();
    expect(safeInternalHref("http://evil.com")).toBeNull();
    expect(safeInternalHref("//evil.com")).toBeNull();
    expect(safeInternalHref("/\\evil.com")).toBeNull();
    expect(safeInternalHref("javascript:alert(1)")).toBeNull();
    expect(safeInternalHref("mailto:x@y.com")).toBeNull();
    expect(safeInternalHref("tel:5551234")).toBeNull();
    expect(safeInternalHref("jobs/abc")).toBeNull(); // relative, no leading slash
    expect(safeInternalHref("")).toBeNull();
    expect(safeInternalHref(null)).toBeNull();
    expect(safeInternalHref(42)).toBeNull();
  });
});

describe("sanitizeHudCard — strips unsafe hrefs, preserves everything else", () => {
  it("drops an off-origin card href but keeps the rest of the card", () => {
    const out = sanitizeHudCard({
      kind: "customer",
      title: "R. Smith",
      scope: "panel upgrade",
      href: "https://et-electric-billing.com/pay",
    });
    expect(out.href).toBeUndefined();
    expect(out.title).toBe("R. Smith");
    expect(out.scope).toBe("panel upgrade");
    expect(out.kind).toBe("customer");
  });

  it("keeps a safe internal card href", () => {
    const out = sanitizeHudCard({ kind: "job", title: "J-12", href: "/jobs/j-12" });
    expect(out.href).toBe("/jobs/j-12");
  });

  it("sanitizes each row href independently", () => {
    const out = sanitizeHudCard({
      kind: "list",
      title: "3 jobs",
      rows: [
        { label: "A", href: "/jobs/a" },
        { label: "B", href: "https://evil.com" },
        { label: "C" },
      ],
    });
    expect(out.rows?.[0].href).toBe("/jobs/a");
    expect(out.rows?.[1].href).toBeUndefined();
    expect(out.rows?.[1].label).toBe("B"); // row content survives, only the link is dropped
    expect(out.rows?.[2].href).toBeUndefined();
  });

  it("tolerates junk input without throwing", () => {
    expect(() => sanitizeHudCard(null)).not.toThrow();
    expect(() => sanitizeHudCard(undefined)).not.toThrow();
    expect(sanitizeHudCard({}).href).toBeUndefined();
  });
});
