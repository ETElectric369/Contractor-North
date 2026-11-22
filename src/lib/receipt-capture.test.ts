import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * THE RECEIPT PIPELINE'S WORDS AND THE NORT SWITCH (0352, rule k). The reader works whether Nort is
 * on or off; off, its sentences never name him. On (and when a door passes nothing), they read as
 * they always did.
 */
const upload = vi.fn();
const bill = vi.fn();
vi.mock("@/lib/job-file-upload", () => ({ uploadJobFile: (...a: unknown[]) => upload(...a) }));
vi.mock("@/app/(app)/jobs/actions", () => ({ addDocument: vi.fn(async () => ({ ok: true, id: "doc-1" })) }));
vi.mock("@/app/(app)/organize/actions", () => ({ billJobReceipt: (...a: unknown[]) => bill(...a) }));

const { captureReceipt, readReceiptDocument } = await import("./receipt-capture");

const file = new File(["x"], "r.jpg", { type: "image/jpeg" });
const big = (size: number) => upload.mockResolvedValueOnce({ ok: true, path: "o/j/r.jpg", name: "r.jpg", size });

beforeEach(() => {
  upload.mockReset();
  bill.mockReset();
});

describe("a receipt too big to read", () => {
  it("is filed either way; with Nort off the sentence doesn't name him", async () => {
    big(20 * 1024 * 1024);
    const on = await captureReceipt({ orgId: "o", jobId: "j", file, read: true });
    expect(on.sentence).toContain("Nort reads receipts up to 8 MB");
    big(20 * 1024 * 1024);
    const off = await captureReceipt({ orgId: "o", jobId: "j", file, read: true, nortOn: false });
    expect(off.kind).toBe("filed");
    expect(off.sentence).toContain("receipts are read up to 8 MB");
    expect(off.sentence).not.toContain("Nort");
    expect(off.sentence).toContain("Record as Cost");
  });
});

