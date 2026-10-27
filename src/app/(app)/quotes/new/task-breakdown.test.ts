import { describe, it, expect, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * THE TASK IS THE LINE, ON THE BUILDER (0386). A line that carries a breakdown shows its labor and
 * parts under the description and ASKS where a number is missing; a line without one renders
 * exactly as before. The rate the hours price at comes through THE one rule (laborRateFor) from the
 * org default the page hands in — pinned at the source, because a builder that forgets the prop
 * still compiles and prices every task's hours at $0 while saying "no company labor rate set".
 *
 * LABOR IS ONE ROW PER RATE (cn-v1131). Erik: "im curious how to add time at a different pay rate
 * and i noticed the 145 on there and i thought i had updated that in the backend to 135". Each row
 * names who (Labor · a person · his own word), asks its hours, and says beside the figure where it
 * came from — "company default", "<name>'s rate", "typed", "from the scope".
 */
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/quotes/new",
}));
vi.mock("@/components/toast", () => ({ useToast: () => vi.fn() }));
vi.mock("@/components/ui/modal", () => ({
  Modal: ({ children, footer }: { children?: ReactNode; footer?: ReactNode }) => createElement("div", { "data-modal": "" }, children, footer),
  ModalActions: () => null,
}));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
vi.mock("./actions", () => ({
  saveQuote: vi.fn(),
  generateQuoteDraft: vi.fn(),
  generateQuoteDraftFromLeadPlans: vi.fn(),
  generateQuoteDraftFromPlan: vi.fn(),
  generateQuoteDraftFromSupplier: vi.fn(),
}));
vi.mock("../price-list/actions", () => ({ applyPriceBookReview: vi.fn() }));
vi.mock("../../price-list/kit-actions", () => ({ rememberTaskAsKit: vi.fn() }));
vi.mock("@/components/new-customer-inline", () => ({ NewCustomerInline: () => null }));
// THE RESTORE DOOR, DRIVEN WITHOUT A DOM. useDraft rehydrates in an effect, and react-dom/server never
// runs one; this stand-in hands the slot's draft to the builder's OWN restore callback during its first
// render (a render-phase state update, which React re-renders at once), once per render pass. What the
// test sees is then the builder as it stands after a reload with that draft in sessionStorage.
const draftSlot = vi.hoisted(() => ({ draft: null as Record<string, unknown> | null, handed: false }));
vi.mock("@/lib/use-draft", () => ({
  useDraft: (_key: string, _state: unknown, setState: (d: unknown) => void) => {
    if (draftSlot.draft && !draftSlot.handed) {
      draftSlot.handed = true;
      setState(draftSlot.draft);
    }
    return { restored: !!draftSlot.draft, clear: vi.fn() };
  },
}));
const withDraft = (draft: Record<string, unknown>, render: () => string): string => {
  draftSlot.draft = draft;
  draftSlot.handed = false;
  try {
    return render();
  } finally {
    draftSlot.draft = null;
    draftSlot.handed = false;
  }
};

const { QuoteBuilder } = await import("./quote-builder");

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");
// The words as a person reads them: tags gone, the server's entity escapes undone (an apostrophe
// renders as &#x27;).
const text = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
// The company default is $145/h on every render here, so a rule row's chip can name its source.
const builder = (p: Record<string, unknown> = {}) =>
  renderToStaticMarkup(createElement(QuoteBuilder as any, { customers: [], taxRates: [], salesTax: false, defaultLaborRate: 145, ...p }));

const rule = { label: null, person_id: null, hours: null, rate: 145, rate_from: "rule" as const };
const taskLine = {
  description: "Install transfer switch",
  quantity: 1,
  unit: "ea",
  unit_price: 480,
  flag: "hours? · price? a 50 amp breaker",
  detail: {
    task_id: "t1",
    labor: [rule],
    units: null,
    kit_id: null,
    materials: [
      { code: "R1", name: "Transfer switch, 200A", qty: 1, cost: 400, sell: 480 },
      { code: null, name: "a 50 amp breaker", qty: null, cost: null, sell: null },
    ],
  },
};
const people = [
  { id: "p1", name: "Snowbell", billRate: 135 },
  { id: "p2", name: "Larkspur", billRate: null },
];

