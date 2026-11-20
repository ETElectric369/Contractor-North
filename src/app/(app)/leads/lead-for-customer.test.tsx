import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * A NEW LEAD FOR A CUSTOMER ALREADY ON FILE (cn-v1173). The owner, 2026-11-19: "i would like to promote
 * the workflow starting with new lead which could be an existing client with a new job but it gets the
 * information in the right place". The customer's page hands the Leads page's own form the customer:
 * the form starts from them and posts their id, and createInquiry links THAT customer when a read on the
 * caller's own session finds it. An id that reads nothing falls back to the name match; nothing posted
 * is today's door, byte for byte.
 */
type Row = Record<string, any>;
type Call = { table: string; op: "select" | "insert"; cols?: string; patch?: Row; filters: [string, string, unknown][] };

const db = vi.hoisted(() => ({ calls: [] as Call[], customers: [] as Row[], failIdRead: false }));

function builder(table: string) {
  const call: Call = { table, op: "select", filters: [] };
  db.calls.push(call);
  const run = (single: boolean) => {
    if (table === "profiles") return { data: { language: "en" }, error: null };
    if (call.op === "insert") return { data: { id: "new-1" }, error: null };
    if (table === "customers") {
      if (db.failIdRead && call.filters.some(([m, k]) => m === "eq" && k === "id")) return { data: null, error: { message: "connection reset" } };
      // The stand-in's RLS: only this company's customers are ever read.
      const rows = db.customers.filter((c) => call.filters.every(([m, k, v]) => m !== "eq" || c[k] === v));
      return { data: single ? (rows[0] ?? null) : rows, error: null };
    }
    return { data: single ? null : [], error: null };
  };
  const b: any = {
    select: (cols?: string) => ((call.cols = cols), b),
    insert: (p: Row) => ((call.op = "insert"), (call.patch = p), b),
    maybeSingle: async () => run(true),
    single: async () => run(true),
    then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(run(false)).then(ok, bad),
  };
  for (const m of ["eq", "neq", "in", "is", "or", "not", "gte", "lt", "order", "limit"]) b[m] = (k: string, v: unknown) => (call.filters.push([m, k, v]), b);
  return b;
}
const client = () => ({ from: (t: string) => builder(t), auth: { getUser: async () => ({ data: { user: { id: "office-1" } } }) } });

const revalidated = vi.hoisted(() => [] as string[]);
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => client()), createServiceClient: vi.fn(() => client()) }));
vi.mock("@/lib/staff-guard", () => ({ requireStaff: async () => ({ supabase: client(), userId: "office-1", orgId: "org-1" }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn((p: string) => revalidated.push(p)), revalidateTag: vi.fn() }));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({ rateLimited: async () => false }));
vi.mock("../schedule/actions", () => ({ planDayTimes: vi.fn() }));
vi.mock("../quotes/actions", () => ({ saveQuote: vi.fn() }));
vi.mock("@/lib/plan-brief-run", () => ({ runPlanBrief: vi.fn() }));

import { createInquiry } from "./actions";
import { reportError } from "@/lib/observe";

const SAM = { id: "c-sam", name: "Sam Tillery", phone: "(530) 555-0100", email: "sam@example.test", address: "4 Larkspur Ln", city: "Thistlewood", state: "CA", zip: "96161", company_name: "Snowbell Builders" };
// A second Sam Tillery: by name alone the app must not choose between them.
const SAM_TWO = { id: "c-sam-2", name: "Sam Tillery", phone: null, email: null, address: "9 Catbird Ct", city: "Bayberry", state: "CA", zip: "96150", company_name: null };
const DANA = { id: "c-dana", name: "Dana Rook", phone: "(530) 555-0199", email: null, address: "12 Bayberry Rd", city: "Thistlewood", state: "CA", zip: "96161", company_name: null };

const form = (f: Record<string, string>) => {
  const d = new FormData();
  for (const [k, v] of Object.entries(f)) d.set(k, v);
  return d;
};
const inserted = () => db.calls.find((c) => c.table === "inquiries" && c.op === "insert")!.patch!;
const customerReads = () => db.calls.filter((c) => c.table === "customers");

