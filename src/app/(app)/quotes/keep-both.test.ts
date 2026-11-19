import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fakeDb, type Row } from "@/test/fake-supabase";
import { fillText, translator } from "@/lib/i18n";

/**
 * KEEP BOTH, THE DOOR (cn-v1168). The owner, 2026-11-19, with a duplex: "I made them into 2 different
 * quotes for each unit of the duplex and the customer accepted both of them then one got locked and
 * dissapeared to the bottom of the list, if i wanted it gone i would have deleted it". The second quote
 * had been made with Revise on the first, so the customer's Accept on it retired the first.
 *
 * keepBothEstimates is CALLED here against the stateful fake (the rows are read back afterwards), with
 * the job's two rules, the paperwork doors and the billing guard's read as spies that also look at the
 * table at the moment they run: what is read BEFORE anything is written, what the job is caught up
 * FROM, and what is never called at all, is the point. The plan itself is pinned in
 * lib/estimate/revision.test.ts, and the two rules run for real, on the duplex, in keep-both-job.test.ts
 * (skeptic #71: with every rule a spy, a second materials list made by the take-off went through
 * green). Names and numbers are stand-ins.
 */
const s = vi.hoisted(() => ({
  db: null as null | { sb: any; tables: Record<string, Record<string, any>[]> },
  reported: [] as { where: string; error: unknown; extra: unknown }[],
  events: [] as string[],
  /** Run when the figure before is read: a test moves a row "meanwhile" here. */
  meanwhile: null as null | (() => void),
}));
const sb = () => s.db!.sb;
const quote = (id: string) => s.db!.tables.quotes.find((q) => q.id === id)!;

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => sb()), createServiceClient: vi.fn(() => sb()) }));
vi.mock("@/lib/staff-guard", () => ({
  requireStaff: vi.fn(async () => ({ supabase: sb(), userId: "office-1", orgId: "org-1" })),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("@/lib/observe", () => ({ reportError: (where: string, error: unknown, extra?: unknown) => void s.reported.push({ where, error, extra }) }));
vi.mock("@/lib/pdf-cache", async (importOriginal) => ({ ...(await importOriginal<object>()), bustDocPdf: vi.fn(async () => {}), warmDocPdf: vi.fn(async () => {}) }));

const rules = vi.hoisted(() => ({
  estimateLines: vi.fn(),
  syncJobTasks: vi.fn(),
  syncJobMaterials: vi.fn(),
  createWorkOrderFromQuote: vi.fn(),
  createMaterialListFromQuote: vi.fn(),
  findRevisedOriginalBilled: vi.fn(),
}));
vi.mock("@/lib/estimate/sync-job-tasks", async (importOriginal) => ({ ...(await importOriginal<object>()), estimateLines: rules.estimateLines, syncJobTasks: rules.syncJobTasks }));
vi.mock("@/lib/estimate/sync-job-materials", async (importOriginal) => ({ ...(await importOriginal<object>()), syncJobMaterials: rules.syncJobMaterials }));
vi.mock("@/app/(app)/work-orders/actions", async (importOriginal) => ({ ...(await importOriginal<object>()), createWorkOrderFromQuote: rules.createWorkOrderFromQuote }));
vi.mock("@/app/(app)/materials/actions", async (importOriginal) => ({ ...(await importOriginal<object>()), createMaterialListFromQuote: rules.createMaterialListFromQuote }));
vi.mock("@/lib/billing/revision-billed", async (importOriginal) => ({ ...(await importOriginal<object>()), findRevisedOriginalBilled: rules.findRevisedOriginalBilled }));

const { keepBothEstimates } = await import("./actions");

const WON = "2026-11-19T15:55:11.000Z";
const q = (over: Row): Row => ({
  org_id: "org-1",
  status: "accepted",
  revises_quote_id: null,
  accepted_at: null,
  job_id: "job-1",
  customer_id: "cust-1",
  title: "EV Charger Install",
  description: null,
  inquiry_id: null,
  address: null,
  unit: null,
  city: null,
  state: null,
  zip: null,
  ...over,
});
/** The duplex: the first unit's quote, retired by the acceptance of the second, which was made with Revise. */
const duplex = (): Row[] => [
  q({ id: "unit-a", quote_number: "Q-0041", status: "superseded", accepted_at: WON, unit: "Unit A" }),
  q({ id: "unit-b", quote_number: "Q-0043", status: "accepted", accepted_at: "2026-11-19T15:55:53.000Z", revises_quote_id: "unit-a", unit: "Unit B" }),
];
const world = (quotes: Row[], more: { tasks?: Row[]; lists?: Row[] } = {}) => {
  s.db = fakeDb({
    quotes,
    jobs: [{ id: "job-1", org_id: "org-1", description: null }],
    profiles: [{ id: "office-1", org_id: "org-1", language: "en" }],
    tasks: more.tasks ?? [],
    // The crew's one list: the second unit's since its acceptance adopted it (take-off-from-quote).
    material_lists: more.lists ?? [{ id: "ml-1", org_id: "org-1", job_id: "job-1", quote_id: "unit-b" }],
  });
};
/** The line every comeback WITH a job and NO list of its own ends on. */
const PARTS_NOTE = (n: string) => `${n}'s parts are not on the job's materials list. Add what it needs on the job's Materials tab.`;

beforeEach(() => {
  s.reported = [];
  s.events = [];
  s.meanwhile = null;
  for (const spy of Object.values(rules)) spy.mockReset();
  // The figure before, read while the pointer still stands and the first unit is still retired.
  rules.estimateLines.mockImplementation(async (_sb: unknown, who: { jobId: string }) => {
    s.events.push(`figure-before:${who.jobId}:pointer=${quote("unit-b")?.revises_quote_id ?? "none"}:a=${quote("unit-a")?.status}`);
    s.meanwhile?.();
    return { lines: [], minutes: 240, taskMinutes: new Map([["line:b1", 240]]), partCounts: new Map([["line:b1#R1", 1]]) };
  });
  rules.syncJobTasks.mockImplementation(async (_sb: unknown, who: { jobId: string; sizeBefore?: number | null }) => {
    s.events.push(`tasks:${who.jobId}:before=${who.sizeBefore}:pointer=${quote("unit-b")?.revises_quote_id ?? "none"}:a=${quote("unit-a")?.status}`);
    return { inserted: 1, rekeyed: 0, removed: 0, kept: 0, timed: 0, keptNames: [], leftOff: [], twice: [], sizeSet: true, sizeNow: 480 };
  });
  rules.syncJobMaterials.mockImplementation(async () => (s.events.push("materials"), { inserted: 0, rekeyed: 0, removed: 0, removedNames: [], kept: 0, keptNames: [], leftOff: [], countsDiffer: [] }));
  rules.createWorkOrderFromQuote.mockImplementation(async (id: string) => (s.events.push(`work-order:${id}`), { ok: true }));
  rules.createMaterialListFromQuote.mockImplementation(async (id: string) => (s.events.push(`list:${id}`), { ok: true }));
  // Nothing it revises is billed, unless a test says so. It notes the pointer at the moment it reads.
  rules.findRevisedOriginalBilled.mockImplementation(async () => (s.events.push(`billed?:pointer=${quote("unit-b")?.revises_quote_id ?? "none"}`), null));
});

describe("keepBothEstimates — the duplex", () => {
  it("un-links the second quote, puts the first back to accepted with the day it was won untouched, and catches the job up from the figure read BEFORE anything was written", async () => {
    world(duplex());
    const res = await keepBothEstimates("unit-b");
    expect(res.ok).toBe(true);
    // The rows, read back.
    expect(quote("unit-b")).toMatchObject({ revises_quote_id: null, status: "accepted" });
    expect(quote("unit-a")).toMatchObject({ status: "accepted", accepted_at: WON, revises_quote_id: null });
    // In order: the figure, and whether the first unit is billed, both while the pointer stood and the
    // first unit was still retired; then the job's two rules, handed that figure, with both counting.
    expect(s.events).toEqual([
      "figure-before:job-1:pointer=unit-a:a=superseded",
      "billed?:pointer=unit-a",
      "tasks:job-1:before=240:pointer=none:a=accepted",
      "materials",
    ]);
    // NEVER THE ACCEPTANCE DOOR'S PAPERWORK (skeptic #71, the blocker): a take-off here would have made
    // the first unit a NEW list, and the newest list on a job is the one every reader shows.
    expect(rules.createWorkOrderFromQuote).not.toHaveBeenCalled();
    expect(rules.createMaterialListFromQuote).not.toHaveBeenCalled();
    expect(s.db!.tables.material_lists).toEqual([{ id: "ml-1", org_id: "org-1", job_id: "job-1", quote_id: "unit-b" }]);
    expect(rules.findRevisedOriginalBilled).toHaveBeenCalledWith(expect.anything(), { revises_quote_id: "unit-a", job_id: "job-1" });
    expect(rules.syncJobTasks).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ jobId: "job-1", orgId: "org-1", sizeBefore: 240, tasksBefore: new Map([["line:b1", 240]]) }), "en", expect.anything());
    expect(rules.syncJobMaterials).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ jobId: "job-1", partsBefore: new Map([["line:b1#R1", 1]]) }), "en", expect.anything());
    // What it says: the two facts first, in the two estimates' own numbers.
    expect(res.said?.startsWith("Q-0043 stands on its own now. Q-0041 is accepted again.")).toBe(true);
    // What is left for a person, and nothing else: the list is the second unit's, so the first unit's
    // parts are on no list. Nothing was done on the job, so there is no word about done work.
    expect(res.warning).toBe(PARTS_NOTE("Q-0041"));
    expect(s.reported).toEqual([]);
  });

  it("an estimate that comes back still holding a list of its own gets no word about parts: its list followed by the rule", async () => {
    world(duplex(), { lists: [{ id: "ml-a", org_id: "org-1", job_id: "job-1", quote_id: "unit-a" }, { id: "ml-b", org_id: "org-1", job_id: "job-1", quote_id: "unit-b" }] });
    const res = await keepBothEstimates("unit-b");
    expect(res.ok).toBe(true);
    expect(res.warning).toBeUndefined();
    expect(rules.syncJobMaterials).toHaveBeenCalledTimes(1);
  });

  it("WORK ALREADY DONE STAYS WHERE IT IS, and is said only on a job with progress that got new tasks now", async () => {
    const born = () => void (s.db!.tables.tasks = [...s.db!.tables.tasks, { id: "t-new", job_id: "job-1", status: "open", source_key: "line:a1" }]);
    // Progress on the job, and the first unit's task arrives as a new one: said, with the one thing to do.
    world(duplex(), { tasks: [{ id: "t-done", job_id: "job-1", status: "done", source_key: "line:b1" }] });
    rules.syncJobTasks.mockImplementation(async () => (born(), { inserted: 1, rekeyed: 0, removed: 0, kept: 0, timed: 0, keptNames: [], leftOff: [], twice: [], sizeSet: true, sizeNow: 480 }));
    const said = await keepBothEstimates("unit-b");
    expect(said.warning).toBe(`${PARTS_NOTE("Q-0041")} Tasks already done on the job stayed where they are. Q-0041's tasks are new and open: check off what is done.`);
    // The same job with nothing done yet: no word.
    world(duplex(), { tasks: [{ id: "t-open", job_id: "job-1", status: "open", source_key: "line:b1" }] });
    expect((await keepBothEstimates("unit-b")).warning).toBe(PARTS_NOTE("Q-0041"));
    // Progress, and no new task came (the rule added none): no word either, because none would be true.
    world(duplex(), { tasks: [{ id: "t-done", job_id: "job-1", status: "done", source_key: "line:b1" }] });
    rules.syncJobTasks.mockImplementation(async () => ({ inserted: 0, rekeyed: 0, removed: 0, kept: 0, timed: 0, keptNames: [], leftOff: [], twice: [], sizeSet: false, sizeNow: null }));
    expect((await keepBothEstimates("unit-b")).warning).toBe(PARTS_NOTE("Q-0041"));
  });

  it("THE BILLING GUARD GOES WITH THE POINTER, AND THAT IS SAID: an invoice already cut from the first unit is named, and nothing is refused", async () => {
    world(duplex());
    rules.findRevisedOriginalBilled.mockImplementation(async () => ({ quoteNumber: "Q-0041", invoiceNumber: "INV-0012" }));
    const res = await keepBothEstimates("unit-b");
    expect(res.ok).toBe(true);
    expect(quote("unit-a").status).toBe("accepted");
    expect(res.warning).toBe(`${PARTS_NOTE("Q-0041")} Q-0041 is already billed on INV-0012, and Q-0043 can be billed beside it now. Bill Q-0043 only if it is separate work.`);
    // An invoice with no number yet, on an estimate with none: still a sentence.
    world(duplex());
    rules.findRevisedOriginalBilled.mockImplementation(async () => ({ quoteNumber: null, invoiceNumber: null }));
    expect((await keepBothEstimates("unit-b")).warning).toContain("The estimate this revised is already billed on an invoice, and Q-0043 can be billed beside it now.");
  });

  it("a billed read that fails is never guessed either way: the door still works, says it could not be read, and files it", async () => {
    world(duplex());
    rules.findRevisedOriginalBilled.mockImplementation(async () => ({ unread: "the invoices could not be read" }));
    const res = await keepBothEstimates("unit-b");
    expect(res.ok).toBe(true);
    expect(res.warning).toBe(`${PARTS_NOTE("Q-0041")} Whether the estimate Q-0043 revised is already billed could not be read. Look at its invoices before you bill Q-0043.`);
    expect(s.reported.map((r) => r.where)).toEqual(["keepBothEstimates:billed"]);
    // And a read that throws is the same thing.
    world(duplex());
    s.reported = [];
    rules.findRevisedOriginalBilled.mockImplementation(async () => {
      throw new Error("socket closed");
    });
    expect((await keepBothEstimates("unit-b")).warning).toContain("could not be read");
    expect(s.reported.map((r) => r.where)).toEqual(["keepBothEstimates:billed"]);
  });

  it("an estimate that comes back with NO job says where its job is made; this door makes none and catches nothing up", async () => {
    world([
      q({ id: "unit-a", quote_number: "Q-0041", status: "superseded", accepted_at: WON, job_id: null }),
      q({ id: "unit-b", quote_number: "Q-0043", status: "accepted", accepted_at: "2026-11-19T15:55:53.000Z", revises_quote_id: "unit-a" }),
    ]);
    const res = await keepBothEstimates("unit-b");
    expect(res).toEqual({ ok: true, said: "Q-0043 stands on its own now. Q-0041 is accepted again.", warning: "Q-0041 has no job. Open it and tap Create Job." });
    expect(quote("unit-a")).toMatchObject({ status: "accepted", job_id: null });
    expect(s.db!.tables.jobs).toHaveLength(1);
    expect(rules.estimateLines).not.toHaveBeenCalled();
    expect(rules.syncJobTasks).not.toHaveBeenCalled();
    expect(rules.createWorkOrderFromQuote).not.toHaveBeenCalled();
  });

  it("is the same deed from either page: the door is always handed the estimate that carries the pointer, and the one it replaced is never passed as the revision", async () => {
    world(duplex());
    const res = await keepBothEstimates("unit-a"); // the retired one carries no pointer
    expect(res).toEqual({ ok: false, error: "Q-0041 is not a revision of another estimate, so there is nothing to un-link." });
    expect(quote("unit-b").revises_quote_id).toBe("unit-a");
    expect(quote("unit-a").status).toBe("superseded");
    expect(s.events).toEqual([]);
  });

  it("a second tap finds nothing left to un-link and changes nothing", async () => {
    world(duplex());
    expect((await keepBothEstimates("unit-b")).ok).toBe(true);
    s.events = [];
    expect(await keepBothEstimates("unit-b")).toEqual({ ok: false, error: "Q-0043 is not a revision of another estimate, so there is nothing to un-link." });
    expect(s.events).toEqual([]);
  });
});

