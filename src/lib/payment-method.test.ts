import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  DEFAULT_PAYMENT_METHODS,
  PAYMENT_METHOD_ALIASES,
  PAYMENT_METHOD_LABELS,
  isPaymentMethod,
  paymentMethodChoices,
  paymentMethodKey,
  paymentMethodLabel,
} from "./payment-method";
import { DEFAULT_SETTINGS } from "./org-settings";

describe("paymentMethodKey / paymentMethodLabel", () => {
  const cases: Array<[raw: string, key: string, label: string]> = [
    ["Cash", "cash", "Cash"],
    [" venmo ", "venmo", "Venmo"],
    ["Check", "check", "Check"],
    ["Cheque", "check", "Check"],
    ["Credit Card", "card", "Card"],
    ["Bank Transfer", "transfer", "Transfer"],
    ["Cash App", "cashapp", "Cash App"],
    ["", "other", "Other"],
    ["Apple Cash", "apple cash", "Apple Cash"],
    ["ach", "ach", "ACH"],
    ["us_bank_account", "ach", "ACH"],
    ["  Wire   Transfer ", "transfer", "Transfer"],
    // A custom method that happens to name an Object.prototype member is still just text.
    ["Constructor", "constructor", "Constructor"],
    ["__proto__", "__proto__", "__proto__"],
    ["toString", "tostring", "Tostring"],
  ];
  for (const [raw, key, label] of cases) {
    it(`${JSON.stringify(raw)} is stored as ${key} and reads ${label}`, () => {
      expect(paymentMethodKey(raw)).toBe(key);
      expect(paymentMethodLabel(raw)).toBe(label);
    });
  }

  it("treats null and undefined as other", () => {
    expect(paymentMethodKey(null)).toBe("other");
    expect(paymentMethodKey(undefined)).toBe("other");
  });

  it("is idempotent: a key normalizes to itself", () => {
    for (const k of Object.keys(PAYMENT_METHOD_LABELS)) expect(paymentMethodKey(k)).toBe(k);
    for (const k of Object.values(PAYMENT_METHOD_ALIASES)) expect(paymentMethodKey(k)).toBe(k);
  });

  it("maps every alias onto a key that has a label", () => {
    for (const k of Object.values(PAYMENT_METHOD_ALIASES)) expect(PAYMENT_METHOD_LABELS[k]).toBeTruthy();
  });
});

/**
 * ── ONE LIST OF THE WAYS MONEY MOVES (cn-v1152) ────────────────────────────────────────────────
 * Erik, 2026-11-07: "there are some payment entry windows that show venmo as an option then others
 * that dont … i had to add venmo in the notes". Every door that records a payment draws its chips
 * from Settings › Payment methods through paymentMethodChoices and stores the key.
 */
describe("paymentMethodChoices: the chips every pay door draws", () => {
  it("keeps the company's own spelling as the label and submits the key", () => {
    expect(paymentMethodChoices(["Cash", "Venmo", "Apple Cash", "Credit Card"])).toEqual([
      { key: "cash", label: "Cash" },
      { key: "venmo", label: "Venmo" },
      { key: "apple cash", label: "Apple Cash" },
      { key: "card", label: "Credit Card" },
    ]);
  });

  it("two spellings of one key are one chip, the first spelling's", () => {
    expect(paymentMethodChoices(["Venmo", "venmo", " VENMO ", "Cheque", "Check"])).toEqual([
      { key: "venmo", label: "Venmo" },
      { key: "check", label: "Cheque" },
    ]);
  });

  it("skips blanks and tidies spaces, and an empty list draws the house default", () => {
    expect(paymentMethodChoices(["", "  ", null, undefined, "  Zelle  "])).toEqual([{ key: "zelle", label: "Zelle" }]);
    const house = DEFAULT_PAYMENT_METHODS.map((m) => ({ key: paymentMethodKey(m), label: m }));
    expect(paymentMethodChoices([])).toEqual(house);
    expect(paymentMethodChoices(null)).toEqual(house);
    expect(paymentMethodChoices(["", "  "])).toEqual(house);
    expect(paymentMethodChoices([], [])).toEqual([]);
  });

  it("the house default is the one list a company starts with (org-settings reads this copy)", () => {
    expect(DEFAULT_PAYMENT_METHODS).toEqual(["Cash", "Check", "Card", "Zelle", "Venmo", "Transfer"]);
    expect(DEFAULT_SETTINGS.payment_methods).toEqual([...DEFAULT_PAYMENT_METHODS]);
    for (const m of DEFAULT_PAYMENT_METHODS) expect(paymentMethodLabel(m)).toBe(m);
  });
});