beforeEach(() => {
  db.calls = [];
  db.customers = [SAM, SAM_TWO, DANA];
  db.failIdRead = false;
  revalidated.length = 0;
  vi.mocked(reportError).mockClear();
});

describe("createInquiry: a posted customer id", () => {
  it("links THAT customer, skips the name match, carries what the form left empty, and says Linked to …", async () => {
    // Two Sam Tillerys on file: a name match would link neither. The posted id is the one he started from.
    const res = await createInquiry(form({ customer_id: "c-sam", name: "Sam Tillery", message: "A second deck" }));
    expect(res).toMatchObject({ ok: true, id: "new-1" });
    expect(res.note).toBe("Linked to Sam Tillery — brought their phone, email, address, city, state, ZIP and company across.");
    expect(inserted()).toMatchObject({ customer_id: "c-sam", phone: "(530) 555-0100", email: "sam@example.test", address: "4 Larkspur Ln", city: "Thistlewood", zip: "96161", company_name: "Snowbell Builders", message: "A second deck" });
    // One read, by that id; no read of every customer for a name match.
    expect(customerReads()).toHaveLength(1);
    expect(customerReads()[0].filters).toContainEqual(["eq", "id", "c-sam"]);
    expect(customerReads()[0].filters.some(([m]) => m === "limit")).toBe(false);
    // The customer's page lists their leads: it is woken too.
    expect(revalidated).toEqual(expect.arrayContaining(["/leads", "/planner", "/crm/c-sam"]));
  });

  it("what was typed still wins: the form's own values stay, the carry fills only the empty ones", async () => {
    const res = await createInquiry(form({ customer_id: "c-sam", name: "Sam Tillery", phone: "(530) 555-0111", address: "7 Catbird Ct", city: "Bayberry" }));
    expect(res.ok).toBe(true);
    const row = inserted();
    expect(row).toMatchObject({ customer_id: "c-sam", phone: "(530) 555-0111", address: "7 Catbird Ct", city: "Bayberry", email: "sam@example.test" });
    // A place he named is his, whole: none of the customer's place is carried under it.
    expect(row.zip).toBeNull();
  });

  it("a form already seeded from the customer carries nothing and still says it is linked", async () => {
    const res = await createInquiry(form({ customer_id: "c-dana", name: "Dana Rook", phone: "(530) 555-0199", address: "12 Bayberry Rd", city: "Thistlewood", state: "CA", zip: "96161" }));
    expect(res.note).toBe("Linked to Dana Rook.");
    expect(inserted()).toMatchObject({ customer_id: "c-dana" });
  });

  it("an id that reads nothing (gone, merged, another company's) is ignored: the name match runs as before", async () => {
    const res = await createInquiry(form({ customer_id: "c-nobody", name: "Dana Rook" }));
    expect(inserted()).toMatchObject({ customer_id: "c-dana", phone: "(530) 555-0199" });
    expect(res.note).toContain("Linked to Dana Rook");
    expect(customerReads()).toHaveLength(2);
    expect(revalidated).toContain("/crm/c-dana");
    // …and an unknown id with an ambiguous name links neither, and says so.
    db.calls = [];
    const two = await createInquiry(form({ customer_id: "c-nobody", name: "Sam Tillery" }));
    expect(inserted().customer_id).toBeNull();
    expect(two.note).toContain("2");
  });

  it("a read of the posted id that FAILS is filed (a tag, no person's data), then the name match runs as for an id that reads nothing", async () => {
    db.failIdRead = true;
    const res = await createInquiry(form({ customer_id: "c-dana", name: "Dana Rook" }));
    expect(res.ok).toBe(true);
    expect(reportError).toHaveBeenCalledTimes(1);
    const [tag, err, extra] = vi.mocked(reportError).mock.calls[0];
    expect(tag).toBe("leads:create:posted-customer");
    expect(err).toEqual({ message: "connection reset" });
    expect(extra).toBeUndefined();
    // The fallback: the name match over the book links the one Dana Rook.
    expect(customerReads()).toHaveLength(2);
    expect(inserted()).toMatchObject({ customer_id: "c-dana" });
  });

  it("an id that reads nothing reports nothing (it is not a failure)", async () => {
    await createInquiry(form({ customer_id: "c-nobody", name: "Dana Rook" }));
    expect(reportError).not.toHaveBeenCalled();
  });

  it("nothing posted: today's door (the name match alone, no id read)", async () => {
    await createInquiry(form({ name: "Dana Rook" }));
    expect(inserted()).toMatchObject({ customer_id: "c-dana" });
    expect(customerReads()).toHaveLength(1);
    expect(customerReads()[0].filters.some(([m, k]) => m === "eq" && k === "id")).toBe(false);
    db.calls = [];
    revalidated.length = 0;
    await createInquiry(form({ name: "Casey Loam" }));
    expect(inserted().customer_id).toBeNull();
    expect(revalidated).toEqual(["/leads", "/planner"]);
  });
});

