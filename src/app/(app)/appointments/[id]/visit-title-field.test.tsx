import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/** WHAT IS THIS FOR? and the Didn't Happen? doors, rendered (static): the label, the example, no Save button
 *  to hunt for (it saves on blur or Enter), in both languages. */
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/components/toast", () => ({ useToast: () => vi.fn() }));
vi.mock("../actions", () => ({ setAppointmentTitle: vi.fn(), setAppointmentOutcome: vi.fn(), wontHappenAppointment: vi.fn() }));
let LANG = "en";
vi.mock("@/components/lang-provider", () => ({ useLang: () => LANG }));

import { VisitTitleField } from "./visit-title-field";
import { MissedDoors } from "../../inspections/missed-doors";

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

describe("the Didn't Happen? row's two doors", () => {
  it("Didn't Happen and Lost, Title Case, in both languages", () => {
    LANG = "en";
    const en = renderToStaticMarkup(createElement(MissedDoors, { id: "a1" }));
    expect(en).toContain("Didn&#x27;t Happen");
    expect(en).toContain(">Lost<");
    expect(en.match(/<button/g)?.length).toBe(2);
    LANG = "es";
    const es = renderToStaticMarkup(createElement(MissedDoors, { id: "a1" }));
    expect(es).toContain("No Se Hizo");
    expect(es).toContain(">Perdida<");
  });
});
