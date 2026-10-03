import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * LEADS (W2-07): no silent contact, one next-step chip, a status that moves itself, and New Lead in
 * seven. Rendered the way the page draws them (react-dom/server), with the server actions stubbed.
 */
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/leads",
}));
vi.mock("@/components/toast", () => ({ useToast: () => () => {} }));
vi.mock("@/components/use-org-public-base", () => ({ useOrgPublicBase: () => "https://example.test" }));
vi.mock("@/lib/use-draft", () => ({ useDraft: () => ({ restored: false, clear: () => {} }) }));
vi.mock("./actions", () => ({
  convertInquiry: vi.fn(),
  deleteInquiry: vi.fn(),
  markInquiryContacted: vi.fn(),
  setInquiryStatus: vi.fn(),
  sizeLead: vi.fn(),
  snoozeInquiry: vi.fn(),
  suggestVisitSlots: vi.fn(),
  createInquiry: vi.fn(),
  updateInquiry: vi.fn(),
  refreshPlanBrief: vi.fn(),
  intakeFileUrl: vi.fn(),
}));
vi.mock("@/app/(app)/appointments/actions", () => ({ createInspectionNow: vi.fn(), openLeadInspection: vi.fn() }));

import { InquiryRow, LeadDetails, markLeadLost, saveLeadAsContact } from "./inquiry-row";
import { InquiryFields, inquiryFormValue, moreOptionsFilled } from "./inquiry-fields";
import type { Inquiry } from "@/lib/types";

const TODAY = "2026-09-28";
const lead = (over: Partial<Inquiry> = {}): Inquiry =>
  ({
    id: "lead-1",
    name: "Rita Moss",
    company_name: null,
    type: "residential",
    email: null,
    phone: "(530) 555-0100",
    address: "12 Elm St",
    unit: null,
    city: "Testville",
    state: "CA",
    zip: "96161",
    message: "Wants a hot water heater swapped",
    notes: null,
    source: "manual",
    status: "new",
    next_follow_up_at: null,
    last_contacted_at: null,
    customer_id: null,
    converted_to: null,
    converted_at: null,
    created_by: null,
    created_at: "2026-09-27T16:00:00.000Z",
    updated_at: "2026-09-27T16:00:00.000Z",
    project_type: null,
    lead_bucket: null,
    estimate_total: null,
    site_inspection_required: false,
    priority: 0,
    intake: null,
    ...over,
  }) as Inquiry;

const row = (inquiry: Inquiry, extra: Record<string, unknown> = {}) =>
  renderToStaticMarkup(createElement(InquiryRow, { inquiry, customers: [], todayYmd: TODAY, tz: "America/Los_Angeles", ...extra }));
const panel = (inquiry: Inquiry, extra: Record<string, unknown> = {}) =>
  renderToStaticMarkup(createElement(LeadDetails, { inquiry, todayYmd: TODAY, ...extra }));

describe("A. no silent contact", () => {
  it("an unlinked lead's name is only its name: no button, no underline, nothing written", () => {
    const html = row(lead());
    expect(html).toContain('<span class="font-semibold text-slate-900">Rita Moss</span>');
    expect(html).not.toMatch(/<button[^>]*>(?:(?!<\/button>).)*Rita Moss/);
    expect(html).not.toContain("decoration-dotted");
    expect(html).not.toContain("tap to make one");
  });

  it("a linked lead's name opens its contact", () => {
    expect(row(lead({ customer_id: "cust-1" }))).toMatch(/<a[^>]*href="\/crm\/cust-1"[^>]*>Rita Moss<\/a>/);
  });

  it("Save As Contact is in the ⋯ panel only for a lead with no card that hasn't become anything", () => {
    expect(panel(lead())).toContain("Save As Contact");
    expect(panel(lead({ customer_id: "cust-1" }))).not.toContain("Save As Contact");
    expect(panel(lead({ converted_at: "2026-09-20T10:00:00Z", converted_to: "quote" }))).not.toContain("Save As Contact");
    // 44px, Title Case.
    expect(panel(lead())).toMatch(/<button[^>]*class="[^"]*min-h-11[^"]*"[^>]*><svg[^>]*>.*?<\/svg> Save As Contact<\/button>/);
  });

  it("the toast says which: a new card, or the card the book already had; Open is offered, nothing navigates itself", async () => {
    const toast = vi.fn();
    const open = vi.fn();
    const refresh = vi.fn();
    await saveLeadAsContact({ id: "lead-1", name: "Rita Moss" }, {
      convert: async () => ({ ok: true, id: "cust-9", contact: { id: "cust-9", name: "Rita Moss", existing: false } }),
      toast, open, refresh,
    });
    expect(toast.mock.calls[0][0]).toBe("Saved Rita Moss As A Contact");
    expect(toast.mock.calls[0][2].label).toBe("Open");
    expect(open).not.toHaveBeenCalled();
    toast.mock.calls[0][2].onClick();
    expect(open).toHaveBeenCalledWith("/crm/cust-9");

    toast.mockClear();
    await saveLeadAsContact({ id: "lead-1", name: "rita" }, {
      convert: async () => ({ ok: true, id: "cust-2", contact: { id: "cust-2", name: "Rita Moss", existing: true } }),
      toast, open, refresh,
    });
    expect(toast.mock.calls[0][0]).toBe("Linked To Rita Moss");

    toast.mockClear();
    await saveLeadAsContact({ id: "lead-1", name: "Rita Moss" }, { convert: async () => ({ ok: false, error: "Lead not found." }), toast, open, refresh });
    expect(toast).toHaveBeenCalledWith("Lead not found.", "error");
  });
});

