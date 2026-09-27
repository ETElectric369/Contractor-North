/**
 * ONE PERSON, ONE PLACE AT A TIME (migration 0360), exercised where the rule lives.
 *
 * one-place-at-a-time.integration.test.ts runs this against the TEST database inside ONE
 * transaction that is always rolled back; every case sits in its own savepoint. The company is a
 * throwaway one minted in that transaction (an owner who is office staff, and a tech), never a live
 * one. Cases that need a clock "running now" use now() itself, which is fixed for the whole
 * transaction, so a switch, a clock-out and a punch all agree about what now is.
 *
 * Before 0360 is on the database each case says so and returns (loud, not a green lie), unless the
 * run sets ONE_PLACE_SUITE_APPLY=1, which applies 0360 inside the rolled-back transaction: how the
 * migration was iterated before it was applied to the test database. Never set against production;
 * the suite's caller refuses anything but the test database anyway.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { mintOrgAndStranger } from "./throwaway-org.db-fixture";
import { notOnThisDatabase } from "@/lib/db-guard";

export interface SqlClient {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;
  end: () => Promise<void>;
}

const iso = (v: unknown) => new Date(v as string).toISOString();

export function defineOnePlaceAtATimeSuite(connect: () => Promise<SqlClient>) {
  let c: SqlClient;
  let ready = false;
  let orgId = "";
  let techId = "";
  let techName = "";
  let staffId = "";
  let jobA = "";
  let jobB = "";
  const run = Math.random().toString(36).slice(2, 8).toUpperCase();

  const one = async (sql: string, params: unknown[] = []) => (await c.query(sql, params)).rows[0];
  const as = async (uid: string) => {
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: uid, role: "authenticated" })]);
    await c.query("set local role authenticated");
  };
  const asServer = async () => {
    await c.query("reset role");
    await c.query("select set_config('request.jwt.claims', '', true)");
  };
  const step = async (fn: () => Promise<void>) => {
    await c.query("savepoint step");
    try {
      await fn();
    } finally {
      await c.query("rollback to savepoint step");
      await asServer();
    }
  };
  const refusal = async (fn: () => Promise<unknown>): Promise<{ message: string; detail?: string } | null> => {
    await c.query("savepoint attempt");
    try {
      await fn();
      await c.query("release savepoint attempt");
      return null;
    } catch (e: any) {
      await c.query("rollback to savepoint attempt");
      return { message: String(e?.message ?? e), detail: e?.detail };
    }
  };
  const needs = () => ready || notOnThisDatabase("[one-place-at-a-time] migration 0360 is not on this database yet; apply it (or set ONE_PLACE_SUITE_APPLY=1) to exercise this case.");

  type EntryIn = { profile?: string; job?: string | null; code?: string | null; in: string; out?: string | null; source?: string; reason?: string | null };
  /** A fixture row, written as the server (no claims): the person guards stand aside, this one does not. */
  const entry = async (e: EntryIn): Promise<string> =>
    (
      await one(
        `insert into public.time_entries (org_id, profile_id, job_id, job_code, clock_in, clock_out, status, source, auto_closed_reason)
         values ($1, $2, $3, $4, ${e.in}, ${e.out ?? "null"}, $5, $6, $7) returning id`,
        [orgId, e.profile ?? techId, e.job === undefined ? jobA : e.job, e.code ?? null, e.out ? "closed" : "open", e.source ?? "manual", e.reason ?? null],
      )
    ).id;
  /** The same insert, as whoever is speaking (as()/asServer()), for a statement that may be refused. */
  const insert = (e: EntryIn) =>
    c.query(
      `insert into public.time_entries (org_id, profile_id, job_id, job_code, clock_in, clock_out, status, source)
       values ($1, $2, $3, $4, ${e.in}, ${e.out ?? "null"}, $5, $6) returning id`,
      [orgId, e.profile ?? techId, e.job === undefined ? jobA : e.job, e.code ?? null, e.out ? "closed" : "open", e.source ?? "manual"],
    );
  const row = async (id: string) =>
    one("select id, profile_id, job_id, clock_in, clock_out, status, source, auto_closed_reason, split_from from public.time_entries where id = $1", [id]);
  const rpc = async (fn: string, args: unknown[]) => {
    const ph = args.map((_, i) => `$${i + 1}`).join(", ");
    return (await one(`select public.${fn}(${ph}) as r`, args)).r;
  };
  const ts = (s: string) => `'${s}'::timestamptz`;

  beforeAll(async () => {
    c = await connect();
    await c.query("begin");
    await c.query("set local lock_timeout = '5s'");
    const has = async () =>
      (
        await one(
          `select position('ONE PERSON, ONE PLACE AT A TIME' in p.prosrc) > 0 as ok
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname = 'guard_time_entry_sanity'`,
        )
      )?.ok === true;
    ready = await has();
    if (!ready && process.env.ONE_PLACE_SUITE_APPLY === "1") {
      const sql = readFileSync(fileURLToPath(new URL("../../supabase/migrations/0360_one_person_one_place_at_a_time.sql", import.meta.url)), "utf8");
      await c.query(sql);
      ready = await has();
      console.warn("[one-place-at-a-time] 0360 is not on this database yet; applied inside the test's own transaction, which is rolled back.");
    }
    if (!ready) return;

    const fx = await mintOrgAndStranger(c, "one-place");
    orgId = fx.orgId;
    techId = fx.techId;
    staffId = fx.staffId;
    techName = (await one("select full_name from public.profiles where id = $1", [techId])).full_name;
    // THE COMPANY'S OWN TIMEZONE, not the one the old sentence hard-coded: New York here.
    await c.query(
      "update public.organizations set settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object('timezone', 'America/New_York') where id = $1",
      [orgId],
    );
    const job = async (n: string) =>
      (
        await one(
          `insert into public.jobs (org_id, name, job_number, status, billing_type)
           values ($1, $2, $3, 'scheduled', 'tm') returning id`,
          [orgId, `TEST one-place job ${n}`, `TEST-ONE-${n}-${run}`],
        )
      ).id;
    jobA = await job("A");
    jobB = await job("B");
  });

  afterAll(async () => {
    await c?.query("rollback").catch(() => undefined);
    await c?.end();
  });

  describe("the same person's hours, twice", () => {
    it("refuses a second entry over hours already on a job, naming the person, the day and times in the company's timezone, the job, and the shift's id", async () => {
      if (!needs()) return;
      await step(async () => {
        // 9:00 AM to 5:00 PM New York, Thu Feb 1 2001.
        const first = await entry({ in: ts("2001-02-01T14:00:00Z"), out: ts("2001-02-01T22:00:00Z") });
        await as(staffId);
        const r = await refusal(() => insert({ job: jobB, in: ts("2001-02-01T15:00:00Z"), out: ts("2001-02-01T16:00:00Z") }));
        expect(r?.message).toBe(
          `Those hours overlap a shift already recorded for ${techName}: Thu Feb 1, 9:00 AM to 5:00 PM, on TEST one-place job A. Edit that shift instead, or move these times clear of it.`,
        );
        expect(r?.detail).toBe(`time_entry:${first}`);
      });
    });

    it("a no-job punch is named as one, with the advice to put it on the job (the 85 Whitney case)", async () => {
      if (!needs()) return;
      await step(async () => {
        // Brian's 9/11 shape: an app punch with no job, then the office types the day on the job.
        const punch = await entry({ job: null, in: ts("2001-02-02T15:31:00Z"), out: ts("2001-02-02T23:57:00Z"), source: "app" });
        await as(staffId);
        const r = await refusal(() => insert({ job: jobA, in: ts("2001-02-02T16:00:00Z"), out: ts("2001-02-03T00:30:00Z") }));
        expect(r?.message).toMatch(/overlap a shift already recorded for .*: Fri Feb 2, 10:31 AM to 6:57 PM, on no job\. Put that shift on the job instead of adding the hours again/);
        expect(r?.detail).toBe(`time_entry:${punch}`);
        // THE DOOR THE SENTENCE NAMES: putting the punch itself on the job is a job change, not a
        // time change, so it passes, and the hours land on the job once.
        await c.query("update public.time_entries set job_id = $2 where id = $1", [punch, jobA]);
        expect((await row(punch)).job_id).toBe(jobA);
      });
    });

    it("the exact same times twice is refused as the double submit it is", async () => {
      if (!needs()) return;
      await step(async () => {
        const first = await entry({ in: ts("2001-02-05T19:30:00Z"), out: ts("2001-02-05T21:00:00Z") });
        await as(staffId);
        const r = await refusal(() => insert({ in: ts("2001-02-05T19:30:00Z"), out: ts("2001-02-05T21:00:00Z") }));
        expect(r?.message).toMatch(/Those exact times are already recorded for this person on another entry/);
        expect(r?.detail).toBe(`time_entry:${first}`);
      });
    });

    it("passes the same hours for somebody else, shifts that touch, and a minute of slack", async () => {
      if (!needs()) return;
      await step(async () => {
        await entry({ in: ts("2001-02-06T14:00:00Z"), out: ts("2001-02-06T18:00:00Z") });
        await as(staffId);
        expect(await refusal(() => insert({ profile: staffId, in: ts("2001-02-06T14:00:00Z"), out: ts("2001-02-06T18:00:00Z") }))).toBeNull();
        expect(await refusal(() => insert({ job: jobB, in: ts("2001-02-06T18:00:00Z"), out: ts("2001-02-06T20:00:00Z") }))).toBeNull();
        expect(await refusal(() => insert({ job: jobB, in: ts("2001-02-06T13:00:00Z"), out: ts("2001-02-06T14:00:30Z") }))).toBeNull();
      });
    });

    it("handing a shift to someone who already has those hours is refused (the trigger fires on the person too)", async () => {
      if (!needs()) return;
      await step(async () => {
        await entry({ in: ts("2001-02-07T14:00:00Z"), out: ts("2001-02-07T22:00:00Z") });
        const erik = await entry({ profile: staffId, in: ts("2001-02-07T15:00:00Z"), out: ts("2001-02-07T19:00:00Z") });
        await as(staffId);
        const r = await refusal(() => c.query("update public.time_entries set profile_id = $2 where id = $1", [erik, techId]));
        expect(r?.message).toMatch(/overlap a shift already recorded for /);
        // A note or job fix on the same row keeps saving: no time or person moved.
        expect(await refusal(() => c.query("update public.time_entries set notes = 'fixed', job_id = $2 where id = $1", [erik, jobB]))).toBeNull();
      });
    });
  });

  describe("a running clock runs until now", () => {
    it("hours typed into a day a clock is still running across are refused, and pass once the clock is stopped where it really ended", async () => {
      if (!needs()) return;
      await step(async () => {
        const open = await entry({ in: "now() - interval '3 hours'" });
        await as(staffId);
        const r = await refusal(() => insert({ job: jobB, in: "now() - interval '2 hours'", out: "now() - interval '1 hour'" }));
        expect(r?.message).toMatch(/overlap a shift already recorded for .*: a clock running since .*, on TEST one-place job A\. Stop that clock at the time the shift really ended first\./);
        expect(r?.detail).toBe(`time_entry:${open}`);
        // The office's Stop The Clock at a stated time (stopShift's write) passes, and then the hours fit.
        expect(
          await refusal(() =>
            c.query("update public.time_entries set status = 'closed', clock_out = now() - interval '150 minutes' where id = $1", [open]),
          ),
        ).toBeNull();
        expect(await refusal(() => insert({ job: jobB, in: "now() - interval '2 hours'", out: "now() - interval '1 hour'" }))).toBeNull();
      });
    });

    it("a clock-in back-dated over hours already recorded is refused at the punch, not left to trap the clock-out", async () => {
      if (!needs()) return;
      await step(async () => {
        // Erik's 9/1 shape: hours on the card, then a staff clock-in back-dated across them.
        await entry({ profile: staffId, in: "now() - interval '3 hours'", out: "now() - interval '1 hour'" });
        await as(staffId);
        const r = await refusal(() => insert({ profile: staffId, in: "now() - interval '2 hours'", source: "manual" }));
        expect(r?.message).toMatch(/overlap a shift already recorded for .*: .* to .*, on TEST one-place job A/);
        // Back-dated only to where the last shift ended, it opens.
        expect(await refusal(() => insert({ profile: staffId, in: "now() - interval '1 hour'", source: "manual" }))).toBeNull();
      });
    });

    it("two running clocks stay the unique index's to refuse, in its own words", async () => {
      if (!needs()) return;
      await step(async () => {
        await entry({ in: "now() - interval '1 hour'" });
        const r = await refusal(() => insert({ in: "now() - interval '30 minutes'" }));
        expect(r?.message).toMatch(/one_open_entry_per_user/);
        expect(r?.message).not.toMatch(/overlap a shift/);
      });
    });
  });

  describe("the clock's own moves still pass", () => {
    it("a live punch right after a clock-out, then Switch Job (a cut), then Clock Out", async () => {
      if (!needs()) return;
      await step(async () => {
        await entry({ in: "now() - interval '4 hours'", out: "now() - interval '10 minutes'" });
        await as(techId);
        const opened = await refusal(() => insert({ job: jobA, in: "now() - interval '10 minutes'", source: "app" }));
        expect(opened).toBeNull();
        const open = (await one("select id from public.time_entries where profile_id = $1 and status = 'open'", [techId])).id;
        // Ten minutes in, a Switch Job is a cut: close now, open the next piece at the same instant.
        const sw = await rpc("switch_job", [open, jobB, null, null]);
        expect(sw.mode).toBe("cut");
        expect(iso((await row(open)).clock_out)).toBe(iso((await row(sw.entry_id)).clock_in));
        // Clock Out: the tech closes his own running piece.
        expect(await refusal(() => c.query("update public.time_entries set status = 'closed', clock_out = now() where id = $1", [sw.entry_id]))).toBeNull();
      });
    });

    it("a running punch with no job is re-pointed whole by Switch Job", async () => {
      if (!needs()) return;
      await step(async () => {
        const open = await entry({ job: null, in: "now() - interval '20 minutes'", source: "app" });
        await as(techId);
        const sw = await rpc("switch_job", [open, jobA, null, null]);
        expect(sw.mode).toBe("repointed");
        expect((await row(open)).job_id).toBe(jobA);
      });
    });

    it("an offline punch delivered late onto a clear day opens, and its clock-out closes", async () => {
      if (!needs()) return;
      await step(async () => {
        await as(techId);
        expect(await refusal(() => insert({ in: "now() - interval '3 hours'", source: "offline" }))).toBeNull();
        const open = (await one("select id from public.time_entries where profile_id = $1 and status = 'open'", [techId])).id;
        expect(await refusal(() => c.query("update public.time_entries set status = 'closed', clock_out = now() - interval '30 minutes' where id = $1", [open]))).toBeNull();
      });
    });

    it("a stale clock (18 h+) is zero-closed by the next punch, and the punch lands", async () => {
      if (!needs()) return;
      await step(async () => {
        const stale = await entry({ in: "now() - interval '20 hours'", source: "app" });
        await as(techId);
        expect(await refusal(() => insert({ in: "now()", source: "app" }))).toBeNull();
        await asServer();
        const s = await row(stale);
        expect(s.status).toBe("closed");
        expect(iso(s.clock_out)).toBe(iso(s.clock_in));
        expect(s.auto_closed_reason).toMatch(/forgotten/);
      });
    });

    it("split, Move The Split and Join Back: pieces of one shift touch and never count twice", async () => {
      if (!needs()) return;
      await step(async () => {
        const id = await entry({ in: ts("2001-03-01T16:00:00Z"), out: ts("2001-03-01T22:00:00Z") });
        await as(staffId);
        const r = await rpc("split_time_entry", [id, "2001-03-01T19:00:00Z", jobB, null, null, null]);
        const later = await rpc("move_time_entry_cut", [id, r.right_id, "2001-03-01T20:00:00Z"]);
        expect(later.moved).toBe(true);
        const earlier = await rpc("move_time_entry_cut", [id, r.right_id, "2001-03-01T17:00:00Z"]);
        expect(earlier.moved).toBe(true);
        const j = await rpc("join_time_entries", [id, r.right_id]);
        expect(j.kept_id).toBe(id);
        await asServer();
        expect(iso((await row(id)).clock_out)).toBe("2001-03-01T22:00:00.000Z");
      });
    });
  });

  it("the guard takes a per-person lock and fires on clock_in, clock_out and profile_id", async () => {
    if (!needs()) return;
    const src = (await one("select prosrc from pg_proc where oid = 'public.guard_time_entry_sanity()'::regprocedure")).prosrc as string;
    expect(src).toContain("pg_advisory_xact_lock");
    expect(src).not.toContain("America/Los_Angeles");
    const cols = (
      await one(
        `select array_agg(a.attname::text order by a.attname) as cols
           from pg_trigger t, unnest(t.tgattr::int2[]) as k(attnum)
           join pg_attribute a on a.attnum = k.attnum
          where t.tgrelid = 'public.time_entries'::regclass and t.tgname = 'zz_guard_time_entry_sanity'
            and a.attrelid = t.tgrelid`,
      )
    ).cols;
    expect(cols).toEqual(["clock_in", "clock_out", "profile_id"]);
  });
}
