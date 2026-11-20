import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * THE CUSTOMER'S FILE KEEPS THE REQUEST AND THE INSPECTION (cn-v1171). The customer's page is run
 * against a stand-in client that records every read, and its two new tabs are drawn the way the page
 * draws them, in both languages: Inspections (theirs and the ones made from their leads, once each,
 * cancelled included) and Requests (each lead with its stage in the lead file's own words). A failed
 * read is said in its tab. A tech's page has neither tab and runs neither read. No money column.
 */

type Op = [string, ...unknown[]];
type Answer = { data: unknown; error: unknown };
const db: { calls: { table: string; ops: Op[] }[]; answer: (table: string, ops: Op[]) => Answer } = {
  calls: [],
  answer: () => ({ data: null, error: null }),
};

function builder(table: string) {
  const ops: Op[] = [];
  db.calls.push({ table, ops });
  const b: Record<string, unknown> = new Proxy(
    {},
    {
      get(_t, k) {
        if (k === "then")
          return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(db.answer(table, ops)).then(res, rej);
        if (k === "maybeSingle") return () => Promise.resolve(db.answer(table, [...ops, ["maybeSingle"]]));
        return (...args: unknown[]) => {
          ops.push([String(k), ...args]);
          return b;
        };
      },
    },
  );
  return b;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (t: string) => builder(t),
    rpc: () => Promise.resolve({ data: null, error: null }),
    auth: { getUser: async () => ({ data: { user: { id: "u1" } } }) },
  }),
}));
const lang: { v: "en" | "es" } = { v: "en" };
vi.mock("@/lib/current-lang", () => ({ currentLangFor: async () => lang.v }));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("@/lib/schedule-options", async (orig) => ({
  ...(await orig<typeof import("@/lib/schedule-options")>()),
  listActiveTechs: async () => ({ data: [] }),
  readUsualBillingKind: async () => "tm",
}));
vi.mock("../actions", () => ({ deleteCustomer: vi.fn() }));
vi.mock("./edit-customer-button", () => ({ EditCustomerButton: () => null }));
vi.mock("./merge-customer-button", () => ({ MergeCustomerButton: () => null }));
vi.mock("./portal-link-button", () => ({ PortalLinkButton: () => null }));
vi.mock("../../schedule/new-job-button", () => ({ NewJobButton: () => null }));
vi.mock("../../appointments/appointment-button", () => ({ AppointmentButton: () => null }));
vi.mock("@/components/section-actions-menu", () => ({ SectionActionsMenu: () => null }));
vi.mock("@/components/back-link", () => ({ BackLink: () => null }));
vi.mock("@/components/tabs", () => ({ Tabs: function TabsStub() { return null; } }));
// The Requests tab's New Lead (cn-v1173) is the Leads page's own form, drawn here as a mark that says
// which customer it was handed (the form itself is drawn in leads/lead-for-customer.test.tsx).
vi.mock("../../leads/inquiry-modal", async () => {
  const { createElement: h } = await import("react");
  return {
    InquiryModal: ({ customer }: { customer?: Record<string, unknown> }) => h("i", { "data-x": `new-lead ${JSON.stringify(customer ?? null)}` }),
  };
});

import CustomerDetailPage from "./page";
import { Tabs } from "@/components/tabs";
import { CUSTOMER_REQUEST_COLUMNS, CUSTOMER_VISIT_COLUMNS } from "@/lib/crm/customer-file";

const CID = "c1";
const CUSTOMER = { id: CID, name: "Sam Tillery", status: "active", type: "residential", email: null, phone: null, address: null, city: null, state: null, zip: null, notes: null, company_name: null };
const NOW_AHEAD = new Date(Date.now() + 3 * 86_400_000).toISOString();
const PAST = new Date(Date.now() - 3 * 86_400_000).toISOString();

const LEADS = [
  // won: its visit carries only the lead
  { id: "L1", name: "Sam Tillery", message: "New deck off the back\nStairs too", source: "public_form", status: "won", converted_to: "customer", converted_at: PAST, created_at: "2026-11-10T17:00:00Z" },
  // a second request, with an inspection booked from it
  { id: "L2", name: "Sam Tillery", message: "", source: "Referral", status: "new", converted_to: null, converted_at: null, created_at: "2026-11-15T17:00:00Z" },
  { id: "L3", name: "Sam Tillery", message: "Railing on the Larkspur side", source: null, status: "lost", converted_to: null, converted_at: null, created_at: "2026-11-01T17:00:00Z" },
];
const OWN_VISITS = [{ id: "v-own", type: "inspection", status: "cancelled", outcome: null, starts_at: PAST, title: "Inspection: Sam Tillery", inquiry_id: null }];
const LEAD_VISITS = [
  { id: "v-won", type: "inspection", status: "completed", outcome: "won", starts_at: PAST, title: null, inquiry_id: "L1" },
  { id: "v-booked", type: "inspection", status: "scheduled", outcome: null, starts_at: NOW_AHEAD, title: null, inquiry_id: "L2" },
  // also the customer's own: listed once
  { id: "v-own", type: "inspection", status: "cancelled", outcome: null, starts_at: PAST, title: "Inspection: Sam Tillery", inquiry_id: null },
];