describe("a task line on the builder", () => {
  it("shows the breakdown: one labor row asks its hours at the rule's rate, each part has a count and a price box, and the sums read", () => {
    const html = builder({ seededLines: [taskLine] });
    expect(html).toContain('aria-label="Who"');
    expect(html).toContain('placeholder="hours?"');
    expect(text(html)).toContain("× $145.00/h · company default");
    expect(html).toContain('placeholder="Part"');
    expect(html).toContain('value="Transfer switch, 200A"');
    expect(html).toContain('value="a 50 amp breaker"');
    expect((html.match(/placeholder="how many"/g) ?? []).length).toBe(2);
    expect((html.match(/placeholder="price\?"/g) ?? []).length).toBe(2);
    expect(html).toContain('aria-label="Remove This Part"');
    expect(html).toContain("Add A Part");
    expect(text(html)).toContain("Add Labor At Another Rate");
    // The first row is the task's labor: it never offers to leave.
    expect(html).not.toContain('aria-label="Remove This Labor"');
    expect(text(html)).toContain("Parts $480.00");
    // The flag still rides the line, and a breakdown that adds up prints no hand-price note.
    expect(text(html)).toContain("hours? · price? a 50 amp breaker");
    expect(text(html)).not.toContain("Price set by hand");
  });

  it("two rows at two rates render two chips with their source words; a person row says <name>'s rate", () => {
    const line = {
      ...taskLine,
      unit_price: 905, // 2 h × $145 + 1 h × $135 + $480 of parts
      flag: "price? a 50 amp breaker",
      detail: {
        ...taskLine.detail,
        labor: [
          { ...rule, hours: 2 },
          { label: null, person_id: "p1", hours: 1, rate: 135, rate_from: "rule" as const },
        ],
      },
    };
    const html = builder({ seededLines: [line], people });
    const t = text(html);
    expect(t).toContain("× $145.00/h · company default");
    expect(t).toContain("× $135.00/h · Snowbell's rate");
    // Each row's money, and the labor sum once there is more than one row.
    expect(t).toContain("$290.00");
    expect(t).toContain("$135.00");
    expect(t).toContain("Labor $425.00");
    // The second row can go; the first cannot.
    expect((html.match(/aria-label="Remove This Labor"/g) ?? []).length).toBe(1);
    // The Who select offers Labor, every active person, and his own word.
    expect(html).toContain(">Labor</option>");
    expect(html).toContain('value="person:p1"');
    expect(html).toContain(">Snowbell</option>");
    expect(html).toContain(">Larkspur</option>");
    expect(html).toContain('value="other"');
    expect(t).not.toContain("Price set by hand");
  });

  it("a typed rate says typed, a dictated one says from the scope, an old one-figure row says only what it was quoted at", () => {
    const line = {
      ...taskLine,
      unit_price: 1045, // 2 × 200 + 1 × 150 + 0.1 × 145 + 480 parts = 1044.5 → the paper rounds; use 1 h legacy
      detail: {
        ...taskLine.detail,
        labor: [
          { label: null, person_id: null, hours: 2, rate: 200, rate_from: "hand" as const },
          { label: "2-man crew", person_id: null, hours: 1, rate: 150, rate_from: "stated" as const },
          { label: null, person_id: null, hours: 1, rate: 145, rate_from: "legacy" as const },
        ],
      },
    };
    const t = text(builder({ seededLines: [{ ...line, unit_price: 1175 }], people }));
    expect(t).toContain("× $200.00/h · typed");
    expect(t).toContain("× $150.00/h · from the scope");
    expect(t).toContain("quoted at $145.00/h");
    // His own word for who sits in its box, and the row's Who select reads Other.
    expect(builder({ seededLines: [{ ...line, unit_price: 1175 }], people })).toContain('value="2-man crew"');
    expect(t).not.toContain("Price set by hand");
  });

  it("a row priced for somebody who has left the team keeps a row to sit on (Title Case, an option), and its chip says the rule has moved on", () => {
    const line = { ...taskLine, unit_price: 615, detail: { ...taskLine.detail, labor: [{ label: null, person_id: "gone", hours: 1, rate: 135, rate_from: "rule" as const }] } };
    const html = builder({ seededLines: [line], people });
    expect(html).toContain('value="person:gone"');
    expect(text(html)).toContain("Someone No Longer On The Team");
    // Nobody on the team prices this row now, so the rule's answer is the no-person one: the chip says so.
    expect(text(html)).toContain("quoted at $135.00/h · the rule says $145.00/h now");
  });

  it("A RULE ROW THE RULE HAS LEFT BEHIND (the skeptic's S2): a draft saved at $145 after the default moved to $135 says what it was quoted at and what the rule says now — never 'company default' beside a figure that is not", () => {
    // The seed carries its rate and the effect never runs on the first render: the stored 145 stands.
    const t = text(builder({ seededLines: [{ ...taskLine, detail: { ...taskLine.detail, labor: [{ ...rule, hours: 2 }] }, unit_price: 770 }], defaultLaborRate: 135 }));
    expect(t).toContain("quoted at $145.00/h · the rule says $135.00/h now");
    expect(t).not.toContain("× $145.00/h · company default");
    // When they agree the chip reads as before; with no rate set at all the rule says so.
    expect(text(builder({ seededLines: [taskLine] }))).toContain("× $145.00/h · company default");
    expect(text(builder({ seededLines: [taskLine], defaultLaborRate: 0 }))).toContain("quoted at $145.00/h · the rule says no rate now");
    // The way back is offered to such a row too (beside the box when the chip is open): by the rule's name.
    const src = read("src/app/(app)/quotes/new/quote-builder.tsx");
    expect(src).toContain("const back = cents(live.rate) !== row.rate ? backWords(live) : null;");
    expect(src).toContain('setLabor(i, { rate: cents(live.rate), rate_from: "rule" });');
  });

  it("A DRAFT SAVED BY AN OLDER BUILD (the skeptic's B1): the one-figure {hours, rate} shape restores as ONE legacy row and the breakdown renders instead of throwing", () => {
    const oldShape = {
      description: "Install transfer switch",
      quantity: 1,
      unit: "ea",
      unit_price: 3380,
      flag: "stale words from the old build",
      detail: { task_id: "t-old", hours: 20, rate: 145, hours_from_kit: false, units: null, kit_id: null, materials: [{ code: "R1", name: "Transfer switch, 200A", qty: 1, cost: 400, sell: 480 }] },
    };
    const draft = { customerId: "", leadId: "", docType: "estimate", title: "Larkspur panel", description: "", notes: "", taxRate: 0, taxChoice: "", validUntil: "", items: [oldShape], scope: "", proposed: [{ ...oldShape, pid: 1, keep: true }], questions: [], quoteId: "" };
    const html = withDraft(draft, () => builder({ companyEstimateFormat: "tasks" }));
    // The draft came back: its title, its line, and the breakdown under it.
    expect(html).toContain('value="Larkspur panel"');
    expect(html).toContain('value="Install transfer switch"');
    expect(html).toContain('aria-label="Who"');
    expect(html).toContain('aria-label="Hours"');
    expect(html).toContain('value="20"');
    expect(text(html)).toContain("quoted at $145.00/h"); // the legacy row, with no source words to claim
    expect(html).toContain('value="Transfer switch, 200A"');
    // The flag is build-time only and was rebuilt from the breakdown (nothing asks here): the stale words are gone.
    expect(text(html)).not.toContain("stale words from the old build");
    // His price stands: 20 × 145 + 480 = 3380 explains the line, so no hand-price note.
    expect(text(html)).not.toContain("Price set by hand");
    // Both lists come back through the one reader; the format restores with the draft when it carries one.
    const src = read("src/app/(app)/quotes/new/quote-builder.tsx");
    expect(src).toContain("if (Array.isArray(d.items) && d.items.length) setItems(d.items.map(coerceDraftLine));");
    expect(src).toContain("if (Array.isArray(d.proposed) && d.proposed.length) setProposed(d.proposed.map(coerceDraftLine));");
  });

  it("a Unit $ typed over the sum says the breakdown stays off the paper", () => {
    const html = builder({ seededLines: [{ ...taskLine, unit_price: 450 }] });
    expect(text(html)).toContain("Price set by hand — the breakdown stays off the paper");
  });

  it("a line without a breakdown renders exactly as before, with the one door to become a task", () => {
    const plain = builder({ seededLines: [{ description: "Permit", quantity: 1, unit: "ea", unit_price: 250 }] });
    expect(plain).not.toContain('placeholder="hours?"');
    expect(plain).not.toContain("Add A Part");
    expect(text(plain)).toContain("Make This A Task");
    expect(builder({ seededLines: [{ description: "Permit", quantity: 1, unit: "ea", unit_price: 250, detail: null }] })).toBe(plain);
    // A task line already is one.
    expect(text(builder({ seededLines: [taskLine] }))).not.toContain("Make This A Task");
  });
});

