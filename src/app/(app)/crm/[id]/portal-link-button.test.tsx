import { describe, it, expect, vi } from "vitest";
import { createElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { translator } from "@/lib/i18n";

/**
 * A CUSTOMER'S OWN PAGE STARTS OFF (cn-v1186, 0419). The owner: "lets set the customer portal to
 * default as OFF and then we can turn it on when needed for who needs it only". So OFF is the
 * ordinary state of the card, not an alarm: "Link is off." in slate, never red; the sentence says
 * to turn it on when this customer needs it; Turn On is the one live door; and no button on an off
 * link is a dead end (See What They See, Copy the Link and Email It to Them wait, each saying
 * "Turn the link on first"). On, the card is what it was. Both languages.
 */
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/crm",
}));
vi.mock("@/components/toast", () => ({ useToast: () => vi.fn() }));
vi.mock("../actions", () => ({
  rotatePortalLink: vi.fn(),
  setPortalEnabled: vi.fn(),
  signOutPortalDevices: vi.fn(),
}));
vi.mock("@/app/(app)/share-actions", () => ({ orgPublicBase: vi.fn(async () => "https://snowbell.example") }));
vi.mock("../../portal-look-actions", () => ({ portalOfficeLookUrl: vi.fn() }));
vi.mock("@/app/(app)/portal-look-actions", () => ({ portalOfficeLookUrl: vi.fn() }));
vi.mock("@/components/portal/open-office-look", () => ({ openOfficeLook: vi.fn() }));
vi.mock("@/components/sent-messages-list", () => ({ SentMessagesList: () => null }));
// The live send door, drawn as a plain enabled button so the test can tell it from the waiting one.
vi.mock("@/components/send-sheet", () => ({
  SendButton: ({ label }: { label: string }) => createElement("button", { type: "button", "data-send": "live" }, label),
}));
vi.mock("@/components/ui/modal", () => ({
  Modal: ({ children, footer }: { children?: ReactNode; footer?: ReactNode }) => createElement("div", null, children, footer),
  ModalActions: () => null,
}));

const { LangProvider } = await import("@/components/lang-provider");
const { PortalLinkButton } = await import("./portal-link-button");

const es = (el: ReactElement) => renderToStaticMarkup(<LangProvider lang="es">{el}</LangProvider>);
const en = (el: ReactElement) => renderToStaticMarkup(el);
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();

/** The <button> whose text contains `label`, as markup. */
function button(html: string, label: string): string | null {
  for (const m of html.matchAll(/<button[^>]*>[\s\S]*?<\/button>/g)) {
    if (text(m[0]).includes(label)) return m[0];
  }
  return null;
}
const isDisabled = (b: string | null) => !!b && /<button[^>]*\sdisabled=""/.test(b);

const off = { token: "tok-1", enabled: false, lastOpenedAt: null, devices: 0 };
const on = { token: "tok-1", enabled: true, lastOpenedAt: null, devices: 0 };
const card = (initial: object) => (
  <PortalLinkButton customerId="c-1" customerName="Sam Tillery" initial={initial as never} hasEmail />
);

describe("an off link is the ordinary state (0419)", () => {
  it("English: 'Link is off.' in slate, never red; the new sentence; Turn On live; See, Copy and Email wait", () => {
    const html = en(card(off));
    expect(html).toContain('<span class="font-medium text-slate-700">Link is off.</span>');
    expect(html).not.toContain("text-red-700");
    expect(text(html)).toContain(
      "Link is off. Turn it on when this customer needs it. Until then the link opens to “This link was turned off.”",
    );
    expect(text(html)).not.toContain("Nothing else shows");
    const turnOn = button(html, "Turn On");
    expect(turnOn).not.toBeNull();
    expect(isDisabled(turnOn)).toBe(false);
    for (const label of ["See What They See", "Copy the Link", "Email It to Them"]) {
      const b = button(html, label);
      expect(b, label).not.toBeNull();
      expect(isDisabled(b), label).toBe(true);
      expect(b, label).toContain('title="Turn the link on first"');
    }
    expect(html).not.toContain('data-send="live"');
  });

  it("Spanish: the same, in tú, quoting the customer's sentence as it is", () => {
    const html = es(card(off));
    const t = translator("es");
    expect(html).toContain('<span class="font-medium text-slate-700">El enlace está desactivado.</span>');
    expect(text(html)).toContain(
      "El enlace está desactivado. Actívalo cuando este cliente lo necesite. Hasta entonces el enlace se abre con “This link was turned off.”",
    );
    expect(isDisabled(button(html, t("cu_btn_turnOn")))).toBe(false);
    for (const k of ["cu_btn_seeWhatTheySee", "cu_btn_copyTheLink", "cu_btn_emailItToThem"]) {
      const b = button(html, t(k));
      expect(isDisabled(b), k).toBe(true);
      expect(b, k).toContain('title="Primero activa el enlace"');
    }
  });

  it("the words said on Turn On drop 'again', and its title is true of a link that was never on", () => {
    expect(translator("en")("cu_turnedOn")).toBe("Turned on. Their link works; each device asks for a code from their email.");
    expect(translator("es")("cu_turnedOn")).toBe("Activado. Su enlace funciona; cada dispositivo pide un código de su correo.");
    expect(translator("en")("cu_turnOnTitle")).not.toMatch(/again/i);
    expect(translator("es")("cu_turnOnTitle")).not.toMatch(/vuelve/i);
  });
});

describe("an on link is the card it was", () => {
  it("See What They See and Copy the Link are live, Email is the send door, Turn Off is offered", () => {
    const html = en(card(on));
    expect(html).toContain('<span class="font-medium text-emerald-700">Link is on.</span>');
    expect(isDisabled(button(html, "See What They See"))).toBe(false);
    expect(button(html, "See What They See")).toContain('title="Open it exactly as the customer sees it"');
    expect(isDisabled(button(html, "Copy the Link"))).toBe(false);
    expect(html).toContain('data-send="live"');
    expect(button(html, "Turn Off")).not.toBeNull();
  });
});

/**
 * NEW LINK NEVER TURNS THE PAGE ON BY THE BACK DOOR (cn-v1186, skeptic S5): the database's rotate sets
 * enabled = true, so New Link on an off link quietly opened the customer's page. Off, Turn On is the
 * door and New Link is not drawn; on, New Link is offered as it was.
 */
describe("New Link only while the link is on", () => {
  it("off: Turn On is drawn and New Link is not, in both languages", () => {
    const html = en(card(off));
    expect(button(html, "Turn On")).not.toBeNull();
    expect(button(html, "New Link")).toBeNull();
    const t = translator("es");
    const esHtml = es(card(off));
    expect(button(esHtml, t("cu_btn_turnOn"))).not.toBeNull();
    expect(button(esHtml, t("cu_btn_newLink"))).toBeNull();
  });

  it("on: New Link is drawn and live", () => {
    const html = en(card(on));
    expect(button(html, "New Link")).not.toBeNull();
    expect(isDisabled(button(html, "New Link"))).toBe(false);
  });
});
