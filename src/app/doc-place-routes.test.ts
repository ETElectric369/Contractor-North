/**
 * The street on the end of a customer link is decoration (lib/doc-place): /i/<token>/<street> and
 * /q/<token>/<street> render exactly what /i/<token> and /q/<token> do, the token alone is the key,
 * and a link already sent keeps working. And the customer's PDF door names its file by the street.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const TOKEN = "tokTaoZhu080";
const INVOICE = {
  invoice: { invoice_number: "INV-080", status: "sent" },
  customer: { name: "Tao Zhu", address: "235 Timbercreek Ct" },
  site_candidates: [{ source: "job", parts: { address: "235 Timbercreek Court" } }],
};
const QUOTE = {
  quote: { quote_number: "E-017", doc_type: "estimate", status: "sent" },
  customer: { name: "Andrew Cohen", address: "13897 Herringbone Way Truckee  CA 96161" },
  site_candidates: [{ source: "quote", parts: { address: null } }, null, null],
};

const rpc = vi.fn(async (fn: string, _args: { p_token: string }) => ({ data: fn === "public_invoice" ? INVOICE : QUOTE }));

/** A PostgREST chain whose terminal reads answer per table. */
let rows: Record<string, unknown> = {};
function chain(table: string) {
  const c: Record<string, unknown> = {};
  for (const m of ["select", "eq", "order", "limit", "in"]) c[m] = () => c;
  c.maybeSingle = async () => ({ data: rows[table] ?? null });
  return c;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ rpc }),
  createServiceClient: () => ({
    from: (t: string) => chain(t),
    storage: { from: () => ({ download: async () => ({ data: new Blob([new Uint8Array([37, 80, 68, 70])]) }) }) },
  }),
}));

beforeEach(() => {
  rpc.mockClear();
  rows = {};
});

describe("/i/<token>/<street> is /i/<token>", () => {
  it("the same page and the same title, read by the token alone", async () => {
    const bare = await import("./i/[token]/page");
    const slugged = await import("./i/[token]/[place]/page");
    expect(slugged.default).toBe(bare.default);
    expect(slugged.generateMetadata).toBe(bare.generateMetadata);
    expect(slugged.dynamic).toBe("force-dynamic");

    const a = await bare.generateMetadata({ params: Promise.resolve({ token: TOKEN }) });
    const b = await slugged.generateMetadata({ params: Promise.resolve({ token: TOKEN, place: "235-timbercreek" } as { token: string }) });
    const c = await slugged.generateMetadata({ params: Promise.resolve({ token: TOKEN, place: "anything-at-all" } as { token: string }) });
    expect(a.title).toBe("INV-080_235 Timbercreek");
    expect(b.title).toBe(a.title);
    expect(c.title).toBe(a.title);
    for (const call of rpc.mock.calls) expect(call[1]).toEqual({ p_token: TOKEN });
  });
});

describe("/q/<token>/<street> is /q/<token>", () => {
  it("the same page and the same title, read by the token alone", async () => {
    const bare = await import("./q/[token]/page");
    const slugged = await import("./q/[token]/[place]/page");
    expect(slugged.default).toBe(bare.default);
    expect(slugged.generateMetadata).toBe(bare.generateMetadata);

    const a = await bare.generateMetadata({ params: Promise.resolve({ token: TOKEN }) });
    const b = await slugged.generateMetadata({ params: Promise.resolve({ token: TOKEN, place: "13897-herringbone" } as { token: string }) });
    expect(a.title).toBe("E-017_13897 Herringbone");
    expect(b.title).toBe(a.title);
    for (const call of rpc.mock.calls) expect(call[1]).toEqual({ p_token: TOKEN });
  });
});

describe("the customer's PDF door names the file by the street", () => {
  it("INV-080_235 Timbercreek.pdf, never the customer's name", async () => {
    rows = {
      invoices: {
        id: "11111111-1111-1111-1111-111111111111",
        status: "sent",
        invoice_number: "INV-080",
        jobs: { address: "235 Timbercreek Court" },
        customers: { address: "235 Timbercreek Ct" },
      },
      doc_pdf_cache: { path: "org/invoice/x/m0.75.pdf" },
    };
    const { GET } = await import("./api/share-pdf/[token]/route");
    const res = await GET(new Request(`https://x.test/api/share-pdf/${TOKEN}`) as never, { params: Promise.resolve({ token: TOKEN }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe(
      `inline; filename="INV-080_235 Timbercreek.pdf"; filename*=UTF-8''INV-080_235%20Timbercreek.pdf`,
    );
  });

  it("E-017_13897 Herringbone.pdf for an estimate", async () => {
    rows = {
      quotes: {
        id: "22222222-2222-2222-2222-222222222222",
        status: "sent",
        quote_number: "E-017",
        address: null,
        jobs: { address: "13897 Herringbone Way" },
        customers: { address: "13897 Herringbone Way Truckee  CA 96161" },
      },
      doc_pdf_cache: { path: "org/quote/x/m0.75.pdf" },
    };
    const { GET } = await import("./api/share-pdf/[token]/route");
    const res = await GET(new Request(`https://x.test/api/share-pdf/${TOKEN}`) as never, { params: Promise.resolve({ token: TOKEN }) });
    expect(res.headers.get("content-disposition")).toContain('filename="E-017_13897 Herringbone.pdf"');
  });
});
