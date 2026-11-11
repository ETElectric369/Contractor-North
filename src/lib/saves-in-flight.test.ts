import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SAVES_QUIET_MS, SAVES_WAIT_CAP_MS, beginSave, savesInFlight, subscribeSaves, whenSavesSettle } from "./saves-in-flight";

/**
 * PREVIEW SHOWS WHAT IS SAVED, SO IT WAITS FOR THE SAVE (cn-v1157). The header's Preview is one tap
 * from a box that saves as it is left; a link that left in the same instant drew the paper without
 * the change just typed. This is the count the editors feed and the door asks: what counts as a save
 * on its way, and when the page counts as quiet.
 */
const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("the count", () => {
  it("goes up when a save leaves and down when it lands; landing twice counts once", () => {
    expect(savesInFlight()).toBe(0);
    const a = beginSave();
    const b = beginSave();
    expect(savesInFlight()).toBe(2);
    a();
    a();
    expect(savesInFlight()).toBe(1);
    b();
    expect(savesInFlight()).toBe(0);
    b();
    expect(savesInFlight()).toBe(0); // never below nothing
  });

  it("tells whoever is listening, and stops when they let go", () => {
    const heard = vi.fn();
    const off = subscribeSaves(heard);
    const end = beginSave();
    end();
    expect(heard).toHaveBeenCalledTimes(2);
    off();
    beginSave()();
    expect(heard).toHaveBeenCalledTimes(2);
  });
});

