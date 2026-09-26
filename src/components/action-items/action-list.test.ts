import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * CALL BACK (the switch board, 0352). With Leads switched off a request still reaches Needs You as
 * "New Request From …", and the one thing to do about it is one tap: Call Back dials the number.
 * With Leads on the row is exactly the lead row it always was (no Call Back).
 */
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/components/toast", () => ({ useToast: () => vi.fn() }));
vi.mock("@/lib/action-items/dispatch", () => ({ dispatchAction: vi.fn() }));
vi.mock("@/components/supplier-paper-cards", () => ({ SupplierPaperCards: () => null, SUPPLIER_PAPERS_SCOPE: "my-day" }));
vi.mock("@/components/move-to-day", () => ({ MoveToDay: ({ children }: { children: unknown }) => children as never }));

import { ActionList } from "./action-list";
import { inquiryActionItem } from "@/lib/action-items/switches";
import { KIND_STREAM } from "@/lib/action-items/types";

const row = { id: "i1", name: "Dana Reyes", status: "new", next_follow_up_at: null, phone: "(530) 555-0142" };
const render = (leadsOn: boolean) => {
  const item = { ...inquiryActionItem(row, "2026-09-26", leadsOn), stream: KIND_STREAM.inquiry };
  return renderToStaticMarkup(createElement(ActionList, { items: [item], todayStr: "2026-09-26" }));
};

describe("ActionList — a request with Leads off", () => {
  it("Leads on: the lead row as before, no Call Back", () => {
    const html = render(true);
    expect(html).toContain("Dana Reyes");
    expect(html).not.toContain("Call Back");
    expect(html).not.toContain("tel:");
  });

  it("Leads off: 'New Request From Dana Reyes' with a 44px Call Back that dials her", () => {
    const html = render(false);
    expect(html).toContain("New Request From Dana Reyes");
    const a = html.match(/<a [^>]*href="tel:[^"]*"[^>]*>.*?<\/a>/)![0];
    expect(a).toContain('href="tel:(530) 555-0142"');
    expect(a).toContain("Call Back");
    expect(a).toMatch(/\bh-11\b/);
  });
});
