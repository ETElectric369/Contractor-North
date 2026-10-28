import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dict } from "@/lib/i18n";

/**
 * A TECH PUT ON A VISIT IS TOLD IN HIS OWN LANGUAGE (cn-v1138, skeptic #44 B2). Both doors that assign a
 * visit — the booking form and the reassign action — used to hand notifyPeople a literal
 * "New appointment assigned"; now each hands it the function form, so the bell line and the push are
 * written per reader (nb_apptAssignedTitle). The body stays the visit's own title, as typed.
 */
describe("the two appointment-assigned notifies", () => {
  const src = readFileSync(join(process.cwd(), "src/app/(app)/appointments/actions.ts"), "utf8");
  it("use the function form with the catalog's title, and no literal is left", () => {
    expect(src).toContain('after(() => notifyPeople(orgId, [assignedTo], "assigned", (lang) => ({');
    expect(src).toContain('title: translator(lang)("nb_apptAssignedTitle"),');
    expect(src).toContain('after(() => notifyPeople(orgId, [who], "assigned", (lang) => ({ title: translator(lang)("nb_apptAssignedTitle"), body: title, url: `/appointments/${id}` })));');
    expect(src).not.toContain('"New appointment assigned"');
    expect(src).toContain('import { translator } from "@/lib/i18n";');
  });
  it("the title is the English it always was, and Spanish for a Spanish tech", () => {
    expect(dict("en").nb_apptAssignedTitle).toBe("New appointment assigned");
    expect(dict("es").nb_apptAssignedTitle).toBe("Nueva cita asignada");
  });
});
