import { describe, it, expect, vi, beforeEach } from "vitest";
import { TIMBER_CREEK } from "@/test/ced-timber-creek";

/**
 * THE CED PDF ITSELF IS KEPT (Erik, 2026-09-26: Open Bill said "The PDF itself isn't kept here").
 *
 * Pinned: the bytes go to the PRIVATE documents bucket, under this org's staff-only organize
 * folder, named by their SHA-256; ONE upload per file even when the file holds several invoices,
 * and every one of those rows names the stored path; the same PDF again is never uploaded again;
 * a PDF that doesn't save never blocks its documents (they land with the file's name, and the
 * sentence says which PDF didn't save and how to keep it); a stored path is never swapped back for
 * a bare name.
 */

const state = vi.hoisted(() => ({ client: null as any }));
vi.mock("@/lib/staff-guard", () => ({
  requireStaff: vi.fn(async () => ({ supabase: state.client, userId: "user-1", orgId: "org-1" })),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/observe", () => ({ reportError: () => {} }));

import { importCedInvoices } from "./supplier-import-actions";
import { sha256Hex } from "@/lib/content-hash";
import { cedPdfPath } from "@/lib/ced-pdf-store";

type Call = { table: string; verb: string; payload?: any; eqs: [string, unknown][]; ins: [string, unknown][] };
const uploads: { path: string; bytes: Uint8Array; opts: any }[] = [];
let uploadAnswer: { error: unknown } = { error: null };

function fakeSupabase(script: Record<string, any[]>, calls: Call[]) {
  const next = (key: string) => {
    const q = script[key];
    if (!q || q.length === 0) throw new Error(`unscripted call: ${key}`);
    return q.shift();
  };
  return {
    storage: {
      from: (bucket: string) => ({
        upload: async (path: string, bytes: Uint8Array, opts: any) => {
          expect(bucket).toBe("documents");
          uploads.push({ path, bytes, opts });
          return uploadAnswer;
        },
      }),
    },
    from(table: string) {
      const call: Call = { table, verb: "select", eqs: [], ins: [] };
      calls.push(call);
      const chain: any = {
        select: () => chain,
        insert: (payload: any) => ((call.verb = "insert"), (call.payload = payload), chain),
        update: (payload: any) => ((call.verb = "update"), (call.payload = payload), chain),
        eq: (col: string, v: unknown) => (call.eqs.push([col, v]), chain),
        in: (col: string, v: unknown) => (call.ins.push([col, v]), chain),
        limit: () => chain,
        then(resolve: any, reject: any) {
          try {
            resolve(next(`${table}.${call.verb}`));
          } catch (e) {
            reject?.(e);
          }
        },
      };
      return chain;
    },
  };
}

// One downloaded PDF, two invoices in it (CED sends them that way): Timber Creek, and the same
// paper under a second number. Both reconcile on their own arithmetic.
const SECOND = TIMBER_CREEK.replace(/8802-1101363/g, "8802-1101364");
const TWO_INVOICE_TEXT = `${TIMBER_CREEK}\n${SECOND}`;
const PDF = new TextEncoder().encode("%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n");
let PATH: string;

let calls: Call[];
beforeEach(async () => {
  calls = [];
  uploads.length = 0;
  uploadAnswer = { error: null };
  PATH = cedPdfPath("org-1", await sha256Hex(PDF));
});
const did = (table: string, verb: string) => calls.filter((c) => c.table === table && c.verb === verb);
const fresh = (over: Record<string, any[]> = {}) => ({
  "supplier_accounts.select": [{ data: [], error: null }],
  "supplier_invoices.select": [{ data: [], error: null }],
  "supplier_invoices.insert": [
    {
      data: [
        { id: "si-1", invoice_number: "8802-1101363" },
        { id: "si-2", invoice_number: "8802-1101364" },
      ],
      error: null,
    },
  ],
  "supplier_invoice_lines.insert": [{ data: Array.from({ length: 10 }, (_, i) => ({ id: `l${i}` })), error: null }],
  ...over,
});

describe("a CED PDF is kept once, and every invoice in it can open it", () => {
  it("one PDF holding two invoices: one upload, to the org's private staff-only folder, named by its content; both rows name it", async () => {
    state.client = fakeSupabase(fresh(), calls);
    const res = await importCedInvoices({ files: [{ name: "invoice_8802-1101363.pdf", text: TWO_INVOICE_TEXT, pdf: PDF }] });
    expect(res.ok).toBe(true);
    expect(res.landed.map((d) => d.invoiceNumber).sort()).toEqual(["8802-1101363", "8802-1101364"]);
    expect(uploads).toHaveLength(1);
    expect(uploads[0].path).toBe(PATH);
    expect(uploads[0].path).toMatch(/^org-1\/organize\/ced\/[0-9a-f]{64}\.pdf$/);
    expect(uploads[0].opts).toEqual({ contentType: "application/pdf", upsert: false });
    const rows = did("supplier_invoices", "insert")[0].payload as any[];
    expect(rows.map((r) => r.source_file)).toEqual([PATH, PATH]);
    // What the screen names back is still the file he picked, not a hash.
    expect(res.landed.every((d) => d.sourceFile === "invoice_8802-1101363.pdf")).toBe(true);
    expect(res.message).not.toContain("didn't save");
  });

  it("the same PDF picked twice in one go (renamed) is still one upload", async () => {
    state.client = fakeSupabase(fresh(), calls);
    await importCedInvoices({
      files: [
        { name: "a.pdf", text: TWO_INVOICE_TEXT, pdf: PDF },
        { name: "a copy.pdf", text: TWO_INVOICE_TEXT, pdf: PDF },
      ],
    });
    // The second file reads as the same documents: nothing of its own to keep.
    expect(uploads).toHaveLength(1);
  });

  it("re-importing the same PDF uploads nothing and writes nothing", async () => {
    const onFile = (number: string, id: string) => ({
      id,
      invoice_number: number,
      kind: "invoice",
      invoice_date: "2026-06-15",
      job_name_raw: "235 TIMBER CREEK",
      job_id: null,
      supplier_account_id: null,
      merchandise: 149.04,
      tax: 13.41,
      shipping: 0,
      total: 162.45,
      discount_amount: 1.38,
      discount_by: "2026-07-10",
      open_balance: 162.45,
      closed: false,
      source_file: PATH,
    });
    state.client = fakeSupabase(
      {
        "supplier_accounts.select": [{ data: [], error: null }],
        "supplier_invoices.select": [{ data: [onFile("8802-1101363", "si-1"), onFile("8802-1101364", "si-2")], error: null }],
        "supplier_invoice_lines.select": [{ data: [{ supplier_invoice_id: "si-1" }, { supplier_invoice_id: "si-2" }], error: null }],
      },
      calls,
    );
    const res = await importCedInvoices({ files: [{ name: "renamed.pdf", text: TWO_INVOICE_TEXT, pdf: PDF }] });
    expect(res.ok).toBe(true);
    expect(uploads).toEqual([]);
    expect(did("supplier_invoices", "update")).toEqual([]);
    expect(res.unchanged).toHaveLength(2);
  });

  it("documents imported before (a name only) gain the stored PDF, and read as unchanged", async () => {
    const named = (number: string, id: string) => ({
      id,
      invoice_number: number,
      kind: "invoice",
      invoice_date: "2026-06-15",
      job_name_raw: "235 TIMBER CREEK",
      job_id: null,
      supplier_account_id: null,
      merchandise: 149.04,
      tax: 13.41,
      shipping: 0,
      total: 162.45,
      discount_amount: 1.38,
      discount_by: "2026-07-10",
      open_balance: 162.45,
      closed: false,
      source_file: "invoice_8802-1101363.pdf",
    });
    state.client = fakeSupabase(
      {
        "supplier_accounts.select": [{ data: [], error: null }],
        "supplier_invoices.select": [{ data: [named("8802-1101363", "si-1"), named("8802-1101364", "si-2")], error: null }],
        "supplier_invoice_lines.select": [{ data: [{ supplier_invoice_id: "si-1" }, { supplier_invoice_id: "si-2" }], error: null }],
        "supplier_invoices.update": [
          { data: [{ id: "si-1" }], error: null },
          { data: [{ id: "si-2" }], error: null },
        ],
      },
      calls,
    );
    const res = await importCedInvoices({ files: [{ name: "invoice_8802-1101363.pdf", text: TWO_INVOICE_TEXT, pdf: PDF }] });
    expect(uploads).toHaveLength(1);
    const writes = did("supplier_invoices", "update");
    expect(writes.map((w) => w.payload)).toEqual([{ source_file: PATH }, { source_file: PATH }]);
    for (const w of writes) expect(w.eqs).toContainEqual(["org_id", "org-1"]);
    expect(res.unchanged).toHaveLength(2);
    expect(res.updated).toEqual([]);
    expect(res.message).toContain("The PDF is kept now for 2 documents that were already here.");
  });

  it("a failed upload never blocks the import: the documents land with the name, and the sentence says so", async () => {
    uploadAnswer = { error: { message: "Bucket unreachable", statusCode: "503" } };
    state.client = fakeSupabase(fresh(), calls);
    const res = await importCedInvoices({ files: [{ name: "invoice_8802-1101363.pdf", text: TWO_INVOICE_TEXT, pdf: PDF }] });
    expect(res.ok).toBe(true);
    expect(res.landed).toHaveLength(2);
    const rows = did("supplier_invoices", "insert")[0].payload as any[];
    expect(rows.map((r) => r.source_file)).toEqual(["invoice_8802-1101363.pdf", "invoice_8802-1101363.pdf"]);
    expect(res.message).toContain("This PDF didn't save, so Open Bill can't show it: invoice_8802-1101363.pdf (the upload failed (Bucket unreachable))");
    expect(res.message).toContain("Choose it again with Choose CED PDFs to keep the PDF.");
  });

  it("storage saying the object is already there is the answer we wanted: the path is recorded", async () => {
    uploadAnswer = { error: { message: "The resource already exists", statusCode: "409" } };
    state.client = fakeSupabase(fresh(), calls);
    const res = await importCedInvoices({ files: [{ name: "a.pdf", text: TWO_INVOICE_TEXT, pdf: PDF }] });
    expect(res.ok).toBe(true);
    expect((did("supplier_invoices", "insert")[0].payload as any[]).map((r) => r.source_file)).toEqual([PATH, PATH]);
    expect(res.message).not.toContain("didn't save");
  });

  it("bytes that aren't a PDF are never stored, and the documents still land", async () => {
    state.client = fakeSupabase(fresh(), calls);
    const res = await importCedInvoices({ files: [{ name: "a.pdf", text: TWO_INVOICE_TEXT, pdf: new TextEncoder().encode("hello") }] });
    expect(res.ok).toBe(true);
    expect(uploads).toEqual([]);
    expect(res.message).toContain("a.pdf (it isn't a PDF inside)");
  });

  it("a re-import by paste (no bytes) never swaps a stored PDF back for a bare name", async () => {
    const stored = {
      id: "si-1",
      invoice_number: "8802-1101363",
      kind: "invoice",
      invoice_date: "2026-06-15",
      job_name_raw: "235 TIMBER CREEK",
      job_id: null,
      supplier_account_id: null,
      merchandise: 149.04,
      tax: 13.41,
      shipping: 0,
      total: 162.45,
      discount_amount: 1.38,
      discount_by: "2026-07-10",
      open_balance: 162.45,
      closed: false,
      source_file: PATH,
    };
    state.client = fakeSupabase(
      {
        "supplier_accounts.select": [{ data: [], error: null }],
        "supplier_invoices.select": [{ data: [stored], error: null }],
        "supplier_invoice_lines.select": [{ data: [{ supplier_invoice_id: "si-1" }], error: null }],
      },
      calls,
    );
    const res = await importCedInvoices({ files: [{ name: "something-else.pdf", text: TIMBER_CREEK }] });
    expect(res.ok).toBe(true);
    expect(did("supplier_invoices", "update")).toEqual([]);
    expect(res.unchanged.map((d) => d.invoiceNumber)).toEqual(["8802-1101363"]);
  });
});
