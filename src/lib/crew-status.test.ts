import { describe, it, expect } from "vitest";
import { getCrewStatus } from "./crew-status";

/**
 * THE LABEL ON THE CREW STRIP. Erik filed "job name not job number" three times — once about
 * /timecards, twice more as "everywhere". /timecards itself already used the jobLabel SSOT; the
 * live-presence strip across the top of it did not, because crew-status.ts built its own
 * number-first label. That is why it kept reading as unfixed.
 *
 * These lock the shape rather than the wording, so the SSOT can evolve and this still holds.
 */

/** A chainable stub: profiles resolves to `members`, time_entries to `open`. */
function fakeSupabase(members: unknown[], open: unknown[]) {
  const make = (rows: unknown[]) => {
    const q: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in", "order"]) q[m] = () => q;
    // Awaited at the call site, so the chain has to be thenable.
    (q as { then: unknown }).then = (res: (v: { data: unknown[] }) => unknown) => res({ data: rows });
    return q;
  };
  return { from: (t: string) => make(t === "profiles" ? members : open) };
}

const brian = { id: "u1", full_name: "Brian" };

describe("getCrewStatus — the job label", () => {
  it("shows the NAME, not the number", async () => {
    const crew = await getCrewStatus(
      fakeSupabase([brian], [{ profile_id: "u1", job: { job_number: "J-009", name: "TTP #11" } }]),
    );
    expect(crew[0].jobLabel).toBe("TTP #11");
    expect(crew[0].jobLabel).not.toContain("J-009");
  });

  it("falls back to the number when a job has no name — never a bare separator", async () => {
    const crew = await getCrewStatus(
      fakeSupabase([brian], [{ profile_id: "u1", job: { job_number: "J-012", name: null } }]),
    );
    expect(crew[0].jobLabel).toBe("J-012");
    expect(crew[0].jobLabel).not.toMatch(/·|undefined|null/);
  });

  it("three dwellings at one address stay distinguishable", async () => {
    // The whole reason the number is wrong here: J-009/J-013/J-017 are 300 W Lake Blvd #11/#56/#224.
    const crew = await getCrewStatus(
      fakeSupabase(
        [brian, { id: "u2", full_name: "Ryan" }],
        [
          { profile_id: "u1", job: { job_number: "J-009", name: "TTP #11" } },
          { profile_id: "u2", job: { job_number: "J-017", name: "TTP #224" } },
        ],
      ),
    );
    expect(crew.map((c) => c.jobLabel)).toEqual(["TTP #11", "TTP #224"]);
  });

  it("off the clock is a null label and clockedIn false, not an empty string", async () => {
    const crew = await getCrewStatus(fakeSupabase([brian], []));
    expect(crew[0]).toMatchObject({ name: "Brian", clockedIn: false, jobLabel: null });
  });

  it("on the clock with no job selected still reads as clocked in", async () => {
    const crew = await getCrewStatus(fakeSupabase([brian], [{ profile_id: "u1", job: null }]));
    expect(crew[0]).toMatchObject({ clockedIn: true, jobLabel: null });
  });

  it("nobody active is an empty list, not a throw", async () => {
    expect(await getCrewStatus(fakeSupabase([], []))).toEqual([]);
  });
});
