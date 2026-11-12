import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/** WHAT IS THIS FOR? and an inspection row's ⋯ doors, rendered (static): the label, the example, no Save button
 *  to hunt for (it saves on blur or Enter), in both languages. */
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/components/toast", () => ({ useToast: () => vi.fn() }));
vi.mock("@/components/use-org-public-base", () => ({ useOrgPublicBase: () => "" }));
vi.mock("../../schedule/actions", () => ({ moveJobDay: vi.fn() }));
vi.mock("../actions", () => ({
  setAppointmentTitle: vi.fn(),
  setAppointmentOutcome: vi.fn(),
  wontHappenAppointment: vi.fn(),
  setAppointmentStatus: vi.fn(),
  rescheduleAppointment: vi.fn(),
  createAppointment: vi.fn(),
  updateAppointment: vi.fn(),
  deleteAppointment: vi.fn(),
  createJobFromAppointment: vi.fn(),
  createAppointmentProposal: vi.fn(),
}));
let LANG = "en";
vi.mock("@/components/lang-provider", () => ({ useLang: () => LANG }));

import { VisitTitleField } from "./visit-title-field";
import { InspectionRowMenuView } from "../../inspections/inspection-row-menu";

describe("the untitled visit's one field", () => {
  it("asks What Is This For? with an example placeholder and one text input", () => {
    LANG = "en";
    const s = renderToStaticMarkup(createElement(VisitTitleField, { appointmentId: "a1" }));
    expect(s).toContain("What Is This For?");
    expect(s).toContain('placeholder="e.g. Panel upgrade');
    expect(s.match(/<input/g)?.length).toBe(1);
    expect(s).not.toContain("<button");
  });
  it("says it in Spanish", () => {
    LANG = "es";
    const s = renderToStaticMarkup(createElement(VisitTitleField, { appointmentId: "a1" }));
    expect(s).toContain("¿Para Qué Es?");
    expect(s).toContain('placeholder="p. ej. Cambio de panel');
  });
});

describe("a Didn't Happen? row's ⋯ doors", () => {
  const noop = () => {};
  const rows = () =>
    renderToStaticMarkup(
      createElement(InspectionRowMenuView, {
        doors: ["move", "happened", "lost", "del"],
        asking: false,
        pending: false,
        onPickDay: async () => ({ ok: true }),
        onHappened: noop,
        onLost: noop,
        onAsk: noop,
        onDelete: noop,
        onKeep: noop,
      }),
    );
  it("Move to Another Day…, It Happened: Write It Up, Lost and Delete…, Title Case, in both languages", () => {
    LANG = "en";
    const en = rows();
    expect(en).toContain(">Move to Another Day…<");
    expect(en).toContain(">It Happened: Write It Up<");
    expect(en).toContain(">Lost<");
    expect(en).toContain(">Delete…<");
    expect(en.match(/<button/g)?.length).toBe(4);
    LANG = "es";
    const es = rows();
    expect(es).toContain(">Mover a Otro Día…<");
    expect(es).toContain(">Sí Se Hizo: Redactarla<");
    expect(es).toContain(">Perdida<");
    expect(es).toContain(">Eliminar…<");
  });
});
