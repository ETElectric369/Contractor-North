import { describe, it, expect } from "vitest";
import { invoiceAmount } from "./invoice-amount";

// Made-up figures only: this repo is public.
describe("invoiceAmount — what is due, and what it is due against, on one line", () => {
  it("names the total inline even when nothing is paid", () => {
    expect(invoiceAmount(1000, 0)).toEqual({
      due: "$1,000.00",
      against: "due of $1,000.00",
      line: "$1,000.00 due of $1,000.00",
      note: null,
      detail: null,
    });
    expect(invoiceAmount(1000, null).line).toBe("$1,000.00 due of $1,000.00");
    expect(invoiceAmount(1000, 0.004).note).toBeNull();
  });

  it("puts the balance and the total on one line and the paid amount under it on a partial", () => {
    expect(invoiceAmount(8318.62, 6760)).toEqual({
      due: "$1,558.62",
      against: "due of $8,318.62",
      line: "$1,558.62 due of $8,318.62",
      note: "$6,760.00 paid",
      detail: "of $8,318.62 · $6,760.00 paid",
    });
  });

  it("keeps the bill's size on screen when it is settled (the $0.00 · Paid rows)", () => {
    const a = invoiceAmount(1000, 1000);
    expect(a.line).toBe("$0.00 due of $1,000.00");
    expect(a.note).toBe("paid in full");
    expect(a.detail).toBe("of $1,000.00 · paid in full");
    // Float dust is still paid in full.
    expect(invoiceAmount(0.03, 0.01 + 0.02).note).toBe("paid in full");
  });

  it("names an overpayment instead of hiding it in a $0.00", () => {
    const a = invoiceAmount(1000, 1040);
    expect(a.line).toBe("$0.00 due of $1,000.00");
    expect(a.note).toBe("$1,040.00 paid · $40.00 over");
    expect(a.detail).toBe("of $1,000.00 · $1,040.00 paid · $40.00 over");
  });

  it("prints a credit memo's negative total and calls it a credit, never $0.00", () => {
    expect(invoiceAmount(-250, 0)).toEqual({ due: "-$250.00", against: "credit", line: "-$250.00 credit", note: null, detail: "credit" });
    expect(invoiceAmount(-250, null).line).toBe("-$250.00 credit");
  });

  it("the line is always the figure then the words, so a row can bold just the figure", () => {
    for (const [t, p] of [[1000, 0], [1000, 250], [1000, 1000], [-250, 0], [0, 0]] as const) {
      const a = invoiceAmount(t, p);
      expect(a.line).toBe(`${a.due} ${a.against}`);
    }
  });

  it("never says a VOID invoice is due: it says what the bill was, and any money that came in", () => {
    expect(invoiceAmount(8318.62, 0, "void")).toEqual({ due: "Void", against: "· was $8,318.62", line: "Void · was $8,318.62", note: null, detail: "was $8,318.62" });
    const paid = invoiceAmount(1000, 200, "void");
    expect(paid.line).toBe("Void · was $1,000.00");
    expect(paid.line).not.toContain("due");
    expect(paid.note).toBe("$200.00 paid");
    expect(paid.line).toBe(`${paid.due} ${paid.against}`);
    // Every other status keeps the one due line.
    expect(invoiceAmount(1000, 200, "sent").line).toBe("$800.00 due of $1,000.00");
    expect(invoiceAmount(1000, 200, null).line).toBe("$800.00 due of $1,000.00");
  });

  it("never prints NaN", () => {
    expect(invoiceAmount(Number.NaN, Number.NaN).line).toBe("$0.00 due of $0.00");
    expect(invoiceAmount(undefined, 50).due).toBe("$0.00");
    expect(invoiceAmount(undefined, 50).line).not.toContain("NaN");
  });
});
