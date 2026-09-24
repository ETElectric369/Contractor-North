import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  PAYMENT_METHOD_ALIASES,
  PAYMENT_METHOD_LABELS,
  paymentMethodKey,
  paymentMethodLabel,
} from "./payment-method";

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

  it("the Stripe webhook writes the card key", () => {
    const hook = code("src/app/api/stripe/webhook/route.ts");
    const inserts = [...hook.matchAll(/from\("payments"\)\.insert\(\{[\s\S]*?\}\)/g)].map((m) => m[0]);
    expect(inserts.length).toBeGreaterThan(0);
    for (const ins of inserts) expect(ins).toContain('method: "card"');
  });

  it("no other code writes a method into payments", () => {
    // If a third writer appears it has to be added here on purpose, with its key. (The database
    // trigger from 0287 backs all of them regardless.)
    const writers = new Set(["src/app/(app)/billing/actions.ts", "src/app/api/stripe/webhook/route.ts"]);
    const files = (readdirSync(join(process.cwd(), "src"), { recursive: true }) as string[])
      .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f))
      .map((f) => join("src", f));
    const found = files.filter((f) => /from\("payments"\)\s*\.(insert|upsert)\(/.test(code(f)));
    expect(found.sort()).toEqual([...writers].sort());
  });
});

describe("every screen that shows a method shows its label", () => {
  it("the invoice page, /payments, the story feed and the customer's copy", () => {
    for (const f of [
      "src/app/(app)/billing/[id]/invoice-detail.tsx",
      "src/app/(app)/payments/page.tsx",
      "src/lib/story.ts",
      "src/components/invoice-document.tsx",
    ]) {
      const src = code(f);
      expect(src, f).toContain("paymentMethodLabel(");
      expect(src, f).not.toMatch(/\{p\.method\}/);
      expect(src, f).not.toMatch(/cell: \(p\) => p\.method \}/);
    }
  });

  it("the payment editor's options carry keys, and its fallback is the check key", () => {
    const src = code("src/app/(app)/billing/[id]/invoice-detail.tsx");
    expect(src).toContain("value={paymentMethodKey(m)}");
    expect(src).toContain('<option value="check">Check</option>');
    expect(src).toContain("setPayEditMethod(paymentMethodKey(p.method))");
  });

  it("Nort's record action reads and speaks the label", () => {
    const src = code("src/lib/actions/entities/invoice.ts");
    expect(src).toMatch(/Record a \$\{paymentMethodLabel\(i\.method \|\| "check"\)\} payment/);
    expect(src).toMatch(/Recorded a \$\{paymentMethodLabel\(i\.method \|\| "check"\)\} payment/);
  });

  it("the customer's copy never prints the office's payment note", () => {
    expect(code("src/components/invoice-document.tsx")).not.toMatch(/\.note\b/);
    const print = code("src/app/print/invoice/[id]/page.tsx");
    expect(print).toMatch(/from\("payments"\)\.select\("id, amount, paid_at, method"\)/);
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
