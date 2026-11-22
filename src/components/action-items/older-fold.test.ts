import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }) }));
vi.mock("@/components/toast", () => ({ useToast: () => vi.fn() }));
vi.mock("@/lib/action-items/dispatch", () => ({ dispatchAction: vi.fn() }));
vi.mock("@/components/supplier-paper-cards", () => ({ SupplierPaperCards: () => null, SUPPLIER_PAPERS_SCOPE: "my-day" }));
vi.mock("@/components/move-to-day", () => ({ MoveToDay: ({ children }: { children: unknown }) => children as never }));
vi.mock("@/components/send-sheet", () => ({ SendSheet: () => null }));

import { ActionList } from "./action-list";
import { LangProvider } from "@/components/lang-provider";
import { AFFORDANCES, KIND_GROUP, type ActionItem, type ActionKind } from "@/lib/action-items/types";
import { translator } from "@/lib/i18n";
import type { Lang } from "@/lib/locale";

/**
 * THE OLDER FOLD, DRAWN (cn-v1175). The owner's pick: a visit, write-up or unsent draft that has waited
 * thirty days stops being counted and moves to a grey Older fold, still listed with its buttons. Shut at
 * first, grey (never amber), at the bottom of the board, its count its things; drawn even when nothing
 * else is open. Every name is a stand-in.
 */
const TODAY = "2026-11-21";
const row = (kind: ActionKind, id: string, o: Partial<ActionItem> = {}): ActionItem => ({
  id,
  kind,
  group: KIND_GROUP[kind],
  level: "none",
  title: `${kind} ${id}`,
  who: "Dana Rook",
  when: "2026-09-20T17:00:00Z",
  urgency: 0,
  done: false,
  href: `/x/${id}`,
  affordances: AFFORDANCES[kind],
  ...o,
});
const olderPile = (): ActionItem =>
  row("appointment", "pile:visits_to_close_out:older", {
    older: true,
    affordances: ["open"],
    pile: { name: "visits_to_close_out", label: "Visits to Close Out", count: 4, capped: false, listHref: null, listLabel: null, verb: "Close Out" },
    children: ["a1", "a2", "a3", "a4"].map((id) => row("appointment", id, { older: true })),
  });
const draw = (items: ActionItem[], older: ActionItem[], lang: Lang = "en") =>
  renderToStaticMarkup(
    createElement(LangProvider, {
      lang,
      children: createElement(ActionList, { items, older, todayStr: TODAY, tz: "America/Los_Angeles", isStaff: true, title: translator(lang)("md_needsYou") }),
    }),
  );

describe("the Older fold", () => {
  it("is shut, grey, counts its things, and sits under the board's rows, in both languages", () => {
    for (const lang of ["en", "es"] as const) {
      const html = draw([row("inquiry", "lead-1", { level: "soon", clock: TODAY })], [olderPile(), row("quote_draft", "qdraft-9", { older: true })], lang);
      const at = html.indexOf('data-older=""');
      expect(at).toBeGreaterThan(html.indexOf('data-group='));
      const fold = html.slice(at);
      expect(fold).toContain(`${translator(lang)("ny_older")} <span class="text-slate-500" data-older-count="5">(5)</span>`);
      expect(fold).toContain('aria-expanded="false"');
      // Shut: its rows and its line are not drawn yet.
      expect(fold).not.toContain('data-row="a1"');
      expect(fold).not.toContain(translator(lang)("ny_olderWhy"));
      expect(fold).not.toMatch(/amber|red-/);
      // Counted by no number: the header says the one lead only.
      expect(html.slice(0, at)).toContain('data-count="soon"');
      expect(html.slice(0, at)).not.toContain('data-count="more"');
    }
    expect(translator("en")("ny_older")).toBe("Older");
    expect(translator("es")("ny_older")).toBe("Más Antiguos");
  });

  it("an emptied board with only older rows still draws it, under the empty sentence", () => {
    const html = draw([], [row("appointment", "appt-1", { older: true })]);
    expect(html).toContain(translator("en")("md_nothingNeedsYou"));
    expect(html.indexOf('data-older=""')).toBeGreaterThan(html.indexOf(translator("en")("md_nothingNeedsYou")));
    expect(html).toContain('data-older-count="1"');
    expect(html).not.toContain("data-counts");
  });

  it("draws nothing when nothing is older", () => {
    expect(draw([row("inquiry", "lead-1")], [])).not.toContain("data-older");
  });

  it("is never remounted by a row's action: its open state is plain state, and its rows go through the board's own draw", () => {
    const src = readFileSync(join(process.cwd(), "src/components/action-items/action-list.tsx"), "utf8");
    expect(src).toContain("const [olderOpen, setOlderOpen] = useState(false);");
    expect(src).toContain("{olderRows.map((r) => draw(r.item))}");
    expect(src).not.toMatch(/key=\{[^}]*older/i);
  });
});
