import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { translator } from "@/lib/i18n";

/**
 * THE NOT SOLD FOLD'S DELETE… (cn-v1181, I2b), on the phone's side: the door at rest, its ask in place
 * (never the browser's dialog), and the three endings of the second tap, with the server door handed in.
 */
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }) }));
vi.mock("@/components/toast", () => ({ useToast: () => vi.fn() }));
vi.mock("../appointments/actions", () => ({ deleteEndedVisit: vi.fn() }));

const { FoldDelete, FoldDeleteAsk, deleteFoldVisit } = await import("./fold-delete");
const { LangProvider } = await import("@/components/lang-provider");

const draw = (lang: "en" | "es", el: React.ReactElement) => renderToStaticMarkup(<LangProvider lang={lang}>{el}</LangProvider>);
const io = () => ({ toast: vi.fn(), refresh: vi.fn(), t: translator("en") });

describe("the fold's Delete…", () => {
  it("at rest: one outline door on a 44px target, Title Case in both languages, nothing red", () => {
    const en = draw("en", createElement(FoldDelete, { id: "v-1" }));
    expect(en).toMatch(/<button type="button" class="[^"]*h-11[^"]*border-slate-300[^"]*" data-fold-delete="v-1">Delete…<\/button>/);
    expect(en).not.toMatch(/red-|amber-/);
    expect(draw("es", createElement(FoldDelete, { id: "v-1" }))).toContain(">Eliminar…</button>");
  });

  it("the ask says what goes and that a visit with anything on it stays; the deed and Keep It", () => {
    const html = draw("en", createElement(FoldDeleteAsk, { pending: false, onYes: () => {}, onKeep: () => {} }));
    expect(html).toContain("Delete this visit for good? Only a visit with nothing on it is deleted. If anything is on it, it stays on file.");
    expect(html).toContain(">Delete</button>");
    expect(html).toContain(">Keep It</button>");
    const es = draw("es", createElement(FoldDeleteAsk, { pending: false, onYes: () => {}, onKeep: () => {} }));
    expect(es).toContain("¿Eliminar esta visita para siempre?");
  });

  it("deleted: said, and the fold re-reads", async () => {
    const o = io();
    expect(await deleteFoldVisit("v-1", o, { del: (async () => ({ ok: true, did: "deleted" })) as never })).toBe(true);
    expect(o.toast).toHaveBeenCalledWith("Deleted. Nothing was on it.", "success");
    expect(o.refresh).toHaveBeenCalledOnce();
  });

  it("kept: the server's one sentence, said plainly (not red); nothing re-reads", async () => {
    const o = io();
    const said = "Not deleted: this visit has an invoice on it. It stays on file.";
    expect(await deleteFoldVisit("v-1", o, { del: (async () => ({ ok: false, kept: true, error: said })) as never })).toBe(false);
    expect(o.toast).toHaveBeenCalledWith(said, "info");
    expect(o.refresh).not.toHaveBeenCalled();
  });

  it("refused: said in red, the fold re-reads; no connection: said, nothing re-reads", async () => {
    const o = io();
    await deleteFoldVisit("v-1", o, { del: (async () => ({ ok: false, error: "That visit is not there anymore." })) as never });
    expect(o.toast).toHaveBeenCalledWith("That visit is not there anymore.", "error");
    expect(o.refresh).toHaveBeenCalledOnce();
    const o2 = io();
    await deleteFoldVisit("v-1", o2, {
      del: (async () => {
        throw new Error("offline");
      }) as never,
    });
    expect(o2.toast).toHaveBeenCalledWith(translator("en")("vp_thatDidntSave"), "error");
    expect(o2.refresh).not.toHaveBeenCalled();
  });
});
