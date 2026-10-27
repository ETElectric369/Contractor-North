import { vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * RENDERING THE ONE ESTIMATE EDITOR WITHOUT A DOM (cn-v1132). Every server door and every piece of
 * the shell the editor's children reach for is stubbed here, once, so the three suites that render it
 * (task-breakdown, estimate-tax-doors, estimate-editor) mock the same set the same way. The vi.mock
 * calls sit at this module's top level — vitest hoists them when it transforms the module, and a
 * suite that imports this file BEFORE its dynamic `await import("./estimate-editor")` gets every
 * door stubbed. The paths are this folder's, so the module must stay beside the editor.
 */
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/quotes/new",
}));
vi.mock("@/components/toast", () => ({ useToast: () => vi.fn() }));
vi.mock("@/components/ui/modal", () => ({
  Modal: ({ children, footer }: { children?: ReactNode; footer?: ReactNode }) => createElement("div", { "data-modal": "" }, children, footer),
  ModalActions: () => null,
}));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
vi.mock("@/lib/actions/execute", () => ({ executeAction: vi.fn() }));
vi.mock("@/components/new-customer-inline", () => ({ NewCustomerInline: () => null }));
vi.mock("./actions", () => ({
  saveQuote: vi.fn(),
  appendQuoteLines: vi.fn(),
  updateQuoteItem: vi.fn(),
  deleteQuoteItem: vi.fn(),
  updateQuoteMeta: vi.fn(),
  setQuoteCustomer: vi.fn(),
  setQuoteType: vi.fn(),
  readQuoteLineIds: vi.fn(),
  deleteQuote: vi.fn(),
  createJobFromQuote: vi.fn(),
  generateQuoteDraft: vi.fn(),
  generateQuoteDraftFromLeadPlans: vi.fn(),
  generateQuoteDraftFromPlan: vi.fn(),
  generateQuoteDraftFromSupplier: vi.fn(),
  quoteShareText: vi.fn(),
  updateQuoteStatus: vi.fn(),
  duplicateQuote: vi.fn(),
  saveCircuitSchedule: vi.fn(),
  generateCircuitSchedule: vi.fn(),
  emailQuote: vi.fn(),
  textQuote: vi.fn(),
}));
vi.mock("../price-list/actions", () => ({ applyPriceBookReview: vi.fn() }));
vi.mock("../price-list/kit-actions", () => ({ rememberTaskAsKit: vi.fn() }));
vi.mock("../billing/actions", () => ({ createInvoiceFromQuote: vi.fn(), emailInvoice: vi.fn(), textInvoice: vi.fn() }));
vi.mock("../work-orders/actions", () => ({ createWorkOrderFromQuote: vi.fn() }));
vi.mock("../materials/actions", () => ({ createMaterialListFromQuote: vi.fn() }));
vi.mock("../crm/actions", () => ({ createCustomer: vi.fn(), updateCustomer: vi.fn() }));
vi.mock("../crm/[id]/edit-customer-button", () => ({ EditCustomerButton: () => null }));
vi.mock("../leads/actions", () => ({ intakeFileUrl: vi.fn() }));

/** The words as a person reads them: tags gone, the server's entity escapes undone. */
export const text = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

export const CLIENT_ID = "11111111-1111-4111-8111-111111111111";

/** The catalog every render shares: no book, no kits, the company default $145/h, Sales Tax off. */
export const catalog = (p: Record<string, unknown> = {}) => ({
  orgId: "org-1",
  priceItems: [],
  kits: [],
  taskKits: [],
  kitsOn: true,
  taxRates: [],
  people: [],
  defaultMarkupPct: 0,
  defaultLaborRate: 145,
  companyEstimateFormat: "tasks",
  salesTax: false,
  estimatorTaskMode: true,
  textReady: false,
  estimatesOn: true,
  ...p,
});

export const savedRow = (q: Record<string, unknown> = {}) => ({
  id: "q1",
  quote_number: "E-001",
  status: "draft",
  doc_type: "estimate",
  title: "Larkspur panel",
  description: "",
  notes: "",
  tax_rate: 0,
  valid_until: null,
  estimate_format: null,
  circuits: [],
  job_id: null,
  inquiry_id: null,
  customer_id: null,
  created_at: "2026-10-27T10:00:00Z",
  ...q,
});

export const savedProps = (q: Record<string, unknown> = {}, items: unknown[] = [], extra: Record<string, unknown> = {}) => ({
  quote: savedRow(q),
  items,
  lock: null,
  customer: null,
  lead: null,
  customers: [],
  level: { markup: null, rate: null },
  existing: { invoice: null, workOrder: null, materialList: null },
  revises: null,
  supersededBy: null,
  visitBehind: null,
  showCircuits: false,
  panelJob: null,
  ...extra,
});

/** Render the editor with no row (the /quotes/new door) or with a row (the /quotes/[id] door). */
export function renderers(EstimateEditor: unknown) {
  const Editor = EstimateEditor as never;
  const unsaved = (seed: Record<string, unknown> = {}, cat: Record<string, unknown> = {}) =>
    renderToStaticMarkup(createElement(Editor, { mode: "unsaved", seed: { clientId: CLIENT_ID, customers: [], leads: [], items: [], quoteExpiryDays: 30, ...seed }, catalog: catalog(cat) } as never));
  const saved = (q: Record<string, unknown> = {}, items: unknown[] = [], extra: Record<string, unknown> = {}, cat: Record<string, unknown> = {}) =>
    renderToStaticMarkup(createElement(Editor, { mode: "saved", saved: savedProps(q, items, extra), catalog: catalog(cat) } as never));
  return { unsaved, saved };
}
