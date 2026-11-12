import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { titleCaseIn } from "../../../../tests/title-case-words";

/**
 * AN OPEN INSPECTION'S ⋯. Every open row's moves sit behind the app's one row sheet: Move to Another
 * Day…, It Happened: Write It Up, Lost and Delete…, in that order, as the row's `menu` allows. Delete
 * asks first in the sheet (never the browser's dialog); It Happened and Lost carry an Undo that calls
 * the right door with the right value; a refusal is said, then the sheet closes, then the list
 * re-reads; no connection is said with the sheet still open; nobody is sent anywhere. Rendered statically (no DOM): the pure view's two faces, and the deeds
 * with their server doors handed in.
 */
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/inspections",
}));
vi.mock("@/components/toast", () => ({ useToast: () => vi.fn() }));
vi.mock("@/components/use-org-public-base", () => ({ useOrgPublicBase: () => "" }));
vi.mock("../schedule/actions", () => ({ moveJobDay: vi.fn() }));
vi.mock("../appointments/actions", () => ({
  rescheduleAppointment: vi.fn(),
  setAppointmentStatus: vi.fn(),
  setAppointmentOutcome: vi.fn(),
  wontHappenAppointment: vi.fn(),
  createAppointment: vi.fn(),
  updateAppointment: vi.fn(),
  deleteAppointment: vi.fn(),
  createJobFromAppointment: vi.fn(),
  createAppointmentProposal: vi.fn(),
}));

const { LangProvider } = await import("@/components/lang-provider");
const { translator } = await import("@/lib/i18n");
const { InspectionRowMenu, InspectionRowMenuView, menuDoors, markItHappened, markItLost, deleteTheVisit, moveTheVisit } = await import(
  "./inspection-row-menu"
);
type MenuDoor = import("./inspection-row-menu").MenuDoor;