describe("a reader that fails without a reason", () => {
  it("says it couldn't read it, naming Nort only while he's on", async () => {
    bill.mockRejectedValueOnce({});
    expect((await readReceiptDocument("doc-1")).sentence).toMatch(/^Nort couldn't read it\./);
    bill.mockRejectedValueOnce({});
    const off = await readReceiptDocument("doc-1", undefined, false);
    expect(off.sentence).toMatch(/^Couldn't read it\./);
    expect(off.sentence).not.toContain("Nort");
  });

  it("the switch rides from captureReceipt into the read", async () => {
    upload.mockResolvedValueOnce({ ok: true, path: "o/j/r.jpg", name: "r.jpg", size: 1000 });
    bill.mockResolvedValueOnce({ ok: false });
    const off = await captureReceipt({ orgId: "o", jobId: "j", file, read: true, nortOn: false });
    expect(off.sentence).not.toContain("Nort");
  });
});

/**
 * "ALREADY ON THE BOOKS" CARRIES THE BILL (d1ff7c5a): which bill, and whether it is on this paper's
 * job, ride the outcome so a door can offer Same Purchase: It's That Bill (the tie) beside Different
 * Purchase, instead of another read or a second bill.
 */
describe("a paper whose number is already on a bill", () => {
  it("the outcome names the bill and whether it is this job's, beside the Different Purchase door", async () => {
    bill.mockResolvedValueOnce({ ok: true, already: true, sameAs: "Already on the books: CED #8802, $301.81, on J-013 ARR #56. Nothing was recorded twice.", sameBillId: "b-ced", sameOnThisJob: true });
    const out = await readReceiptDocument("doc-1");
    expect(out).toMatchObject({ kind: "already", tone: "warn", samePurchase: true, sameBillId: "b-ced", sameOnThisJob: true });
    expect(out.sentence).toContain("Different Purchase: Record It Anyway");
  });

  it("a bill on another job: named, but not this job's (no tie is offered there)", async () => {
    bill.mockResolvedValueOnce({ ok: true, already: true, sameAs: "Already on the books: CED #8802, on J-002.", sameBillId: "b-ced", sameOnThisJob: false });
    expect(await readReceiptDocument("doc-1")).toMatchObject({ kind: "already", samePurchase: true, sameBillId: "b-ced", sameOnThisJob: false });
  });

  it("this very file already made a bill (no number match): plain already, no bill to tie", async () => {
    bill.mockResolvedValueOnce({ ok: true, already: true });
    const out = await readReceiptDocument("doc-1");
    expect(out).toEqual({ kind: "already", docId: "doc-1", tone: "ok", sentence: "Already recorded as a cost — nothing added twice." });
  });
});

describe("the pen sentence is not a warning (cn-v1181 fixer, skeptic #84 S7)", () => {
  it("a read with ink: tone ok, the sentence carries no pen words, the pen rides on its own field", async () => {
    bill.mockResolvedValueOnce({ ok: true, amount: 162, vendor: "Northline Supply", lineCount: 4, pen: "Pen marks read: 1 line crossed out." });
    const out = await readReceiptDocument("doc-1");
    expect(out).toMatchObject({ kind: "billed", tone: "ok", warning: null, pen: "Pen marks read: 1 line crossed out." });
    expect(out.sentence).not.toContain("Pen marks");
    const { penLineOf } = await import("./receipt-capture");
    expect(penLineOf(out)).toBe("Pen marks read: 1 line crossed out.");
  });
  it("a real warning still makes the tone warn, with the pen beside it", async () => {
    bill.mockResolvedValueOnce({ ok: true, amount: 162, vendor: "Northline Supply", lineCount: 4, warning: "The lines come to $150.00.", pen: "Pen marks read: 1 line crossed out." });
    const out = await readReceiptDocument("doc-1");
    expect(out).toMatchObject({ tone: "warn", warning: "The lines come to $150.00." });
    const { penLineOf } = await import("./receipt-capture");
    expect(penLineOf(out)).toBe("Pen marks read: 1 line crossed out.");
  });
});

describe("every door that draws a receipt's read draws the pen line, slate (S7)", () => {
  it("PenNote: slate, never amber; nothing when empty", async () => {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { createElement } = await import("react");
    const { PenNote } = await import("@/components/pen-note");
    const html = renderToStaticMarkup(createElement(PenNote, { text: "Pen marks read: 1 line crossed out." }));
    expect(html).toMatch(/text-slate-600/);
    expect(html).not.toMatch(/amber/);
    expect(renderToStaticMarkup(createElement(PenNote, { text: null }))).toBe("");
  });
  it("the job page's two doors and the Add Cost sheet each draw it", async () => {
    const { readFileSync } = await import("node:fs");
    const src = (p: string) => readFileSync(`${process.cwd()}/${p}`, "utf8");
    const capture = src("src/app/(app)/jobs/[id]/job-cost-capture.tsx");
    expect(capture).toContain("say(p.id, p.name, sentence, out.tone, differentDoc, sameBillId, penLineOf(out));");
    expect(capture).toContain("say(l.id, l.name, out.sentence, out.tone, undefined, undefined, penLineOf(out));");
    expect(capture).toContain('<PenNote text={l.pen} className="mt-0.5" />');
    const docs = src("src/app/(app)/jobs/[id]/job-documents.tsx");
    expect(docs).toContain("pen: penLineOf(out),");
    expect(docs).toContain('<PenNote text={n.pen} className="mt-0.5" />');
    const sheet = src("src/components/quick-cost-button.tsx");
    expect(sheet).toContain("if (res.warning || res.pen) {");
    expect(sheet).toContain('{penSaid && <p className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">{penSaid}</p>}');
  });
  it("Read Again keeps the door's pen sentence", async () => {
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(`${process.cwd()}/src/app/(app)/organize/read-again-core.ts`, "utf8")).toContain('doorSaid = [made.pen, made.warning].filter(Boolean).join(" ");');
  });
});
