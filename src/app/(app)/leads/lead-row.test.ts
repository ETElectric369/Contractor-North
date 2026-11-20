import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * LEADS (W2-07, reworked cn-v1170): the row is the lead and its doors (who, how to reach them, the
 * Scope, Schedule · Not Sold · Edit Details), the doors follow the lead's stage, and the list is the
 * one rule's. Rendered the way the page draws them (react-dom/server), with the server actions stubbed.
 */
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/leads",
  redirect: vi.fn(),
}));
vi.mock("@/components/toast", () => ({ useToast: () => () => {} }));
vi.mock("@/components/use-org-public-base", () => ({ useOrgPublicBase: () => "https://example.test" }));
vi.mock("@/lib/use-draft", () => ({ useDraft: () => ({ restored: false, clear: () => {} }) }));
vi.mock("./actions", () => ({
  convertInquiry: vi.fn(),
  deleteInquiry: vi.fn(),
  setInquiryStatus: vi.fn(),
  reopenLead: vi.fn(),
  suggestVisitSlots: vi.fn(),
  createInquiry: vi.fn(),
  updateInquiry: vi.fn(),
  refreshPlanBrief: vi.fn(),
  intakeFileUrl: vi.fn(),
}));
vi.mock("./lead-sources-actions", () => ({ readLeadSources: vi.fn() }));
vi.mock("@/app/(app)/appointments/actions", () => ({ createInspectionNow: vi.fn(), openLeadInspection: vi.fn() }));

import { InquiryRow } from "./inquiry-row";
import { LeadDoors, markLeadNotSold, reopenNotSoldLead } from "./lead-doors";
import { LangProvider } from "@/components/lang-provider";
import type { LeadStage } from "@/lib/leads/new-intake";
import type { Inquiry } from "@/lib/types";
import { words as leadWords } from "@/lib/words/leads";

const en = leadWords.en;

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

const ARRIVED_MS = Date.parse("2026-09-27T16:00:00.000Z");
const row = (inquiry: Inquiry, extra: Record<string, unknown> = {}) =>
  renderToStaticMarkup(createElement(InquiryRow, { inquiry, tz: "America/Los_Angeles", nowMs: ARRIVED_MS + 134 * 60_000, ...extra }));
const doors = (stage: LeadStage, lang: "en" | "es" = "en", inquiry: Inquiry = lead()) => {
  const el = createElement(LeadDoors, { inquiry, stage, businessPhone: null });
  return renderToStaticMarkup(lang === "es" ? createElement(LangProvider, { lang: "es", children: el }) : el);
};
/** The words on the buttons, in order. */
const buttons = (html: string) => [...html.matchAll(/<button[^>]*>(.*?)<\/button>/g)].map((m) => m[1].replace(/<[^>]+>/g, "").trim());