describe("isPaymentMethod: a word that reads as a way money moves", () => {
  it("is any non-blank string; a blank is not a pick and nothing else is a word", () => {
    for (const v of ["cash", "Venmo", "apple cash", " zelle "]) expect(isPaymentMethod(v)).toBe(true);
    for (const v of ["", "   ", null, undefined, 0, 3, {}, [], true]) expect(isPaymentMethod(v)).toBe(false);
  });
});

/** Source with comments removed, so prose can neither satisfy nor trip an assertion about code. */
const code = (path: string) =>
  readFileSync(join(process.cwd(), path), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s)\/\/[^\n]*/g, "$1");

/** The body of one exported function, up to the next export. */
const fnBody = (src: string, head: string) => {
  const at = src.indexOf(head);
  expect(at, head).toBeGreaterThan(-1);
  const next = src.indexOf("\nexport ", at + 1);
  return src.slice(at, next === -1 ? undefined : next);
};

describe("every door that writes payments.method writes a key", () => {
  const actions = code("src/app/(app)/billing/actions.ts");

  it("recordPayment normalizes what it was handed", () => {
    const body = fnBody(actions, "export async function recordPayment(");
    expect(body).toMatch(/method: input\.method\?\.trim\(\) \? paymentMethodKey\(input\.method\) : "check"/);
    expect(body).not.toMatch(/method: input\.method \|\|/);
  });

  it("updatePayment normalizes what it was handed", () => {
    const body = fnBody(actions, "export async function updatePayment(");
    expect(body).toMatch(/method: patch\.method\?\.trim\(\) \? paymentMethodKey\(patch\.method\) : "check"/);
    expect(body).not.toMatch(/method: patch\.method \|\|/);
  });

  it("the Stripe writer (the webhook's and the Pay Now sheet's, one module) writes a key: card, or ach for a bank debit (audit v994 BK2)", () => {
    // The insert moved out of the route on 2026-09-30 into lib/record-invoice-payment.ts, the one
    // writer the webhook and tapPaymentOutcome share; the route itself writes no payment row.
    const hook = code("src/lib/record-invoice-payment.ts");
    expect(code("src/app/api/stripe/webhook/route.ts")).not.toMatch(/from\("payments"\)\s*\.(insert|upsert)\(/);
    const inserts = [...hook.matchAll(/from\("payments"\)\.insert\(\{[\s\S]*?\}\)/g)].map((m) => m[0]);
    expect(inserts.length).toBeGreaterThan(0);
    for (const ins of inserts) expect(ins).toContain('method: paymentMethodKey(via.method ?? "card")');
    expect(paymentMethodKey("us_bank_account")).toBe("ach");
  });

  it("no other code writes a method into payments", () => {
    // If a third writer appears it has to be added here on purpose, with its key. (The database
    // trigger from 0287 backs all of them regardless.)
    // The bank download (2026-09-27) puts a deposit a person placed on an invoice, keyed.
    const writers = new Set(["src/app/(app)/billing/actions.ts", "src/lib/record-invoice-payment.ts", "src/app/(app)/bills/bank-core.ts"]);
    expect(code("src/app/(app)/bills/bank-core.ts")).toContain("method: paymentMethodKey(depositMethod(w.line.description))");
    const files = (readdirSync(join(process.cwd(), "src"), { recursive: true }) as string[])
      .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f))
      .map((f) => join("src", f));
    const found = files.filter((f) => /from\("payments"\)\s*\.(insert|upsert)\(/.test(code(f)));
    expect(found.sort()).toEqual([...writers].sort());
  });
});