describe("B. one next-step chip on the row", () => {
  it("replaces the badges: no status word, no inspection counts, no follow-up or web badges", () => {
    // 'intake' is a real stored source that lib/types' Inquiry union doesn't list (next-step reads its own type).
    const html = row(lead({ status: "contacted", source: "intake" as Inquiry["source"], lead_bucket: "A", site_inspection_required: true }), {
      visits: { done: 1, upcoming: 0, nextAt: null },
    });
    for (const gone of [">contacted<", "inspected", "inspection booked", "🚩", ">web<", "deck site", ">follow up"]) expect(html).not.toContain(gone);
    expect(html).toContain("A · Walked · Estimate Next");
    expect(html).toContain('aria-label="From Your Website"');
    expect(html).toContain('title="From Your Website"');
  });

  it("says what to do next", () => {
    expect(row(lead())).toContain("New · Call Them");
    expect(row(lead({ next_follow_up_at: "2026-09-20" }))).toContain("Call Back · Sep 20");
    expect(row(lead(), { visits: { done: 0, upcoming: 1, nextAt: "2026-10-01T17:00:00.000Z" } })).toContain("Inspection · Thu Oct 1");
  });

  it("Referred By lives in the ⋯ panel, and only with Track Referrals on", () => {
    const referred = lead({ ...({ referrer: { full_name: "Chris Lane" } } as object) });
    expect(row(referred)).not.toContain("Chris Lane");
    expect(panel(referred, { referralsOn: true })).toContain("Referred By Chris Lane");
    expect(panel(referred, { referralsOn: false })).not.toContain("Chris Lane");
  });
});

describe("C. the status moves itself", () => {
  it("no Status select: the Follow Up day, Mark Contacted and Mark Lost, each 44px", () => {
    const html = panel(lead({ status: "contacted" }));
    expect(html).not.toContain(">Status<");
    for (const s of [">New<", ">Quoted<", ">Won<"]) expect(html, s).not.toContain(`<option value="${s.slice(1, -1).toLowerCase()}"`);
    expect(html).toContain("Follow Up");
    expect(html).toMatch(/class="[^"]*min-h-11[^"]*"[^>]*>Mark Contacted<\/button>/);
    expect(html).toMatch(/class="[^"]*min-h-11[^"]*"[^>]*>Mark Lost<\/button>/);
    expect(html).toMatch(/class="[^"]*min-h-11[^"]*"[^>]*>Delete Lead<\/button>/);
    // A lost lead (a ?focus= row) can be marked contacted again, but not lost twice.
    expect(panel(lead({ status: "lost" }))).not.toContain("Mark Lost");
  });

  it("Mark Lost's toast carries the status the lead HAD, and Undo puts that back (never a guessed 'new')", async () => {
    const calls: [string, string][] = [];
    const setStatus = vi.fn(async (id: string, status: string) => (calls.push([id, status]), { ok: true }));
    const toast = vi.fn();
    const refresh = vi.fn();
    await markLeadLost({ id: "lead-1", name: "Rita Moss", status: "contacted" }, { setStatus, toast, refresh });
    expect(calls).toEqual([["lead-1", "lost"]]);
    expect(toast.mock.calls[0][0]).toBe("Marked Rita Moss Lost");
    expect(toast.mock.calls[0][2].label).toBe("Undo");
    toast.mock.calls[0][2].onClick();
    await vi.waitFor(() => expect(calls).toEqual([["lead-1", "lost"], ["lead-1", "contacted"]]));
    await vi.waitFor(() => expect(toast).toHaveBeenLastCalledWith("Put back.", "success"));
  });

  it("the ⋯ toggle is a 44px target", () => {
    expect(row(lead())).toMatch(/<button[^>]*aria-expanded="false"[^>]*class="[^"]*min-h-11 min-w-11[^"]*"/);
  });
});