describe("keepBothEstimates — before the revision is accepted", () => {
  it("only the pointer goes: the original stood all along, nothing is read for a job and nothing is caught up", async () => {
    world([q({ id: "unit-a", quote_number: "Q-0041", status: "accepted", accepted_at: WON }), q({ id: "unit-b", quote_number: "Q-0043", status: "sent", revises_quote_id: "unit-a", job_id: "job-1" })]);
    const res = await keepBothEstimates("unit-b");
    expect(res).toEqual({ ok: true, said: "Q-0043 stands on its own now." });
    expect(quote("unit-b")).toMatchObject({ revises_quote_id: null, status: "sent" });
    expect(quote("unit-a")).toMatchObject({ status: "accepted", accepted_at: WON });
    expect(s.events).toEqual(["billed?:pointer=unit-a"]); // the one read: nothing for a job, nothing caught up
  });

  it("ONLY A REVISION THAT WAS ACCEPTED RETIRED ANYTHING (skeptic #71): a draft one never brings back an estimate somebody else's acceptance retired", async () => {
    // Q-0041 was replaced by its revision Q-0042, which was then walked back to sent: Q-0041 stays
    // retired, as designed. Q-0043 is a DRAFT revision of Q-0041 that never retired anything, and its
    // page's own sentence says only that accepting it will no longer replace Q-0041.
    world([
      q({ id: "unit-a", quote_number: "Q-0041", status: "superseded", accepted_at: WON }),
      q({ id: "price-2", quote_number: "Q-0042", status: "sent", accepted_at: "2026-11-19T16:10:00.000Z", revises_quote_id: "unit-a" }),
      q({ id: "unit-b", quote_number: "Q-0043", status: "draft", revises_quote_id: "unit-a" }),
    ]);
    const res = await keepBothEstimates("unit-b");
    expect(res).toEqual({ ok: true, said: "Q-0043 stands on its own now." });
    expect(quote("unit-b").revises_quote_id).toBeNull();
    expect(quote("unit-a").status).toBe("superseded");
    expect(quote("price-2")).toMatchObject({ status: "sent", revises_quote_id: "unit-a" });
    expect(rules.estimateLines).not.toHaveBeenCalled();
    expect(rules.syncJobTasks).not.toHaveBeenCalled();
  });

  it("a revision that WAS accepted and has been replaced itself since still un-links with its plan (the retired estimate's page names it and promises the comeback)", async () => {
    world([
      q({ id: "unit-a", quote_number: "Q-0041", status: "superseded", accepted_at: WON }),
      q({ id: "unit-b", quote_number: "Q-0043", status: "superseded", accepted_at: "2026-11-19T15:55:53.000Z", revises_quote_id: "unit-a" }),
    ]);
    const res = await keepBothEstimates("unit-b");
    expect(res.ok).toBe(true);
    expect(quote("unit-a").status).toBe("accepted");
    expect(res.said?.startsWith("Q-0043 stands on its own now. Q-0041 is accepted again.")).toBe(true);
  });
});

