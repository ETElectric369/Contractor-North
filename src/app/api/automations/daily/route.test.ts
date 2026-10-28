import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * THE NIGHT'S ANSWER IS HONEST (sink-07, cn-v1130). The daily cron used to answer 200 {ok:true}
 * whatever happened: every step filed its own row, but Vercel's cron log — the one place that goes
 * red — reads only the status, so a night where all eight steps failed stayed green. Pinned here with
 * every step mocked: ok is false and the status 500 when ANY step failed (skeptic #34: the first rule,
 * "500 only when every step failed", never fired — several steps fail closed without throwing), each
 * failed step files its row and names itself in the body, a database error the rpc HANDS BACK (it
 * never throws) is a failed step, a Nort review that made nothing or was cut short is a failed step,
 * and the review is handed a deadline in milliseconds inside the function's own 300 s.
 *
 * TEN STEPS NOW (cn-v1136): the error sweep and the Monday Bug Watch digest join the night, each its
 * own try — BEFORE the Nort review (skeptic #42, N2: behind its 200 s budget they were the first to be
 * cut when the night ran long); and a night where EVERY step failed is one BLOCKER (cron-daily,
 * waited for) that pages North's own team, while one failed step is that step's row and no page.
 */
const state = vi.hoisted(() => ({ client: null as any }));
const steps = vi.hoisted(() => ({
  recurring: vi.fn(),
  fees: vi.fn(),
  stale: vi.fn(),
  dayAhead: vi.fn(),
  review: vi.fn(),
  shelf: vi.fn(),
  sweep: vi.fn(),
  errorSweep: vi.fn(),
  digest: vi.fn(),
  reportError: vi.fn(),
  reportBlockerAwaited: vi.fn(async () => {}),
}));

vi.mock("@/lib/cron-guard", () => ({ requireCron: vi.fn(() => ({ supabase: state.client })) }));
vi.mock("@/lib/observe", () => ({ reportError: steps.reportError }));
vi.mock("@/lib/observe-blocker", () => ({ reportBlocker: vi.fn(), reportBlockerAwaited: steps.reportBlockerAwaited }));
vi.mock("@/lib/error-retention", () => ({ sweepErrorEvents: steps.errorSweep }));
vi.mock("@/lib/bug-watch-digest", () => ({ sendBugWatchDigest: steps.digest }));
vi.mock("@/lib/recurring-engine", () => ({ generateDueTemplates: steps.recurring }));
vi.mock("@/lib/action-items/digest", () => ({ sendDayAheadDigests: steps.dayAhead }));
vi.mock("@/lib/nort/review", () => ({ generateNortReviewsForAllOrgs: steps.review }));
vi.mock("@/lib/storage-sweep", () => ({ sweepOrphanedUploads: steps.sweep }));
vi.mock("@/lib/processor-fee-capture", () => ({ backfillProcessorFees: steps.fees }));
vi.mock("@/lib/stock-reconcile-check", () => ({ findShelfProblems: steps.shelf }));
vi.mock("@/lib/bank-transfer-alerts", () => ({ tellStaleBankTransfers: steps.stale }));

import { GET } from "./route";

const req = () => new Request("https://x/api/automations/daily");

/** Every step's *_error key and the sink name it files under, in the order the route runs them. */
const STEP_ROWS: [string, string][] = [
  ["recurring_error", "cron-recurring"],
  ["processor_fees_error", "cron-processor-fees"],
  ["stale_bank_transfers_error", "cron-stale-bank-transfers"],
  ["day_ahead_error", "cron-day-ahead"],
  ["error_sweep_error", "cron-error-sweep"],
  ["bug_watch_digest_error", "cron-bug-watch-digest"],
  ["nort_reviews_error", "cron-nort-review"],
  ["stock_reconcile_error", "cron-stock-reconcile"],
  ["rate_limit_gc_error", "cron-rate-limit-gc"],
  ["storage_sweep_error", "cron-storage-sweep"],
];

