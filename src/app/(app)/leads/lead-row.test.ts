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

import { BecameDoors, InquiryRow, LeadDetails, markLeadLost, saveLeadAsContact } from "./inquiry-row";
import { BECAME_UNREAD } from "@/lib/leads/became";
import { InquiryFields, inquiryFormValue, moreOptionsFilled } from "./inquiry-fields";
import type { Inquiry } from "@/lib/types";
import { words as leadWords } from "@/lib/words/leads";

const en = leadWords.en;

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

  it("Save as Contact is in the ⋯ panel only for a lead with no card that hasn't become anything", () => {
    expect(panel(lead())).toContain("Save as Contact");
    expect(panel(lead({ customer_id: "cust-1" }))).not.toContain("Save as Contact");
    expect(panel(lead({ converted_at: "2026-09-20T10:00:00Z", converted_to: "quote" }))).not.toContain("Save as Contact");
    // 44px, Title Case.
    expect(panel(lead())).toMatch(/<button[^>]*class="[^"]*min-h-11[^"]*"[^>]*><svg[^>]*>.*?<\/svg> Save as Contact<\/button>/);
  });

  it("the toast says which: a new card, or the card the book already had; Open is offered, nothing navigates itself", async () => {
    const toast = vi.fn();
    const open = vi.fn();
    const refresh = vi.fn();
    await saveLeadAsContact({ id: "lead-1", name: "Rita Moss" }, {
      convert: async () => ({ ok: true, id: "cust-9", contact: { id: "cust-9", name: "Rita Moss", existing: false } }),
      toast, open, refresh,
    });
    expect(toast.mock.calls[0][0]).toBe("Saved Rita Moss as a Contact");
    expect(toast.mock.calls[0][2].label).toBe("Open");
    expect(open).not.toHaveBeenCalled();
    toast.mock.calls[0][2].onClick();
    expect(open).toHaveBeenCalledWith("/crm/cust-9");

    toast.mockClear();
    await saveLeadAsContact({ id: "lead-1", name: "rita" }, {
      convert: async () => ({ ok: true, id: "cust-2", contact: { id: "cust-2", name: "Rita Moss", existing: true } }),
      toast, open, refresh,
    });
    expect(toast.mock.calls[0][0]).toBe("Linked to Rita Moss");

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

  it("THE TRIAGE'S SCORE IS A CHIP (cn-v1137): a scored web lead says Priority N; a hand-added lead (0) shows no chip", () => {
    const scored = row(lead({ priority: 42, source: "intake" as Inquiry["source"], lead_bucket: "B", intake: { reason: "Bucket B · $12,000 — quote it" } as Inquiry["intake"] }));
    expect(scored).toMatch(/<span[^>]*title="Bucket B · \$12,000 — quote it"[^>]*>Priority 42<\/span>/);
    expect(row(lead())).not.toContain("Priority ");
    expect(row(lead({ priority: 0 }))).not.toContain("Priority 0");
  });

  it("Referred By lives in the ⋯ panel, and only with Track Referrals on", () => {
    const referred = lead({ ...({ referrer: { full_name: "Chris Lane" } } as object) });
    expect(row(referred)).not.toContain("Chris Lane");
    expect(panel(referred, { referralsOn: true })).toContain("Referred by Chris Lane");
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

  it("shows Name, Phone, Address, What They Need, What Kind of Work, How Long and a closed More Options, and no Residential or commercial", () => {
    const html = fields();
    const labels = [...html.matchAll(/<label[^>]*>([^<]+)<\/label>/g)].map((m) => m[1]);
    expect(labels).toEqual(["Name", "Phone", "Address", "What They Need", "What Kind of Work", "How Long"]);
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

  it("a picked street shows its town on one grey line; a typed one offers Add the Town, and its town lives in More Options", () => {
    const picked = inquiryFormValue(lead());
    expect(picked.town_picked).toBe(true);
    expect(fields(picked)).toContain('<p class="mt-1 text-xs text-slate-500">Testville, CA 96161</p>');
    const typed = { ...inquiryFormValue(), address: "44 Pine Rd" };
    const html = fields(typed);
    expect(html).toMatch(/min-h-11[^"]*"[^>]*>Add the Town<\/button>/);
    // A town typed with no street is kept, in More Options (open, since it holds something).
    const townOnly = inquiryFormValue(lead({ address: null }));
    expect(townOnly.town_picked).toBe(false);
    expect(fields(townOnly)).toContain(">City<");
  });

  it("the modal says New Lead / Edit Lead and keeps its saves", () => {
    const modal = readFileSync(join(process.cwd(), "src/app/(app)/leads/inquiry-modal.tsx"), "utf8");
    // The words live in lib/words/leads (cn-v1146); the English is unchanged.
    expect(modal).toContain('title={editing ? t("ld_btn_editLead") : t("ld_btn_newLead")}');
    expect(modal).toContain('saveLabel={editing ? t("ld_btn_saveChanges") : t("ld_btn_createLead")}');
    expect(en.ld_btn_editLead).toBe("Edit Lead");
    expect(en.ld_btn_newLead).toBe("New Lead");
    expect(en.ld_btn_saveChanges).toBe("Save Changes");
    expect(en.ld_btn_createLead).toBe("Create Lead");
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
    expect(page).toContain('label={t("ld_btn_openLeads")}');
    expect(page).toContain('label={t("ld_btn_followUpsDue")}');
    expect(en.ld_btn_openLeads).toBe("Open Leads");
    expect(en.ld_btn_followUpsDue).toBe("Follow-Ups Due");
    // The visits read carries each visit's day (still leaving cancelled out).
    expect(page).toContain('.select("inquiry_id, status, starts_at, type")');
    expect(page).toContain('.neq("status", "cancelled")');
  });
});

/**
 * G. WHAT IT BECAME IS A DOOR (cn-v1157). The owner, 2026-11-10: "i had no way to get back to his
 * estimate even though it says right on the screen Became An Estimate". A converted row used to end in
 * a sentence; it ends in the records now.
 */
describe("G. a converted lead opens what it became", () => {
  const converted = lead({ converted_at: "2026-09-20T10:00:00Z", converted_to: "quote", status: "quoted" });

  it("its estimate is a door on the row, with its number and what it is called", () => {
    const html = row(converted, { became: [{ kind: "estimate", id: "q-36", number: "E-036", title: "Panel Upgrade" }] });
    expect(html).toContain("Became an Estimate");
    expect(html).toMatch(/<a[^>]*href="\/quotes\/q-36"[^>]*>.*?Open Estimate E-036.*?Panel Upgrade.*?<\/a>/);
    // 44px, like every door on the row.
    expect(html).toMatch(/<a[^>]*class="[^"]*min-h-11[^"]*"[^>]*href="\/quotes\/q-36"|<a[^>]*href="\/quotes\/q-36"[^>]*class="[^"]*min-h-11/);
    // The sentence it replaces is gone, and so are the three verbs (it is provenance, not a lead).
    expect(html).not.toContain(en.ld_alreadyConverted);
    expect(html).not.toContain(">Schedule<");
  });

  it("a job and two estimates are three doors, the job first", () => {
    const html = row(lead({ converted_at: "2026-09-20T10:00:00Z", converted_to: "job" }), {
      became: [
        { kind: "job", id: "j-61", number: "J-061", title: "Panel Upgrade" },
        { kind: "estimate", id: "q-36", number: "E-036", title: null },
        { kind: "estimate", id: "q-31", number: "E-031", title: null },
      ],
    });
    const at = (needle: string) => html.indexOf(needle);
    expect(at('href="/jobs/j-61"')).toBeGreaterThan(-1);
    expect(at('href="/jobs/j-61"')).toBeLessThan(at('href="/quotes/q-36"'));
    expect(at('href="/quotes/q-36"')).toBeLessThan(at('href="/quotes/q-31"'));
    expect(html).toContain("Open Job J-061");
  });

  it("a record with no number yet still gets its door, with no dangling space", () => {
    const html = renderToStaticMarkup(createElement(BecameDoors, { became: [{ kind: "estimate", id: "q-1", number: null, title: null }] }));
    expect(html).toContain(">Open Estimate<");
  });

  it("a read that failed SAYS so; it is never the quiet sentence", () => {
    const html = row(converted, { became: BECAME_UNREAD });
    expect(html).toContain("Couldn&#x27;t load its estimate or job. Reload to try again.");
    expect(html).not.toContain(en.ld_alreadyConverted);
  });

  it("nothing this reader may see keeps the sentence that was there", () => {
    expect(row(converted, { became: null })).toContain(en.ld_alreadyConverted);
    expect(row(converted)).toContain(en.ld_alreadyConverted);
  });

  it("an open lead never draws them: it has its three verbs", () => {
    const html = row(lead(), { became: [{ kind: "estimate", id: "q-36", number: "E-036", title: null }] });
    expect(html).not.toContain("Open Estimate");
    expect(html).toContain("Schedule");
  });

  it("the page reads them for the converted ?focus= row only, newest first, and keeps the reads' errors", () => {
    const page = readFileSync(join(process.cwd(), "src/app/(app)/leads/page.tsx"), "utf8");
    expect(page).toContain("if (focusExtra?.converted_at) {");
    expect(page).toMatch(/\.from\("quotes"\)\s*\.select\("id, quote_number, title"\)\s*\.eq\("inquiry_id", focusExtra\.id\)\s*\.order\("created_at", \{ ascending: false \}\)\s*\.limit\(BECAME_CAP\)/);
    expect(page).toMatch(/\.from\("jobs"\)\s*\.select\("id, job_number, name"\)\s*\.eq\("inquiry_id", focusExtra\.id\)\s*\.order\("created_at", \{ ascending: false \}\)\s*\.limit\(BECAME_CAP\)/);
    expect(page).toContain("error: quotesRead.error");
    expect(page).toContain("error: jobsRead.error");
    expect(page).toContain("became={focusExtra && i.id === focusExtra.id ? became : null}");
  });

  it("the doors are Title Case in both languages", () => {
    expect(en.ld_btn_openEstimate).toBe("Open Estimate {number}");
    expect(en.ld_btn_openJob).toBe("Open Job {number}");
    expect(leadWords.es.ld_btn_openEstimate).toBe("Abrir Presupuesto {number}");
    expect(leadWords.es.ld_btn_openJob).toBe("Abrir Trabajo {number}");
  });
});

/**
 * H. A LEAD'S EDIT REACHES THE ESTIMATES THAT PRINT IT (cn-v1157). The lead's address is the job site
 * on an estimate with no job yet, so the stored copies a customer downloads go with the edit.
 */
describe("H. editing a lead drops its estimates' stored PDFs", () => {
  const src = readFileSync(join(process.cwd(), "src/app/(app)/leads/actions.ts"), "utf8");
  const upd = src.slice(src.indexOf("export async function updateInquiry("), src.indexOf("export async function markInquiryContacted("));

  it("after the write landed, before either way out, scoped to the caller's company", () => {
    const wrote = upd.indexOf("if (!data?.length)");
    const bust = upd.indexOf("await bustLeadPdfs(id, ctx.orgId);");
    const firstReturnOk = upd.indexOf("return { ok: true");
    expect(wrote).toBeGreaterThan(-1);
    expect(bust).toBeGreaterThan(wrote);
    expect(bust).toBeLessThan(firstReturnOk);
  });

  it("deleting a lead drops them too: the ids read before the row goes, the copies dropped only after it has", () => {
    const del = src.slice(src.indexOf("export async function deleteInquiry("), src.indexOf("export async function carryIntakeAnswers(") > -1 ? src.indexOf("export async function carryIntakeAnswers(") : undefined);
    const read = del.indexOf('supabase.from("quotes").select("id").eq("inquiry_id", id)');
    const gone = del.indexOf('supabase.from("inquiries").delete().eq("id", id).select("id")');
    const refused = del.indexOf("if (!gone?.length)");
    const bust = del.indexOf('await bustDocPdf("quote", q.id, ctx.orgId)');
    expect(read).toBeGreaterThan(-1);
    expect(read).toBeLessThan(gone);
    expect(bust).toBeGreaterThan(refused);
  });

  it("the bust reads the lead's estimates inside one company and drops each", () => {
    const cache = readFileSync(join(process.cwd(), "src/lib/pdf-cache.ts"), "utf8");
    const fn = cache.slice(cache.indexOf("export async function bustLeadPdfs("), cache.indexOf("/** Same check, keyed the way the PUBLIC pages"));
    expect(fn).toContain('svc.from("quotes").select("id").eq("inquiry_id", inquiryId)');
    expect(fn).toContain('if (org) quoQ = quoQ.eq("org_id", org);');
    expect(fn).toContain('await bustDocPdf("quote", id, org)');
  });
});

beforeEach(() => {
  vi.clearAllMocks();
});