describe("keepBothEstimates — what it refuses, and what it says when it cannot finish", () => {
  it("an estimate that is not there is said; nothing is written", async () => {
    world(duplex());
    expect(await keepBothEstimates("nobody")).toEqual({ ok: false, error: "That estimate could not be found." });
    expect(quote("unit-a").status).toBe("superseded");
  });

  it("the pointer moved while the page was open (another tab, another person): the write hits no row, says so, and the first unit is left exactly as it was", async () => {
    world(duplex());
    s.meanwhile = () => void (quote("unit-b").revises_quote_id = "someone-else");
    const res = await keepBothEstimates("unit-b");
    expect(res).toEqual({ ok: false, error: "That estimate changed while this page was open, so nothing was un-linked. Reload and look again." });
    expect(quote("unit-a").status).toBe("superseded");
    expect(rules.syncJobTasks).not.toHaveBeenCalled();
  });

  it("the first unit was moved by somebody meanwhile: the pointer is cleared, the status they set stands, and the one next step is said and filed", async () => {
    world(duplex());
    s.meanwhile = () => void (quote("unit-a").status = "declined");
    const res = await keepBothEstimates("unit-b");
    expect(res.ok).toBe(true);
    expect(quote("unit-b").revises_quote_id).toBeNull();
    expect(quote("unit-a").status).toBe("declined");
    expect(res.said).toBe("Q-0043 stands on its own now.");
    expect(res.warning).toBe("Q-0041 could not be set back (it changed meanwhile). Nothing replaces it now: set its status on its own page.");
    expect(s.reported.map((r) => r.where)).toEqual(["keepBothEstimates:restore"]);
    expect(rules.syncJobTasks).not.toHaveBeenCalled();
  });

  /** Two corrected prices for one piece of work, accepted one after the other: the second acceptance
   *  retired the first correction (a sibling) too. Un-linking the second brings the first correction
   *  back, and the original stays replaced by it. */
  const twoPrices = (): Row[] => [
    q({ id: "unit-a", quote_number: "Q-0041", status: "superseded", accepted_at: WON }),
    q({ id: "price-2", quote_number: "Q-0042", status: "superseded", accepted_at: "2026-11-19T15:40:00.000Z", revises_quote_id: "unit-a" }),
    q({ id: "unit-b", quote_number: "Q-0043", status: "accepted", accepted_at: "2026-11-19T15:55:53.000Z", revises_quote_id: "unit-a" }),
  ];

  it("another accepted revision still replaces the original: it stays, and the sentence names what replaces it", async () => {
    world(twoPrices());
    const res = await keepBothEstimates("unit-b");
    expect(res.ok).toBe(true);
    expect(quote("price-2")).toMatchObject({ status: "accepted", revises_quote_id: "unit-a" });
    expect(quote("unit-a").status).toBe("superseded");
    expect(res.said?.startsWith("Q-0043 stands on its own now. Q-0042 is accepted again.")).toBe(true);
    expect(res.said?.endsWith("Q-0041 is still replaced by Q-0042.")).toBe(true);
    expect(rules.syncJobTasks).toHaveBeenCalledTimes(1); // one job, caught up once
  });

  it("when that comeback does not land, nothing is called a replacer that is not one (skeptic #71): its own note says what to do", async () => {
    world(twoPrices());
    s.meanwhile = () => void (quote("price-2").status = "declined");
    const res = await keepBothEstimates("unit-b");
    expect(res).toEqual({
      ok: true,
      said: "Q-0043 stands on its own now.",
      warning: "Q-0042 could not be set back (it changed meanwhile). Nothing replaces it now: set its status on its own page.",
    });
    expect(quote("unit-a").status).toBe("superseded");
    expect(res.said).not.toContain("still replaced");
  });

  it("the job could not be caught up: both estimates still stand as accepted, and the note says the job needs attention", async () => {
    world(duplex());
    rules.syncJobTasks.mockImplementation(async () => ({ inserted: 0, rekeyed: 0, removed: 0, kept: 0, timed: 0, keptNames: [], leftOff: [], twice: [], sizeSet: false, sizeNow: null, error: "the task list is locked" }));
    const res = await keepBothEstimates("unit-b");
    expect(res.ok).toBe(true);
    expect(quote("unit-a").status).toBe("accepted");
    expect(res.warning).toContain("The job's list could not follow this change (the task list is locked). Check its tasks.");
  });

  it("a rule that throws is said and filed the same way; both estimates still stand", async () => {
    world(duplex());
    rules.syncJobTasks.mockImplementation(async () => {
      throw new Error("connection reset");
    });
    const res = await keepBothEstimates("unit-b");
    expect(res.ok).toBe(true);
    expect(quote("unit-a").status).toBe("accepted");
    expect(res.warning).toContain("connection reset");
    expect(s.reported.map((r) => r.where)).toEqual(["keepBothEstimates:job"]);
  });
});

