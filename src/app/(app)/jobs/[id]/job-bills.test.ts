import { describe, it, expect, vi, beforeEach } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * THE COSTS TAB'S BILL ROW USES THE /bills ROW'S DOORS (audit v1018, class 13).
 *
 * It had kept the old ones: a 16px pencil and a 16px trash icon (the trash a one-tap hard delete,
 * no question, no Undo) and a badge reading the raw "paid"/"unpaid", the word /bills retired
 * because a bill ticked paid that a cheque already covered takes the same dollar off twice. Both
 * screens now draw BillRowDoors: Settled / On Account · Switch, Edit, Delete, each 44px, and
 * Delete asks first.
 */

const acts = vi.hoisted(() => ({ deleteBill: vi.fn(async () => ({ ok: true })), setBillStatus: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/app/(app)/jobs/actions", () => ({ ...acts, createBill: vi.fn() }));
vi.mock("@/lib/actions/execute", () => ({ executeAction: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {}, push: () => {} }) }));
vi.mock("@/components/toast", () => ({ useToast: () => () => {} }));
// A press made after the static render runs its transition straight through (there is no DOM here).
vi.mock("react", async (orig) => {
  const real = (await orig()) as typeof import("react");
  return { ...real, useTransition: () => [false, (fn: () => unknown) => void fn()] };
});

/** Every Button the doors draw, with the props it was handed, so a press can be made off the page. */
const pressed = vi.hoisted(() => ({ buttons: [] as { label: string; onClick?: () => void }[] }));
vi.mock("@/components/ui/button", async (orig) => {
  const real = (await orig()) as typeof import("@/components/ui/button");
  const { createElement: h, forwardRef } = await import("react");
  const Button = forwardRef<HTMLButtonElement, any>((props, ref) => {
    const label = [props.children].flat().filter((c: unknown) => typeof c === "string").join("").trim();
    pressed.buttons.push({ label, onClick: props.onClick });
    return h(real.Button, { ...props, ref });
  });
  return { ...real, Button };
});

import { JobBills } from "./job-bills";

const BILLS = [
  { id: "b1", supplier: "CED", bill_number: "8802-1106969", amount: 301.81, status: "unpaid", bill_date: "2026-09-04" },
  { id: "b2", supplier: "OSH", bill_number: null, amount: 16.28, status: "paid", bill_date: "2026-09-18" },
];
const render = () => renderToStaticMarkup(createElement(JobBills, { jobId: "j11", bills: BILLS as any, pos: [] }));

beforeEach(() => {
  pressed.buttons = [];
  acts.deleteBill.mockClear();
});

describe("the Costs tab's bill row", () => {
  it("says how the bill was bought, never 'paid', and the toggle is 44px", () => {
    const html = render();
    const toggles = Array.from(html.matchAll(/<button[^>]*aria-label="How this bill was bought[^"]*"[^>]*>([\s\S]*?)<\/button>/g));
    expect(toggles).toHaveLength(2);
    for (const t of toggles) expect(t[0]).toContain("min-h-11");
    const faces = toggles.map((t) => t[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
    expect(faces).toEqual(["On Account Switch", "Settled Switch"]);
    expect(html).not.toMatch(/>\s*(paid|unpaid)\s*</);
    expect(html).not.toContain("Toggle paid/unpaid");
  });

  it("Edit and Delete are 44px buttons with their words, not bare 16px icons", () => {
    const html = render();
    const doors = Array.from(html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)).map((m) => ({
      tag: m[0],
      words: m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
    }));
    for (const word of ["Edit", "Delete"]) {
      const found = doors.filter((d) => d.words === word);
      expect(found).toHaveLength(2);
      for (const d of found) expect(d.tag).toMatch(/\bh-11\b/);
    }
  });

  it("Delete asks first: a No writes nothing, a Yes deletes that bill", async () => {
    render();
    const del = pressed.buttons.find((b) => b.label === "Delete")!;
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    try {
      del.onClick?.();
      expect(confirm).toHaveBeenCalledWith('Delete bill from "CED"?');
      expect(acts.deleteBill).not.toHaveBeenCalled();
      confirm.mockReturnValue(true);
      del.onClick?.();
      await vi.waitFor(() => expect(acts.deleteBill).toHaveBeenCalledWith("b1", "j11"));
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
