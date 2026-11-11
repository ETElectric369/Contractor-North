import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { NavTree } from "@/lib/nav-tree";
import { catalog, savedProps } from "./editor-test-mocks";

/**
 * THE CIRCUIT SCHEDULE IS ASKED FOR ON THE ESTIMATE, NOT DRAWN UNDER EVERY ONE (cn-v1160). The owner,
 * 2026-11-10: "we do not need the circuit schedule on the estimates page, right now it shows up on the
 * bottom of every one". The card shows when the estimate has circuits; otherwise, with Panel Map on,
 * the estimate's ⋯ holds one row, Add Circuit Schedule, that opens it on this estimate alone. The page
 * asks lib/estimate/circuit-card (tabled in its own test) and hands the editor the answer; here the
 * editor is drawn with each answer. Every name here is invented.
 */

// THE ⋯ MENU, OPENED: the real one draws only its button until it is tapped, which a server render
// never does. This stand-in writes the tree's rows as the menu would list them, so the rows can be read.
const trees: NavTree[] = [];
vi.doMock("@/components/section-actions-menu", () => ({
  SectionActionsMenu: ({ tree }: { tree: NavTree }) => {
    trees.push(tree);
    return createElement(
      "ul",
      { "data-menu": "" },
      tree.nodes.map((n) => createElement("li", { key: n.id, "data-row": n.id }, n.label)),
    );
  },
  useCloseActionsMenu: () => () => {},
  ACTIONS_ROW_CLS: "",
  ACTIONS_NOTE_CLS: "",
  ACTIONS_DANGER_ROW_CLS: "",
  ACTIONS_DIVIDER_CLS: "",
}));

const { LangProvider } = await import("@/components/lang-provider");
const { EstimateEditor } = await import("./estimate-editor");
const { words: qe } = await import("@/lib/words/quotes-editor");

const CARD = 'id="estimate-circuit-schedule"';
const ROW = 'data-row="qm-circuits"';
const CIRCUIT = { number: "1", label: "Snowbell kitchen counter", amps: 20 };

const el = (q: Record<string, unknown>, extra: Record<string, unknown>) =>
  createElement(EstimateEditor as never, { mode: "saved", saved: savedProps({ status: "draft", ...q }, [], extra), catalog: catalog() } as never) as ReactElement;
const draw = (q: Record<string, unknown>, extra: Record<string, unknown>, lang: "en" | "es" = "en") =>
  renderToStaticMarkup(createElement(LangProvider, { lang } as never, el(q, extra)));

describe("the estimate's circuit schedule: the card when there are circuits, the ⋯ row when it can be started", () => {
  it("Panel Map on and no circuits: the ⋯ row, and NO card", () => {
    const html = draw({ circuits: [] }, { showCircuits: false, canAddCircuits: true });
    expect(html).toContain(ROW);
    expect(html).toContain(">Add Circuit Schedule</li>");
    expect(html).not.toContain(CARD);
  });

  it("the row sits just before Delete, and its run opens the card and answers ok (the menu then closes)", async () => {
    trees.length = 0;
    draw({ circuits: [] }, { showCircuits: false, canAddCircuits: true });
    const ids = trees.at(-1)!.nodes.map((n) => n.id);
    expect(ids.slice(-2)).toEqual(["qm-circuits", "qm-del"]);
    const row = trees.at(-1)!.nodes.find((n) => n.id === "qm-circuits")!;
    expect(row.icon).toBe("zap");
    expect(row.href).toBeUndefined(); // no navigation: it opens the card in place
    await expect(row.run!()).resolves.toEqual({ ok: true });
  });

  it("an estimate that has circuits: the card, and no row", () => {
    const html = draw({ circuits: [CIRCUIT] }, { showCircuits: true, canAddCircuits: false });
    expect(html).toContain(CARD);
    expect(html).not.toContain(ROW);
  });

  it("Panel Map off and no circuits: neither the card nor the row", () => {
    const html = draw({ circuits: [] }, { showCircuits: false, canAddCircuits: false });
    expect(html).not.toContain(CARD);
    expect(html).not.toContain(ROW);
  });

  it("a locked estimate: no row (the page's helper says canAdd false), and the rest of the ⋯ stays", () => {
    const html = draw({ status: "accepted", circuits: [] }, { showCircuits: false, canAddCircuits: false, lock: { reason: "A draw was already billed against it." } });
    expect(html).not.toContain(ROW);
    expect(html).not.toContain(CARD);
    expect(html).toContain('data-row="qm-del"');
  });

  it("the row in Spanish, from the one catalog key", () => {
    const html = draw({ circuits: [] }, { showCircuits: false, canAddCircuits: true }, "es");
    expect(html).toContain(">Agregar Tabla de Circuitos</li>");
    expect(qe.en.qe_btn_addCircuitSchedule).toBe("Add Circuit Schedule");
    expect(qe.es.qe_btn_addCircuitSchedule).toBe("Agregar Tabla de Circuitos");
  });

  it("the page no longer draws the card for every estimate because Panel Map is on: it asks the helper", () => {
    const page = readFileSync(join(process.cwd(), "src/app/(app)/quotes/[id]/page.tsx"), "utf8");
    expect(page).not.toContain('featureOn(orgS.features, "panel_map") ||');
    expect(page).toContain('circuitCard({ panelMapOn: featureOn(orgS.features, "panel_map"), circuits: q.circuits, locked: !!lock })');
    expect(page).toContain("showCircuits: card.has,");
    expect(page).toContain("canAddCircuits: card.canAdd,");
  });
});
