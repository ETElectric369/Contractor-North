import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {}, push: () => {} }), useSearchParams: () => new URLSearchParams() }));
vi.mock("@/components/toast", () => ({ useToast: () => () => {} }));
vi.mock("@/app/(app)/jobs/already-billed-actions", () => ({
  alreadyBilledSheet: vi.fn(),
  noJobHoursSheet: vi.fn(),
  markAlreadyBilled: vi.fn(),
  unmarkAlreadyBilled: vi.fn(),
}));
vi.mock("@/app/(app)/jobs/actions", () => ({ createBill: vi.fn(), deleteDocument: vi.fn(), setBillStatus: vi.fn(), deleteBill: vi.fn() }));
vi.mock("@/lib/actions/execute", () => ({ executeAction: vi.fn() }));

import { BillAlreadyBilledDoor } from "./bills-receipts";

/**
 * ALREADY BILLED ON THE BILL'S OWN ROW (0357, Erik 2026-09-26: "the Already Billed could connect to
 * the bill on that screen too"). Bills → All Bills → a bill's detail carries the same door the job's
 * Costs tab does, or the mark it carries with its way back. The page decides which (lib/already-billed
 * billAlreadyBilledDoors); these pin what he sees: 44px, Title Case, the invoice named.
 */
const buttons = (html: string) =>
  Array.from(html.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)).map((m) => ({ attrs: m[1], words: m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() }));
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("a bill's own row", () => {
  it("Already Billed on a bill on a job no invoice holds, where the job's sheet could hold it", () => {
    const html = renderToStaticMarkup(createElement(BillAlreadyBilledDoor, { bill: { id: "ps" }, door: { kind: "open", jobId: "j-010", what: "CED 8802-1101475" } }));
    const b = buttons(html);
    expect(b.map((x) => x.words)).toEqual(["Already Billed"]);
    expect(b[0].attrs).toMatch(/\bh-11\b/);
  });

  it("Billed By Hand On INV-00023 · Not Billed After All on a bill a person marked", () => {
    const html = renderToStaticMarkup(
      createElement(BillAlreadyBilledDoor, {
        bill: { id: "ps" },
        door: { kind: "hand", jobId: "j-010", lineId: "li-mat", ids: ["ps"], invoiceNumber: "INV-00023", what: "CED 8802-1101475" },
      }),
    );
    expect(text(html)).toContain("Billed By Hand On INV-00023");
    const b = buttons(html);
    expect(b.map((x) => x.words)).toEqual(["Not Billed After All"]);
    expect(b[0].attrs).toMatch(/\bh-11\b/);
  });

  it("nothing when the page offers neither", () => {
    expect(renderToStaticMarkup(createElement(BillAlreadyBilledDoor, { bill: { id: "x" }, door: undefined }))).toBe("");
  });

  it("the ledger row draws it beside the bill's own doors, and the page hands it the doors", () => {
    const row = readFileSync(join(process.cwd(), "src/app/(app)/bills/bills-receipts.tsx"), "utf8");
    expect(row).toMatch(/<BillRowDoors bill=\{b\}[^\n]*\/>\s*<BillAlreadyBilledDoor bill=\{b\} door=\{alreadyBilled\[b\.id\]\} \/>/);
    const page = readFileSync(join(process.cwd(), "src/app/(app)/bills/page.tsx"), "utf8");
    expect(page).toContain("alreadyBilled={billDoors}");
    expect(page).toMatch(/const billDoors =\s*ledgerReach && ledgerReach\.ready\s*\?\s*billAlreadyBilledDoors\(/);
  });
});
