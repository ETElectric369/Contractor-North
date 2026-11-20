import { describe, it, expect } from "vitest";
import { CATALOGS, dict } from "@/lib/i18n";
import { resolveRowVerb } from "@/lib/action-items/dispatch-map";
import { rowButtons } from "@/lib/action-items/row-buttons";
import type { ActionItem } from "@/lib/action-items/types";

/**
 * ONE NAME FOR ONE DOOR (the owner, 2026-11-16, cn-v1166): "i really dont like this term we are using
 * everywhere "Won't Happen" and then its next to Lost on some spots ... is it the same as "Dismiss"
 * and handled the same way and if so lets change it everywhere".
 *
 * The door that ends a visit that isn't going ahead (wontHappenAppointment: deleted when nothing hangs
 * on it, otherwise cancelled and kept on file) is Dismiss / Descartar on every screen: the visit page's
 * ⋯, the Schedule, Needs You's ⋯ and the Inspections row's ⋯ (Dismiss…, its neighbours carry the
 * ellipsis). Lost is a different answer (the visit happened, the work was not won) and keeps its name.
 * The key NAMES stayed (ids are never shown); only the words changed.
 */
const DOOR_KEYS = ["vp_btn_wontHappen", "ag_rail_btn_wontHappen", "ny_btn_didntHappen", "ip_btn_deleteIt"] as const;
// The Inspections tile "Didn't Happen?" was the one question let through here; it went with the tiles
// (cn-v1171), and its row says Day Passed, so no value is let through now.

describe("one name for the visit's Dismiss", () => {
  it("the four door keys say Dismiss in English and Descartar in Spanish; the Inspections row says it with its ellipsis", () => {
    for (const k of DOOR_KEYS) {
      expect(dict("en")[k], k).toBe("Dismiss");
      expect(dict("es")[k], k).toBe("Descartar");
    }
    expect(dict("en").ip_btn_delete).toBe("Dismiss…");
    expect(dict("es").ip_btn_delete).toBe("Descartar…");
  });

  it("the Schedule's ask and the Inspections row's ask are one sentence", () => {
    for (const lang of ["en", "es"] as const) expect(dict(lang).ag_rail_wontHappenAsk).toBe(dict(lang).ip_deleteAsk);
    expect(dict("en").ip_deleteAsk.startsWith("Dismiss this visit?")).toBe(true);
    expect(dict("es").ip_deleteAsk.startsWith("¿Descartar esta visita?")).toBe(true);
  });

  it("no catalog value in either language still says the old names", () => {
    const old = /Won't Happen|Won’t Happen|Didn't Happen|Didn’t Happen|No Se Hará|No Se Hizo|won't happen\?|no se hará\?/i;
    const said: string[] = [];
    for (const c of CATALOGS)
      for (const lang of ["en", "es"] as const)
        for (const [k, v] of Object.entries(c[lang] as Record<string, string>)) {
          if (typeof v === "string" && old.test(v)) said.push(`${lang} ${k}: ${v}`);
        }
    expect(said).toEqual([]);
    expect(dict("en").ip_btn_tileMissed).toBeUndefined();
  });

  it("every visit Dismiss in Needs You runs the one deed, appointment.wontHappen", () => {
    expect(resolveRowVerb("appointment", "dismiss", "appt-1")).toEqual({ name: "appointment.wontHappen", input: { id: "appt-1" } });
    expect(resolveRowVerb("inspection_writeup", "wontHappen", "appt-1")).toEqual({ name: "appointment.wontHappen", input: { id: "appt-1" } });
    // Lost stays Lost: the inspection row's other ending records the outcome, it never ends the visit.
    expect(resolveRowVerb("inspection_writeup", "dismiss", "appt-1")).toEqual({ name: "appointment.setOutcome", input: { id: "appt-1", outcome: "lost" } });
    // And every row door labelled Dismiss sends one of those two verbs.
    const row = (kind: ActionItem["kind"], affordances: ActionItem["affordances"]) =>
      ({ id: "appt-1", kind, title: "Inspection", subtitle: null, when: null, urgency: 0, done: false, href: "/appointments/appt-1", affordances }) as unknown as ActionItem;
    for (const item of [row("appointment", ["do", "dismiss", "open"]), row("inspection_writeup", ["dismiss", "wontHappen", "open"])]) {
      const door = rowButtons(item, { isStaff: true }).more.find((d) => d.label === "Dismiss");
      expect(door, item.kind).toBeTruthy();
      if (door?.act.type !== "confirm") throw new Error("Dismiss asks first");
      expect(resolveRowVerb(item.kind, door.act.verb, item.id)?.name).toBe("appointment.wontHappen");
    }
  });
});
