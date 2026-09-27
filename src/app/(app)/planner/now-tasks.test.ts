import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * MY DAY'S NOW CARD, THE CLOCKED-IN JOB'S TASKS: while the job's materials list has lines left to
 * buy, "Buy Materials · N Open" leads, opening the same list the Materials button does.
 */
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }) }));
vi.mock("@/components/toast", () => ({ useToast: () => () => {} }));
vi.mock("../tasks/actions", () => ({ toggleTask: vi.fn() }));

import { NowTasks } from "./now-tasks";

const NEXT = [
  { id: "a", title: "Pull the permit" },
  { id: "b", title: "Set the meter base" },
  { id: "c", title: "Run the feeder" },
];
const render = (props: Record<string, unknown>) =>
  renderToStaticMarkup(createElement(NowTasks, { jobId: "j1", left: 4, next: NEXT, ...props } as any));

describe("the Buy Materials row in the Now card", () => {
  it("leads the block and links to the job's list; three rows in all", () => {
    const html = render({ materials: { open: 5, href: "/materials/l1" } });
    expect(html).toMatch(/<a[^>]*min-h-\[44px\][^>]*href="\/materials\/l1"[^>]*>[\s\S]*?Buy Materials · 5 Open/);
    expect(html.indexOf("Buy Materials")).toBeLessThan(html.indexOf("Pull the permit"));
    expect(html).toContain("Set the meter base");
    expect(html).not.toContain("Run the feeder");
    expect(html).toMatch(/Tasks: <!-- -->4<!-- --> left|Tasks: 4 left/);
  });

  it("no row when nothing is left to buy", () => {
    const html = render({ left: 3, materials: null });
    expect(html).not.toContain("Buy Materials");
    for (const t of NEXT) expect(html).toContain(t.title);
  });
});
