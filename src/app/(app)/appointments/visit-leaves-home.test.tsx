import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A VISIT REMOVED FROM UNDER ITS OWN PAGE: THE PAGE IS LEFT AT ONCE, FOR WHERE THE VISIT LIVES.
 *
 * Erik, 2026-11-10, on the desktop: "check how i deleted a couple inspections and instead of going
 * back to the inspection page it goes to" the app's 404 ("We couldn't find that page").
 *
 * THE MECHANISM, as the code has it. Both delete doors call a server action that revalidates
 * (wontHappenAppointment, deleteAppointment). Any revalidatePath in an action makes Next render the
 * page the action was sent from into the action's own answer; that page is /appointments/<id>, its
 * row is gone, and it answers notFound(). No not-found page lived inside the shell then, so the root
 * one replaced the dock, the sub-nav and the toast provider. (The visit has its own boundary since
 * skeptic #60, [id]/not-found.tsx, for the Back that still reaches a deleted visit: the delete's
 * replace takes the SHEET's history entry, and the visit's own stays under it. [id]/not-found.test.)
 * Whether that render is ever APPLIED turns on what the client does in the tick the answer arrives:
 *
 *   · ⋯ › Won't Happen went router.back(): the browser's history, which puts nothing on Next's
 *     queue, so the dead page was applied and the Back raced it.
 *   · ⋯ › Edit Details… › Delete closed its sheet and THEN pushed. Closing a Modal takes its history
 *     entry off with a history step; that popstate reaches Next as a Back, which takes priority over
 *     the push still in flight and drops it. The push had already taken the action's place on the
 *     queue, so Next owed the page a refresh: of the deleted visit. notFound(), for good.
 *
 * A navigation sent in that tick, with nothing closing under it, takes priority over the action and
 * its re-render is thrown away: the way a job, an estimate or an invoice already leaves. The router
 * rule itself is RUN, on Next's own queue, in tests/next-router-queue.test.ts (the two old doors and
 * the new way). Here: pins on the doors' source (the unit project has no DOM, no router and no history)
 * plus the list door's two faces, rendered.
 */
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }) }));
vi.mock("@/components/toast", () => ({ useToast: () => vi.fn() }));
vi.mock("@/components/use-org-public-base", () => ({ useOrgPublicBase: () => "" }));
vi.mock("../schedule/actions", () => ({ moveJobDay: vi.fn() }));
vi.mock("./actions", () => ({
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

const { LangProvider } = await import("@/components/lang-provider");
const { InspectionRowMenu, InspectionRowMenuView } = await import("../inspections/inspection-row-menu");

const src = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");
const decode = (s: string) => s.replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const text = (html: string) => decode(html.replace(/<[^>]+>/g, " "));
const buttons = (html: string) => [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((m) => decode(m[1]));

describe("⋯ › Won't Happen leaves for the visit's home in the tick the server answers", () => {
  const rows = src("src/app/(app)/appointments/[id]/visit-header-actions.tsx");
  const row = rows.slice(rows.indexOf("export function WontHappenRow"));

  it("deleted: the toast, then the page is REPLACED (no entry for Back to land on a page that is gone)", () => {
    expect(row).toMatch(/toast\(wontHappenToast\("deleted", null, lang, t\), "success"\);\s*router\.replace\(afterHref\);\s*return;/);
  });

  it("cancelled: the toast with its Undo, then the home is PUSHED (the visit is still there for Back)", () => {
    expect(row).toMatch(/toast\(wontHappenToast\("cancelled", res\.note, lang, t\), "success", undo\(res\.previousStatus\)\);\s*router\.push\(afterHref\);/);
  });

  it("never goes back and never refreshes the dead page, and nothing is awaited between the answer and the navigation", () => {
    expect(row).not.toMatch(/router\.(back|refresh)\(/);
    expect(rows).not.toContain("hasInAppHistory");
    expect(row.match(/\bawait\b/g)).toHaveLength(1); // the action itself, and nothing after it
    // A refusal stays on the page and says why: nothing was removed, so there is nowhere to go.
    expect(row).toMatch(/if \(!res\.ok \|\| !res\.did\) \{\s*toast\(res\.error \?\? t\("vp_thatVisitDidntChange"\), "error"\);\s*return;\s*\}/);
  });

  it("the server deletes, revalidates the lists and answers; it sends nobody anywhere", () => {
    const actions = src("src/app/(app)/appointments/actions.ts");
    expect(actions).not.toContain('from "next/navigation"');
    expect(actions).toMatch(/function revalidateVisit\(id: string\) \{\s*revalidatePath\("\/schedule"\);\s*revalidatePath\("\/planner"\);\s*revalidatePath\("\/inspections"\);/);
  });
});

describe("⋯ › Edit Details… › Delete leaves with its sheet still open: never close-then-navigate", () => {
  const form = src("src/app/(app)/appointments/appointment-button.tsx");
  const remove = form.slice(form.indexOf("function remove()"), form.indexOf("\n  return (", form.indexOf("function remove()")));

  it("on the visit's own page the page is replaced by the visit's home before anything closes", () => {
    expect(remove).toContain('if (afterDeleteHref) return leave("replace", afterDeleteHref);');
    expect(remove.indexOf('return leave("replace", afterDeleteHref);')).toBeGreaterThan(remove.indexOf('toast(t("vp_appointmentDeleted"), "success");'));
    expect(remove.indexOf('return leave("replace", afterDeleteHref);')).toBeLessThan(remove.indexOf("setOpen(false);"));
    expect(remove.match(/\bawait\b/g)).toHaveLength(1);
  });

  it("leaving is the navigation and nothing else: the sheet is not closed, so no history step lands under it", () => {
    expect(form).toMatch(/function leave\(how: "push" \| "replace", href: string\) \{\s*setLeaving\(true\);\s*router\[how\]\(href\);\s*\}/);
    // The house rule the Add to Schedule sheet already holds (tests/field-1015-features): a Modal's
    // history step overtakes a navigation sent after its close.
    expect(form).not.toMatch(/setOpen\(false\);\s*(?:if \([^)]*\)\s*)?router\.(push|replace)\(/);
    expect(form).not.toMatch(/closeAll\(\);\s*router\.(push|replace)\(/);
  });

  it("while the page is on its way the X, a tap outside and Escape wait, and so do the sheet's doors", () => {
    expect(form).toContain("holdOpen={leaving}");
    expect(form).toContain("saving={pending || leaving}");
    expect(form).toContain("<Button type=\"button\" variant=\"outline\" onClick={remove} disabled={pending || leaving} className=\"text-red-600\">");
    // A leave that never landed does not leave the doors waiting the next time the sheet opens.
    expect(form).toMatch(/setLeaving\(false\);[^\n]*\n\s*setOpen\(true\);/);
  });

  it("on a list the row simply leaves: the sheet closes, the list re-reads, the holder is told", () => {
    expect(remove).toMatch(/setOpen\(false\);\s*router\.refresh\(\);\s*onSaved\?\.\(\);/);
  });

  it("the same sheet's other way out to a page (the job a visit became) leaves the same way", () => {
    expect(form).toContain("leave(\"push\", `/jobs/${res.id}`);");
  });
});

describe("an inspection row's Delete… asks in its sheet, never in the browser's own dialog", () => {
  const doors = src("src/app/(app)/inspections/inspection-row-menu.tsx");
  const noop = () => {};
  const face = (asking: boolean, lang: "en" | "es", pending = false) =>
    renderToStaticMarkup(
      <LangProvider lang={lang}>
        <InspectionRowMenuView
          doors={["move", "happened", "lost", "del"]}
          asking={asking}
          pending={pending}
          onPickDay={async () => ({ ok: true })}
          onHappened={noop}
          onLost={noop}
          onAsk={noop}
          onDelete={noop}
          onKeep={noop}
        />
      </LangProvider>,
    );

  it("no confirm() in the file: the first tap opens the question, the second is the deed", () => {
    expect(doors).not.toMatch(/\bconfirm\s*\(/);
    expect(doors).toContain("onAsk={() => setAsking(true)}");
    expect(doors).toMatch(/onDelete=\{\(\) => start\(\(\) => deleteTheVisit\(row\.id,/);
    expect(doors).toContain("onKeep={() => setAsking(false)}");
    // The deed is the one rule the visit's page runs, with nothing between the tap and it.
    expect(doors).toMatch(/export async function deleteTheVisit\([\s\S]*?\{\s*let res[^;]*;\s*try \{\s*res = await deps\.wontHappen\(id\);/);
    expect(doors).toMatch(/deps: \{ wontHappen: typeof wontHappenAppointment; setStatus: typeof setAppointmentStatus \} = \{\s*wontHappen: wontHappenAppointment,/);
  });

  it("resting: the sheet's rows; asking: the question, the deed in red and Keep It (Title Case, both languages)", () => {
    expect(buttons(face(false, "en"))).toEqual(["Move to Another Day…", "It Happened: Write It Up", "Lost", "Delete…"]);
    expect(buttons(face(false, "es"))).toEqual(["Mover a Otro Día…", "Sí Se Hizo: Redactarla", "Perdida", "Eliminar…"]);
    const en = face(true, "en");
    expect(text(en)).toContain("Delete this visit? It is removed if nothing is on it. If anything is (notes, an estimate, an invoice, a time-pick link), it is cancelled and kept on file.");
    expect(buttons(en)).toEqual(["Delete", "Keep It"]);
    expect(en).toMatch(/<button[^>]*text-red-600[^>]*>Delete<\/button>/);
    const es = face(true, "es");
    expect(text(es)).toContain("¿Eliminar esta visita? Se elimina si no tiene nada. Si tiene algo (notas, un presupuesto, una factura, un enlace para elegir hora), se cancela y se conserva en el archivo.");
    expect(buttons(es)).toEqual(["Eliminar", "Dejarla"]);
    expect(es).not.toMatch(/Delete|Keep It|Lost/);
    // The door as the list mounts it is the one ⋯, and its sheet starts at rest (it opens closed).
    const mounted = renderToStaticMarkup(
      createElement(InspectionRowMenu, {
        row: { id: "a1", who: "Dana Rook", what: "", menu: { move: false, happened: false, lost: true, del: true }, startsAt: null, endsAt: null },
        tz: "America/Los_Angeles",
      }),
    );
    expect(mounted.match(/<button/g)).toHaveLength(1);
    expect(mounted).toContain('aria-label="More for Dana Rook"');
  });

  it("while the deed is out both buttons wait, and the deed says so", () => {
    const busy = face(true, "en", true);
    expect(buttons(busy)).toEqual(["Saving…", "Keep It"]);
    expect(busy.match(/<button[^>]* disabled=""/g)).toHaveLength(2);
  });

  it("on the list the row leaves and the person stays: the list re-reads, and nothing navigates", () => {
    expect(doors).not.toMatch(/router\.(push|replace|back)\(/);
    // One re-read for every deed: the list's router.refresh, handed to each deed as io.refresh.
    expect(doors.match(/router\.refresh\(\)/g)).toHaveLength(1);
    expect(doors).toContain("refresh: () => router.refresh()");
    const del = doors.slice(doors.indexOf("export async function deleteTheVisit"), doors.indexOf("export async function moveTheVisit"));
    // The deed re-reads, and so does its refusal (a stale row): said, the sheet closed, then the
    // re-read, through the one helper every deed's refusal takes.
    expect(del.match(/io\.refresh\(\)/g)).toHaveLength(1);
    expect(del).toContain('if (!res.ok || !res.did) return refused(io, res.error ?? io.t("vp_thatVisitDidntChange"));');
    expect(doors).toMatch(/function refused\(io: DoorIo, sentence: string\) \{\s*io\.toast\(sentence, "error"\);\s*io\.close\(\);\s*io\.refresh\(\);\s*\}/);
  });
});