describe("the quiet a door waits for", () => {
  const settled = () => {
    const done = vi.fn();
    void whenSavesSettle().then(done);
    return done;
  };

  it("with nothing on its way it still waits one beat, then goes", async () => {
    const done = settled();
    await vi.advanceTimersByTimeAsync(SAVES_QUIET_MS - 1);
    expect(done).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toHaveBeenCalledWith(true);
  });

  it("a save on its way holds the door until it lands, plus the beat", async () => {
    const end = beginSave();
    const done = settled();
    await vi.advanceTimersByTimeAsync(3000);
    expect(done).not.toHaveBeenCalled();
    end();
    await vi.advanceTimersByTimeAsync(SAVES_QUIET_MS - 1);
    expect(done).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toHaveBeenCalledWith(true);
  });

  it("a write queued behind the first goes out in the gap: the gap is not quiet", async () => {
    const first = beginSave();
    const done = settled();
    first();
    await vi.advanceTimersByTimeAsync(SAVES_QUIET_MS - 10);
    const second = beginSave(); // the queued write leaves before the beat is over
    await vi.advanceTimersByTimeAsync(SAVES_QUIET_MS * 3);
    expect(done).not.toHaveBeenCalled();
    second();
    await vi.advanceTimersByTimeAsync(SAVES_QUIET_MS);
    expect(done).toHaveBeenCalledWith(true);
  });

  it("a save that never lands is given up on at the cap, and the door is told so", async () => {
    const end = beginSave();
    const done = settled();
    await vi.advanceTimersByTimeAsync(SAVES_WAIT_CAP_MS - 1);
    expect(done).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toHaveBeenCalledWith(false);
    end();
    // Answered once: the late landing changes nothing.
    await vi.advanceTimersByTimeAsync(SAVES_QUIET_MS * 2);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("the cap is shorter than the editors' own write timeout, and long enough for a slow connection", () => {
    expect(SAVES_WAIT_CAP_MS).toBeGreaterThanOrEqual(8_000);
    expect(SAVES_WAIT_CAP_MS).toBeLessThan(20_000);
  });
});

describe("who feeds the count, and who asks it", () => {
  it("the estimate editor counts its write on the wire", () => {
    const src = read("src/app/(app)/quotes/estimate-editor.tsx");
    expect(src).toMatch(/const busy = state\.pending !== null;\s*(\/\/[^\n]*\n\s*)*useSaveInFlight\(busy\);/);
  });

  it("the invoice counts its transition (title, due day, lines) and its description save", () => {
    const src = read("src/app/(app)/billing/[id]/invoice-detail.tsx");
    expect(src).toContain('useSaveInFlight(pending || descrState === "saving");');
  });

  // THREE SAVERS STOOD OUTSIDE THE COUNT (skeptic #60): each keeps its OWN transition, so the editor's
  // flag above never saw it, and Preview could leave while the write was on the wire: a paper made out
  // to the customer just changed, worded for the type just flipped, or filed under the kind just moved.
  // Each feeds the count with the flag it already keeps, as a hook at the top of the component (above
  // any early return), and nothing else about it moves.
  const feedsItsTransition = (rel: string, component: string) => {
    const src = read(rel);
    expect(src, rel).toContain('import { useSaveInFlight } from "@/lib/saves-in-flight";');
    const at = src.indexOf(`export function ${component}(`);
    expect(at, `${rel}: ${component}`).toBeGreaterThan(-1);
    const body = src.slice(at);
    // The transition's own flag, counted straight after it is made (comment lines may stand between).
    expect(body, rel).toMatch(/const \[pending, start\] = useTransition\(\);\s*(\/\/[^\n]*\n\s*)*useSaveInFlight\(pending\);/);
    // Once, and before the component's first return (comments aside): a hook is never behind a branch.
    expect(body.split("useSaveInFlight(").length - 1, rel).toBe(1);
    const code = body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/[^\n]*$/gm, "");
    expect(code.indexOf("useSaveInFlight(pending);"), rel).toBeGreaterThan(-1);
    expect(code.indexOf("useSaveInFlight(pending);"), rel).toBeLessThan(code.search(/\breturn\b/));
    // The save itself still runs inside that same transition.
    expect(body, rel).toMatch(/start\(async \(\) => \{/);
    return body;
  };

  it("the estimate's customer pick counts its own transition (the pick, and New Customer's create-and-attach)", () => {
    const body = feedsItsTransition("src/app/(app)/quotes/[id]/customer-select.tsx", "CustomerSelect");
    expect(body).toContain("commitCustomerPick(quoteId, next");
    expect(body).toContain("commitCustomerPick(quoteId, made.id");
  });

  it("the estimate's type toggle counts its own transition", () => {
    const body = feedsItsTransition("src/app/(app)/quotes/[id]/quote-type-toggle.tsx", "QuoteTypeToggle");
    expect(body).toContain("const res = await setQuoteType(id, next);");
    // …and it is the editor's header that mounts it, in the same window as the Preview that waits.
    expect(read("src/app/(app)/quotes/estimate-editor.tsx")).toContain("<QuoteTypeToggle id={savedId} status={status} value={quoteDocType} />");
  });

  it("the invoice's line-kind chips count their own transition, above the early return for a locked line", () => {
    const body = feedsItsTransition("src/app/(app)/billing/[id]/line-kind-chips.tsx", "LineKindChips");
    expect(body).toContain("const res = await setInvoiceItemKind(item.id, invoiceId, kind);");
    expect(body.indexOf("useSaveInFlight(pending);")).toBeLessThan(body.indexOf('if (src === "draw_credit" || src === "milestone") return null;'));
  });

  it("Preview asks at the tap (never from a render), waits, then goes; a save that has not landed is said", () => {
    const src = read("src/components/preview-button.tsx");
    expect(src).toContain("if (savesInFlight() === 0) return;");
    expect(src).toMatch(/e\.preventDefault\(\);\s*setWaiting\(true\);\s*void whenSavesSettle\(\)\.then\(\(settled\) => \{/);
    expect(src).toContain("if (settled) router.push(href);");
    expect(src).toContain('else toast(t("qt_previewStillSaving"), "info");');
    // A second tap while it waits is one navigation, not two.
    expect(src).toMatch(/if \(waiting\) \{\s*e\.preventDefault\(\);/);
    // It never leaves by a new window.
    expect(src.replace(/\/\*[\s\S]*?\*\//g, "")).not.toContain("window.open");
  });
});