const has = (ops: Op[], name: string, col?: string) => ops.some((o) => o[0] === name && (col === undefined || o[1] === col));

type Fail = Partial<Record<"requests" | "own" | "byLead", boolean>>;
function answers(role: string, fail: Fail = {}) {
  db.answer = (table, ops) => {
    if (table === "customers" && has(ops, "maybeSingle")) return { data: CUSTOMER, error: null };
    if (table === "profiles") return { data: { role, active: true, organizations: { settings: { timezone: "America/Los_Angeles" } } }, error: null };
    if (table === "inquiries") return fail.requests ? { data: null, error: { message: "boom" } } : { data: LEADS, error: null };
    if (table === "appointments") {
      if (has(ops, "eq", "customer_id")) return fail.own ? { data: null, error: { message: "boom" } } : { data: OWN_VISITS, error: null };
      // standingFor's read names only the lead visit columns; the tab's names its own.
      if (has(ops, "select", CUSTOMER_VISIT_COLUMNS)) return fail.byLead ? { data: null, error: { message: "boom" } } : { data: LEAD_VISITS, error: null };
      return { data: LEAD_VISITS.map(({ inquiry_id, status, outcome, starts_at }) => ({ inquiry_id, status, outcome, starts_at })), error: null };
    }
    return { data: [], error: null };
  };
}

function findTabs(node: ReactNode): ReactElement<{ tabs: { id: string; label: string; count?: number; content: ReactNode }[] }> | null {
  if (!isValidElement(node)) {
    if (Array.isArray(node)) for (const n of node) { const f = findTabs(n); if (f) return f; }
    return null;
  }
  if (node.type === Tabs) return node as ReactElement<{ tabs: { id: string; label: string; count?: number; content: ReactNode }[] }>;
  return findTabs((node.props as { children?: ReactNode }).children);
}

async function open(role = "owner", fail: Fail = {}) {
  answers(role, fail);
  db.calls = [];
  const el = (await CustomerDetailPage({ params: Promise.resolve({ id: CID }) })) as ReactElement;
  const tabs = findTabs(el)!.props.tabs;
  const draw = (id: string) => {
    const tab = tabs.find((t) => t.id === id);
    return tab ? renderToStaticMarkup(createElement("div", null, tab.content)) : null;
  };
  return { tabs, draw };
}

beforeEach(() => {
  lang.v = "en";
});

describe("the office's page: two tabs after Invoices", () => {
  it("in order, with their counts", async () => {
    const { tabs } = await open();
    expect(tabs.map((t) => t.id)).toEqual(["details", "jobs", "quotes", "invoices", "inspections", "requests"]);
    expect(tabs.find((t) => t.id === "inspections")).toMatchObject({ label: "Inspections", count: 1 });
    // L2 stands (its visit is booked); L1 is won and L3 Not Sold.
    expect(tabs.find((t) => t.id === "requests")).toMatchObject({ label: "Requests", count: 1 });
  });

  it("Inspections: the customer's own and the ones made from their leads, once each, cancelled included", async () => {
    const html = (await open()).draw("inspections")!;
    for (const id of ["v-own", "v-won", "v-booked"]) expect(html.split(`href="/appointments/${id}"`).length - 1, id).toBe(1);
    expect(html).toContain("Cancelled");
    expect(html).toContain("Won");
    expect(html).toContain("Booked");
    // newest first: the booked one ahead is drawn before the past ones
    expect(html.indexOf("v-booked")).toBeLessThan(html.indexOf("v-won"));
  });

  it("Requests: the scope's first line else the name, the day and the source, the stage in the lead file's words, to the lead's file", async () => {
    const html = (await open()).draw("requests")!;
    expect(html).toContain("New deck off the back");
    expect(html).not.toContain("Stairs too");
    expect(html).toContain('href="/leads/L1"');
    expect(html).toContain('href="/leads/L2"');
    expect(html).toContain("Became a Customer");
    expect(html).toContain("Inspection on the Books · ");
    expect(html).toContain("Not Sold");
    expect(html).toContain("Came in Nov 10");
    expect(html).toContain("From Your Website");
    expect(html).toContain("Referral");
  });

  it("in Spanish", async () => {
    lang.v = "es";
    const { tabs, draw } = await open();
    expect(tabs.slice(-2).map((t) => t.label)).toEqual(["Inspecciones", "Solicitudes"]);
    expect(draw("inspections")).toContain("Cancelada");
    const req = draw("requests")!;
    expect(req).toContain("Se Convirtió en Cliente");
    expect(req).toContain("Inspección Agendada · ");
    expect(req).toContain("No Vendido");
    expect(req).toContain("Desde Tu Sitio Web");
  });

  it("the by-lead read and the standing read run only when the customer has leads", async () => {
    const realAnswer = () => db.answer;
    answers("owner");
    const base = realAnswer();
    db.answer = (table, ops) => (table === "inquiries" ? { data: [], error: null } : base(table, ops));
    db.calls = [];
    const el = (await CustomerDetailPage({ params: Promise.resolve({ id: CID }) })) as ReactElement;
    expect(db.calls.filter((c) => c.table === "appointments" && has(c.ops, "in", "inquiry_id"))).toHaveLength(0);
    const tabs = findTabs(el)!.props.tabs;
    expect(renderToStaticMarkup(createElement("div", null, tabs.find((t) => t.id === "requests")!.content))).toContain("No requests yet.");
  });
});

