import { describe, it, expect } from "vitest";
import { jobBillForPayment } from "./job-bill-for-payment";
import { finishedWithWorkOffBill, finishWouldLeaveOffBill, notBilledWords } from "./finish-job-words";

const bill = (invoice_number: string, status: string, total: number, amount_paid = 0) => ({ id: invoice_number.toLowerCase(), invoice_number, status, total, amount_paid });

describe("a payment from the job page lands on the job's open bill (J-052, J-028)", () => {
  it("J-052: INV-074 sent and open for $624.49 takes the payment — no second invoice", () => {
    const c = jobBillForPayment([bill("INV-074", "sent", 624.49)], { card: false });
    expect(c).toMatchObject({ kind: "land", bill: { invoice_number: "INV-074" }, balance: 624.49 });
  });

  it("J-028: INV-061 paid in full is not open — a new doorstep bill may be written", () => {
    expect(jobBillForPayment([bill("INV-061", "paid", 8432.15, 8432.15)], { card: false })).toEqual({ kind: "none" });
  });

  it("a CARD on the job's open draft asks to send it first; cash on it just lands (a draft takes a deposit)", () => {
    const draft = [bill("INV-078", "draft", 9505.83, 6760)];
    expect(jobBillForPayment(draft, { card: true })).toMatchObject({ kind: "needsSend", bill: { invoice_number: "INV-078" }, balance: 2745.83 });
    expect(jobBillForPayment(draft, { card: false })).toMatchObject({ kind: "land", bill: { invoice_number: "INV-078" } });
  });

  it("two open bills are named, never guessed between", () => {
    const c = jobBillForPayment([bill("INV-061", "sent", 100), bill("INV-064", "partial", 300, 50)], { card: false });
    expect(c).toEqual({ kind: "ambiguous", bills: [{ number: "INV-061", balance: 100 }, { number: "INV-064", balance: 250 }] });
  });

  it("a void bill is not a door", () => {
    expect(jobBillForPayment([bill("INV-070", "void", 500)], { card: true })).toEqual({ kind: "none" });
  });
});

describe("Finish Job names the work that is not on a bill (Tao J-002)", () => {
  const tao = { hours: 19.5, laborAmount: 2437.5, billsCount: 0, billsBilled: 0 };

  it("before the press", () => {
    expect(finishWouldLeaveOffBill(tao)).toBe(
      "Not billed yet: 19.5 h ($2,437.50). Finishing marks the job complete and does not bill it. To bill it first: Invoices tab → Progress Payment → Final → Actual T&M.",
    );
  });

  it("after the press", () => {
    expect(finishedWithWorkOffBill(tao)).toBe(
      "19.5 h ($2,437.50) of work on this job is not on a bill yet. Finishing didn't bill it - bill it with Progress Payment → Final on the job's Invoices tab.",
    );
  });

  it("hours and bills together, and nothing when everything is billed", () => {
    expect(notBilledWords({ hours: 2, laborAmount: 200, billsCount: 2, billsBilled: 50.25 })).toBe("2 h and 2 bills ($250.25)");
    expect(notBilledWords({ hours: 0, laborAmount: 0, billsCount: 0, billsBilled: 0 })).toBeNull();
    expect(finishWouldLeaveOffBill(null)).toBeNull();
  });
});