describe("every screen that shows a method shows its label", () => {
  it("the invoice page, Payments In on /billing (the old /payments ledger), the story feed and the customer's copy", () => {
    for (const f of [
      "src/app/(app)/billing/[id]/invoice-detail.tsx",
      "src/app/(app)/billing/page.tsx",
      "src/lib/story.ts",
      "src/components/invoice-document.tsx",
    ]) {
      const src = code(f);
      expect(src, f).toContain("paymentMethodLabel(");
      expect(src, f).not.toMatch(/\{p\.method\}/);
      expect(src, f).not.toMatch(/cell: \(p\) => p\.method \}/);
    }
  });

  it("the payment editor's options carry keys, drawn from the one list (cn-v1152: its lone-Check fallback is gone)", () => {
    const src = code("src/app/(app)/billing/[id]/invoice-detail.tsx");
    expect(src).toContain("const editMethods = paymentMethodChoices(paymentMethods);");
    expect(src).toContain("<option key={c.key} value={c.key}>{c.label}</option>");
    expect(src).not.toContain('<option value="check">Check</option>');
    expect(src).not.toMatch(/findIndex\(\(o\) => paymentMethodKey\(o\)/);
    expect(src).toContain("setPayEditMethod(paymentMethodKey(p.method))");
  });

  it("Nort's record action reads and speaks the label", () => {
    const src = code("src/lib/actions/entities/invoice.ts");
    expect(src).toMatch(/Record a \$\{paymentMethodLabel\(i\.method \|\| "check"\)\} payment/);
    expect(src).toMatch(/Recorded a \$\{paymentMethodLabel\(i\.method \|\| "check"\)\} payment/);
  });

  it("the customer's copy never prints the office's payment note", () => {
    expect(code("src/components/invoice-document.tsx")).not.toMatch(/\.note\b/);
    // Print, /i and the portal's bill all read through the one assembly (readInvoiceDocumentProps).
    expect(code("src/app/print/invoice/[id]/page.tsx")).toContain("readInvoiceDocumentProps(");
    const assembly = code("src/lib/invoice-document-props.ts");
    expect(assembly).toMatch(/payments: "id, amount, paid_at, method",/);
    expect(assembly).toMatch(/from\("payments"\)\.select\(INVOICE_DOC_COLS\.payments\)/);
  });
});

describe("migration 0287 agrees with the app", () => {
  const sql = readFileSync(
    fileURLToPath(new URL("../../supabase/migrations/0287_a_payment_method_is_a_key.sql", import.meta.url)),
    "utf8",
  );
  const whens = [...sql.matchAll(/when '([^']*)' then '([^']*)'/g)].map((m) => [m[1], m[2]] as const);

  it("carries every app alias as a WHEN line", () => {
    for (const [alias, key] of Object.entries(PAYMENT_METHOD_ALIASES)) {
      expect(sql).toContain(`when '${alias}' then '${key}'`);
    }
  });

  it("has no WHEN line the app does not know", () => {
    for (const [alias, key] of whens) {
      if (alias === "") expect(key).toBe("other");
      else expect(PAYMENT_METHOD_ALIASES[alias]).toBe(key);
    }
    expect(whens.length).toBe(Object.keys(PAYMENT_METHOD_ALIASES).length + 1);
  });

  it("normalizes with a trigger on payments, not a CHECK", () => {
    expect(sql).toMatch(/before insert or update of method on public\.payments/);
    expect(sql).not.toMatch(/add constraint/i);
  });
});

describe("migration 0406 runs the same normalizer on the crew's and the supplier's payments", () => {
  const sql = readFileSync(
    fileURLToPath(new URL("../../supabase/migrations/0406_one_list_of_ways_money_moves.sql", import.meta.url)),
    "utf8",
  ).replace(/--.*$/gm, "");

  it("one generic trigger function, 0287's payment_method_key inside it, before insert or update of method on both", () => {
    expect(sql).toContain("new.method := public.payment_method_key(new.method);");
    expect(sql).toMatch(/before insert or update of method on public\.pay_payments/);
    expect(sql).toMatch(/before insert or update of method on public\.supplier_payments/);
    expect(sql).toContain("drop constraint if exists pay_payments_method_check");
    expect(sql).toContain("drop constraint if exists supplier_payments_method_check");
    expect(sql).not.toMatch(/add constraint/i);
    // The database's answers the self-check demands are the app's.
    expect(paymentMethodKey("Venmo")).toBe("venmo");
    expect(paymentMethodKey("Cheque")).toBe("check");
    expect(paymentMethodKey(" Apple  Cash ")).toBe("apple cash");
    expect(paymentMethodKey("")).toBe("other");
  });
});

