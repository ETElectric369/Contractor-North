import { describe, it, expect } from "vitest";
import { isThenable, plainBadges } from "./dock";

/**
 * THE cn-v930 CRASH, pinned. The app shell hands <Dock> its badge counts as a value that may
 * still be in flight. What actually arrives from the server is a React RSC THENABLE — `.then()`
 * registers the callback and returns UNDEFINED — so `value.then(...).catch(...)` threw
 * "undefined is not an object (evaluating '…​.catch')" and took the whole page's error boundary
 * with it on /jobs/<id>. Both helpers exist so the hook can never call `.then` on the wrong
 * thing, or hand the renderer something that isn't a count map.
 */
describe("isThenable — what Promise.resolve can safely adopt", () => {
  it("accepts a real promise", () => {
    expect(isThenable(Promise.resolve({}))).toBe(true);
  });

  it("accepts a bare thenable whose then() returns undefined (React's RSC shape)", () => {
    expect(isThenable({ then: () => undefined })).toBe(true);
  });

  it("rejects the values that used to crash it", () => {
    expect(isThenable(undefined)).toBe(false);
    expect(isThenable(null)).toBe(false);
    expect(isThenable({ "/planner": 3 })).toBe(false);
    expect(isThenable("pending")).toBe(false);
  });
});

describe("plainBadges — the renderer only ever sees a count map", () => {
  it("passes a real map through", () => {
    expect(plainBadges({ "/planner": 3 })).toEqual({ "/planner": 3 });
  });

  it("turns anything else into an empty map rather than throwing", () => {
    expect(plainBadges(undefined)).toEqual({});
    expect(plainBadges(null)).toEqual({});
    expect(plainBadges(7)).toEqual({});
    expect(plainBadges([1, 2])).toEqual({});
  });
});
