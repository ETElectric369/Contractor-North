import { describe, it, expect, vi, beforeEach } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LangProvider } from "@/components/lang-provider";

/**
 * THE TWO MATERIALS PAGES IN THE PERSON'S LANGUAGE (cn-v1138). Each page reads profiles.language on
 * the same profile read it already made for the role, and every word it draws comes from
 * lib/words/materials (mt_); the client components inside read the (app) layout's LangProvider, which
 * this test stands in for. The pages themselves are rendered — the server components, with a fake
 * database answering in live shapes — for a Spanish-speaking tech and for an English one, so the
 * headline, the doors and the dates are checked as a person sees them.
 */
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => "/materials/l1",
  useSearchParams: () => new URLSearchParams(),
  notFound: () => {
    throw new Error("notFound");
  },
}));
vi.mock("@/components/toast", () => ({ useToast: () => () => {} }));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));
vi.mock("@/app/(app)/materials/actions", () => ({
  canonicalMaterialListId: vi.fn(async () => ({ id: "l1" })),
  deleteMaterialList: vi.fn(),
  createMaterialList: vi.fn(),
  generateMaterialDraft: vi.fn(),
  updateMaterialList: vi.fn(),
  addMaterialItem: vi.fn(),
  deleteMaterialItem: vi.fn(),
  updateMaterialItem: vi.fn(),
  setMaterialItemPurchased: vi.fn(),
  setMaterialItemTool: vi.fn(),
  ensureJobMaterialList: vi.fn(),
  requestMaterials: vi.fn(),
}));
vi.mock("@/app/(app)/materials/stock-actions", () => ({ loadShelf: vi.fn(), takeFromStockAction: vi.fn(), undoTakeAction: vi.fn() }));
vi.mock("@/lib/stock-ledger", () => ({
  jobTakes: vi.fn(async () => ({ takes: [], missing: false, error: null })),
  shelfForCrew: vi.fn(async () => ({ ok: false })),
}));
vi.mock("@/lib/viewer-switches", () => ({ viewerSwitches: vi.fn(async () => ({ features: null, isOwner: false })) }));
vi.mock("@/app/(app)/purchasing/new-po-button", () => ({ NewPoButton: () => null }));

/** What the database answers: the viewer's profile, the one list (the list page), the lists (the index), the list's lines. */
const db = vi.hoisted(() => ({
  language: null as string | null,
  role: "tech",
  list: null as Record<string, unknown> | null,
  items: [] as unknown[],
  lists: [] as unknown[],
}));
function answerOne(table: string): unknown {
  if (table === "profiles") return { role: db.role, language: db.language };
  if (table === "material_lists") return db.list;
  return null;
}
function answerMany(table: string): unknown[] {
  if (table === "material_lists") return db.lists;
  if (table === "material_list_items") return db.items;
  return [];
}
function client() {
  return {
    auth: { getUser: async () => ({ data: { user: { id: "u-1" } } }) },
    from(table: string) {
      const b: any = {
        select: () => b,
        eq: () => b,
        not: () => b,
        order: () => b,
        limit: () => b,
        maybeSingle: async () => ({ data: answerOne(table), error: null }),
        then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve({ data: answerMany(table), error: null }).then(ok, bad),
      };
      return b;
    },
  };
}
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => client() }));

import MaterialsPage from "./page";
import MaterialListPage from "./[id]/page";

const JOB = { id: "j1", job_number: "J-047", name: "Snowbell Deck", address: "12 Thistlewood Ln", customers: { name: "Larkspur" } };
const LIST = { id: "l1", name: "Materials — J-047", job_id: "j1", quote_id: null, work_order_id: null, created_at: "2026-10-20T19:00:00Z", jobs: JOB };
const line = (id: string, description: string, purchased: boolean) => ({ id, list_id: "l1", description, part_number: null, quantity: 2, unit: "box", purchased, purchased_at: null, is_tool: false, sort_order: 0 });
const ITEMS = [line("i1", "Deck screws", false), line("i2", "Joist hangers", true)];