describe("A. the row: who, how to reach them, the Scope, the doors (cn-v1170)", () => {
  it("the name opens the lead's file; the business is beside it", () => {
    const html = row(lead({ company_name: "Larkspur Builders", customer_id: "cust-1" }));
    expect(html).toMatch(/<a[^>]*href="\/leads\/lead-1"[^>]*>Rita Moss<\/a>/);
    expect(html).not.toContain('href="/crm/cust-1"');
    expect(html).toContain("Larkspur Builders");
  });

  it("where it came from: a website door is the Globe and its words; a picked source is its label; nothing picked, no chip", () => {
    const web = row(lead({ source: "intake" as Inquiry["source"] }));
    expect(web).toMatch(/<svg[^>]*>.*?<\/svg> From Your Website/);
    const picked = row(lead({ source: "Word of Mouth" as Inquiry["source"] }));
    expect(picked).toContain(">Word of Mouth<");
    expect(picked).not.toContain("From Your Website");
    const manual = row(lead());
    expect(manual).not.toContain("From Your Website");
    expect(manual).not.toContain(">manual<");
  });

  it("THE TRIAGE'S SCORE IS A CHIP (cn-v1137): a scored web lead says Priority N; a hand-added lead (0) shows no chip", () => {
    const scored = row(lead({ priority: 42, source: "intake" as Inquiry["source"], lead_bucket: "B", intake: { reason: "Bucket B · $12,000 — quote it" } as Inquiry["intake"] }));
    expect(scored).toMatch(/<span[^>]*title="Bucket B · \$12,000 — quote it"[^>]*>Priority 42<\/span>/);
    expect(row(lead())).not.toContain("Priority ");
  });

  it("the arrival time and, beside it, the running clock (the server's now first: no hydration mismatch)", () => {
    const html = row(lead());
    expect(html).toContain('title="Added ');
    expect(html).toMatch(/<span[^>]*aria-label="Waiting 2h 14m since it came in"[^>]*>2h 14m<\/span>/);
    expect(html).toMatch(/class="[^"]*tabular-nums[^"]*text-slate-500[^"]*"[^>]*aria-label="Waiting/);
    expect(html).not.toMatch(/aria-label="Waiting[^"]*"[^>]*class="[^"]*amber/);
  });

  it("how to reach them: phone, email and the address, one tap each; the Scope in two lines", () => {
    const html = row(lead({ email: "rita@example.test", intake: { reason: "Wants it this month" } as Inquiry["intake"] }));
    expect(html).toContain('href="tel:(530) 555-0100"');
    expect(html).toContain('href="mailto:rita@example.test"');
    expect(html).toContain('href="https://maps.apple.com/?q=12%20Elm%20St%2C%20Testville"');
    expect(html).toContain("Wants it this month");
    expect(html).toMatch(/<p class="line-clamp-2[^"]*">Wants a hot water heater swapped<\/p>/);
  });

  it("gone from the row: the chip, Contacted, the work, the Follow Up day, the expander, Mark Contacted, Save as Contact, Delete", () => {
    const html = row(lead({ status: "contacted", last_contacted_at: "2026-09-20T18:00:00.000Z", next_follow_up_at: "2026-09-20" }));
    for (const gone of ["New · Call Them", "Call Back", "contacted ", "The work", "Follow Up", "aria-expanded", "Mark Contacted", "Save as Contact", "Delete Lead", ">Estimate<", ">Inspection<"]) {
      expect(html, gone).not.toContain(gone);
    }
  });

  it("each lead is its own card, and its doors are Schedule · Not Sold · Edit Details", () => {
    const html = row(lead());
    expect(html).toMatch(/^<li id="lead-lead-1" class="[^"]*rounded-xl border-2 border-slate-200[^"]*"/);
    expect(buttons(html)).toEqual(["Schedule", "Not Sold", "Edit Details"]);
  });

  it("the arrival time is the COMPANY's clock, not the server's", () => {
    // 16:00 UTC in September is 9:00 AM in Los Angeles and 12:00 PM in New York.
    expect(row(lead())).toContain(">Sep 27, 9:00 AM<");
    expect(row(lead(), { tz: "America/New_York" })).toContain(">Sep 27, 12:00 PM<");
  });

  it("a pick-a-time request nobody answered: the row says the times were sent (both languages)", () => {
    expect(row(lead(), { pickPending: true })).toContain("The times were sent and no pick has come back.");
    expect(row(lead())).not.toContain("no pick has come back");
    const es = renderToStaticMarkup(
      createElement(LangProvider, { lang: "es", children: createElement(InquiryRow, { inquiry: lead(), tz: "America/Los_Angeles", nowMs: ARRIVED_MS, pickPending: true }) }),
    );
    expect(es).toContain("Se enviaron los horarios y no ha elegido ninguno.");
  });

  it("an inspection marked Won with no job picked: the row says where to finish it (cn-v1171, skeptic #74)", () => {
    expect(row(lead(), { wonPending: true })).toContain("Its inspection was marked Won and no job was picked. Open the inspection to pick the job.");
    expect(row(lead())).not.toContain("no job was picked");
    const es = renderToStaticMarkup(
      createElement(LangProvider, { lang: "es", children: createElement(InquiryRow, { inquiry: lead(), tz: "America/Los_Angeles", nowMs: ARRIVED_MS, wonPending: true }) }),
    );
    expect(es).toContain("Abre la inspección para elegir el trabajo.");
  });

  it("kept from the old row: the bucket's mark and the customer's own Needs a Visit", () => {
    const html = row(lead({ lead_bucket: "A", site_inspection_required: true }));
    expect(html).toMatch(/<span[^>]*title="Has plans — straight to a firm estimate\."[^>]*><span aria-hidden="true" class="[^"]*bg-emerald-500[^"]*"><\/span>A · Ready to quote<\/span>/);
    expect(html).toContain(">Needs a Visit<");
    expect(row(lead())).not.toContain("Needs a Visit");
    expect(row(lead())).not.toContain("Ready to quote");
  });

  it("a lead whose visits could not be read says so (it is listed in case)", () => {
    expect(row(lead(), { visitsUnread: true })).toContain(en.ld_visitsUnread.replace(/'/g, "&#x27;"));
    expect(row(lead())).not.toContain(en.ld_visitsUnread.replace(/'/g, "&#x27;"));
  });
});

describe("B. the doors follow the stage (lead-doors.tsx), in both languages", () => {
  it.each([
    ["open", ["Schedule", "Not Sold", "Edit Details"], ["Agendar", "No Vendido", "Editar Detalles"]],
    ["standing", ["Edit Details"], ["Editar Detalles"]],
    ["notSold", ["Reopen", "Edit Details"], ["Reabrir", "Editar Detalles"]],
    ["converted", ["Edit Details"], ["Editar Detalles"]],
  ] as [LeadStage, string[], string[]][])("%s", (stage, english, spanish) => {
    expect(buttons(doors(stage))).toEqual(english);
    expect(buttons(doors(stage, "es"))).toEqual(spanish);
  });

  it("no Estimate and no one-tap Inspection on the doors: Start Now is inside Schedule's sheet", () => {
    const src = readFileSync(join(process.cwd(), "src/app/(app)/leads/convert-menu.tsx"), "utf8");
    expect(src).toContain('{ id: "now", label: t("ld_btn_startNow") }');
    expect(src).toContain("createInspectionNow({ inquiryId })");
    expect(src).toContain("router.push(`/appointments/${res.id}`)");
    expect(src).not.toContain("NewInspectionButton");
    expect(src).not.toContain('"quote"');
  });

  it("openSchedule is honoured only when the lead is open, and once per mount", () => {
    const src = readFileSync(join(process.cwd(), "src/app/(app)/leads/lead-doors.tsx"), "utf8");
    expect(src).toContain('if (openedOnce.current || !openSchedule || stage !== "open") return;');
    expect(src).toContain("openedOnce.current = true;");
  });

  it("closing the Schedule sheet refreshes the route, on every way out (Let Them Pick revalidates nothing)", () => {
    const src = readFileSync(join(process.cwd(), "src/app/(app)/leads/convert-menu.tsx"), "utf8");
    const close = src.slice(src.indexOf("function closeInspect()"), src.indexOf("// The BUSINESS's domain"));
    expect(close).toMatch(/onClose\(\);\s*router\.refresh\(\);/);
    expect(close).not.toMatch(/if \(hadLink\)/);
    // The Modal's own close, Cancel, Done and the link screen's buttons all go through it.
    expect(src).toContain("onClose={closeInspect}");
    expect(src.match(/onCancel=\{closeInspect\}/g)?.length).toBe(2);
    expect(src).toContain("onSave={closeInspect}");
  });
});

describe("C. Not Sold and Reopen", () => {
  it("Not Sold's toast carries the status the lead HAD, and Undo puts that back (never a guessed 'new')", async () => {
    const calls: [string, string][] = [];
    const setStatus = vi.fn(async (id: string, status: string) => (calls.push([id, status]), { ok: true }));
    const toast = vi.fn();
    const refresh = vi.fn();
    await markLeadNotSold({ id: "lead-1", name: "Rita Moss", status: "contacted" }, { setStatus, toast, refresh });
    expect(calls).toEqual([["lead-1", "lost"]]);
    expect(toast.mock.calls[0][0]).toBe("Marked Rita Moss Not Sold");
    expect(toast.mock.calls[0][2].label).toBe("Undo");
    toast.mock.calls[0][2].onClick();
    await vi.waitFor(() => expect(calls).toEqual([["lead-1", "lost"], ["lead-1", "contacted"]]));
    await vi.waitFor(() => expect(toast).toHaveBeenLastCalledWith("Put back.", "success"));
  });

  it("a refusal shows the server's own sentence, and nothing else happens", async () => {
    const toast = vi.fn();
    const refresh = vi.fn();
    const said = "A visit from this lead is still on the books. Open the visit and mark it Not Sold or Dismiss it there.";
    await markLeadNotSold({ id: "lead-1", name: "Rita Moss", status: "new" }, { setStatus: async () => ({ ok: false, error: said }), toast, refresh });
    expect(toast).toHaveBeenCalledWith(said, "error");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("Reopen: one tap, a toast, no confirm", async () => {
    const toast = vi.fn();
    const refresh = vi.fn();
    const reopen = vi.fn(async () => ({ ok: true }));
    await reopenNotSoldLead({ id: "lead-1" }, { reopen, toast, refresh });
    expect(reopen).toHaveBeenCalledWith("lead-1");
    expect(toast).toHaveBeenCalledWith("Back on the Leads list.", "success");
    expect(refresh).toHaveBeenCalled();
    toast.mockClear();
    await reopenNotSoldLead({ id: "lead-1" }, { reopen: async () => ({ ok: false, error: "Nope." }), toast, refresh });
    expect(toast).toHaveBeenCalledWith("Nope.", "error");
  });

  it("the words: Not Sold in both languages, Title Case on the doors", () => {
    expect(en.ld_btn_markLost).toBe("Not Sold");
    expect(leadWords.es.ld_btn_markLost).toBe("No Vendido");
    expect(en.ld_status_lost).toBe("not sold");
    expect(leadWords.es.ld_status_lost).toBe("no vendido");
    expect(en.ld_btn_reopen).toBe("Reopen");
    expect(leadWords.es.ld_btn_reopen).toBe("Reabrir");
  });
});

// D. The lead form moved to lead-form.test.tsx (cn-v1170: the one lead form).

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

describe("F. the page is the one rule's list (cn-v1170)", () => {
  const page = readFileSync(join(process.cwd(), "src/app/(app)/leads/page.tsx"), "utf8");

  it("reads through loadNewIntake, newest first, and never writes the open-lead filter itself", () => {
    expect(page).toContain('loadNewIntake<Inquiry>(supabase, "*, referrer:profiles!inquiries_referred_by_fkey(full_name)", { nowMs })');
    expect(page).not.toContain('.neq("status", "lost")');
    expect(page).not.toMatch(/from\("appointments"\)/);
    expect(page).not.toContain("orderLeadBoard");
  });

  it("?focus= redirects to the lead's file; ?due is gone, and so are the two tiles", () => {
    expect(page).toContain("if (focus) redirect(`/leads/${encodeURIComponent(focus)}`);");
    expect(page).toContain("searchParams: Promise<{ focus?: string }>;");
    expect(page).not.toMatch(/due ===|\?due=|next_follow_up_at/);
    expect(page).not.toContain("StatTile");
    expect(page).not.toContain("ld_btn_openLeads");
    expect(page).not.toContain("ld_btn_followUpsDue");
  });

  it("a failed read says so and is never the empty state", () => {
    const failed = page.indexOf("intake.error ?");
    const empty = page.indexOf("<EmptyState");
    expect(failed).toBeGreaterThan(-1);
    expect(page.slice(failed, empty)).toContain('t("ld_listCouldntLoad")');
    expect(failed).toBeLessThan(empty);
  });

  it("one card per lead with space between, not dividers inside one card", () => {
    expect(page).toContain('<ul className="space-y-3">');
    expect(page).not.toContain("divide-y");
    expect(page).not.toContain("<Card>");
    expect(page).toContain("visitsUnread={intake.unread.has(i.id)}");
    expect(page).toContain("pickPending={intake.pickPending.has(i.id)}");
    expect(page).toContain("wonPending={intake.wonPending.has(i.id)}");
  });

  it("the Not Sold fold: unconverted Not Sold leads, most recently updated first, fifty and a cut", () => {
    expect(page).toMatch(/\.select\("id, name, company_name, message"\)\s*\.eq\("status", NOT_SOLD_STATUS\)\s*\.is\("converted_at", null\)\s*\.order\("updated_at", \{ ascending: false \}\)\s*\.limit\(NOT_SOLD_FOLD_CAP \+ 1\)/);
    expect(page).toContain("<NotSoldFold leads={notSold} cut={notSoldRows.length > NOT_SOLD_FOLD_CAP} failed={!!notSoldRead.error} t={t} />");
    // No customers list is read: no door uses it.
    expect(page).not.toContain("listCustomerOptions");
  });
});

// G. BecameDoors went with cn-v1170 (the lead's file draws its estimates and jobs itself).

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