describe("what the first tap says, one sentence per outcome, in both languages", () => {
  const ask = (lang: "en" | "es", key: string) => fillText(translator(lang)(key), { revision: "Q-0043", original: "Q-0041" });
  it("the estimate that was replaced was accepted: it counts again, and both add up", () => {
    expect(ask("en", "qe_keepBothAskReplaced")).toBe("Q-0043 will stand on its own and Q-0041 will count again. Both add up on the job.");
    expect(ask("es", "qe_keepBothAskReplaced")).toBe("Q-0043 quedará por su cuenta y Q-0041 volverá a contar. Los dos suman en el trabajo.");
  });
  it("it was only sent: it is an open offer again, and nothing is promised about the job (the deed says the same: \"an open offer again (sent)\")", () => {
    expect(ask("en", "qe_keepBothAskOffer")).toBe("Q-0043 will stand on its own and Q-0041 will be an open offer again.");
    expect(ask("es", "qe_keepBothAskOffer")).toBe("Q-0043 quedará por su cuenta y Q-0041 volverá a ser una oferta abierta.");
    expect(ask("en", "qe_keepBothAskOffer")).not.toContain("count");
  });
  it("the revision is not accepted yet: only what accepting it will no longer do", () => {
    expect(ask("en", "qe_keepBothAskPending")).toBe("Q-0043 will stand on its own. Accepting it will no longer replace Q-0041.");
    expect(ask("es", "qe_keepBothAskPending")).toBe("Q-0043 quedará por su cuenta. Aceptarlo ya no reemplazará a Q-0041.");
  });
});