const src = readFileSync(join(process.cwd(), "src/app/(app)/inspections/inspection-row-menu.tsx"), "utf8");
const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const decode = (s: string) => s.replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const text = (html: string) => decode(html.replace(/<[^>]+>/g, " "));
const buttons = (html: string) => [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((m) => decode(m[1].replace(/<[^>]+>/g, "")));

const ALL = { move: true, happened: true, lost: true, del: true };
const NONE = { move: false, happened: false, lost: false, del: false };
const row = {
  id: "a1",
  who: "Sam Tillery",
  what: "Panel swap · 12 Larkspur",
  menu: ALL,
  startsAt: "2026-11-03T17:00:00.000Z",
  endsAt: "2026-11-03T18:00:00.000Z",
};
const noop = () => {};
const face = (doors: MenuDoor[], asking: boolean, lang: "en" | "es" = "en", pending = false) =>
  renderToStaticMarkup(
    <LangProvider lang={lang}>
      <InspectionRowMenuView
        doors={doors}
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

describe("which moves a row's ⋯ holds", () => {
  it("each tile's shape, in the sheet's order", () => {
    expect(menuDoors(row)).toEqual(["move", "happened", "lost", "del"]); // Didn't Happen?
    expect(menuDoors({ ...row, menu: { ...NONE, move: true, del: true } })).toEqual(["move", "del"]); // Coming Up
    expect(menuDoors({ ...row, menu: { ...NONE, del: true } })).toEqual(["del"]); // Needs a Day
    expect(menuDoors({ ...row, menu: { ...NONE, lost: true } })).toEqual(["lost"]); // Write Up
  });

  it("no Move without a start: there is no time of day to keep", () => {
    expect(menuDoors({ ...row, startsAt: null })).toEqual(["happened", "lost", "del"]);
    expect(menuDoors({ ...row, startsAt: null, menu: { ...NONE, move: true } })).toEqual([]);
  });

  it("nothing renders for a null menu or a menu with nothing in it (no ⋯, never an empty sheet)", () => {
    expect(renderToStaticMarkup(createElement(InspectionRowMenu, { row: { ...row, menu: null }, tz: "America/Los_Angeles" }))).toBe("");
    expect(renderToStaticMarkup(createElement(InspectionRowMenu, { row: { ...row, menu: NONE }, tz: "America/Los_Angeles" }))).toBe("");
    expect(
      renderToStaticMarkup(createElement(InspectionRowMenu, { row: { ...row, startsAt: null, menu: { ...NONE, move: true } }, tz: "America/Los_Angeles" })),
    ).toBe("");
  });

  it("a row with moves gets the one 44px ⋯, titled with who it is for", () => {
    const html = renderToStaticMarkup(createElement(InspectionRowMenu, { row, tz: "America/Los_Angeles" }));
    expect(html).toMatch(/<button type="button" aria-label="More for Sam Tillery"[^>]*class="[^"]*h-11 w-11[^"]*"/);
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(code).toContain("<RowMoreSheet title={row.who} subline={row.what || null}>");
  });
});

describe("the sheet's two faces", () => {
  it("resting: the rows the menu allows, in order, each a 44px sheet row, nothing red", () => {
    const en = face(["move", "happened", "lost", "del"], false);
    expect(buttons(en)).toEqual(["Move to Another Day…", "It Happened: Write It Up", "Lost", "Delete…"]);
    expect(en.match(/<button[^>]*class="[^"]*min-h-\[44px\] w-full[^"]*"/g)).toHaveLength(4);
    expect(en).not.toMatch(/red-/);
    expect(buttons(face(["move", "del"], false))).toEqual(["Move to Another Day…", "Delete…"]);
    expect(buttons(face(["lost"], false))).toEqual(["Lost"]);
  });

  it("asking: the question, the deed in red and Keep It; the rows are gone", () => {
    const en = face(["move", "happened", "lost", "del"], true);
    expect(text(en)).toContain("Delete this visit? It is removed if nothing is on it. If anything is (notes, an estimate, an invoice, a time-pick link), it is cancelled and kept on file.");
    expect(buttons(en)).toEqual(["Delete", "Keep It"]);
    expect(en).toMatch(/<button[^>]*text-red-600[^>]*>Delete<\/button>/);
    expect(en.match(/red-/g)).toHaveLength(1);
    const es = face(["del"], true, "es");
    expect(text(es)).toContain("¿Eliminar esta visita? Se elimina si no tiene nada. Si tiene algo (notas, un presupuesto, una factura, un enlace para elegir hora), se cancela y se conserva en el archivo.");
    expect(buttons(es)).toEqual(["Eliminar", "Dejarla"]);
    expect(es).not.toMatch(/Delete|Keep It/);
  });

  it("while a deed is out the buttons wait, and the deed says so", () => {
    const busy = face(["del"], true, "en", true);
    expect(buttons(busy)).toEqual(["Saving…", "Keep It"]);
    expect(busy.match(/<button[^>]* disabled=""/g)).toHaveLength(2);
    const resting = face(["happened", "lost", "del"], false, "en", true);
    expect(resting.match(/<button[^>]* disabled=""/g)).toHaveLength(3);
  });

  it("Spanish, and every label Title Case in both languages", () => {
    const es = face(["move", "happened", "lost", "del"], false, "es");
    expect(buttons(es)).toEqual(["Mover a Otro Día…", "Sí Se Hizo: Redactarla", "Perdida", "Eliminar…"]);
    for (const lang of ["en", "es"] as const) {
      const t = translator(lang);
      for (const k of ["ip_btn_moveToAnotherDay", "ip_btn_itHappened", "ip_btn_lost", "ip_btn_delete", "ip_btn_deleteIt", "vp_btn_keepIt", "ag_btn_undo"]) {
        expect(titleCaseIn(t(k).replace(/…$/, ""), lang), `${lang} ${k}: ${t(k)}`).toBe(true);
      }
    }
  });

  it("asks in the sheet, never in the browser's own dialog; the first tap asks, the second is the deed", () => {
    expect(code).not.toMatch(/\bconfirm\s*\(/);
    expect(code).toContain("onAsk={() => setAsking(true)}");
    expect(code).toContain("onKeep={() => setAsking(false)}");
    expect(code).toMatch(/onDelete=\{\(\) => start\(\(\) => deleteTheVisit\(row\.id,/);
    // The deed is the one rule the visit's page runs, with nothing between the tap and it.
    expect(code).toMatch(/res = await deps\.wontHappen\(id\);/);
  });

  it("on the list the row leaves and the person stays: the list re-reads, and nothing navigates", () => {
    expect(code).not.toMatch(/router\.(push|replace|back)\(/);
    expect(code).toContain("refresh: () => router.refresh()");
  });

  it("no amber, no slate-400, and the one red is the ask's deed", () => {
    expect(src).not.toMatch(/amber-|text-slate-400/);
    expect(src.match(/red-/g)).toEqual(["red-"]);
  });
});

/** A recorder for the deeds' io: every call lands in one ordered log, so the order is provable. */
function rig(lang: "en" | "es" = "en") {
  const log: string[] = [];
  const toast = vi.fn((message: string, kind?: string, _action?: unknown, _opts?: unknown) => void log.push(`toast:${kind}:${message}`));
  const io = { toast, refresh: vi.fn(() => void log.push("refresh")), close: vi.fn(() => void log.push("close")), lang, t: translator(lang), log };
  return io;
}
type Io = ReturnType<typeof rig>;
const undoOf = (toast: Io["toast"]) => (toast.mock.calls[0][2] as unknown as { label: string; onClick: () => void }).onClick;
const settle = () => new Promise((r) => setTimeout(r, 0));
const offline = async () => {
  throw new Error("offline");
};
/** A thrown call is said, the sheet stays open, nothing re-reads. */
const saidOffline = (io: Io, sentence = "That didn't save — try again.") => {
  expect(io.log).toEqual([`toast:error:${sentence}`]);
};
/** A refusal: said in red, THEN the sheet closes, THEN the list re-reads. */
const saidRefused = (io: Io, sentence: string) => {
  expect(io.log).toEqual([`toast:error:${sentence}`, "close", "refresh"]);
};

describe("It Happened: Write It Up", () => {
  it("marks it done, closes, re-reads, and Undo puts back the status it had", async () => {
    const setStatus = vi.fn(async (_id: string, s: string) => ({ ok: true, previousStatus: s === "completed" ? "scheduled" : "completed" }));
    const io = rig();
    await markItHappened("a1", io, { setStatus: setStatus as any });
    expect(setStatus).toHaveBeenCalledWith("a1", "completed");
    expect(io.log).toEqual(["close", "toast:success:Moved to Write Up.", "refresh"]);
    expect(io.toast.mock.calls[0][2]).toMatchObject({ label: "Undo" });
    undoOf(io.toast)();
    await settle();
    expect(setStatus).toHaveBeenLastCalledWith("a1", "scheduled");
    expect(io.toast).toHaveBeenLastCalledWith("Back where it was.", "success");
    expect(io.refresh).toHaveBeenCalledTimes(2);
  });

  it("a visit that was waiting on a pick comes back Scheduled, and the Undo says the link stays withdrawn", async () => {
    const setStatus = vi.fn(async (_id: string, s: string) =>
      s === "completed" ? { ok: true, previousStatus: "proposed", note: "The pick-a-time link was withdrawn." } : { ok: true },
    );
    const io = rig();
    await markItHappened("a1", io, { setStatus: setStatus as any });
    expect(io.toast).toHaveBeenCalledWith("The pick-a-time link was withdrawn.", "info", undefined, { sticky: true });
    undoOf(io.toast)();
    await settle();
    // Never "proposed": the link it waited on is gone, so nobody could pick.
    expect(setStatus).toHaveBeenLastCalledWith("a1", "scheduled");
    expect(io.toast).toHaveBeenLastCalledWith("Put back. The pick-a-time link stays withdrawn — send a new one.", "success");
  });

  it("a refusal is said in the server's sentence, then the sheet closes, then the list re-reads", async () => {
    const io = rig();
    await markItHappened("a1", io, { setStatus: (async () => ({ ok: false, error: "That visit is gone." })) as any });
    saidRefused(io, "That visit is gone.");
  });

  it("no connection is said in the reader's language; the sheet stays open and nothing re-reads", async () => {
    const io = rig("es");
    await markItHappened("a1", io, { setStatus: offline as any });
    saidOffline(io, "Eso no se guardó — inténtalo de nuevo.");
  });
});

describe("Lost", () => {
  it("writes lost, closes, re-reads, and Undo clears the outcome", async () => {
    const setOutcome = vi.fn(async () => ({ ok: true }));
    const io = rig();
    await markItLost("a1", io, { setOutcome: setOutcome as any });
    expect(setOutcome).toHaveBeenCalledWith("a1", "lost");
    expect(io.log).toEqual(["close", "toast:success:Marked Lost.", "refresh"]);
    undoOf(io.toast)();
    await settle();
    expect(setOutcome).toHaveBeenLastCalledWith("a1", null);
    expect(io.toast).toHaveBeenLastCalledWith("Back where it was.", "success");
  });

  it("an Undo that fails says why", async () => {
    const setOutcome = vi.fn(async (_id: string, o: string | null) => (o ? { ok: true } : { ok: false, error: "Couldn't put it back." }));
    const io = rig();
    await markItLost("a1", io, { setOutcome: setOutcome as any });
    undoOf(io.toast)();
    await settle();
    expect(io.toast).toHaveBeenLastCalledWith("Couldn't put it back.", "error");
  });

  it("a refusal says the server's sentence, else the house's; then the sheet closes and the list re-reads", async () => {
    const io = rig();
    await markItLost("a1", io, { setOutcome: (async () => ({ ok: false, error: "No access." })) as any });
    saidRefused(io, "No access.");
    const io2 = rig();
    await markItLost("a1", io2, { setOutcome: (async () => ({ ok: false })) as any });
    saidRefused(io2, "That didn't save — try again.");
  });

  it("no connection is said; the sheet stays open and nothing re-reads", async () => {
    const io = rig();
    await markItLost("a1", io, { setOutcome: offline as any });
    saidOffline(io);
  });
});

describe("Delete…, the second tap", () => {
  const setStatus = vi.fn(async () => ({ ok: true }));

  it("removed: said the visit page's way, no Undo (there is nothing to put back); the sheet closes and the list re-reads", async () => {
    const io = rig();
    await deleteTheVisit("a1", io, { wontHappen: (async () => ({ ok: true, did: "deleted" })) as any, setStatus: setStatus as any });
    expect(io.log).toEqual(["close", "toast:success:Deleted. Nothing was on it.", "refresh"]);
    expect(io.toast.mock.calls[0][2]).toBeUndefined();
  });

  it("cancelled and kept: said, with an Undo that puts its status back by the visit page's rule", async () => {
    const put = vi.fn(async () => ({ ok: true }));
    const io = rig();
    await deleteTheVisit("a1", io, { wontHappen: (async () => ({ ok: true, did: "cancelled", previousStatus: "scheduled" })) as any, setStatus: put as any });
    expect(io.log).toEqual(["close", "toast:success:Marked Cancelled. Everything on it stays on file.", "refresh"]);
    expect(io.toast.mock.calls[0][2]).toMatchObject({ label: "Undo" });
    expect(io.toast.mock.calls[0][3]).toBeUndefined();
    undoOf(io.toast)();
    await settle();
    expect(put).toHaveBeenLastCalledWith("a1", "scheduled");
    expect(io.toast).toHaveBeenLastCalledWith("Back where it was.", "success");
    expect(io.refresh).toHaveBeenCalledTimes(2);
  });

  it("cancelled with a withdrawn link: the toast carries the note and stays until read; Undo brings it back Scheduled", async () => {
    const put = vi.fn(async () => ({ ok: true }));
    const io = rig();
    await deleteTheVisit("a1", io, {
      wontHappen: (async () => ({ ok: true, did: "cancelled", previousStatus: "proposed", note: "The pick-a-time link was withdrawn." })) as any,
      setStatus: put as any,
    });
    expect(io.toast.mock.calls[0][0]).toBe("Marked Cancelled. Everything on it stays on file. The pick-a-time link was withdrawn.");
    expect(io.toast.mock.calls[0][3]).toEqual({ sticky: true });
    undoOf(io.toast)();
    await settle();
    expect(put).toHaveBeenLastCalledWith("a1", "scheduled");
  });

  it("a refusal is said, then the sheet closes, then the list re-reads", async () => {
    const io = rig();
    await deleteTheVisit("a1", io, { wontHappen: (async () => ({ ok: false, error: "Already cancelled." })) as any, setStatus: setStatus as any });
    saidRefused(io, "Already cancelled.");
    const io2 = rig("es");
    await deleteTheVisit("a1", io2, { wontHappen: (async () => ({ ok: true })) as any, setStatus: setStatus as any });
    saidRefused(io2, "Esa visita no cambió — inténtalo de nuevo.");
  });

  it("no connection is said; the ask stays open and nothing re-reads", async () => {
    const io = rig();
    await deleteTheVisit("a1", io, { wontHappen: offline as any, setStatus: setStatus as any });
    saidOffline(io);
  });
});

describe("Move to Another Day…", () => {
  it("keeps the time of day in the company's zone; landed: closes, names the day, re-reads", async () => {
    const reschedule = vi.fn(async () => ({ ok: true }));
    const io = rig();
    const out = await moveTheVisit(row, "2026-11-10", "America/Los_Angeles", io, { reschedule: reschedule as any });
    expect(reschedule).toHaveBeenCalledWith("a1", "2026-11-10T17:00:00.000Z", "2026-11-10T18:00:00.000Z");
    expect(out).toBeUndefined();
    expect(io.log).toEqual(["close", "toast:success:Moved to Nov 10.", "refresh"]);
  });

  it("the day is said in the reader's language, with its year when it is not this year", async () => {
    const io = rig("es");
    await moveTheVisit(row, "2026-11-10", "America/Los_Angeles", io, { reschedule: (async () => ({ ok: true })) as any });
    expect(io.toast.mock.calls[0][0]).toBe("Se movió al 10 nov.");
    const io2 = rig();
    await moveTheVisit(row, "2099-01-05", "America/Los_Angeles", io2, { reschedule: (async () => ({ ok: true })) as any });
    expect(io2.toast.mock.calls[0][0]).toBe("Moved to Jan 5, 2099.");
  });

  it("a withdrawn link is a second toast, kept until read", async () => {
    const io = rig();
    await moveTheVisit(row, "2026-11-10", "America/Los_Angeles", io, { reschedule: (async () => ({ ok: true, note: "Link withdrawn." })) as any });
    expect(io.toast).toHaveBeenNthCalledWith(1, "Moved to Nov 10.", "success");
    expect(io.toast).toHaveBeenNthCalledWith(2, "Link withdrawn.", "info", undefined, { sticky: true });
  });

  it("a refusal is said, then the sheet closes, then the list re-reads", async () => {
    const io = rig();
    const out = await moveTheVisit(row, "2026-11-10", "America/Los_Angeles", io, { reschedule: (async () => ({ ok: false, error: "No access." })) as any });
    expect(out).toBeUndefined();
    saidRefused(io, "No access.");
  });

  it("no connection: the picker says it where the day was picked; the sheet stays open and nothing re-reads", async () => {
    const io = rig();
    const out = await moveTheVisit(row, "2026-11-10", "America/Los_Angeles", io, { reschedule: offline as any });
    expect(out).toEqual({ ok: false, error: "That didn't save — try again." });
    expect(io.log).toEqual([]);
  });
});
