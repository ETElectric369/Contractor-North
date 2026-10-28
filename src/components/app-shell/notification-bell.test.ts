import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * THE BELL IN THE PERSON'S LANGUAGE (cn-v1138): its button, its heading, Mark All Read, the empty
 * line and the failed line come through the shell's catalog; the lines it lists were written in
 * the person's language when they were sent. English is what it was, byte for byte.
 *
 * Rendered OPEN: the panel opens on a tap, which a static render can't make, so the fifth
 * useState (open — after items, unread, more, failed) starts true here. Nothing else is replaced.
 */
const rt = vi.hoisted(() => ({ n: 0 }));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (init: unknown) => {
      rt.n += 1;
      return actual.useState(rt.n === 5 && init === false ? true : init);
    },
  };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/components/toast", () => ({ ToastProvider: ({ children }: { children: unknown }) => children, useToast: () => vi.fn() }));
vi.mock("@/app/(app)/notification-actions", () => ({
  getMyBell: vi.fn(() => new Promise(() => {})),
  markNotificationsRead: vi.fn(async () => ({ ok: true })),
}));

import { NotificationBell } from "./notification-bell";
import { LangProvider } from "@/components/lang-provider";
import type { Lang } from "@/lib/i18n";

const render = (lang: Lang) => {
  rt.n = 0;
  return renderToStaticMarkup(createElement(LangProvider, { lang, children: createElement(NotificationBell) }));
};

describe("NotificationBell", () => {
  it("English: the button, the heading and the empty line, as before", () => {
    const html = render("en");
    expect(html).toMatch(/<button[^>]*aria-label="Notifications"[^>]*title="Notifications"/);
    expect(html).toContain(">Notifications</span>");
    expect(html).toContain("You&#x27;re all caught up.");
  });

  it("Spanish: the same button, heading and empty line in the tech's words", () => {
    const html = render("es");
    expect(html).toMatch(/<button[^>]*aria-label="Notificaciones"[^>]*title="Notificaciones"/);
    expect(html).toContain(">Notificaciones</span>");
    expect(html).toContain("Estás al día.");
    expect(html).not.toContain("caught up");
    expect(html).not.toContain("Notifications");
  });
});