function everyStepWorks() {
  steps.recurring.mockResolvedValue(2);
  steps.fees.mockResolvedValue({ filled: 0 });
  steps.stale.mockResolvedValue({ told: 0 });
  steps.dayAhead.mockResolvedValue({ orgs: 1, pushed: 1 });
  steps.review.mockResolvedValue({ made: 1, failed: 0, left: 0 });
  steps.shelf.mockResolvedValue({ problems: [], skipped: null });
  steps.sweep.mockResolvedValue({ removed: 0 });
  steps.errorSweep.mockResolvedValue({ closed_deleted: 2, trace_deleted: 9 });
  steps.digest.mockResolvedValue({ sent: 0, skipped: "not Monday" });
  state.client = { rpc: vi.fn(async () => ({ data: null, error: null })) };
}

function everyStepFails() {
  const fell = (name: string) => new Error(`${name} fell over`);
  steps.recurring.mockRejectedValue(fell("recurring"));
  steps.fees.mockRejectedValue(fell("fees"));
  steps.stale.mockRejectedValue(fell("stale"));
  steps.dayAhead.mockRejectedValue(fell("day ahead"));
  steps.review.mockRejectedValue(fell("review"));
  steps.shelf.mockRejectedValue(fell("shelf"));
  steps.sweep.mockRejectedValue(fell("sweep"));
  steps.errorSweep.mockRejectedValue(fell("error sweep"));
  steps.digest.mockRejectedValue(fell("digest"));
  state.client = {
    rpc: vi.fn(async () => {
      throw fell("gc");
    }),
  };
}

const errorKeys = (body: Record<string, unknown>) => Object.keys(body).filter((k) => k.endsWith("_error"));

beforeEach(() => {
  for (const fn of Object.values(steps)) fn.mockReset();
  steps.reportBlockerAwaited.mockResolvedValue(undefined);
});