describe("Add A Task and Make This A Task", () => {
  const src = read("src/app/(app)/quotes/new/quote-builder.tsx");
  it("both buttons are on the screen, Title Case, beside Add A Line", () => {
    const html = builder();
    const t = text(html);
    expect(t).toContain("Add A Task");
    expect(t).toContain("Add A Line");
    expect(t).not.toMatch(/\bAdd\s*<\/button>/);
  });
  it("Add A Task starts from emptyTaskDetail at the rule's rate under Tasks and focuses the name; Make This A Task goes through taskFromLine", () => {
    // The render cannot press the buttons (no DOM), so the two doors are pinned at the source.
    expect(src).toContain("const detail = emptyTaskDetail(rule);");
    expect(src).toContain('setItems((p) => [...p, { description: "", quantity: 1, unit: "ea", unit_price: 0, group: "Tasks", detail, flag: taskFlags(detail) }]);');
    expect(src).toContain("setFocusIdx(items.length);");
    expect(src).toContain("autoFocus={focusIdx === idx}");
    expect(src).toContain("setItems((p) => p.map((l, i) => (i === idx ? taskFromLine(l, rule) : l)));");
  });
});

describe("the rate reaches the builder through the one rule", () => {
  it("the page hands in the org default and the team, and the builder resolves the rule with laborRateFor's object form", () => {
    const page = read("src/app/(app)/quotes/new/page.tsx");
    const tag = page.slice(page.indexOf("<QuoteBuilder"), page.indexOf("/>", page.indexOf("<QuoteBuilder")));
    expect(tag).toContain("defaultLaborRate={settings.default_labor_rate}");
    expect(tag).toContain("people={people}");
    expect(tag).toContain("companyEstimateFormat={companyEstimateFormat}");
    // The team off the same view the job's labor billing reads its rates from — never their pay rate.
    expect(page).toContain('supabase.from("profile_pay").select("id, full_name, bill_rate").eq("active", true).order("full_name")');
    expect(page).toContain("laborRateFor({ levelRate: seedCustomer?.pricing_levels?.labor_rate, orgDefault: settings.default_labor_rate }).rate");
    const src = read("src/app/(app)/quotes/new/quote-builder.tsx");
    expect(src).toContain('import { laborRateFor, laborRateFromWords, type LaborRateFrom } from "@/lib/pricing/labor-rate";');
    expect(src).toContain("const rule = laborRateFor({ levelRate, orgDefault: defaultLaborRate });");
    // A row's own rule: the person's Team rate on top of the estimate's two rungs.
    expect(src).toContain("laborRateFor({ personRate: person?.billRate, levelRate, orgDefault: defaultLaborRate })");
    // Every edit of the breakdown re-prices through lineFromDetail; a change of the rule's answer
    // through the one pure pass (lib/estimate/reprice-rows, driven in its own file), keyed on every
    // input of the rule, never over a hand-set price.
    expect(src).toContain("onChange(lineFromDetail(line, next))");
    expect(src).toContain("l.detail && detailExplains(l.detail, l) ? repriceRows(l, ruleNow, prevRate) : l");
    expect(src).toContain("}, [ruleKey]);");
    // Typing a rate makes it his; typing hours makes them his (the kit's mark comes off that row).
    expect(src).toContain('setLabor(i, { rate: n > 0 ? n : 0, rate_from: "hand" })');
    expect(src).toContain("const { from_kit: _k, ...rest } = r;");
    // A Who pick goes through rowForWho: a rule or legacy row re-asks the rule; a typed or dictated rate stands.
    expect(src).toContain("setLabor(i, rowForWho(row, who, ruleInputs));");
  });
});

