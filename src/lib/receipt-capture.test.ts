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
    expect(off.sentence).toContain("Record As Cost");
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
    bill.mockResolvedValueOnce({ ok: true, already: true, sameAs: "Already on the books: CED #8802, $301.81, on J-013 TTP #56. Nothing was recorded twice.", sameBillId: "b-ced", sameOnThisJob: true });
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
