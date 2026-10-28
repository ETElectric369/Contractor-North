import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { QUOTE_STATUSES, QUOTE_STATUS_PRIORITY } from "../src/lib/statuses";
import { statusTone } from "../src/components/ui/badge";
import { isLiveQuote } from "../src/lib/invoice-import-rule";
import { CUSTOMER_VISIBLE_STATUSES } from "../src/lib/customer-visible-docs";
import { computeQuoteStats } from "../src/lib/analytics/money-metrics";
import { visitsBehindQuoteFilter } from "../src/lib/appointments/behind-quote";

/**
 * A REVISION SUPERSEDES THE ESTIMATE IT REVISES (0391, cn-v1085). Two accepted estimates on one job add
 * up everywhere — right for a change order, wrong for a corrected price. Revise births a copy that
 * remembers what it revises; accepting it moves the original to `superseded`, so every reader of
 * "accepted" sees one price for the work. These pins hold the doors to that shape.
 */
const src = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");
const body = (text: string, head: string) => {
  const i = text.indexOf(head);
  expect(i, head).toBeGreaterThan(-1);
  const next = text.indexOf("\nexport ", i + head.length);
  return text.slice(i, next === -1 ? undefined : next);
};
const actions = src("src/app/(app)/quotes/actions.ts");

describe("the migration", () => {
  const sql = src("supabase/migrations/0391_an_estimate_may_be_revised.sql");
  it("adds the enum value and the pointer, idempotently, and never USES the new value in the same transaction", () => {
    expect(sql).toContain("alter type public.quote_status add value if not exists 'superseded';");
    expect(sql).toContain("add column if not exists revises_quote_id uuid references public.quotes(id) on delete set null;");
    expect(sql).toContain("create index if not exists quotes_revises_idx");
    // The self-check reads the catalog by label; no statement casts or compares the enum value itself.
    expect(sql).toContain("e.enumlabel = 'superseded'");
    expect(sql).not.toMatch(/status\s*=\s*'superseded'/);
    expect(sql).not.toMatch(/'superseded'::/);
  });
});

describe("the spine knows the word, and every settled-paper reader leaves it out", () => {
  it("superseded is a quote status, filed last, slate like declined, not live, not the customer's paper", () => {
    expect(QUOTE_STATUSES).toContain("superseded");
    expect(QUOTE_STATUS_PRIORITY.superseded).toBeGreaterThan(QUOTE_STATUS_PRIORITY.expired);
    expect(statusTone("superseded")).toBe(statusTone("declined"));
    expect(isLiveQuote("superseded")).toBe(false);
    expect(CUSTOMER_VISIBLE_STATUSES.quote).not.toContain("superseded");
    // Analytics: neither a draft nor a decision; the visit behind the original stands behind the revision too.
    expect(computeQuoteStats([{ status: "superseded", total: 100 }, { status: "accepted", total: 50 }])).toMatchObject({ won: 1, draft: 0, decided: 1 });
    expect(visitsBehindQuoteFilter({ id: "rev", revises_quote_id: "orig" })).toBe("capture->>quote_id.eq.rev,capture->>quote_id.eq.orig");
  });
  it("the job's estimate pick skips a superseded one; the status select offers it only as the current, disabled option", () => {
    expect(src("src/app/(app)/jobs/actions.ts")).toContain('q.status !== "declined" && q.status !== "expired" && q.status !== "superseded"');
    const control = src("src/app/(app)/quotes/[id]/status-control.tsx");
    expect(control).toContain('QUOTE_STATUSES.filter((s) => s !== "superseded" || shown === "superseded")');
    expect(control).toContain('disabled={s === "superseded"}');
  });
});

