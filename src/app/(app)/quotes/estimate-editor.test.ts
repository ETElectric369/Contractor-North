import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderers, text, CLIENT_ID } from "./editor-test-mocks";

/**
 * THE ONE ESTIMATE EDITOR, RENDERED (cn-v1132): the same component on /quotes/new (no row) and on
 * /quotes/[id] (the row), every door the saved page had, the lock, and the words of the one save
 * model where a render can show them. The write path itself is DRIVEN in use-quote-writes.test.ts and
 * the hand-off stash in handoff.test.ts; what cannot be driven without a DOM (the mount effect, the
 * navigation) is pinned at the source and said so.
 */
const actions = await import("./actions");
const { EstimateEditor } = await import("./estimate-editor");
const { unsaved, saved } = renderers(EstimateEditor);
const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");
const editorSrc = read("src/app/(app)/quotes/estimate-editor.tsx");

const rule = { label: null, person_id: null, hours: 2, rate: 145, rate_from: "rule" as const };
const task = { id: "li-1", description: "Install transfer switch", quantity: 1, unit: "ea", unit_price: 290, category: "Tasks", detail: { task_id: "t1", labor: [rule], units: null, kit_id: null, materials: [] }, sort_order: 0 };

describe("birth without litter", () => {
  it("a cold open renders the seed with no row: nothing is called, the totals card says it saves itself, and no Save button is offered", () => {
    const html = unsaved();
    expect(actions.saveQuote).not.toHaveBeenCalled();
    expect(actions.appendQuoteLines).not.toHaveBeenCalled();
    expect(text(html)).toContain("Saves itself the moment you put something on it.");
    expect(text(html)).not.toMatch(/Save Estimate|Save Quote/);
    expect(html).not.toContain(CLIENT_ID); // the client's id is never on the page
    // The /quotes/new door: the Who picker with leads, the Document segment, no header verbs.
    expect(html).toContain('id="who"');
    expect(text(html)).toContain("Quote (Fixed)");
    expect(html).not.toContain("Duplicate");
  });

  it("the seed with real lines renders them (the first save happens in the mount effect, which a server render never runs — pinned)", () => {
    const html = unsaved({ items: [{ description: "Trench", quantity: 1, unit: "ea", unit_price: 290 }] });
    expect(html).toContain('value="Trench"');
    expect(actions.saveQuote).not.toHaveBeenCalled();
    // The mount: one call into the session, which saves ONCE when the seed carries real lines
    // (driven: use-quote-writes.test.ts "the seed with real lines saves exactly once at mount").
    expect(editorSrc).toMatch(/useEffect\(\(\) => \{\s*void session\.mount\(\);\s*\}, \[session\]\);/);
    // The id is chosen when the editor mounts; the session's identity is useState's, not a memo's.
    expect(editorSrc).toContain('{ kind: "unsaved", clientId: props.seed.clientId ?? crypto.randomUUID() }');
    expect(read("src/app/(app)/quotes/use-quote-writes.ts")).toContain("const [session] = useState(make);");
    // The read-back after birth is the LEAN read (ids and their order), never the whole row.
    expect(editorSrc).toContain("readQuoteLineIds,");
    expect(editorSrc).not.toContain("readQuoteForEditor");
  });

  it("the hand-off (S6): once the born-here estimate is quiet and the estimator is idle, the UI text is stashed and the page navigates — a real navigation, once; the saved page takes the stash on mount (pinned; the stash is driven in handoff.test.ts)", () => {
    expect(editorSrc).not.toContain("replaceState");
    expect(editorSrc).not.toContain("replaceUrl");
    expect(editorSrc).toContain("const quiet = isQuiet(state);");
    expect(editorSrc).toContain('if (props.mode !== "unsaved" || mode.kind !== "saved" || !mode.bornHere || handedOff.current) return;');
    expect(editorSrc).toContain("if (!quiet || generating || uploading || bookReview !== null || aiError !== null) return;");
    expect(editorSrc).toContain("handedOff.current = true;");
    expect(editorSrc).toContain("stashHandoff(browserStash(), mode.id, { scope, proposed, questions, number: mode.number });");
    expect(editorSrc).toContain("router.replace(`/quotes/${mode.id}`);");
    expect(editorSrc).toContain("const h = takeHandoff(browserStash(), props.saved.quote.id);");
    expect(editorSrc).toContain("setBorn(h.number ?? props.saved.quote.quote_number);");
    expect(editorSrc).toContain("{(mode.bornHere || born) && (");
  });

  it("the hand-off waits for an open price-book review and for an estimator error he has not acted on — which has a Dismiss (N3) — and a stash that could not be kept with text to carry holds the editor here; the green line offers Open It WHENEVER the editor is in saved mode on this route (pinned; the stash's own answer is driven in handoff.test.ts)", () => {
    const effect = editorSrc.slice(editorSrc.indexOf("const handedOff = useRef(false);"), editorSrc.indexOf("}, [props.mode, mode, quiet, generating, uploading, bookReview, aiError]);"));
    // The review panel and the error are declared before the effect that reads them (a hook reads
    // state declared above it, or it is a render-time error).
    expect(editorSrc.indexOf("const [bookReview, setBookReview] = useState")).toBeLessThan(editorSrc.indexOf("const handedOff = useRef(false);"));
    expect(editorSrc.indexOf("const [aiError, setAiError] = useState")).toBeLessThan(editorSrc.indexOf("const handedOff = useRef(false);"));
    expect(effect).toContain("const kept = stashHandoff(browserStash(), mode.id, { scope, proposed, questions, number: mode.number });");
    expect(effect).toContain("if (!kept && (scope.trim() || proposed.length || questions.length)) return;");
    // Born here and still on this route — a failed stash, a refusal, an error, a review: ANY reason — the
    // green line links the row; on its own page it says the estimate is on the list (skeptic #39, N3).
    expect(editorSrc).not.toContain("stayedHere");
    expect(editorSrc).toMatch(/\{props\.mode === "unsaved" \? \(\s*<>\s*\{" · "\}\s*<Link href=\{`\/quotes\/\$\{savedId\}`\} className="font-semibold underline">\s*Open It\s*<\/Link>/);
    expect(editorSrc).toContain("<> — it&apos;s on the Estimates list even if you leave.</>");
    // The estimator's error can be dismissed (Title Case: a button), so a stale one never holds the hand-off for good.
    expect(editorSrc).toMatch(/\{aiError\}\{" "\}\s*<button type="button" onClick=\{\(\) => setAiError\(null\)\}[^>]*>\s*Dismiss\s*<\/button>/);
  });

  it("the page's fresh props are taken when nothing is on the wire and nothing typed is uncommitted (S2) — a standing refusal does not hold them (skeptic #39: the store keeps a refused row's value and Retry through a reseed) — and the effect re-runs when either flips (the hold itself is driven in use-quote-writes.test.ts)", () => {
    const effect = editorSrc.slice(editorSrc.indexOf("const seededKey = useRef(reseedKey);"), editorSrc.indexOf("}, [reseedKey, busy, dirty]);"));
    expect(effect).toContain("const dirty = session.isDirty();");
    expect(effect).toContain('if (props.mode !== "saved" || seededKey.current === reseedKey) return;');
    expect(effect).toContain("if (busy || dirty) return;");
    expect(effect).not.toContain("if (!quiet || dirty) return;");
    expect(effect).toContain("seededKey.current = reseedKey;");
    expect(effect).toContain("session.reseed({");
  });

  it("the pages say a failed read: the saved page throws on the lines' read like the row's, the new page on the lead-draft read like the ?capture= read (a failed read minted a twin)", () => {
    const saved = read("src/app/(app)/quotes/[id]/page.tsx");
    expect(saved).toContain("if (quoteErr) throw quoteErr;");
    expect(saved).toContain('const { data: items, error: itemsErr } = await supabase.from("quote_line_items").select("*").eq("quote_id", id).order("sort_order");');
    expect(saved).toContain("if (itemsErr) throw itemsErr;");
    const fresh = read("src/app/(app)/quotes/new/page.tsx");
    expect(fresh).toContain("const { data: existing, error: existingErr } = await supabase");
    expect(fresh).toContain("if (existingErr) throw existingErr;");
    expect(fresh).toContain("if (existing?.id) redirect(`/quotes/${existing.id}`);");
    expect(fresh.indexOf("if (existingErr) throw existingErr;")).toBeLessThan(fresh.indexOf("if (existing?.id) redirect(`/quotes/${existing.id}`);"));
  });

  it("the estimator's buttons read Title Case", () => {
    for (const label of ["Not Now", "Drop Them All", "To The Estimate", "To The Price Book", "Tick All", "Untick All"]) expect(editorSrc).toContain(label);
    for (const label of ["Not now", "Drop them all", "to the estimate\n", "to the price book", '"Tick all"', '"Untick all"']) expect(editorSrc).not.toContain(label);
  });

  it("no session draft anywhere: the sessionStorage slot and its key are gone, and nothing imports them (the one-shot hand-off lives in handoff.ts, read once and cleared)", () => {
    expect(editorSrc).not.toMatch(/useDraft|quoteDraftKey|sessionStorage/);
    expect(read("src/app/(app)/quotes/new/page.tsx")).not.toMatch(/adoptedSeed|draftUserId|initialQuoteId/);
  });
});

describe("the saved page's doors, on the editor", () => {
  it("the header: the number, the status, the type, share, the title; the verbs: Email, the status select, Duplicate, Revise (sent/accepted), the ⋯ menu", () => {
    const html = saved({ status: "sent", title: "Larkspur panel" }, [task]);
    const t = text(html);
    expect(t).toContain("E-001");
    expect(t).toContain("sent");
    expect(t).toContain("Larkspur panel");
    expect(t).toContain("Duplicate");
    expect(t).toContain("Revise");
    expect(html).toContain('aria-label="Share"');
    expect(html).toContain('aria-label="Actions"');
    // The status select offers the statuses, sent chosen.
    expect(html).toMatch(/<option value="sent" selected="">/);
    // A draft has no Revise door.
    expect(text(saved({ status: "draft" }, [task]))).not.toContain("Revise");
  });

  it("the customer card, the lead and visit backlinks, the intake files and the created line come with the row", () => {
    const html = saved(
      { inquiry_id: "lead-1" },
      [task],
      {
        lead: { id: "lead-1", name: "Thistlewood Builders", company_name: null, email: null, phone: null, intakePaths: ["org/leads/lead-1/1-plans.pdf"] },
        visitBehind: { id: "appt-1", starts_at: "2026-10-20T17:00:00Z" },
        revises: { id: "q0", quote_number: "E-000", status: "sent" },
      },
    );
    const t = text(html);
    expect(t).toContain("← From Lead: Thistlewood Builders");
    expect(t).toContain("← From The Visit on");
    expect(t).toContain("Revises E-000 — accepting this one supersedes it.");
    expect(t).toContain("plans.pdf");
    expect(t).toContain("Created");
    // The customer card (CustomerSelect) sits above the lines; the sidebar picker does not double it.
    expect(html).not.toContain('id="who"');
    expect(t).toContain("Lead — not a customer yet");
    expect(t).toContain("This estimate is made out to them.");
  });

  it("the ⋯ menu's doors follow the row: View over Create once a record exists; no Create on a superseded estimate", () => {
    const src = editorSrc.slice(editorSrc.indexOf("function quoteTree("), editorSrc.indexOf("/** The words beside a refused write"));
    expect(src).toContain('{ id: "qm-inv", label: "View Invoice", icon: "receipt", href: `/billing/${q.existing.invoice}` }');
    expect(src).toContain('{ id: "qm-inv", label: "Create Invoice", icon: "receipt", run: () => createInvoiceFromQuote(q.id), hrefPrefix: "/billing/" }');
    expect(src).toContain('{ id: "qm-job", label: "Create Job", icon: "briefcase", run: () => createJobFromQuote(q.id), hrefPrefix: "/jobs/" }');
    expect(src).toContain('label: "Create Work Order"');
    expect(src).toContain('label: "Create Material List"');
    expect(src).toContain('label: "Print / PDF"');
    expect(src).toContain('label: "Delete Quote"');
    expect(src).toContain('const replaced = q.status === "superseded";');
    expect(src).toContain('const noPaperYet = replaced || (!!q.revisesId && q.status !== "accepted");');
  });

  it("a locked estimate reads only: the lines as readings with the reason, no picker, no Add, the paper switch gone; the title still edits", () => {
    const html = saved({ status: "accepted" }, [task], { lock: { reason: "A draw was already billed against it — revise it instead." } });
    const t = text(html);
    expect(t).toContain("These line items are locked");
    expect(t).toContain("A draw was already billed against it — revise it instead.");
    expect(html).not.toContain('placeholder="hours?"');
    expect(t).not.toContain("Add A Task");
    expect(t).not.toContain("Draft with Estimator");
    expect(t).not.toContain("Labor And Parts On The Paper");
    expect(html).toContain('id="title"');
    expect(t).toContain("Install transfer switch");
    expect(t).toContain("$290.00");
  });

  it("the lock is the page's answer from the server rule, only (S7): a superseded estimate reads only when the rule says so, and edits when no revision stands", () => {
    const locked = saved({ status: "superseded" }, [task], { supersededBy: { id: "q2", quote_number: "E-002" }, lock: { reason: "E-001 is superseded by E-002 — edit that one instead." } });
    const t = text(locked);
    expect(t).toContain("Superseded by E-002 — that estimate is the price for this work now.");
    expect(t).toContain("These line items are locked");
    expect(t).toContain("E-001 is superseded by E-002 — edit that one instead.");
    expect(t).not.toContain("Add A Line");
    // The revision deleted or walked back: requireEditableQuote says editable, and so does the editor.
    const free = text(saved({ status: "superseded" }, [task], { supersededBy: null, lock: null }));
    expect(free).toContain("Add A Line");
    expect(free).not.toContain("These line items are locked");
    expect(editorSrc).toContain('const lock: { reason: string } | null = props.mode === "saved" ? props.saved.lock : null;');
    expect(editorSrc).not.toContain("its lines are history now");
  });
});

describe("nothing moves silently on a sent estimate", () => {
  it("the chip on a sent estimate says what it was quoted at and what the rule says now; the figure stands (the pass is driven in use-quote-writes.test.ts)", () => {
    const html = saved({ status: "sent" }, [task], {}, { defaultLaborRate: 135 });
    const t = text(html);
    expect(t).toContain("quoted at $145.00/h · the rule says $135.00/h now");
    expect(t).not.toContain("× $135.00/h · company default");
    expect(t).toContain("$290.00"); // 2 h × $145 as quoted
    expect(t).not.toContain("$270.00");
    // The draft form of the same row reads the live rule only once the pass has run; on the first
    // render both say what was quoted, which is the truth of the stored figure.
    expect(text(saved({ status: "draft" }, [task], {}, { defaultLaborRate: 135 }))).toContain("quoted at $145.00/h · the rule says $135.00/h now");
    // The pass is gated on the status in the model, and the editor hands it the status's mode.
    const model = read("src/app/(app)/quotes/use-quote-writes.ts");
    expect(model).toContain('if (status !== "draft") return items.slice();');
    expect(model).toContain('const status = state.mode.kind === "saved" ? state.mode.status : "draft";');
  });
});

describe("the one save model, on the screen", () => {
  it("every control takes the pending flag — the picker and every add door too — and a refusal is drawn with a Title Case Retry beside the thing; queued words have none", () => {
    expect(editorSrc).toContain("const busy = state.pending !== null;");
    // The controls wait while a write runs (the invoice editor's rule).
    expect((editorSrc.match(/disabled=\{busy\}/g) ?? []).length).toBeGreaterThanOrEqual(15);
    expect(editorSrc).toContain("disabled={busy} onAdd={(lines) => void session.addLines(lines)}");
    expect(read("src/components/add-line-items.tsx")).toContain("disabled?: boolean;");
    expect(editorSrc).toContain("function Refused({ words, onRetry, disabled }");
    expect(editorSrc).toMatch(/<button type="button" onClick=\{onRetry\} disabled=\{disabled\} className="font-semibold underline disabled:opacity-50">\s*Retry\s*<\/button>/);
    // A commit queued behind the wire, a line waiting for its id: words, no button.
    expect(editorSrc).toContain("function Waiting({ words }: { words?: string })");
    expect(editorSrc).toContain('<Waiting words={state.waiting[slot]} />');
    for (const slot of ["header:title", "header:description", "header:notes", "header:taxRate", "header:validUntil", "header:estimateFormat", "header:customerId", "header:docType"]) expect(editorSrc).toContain(`{fieldWords("${slot}")}`);
    // Per-field commit on blur / Enter; a NumberInput on blur; a pick or a segment at once.
    expect(editorSrc).toContain('onBlur={() => commitField("title")} onKeyDown={blurOnEnter}');
    expect(editorSrc).toContain('onBlur={() => commitField("description")}');
    expect(editorSrc).toContain('onBlur={() => commitField("notes")}');
    expect(editorSrc).toContain('onValueChange={(n) => session.typeLine(it.key, { unit_price: n })} onBlur={() => void session.commitLine(it.key)}');
    expect(editorSrc).toContain('onValueChange={(n) => session.typeLine(it.key, { quantity: n })} onBlur={() => void session.commitLine(it.key)}');
    expect(editorSrc).toContain("onBlur={() => void session.commitLine(it.key)}");
    // Proposals stay client-side until accepted: a take is the session's append (or the first save).
    expect(editorSrc).toContain("void session.addLines(taking.map(({ pid, keep, ...line }) => line));");
    expect(editorSrc).toContain("onAdd={(lines) => void session.addLines(lines)}");
    // The breakdown's writes go through the same two doors.
    expect(editorSrc).toContain("onChange={(next) => session.typeLine(it.key, next)}");
    expect(editorSrc).toContain("onCommit={(next) => void session.commitLine(it.key, next)}");
  });
  it("a pick from the price book replaces the head and keeps the note he typed under the line (skeptic #43, S6)", () => {
    expect(editorSrc).toContain('import { joinLineNote, splitLineNote } from "@/lib/estimate/line-note";');
    expect(editorSrc).toContain("description: joinLineNote(line.description, splitLineNote(it.description).note),");
    // Never the bare book words over the whole description.
    expect(editorSrc).not.toContain("description: line.description,\n                                            unit: line.unit,");
  });
  it("the picker's box and kit chips wait while a write runs", () => {
    const picker = read("src/components/add-line-items.tsx");
    expect(picker).toMatch(/value=\{query\}\s*disabled=\{disabled\}/);
    expect(picker).toMatch(/key=\{k\.id\}\s*type="button"\s*disabled=\{disabled\}/);
  });
  it("the breakdown's own controls wait too, and leaving a box commits the line", () => {
    const src = read("src/app/(app)/quotes/task-breakdown.tsx");
    expect((src.match(/disabled=\{disabled\}/g) ?? []).length).toBeGreaterThanOrEqual(10);
    expect(src).toContain("const leave = () => onCommit();");
    expect((src.match(/onBlur=\{leave\}/g) ?? []).length).toBeGreaterThanOrEqual(6);
  });
  it("the paper pill of the old saved page (PaperFormatControl) is gone: the editor's own switch writes through the one header door", () => {
    expect(() => read("src/app/(app)/quotes/[id]/paper-format-control.tsx")).toThrow();
    expect(editorSrc).toContain('commitField("estimateFormat");');
  });
});
