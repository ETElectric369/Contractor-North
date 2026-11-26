import { describe, expect, it } from "vitest";
import { REGISTRY } from "./registry";
import { toolJsonSchema } from "./agent-tools";
import { parseActionInput } from "./parse-input";

// A LIST HAS AN END (cn-v1196). zod 4.6.7 refuses an over-long list before it reads a single
// element (GHSA-mrhx-c7xc-m3w5: one issue per bad element, with no cap, ran a parse out of
// memory) — but only when the list has an upper bound. A list with none is read element by
// element whatever its length. So every list any action takes, at any depth, carries one.

function unboundedArrays(node: unknown, path: string, out: string[]): void {
  if (Array.isArray(node)) return node.forEach((n, i) => unboundedArrays(n, `${path}[${i}]`, out));
  if (!node || typeof node !== "object") return;
  const o = node as Record<string, unknown>;
  const isArray = o.type === "array" || (Array.isArray(o.type) && o.type.includes("array"));
  if (isArray && typeof o.maxItems !== "number") out.push(path);
  for (const [k, v] of Object.entries(o)) unboundedArrays(v, `${path}.${k}`, out);
}

describe("every list an action takes has an end", () => {
  it("every array in every registry action's input, at any depth, carries a maxItems", () => {
    const out: string[] = [];
    let arrays = 0;
    for (const name of Object.keys(REGISTRY).sort()) {
      const js = toolJsonSchema(REGISTRY[name].input);
      arrays += (JSON.stringify(js).match(/"type":"array"/g) ?? []).length;
      unboundedArrays(js, name, out);
    }
    expect(out, out.join("\n")).toEqual([]);
    expect(arrays).toBeGreaterThanOrEqual(7);
  });

  const line = { description: "12/2 NM-B from Northline Supply", amount: 1 };
  const item = { description: "Panel swap at J-901 (Larkspur)", quantity: 1, unit_price: 1 };
  const bill = (n: number) => ({ bill_id: "b-901", paper_number: "NS-901", paper_total: n, lines: Array.from({ length: n }, () => line) });
  const quote = (n: number) => ({ title: "J-902 (Snowbell)", items: Array.from({ length: n }, () => item) });

  it("a bill takes 1,000 lines and refuses 1,001 in one issue that names the one thing to do", () => {
    expect(parseActionInput(REGISTRY["bill.correct"].input, bill(1000)).success).toBe(true);
    const r = parseActionInput(REGISTRY["bill.correct"].input, { ...bill(1001), lines: [...bill(1000).lines, { amount: "x" }] });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.map((i) => [i.path.join("."), i.message])).toEqual([["lines", "A bill takes up to 1,000 lines at once. Split it into two bills."]]);
  });

  it("an estimate takes 1,000 lines and refuses 1,001 in one issue that names the one thing to do", () => {
    expect(parseActionInput(REGISTRY["quote.create"].input, quote(1000)).success).toBe(true);
    const r = parseActionInput(REGISTRY["quote.create"].input, { ...quote(1001), items: [...quote(1000).items, { quantity: "x" }] });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.map((i) => [i.path.join("."), i.message])).toEqual([["items", "An estimate takes up to 1,000 lines at once. Add the rest after it is saved."]]);
  });

  it("a draw schedule takes 100 milestones and refuses 101", () => {
    const ms = (n: number) => ({ job_id: "j-901", milestones: Array.from({ length: n }, () => ({ label: "Rough-in", percent: 1 })) });
    expect(parseActionInput(REGISTRY["payment.setSchedule"].input, ms(100)).success).toBe(true);
    const r = parseActionInput(REGISTRY["payment.setSchedule"].input, ms(101));
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.map((i) => i.message)).toEqual(["A draw schedule takes up to 100 milestones. Combine some of them."]);
  });

  it("a form's answers are a record of any value: there is no list in it to bound", () => {
    const r = parseActionInput(REGISTRY["form.submit"].input, { form_id: "f-901", data: { "Ladder inspected": "yes", Hours: 2 } });
    expect(r.success).toBe(true);
  });
});