describe("the doors", () => {
  it("Revise: a copy that keeps the job, the customer and the lead, keeps the title, and remembers what it revises — read back, or refused with the way out", () => {
    const fn = body(actions, "export async function duplicateQuote(");
    expect(fn).toContain("opts?: { revision?: boolean }");
    expect(fn).toContain('const columns = "customer_id, title, description, notes, tax_rate, valid_until, doc_type, circuits, job_id, inquiry_id, status" as const;');
    expect(fn).toContain('select(`${columns}, estimate_format`)'); // the copy keeps the paper format (cn-v1131), two rungs across the 0395 gap
    expect(fn).toContain("const withFormat = !(first.error && isMissingColumn(first.error));");
    expect(fn).toContain('"Only a sent or accepted estimate can be revised — edit this one instead."');
    expect(fn).toContain("job_id: revision ? ((quote as { job_id?: string | null }).job_id ?? null) : null,");
    expect(fn).toContain("title: revision ? (quote.title ?? \"Quote\") : `${quote.title ?? \"Quote\"} (copy)`,");
    expect(fn).toContain('.update({ revises_quote_id: id }).eq("id", res.id).select("id")');
    expect(fn).toContain('.delete().eq("id", res.id).eq("status", "draft").select("id")'); // no half-made revision
    expect(fn).toContain("— Revise again.");
    expect(fn).toContain("valid_until: revision ? null : quote.valid_until ?? null,");
    // cn-v1132: the door lives on the one editor now; the page only reads the row and mounts it.
    const page = src("src/app/(app)/quotes/estimate-editor.tsx");
    expect(page).toContain('(status === "sent" || status === "accepted") && <DuplicateQuoteButton id={savedId} revision />');
    expect(page).toContain("Superseded by{");
    expect(page).toContain("Revises{");
    const button = src("src/app/(app)/quotes/[id]/duplicate-quote-button.tsx");
    expect(button).toContain('revision ? "Revise" : "Duplicate"');
    expect(button).toContain("duplicateQuote(id, revision ? { revision: true } : undefined)");
  });
  it("accepting a revision supersedes the original on BOTH office branches, before the follow / the birth; a failed supersede skips the follow; the revision takes the original's job", () => {
    const create = body(actions, "export async function createJobFromQuote(");
    const first = create.indexOf("supersedeRevised(supabase, { revisionId: quoteId, orgId: ctx.orgId })");
    const follow = create.indexOf("jobFollows(supabase, { jobId: q.job_id");
    const second = create.indexOf("supersedeRevised(supabase, { revisionId: quoteId, orgId: ctx.orgId })", first + 1);
    const birth = create.indexOf("bornWithTasks(");
    expect(first).toBeGreaterThan(-1);
    expect(first).toBeLessThan(follow);
    expect(second).toBeGreaterThan(follow);
    expect(second).toBeLessThan(birth);
    expect(create).toContain("superseded?: string[];");
    expect(create).toContain("Accept it again to retry.");
    expect(create.indexOf("Accept it again to retry.")).toBeLessThan(follow); // the linked branch returns before the follow
    expect(create).toContain('.update({ job_id: origJob }).eq("id", quoteId).is("job_id", null).select("id")'); // the original's job, read back
    expect(create).toContain("revises_quote_id: revises }, { jobId: job.id, outcome: \"won\", orgId: ctx.orgId }"); // the visit behind the original closes too, the company named (S6)
    const status = body(actions, "export async function updateQuoteStatus(");
    expect(status).toContain('if (status === "superseded") return { ok: false as const, error: "Superseded is set by accepting a revision — Revise this estimate instead." };');
    expect(status).toContain("replaced this estimate — change that one instead."); // leaving superseded by hand while the revision stands
    expect(status).toContain('QUOTE_STATUSES.filter((s) => s !== "superseded").join(", ")');
    expect(status).toContain("if (jobRes?.superseded?.length) said = [supersededWords(jobRes.superseded), said].filter(Boolean).join(\" \");");
  });
  it("a revision of a BILLED estimate is not billed whole again: both invoice doors refuse, naming the invoice", () => {
    const guard = src("src/lib/billing/revision-billed.ts"); // a lib rule, never a server action
    expect(guard).toContain("export async function revisedOriginalBilled(");
    expect(guard).toContain("— add the change to that invoice instead.");
    const billing = src("src/app/(app)/billing/actions.ts");
    const create = body(billing, "export async function createInvoiceFromQuote(");
    expect(create).toContain("revisedOriginalBilled(supabase, quote as { revises_quote_id?: string | null; job_id?: string | null })");
    expect(billing).toContain("revisedOriginalBilled(supabase, (picked ?? {}) as { revises_quote_id?: string | null; job_id?: string | null }, invoiceId)");
  });
  it("the visit behind a superseded estimate shows the revision, not a dead estimate", () => {
    const page = src("src/app/(app)/appointments/[id]/page.tsx");
    expect(page).toContain('quoteBehind?.status === "superseded" ? (await revisionOf(supabase, { quoteId: quoteBehind.id, orgId: null })) ?? null : null');
  });
  it("the customer's own Accept supersedes after the figure before is read and before the sync; a failed supersede skips both syncs", () => {
    const finish = body(src("src/app/q/[token]/actions.ts"), "async function finishPublicAcceptance("); // internal since cn-v1133: acceptPublicQuote awaits it
    const before = finish.indexOf("estimateLines(sb, { jobId, orgId: who.orgId, except: q.id })");
    const sup = finish.indexOf("supersedeRevised(sb, { revisionId: q.id, orgId: who.orgId })");
    const sync = finish.indexOf("syncJobTasks(sb,");
    expect(before).toBeGreaterThan(-1);
    expect(sup).toBeGreaterThan(before);
    expect(sync).toBeGreaterThan(sup);
    expect(finish).toContain('reportError("finishPublicAcceptance:supersede"');
    expect(finish).toContain("} else {\n      const born = await syncJobTasks(");
    expect(finish).toContain("if (!sup.error) {\n      const mats = await syncJobMaterials(");
  });
  it("a superseded estimate is locked while its revision stands, naming it — and his again when none does; the lock's old words now name the Revise door", () => {
    const guard = body(actions, "async function requireEditableQuote(");
    expect(guard).toContain('if ((quote as any).status === "superseded") {');
    expect(guard).toContain("rev = await revisionOf(supabase, { quoteId, orgId: null });"); // inside a try: a failed read is a said refusal
    expect(guard).toContain("— edit that one instead.");
    expect(actions).toContain("Revise it instead (or void the contract).");
    expect(actions).toContain("Revise it instead (or void the draw).");
    expect(actions).not.toContain("Duplicate it as a revision");
  });
  it("a revision adopts the original's materials list (compare-and-set on the original's id), so the crew's bought marks carry over", () => {
    const takeOff = src("src/lib/estimate/take-off-from-quote.ts");
    expect(takeOff).toContain("let fromOriginal = !!(canonical && revises && canonical.quote_id === revises);");
    expect(takeOff).toContain('tq = fromOriginal ? tq.eq("quote_id", canonical.quote_id as string) : tq.is("quote_id", null);'); // the list's holder: the original, or an ancestor up the chain
    expect(takeOff).toContain('.select("id, quote_number, job_id, title, customer_id, status, revises_quote_id")');
  });
});