describe("every door that records how money moved reads the one list (cn-v1152)", () => {
  it("the crew's pay form and the supplier's pay door draw paymentMethodChoices and set the key", () => {
    for (const f of ["src/app/(app)/payroll/pay-sheet.tsx", "src/app/(app)/bills/suppliers-card.tsx"]) {
      const src = code(f);
      expect(src, f).toContain("paymentMethodChoices(methods)");
      expect(src, f).toContain("onClick={() => setMethod(m.key)}");
      expect(src, f).toContain("{m.label}");
    }
  });

  it("the pages hand down settings.payment_methods, the same prop the customer's door takes", () => {
    expect(code("src/app/(app)/payroll/page.tsx")).toContain("paymentMethods={settings.payment_methods}");
    expect(code("src/app/(app)/bills/page.tsx")).toContain("methods={orgSettings.payment_methods}");
    expect(code("src/app/(app)/billing/page.tsx")).toContain("methods={orgSettings.payment_methods}");
  });

  it("both actions judge the word by isPaymentMethod and store paymentMethodKey of it; the old refusal is gone", () => {
    const payroll = code("src/app/(app)/payroll/actions.ts");
    expect(payroll).toContain('isPayMethod(input.method) ? paymentMethodKey(input.method) : ""');
    expect(payroll).toContain('"Pick how you paid."');
    expect(payroll).not.toContain("cash, check, transfer or other");
    const supplier = code("src/app/(app)/bills/supplier-actions.ts");
    expect(supplier).toContain('isPaymentMethod(input.method) ? paymentMethodKey(input.method) : ""');
    expect(supplier).toContain('"Pick how you paid."');
  });

  it("the customer's two doors read it too: the Get Paid sheet's chips (less the card) and the invoice page's payment editor", () => {
    const sheet = code("src/components/settle-up-button.tsx");
    expect(sheet).toContain('paymentMethodChoices(props.methods).filter((c) => c.key !== "card")');
    expect(sheet).not.toContain('["Cash", "Check", "Venmo", "Other"]');
    expect(code("src/app/(app)/billing/[id]/invoice-detail.tsx")).toContain("paymentMethodChoices(paymentMethods)");
  });

  it("no word list of a door's own remains", () => {
    expect(code("src/components/settle-up-button.tsx")).not.toContain('["Cash", "Check", "Venmo", "Other"]');
    expect(code("src/lib/payroll-math.ts")).not.toContain("PAY_METHODS");
    expect(code("src/app/(app)/bills/supplier-balance.ts")).not.toContain("SUPPLIER_PAY_METHODS");
    expect(code("src/lib/supplier-pay-words.ts")).not.toContain("SUPPLIER_PAY_METHOD_LABELS");
    expect(code("src/app/(app)/payroll/pay-sheet.tsx")).not.toMatch(/\bMETHODS\b/);
  });

  it("every screen that shows a crew or supplier payment shows its label, never the raw key", () => {
    expect(code("src/app/(app)/payroll/person-statement.tsx")).toContain("paymentMethodLabel(p.method)");
    expect(code("src/app/(app)/payroll/person-statement.tsx")).not.toMatch(/\{p\.method\}/);
    expect(code("src/app/(app)/bills/suppliers-card.tsx")).toContain("paymentMethodLabel(p.method)");
    expect(code("src/app/(app)/payroll/payroll-view.tsx")).toContain("paymentMethodLabel(b.lastPayment.method)");
    expect(code("src/app/(app)/payroll/payroll-view.tsx")).toContain("paymentMethodLabel(fields.method)");
    expect(code("src/lib/payroll-math.ts")).toContain("paymentMethodLabel(input.method)");
  });
});