describe("the form, started from the customer (static render, both languages)", async () => {
  vi.doMock("next/navigation", () => ({
    useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn(), back: vi.fn() }),
    useSearchParams: () => new URLSearchParams("new=1"),
    usePathname: () => "/crm/c-sam",
  }));
  vi.doMock("@/components/toast", () => ({ useToast: () => () => {} }));
  vi.doMock("@/lib/use-draft", () => ({ useDraft: () => ({ restored: false, clear: () => {} }) }));
  vi.doMock("./lead-sources-actions", () => ({ readLeadSources: vi.fn(async () => ({ ok: true, sources: [] })) }));
  const { InquiryFields, customerLeadFormValue, inquiryFormValue } = await import("./inquiry-fields");
  const { LangProvider } = await import("@/components/lang-provider");
  const { InquiryModal } = await import("./inquiry-modal");
  const draw = (lang: "en" | "es") =>
    renderToStaticMarkup(createElement(LangProvider, { lang, children: createElement(InquiryFields, { value: customerLeadFormValue(SAM), onChange: () => {}, sources: [] }) }));

  it("the person block holds the customer; the rest starts blank", () => {
    expect(customerLeadFormValue(SAM)).toEqual({
      ...inquiryFormValue(),
      name: "Sam Tillery",
      company_name: "Snowbell Builders",
      phone: "(530) 555-0100",
      email: "sam@example.test",
      address: "4 Larkspur Ln",
      city: "Thistlewood",
      state: "CA",
      zip: "96161",
      // The customer's street with its town reads as the grey line. In this door it is a SUGGESTION:
      // the modal hands the block seededTownIsSuggestion, so typing a different street drops this town
      // (the cn-v1173 fixer; see person-fields-seeded.test.tsx).
      town_picked: true,
    });
  });

  for (const lang of ["en", "es"] as const) {
    it(`${lang}: drawn with the customer's name, business, phone, email, street and stored town, all posted`, () => {
      const html = draw(lang);
      expect(html).toMatch(/<input[^>]*name="name"[^>]*value="Sam Tillery"|<input[^>]*value="Sam Tillery"[^>]*name="name"/);
      expect(html).toContain('type="hidden" name="company_name" value="Snowbell Builders"');
      expect(html).toContain("sam@example.test");
      expect(html).toContain("4 Larkspur Ln");
      for (const [k, v] of [["city", "Thistlewood"], ["state", "CA"], ["zip", "96161"]]) expect(html).toContain(`name="${k}" value="${v}"`);
      expect(html).toContain("Thistlewood, CA 96161");
      // The Business box is open (it holds something), so its link is not drawn.
      expect(html).not.toContain(lang === "en" ? ">Business</button>" : ">Negocio</button>");
    });
  }

  it("the modal's trigger is the Leads page's own New Lead, in both languages", () => {
    const en = renderToStaticMarkup(createElement(InquiryModal, { customer: SAM }));
    expect(en).toMatch(/<\/svg> New Lead<\/button>/);
    const es = renderToStaticMarkup(createElement(LangProvider, { lang: "es", children: createElement(InquiryModal, { customer: SAM }) }));
    expect(es).toMatch(/<\/svg> Nuevo Prospecto<\/button>/);
  });

  it("source: posts the id, never answers ?new=1, keeps its own draft, lands on the lead's file, never keys the Modal", () => {
    const src = readFileSync(join(process.cwd(), "src/app/(app)/leads/inquiry-modal.tsx"), "utf8");
    expect(src).toContain('{forCustomer && <input type="hidden" name="customer_id" value={forCustomer.id} />}');
    expect(src).toContain("const forCustomer = !editing && customer ? customer : null;");
    expect(src).toContain("(forCustomer ? customerLeadFormValue(forCustomer) : inquiryFormValue(inquiry))");
    expect(src).toMatch(/useEffect\(\(\) => \{\s*if \(editing \|\| forCustomer\) return;\s*if \(searchParams\.get\("new"\) !== "1"\)/);
    expect(src).toContain('forCustomer ? "lead-new:customer:" + forCustomer.id : "lead-new"');
    expect(src).toMatch(/if \(forCustomer && res\.id\) router\.push\(`\/leads\/\$\{res\.id\}`\);\s*else router\.refresh\(\);/);
    expect(src).not.toMatch(/<Modal\b[^>]*\bkey=/);
  });

  it("source: the seeded town is a suggestion in this door only", () => {
    const src = readFileSync(join(process.cwd(), "src/app/(app)/leads/inquiry-modal.tsx"), "utf8");
    expect(src).toContain("seededTownIsSuggestion={!!forCustomer}");
    const fields = readFileSync(join(process.cwd(), "src/app/(app)/leads/inquiry-fields.tsx"), "utf8");
    expect(fields).toContain("<PersonFields value={value} onChange={onChange} seededTownIsSuggestion={seededTownIsSuggestion} />");
    expect(fields).toContain("seededTownIsSuggestion = false,");
  });

  it("source: opened clean it starts from the customer as handed in NOW, and a pristine form is never their draft", () => {
    const src = readFileSync(join(process.cwd(), "src/app/(app)/leads/inquiry-modal.tsx"), "utf8");
    const open = src.slice(src.indexOf("function openModal()"), src.indexOf("// Confirmed close"));
    // Re-seeded from blank(), which reads the customer prop as it is at the tap, with a new baseline.
    expect(open).toContain("if ((editing || forCustomer) && !dirty) {");
    expect(open).toContain("const fresh = blank();");
    expect(open).toMatch(/initialSnap\.current = snap;\s*setForm\(fresh\);/);
    expect(open.indexOf("setForm(fresh)")).toBeLessThan(open.indexOf("setOpen(true)"));
    // After a save or a discard the reset moves the baseline with it, so the reset reads clean.
    const reset = src.slice(src.indexOf("function resetNew()"), src.indexOf("function onSubmit("));
    expect(reset).toContain("const fresh = blank();");
    expect(reset).toContain("if (!editing) initialSnap.current = JSON.stringify(fresh);");
    expect(src).toMatch(/function discard\(\) \{\s*draft\.clear\(\);\s*resetNew\(\);\s*setOpen\(false\);/);
    expect(src).toMatch(/if \(!editing\) \{\s*resetNew\(\);\s*\} else \{/);
    // A customer's pristine form clears its draft after the mirror's write is scheduled; the mount pass
    // (the read-back) is skipped; the clear is declared after useDraft, so it runs after the mirror.
    expect(src).toContain("const pristineForCustomer = !!forCustomer && !dirty;");
    expect(src).toMatch(/if \(pristineForCustomer\) clearDraft\(\);\s*\}, \[form, pristineForCustomer, clearDraft\]\);/);
    expect(src.indexOf("const draft = useDraft(")).toBeLessThan(src.indexOf("if (pristineForCustomer) clearDraft();"));
    // Still one Modal, never keyed or mounted on a condition.
    expect(src).not.toMatch(/<Modal\b[^>]*\bkey=/);
    expect(src).not.toMatch(/\{[^}]*&&\s*<Modal\b/);
  });
});
