import { describe, it, expect, vi } from "vitest";
import { sweepErrorEvents } from "./error-retention";

/** The nightly knock on sweep_error_events (0399): the counts back, or the handed-back error thrown. */
describe("sweepErrorEvents", () => {
  it("calls the RPC and answers its counts", async () => {
    const rpc = vi.fn(async () => ({ data: { closed_deleted: 12, trace_deleted: 40 }, error: null }));
    expect(await sweepErrorEvents({ rpc })).toEqual({ closed_deleted: 12, trace_deleted: 40 });
    expect(rpc).toHaveBeenCalledWith("sweep_error_events");
  });

  it("a handed-back error is thrown (supabase-js never throws it)", async () => {
    const rpc = vi.fn(async () => ({ data: null, error: { message: "permission denied for function sweep_error_events" } }));
    await expect(sweepErrorEvents({ rpc })).rejects.toEqual({ message: "permission denied for function sweep_error_events" });
  });

  it("a shapeless answer reads as zero of each, never a crash", async () => {
    const rpc = vi.fn(async () => ({ data: null, error: null }));
    expect(await sweepErrorEvents({ rpc })).toEqual({ closed_deleted: 0, trace_deleted: 0 });
  });
});
