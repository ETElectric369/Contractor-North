import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * THE PHONE SETUP CHECKLIST IN THE PERSON'S LANGUAGE (cn-v1138). The Handbook page hands over
 * profiles.language; the three steps, their lines and the iPhone paths come through the shell's
 * catalog, the paths being what a Spanish iPhone's own Settings say. English is what it was.
 */
const ua = vi.hoisted(() => ({ value: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)" }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "user-agent": ua.value }) }));

import { PhoneSetupChecklist } from "./phone-setup-checklist";

const render = async (lang: string | null, shell = false) => {
  ua.value = shell ? "Mozilla/5.0 (iPhone) CNShell/3 (iOS)" : "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)";
  return renderToStaticMarkup(await PhoneSetupChecklist({ lang }));
};
/** The visible words; a bold span inside a sentence is part of the sentence, every other tag a break. */
const text = (html: string) =>
  html.replace(/<span class="font-medium">([^<]*)<\/span>/g, "$1").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").replace(/&amp;/g, "&").trim();

describe("PhoneSetupChecklist", () => {
  it("English, in a browser: the three steps and the Safari Websites path, as before", async () => {
    const html = await render("en");
    const words = text(html);
    expect(words).toContain("Set up your phone for North");
    expect(words).toContain("Add North to your home screen");
    expect(words).toContain("Open the site in Safari → tap the Share button → Add to Home Screen. Now it opens like an app.");
    expect(html).toContain('<span class="font-medium">Add to Home Screen</span>');
    expect(words).toContain("Settings → Privacy & Security → Location Services → Safari Websites → “While Using the App.”");
    expect(words).toContain("Look for “Safari Websites,” NOT “North”");
    expect(words).toContain("Allow Notifications");
    expect(words).toContain("When North asks, tap Allow — schedule reminders and clock-out prompts come through here.");
    expect(words).toContain("Android: it’s the same idea");
  });

  it("English, inside the shell: no home-screen step, the app's own Location entry, no Android line", async () => {
    const words = text(await render(null, true));
    expect(words).not.toContain("Add North to your home screen");
    expect(words).toContain("Settings → Privacy & Security → Location Services → North → “Always.”");
    expect(words).toContain("the clock-out question when you leave a job site");
    expect(words).not.toContain("Android");
  });

  it("Spanish: the steps in the tech's words, and the paths a Spanish iPhone's Settings really say", async () => {
    const html = await render("es");
    const words = text(html);
    expect(words).toContain("Configura tu teléfono para North");
    expect(words).toContain("Agrega North a tu pantalla de inicio");
    expect(html).toContain('<span class="font-medium">Agregar a pantalla de inicio</span>');
    expect(words).toContain("Configuración → Privacidad y seguridad → Localización → Sitios web de Safari → “Al usar la app”.");
    expect(words).toContain("Permite las Notificaciones");
    expect(words).toContain("toca Permitir");
    for (const en of ["Set up your phone", "Add to Home Screen", "Location Services", "Allow Notifications"]) expect(words).not.toContain(en);
    const shell = text(await render("es", true));
    expect(shell).toContain("Configuración → Privacidad y seguridad → Localización → North → “Siempre”.");
    expect(shell).not.toContain("Android");
  });
});
