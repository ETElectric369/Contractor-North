import { describe, it, expect, vi } from "vitest";

/**
 * NORT'S job.create SAYS THE VISIT IT TIED (cn-v1181 fixer, skeptic #84 S6). createJob answers `note`
 * when it files an open site visit with the new job; the model is handed only what agentToolResultBody
 * projects, and `note` is not on that list, so the handler hands it on as `speak`. Stand-ins: Dana Rook.
 */
const made = vi.hoisted(() => ({ res: {} as Record<string, unknown> }));
vi.mock("@/app/(app)/schedule/actions", () => ({
  createJob: vi.fn(async () => made.res),
  scheduleJobWindow: vi.fn(),
  addJobDay: vi.fn(),
  setJobDayTimes: vi.fn(),
  setJobCrew: vi.fn(),
  moveJobDay: vi.fn(),
  createScheduleProposal: vi.fn(),
  setJobHold: vi.fn(),
  snoozeJobHold: vi.fn(),
}));
vi.mock("@/app/(app)/jobs/actions", () => ({ setJobStatus: vi.fn(), finishJob: vi.fn(), updateJobDescription: vi.fn(), setJobCustomer: vi.fn() }));
vi.mock("@/app/(app)/jobs/[id]/job-contacts-actions", () => ({ linkJobContact: vi.fn(), unlinkJobContact: vi.fn() }));
vi.mock("@/lib/schedule/job-day-read", () => ({ readJobDay: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => ({})) }));
vi.mock("../resolve-id", () => ({
  resolveCustomerId: vi.fn(async () => ({ id: "cust-dana" })),
  resolveContactId: vi.fn(),
  resolveJobId: vi.fn(),
  resolveProfileId: vi.fn(),
}));

const { jobActions } = await import("./job");
const { agentToolResultBody } = await import("../agent-tool-result");

describe("job.create: the tie is in the words Nort gives back", () => {
  it("a visit filed with the new job rides as speak, and the model is handed it", async () => {
    made.res = { ok: true, id: "job-1", name: "410 Larkspur Ln", note: "Site inspection: Dana Rook (Sun Nov 8) is filed with this job." };
    const res = await jobActions["job.create"].handler({ name: "410 Larkspur Ln", customer_id: "cust-dana" } as any, {} as any);
    expect(JSON.parse(agentToolResultBody(res as any)).speak).toBe("Site inspection: Dana Rook (Sun Nov 8) is filed with this job.");
  });
  it("a tie that failed rides as warning", async () => {
    made.res = { ok: true, id: "job-1", name: "410 Larkspur Ln", warning: "The visit couldn't be filed with this job." };
    const res = await jobActions["job.create"].handler({ name: "410 Larkspur Ln" } as any, {} as any);
    expect(JSON.parse(agentToolResultBody(res as any)).warning).toBe("The visit couldn't be filed with this job.");
  });
});

describe("organize.billReceipt: the pen sentence still reaches Nort (S7 moved it off `warning`)", () => {
  it("rides as speak", async () => {
    vi.resetModules();
    vi.doMock("@/app/(app)/organize/actions", () => ({
      archiveItem: vi.fn(),
      saveVoiceNote: vi.fn(),
      aiReviewItem: vi.fn(),
      billJobReceipt: vi.fn(async () => ({ ok: true, amount: 162, pen: "Pen marks read: 1 line crossed out." })),
    }));
    const { organizeActions } = await import("./organize");
    const res = await organizeActions["organize.billReceipt"].handler({ document_id: "doc-7" } as any, {} as any);
    const { agentToolResultBody: body } = await import("../agent-tool-result");
    expect(JSON.parse(body(res as any)).speak).toBe("Pen marks read: 1 line crossed out.");
  });
});