describe("GET /api/automations/daily", () => {
  it("every step failed: 500, ok false, every *_error key, a row filed per step", async () => {
    everyStepFails();
    const res = await GET(req());
    const body = await res.json();
    expect(res.status).toBe(500);
    expect(body.ok).toBe(false);
    expect(errorKeys(body).sort()).toEqual(STEP_ROWS.map(([k]) => k).sort());
    expect(body.recurring_error).toBe("recurring fell over");
    expect(body.rate_limit_gc_error).toBe("gc fell over");
    expect(steps.reportError).toHaveBeenCalledTimes(STEP_ROWS.length);
    for (const [, where] of STEP_ROWS) {
      expect(steps.reportError).toHaveBeenCalledWith(where, expect.any(Error));
    }
    // IN THAT ORDER (N2): the sink's two steps run right after day_ahead and before the Nort review.
    expect(steps.reportError.mock.calls.map((c) => c[0])).toEqual(STEP_ROWS.map(([, where]) => where));
    expect(Object.keys(body).filter((k) => k.endsWith("_error"))).toEqual(STEP_ROWS.map(([k]) => k));
    // AND ONE BLOCKER, waited for: a night where nothing ran is platform-wide, and pages (cn-v1136).
    expect(steps.reportBlockerAwaited).toHaveBeenCalledTimes(1);
    const [where, err] = steps.reportBlockerAwaited.mock.calls[0] as unknown as [string, Error];
    expect(where).toBe("cron-daily");
    expect(err.message).toBe(`every step failed: ${STEP_ROWS.map(([k]) => k).join(", ")}`);
  });

  it("one step failed: 500 (Vercel's log goes red), ok false, only that step's key and row", async () => {
    everyStepWorks();
    steps.review.mockRejectedValue(new Error("the model is away"));
    const res = await GET(req());
    const body = await res.json();
    expect(res.status).toBe(500);
    expect(body.ok).toBe(false);
    expect(errorKeys(body)).toEqual(["nort_reviews_error"]);
    expect(body.nort_reviews_error).toBe("the model is away");
    expect(body.recurring_generated).toBe(2);
    expect(body.storage_sweep).toEqual({ removed: 0 });
    expect(steps.reportError).toHaveBeenCalledTimes(1);
    expect(steps.reportError).toHaveBeenCalledWith("cron-nort-review", expect.any(Error));
    expect(steps.reportBlockerAwaited).not.toHaveBeenCalled(); // one failed step is not a blocker
  });

  it("all steps but one failed: still no blocker — the page is for a night where nothing ran", async () => {
    everyStepFails();
    steps.recurring.mockResolvedValue(0);
    const res = await GET(req());
    expect(res.status).toBe(500);
    expect(errorKeys(await res.json())).toHaveLength(STEP_ROWS.length - 1);
    expect(steps.reportBlockerAwaited).not.toHaveBeenCalled();
  });

  it("a failed error sweep reddens the night and files its row; a failed digest the same", async () => {
    everyStepWorks();
    steps.errorSweep.mockRejectedValue(new Error("permission denied for function sweep_error_events"));
    let res = await GET(req());
    let body = await res.json();
    expect(res.status).toBe(500);
    expect(errorKeys(body)).toEqual(["error_sweep_error"]);
    expect(body.error_sweep_error).toBe("permission denied for function sweep_error_events");
    expect(steps.reportError).toHaveBeenCalledWith("cron-error-sweep", expect.any(Error));
    expect(body.bug_watch_digest).toEqual({ sent: 0, skipped: "not Monday" }); // the step after it still ran

    for (const fn of Object.values(steps)) fn.mockReset();
    everyStepWorks();
    steps.digest.mockRejectedValue(new Error("platform_admins unreachable"));
    res = await GET(req());
    body = await res.json();
    expect(res.status).toBe(500);
    expect(errorKeys(body)).toEqual(["bug_watch_digest_error"]);
    expect(steps.reportError).toHaveBeenCalledWith("cron-bug-watch-digest", expect.any(Error));
    expect(body.error_sweep).toEqual({ closed_deleted: 2, trace_deleted: 9 });
  });

  it("the digest is handed the cron's client and the run's own start", async () => {
    everyStepWorks();
    const before = Date.now();
    await GET(req());
    expect(steps.digest).toHaveBeenCalledTimes(1);
    const [client, nowMs] = steps.digest.mock.calls[0];
    expect(client).toBe(state.client);
    expect(nowMs).toBeGreaterThanOrEqual(before);
    expect(nowMs).toBeLessThanOrEqual(Date.now());
    expect(steps.errorSweep).toHaveBeenCalledWith(state.client);
  });

  it("the sweep and the digest run BEFORE the Nort review (N2), and the review still gets its budget from the run's start", async () => {
    everyStepWorks();
    const order: string[] = [];
    steps.dayAhead.mockImplementation(async () => (order.push("day_ahead"), { orgs: 1, pushed: 1 }));
    steps.errorSweep.mockImplementation(async () => (order.push("error_sweep"), { closed_deleted: 0, trace_deleted: 0 }));
    steps.digest.mockImplementation(async () => (order.push("bug_watch_digest"), { sent: 0, skipped: "not Monday" }));
    steps.review.mockImplementation(async () => (order.push("nort_review"), { made: 1, failed: 0, left: 0 }));
    steps.shelf.mockImplementation(async () => (order.push("stock_reconcile"), { problems: [], skipped: null }));
    await GET(req());
    expect(order).toEqual(["day_ahead", "error_sweep", "bug_watch_digest", "nort_review", "stock_reconcile"]);
  });

  it("the rate-limit step's database error is HANDED BACK, not thrown: still a failed step, filed", async () => {
    everyStepWorks();
    state.client = { rpc: vi.fn(async () => ({ data: null, error: { message: "permission denied for function rate_limit_gc" } })) };
    const res = await GET(req());
    const body = await res.json();
    expect(state.client.rpc).toHaveBeenCalledWith("rate_limit_gc");
    expect(res.status).toBe(500);
    expect(body.ok).toBe(false);
    expect(errorKeys(body)).toEqual(["rate_limit_gc_error"]);
    expect(body.rate_limit_gc_error).toBe("permission denied for function rate_limit_gc");
    expect(body.rate_limit_gc).toBeUndefined();
    expect(steps.reportError).toHaveBeenCalledTimes(1);
    expect(steps.reportError).toHaveBeenCalledWith("cron-rate-limit-gc", expect.anything());
  });

  it("a Nort review that made nothing and failed for every company is a failed step", async () => {
    everyStepWorks();
    steps.review.mockResolvedValue({ made: 0, failed: 2, left: 0 });
    const res = await GET(req());
    const body = await res.json();
    expect(res.status).toBe(500);
    expect(body.ok).toBe(false);
    expect(errorKeys(body)).toEqual(["nort_reviews_error"]);
    expect(body.nort_reviews_error).toBe("every company with activity failed: 2");
    expect(body.nort_reviews).toEqual({ made: 0, failed: 2, left: 0 }); // the counts stay beside the sentence
  });

  it("a Nort review cut short by its deadline is a failed step", async () => {
    everyStepWorks();
    steps.review.mockResolvedValue({ made: 3, failed: 0, left: 1 });
    const res = await GET(req());
    const body = await res.json();
    expect(res.status).toBe(500);
    expect(body.ok).toBe(false);
    expect(errorKeys(body)).toEqual(["nort_reviews_error"]);
    expect(body.nort_reviews_error).toBe("cut short: 1 companies not reviewed");
  });

  it("a Nort review with one company made and one failed is not a failed step (the sink holds the one)", async () => {
    everyStepWorks();
    steps.review.mockResolvedValue({ made: 1, failed: 1, left: 0 });
    const res = await GET(req());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(errorKeys(body)).toEqual([]);
  });

  it("no step failed: 200, ok true, no *_error key, every step's answer in the body", async () => {
    everyStepWorks();
    const res = await GET(req());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(errorKeys(body)).toEqual([]);
    expect(body).toMatchObject({
      recurring_generated: 2,
      processor_fees: { filled: 0 },
      stale_bank_transfers: { told: 0 },
      day_ahead: { orgs: 1, pushed: 1 },
      nort_reviews: { made: 1, failed: 0, left: 0 },
      stock_reconcile: { problems: 0 },
      rate_limit_gc: true,
      storage_sweep: { removed: 0 },
      error_sweep: { closed_deleted: 2, trace_deleted: 9 },
      bug_watch_digest: { sent: 0, skipped: "not Monday" },
    });
    expect(steps.reportError).not.toHaveBeenCalled();
    expect(steps.reportBlockerAwaited).not.toHaveBeenCalled();
  });

  it("the Nort review is handed a deadline: a number inside the function's own 300 s", async () => {
    everyStepWorks();
    const before = Date.now();
    await GET(req());
    expect(steps.review).toHaveBeenCalledTimes(1);
    const [client, opts] = steps.review.mock.calls[0];
    expect(client).toBe(state.client);
    expect(typeof opts.deadlineMs).toBe("number");
    expect(opts.deadlineMs).toBeGreaterThan(before);
    expect(opts.deadlineMs).toBeLessThanOrEqual(Date.now() + 300_000);
  });

  it("the shelf's problems each file a row and the body counts them, without being a failed step", async () => {
    everyStepWorks();
    steps.shelf.mockResolvedValue({
      problems: [{ problem: "lot cost drift", detail: "lot-1 reads 40, bills say 44", orgId: "org-1", lotId: "lot-1", billId: "bill-1" }],
      skipped: null,
    });
    const res = await GET(req());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.stock_reconcile).toEqual({ problems: 1 });
    expect(steps.reportError).toHaveBeenCalledWith("cron-stock-reconcile", expect.any(Error), { orgId: "org-1", lotId: "lot-1", billId: "bill-1" });
  });
});
