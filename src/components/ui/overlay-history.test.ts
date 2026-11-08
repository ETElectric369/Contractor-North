import { describe, it, expect } from "vitest";
import { createBackStepper, createOverlayStack, shouldGuardBack, shouldRemoveEntry } from "./overlay-history";

/**
 * Modal pushes a history entry so the system BACK gesture closes the overlay instead of leaving
 * the page. 76 files use that component, so these three decisions run everywhere — and each wrong
 * answer is its own user-visible failure, which is why they are pinned separately.
 */
describe("shouldRemoveEntry — the three ways an overlay closes", () => {
  it("CLOSED BY BACK: does not go back again", () => {
    // The double-back bug: popstate closes the modal, then cleanup calls history.back() too, and
    // the user leaves the page entirely — the exact thing this mechanism exists to prevent.
    expect(shouldRemoveEntry({ pushed: true, popped: true, stillOurs: false })).toBe(false);
  });

  it("CLOSED BY A BUTTON: removes the entry it added", () => {
    // Cancel / X / Escape / backdrop. Leave the entry behind and the user's NEXT back silently
    // closes an already-closed overlay, which reads as the back button being broken.
    expect(shouldRemoveEntry({ pushed: true, popped: false, stillOurs: true })).toBe(true);
  });

  it("CLOSED BY NAVIGATING AWAY: never undoes the navigation", () => {
    // A link inside the overlay took them somewhere. The new page pushed its own state, so our
    // marker is no longer current. Going back here drags them off the page they just asked for.
    expect(shouldRemoveEntry({ pushed: true, popped: false, stillOurs: false })).toBe(false);
  });

  it("never touches history if it never pushed", () => {
    expect(shouldRemoveEntry({ pushed: false, popped: false, stillOurs: true })).toBe(false);
  });
});

describe("shouldGuardBack — a dirty form treats back like any other dismissal", () => {
  it("first back on a dirty form arms the discard notice instead of closing", () => {
    expect(shouldGuardBack({ dirty: true, confirmDiscard: false })).toBe(true);
  });

  it("second back — already armed — lets it close", () => {
    expect(shouldGuardBack({ dirty: true, confirmDiscard: true })).toBe(false);
  });

  it("a clean form closes on the first back, no ceremony", () => {
    expect(shouldGuardBack({ dirty: false, confirmDiscard: false })).toBe(false);
  });
});

describe("an overlay that remounts while open closes itself — why no Modal may be keyed on changing state", () => {
  it("the old instance's step pops the entry the new instance pushed, and the new one owns that pop", () => {
    // The send sheet, cn-v1155: its view was keyed on the server answer's round, so the Modal inside
    // remounted the moment the words arrived, and the sheet was gone (Erik, INV-093, 2026-11-08).
    // Pinned as it IS, so a wave that teaches the stack to hand the entry over does it on purpose.
    const stack = createOverlayStack();
    const steps: number[] = [];
    const queue: (() => void)[] = [];
    const stepBack = createBackStepper((n) => steps.push(n), (fn) => queue.push(fn));
    stack.open("A"); // the first mount pushed an entry
    // React runs the old instance's cleanup first (a button-style close: the entry is still ours)...
    stepBack(stack.close("A", { pushed: true, popped: false, stillOurs: true }));
    stack.open("B"); // ...then the new instance mounts and pushes its own entry
    expect(steps).toEqual([]); // the step waits for the end of the tick
    queue.splice(0).forEach((fn) => fn());
    expect(steps).toEqual([1]); // history.go(-1) pops the top entry, which is now B's
    expect(stack.ownsPop("B")).toBe(true); // and B takes the popstate as the system Back: it closes
  });
});
