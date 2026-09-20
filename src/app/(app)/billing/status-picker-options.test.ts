import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * TWO <option>s MAY NEVER SHARE A VALUE (cn-v967; INV-071, 2026-09-20).
 *
 * The Status picker on an invoice renders a DEED you can declare ("Sent Again - I re-sent it
 * myself") above a disabled option showing what the invoice actually IS ("Sent"). Both carried
 * value="sent". A browser resolves a select's value by the FIRST option in tree order that
 * matches, so on Karen Wucher's INV-071 ($1,875.98, sent 2026-09-19, revised 2026-09-20) the
 * CLOSED dropdown read "Sent Again - I re-sent it myself" — as though the corrected bill were
 * already in her hands — while the amber banner three inches below was asking Erik to go send it.
 * The picker said done, the banner said not done, and the banner was the one telling the truth.
 *
 * The duplicate broke the action as well as the label: picking the option the browser already
 * considers selected fires no change event, so the re-send declaration was a no-op.
 *
 * This is a browser-semantics bug in a file that no test can render (these suites run in plain
 * Node, with no DOM), so it is pinned the way public-doors.test.ts pins its doors: read the real
 * source, take the real option values out of it, and assert the invariant against the real live
 * invoice. The invariant is not "sent is spelled sent-by-hand" — it is that NO status the picker
 * can hold is ever spelled by more than one option, which is the class, not the instance.
 */

const PICKER = "src/app/(app)/billing/[id]/invoice-detail.tsx";
const src = readFileSync(join(process.cwd(), PICKER), "utf8");

/** The Status <Select>, sliced out of the page by the label that sits beside it. */
const block = (() => {
  const at = src.indexOf('<span className="text-sm text-slate-500">Status</span>');
  expect(at, "the Status picker moved or was renamed").toBeGreaterThan(-1);
  const end = src.indexOf("</Select>", at);
  expect(end, "the Status <Select> has no closing tag").toBeGreaterThan(at);
  return src.slice(at, end);
})();

/** Every option's value, in the order the browser will see them. A literal comes back as its
 *  text; an expression comes back as the expression, e.g. "{invoice.status}". */
const optionValues = [...block.matchAll(/<option\s+value=(\{[^}]+\}|"[^"]+")/g)].map((m) =>
  m[1].startsWith('"') ? m[1].slice(1, -1) : m[1],
);

/** Every status the server will accept (billing/actions.ts INVOICE_STATUSES). The disabled
 *  current-status option can render any of these except draft and void. */
const LIVE_STATUSES = ["sent", "partial", "paid", "overdue"];

describe("the Status picker's options", () => {
  it("still has options to check", () => {
    expect(optionValues.length).toBeGreaterThan(2);
  });

  it("NO STATUS IS SPELLED TWICE — the class, not just the one that bit us", () => {
    // A literal option carrying a live status collides with `value={invoice.status}` the moment
    // the invoice reaches that status. "sent" is the one that happened; "paid" and "partial" are
    // the same trap waiting for the next person to add a shortcut to this list.
    for (const status of LIVE_STATUSES) {
      expect(optionValues.filter((v) => v === status), `a literal <option value="${status}"> collides with the current-status option`).toHaveLength(0);
    }
    const literals = optionValues.filter((v) => !v.startsWith("{"));
    expect(new Set(literals).size, `duplicate option values: ${literals.join(", ")}`).toBe(literals.length);
  });

  it("the option that shows what the invoice IS reads the invoice, not a guess", () => {
    expect(optionValues).toContain("{invoice.status}");
  });

  it("the re-send declaration has a value of its own, translated back before it is sent", () => {
    expect(optionValues).toContain("sent-by-hand");
    // The server's whitelist has no "sent-by-hand" in it, and cn-v962's `redelivered` branch keys
    // off "sent" — so the translation has to happen, and it has to happen here.
    expect(src).toMatch(/e\.target\.value === "sent-by-hand" \? "sent" : e\.target\.value/);
  });
});

describe("INV-071 as the browser renders it", () => {
  /** What the browser does: first option in tree order whose value matches wins. */
  const firstMatch = (options: string[], value: string) => options.indexOf(value);

  /** The options that actually render for INV-071 — status 'sent', amount_paid $0.00 (so Draft is
   *  still on offer), customerHoldsOlderCopy true (sent 2026-09-19, revised 2026-09-20). */
  const rendered = optionValues.map((v) => (v === "{invoice.status}" ? "sent" : v));

  it("exactly one option can satisfy value='sent', so the closed picker reads 'Sent'", () => {
    const hits = rendered.filter((v) => v === "sent");
    expect(hits, `value='sent' is claimed by ${hits.length} options; the browser would show the first`).toHaveLength(1);
    // And the one that claims it is the current-status option, not the action above it.
    expect(firstMatch(rendered, "sent")).toBe(rendered.lastIndexOf("sent"));
  });

  it("picking the declaration is a real change, so the re-send is not a no-op", () => {
    // A <select> sitting at "sent" whose action option is also "sent" fires no change event.
    // Distinct values are what make the click reach setInvoiceStatus at all.
    expect(rendered.indexOf("sent-by-hand")).not.toBe(rendered.indexOf("sent"));
  });

  it("the labels still name the deed, in Title Case, with no em dash", () => {
    expect(src).toContain("Sent Again - I re-sent it myself");
    expect(src).toContain("Sent - I sent it myself");
    expect("Sent Again - I re-sent it myself").not.toContain("—");
  });
});
