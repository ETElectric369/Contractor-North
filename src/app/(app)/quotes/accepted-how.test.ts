import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { translator } from "@/lib/i18n";
import { acceptedLine } from "./[id]/accepted-line";

/**
 * WHO SAID YES (cn-v1176, M5 + M6). updateQuoteStatus takes an optional third argument; on a FRESH
 * acceptance only it writes how the yes was given (in person from the Won sheet, else the office) and
 * the signed-in person who recorded it, never an input. A re-select and a walk-back write neither. The
 * Won sheet's billing kind reaches the NEW job only. The estimate's page says it under the status, in
 * both languages, in each of the four cases. Real doors against the thenable fake; the paperwork doors
 * are mocked at their seams, as in tests/a-job-follows-its-estimate.test.ts.
 */
const ORG = "org-1";
const db = vi.hoisted(() => ({ current: null as any }));

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => db.current.sb), createServiceClient: vi.fn(() => db.current.sb) }));
vi.mock("@/lib/staff-guard", () => ({ requireStaff: vi.fn(async () => ({ supabase: db.current.sb, userId: "u-office", orgId: ORG })) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));
vi.mock("@/lib/pdf-cache", async (importOriginal) => ({ ...(await importOriginal<object>()), bustDocPdf: vi.fn(async () => {}), warmDocPdf: vi.fn(async () => {}) }));
vi.mock("@/lib/push", async (importOriginal) => ({ ...(await importOriginal<object>()), orgStaffIds: vi.fn(async () => []), sendPushToProfiles: vi.fn(async () => {}) }));
vi.mock("@/lib/notifications", async (importOriginal) => ({ ...(await importOriginal<object>()), createNotifications: vi.fn(async () => {}) }));
vi.mock("@/app/(app)/work-orders/actions", async (importOriginal) => ({ ...(await importOriginal<object>()), createWorkOrderFromQuote: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/app/(app)/materials/actions", async (importOriginal) => ({ ...(await importOriginal<object>()), createMaterialListFromQuote: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/estimate/sync-job-materials", async (importOriginal) => ({ ...(await importOriginal<object>()), syncJobMaterials: vi.fn(async () => ({})), materialsWords: () => null }));
vi.mock("@/lib/estimate/born-with-tasks", async (importOriginal) => ({ ...(await importOriginal<object>()), bornWithTasks: vi.fn(async () => ({})) }));
vi.mock("@/lib/schedule-options", async (importOriginal) => ({ ...(await importOriginal<object>()), readUsualBillingKind: vi.fn(async () => "tm") }));

const { fakeDb } = await import("@/test/fake-supabase");
const { updateQuoteStatus } = await import("@/app/(app)/quotes/actions");

const quote = (over: Record<string, unknown> = {}) => ({
  id: "q-900",
  org_id: ORG,
  quote_number: "E-900",
  status: "sent",
  job_id: null,
  customer_id: "c-1",
  inquiry_id: null,
  revises_quote_id: null,
  title: "Panel swap",
  description: null,
  accepted_at: null,
  accepted_how: null,
  accepted_by: null,
  created_at: "2026-11-20T10:00:00Z",
  ...over,
});
const world = (q: Record<string, unknown>) =>
  fakeDb({
    quotes: [q],
    quote_line_items: [],
    customers: [{ id: "c-1", org_id: ORG, name: "Larkspur", company_name: null, type: "residential" }],
    jobs: [{ id: "job-old", org_id: ORG, planned_minutes: null, dismissed_task_keys: [], customer_id: "c-1" }],
    organizations: [{ id: ORG, settings: {} }],
    appointments: [],
    tasks: [],
  });
const row = () => db.current.tables.quotes[0];

describe("updateQuoteStatus records who said yes, on a fresh acceptance only", () => {
  it("no third argument (every existing caller): the office, and the signed-in person", async () => {
    db.current = world(quote({ job_id: "job-old" }));
    expect((await updateQuoteStatus("q-900", "accepted")).ok).toBe(true);
    expect(row()).toMatchObject({ status: "accepted", accepted_how: "office", accepted_by: "u-office" });
  });
  it("in person (the Won sheet): in_person, the signed-in person, never an input", async () => {
    db.current = world(quote({ job_id: "job-old" }));
    expect((await updateQuoteStatus("q-900", "accepted", { inPerson: true })).ok).toBe(true);
    expect(row()).toMatchObject({ accepted_how: "in_person", accepted_by: "u-office" });
  });
  it("accepted again: what was recorded stands (the customer's own yes keeps saying so)", async () => {
    db.current = world(quote({ job_id: "job-old", status: "accepted", accepted_at: "2026-11-19T10:00:00Z", accepted_how: "customer_link", accepted_by: null }));
    expect((await updateQuoteStatus("q-900", "accepted", { inPerson: true })).ok).toBe(true);
    expect(row()).toMatchObject({ accepted_how: "customer_link", accepted_by: null, accepted_at: "2026-11-19T10:00:00Z" });
  });
  it("a walk-back writes neither column", async () => {
    db.current = world(quote({ job_id: "job-old", status: "accepted", accepted_at: "2026-11-19T10:00:00Z", accepted_how: "in_person", accepted_by: "u-other" }));
    expect((await updateQuoteStatus("q-900", "sent")).ok).toBe(true);
    expect(row()).toMatchObject({ status: "sent", accepted_how: "in_person", accepted_by: "u-other" });
  });
});

describe("the Won sheet's billing kind reaches the new job only", () => {
  it("with billingType fixed the new job bills fixed; without it, the company's usual kind", async () => {
    db.current = world(quote());
    const a = await updateQuoteStatus("q-900", "accepted", { billingType: "fixed", inPerson: true });
    expect(a.ok).toBe(true);
    const made = db.current.inserted.jobs ?? db.current.tables.jobs.filter((j: any) => j.id !== "job-old");
    expect(made.at(-1)).toMatchObject({ billing_type: "fixed", status: "to_be_scheduled" });

    db.current = world(quote());
    expect((await updateQuoteStatus("q-900", "accepted")).ok).toBe(true);
    const made2 = db.current.inserted.jobs ?? db.current.tables.jobs.filter((j: any) => j.id !== "job-old");
    expect(made2.at(-1)).toMatchObject({ billing_type: "tm" });
  });
  it("the assistant's handlers call it with two arguments, untouched (pinned at the source)", () => {
    const handlers = readFileSync("src/lib/actions/entities/quote.ts", "utf8");
    expect(handlers).toContain("handler: (i) => updateQuoteStatus(i.id, i.status),");
    expect(handlers).toContain("handler: (i) => createJobFromQuote(i.id),");
  });
  it("the editor's read names both columns (projection law)", () => {
    expect(readFileSync("src/app/(app)/quotes/actions.ts", "utf8")).toContain("accepted_at, declined_at, accepted_how, accepted_by, created_by");
  });
});

describe("the estimate's page says who said yes, in each case, in both languages", () => {
  const day = "Nov 21, 2026";
  const cases = [
    { how: "in_person", byName: "Sam Tillery", en: "Approved in person by Sam Tillery · Nov 21, 2026", es: "Aprobado en persona por Sam Tillery · Nov 21, 2026" },
    { how: "in_person", byName: null, en: "Approved in person · Nov 21, 2026", es: "Aprobado en persona · Nov 21, 2026" },
    { how: "office", byName: "Dana Rook", en: "Marked accepted by Dana Rook · Nov 21, 2026", es: "Marcado como aceptado por Dana Rook · Nov 21, 2026" },
    { how: "customer_link", byName: null, en: "Accepted by the customer on their link · Nov 21, 2026", es: "Aceptado por el cliente en su enlace · Nov 21, 2026" },
    { how: null, byName: null, en: "Accepted · Nov 21, 2026", es: "Aceptado · Nov 21, 2026" },
  ];
  for (const c of cases) {
    it(`${c.how ?? "before 0413"}${c.byName ? " with a name" : ""}`, () => {
      expect(acceptedLine({ status: "accepted", how: c.how, byName: c.byName, day }, translator("en"))).toBe(c.en);
      expect(acceptedLine({ status: "accepted", how: c.how, byName: c.byName, day }, translator("es"))).toBe(c.es);
    });
  }
  it("only while accepted", () => {
    for (const status of ["draft", "sent", "declined", "superseded"]) {
      expect(acceptedLine({ status, how: "in_person", byName: "Sam Tillery", day }, translator("en"))).toBeNull();
    }
  });
  it("drawn under the status as plain text, only while accepted; never on the customer's paper or page", () => {
    const editor = readFileSync("src/app/(app)/quotes/estimate-editor.tsx", "utf8");
    expect(editor).toContain('{status === "accepted" && savedPage?.acceptedSaid && <p className="basis-full text-xs text-slate-500">{savedPage.acceptedSaid}</p>}');
    const page = readFileSync("src/app/(app)/quotes/[id]/page.tsx", "utf8");
    expect(page).toContain('supabase.from("profiles").select("id, full_name").eq("id", acceptedRow.accepted_by).maybeSingle()');
    expect(page).toContain("acceptedSaid,");
    for (const f of ["src/app/q/[token]/page.tsx", "src/components/quote-document.tsx", "src/app/print/quote/[id]/page.tsx"]) {
      let text = "";
      try {
        text = readFileSync(f, "utf8");
      } catch {
        continue;
      }
      expect(text, f).not.toMatch(/accepted_how|accepted_by|acceptedSaid/);
    }
  });
});