describe("D. New Lead in seven", () => {
  const fields = (v = inquiryFormValue()) => renderToStaticMarkup(createElement(InquiryFields, { value: v, onChange: () => {} }));

  it("shows Name, Phone, Address, What They Need, What Kind Of Work, How Long and a closed More Options, and no Residential or commercial", () => {
    const html = fields();
    const labels = [...html.matchAll(/<label[^>]*>([^<]+)<\/label>/g)].map((m) => m[1]);
    expect(labels).toEqual(["Name", "Phone", "Address", "What They Need", "What Kind Of Work", "How Long"]);
    expect(html).toContain("More Options");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("Company · Email"); // the closed row's summary
    expect(html).not.toMatch(/Residential or commercial/i);
    expect(html).not.toContain('name="type"');
    // Everything inside More Options is still sent.
    for (const n of ["company_name", "email", "city", "state", "zip", "notes"]) expect(html).toContain(`type="hidden" name="${n}"`);
  });

  it("More Options opens itself when something inside it is filled (a restored draft, an edited lead)", () => {
    const withCompany = { ...inquiryFormValue(), company_name: "Pine Test Co" };
    expect(moreOptionsFilled(withCompany)).toBe(true);
    const html = fields(withCompany);
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('value="Pine Test Co"');
    expect(html).toContain(">Company<");
    expect(moreOptionsFilled(inquiryFormValue())).toBe(false);
  });

  it("a picked street shows its town on one grey line; a typed one offers Add The Town, and its town lives in More Options", () => {
    const picked = inquiryFormValue(lead());
    expect(picked.town_picked).toBe(true);
    expect(fields(picked)).toContain('<p class="mt-1 text-xs text-slate-500">Testville, CA 96161</p>');
    const typed = { ...inquiryFormValue(), address: "44 Pine Rd" };
    const html = fields(typed);
    expect(html).toMatch(/min-h-11[^"]*"[^>]*>Add The Town<\/button>/);
    // A town typed with no street is kept, in More Options (open, since it holds something).
    const townOnly = inquiryFormValue(lead({ address: null }));
    expect(townOnly.town_picked).toBe(false);
    expect(fields(townOnly)).toContain(">City<");
  });

  it("the modal says New Lead / Edit Lead and keeps its saves", () => {
    const modal = readFileSync(join(process.cwd(), "src/app/(app)/leads/inquiry-modal.tsx"), "utf8");
    expect(modal).toContain('title={editing ? "Edit Lead" : "New Lead"}');
    expect(modal).toContain('saveLabel={editing ? "Save Changes" : "Create Lead"}');
  });
});

describe("E. residential or commercial is worked out, never asked", () => {
  const src = readFileSync(join(process.cwd(), "src/app/(app)/leads/actions.ts"), "utf8");
  it("createInquiry: a sent type wins, else a company makes it commercial", () => {
    expect(src).toContain('return companyName ? "commercial" : "residential";');
    expect(src).toMatch(/type: LEAD_TYPES\.includes\(sentType\) \? sentType : inferredLeadType\(fields\.company_name \?\? carried\.company_name \?\? null\)/);
    // inquiryFields() no longer reads a type from the form.
    const fieldsFn = src.slice(src.indexOf("function inquiryFields("), src.indexOf("export async function createInquiry("));
    expect(fieldsFn).not.toContain('formData.get("type")');
  });

  it("updateInquiry never demotes an Industrial lead", () => {
    const upd = src.slice(src.indexOf("export async function updateInquiry("), src.indexOf("export async function markInquiryContacted("));
    expect(upd).toMatch(/\.update\(\{ type: [^}]*\}\)\s*\.eq\("id", id\)\s*\.or\("type\.is\.null,type\.neq\.industrial"\)\s*\.select\("id"\)/);
  });
});

describe("F. the page's words", () => {
  it("the tiles are Open Leads and Follow-Ups Due", () => {
    const page = readFileSync(join(process.cwd(), "src/app/(app)/leads/page.tsx"), "utf8");
    expect(page).toContain('label="Open Leads"');
    expect(page).toContain('label="Follow-Ups Due"');
    // The visits read carries each visit's day (still leaving cancelled out).
    expect(page).toContain('.select("inquiry_id, status, starts_at, type")');
    expect(page).toContain('.neq("status", "cancelled")');
  });
});

beforeEach(() => {
  vi.clearAllMocks();
});