describe("a failed read is said in its tab, never drawn as nothing", () => {
  for (const l of ["en", "es"] as const) {
    it(`${l}: requests unread`, async () => {
      lang.v = l;
      const { tabs, draw } = await open("owner", { requests: true });
      const req = draw("requests")!;
      expect(req).toContain(l === "en" ? "Couldn&#x27;t load their requests" : "No se pudieron cargar sus solicitudes");
      expect(req).not.toContain(l === "en" ? "No requests yet." : "Aún no hay solicitudes.");
      // Without the leads, the inspections made from them are unknown: said, not half a list.
      expect(draw("inspections")).toContain(l === "en" ? "Couldn&#x27;t load their inspections" : "No se pudieron cargar sus inspecciones");
      // countOpen over an unread list is 0, and zero is no badge (tests/badges-show-open).
      expect(tabs.find((t) => t.id === "requests")!.count).toBe(0);
    });
  }
  it("either visits read failing says the Inspections tab is unread", async () => {
    expect((await open("owner", { own: true })).draw("inspections")).toContain("Couldn&#x27;t load their inspections");
    expect((await open("owner", { byLead: true })).draw("inspections")).toContain("Couldn&#x27;t load their inspections");
  });
});

describe("the Requests tab's New Lead (cn-v1173)", () => {
  const RICH = { ...CUSTOMER, company_name: "Snowbell Builders", phone: "(530) 555-0100", email: "sam@example.test", address: "4 Larkspur Ln", city: "Thistlewood", state: "CA", zip: "96161" };
  async function drawRequests(features?: Record<string, boolean>) {
    answers("owner");
    const base = db.answer;
    db.answer = (table, ops) => {
      if (table === "customers" && has(ops, "maybeSingle")) return { data: RICH, error: null };
      if (table === "profiles") return { data: { role: "owner", active: true, organizations: { settings: { timezone: "America/Los_Angeles", features } } }, error: null };
      return base(table, ops);
    };
    db.calls = [];
    const el = (await CustomerDetailPage({ params: Promise.resolve({ id: CID }) })) as ReactElement;
    const tab = findTabs(el)!.props.tabs.find((t) => t.id === "requests")!;
    return renderToStaticMarkup(createElement("div", null, tab.content));
  }

  it("the office with Leads on: the Leads page's own form, handed this customer, above the tab's card", async () => {
    const html = await drawRequests();
    const mark = html.match(/data-x="new-lead ([^"]*)"/);
    expect(mark).not.toBeNull();
    const handed = JSON.parse(mark![1].replace(/&quot;/g, '"'));
    expect(handed).toEqual({ id: CID, name: "Sam Tillery", company_name: "Snowbell Builders", phone: "(530) 555-0100", email: "sam@example.test", address: "4 Larkspur Ln", city: "Thistlewood", state: "CA", zip: "96161" });
    // Top right of the tab's content, before the list.
    expect(html).toMatch(/^<div><div class="space-y-3"><div class="flex justify-end"><i data-x="new-lead /);
    expect(html.indexOf("new-lead")).toBeLessThan(html.indexOf('href="/leads/L1"'));
  });

  it("Leads off: no door (the tab and its list are as they were)", async () => {
    const html = await drawRequests({ leads: false });
    expect(html).not.toContain("new-lead");
    expect(html).toContain('href="/leads/L1"');
  });

  it("source: the door is in the Requests tab, gated on the office and the Leads switch, and never in the header row", () => {
    const src = readFileSync(join(process.cwd(), "src/app/(app)/crm/[id]/page.tsx"), "utf8");
    const tab = src.slice(src.indexOf('id: "requests",'), src.indexOf("return (", src.indexOf('id: "requests",')));
    expect(tab).toMatch(/\{viewerIsStaff && featureOn\(sw\.features, "leads"\) && \(\s*<div className="flex justify-end">\s*<InquiryModal\s+customer=\{\{/);
    expect(src.split("<InquiryModal").length - 1).toBe(1);
    // One word for one door: the modal's own New Lead (ld_btn_newLead), no new key on this page.
    expect(src).not.toMatch(/t\("[a-z]+_btn_newLead"\)/);
  });
});

describe("a tech's page", () => {
  it("has neither tab and runs neither read", async () => {
    const { tabs } = await open("technician");
    expect(tabs.map((t) => t.id)).toEqual(["details", "jobs"]);
    expect(db.calls.some((c) => c.table === "inquiries")).toBe(false);
    expect(db.calls.some((c) => c.table === "appointments")).toBe(false);
  });
});

describe("the reads' columns", () => {
  const MONEY = /total|amount|price|subtotal|cost|rate|deposit|balance/i;
  it("name their columns and carry no money", () => {
    expect(CUSTOMER_REQUEST_COLUMNS).toBe("id, name, message, source, status, converted_to, converted_at, created_at");
    expect(CUSTOMER_VISIT_COLUMNS).toBe("id, type, status, outcome, starts_at, title, inquiry_id");
    for (const c of [CUSTOMER_REQUEST_COLUMNS, CUSTOMER_VISIT_COLUMNS]) expect(c).not.toMatch(MONEY);
  });
  it("the page asks for them, staff-only, the visits by the estimate visit types", async () => {
    await open();
    const inq = db.calls.find((c) => c.table === "inquiries")!;
    expect(inq.ops).toContainEqual(["select", CUSTOMER_REQUEST_COLUMNS]);
    expect(inq.ops).toContainEqual(["eq", "customer_id", CID]);
    const visitReads = db.calls.filter((c) => c.table === "appointments" && has(c.ops, "select", CUSTOMER_VISIT_COLUMNS));
    expect(visitReads).toHaveLength(2);
    for (const r of visitReads) expect(r.ops).toContainEqual(["in", "type", ["inspection", "final_inspection", "quote"]]);
    const src = readFileSync(join(process.cwd(), "src/app/(app)/crm/[id]/page.tsx"), "utf8");
    expect(src).toMatch(/viewerIsStaff\s*\?\s*supabase\.from\("inquiries"\)\.select\(CUSTOMER_REQUEST_COLUMNS\)/);
    expect(src).toMatch(/viewerIsStaff\s*\?\s*supabase\.from\("appointments"\)\.select\(CUSTOMER_VISIT_COLUMNS\)/);
    expect(src).toContain('t.id !== "inspections" && t.id !== "requests"');
  });
  it("the by-lead visits read goes in batches of 50 lead ids, and one failed batch makes the tab unread (cn-v1171, skeptic #74)", async () => {
    const many = Array.from({ length: 120 }, (_, i) => ({ ...LEADS[1], id: `L${i + 10}` }));
    answers("owner");
    const base = db.answer;
    db.answer = (table, ops) => (table === "inquiries" ? { data: many, error: null } : base(table, ops));
    db.calls = [];
    await CustomerDetailPage({ params: Promise.resolve({ id: CID }) });
    const byLead = db.calls.filter((c) => c.table === "appointments" && has(c.ops, "select", CUSTOMER_VISIT_COLUMNS) && has(c.ops, "in", "inquiry_id"));
    expect(byLead.map((c) => (c.ops.find((o) => o[0] === "in" && o[1] === "inquiry_id")![2] as string[]).length)).toEqual([50, 50, 20]);
    // One batch failing: the whole list is said unread.
    let n = 0;
    db.answer = (table, ops) => {
      if (table === "inquiries") return { data: many, error: null };
      if (table === "appointments" && has(ops, "select", CUSTOMER_VISIT_COLUMNS) && has(ops, "in", "inquiry_id") && ++n === 2) return { data: null, error: { message: "boom" } };
      return base(table, ops);
    };
    const el = (await CustomerDetailPage({ params: Promise.resolve({ id: CID }) })) as ReactElement;
    const tab = findTabs(el)!.props.tabs.find((t) => t.id === "inspections")!;
    expect(renderToStaticMarkup(createElement("div", null, tab.content))).toContain("Couldn&#x27;t load their inspections");
  });

  it("the shared pieces read no money field", () => {
    for (const f of ["src/components/file/visit-list.tsx", "src/components/file/lead-stage.ts", "src/lib/appointments/file-visit.ts", "src/lib/crm/customer-file.ts"]) {
      expect(readFileSync(join(process.cwd(), f), "utf8"), f).not.toMatch(/\.(total|estimate_total|amount|subtotal)\b|formatCurrency/);
    }
  });
});
