import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LangProvider } from "@/components/lang-provider";
import { dict } from "@/lib/i18n";

/**
 * THE OFFICE'S TWO LIST DOORS, IN THE PERSON'S LANGUAGE (cn-v1138). New List (the index) and Edit List
 * (the list page's pencil) share the materials screens, so their words moved into lib/words/materials
 * (mt_) with the rest. The sheets are closed until tapped (the Modal draws nothing), so the render
 * holds the door itself; the sheet's heading and Save are checked on the catalog.
 */
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/app/(app)/materials/actions", () => ({ createMaterialList: vi.fn(), generateMaterialDraft: vi.fn(), updateMaterialList: vi.fn() }));

import { NewListButton } from "./new-list-button";
import { RenameListButton } from "./[id]/rename-list-button";

const textOf = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();
const buttons = (html: string) => [...html.matchAll(/<button[^>]*>[\s\S]*?<\/button>/g)].map((m) => textOf(m[0]));
const newList = (lang: "en" | "es") => renderToStaticMarkup(createElement(LangProvider, { lang, children: createElement(NewListButton, { jobs: [] }) }));
const rename = (lang: "en" | "es") =>
  renderToStaticMarkup(createElement(LangProvider, { lang, children: createElement(RenameListButton, { listId: "l1", name: "Materials — J-047", jobId: null, jobs: [] }) }));

describe("New List and Edit List (cn-v1138)", () => {
  it("Spanish: the doors, and the sheets' headings and Save in the catalog, every door Title Case", () => {
    expect(buttons(newList("es"))).toContain("Nueva Lista");
    expect(rename("es")).toContain('title="Editar lista"');
    expect(dict("es").mt_newMaterialList).toBe("Nueva Lista De Materiales");
    expect(dict("es").mt_createList).toBe("Crear Lista");
    expect(dict("es").mt_editList).toBe("Editar Lista");
    expect(dict("es").mt_save).toBe("Guardar");
    expect(dict("es").mt_cancel).toBe("Cancelar");
    expect(dict("es").mt_generateItems).toBe("Generar Artículos");
  });

  it("English is unchanged", () => {
    expect(newList("en")).toBe(renderToStaticMarkup(createElement(NewListButton, { jobs: [] })));
    expect(buttons(newList("en"))).toContain("New List");
    expect(rename("en")).toContain('title="Edit list"');
    expect(dict("en").mt_newMaterialList).toBe("New Material List");
    expect(dict("en").mt_createList).toBe("Create List");
    expect(dict("en").mt_editList).toBe("Edit List");
    expect(dict("en").mt_listName).toBe("List name");
    expect(dict("en").mt_noneOption).toBe("— None —");
    expect(dict("en").mt_scopePlaceholder).toBe("Describe the work: what, where and how much, the way you'd say it on site.");
    expect(dict("en").mt_itemPlaceholder).toBe("The item, the way you'd ask for it at the counter");
  });
});
