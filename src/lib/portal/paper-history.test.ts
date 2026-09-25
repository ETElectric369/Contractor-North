import { describe, it, expect } from "vitest";
import { paperHistory, replaceChoices, showsAgainIfTakenOff, type ShareLike } from "./paper-history";
import { categoryIsShowable, defaultKindFor, docFormat, kindLabel, organizeRowIsMoney, titleFromName } from "./doc-kinds";
import { normalizeSharedPaper, paperRefusal } from "./share-input";

const ORG = "11111111-1111-4111-8111-111111111111";
const JOB = "22222222-2222-4222-8222-222222222222";
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const D = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const row = (id: string, over: Partial<ShareLike> = {}): ShareLike => ({
  document_id: id,
  title: `Title ${id.slice(0, 1)}`,
  kind: "circuit_map",
  replaces_document_id: null,
  shared_at: "2026-09-01T00:00:00Z",
  shared_by: "erik",
  removed_at: null,
  removed_by: null,
  replaces_marked_at: null,
  replaces_marked_by: null,
  ...over,
});

describe("versions: the customer sees only the newest, the office sees the chain", () => {
  // A (from the plan scans) ← B (Erik's new circuit map) ← C (the one after that); D is unrelated.
  const shares = [
    row(A),
    row(B, { replaces_document_id: A, shared_at: "2026-09-10T00:00:00Z", replaces_marked_at: "2026-09-10T00:00:00Z", replaces_marked_by: "erik" }),
    row(C, { replaces_document_id: B, shared_at: "2026-09-24T00:00:00Z", replaces_marked_at: "2026-09-24T00:00:00Z", replaces_marked_by: "erik" }),
    row(D, { kind: "permit", shared_at: "2026-09-05T00:00:00Z" }),
  ];

  it("one current paper per chain, newest shown first, each with its earlier versions newest first", () => {
    const h = paperHistory(shares);
    expect(h.current.map((c) => c.current.document_id)).toEqual([C, D]);
    expect(h.current[0].earlier.map((e) => [e.share.document_id, e.replacedBy?.document_id])).toEqual([
      [B, C],
      [A, B],
    ]);
    expect(h.takenOff).toEqual([]);
  });

  it("taking the newest down brings the one it replaced back, and the office is told which", () => {
    expect(showsAgainIfTakenOff(shares, C)?.document_id).toBe(B);
    expect(showsAgainIfTakenOff(shares, D)).toBeNull();
    const after = shares.map((s) => (s.document_id === C ? { ...s, removed_at: "2026-09-25T00:00:00Z" } : s));
    const h = paperHistory(after);
    expect(h.current.map((c) => c.current.document_id)).toEqual([B, D]);
    // C is nobody's earlier version: it is on the Taken Off list, from where it can go back up.
    expect(h.takenOff.map((s) => s.document_id)).toEqual([C]);
  });

  it("a newer paper can only be marked as replacing what the customer sees now, never itself", () => {
    expect(replaceChoices(shares, C).map((s) => s.document_id)).toEqual([D]);
    expect(replaceChoices(shares, D).map((s) => s.document_id)).toEqual([C]);
  });

  it("a loop in the data (which 0326 refuses) never hangs the office's page", () => {
    const loop = [row(A, { replaces_document_id: B }), row(B, { replaces_document_id: A, removed_at: "2026-09-02T00:00:00Z" })];
    expect(() => paperHistory(loop)).not.toThrow();
  });
});

describe("what a paper is, and whether a customer may see it", () => {
  it("the format decides how the portal draws it; a 3D file is a link, never dropped", () => {
    expect(docFormat(`${ORG}/${JOB}/1-panel.JPG`)).toBe("image");
    expect(docFormat(`${ORG}/${JOB}/1-plans.pdf`)).toBe("pdf");
    expect(docFormat(`${ORG}/${JOB}/1-house.e57`)).toBe("model");
    expect(docFormat(`${ORG}/${JOB}/1-kitchen.glb?token=x`)).toBe("model");
    expect(docFormat(`${ORG}/${JOB}/1-notes.docx`)).toBe("file");
    expect(kindLabel("scan_3d")).toBe("3D Scan");
    expect(kindLabel("something-new")).toBe("Document");
  });

  it("receipts, bills and invoices are refused by name; an allow-list decides the rest", () => {
    const at = (category: string | null, file = `${ORG}/${JOB}/1-x.pdf`) => paperRefusal({ category, file_url: file, job_id: JOB }, ORG);
    expect(at("Receipt")).toBe("A receipt is the company's own paper and is never shown to the customer.");
    expect(at("Bill")).toMatch(/never shown/);
    expect(at("Invoice")).toMatch(/never shown/);
    expect(at(null)).toMatch(/category first/);
    expect(at("Contract")).toMatch(/not a Contract/);
    expect(at("Plan")).toBeNull();
    expect(at("Other")).toBeNull();
    expect(at("Plan", `${ORG}/organize/1-x.pdf`)).toBe("Only papers uploaded on this job can be shown to the customer.");
    expect(at("Photo", `${ORG}/organize/1-x.jpg`)).toBe("Only photos taken or uploaded on this job can be shown to the customer.");
    expect(["Receipt", "Bill", "Invoice", "", "Note"].some(categoryIsShowable)).toBe(false);
  });

  it("a paper Organize tied to money is money paper whatever it is filed as", () => {
    expect(organizeRowIsMoney({ bill_id: "x", category: "Other" })).toBe(true);
    expect(organizeRowIsMoney({ tied_supplier_invoice_id: "x" })).toBe(true);
    expect(organizeRowIsMoney({ category: "Receipt" })).toBe(true);
    expect(organizeRowIsMoney({ category: "Photo" })).toBe(false);
  });

  it("the office's choices: a kind, a title, what it replaces; a PDF can't be a photo", () => {
    const plan = { id: A, name: "Circuit map rev 2.pdf", category: "Plan", file_url: `${ORG}/${JOB}/1-circuit.pdf` };
    expect(normalizeSharedPaper({}, plan, true)).toEqual({ ok: true, value: { kind: "plan", title: "Circuit map rev 2" } });
    expect(normalizeSharedPaper({ kind: "circuit_map", title: "  Circuit   Map ", replaces: B }, plan, true)).toEqual({
      ok: true,
      value: { kind: "circuit_map", title: "Circuit Map", replaces_document_id: B },
    });
    expect(normalizeSharedPaper({ kind: "photo" }, plan, false)).toMatchObject({ ok: false, error: expect.stringMatching(/Only a picture/) });
    expect(normalizeSharedPaper({ kind: "hologram" }, plan, false)).toMatchObject({ ok: false });
    expect(normalizeSharedPaper({ replaces: A }, plan, false)).toMatchObject({ ok: false, error: "A paper can't replace itself." });
    expect(normalizeSharedPaper({ title: " " }, plan, false)).toMatchObject({ ok: false, error: expect.stringMatching(/title/) });
    expect(normalizeSharedPaper({ replaces: "" }, plan, false)).toEqual({ ok: true, value: { replaces_document_id: null } });
    expect(defaultKindFor("Permit")).toBe("permit");
    expect(defaultKindFor("Other")).toBe("document");
    expect(titleFromName("IMG_2231.HEIC")).toBe("IMG_2231");
  });
});