const textOf = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const buttons = (html: string) => [...html.matchAll(/<button[^>]*>[\s\S]*?<\/button>/g)].map((m) => textOf(m[0]));
/** The page as the (app) layout mounts it: inside the LangProvider carrying the same profiles.language. */
async function listPage(lang: "en" | "es") {
  db.language = lang;
  const el = await MaterialListPage({ params: Promise.resolve({ id: "l1" }) });
  return renderToStaticMarkup(createElement(LangProvider, { lang, children: el }));
}
async function indexPage(lang: "en" | "es") {
  db.language = lang;
  const el = await MaterialsPage({ searchParams: Promise.resolve({}) });
  return renderToStaticMarkup(createElement(LangProvider, { lang, children: el }));
}

beforeEach(() => {
  db.role = "tech";
  db.list = LIST;
  db.items = ITEMS;
  db.lists = [
    { ...LIST, material_list_items: [{ id: "i1", purchased: false, is_tool: false }, { id: "i2", purchased: true, is_tool: false }] },
    { id: "l2", name: "Materials — J-048", job_id: "j2", created_at: "2026-10-19T19:00:00Z", jobs: { ...JOB, job_number: "J-048", name: "Bayberry Fence" }, material_list_items: [] },
  ];
});

describe("the list page (materials/[id]) in Spanish", () => {
  it("a tech on a job's list: the back door, the date, Took From Stock, the editor and Tell The Office", async () => {
    const html = await listPage("es");
    const text = textOf(html);
    expect(text).toContain("Volver A Las Listas De Materiales");
    expect(text).toContain("Creada el 20 oct 2026");
    expect(buttons(html)).toContain("Tomado Del Inventario");
    expect(buttons(html)).toContain("Avisar A La Oficina");
    expect(html).toContain('placeholder="Agregar un artículo…"');
    expect(text).toContain("Comprados (1)");
    expect(text).toContain("1 por comprar");
    expect(text).toContain("Deck screws");
    for (const en of ["Back to Material Lists", "Took From Stock", "Tell The Office", "Bought (", "to buy", "Created Oct"]) expect(text).not.toContain(en);
  });

  it("a tech on the office's paper (a quote's take-off): read-only, said in Spanish", async () => {
    db.list = { ...LIST, job_id: null, jobs: null, quote_id: "q1" };
    db.items = [];
    const text = textOf(await listPage("es"));
    expect(text).toContain("Esta lista pertenece a una cotización — la oficina la lleva.");
    expect(text).toContain("No hay artículos en esta lista.");
    expect(text).not.toContain("the office keeps it");
  });

  it("English is unchanged", async () => {
    const html = await listPage("en");
    const text = textOf(html);
    expect(text).toContain("Back to Material Lists");
    expect(text).toContain("Created Oct 20, 2026");
    expect(buttons(html)).toContain("Took From Stock");
    expect(buttons(html)).toContain("Tell The Office");
    expect(html).toContain('placeholder="Add an item…"');
    expect(text).toContain("Bought (1)");
    expect(text).toContain("1 to buy");
    db.list = { ...LIST, job_id: null, jobs: null, quote_id: "q1" };
    db.items = [];
    const ro = textOf(await listPage("en"));
    expect(ro).toContain("This list belongs to a quote — the office keeps it.");
    expect(ro).toContain("No items on this list.");
  });
});

describe("the index (materials) in Spanish", () => {
  it("a tech's index: the headline, what is left to buy on each card, and the date", async () => {
    const text = textOf(await indexPage("es"));
    expect(text).toContain("Listas de materiales");
    expect(text).toContain("La lista de materiales de cada trabajo — la misma que ve la oficina.");
    expect(text).toContain("1 por comprar");
    expect(text).toContain("Aún Sin Artículos");
    expect(text).toContain("20 oct 2026");
    expect(text).not.toContain("to buy");
    expect(text).not.toContain("No Items Yet");
    db.lists = [];
    const empty = textOf(await indexPage("es"));
    expect(empty).toContain("Aún no hay listas de materiales");
    expect(empty).toContain("La lista de un trabajo empieza en cuanto alguien agrega el primer artículo en su pestaña de Materiales.");
  });

  it("English is unchanged", async () => {
    const text = textOf(await indexPage("en"));
    expect(text).toContain("Material lists");
    expect(text).toContain("Each job's materials list — the same one the office sees.");
    expect(text).toContain("1 to buy");
    expect(text).toContain("No Items Yet");
    expect(text).toContain("Oct 20, 2026");
    db.lists = [];
    const empty = textOf(await indexPage("en"));
    expect(empty).toContain("No material lists yet");
    expect(empty).toContain("A job's list starts the moment somebody adds the first item on its Materials tab.");
  });
});
