import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * NORT'S NIGHTLY REVIEW SAYS WHEN IT BROKE (cn-v1130). generateNortReview used to answer null for a
 * quiet night AND for a missing key, a model failure and a refused insert, and the all-companies
 * runner swallowed every throw, so a review that had not run for weeks read as "nothing happened".
 * Pinned: null is only the quiet night (no model call); the three failures throw with the vendor's or
 * PostgREST's words; the runner reads the companies through readAllOrgs (a failed read throws to the
 * cron), counts made and failed, files each failure with its orgId, and past its deadline stops and
 * files ONE row saying how many companies it did not reach — under a FIXED message with the count in
 * the extras (the sink dedupes on the words), and every model call carries its own clock and no
 * retries (skeptic #34), so a hung call cannot outlive the run.
 */
const model = vi.hoisted(() => ({ create: vi.fn(), keyUnset: false }));
const spies = vi.hoisted(() => ({ reportError: vi.fn(), readAllOrgs: vi.fn(), recordAiUsage: vi.fn() }));

vi.mock("@/lib/anthropic", () => ({
  DEFAULT_MODEL: "claude-test-model",
  getAnthropic: () => {
    if (model.keyUnset) throw new Error("ANTHROPIC_API_KEY is not set. Add it to .env.local / Vercel env vars.");
    return { messages: { create: model.create } };
  },
}));
vi.mock("@/lib/ai-cost", () => ({ recordAiUsage: spies.recordAiUsage }));
vi.mock("@/lib/observe", () => ({
  reportError: spies.reportError,
  errorMessage: (e: unknown) => (e instanceof Error ? e.message : String((e as { message?: string } | null)?.message ?? e)),
}));
vi.mock("@/lib/cron-orgs", () => ({ readAllOrgs: spies.readAllOrgs }));

import { generateNortReview, generateNortReviewsForAllOrgs } from "./review";

type Answer = { data?: unknown; error?: unknown };

/** A pretend service client routed by table: the review's reads (profiles, bug_reports,
 *  conversations, messages) answer through `then`, and the nort_reviews insert's `.select("id").single()`
 *  answers the same table's row. Every write is kept. */
function fake(answers: Record<string, Answer>) {
  const writes: { table: string; row: any }[] = [];
  const client = {
    from(table: string) {
      const answer = () => ({ data: answers[table]?.data ?? [], error: answers[table]?.error ?? null });
      const q: any = {
        insert(row: any) {
          writes.push({ table, row });
          return q;
        },
        single: async () => answer(),
        then: (ok: any, bad?: any) => Promise.resolve(answer()).then(ok, bad),
      };
      for (const m of ["select", "eq", "in", "gte", "order", "limit"]) q[m] = () => q;
      return q;
    },
  } as any;
  return { client, writes };
}

const CREW = [{ id: "p-1", full_name: "Larkspur" }];
const ONE_BUG = [{ note: "The clock-in button did nothing twice this morning", page: "/timeclock", status: "open", created_at: "2026-10-26T15:00:00Z", reported_by: "p-1" }];
const QUIET = { profiles: { data: CREW }, bug_reports: { data: [] }, conversations: { data: [] }, messages: { data: [] } };
const BUSY = { ...QUIET, bug_reports: { data: ONE_BUG }, nort_reviews: { data: { id: "rev-1" } } };

const MODEL_ANSWER = {
  usage: { input_tokens: 10, output_tokens: 5 },
  content: [
    {
      type: "text",
      text: JSON.stringify({
        summary: "One bug filed: the clock-in button.",
        findings: [{ title: "Fix the clock-in button", kind: "bug", priority: 1, evidence: "the report from the morning" }],
      }),
    },
  ],
};

beforeEach(() => {
  model.create.mockReset();
  model.keyUnset = false;
  for (const fn of Object.values(spies)) fn.mockReset();
});
afterEach(() => vi.useRealTimers());

describe("generateNortReview", () => {
  it("a quiet night is null: no bug reports and no messages, and no model call", async () => {
    const { client, writes } = fake(QUIET);
    expect(await generateNortReview(client, "org-a")).toBeNull();
    expect(model.create).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  it("a night with signal writes the review and hands it back with its id", async () => {
    model.create.mockResolvedValue(MODEL_ANSWER);
    const { client, writes } = fake(BUSY);
    const r = await generateNortReview(client, "org-a");
    expect(r?.id).toBe("rev-1");
    expect(r?.summary).toBe("One bug filed: the clock-in button.");
    expect(r?.findings[0]).toMatchObject({ title: "Fix the clock-in button", kind: "bug", priority: 1 });
    expect(r?.counts).toEqual({ bug_reports: 1, conversations: 0, messages: 0 });
    expect(writes).toEqual([{ table: "nort_reviews", row: expect.objectContaining({ org_id: "org-a", summary: r?.summary }) }]);
    expect(spies.recordAiUsage).toHaveBeenCalledWith(expect.objectContaining({ orgId: "org-a", surface: "nort:review" }));
  });

  it("the model call carries its own clock and no retries, as the SDK's second argument", async () => {
    model.create.mockResolvedValue(MODEL_ANSWER);
    await generateNortReview(fake(BUSY).client, "org-a");
    expect(model.create).toHaveBeenCalledTimes(1);
    expect(model.create.mock.calls[0][1]).toEqual({ timeout: 120_000, maxRetries: 0 });
    // the params stay the first argument, untouched by the options
    expect(model.create.mock.calls[0][0]).toMatchObject({ model: "claude-test-model", max_tokens: 1500 });
    expect(model.create.mock.calls[0][0]).not.toHaveProperty("timeout");

    model.create.mockClear();
    await generateNortReview(fake(BUSY).client, "org-a", 36, 30_000);
    expect(model.create.mock.calls[0][1]).toEqual({ timeout: 30_000, maxRetries: 0 });
  });

  it("the model refusing THROWS with the vendor's words, not null", async () => {
    model.create.mockRejectedValue(new Error("overloaded_error: the vendor is busy"));
    const { client, writes } = fake(BUSY);
    await expect(generateNortReview(client, "org-a")).rejects.toThrow(/the vendor is busy/);
    expect(writes).toEqual([]);
  });

  it("the insert refused THROWS with PostgREST's words (a plain object, not an Error)", async () => {
    model.create.mockResolvedValue(MODEL_ANSWER);
    const { client } = fake({ ...BUSY, nort_reviews: { data: null, error: { message: "permission denied for table nort_reviews", code: "42501" } } });
    await expect(generateNortReview(client, "org-a")).rejects.toThrow(/permission denied for table nort_reviews/);
  });

  it("an unset key THROWS (the env var's name, never a value), not null", async () => {
    model.keyUnset = true;
    const { client } = fake(BUSY);
    await expect(generateNortReview(client, "org-a")).rejects.toThrow(/ANTHROPIC_API_KEY is not set/);
    expect(model.create).not.toHaveBeenCalled();
  });

  it("an unset key on a quiet night is still null: the quiet check comes first, so no row is filed for nothing", async () => {
    model.keyUnset = true;
    const { client } = fake(QUIET);
    expect(await generateNortReview(client, "org-a")).toBeNull();
  });
});

describe("generateNortReviewsForAllOrgs", () => {
  it("reads the companies through readAllOrgs by id, counts made and failed, files each failure with its orgId", async () => {
    spies.readAllOrgs.mockResolvedValue([{ id: "org-a" }, { id: "org-b" }, { id: "org-c" }]);
    model.create
      .mockResolvedValueOnce(MODEL_ANSWER)
      .mockRejectedValueOnce(new Error("overloaded_error: the vendor is busy"))
      .mockResolvedValueOnce(MODEL_ANSWER);
    const { client } = fake(BUSY);
    expect(await generateNortReviewsForAllOrgs(client)).toEqual({ made: 2, failed: 1, left: 0 });
    expect(spies.readAllOrgs).toHaveBeenCalledWith(client, "id");
    expect(spies.reportError).toHaveBeenCalledTimes(1);
    expect(spies.reportError).toHaveBeenCalledWith("nort:review", expect.any(Error), { orgId: "org-b" });
    expect(spies.reportError.mock.calls[0][1].message).toMatch(/the vendor is busy/);
  });

  it("a quiet company is neither made nor failed", async () => {
    spies.readAllOrgs.mockResolvedValue([{ id: "org-a" }]);
    const { client } = fake(QUIET);
    expect(await generateNortReviewsForAllOrgs(client)).toEqual({ made: 0, failed: 0, left: 0 });
    expect(spies.reportError).not.toHaveBeenCalled();
  });

  it("a failed companies read THROWS to the cron (which files it as cron-nort-review): never an empty run", async () => {
    spies.readAllOrgs.mockRejectedValue(new Error("organizations could not be read: connection reset"));
    const { client } = fake(BUSY);
    await expect(generateNortReviewsForAllOrgs(client)).rejects.toThrow(/organizations could not be read/);
    expect(model.create).not.toHaveBeenCalled();
  });

  it("past the deadline it stops before the next company and files ONE row saying how many were not reviewed", async () => {
    const T = Date.parse("2026-10-27T09:00:00Z");
    vi.useFakeTimers();
    vi.setSystemTime(T);
    spies.readAllOrgs.mockResolvedValue([{ id: "org-a" }, { id: "org-b" }]);
    // The first company's model call eats the budget; the check before the second sees it gone.
    model.create.mockImplementationOnce(async () => {
      vi.setSystemTime(T + 5_000);
      return MODEL_ANSWER;
    });
    const { client } = fake(BUSY);
    expect(await generateNortReviewsForAllOrgs(client, { deadlineMs: T + 1_000 })).toEqual({ made: 1, failed: 0, left: 1 });
    expect(model.create).toHaveBeenCalledTimes(1);
    expect(spies.reportError).toHaveBeenCalledTimes(1);
    expect(spies.reportError).toHaveBeenCalledWith("nort:review", expect.any(Error), { left: 1 });
    // FIXED words (the sink dedupes on where + message): the count rides in the extras, never the message.
    expect(spies.reportError.mock.calls[0][1].message).toBe("cut short: companies not reviewed");
  });

  it("the cut-short row's message is the same whatever the count, so the sink keeps one row", async () => {
    const T = Date.parse("2026-10-27T09:00:00Z");
    vi.useFakeTimers();
    vi.setSystemTime(T);
    const { client } = fake(BUSY);
    spies.readAllOrgs.mockResolvedValue([{ id: "org-a" }, { id: "org-b" }, { id: "org-c" }]);
    await generateNortReviewsForAllOrgs(client, { deadlineMs: T - 1 }); // spent before the first company
    spies.readAllOrgs.mockResolvedValue([{ id: "org-a" }]);
    await generateNortReviewsForAllOrgs(client, { deadlineMs: T - 1 });
    expect(spies.reportError).toHaveBeenCalledTimes(2);
    expect(spies.reportError.mock.calls.map((c) => c[1].message)).toEqual(["cut short: companies not reviewed", "cut short: companies not reviewed"]);
    expect(spies.reportError.mock.calls.map((c) => c[2])).toEqual([{ left: 3 }, { left: 1 }]);
    expect(model.create).not.toHaveBeenCalled();
  });

  it("each company's call gets what is left of the run's share: capped at two minutes, floored at ten seconds", async () => {
    const T = Date.parse("2026-10-27T09:00:00Z");
    vi.useFakeTimers();
    vi.setSystemTime(T);
    spies.readAllOrgs.mockResolvedValue([{ id: "org-a" }]);
    model.create.mockResolvedValue(MODEL_ANSWER);
    const { client } = fake(BUSY);
    const timeoutFor = async (deadlineMs: number) => {
      model.create.mockClear();
      await generateNortReviewsForAllOrgs(client, { deadlineMs });
      return model.create.mock.calls[0][1];
    };
    expect(await timeoutFor(T + 60_000)).toEqual({ timeout: 60_000, maxRetries: 0 }); // what is left
    expect(await timeoutFor(T + 500_000)).toEqual({ timeout: 120_000, maxRetries: 0 }); // capped
    expect(await timeoutFor(T + 2_000)).toEqual({ timeout: 10_000, maxRetries: 0 }); // floored
    // No deadline given: the call's own default clock (two minutes), still no retries.
    model.create.mockClear();
    await generateNortReviewsForAllOrgs(client);
    expect(model.create.mock.calls[0][1]).toEqual({ timeout: 120_000, maxRetries: 0 });
  });

  it("a deadline still ahead changes nothing: every company runs, no row", async () => {
    spies.readAllOrgs.mockResolvedValue([{ id: "org-a" }, { id: "org-b" }]);
    model.create.mockResolvedValue(MODEL_ANSWER);
    const { client } = fake(BUSY);
    expect(await generateNortReviewsForAllOrgs(client, { deadlineMs: Date.now() + 60_000 })).toEqual({ made: 2, failed: 0, left: 0 });
    expect(spies.reportError).not.toHaveBeenCalled();
  });
});
