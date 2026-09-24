import { describe, expect, it } from "vitest";
import { createParamClaim } from "./param-claim";

describe("createParamClaim", () => {
  it("lets exactly one instance answer the param", () => {
    const c = createParamClaim();
    expect(c.take("header")).toBe(true);
    expect(c.take("empty-state")).toBe(false);
    // The holder's own effect re-running with ?new=1 still there must not open a second modal.
    expect(c.take("header")).toBe(false);
  });

  it("only the holder can let go", () => {
    const c = createParamClaim();
    c.take("header");
    // The empty-state copy unmounts after the first record is created: its release is a no-op.
    c.release("empty-state");
    expect(c.take("empty-state")).toBe(false);
    c.release("header");
    expect(c.take("empty-state")).toBe(true);
  });

  it("a holder that unmounts with the strip failed frees the door for the next tap", () => {
    // f28d8de3: the replace that strips ?new=1 dies on a dropped connection, so the param never
    // goes and the "param gone" release never runs. The unmount release is what frees it.
    const c = createParamClaim();
    expect(c.take("jobs-page-1")).toBe(true);
    c.release("jobs-page-1"); // unmount cleanup
    expect(c.take("jobs-page-2")).toBe(true);
  });

  it("each module's claim is its own", () => {
    const jobs = createParamClaim();
    const leads = createParamClaim();
    expect(jobs.take("a")).toBe(true);
    expect(leads.take("b")).toBe(true);
  });
});