describe("the paper switch (Labor And Parts On The Paper)", () => {
  it("sits by the totals, seeded from the adopted draft, and rides the payload and the session draft", () => {
    const html = builder({ companyEstimateFormat: "tasks" });
    const t = text(html);
    expect(t).toContain("Labor And Parts On The Paper");
    expect(t).toContain("Company Default · Off");
    expect(text(builder({ companyEstimateFormat: "detailed" }))).toContain("Company Default · On");
    const src = read("src/app/(app)/quotes/new/quote-builder.tsx");
    expect(src).toContain('import { PaperFormatSwitch } from "../paper-format-switch";');
    expect(src).toContain('adoptedSeed?.estimateFormat === "tasks" || adoptedSeed?.estimateFormat === "detailed" ? adoptedSeed.estimateFormat : null');
    // Sent only when it changed from what the row holds (saveQuote writes it as one more statement).
    expect(src).toContain("estimate_format: h.estimateFormat === formatSavedRef.current ? undefined : h.estimateFormat,");
    expect(src).toContain("noteFormatSaved(payload, res.id);");
    expect(src).toMatch(/if \(payload\.estimate_format !== undefined\) formatSavedRef\.current = payload\.estimate_format;\s*else if \(payload\.id !== landedId\) formatSavedRef\.current = null;/);
    expect(src).toMatch(/\(\) => \(\{ customerId, leadId, docType, estimateFormat, title/);
    expect(src).toContain('if (d.estimateFormat === "tasks" || d.estimateFormat === "detailed" || d.estimateFormat === null) setEstimateFormat(d.estimateFormat);');
    // The page selects the draft's own format with the draft (and adopts without it before 0395 lands).
    const page = read("src/app/(app)/quotes/new/page.tsx");
    expect(page).toContain('${withFormat ? ", estimate_format" : ""}');
    expect(page).toContain('estimateFormat: ex.estimate_format === "tasks" || ex.estimate_format === "detailed" ? ex.estimate_format : null,');
    expect(page).toContain("const companyEstimateFormat = normalizeDocStyle(settings.doc_style).estimate_format;");
  });
});

describe("Remember As A Kit (W4)", () => {
  it("a task line offers the door; a line built from a kit names the kit and its units instead", () => {
    const html = builder({ seededLines: [taskLine] });
    expect(text(html)).toContain("Remember As A Kit");
    const kitLabor = [{ ...rule, hours: 14 }];
    const fromKit = builder({
      seededLines: [{ ...taskLine, description: "Footings ×7", unit_price: 2510, detail: { ...taskLine.detail, labor: kitLabor, units: 7, kit_id: "k1" } }],
      taskKits: [{ id: "k1", name: "Footing", labor_minutes: 120, unit: "footing", items: [] }],
    });
    expect(text(fromKit)).toContain("From the kit Footing · Units");
    expect(fromKit).toContain('aria-label="Units"');
    expect(fromKit).toContain('value="7"');
    expect(text(fromKit)).toContain("footing");
    // Typed hours (no kit mark on the row) stand; the kit's parts follow the units.
    expect(text(fromKit)).toContain("your hours stand; the kit’s parts follow the units");
    expect(text(fromKit)).not.toContain("Remember As A Kit");
    // The kit left the price list: the line still says where it came from, with no box to re-derive it.
    const gone = builder({
      seededLines: [{ ...taskLine, description: "Footings ×7", unit_price: 2510, detail: { ...taskLine.detail, labor: kitLabor, units: 7, kit_id: "k1" } }],
      taskKits: [],
    });
    expect(text(gone)).toContain("From the kit it was built from (no longer in your kits) · ×7");
    expect(gone).not.toContain('aria-label="Units"');
  });

  it("a plain line has no door, and the company's Kits switch off hides it", () => {
    expect(text(builder({ seededLines: [{ description: "Permit", quantity: 1, unit: "ea", unit_price: 250 }] }))).not.toContain("Remember As A Kit");
    expect(text(builder({ seededLines: [taskLine], kitsOn: false }))).not.toContain("Remember As A Kit");
  });
});