describe("the door's shape, in the source", () => {
  const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
  const actions = src("src/app/(app)/quotes/actions.ts");
  const door = actions.slice(actions.indexOf("export async function keepBothEstimates("), actions.indexOf("/** What an estimator run hands back"));
  it("staff only; the cut is compare-and-set on the pointer as read; a comeback is guarded on superseded; accepted_at is never written", () => {
    expect(door).toContain("const ctx = await requireStaff();");
    expect(door).toContain('.update({ revises_quote_id: null }).eq("id", rev.id).eq("revises_quote_id", originalId).select("id")');
    expect(door).toContain('.update({ status: r.to }).eq("id", r.id).eq("status", "superseded").select("id")');
    expect(door).not.toContain("accepted_at");
    // The figure before, and whether what it revises is billed, are both read ahead of the first write.
    const cut = door.indexOf(".update({ revises_quote_id: null })");
    for (const read of ["figureBefore(await estimateLines(", "await findRevisedOriginalBilled("]) {
      expect(door.indexOf(read)).toBeGreaterThan(-1);
      expect(door.indexOf(read)).toBeLessThan(cut);
    }
    // Nobody is rung: nothing was accepted today.
    expect(door).not.toContain("pushQuoteAccepted");
  });
  it("it never goes through the acceptance door or its paperwork: the job follows by its two rules alone", () => {
    for (const never of ["createJobFromQuote(", "createWorkOrderFromQuote(", "createMaterialListFromQuote(", "supersedeRevised("]) expect(door).not.toContain(never);
    expect(door).toContain("follow = await jobFollows(supabase, { jobId, sizeBefore: fig?.sizeBefore, tasksBefore: fig?.tasksBefore, partsBefore: fig?.partsBefore }, ctx);");
    // Only a revision that was accepted has a plan at all.
    expect(door).toContain('const retired = rev.status === "accepted" || rev.status === "superseded";');
  });
  it("it is not one of the assistant's writes: the registry never names it", () => {
    for (const f of ["src/lib/actions/entities/quote.ts", "src/lib/actions/registry.ts"]) expect(src(f)).not.toContain("keepBothEstimates");
  });
  it("the page draws it where the mark is read, and on the revision while its pointer still decides anything", () => {
    const editor = src("src/app/(app)/quotes/estimate-editor.tsx");
    expect(editor).toContain("{supersededBy?.direct && (");
    // On the revision's own page the door, and its sentence, follow what un-linking would bring back.
    expect(editor).toContain("{revises && keepBothHere && (");
    expect(editor).toContain("comeback={keepBothHere.comeback}");
    expect(editor).toContain('comeback={supersededBy.comeback ?? "accepted"}');
    const here = editor.slice(editor.indexOf("const keepBothHere"), editor.indexOf("  return (", editor.indexOf("const keepBothHere")));
    expect(here.replace(/\s+/g, " ")).toContain(
      '!revises ? null : status === "draft" || status === "sent" ? { comeback: null } : status !== "accepted" ? null : revises.status === "superseded" ? { comeback: revises.comeback ?? "accepted" } : revises.status === "accepted" ? { comeback: "accepted" } : null;',
    );
    // The page works out where each would come back to by the deed's own rule, on the server.
    const page = src("src/app/(app)/quotes/[id]/page.tsx");
    expect(page).toContain("comeback: comebackOf(revisesRead.accepted_at)");
    expect(page).toContain("comeback: comebackOf((q as { accepted_at?: string | null }).accepted_at)");
    expect(src("src/lib/estimate/revision.ts")).toContain("const to = comebackOf(x.accepted_at);");
    const button = src("src/app/(app)/quotes/[id]/keep-both-button.tsx");
    // Three sentences, one per outcome: it counts again, it is an open offer again, nothing comes back.
    expect(button).toContain('t(comeback === "accepted" ? "qe_keepBothAskReplaced" : comeback === "sent" ? "qe_keepBothAskOffer" : "qe_keepBothAskPending")');
    expect(button).toContain("await keepBothEstimates(revisionId)");
    expect(button).not.toMatch(/\bconfirm\(/); // two taps of its own, never the browser's dialog
  });
});
