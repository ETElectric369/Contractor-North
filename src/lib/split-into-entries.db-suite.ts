/**
 * THE SPLIT-INTO-ENTRIES DATABASE SUITE (migrations 0288 + 0289), written once and run against any
 * Postgres that has them: split-into-entries.integration.test.ts runs it against the production
 * database inside ONE transaction that is always rolled back (the billing test's pattern), so
 * nothing it creates survives.
 *
 * It exercises the rules where they live, as the people they bind: office staff, a tech, and staff
 * of ANOTHER company, by planting request.jwt.claims and `set local role authenticated`, exactly as
 * PostgREST does. Every fixture sits in 2001, on days nobody worked (a previous test failed CI by
 * choosing Sep 10 and landing on a real shift). The live Switch Job test is the only one that runs at
 * "now", and it picks a person with nothing on the clock around now.
 *
 * Before the migrations are applied, each test says so on the console and returns: loud, not a
 * green lie, and the rest of the run still goes.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { aggregatePayrollEntries } from "./payroll-math";

export interface SqlClient {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;
  end: () => Promise<void>;
}

const num = (v: unknown) => Number(v);
const iso = (v: unknown) => new Date(v as string).toISOString();

export function defineSplitIntoEntriesSuite(connect: () => Promise<SqlClient>) {
  let c: SqlClient;
  let has0288 = false;
  let has0289 = false;
  let orgId = "";
  let staffId = "";
  let techId = "";
  let otherStaffId = "";
  /** Someone in the org with nothing on the clock: one_open_entry_per_user allows them an open fixture. */
  let idleId = "";
  let jobA = "";
  let jobB = "";
  let jobC = "";
  let seq = 0;

  const one = async (sql: string, params: unknown[] = []) => (await c.query(sql, params)).rows[0];

  /** Speak as this person: the claims auth.uid() reads, under the role PostgREST uses. */
  const as = async (uid: string) => {
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: uid, role: "authenticated" })]);
    await c.query("set local role authenticated");
  };
  /** Back to the direct connection: no claims (a privileged writer), RLS bypassed. */
  const asServer = async () => {
    await c.query("reset role");
    await c.query("select set_config('request.jwt.claims', '', true)");
  };
  /** Each test runs inside its own savepoint and leaves nothing behind for the next. */
  const step = async (fn: () => Promise<void>) => {
    await c.query("savepoint step");
    try {
      await fn();
    } finally {
      await c.query("rollback to savepoint step");
      await asServer();
    }
  };
  /** A statement that should be refused: its error (message + detail), or null if it went through. */
  const refusal = async (fn: () => Promise<unknown>): Promise<{ message: string; detail?: string } | null> => {
    await c.query("savepoint attempt");
    try {
      await fn();
      await c.query("rollback to savepoint attempt");
      return null;
    } catch (e: any) {
      await c.query("rollback to savepoint attempt");
      return { message: String(e?.message ?? e), detail: e?.detail };
    }
  };
  const needs = (what: "0288" | "0289") => {
    const ok = what === "0288" ? has0288 : has0289;
    if (!ok) console.warn(`[split-into-entries] migration ${what} is not on this database yet; apply it to exercise this case.`);
    return ok;
  };

  // ── fixture writers, as the server ──
  type EntryIn = {
    profile?: string;
    job?: string | null;
    code?: string | null;
    in: string;
    out?: string | null;
    lunch?: number;
    miles?: number;
    rate?: number | null;
    paidAt?: string | null;
    status?: "open" | "closed";
    reason?: string | null;
  };
  const entry = async (e: EntryIn): Promise<string> =>
    (
      await one(
        `insert into public.time_entries (org_id, profile_id, job_id, job_code, clock_in, clock_out, lunch_minutes, miles,
                                          rate_override, paid_at, status, source, auto_closed_reason)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'manual', $12) returning id`,
        [
          orgId,
          e.profile ?? techId,
          e.job === undefined ? jobA : e.job,
          e.code ?? null,
          e.in,
          e.out === undefined ? null : e.out,
          e.lunch ?? 0,
          e.miles ?? 0,
          e.rate ?? null,
          e.paidAt ?? null,
          e.status ?? (e.out ? "closed" : "open"),
          e.reason ?? null,
        ],
      )
    ).id;
  const invoice = async (status: string, job = jobA): Promise<{ id: string; number: string }> => {
    const number = `TEST-SPLIT-${++seq}`;
    const r = await one(
      `insert into public.invoices (org_id, job_id, invoice_number, status, total, amount_paid)
       values ($1, $2, $3, $4, 100, $5) returning id`,
      [orgId, job, number, status, status === "paid" ? 100 : 0],
    );
    return { id: r.id, number };
  };
  const line = async (invoiceId: string, sourceIds: string[], quantity = 1): Promise<string> =>
    (
      await one(
        `insert into public.invoice_items (org_id, invoice_id, description, quantity, unit_price, source_ids, import_source)
         values ($1, $2, 'Labor - test', $3, 95, $4::uuid[], 'labor') returning id`,
        [orgId, invoiceId, quantity, sourceIds],
      )
    ).id;
  const lineIds = async (lineId: string): Promise<string[]> =>
    (await one("select source_ids from public.invoice_items where id = $1", [lineId])).source_ids;
  const row = async (id: string) =>
    one(
      `select id, profile_id, job_id, job_code, clock_in, clock_out, lunch_minutes, miles, rate_override, paid_at,
              mileage_paid_at, source, status, split_from, split_how, auto_closed_reason
         from public.time_entries where id = $1`,
      [id],
    );
  const workedS = async (ids: string[]) =>
    num(
      (
        await one(
          `select sum(extract(epoch from (clock_out - clock_in)) - lunch_minutes * 60) as s
             from public.time_entries where id = any($1::uuid[])`,
          [ids],
        )
      ).s,
    );
  const rpc = async (fn: string, args: unknown[]) => {
    const ph = args.map((_, i) => `$${i + 1}`).join(", ");
    return (await one(`select public.${fn}(${ph}) as r`, args)).r;
  };
  /** An old-style split row, for the carve and the "still has an old split" refusal. 0289 freezes the
   *  table; cn.legacy_fixture is the door it keeps for exactly this, on a direct connection only. */
  const alloc = async (entryId: string, job: string | null, hours: number, sort: number, code: string | null = null) => {
    await c.query("select set_config('cn.legacy_fixture', 'on', true)");
    const r = await one(
      `insert into public.time_allocations (time_entry_id, org_id, job_id, job_code, hours, sort_order)
       values ($1, $2, $3, $4, $5, $6) returning id`,
      [entryId, orgId, job, code, hours, sort],
    );
    await c.query("select set_config('cn.legacy_fixture', '', true)");
    return r.id as string;
  };

  beforeAll(async () => {
    c = await connect();
    await c.query("begin");
    const fns = (
      await c.query(
        `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname in ('split_time_entry', 'carve_legacy_allocations')`,
      )
    ).rows.map((r) => r.proname);
    has0288 = fns.includes("split_time_entry");
    has0289 = fns.includes("carve_legacy_allocations");

    // An org with active staff and an active tech, and staff of some OTHER org. Without them the
    // boundary cannot be exercised, and that has to be loud (tests/ci-guard.test.ts), not a skip.
    const fx = await one(
      `select t.org_id, t.id as tech_id, s.id as staff_id
         from public.profiles t
         join public.profiles s on s.org_id = t.org_id and s.role in ('owner', 'admin', 'office') and coalesce(s.active, true)
        where t.role = 'tech' and coalesce(t.active, true)
        order by (s.role = 'owner') desc, t.id
        limit 1`,
    );
    if (!fx) throw new Error("split test fixture: no org has both an active tech and active office staff.");
    orgId = fx.org_id;
    techId = fx.tech_id;
    staffId = fx.staff_id;
    const other = await one(
      `select id from public.profiles
        where org_id is not null and org_id <> $1 and role in ('owner', 'admin', 'office') and coalesce(active, true)
        limit 1`,
      [orgId],
    );
    if (!other) throw new Error("split test fixture: no staff member in a second org, so the cross-org refusal cannot be tested.");
    otherStaffId = other.id;
    const idle = await one(
      `select p.id from public.profiles p
        where p.org_id = $1 and coalesce(p.active, true)
          and not exists (select 1 from public.time_entries x where x.profile_id = p.id and x.status = 'open')
        order by (p.role = 'tech') desc, p.id
        limit 1`,
      [orgId],
    );
    idleId = idle?.id ?? "";

    const job = async (n: string) =>
      (
        await one(
          `insert into public.jobs (org_id, name, job_number, status, billing_type)
           values ($1, $2, $3, 'scheduled', 'tm') returning id`,
          [orgId, `TEST split job ${n}`, `TEST-SPLIT-${n}`],
        )
      ).id;
    jobA = await job("A");
    jobB = await job("B");
    jobC = await job("C");
  });

  afterAll(async () => {
    await c?.query("rollback").catch(() => undefined);
    await c?.end();
  });

  // ── 0288: split / join / move ─────────────────────────────────────────────────────────────────
  describe("split, join and move (0288)", () => {
    it("a split cuts one closed shift into two touching entries, and join puts it back exactly", async () => {
      if (!needs("0288")) return;
      await step(async () => {
        // 08:00-14:00 Pacific (PST), 30 min lunch, 12 miles.
        const id = await entry({ in: "2001-01-01T16:00:00Z", out: "2001-01-01T22:00:00Z", lunch: 30, miles: 12 });
        const before = await workedS([id]);
        await as(staffId);
        const r = await rpc("split_time_entry", [id, "2001-01-01T19:00:00Z", jobB, null, "left", "right"]);
        await asServer();
        expect(r.left_id).toBe(id);
        const left = await row(id);
        const right = await row(r.right_id);
        expect(iso(left.clock_out)).toBe("2001-01-01T19:00:00.000Z");
        expect(num(left.lunch_minutes)).toBe(30);
        expect(num(left.miles)).toBe(0);
        expect(left.job_id).toBe(jobA);
        expect(iso(right.clock_in)).toBe("2001-01-01T19:00:00.000Z");
        expect(iso(right.clock_out)).toBe("2001-01-01T22:00:00.000Z");
        expect(right.job_id).toBe(jobB);
        expect(num(right.lunch_minutes)).toBe(0);
        expect(num(right.miles)).toBe(12); // whole, never divided
        expect(right.split_from).toBe(id);
        expect(right.split_how).toBe("after");
        expect(right.source).toBe("manual"); // inherited after the fact
        expect(right.profile_id).toBe(techId);
        expect(await workedS([id, r.right_id])).toBe(before);
        expect(num(r.left_hours)).toBe(2.5);
        expect(num(r.right_hours)).toBe(3);

        await as(staffId);
        const j = await rpc("join_time_entries", [id, r.right_id]);
        await asServer();
        expect(j.kept_id).toBe(id);
        const back = await row(id);
        expect(iso(back.clock_out)).toBe("2001-01-01T22:00:00.000Z");
        expect(num(back.lunch_minutes)).toBe(30);
        expect(num(back.miles)).toBe(12);
        expect(await row(r.right_id)).toBeUndefined();
        expect(await workedS([id])).toBe(before);
      });
    });

    it("a three-job day is two cuts, and every piece points at the first entry", async () => {
      if (!needs("0288")) return;
      await step(async () => {
        const id = await entry({ in: "2001-01-02T16:00:00Z", out: "2001-01-02T22:00:00Z" });
        await as(staffId);
        const first = await rpc("split_time_entry", [id, "2001-01-02T18:00:00Z", jobB, null, null, null]);
        const second = await rpc("split_time_entry", [first.right_id, "2001-01-02T20:00:00Z", jobC, null, null, null]);
        await asServer();
        expect((await row(second.right_id)).split_from).toBe(id);
        expect(await workedS([id, first.right_id, second.right_id])).toBe(6 * 3600);
      });
    });

    it("move slides the boundary and never reorders", async () => {
      if (!needs("0288")) return;
      await step(async () => {
        const id = await entry({ in: "2001-01-03T16:00:00Z", out: "2001-01-03T22:00:00Z", lunch: 30 });
        await as(staffId);
        const r = await rpc("split_time_entry", [id, "2001-01-03T19:00:00Z", jobB, null, "left", null]);
        const m = await rpc("move_time_entry_cut", [id, r.right_id, "2001-01-03T20:00:00Z"]);
        expect(m.moved).toBe(true);
        expect(num(m.left_hours)).toBe(3.5);
        expect(num(m.right_hours)).toBe(2);
        expect(m.billed).toEqual([]);
        const back = await rpc("move_time_entry_cut", [id, r.right_id, "2001-01-03T17:00:00Z"]);
        expect(num(back.left_hours)).toBe(0.5);
        // Past the end would reorder: refused.
        const past = await refusal(() => rpc("move_time_entry_cut", [id, r.right_id, "2001-01-03T22:30:00Z"]));
        expect(past?.message).toMatch(/Pick a time between/);
        // The first part's lunch would not fit in 20 minutes.
        const squeeze = await refusal(() => rpc("move_time_entry_cut", [id, r.right_id, "2001-01-03T16:20:00Z"]));
        expect(squeeze?.message).toMatch(/lunch would not fit/);
        await asServer();
        expect(iso((await row(id)).clock_out)).toBe("2001-01-03T17:00:00.000Z");
        expect(iso((await row(r.right_id)).clock_in)).toBe("2001-01-03T17:00:00.000Z");
        expect(await workedS([id, r.right_id])).toBe(5.5 * 3600);
      });
    });

    it("refuses, in plain words, every cut it cannot make honestly", async () => {
      if (!needs("0288")) return;
      await step(async () => {
        const closed = await entry({ in: "2001-01-04T16:00:00Z", out: "2001-01-04T22:00:00Z", lunch: 30 });
        const ghost = await entry({ in: "2001-01-04T23:00:00Z", out: "2001-01-04T23:00:00Z" });
        const open = idleId ? await entry({ profile: idleId, in: "2001-01-05T16:00:00Z", status: "open" }) : null;
        const legacy = await entry({ in: "2001-01-06T16:00:00Z", out: "2001-01-06T20:00:00Z" });
        await alloc(legacy, jobA, 2, 0);
        const split = (id: string, at: string, lunch: string | null = null) =>
          refusal(() => rpc("split_time_entry", [id, at, jobB, null, lunch, null]));

        await as(staffId);
        if (open) expect((await split(open, "2001-01-05T17:00:00Z"))?.message).toMatch(/still running\. Use Switch Job/);
        expect((await split(ghost, "2001-01-04T23:00:00Z"))?.message).toMatch(/has no length/);
        expect((await split(closed, "2001-01-04T23:30:00Z"))?.message).toMatch(/Pick a split time inside the shift/);
        expect((await split(closed, "2001-01-04T16:00:30Z", "right"))?.message).toMatch(/at least a minute/);
        expect((await split(closed, "2001-01-04T16:20:00Z", "left"))?.message).toMatch(/30-minute lunch does not fit in the first part/);
        expect((await split(legacy, "2001-01-06T18:00:00Z"))?.message).toMatch(/old-style split/);
        const noJob = await refusal(() => rpc("split_time_entry", [closed, "2001-01-04T19:00:00Z", null, " ", null, null]));
        expect(noJob?.message).toMatch(/Pick a job or a time code/);

        // A tech may not split after the fact (office only).
        await as(techId);
        expect((await split(closed, "2001-01-04T19:00:00Z"))?.message).toMatch(/Only the office/);
        const techJoin = await refusal(() => rpc("join_time_entries", [closed, ghost]));
        expect(techJoin?.message).toMatch(/Only the office/);
        const techMove = await refusal(() => rpc("move_time_entry_cut", [closed, ghost, "2001-01-04T19:00:00Z"]));
        expect(techMove?.message).toMatch(/Only the office/);
      });
    });

    it("a caller from another company is refused on all four doors", async () => {
      if (!needs("0288")) return;
      await step(async () => {
        const id = await entry({ in: "2001-01-07T16:00:00Z", out: "2001-01-07T22:00:00Z" });
        await as(staffId);
        const r = await rpc("split_time_entry", [id, "2001-01-07T19:00:00Z", jobB, null, null, null]);
        await asServer();
        const open = idleId ? await entry({ profile: idleId, in: "2001-01-08T16:00:00Z", status: "open" }) : null;

        await as(otherStaffId);
        expect((await refusal(() => rpc("split_time_entry", [id, "2001-01-07T18:00:00Z", null, "DRIVE", null, null])))?.message).toMatch(/not found/);
        expect((await refusal(() => rpc("join_time_entries", [id, r.right_id])))?.message).toMatch(/not found/);
        expect((await refusal(() => rpc("move_time_entry_cut", [id, r.right_id, "2001-01-07T20:00:00Z"])))?.message).toMatch(/not found/);
        if (open) expect((await refusal(() => rpc("switch_job", [open, jobB, null, null])))?.message).toMatch(/No open shift/);
        await asServer();
        expect(iso((await row(id)).clock_out)).toBe("2001-01-07T19:00:00.000Z");
        if (open) expect((await row(open)).status).toBe("open");
      });
    });

    it("the Jul 14 case: moving an hour of a shift a PAID invoice bills to another job is refused, naming the invoice", async () => {
      if (!needs("0288")) return;
      await step(async () => {
        // 10:30-16:30 Pacific with lunch, billed whole on a paid invoice.
        const id = await entry({ profile: staffId, in: "2001-01-09T18:30:00Z", out: "2001-01-10T00:30:00Z", lunch: 30 });
        const inv = await invoice("paid", jobA);
        const l = await line(inv.id, [id], 26);
        const before = await lineIds(l);
        await as(staffId);
        const r = await refusal(() => rpc("split_time_entry", [id, "2001-01-09T23:30:00Z", jobB, null, "left", null]));
        await asServer();
        expect(r?.message).toMatch(
          new RegExp(`^${inv.number} \\(paid\\) already bills this whole shift to TEST split job A\\. Moving 1 h to TEST split job B would bill it twice\\.$`),
        );
        expect(r?.detail).toBe(`invoice:${inv.id}`);
        expect(iso((await row(id)).clock_out)).toBe("2001-01-10T00:30:00.000Z");
        expect(await lineIds(l)).toEqual(before);
        // A draft refuses it too: take the shift off the draft first.
        const draft = await invoice("draft", jobA);
        const id2 = await entry({ in: "2001-01-11T16:00:00Z", out: "2001-01-11T22:00:00Z" });
        await line(draft.id, [id2]);
        await as(staffId);
        const r2 = await refusal(() => rpc("split_time_entry", [id2, "2001-01-11T19:00:00Z", null, "DRIVE", null, null]));
        expect(r2?.message).toMatch(new RegExp(`^${draft.number} \\(draft\\) already bills this whole shift`));
      });
    });

    it("a same-job piece carries the claim by an appended id, and join takes exactly that id back off", async () => {
      if (!needs("0288")) return;
      await step(async () => {
        const id = await entry({ in: "2001-01-12T16:00:00Z", out: "2001-01-12T22:00:00Z" });
        const inv = await invoice("paid", jobA);
        const l = await line(inv.id, [id], 6);
        const q0 = await one("select quantity, unit_price, description from public.invoice_items where id = $1", [l]);
        await as(staffId);
        const r = await rpc("split_time_entry", [id, "2001-01-12T19:00:00Z", jobA, "TRIM", null, null]);
        await asServer();
        expect(await lineIds(l)).toEqual([id, r.right_id]);
        expect(r.carried.map((x: any) => x.invoice_number)).toEqual([inv.number]);
        expect(await one("select quantity, unit_price, description from public.invoice_items where id = $1", [l])).toEqual(q0);

        // The two pieces now share one claim, so the Undo always works.
        await as(staffId);
        const j = await rpc("join_time_entries", [id, r.right_id]);
        await asServer();
        expect(j.released).toEqual([inv.number]);
        expect(await lineIds(l)).toEqual([id]);
        expect(await one("select quantity, unit_price, description from public.invoice_items where id = $1", [l])).toEqual(q0);
      });
    });

    it("join refuses pieces billed differently, paid differently, or not touching", async () => {
      if (!needs("0288")) return;
      await step(async () => {
        const a = await entry({ in: "2001-01-13T16:00:00Z", out: "2001-01-13T18:00:00Z" });
        const b = await entry({ in: "2001-01-13T18:00:00Z", out: "2001-01-13T20:00:00Z", job: jobB });
        const gap = await entry({ in: "2001-01-13T21:00:00Z", out: "2001-01-13T22:00:00Z" });
        const inv = await invoice("draft", jobA);
        await line(inv.id, [a]);
        await as(staffId);
        const billed = await refusal(() => rpc("join_time_entries", [a, b]));
        expect(billed?.message).toBe(`${inv.number} bills the first part and not the second, so joining them would make unbilled hours look billed.`);
        expect((await refusal(() => rpc("join_time_entries", [b, gap])))?.message).toMatch(/do not touch/);
        await asServer();
        const p1 = await entry({ in: "2001-01-14T16:00:00Z", out: "2001-01-14T18:00:00Z", paidAt: "2001-01-20T00:00:00Z" });
        const p2 = await entry({ in: "2001-01-14T18:00:00Z", out: "2001-01-14T20:00:00Z" });
        await as(staffId);
        expect((await refusal(() => rpc("join_time_entries", [p1, p2])))?.message).toMatch(/paid period/);
      });
    });

    it("a job change on an entry an invoice claims is a database refusal, for everyone; the job-delete cascade still passes", async () => {
      if (!needs("0288")) return;
      await step(async () => {
        const jobX = (
          await one(
            `insert into public.jobs (org_id, name, job_number, status, billing_type)
             values ($1, 'TEST split job X', 'TEST-SPLIT-X', 'scheduled', 'tm') returning id`,
            [orgId],
          )
        ).id;
        const id = await entry({ in: "2001-01-15T16:00:00Z", out: "2001-01-15T22:00:00Z", job: jobX });
        const free = await entry({ in: "2001-01-16T16:00:00Z", out: "2001-01-16T22:00:00Z" });
        const inv = await invoice("sent", jobA); // the claim is org-wide, on any job
        await line(inv.id, [id]);

        const direct = await refusal(() => c.query("update public.time_entries set job_id = $2 where id = $1", [id, jobB]));
        expect(direct?.message).toBe(`${inv.number} already bills this shift on TEST split job X`);
        await as(staffId);
        const asStaff = await refusal(() => c.query("update public.time_entries set job_id = null where id = $1", [id]));
        expect(asStaff?.message).toMatch(/already bills this shift/);
        // An unbilled shift moves freely, and re-saving the same job is not a move.
        await c.query("update public.time_entries set job_id = $2 where id = $1", [free, jobB]);
        await c.query("update public.time_entries set job_id = $2 where id = $1", [id, jobX]);
        await asServer();
        // Deleting the job nulls job_id through the FK: the hours are not moving anywhere.
        await c.query("delete from public.jobs where id = $1", [jobX]);
        expect((await row(id)).job_id).toBeNull();
      });
    });

    it("splitting a PAID shift does not move pay: same hours, same gross, same day, locks and rate copied", async () => {
      if (!needs("0288")) return;
      await step(async () => {
        const paidAt = "2001-01-25T00:00:00.000Z";
        // 08:00-15:30 Pacific, $40 override, paid.
        const id = await entry({ in: "2001-01-17T16:00:00Z", out: "2001-01-17T23:30:00Z", lunch: 30, rate: 40, paidAt });
        const pay = async (ids: string[]) =>
          aggregatePayrollEntries(
            (
              await c.query(
                `select t.profile_id, t.clock_in, t.clock_out, t.lunch_minutes, t.rate_override, t.paid_at,
                        t.mileage_paid_at, t.miles, json_build_object('full_name', 'T', 'hourly_rate', 30) as profiles
                   from public.time_entries t where t.id = any($1::uuid[])`,
                [ids],
              )
            ).rows.map((r) => ({ ...r, clock_in: iso(r.clock_in), clock_out: iso(r.clock_out) })),
          );
        // 20:00-02:00 Pacific, paid: its hours belong to Jan 18.
        const late = await entry({ in: "2001-01-19T04:00:00Z", out: "2001-01-19T10:00:00Z", rate: 40, paidAt });
        const before = await pay([id]);
        await as(staffId);
        const r = await rpc("split_time_entry", [id, "2001-01-17T19:15:00Z", jobB, null, null, null]);
        await asServer();
        const right = await row(r.right_id);
        expect(iso(right.paid_at)).toBe(paidAt);
        expect(num(right.rate_override)).toBe(40);
        const after = await pay([id, r.right_id]);
        expect(after[0].paidHours).toBe(before[0].paidHours);
        expect(after[0].paidGross).toBe(before[0].paidGross);
        expect(after[0].unpaidHours).toBe(0);
        await as(staffId);
        // Past midnight Pacific would move paid hours to another day.
        const off = await refusal(() => rpc("split_time_entry", [late, "2001-01-19T09:00:00Z", jobB, null, null, null]));
        expect(off?.message).toMatch(/already paid, so both parts have to stay on Jan 18/);
        // A cut on an odd second is fine when the pieces still round back to the paid 6.00 h...
        expect(await refusal(() => rpc("split_time_entry", [late, "2001-01-19T05:00:15Z", jobB, null, null, null]))).toBeNull();
        await asServer();
        // ...and refused when they would not: 3.5083 h paid as 3.51, cut into 1.00 + 2.50.
        const odd = await entry({ in: "2001-01-23T16:00:00Z", out: "2001-01-23T19:30:30Z", rate: 40, paidAt });
        await as(staffId);
        const cent = await refusal(() => rpc("split_time_entry", [odd, "2001-01-23T17:00:15Z", jobB, null, null, null]));
        expect(cent?.message).toMatch(/rounding cent/);
      });
    });

    it("an owner's piece never carries a pay rate", async () => {
      if (!needs("0288")) return;
      await step(async () => {
        const owner = await one("select id from public.profiles where org_id = $1 and role = 'owner' limit 1", [orgId]);
        if (!owner) return;
        const id = await entry({ profile: owner.id, in: "2001-01-20T16:00:00Z", out: "2001-01-20T22:00:00Z" });
        await as(staffId);
        const r = await rpc("split_time_entry", [id, "2001-01-20T19:00:00Z", jobB, null, null, null]);
        await asServer();
        expect((await row(r.right_id)).rate_override).toBeNull();
      });
    });

    it("Switch Job closes the running entry now and opens the next piece at the same instant", async () => {
      if (!needs("0288")) return;
      await step(async () => {
        // A tech with nothing on the clock and nothing recorded in the last half hour.
        const t = await one(
          `select p.id from public.profiles p
            where p.org_id = $1 and p.role = 'tech' and coalesce(p.active, true)
              and not exists (select 1 from public.time_entries x where x.profile_id = p.id
                               and (x.status = 'open' or coalesce(x.clock_out, now()) > now() - interval '30 minutes'))
            limit 1`,
          [orgId],
        );
        if (!t) {
          console.warn("[split-into-entries] every tech is on the clock right now; Switch Job was not exercised.");
          return;
        }
        const open = (
          await one(
            `insert into public.time_entries (org_id, profile_id, job_id, clock_in, status, source, notes)
             values ($1, $2, $3, now() - interval '10 minutes', 'open', 'app', 'running note') returning id`,
            [orgId, t.id, jobA],
          )
        ).id;
        await as(t.id);
        const r = await rpc("switch_job", [open, jobB, null, { lat: 39.8, lng: -120.1, accuracy: 10 }]);
        await asServer();
        expect(r.mode).toBe("cut");
        expect(r.closed_id).toBe(open);
        const closed = await row(open);
        const next = await row(r.entry_id);
        expect(closed.status).toBe("closed");
        expect(next.status).toBe("open");
        expect(iso(closed.clock_out)).toBe(iso(next.clock_in));
        expect(next.job_id).toBe(jobB);
        expect(next.split_from).toBe(open);
        expect(next.split_how).toBe("live");
        expect(next.source).toBe("app");
        expect((await one("select notes from public.time_entries where id = $1", [open])).notes).toBe("running note");

        // Under two minutes old: re-pointed, nothing cut. The same for a running entry with no job.
        await as(t.id);
        const again = await rpc("switch_job", [r.entry_id, jobC, null, null]);
        expect(again.mode).toBe("repointed");
        expect(again.entry_id).toBe(r.entry_id);
        const same = await refusal(() => rpc("switch_job", [r.entry_id, jobC, null, null]));
        expect(same?.message).toMatch(/already clocked into that job/);
        await asServer();
        expect((await row(r.entry_id)).job_id).toBe(jobC);
      });
    });

    it("a running entry with no job is re-pointed whole: that time bills to the job you switch to", async () => {
      if (!needs("0288")) return;
      await step(async () => {
        const t = await one(
          `select p.id from public.profiles p
            where p.org_id = $1 and p.role = 'tech' and coalesce(p.active, true)
              and not exists (select 1 from public.time_entries x where x.profile_id = p.id
                               and (x.status = 'open' or coalesce(x.clock_out, now()) > now() - interval '30 minutes'))
            limit 1`,
          [orgId],
        );
        if (!t) return;
        const open = (
          await one(
            `insert into public.time_entries (org_id, profile_id, job_id, clock_in, status, source)
             values ($1, $2, null, now() - interval '20 minutes', 'open', 'app') returning id`,
            [orgId, t.id],
          )
        ).id;
        await as(t.id);
        const r = await rpc("switch_job", [open, jobA, null, null]);
        await asServer();
        expect(r.mode).toBe("repointed");
        expect((await row(open)).job_id).toBe(jobA);
        expect((await row(open)).status).toBe("open");
      });
    });

    it("the old table's ceiling now binds the server and staff on INSERT too (the Jul 14 extra row)", async () => {
      if (!needs("0288")) return;
      await step(async () => {
        const id = await entry({ in: "2001-01-21T18:30:00Z", out: "2001-01-22T00:30:00Z", lunch: 30 });
        await alloc(id, jobA, 4.5, 0);
        await alloc(id, jobA, 1, 1); // 5.5 h: the whole shift
        const extra = await refusal(() => alloc(id, jobB, 1, 2));
        expect(extra?.message).toMatch(/more hours than the shift worked/);
      });
    });
  });

  // ── 0289: the carve ───────────────────────────────────────────────────────────────────────────
  describe("the carve (0289)", () => {
    it("carves the three ET shapes with every proof, and a dry run changes nothing", async () => {
      if (!needs("0289")) return;
      await step(async () => {
        // E1, Jul 14's shape: 10:30-16:30 Pacific, lunch, 4.5 h on A (billed with the shift on a PAID
        // invoice) + 1 h on B (on a draft). Erik: B was the LAST hour.
        const e1 = await entry({ profile: staffId, in: "2001-02-01T18:30:00Z", out: "2001-02-02T00:30:00Z", lunch: 30 });
        const a1 = await alloc(e1, jobA, 4.5, 1);
        const a2 = await alloc(e1, jobB, 1, 0); // recorded first, worked last: p_order decides
        // E2, Jul 31's shape: on B, 3.8 h on C first (paid invoice) then 3.0 h on B (draft).
        const e2 = await entry({ profile: staffId, job: jobB, in: "2001-02-03T17:14:00Z", out: "2001-02-04T00:32:00Z", lunch: 30 });
        const a3 = await alloc(e2, jobC, 3.8, 0);
        const a4 = await alloc(e2, jobB, 3, 1);
        // E3, Aug 5's shape: an unlabeled row and a same-job row, both on the draft: they merge back.
        const e3 = await entry({ profile: staffId, job: jobB, in: "2001-02-05T22:00:00Z", out: "2001-02-06T01:30:32.917Z" });
        const a5 = await alloc(e3, null, 1.28, 0);
        const a6 = await alloc(e3, jobB, 2.23, 1);

        const paidA = await invoice("paid", jobA);
        const paidLine = await line(paidA.id, [e1, a1], 26);
        const paidC = await invoice("paid", jobC);
        const paidCLine = await line(paidC.id, [a3]);
        const draftB = await invoice("draft", jobB);
        const draftLine = await line(draftB.id, [a2, a4, a5, a6], 50.5);
        const paidBefore = [await lineIds(paidLine), await lineIds(paidCLine)];
        const order = { [e1]: [a1, a2] };

        const dry = await one("select public.carve_legacy_allocations(true, $1::uuid[], $2::jsonb) as r", [[e1, e2, e3], JSON.stringify(order)]);
        expect(dry.r.dry).toBe(true);
        expect(dry.r.entries).toBe(3);
        expect(iso((await row(e1)).clock_out)).toBe("2001-02-02T00:30:00.000Z");
        expect(num((await one("select count(*) as n from public.time_allocations where time_entry_id = any($1::uuid[])", [[e1, e2, e3]])).n)).toBe(6);

        const real = await one("select public.carve_legacy_allocations(false, $1::uuid[], $2::jsonb) as r", [[e1, e2, e3], JSON.stringify(order)]);
        expect(real.r.dry).toBe(false);

        // E1: A 10:30-15:30 with the lunch (keeps the id), B 15:30-16:30 as the old row's id.
        const k1 = await row(e1);
        expect([iso(k1.clock_in), iso(k1.clock_out), num(k1.lunch_minutes), k1.job_id]).toEqual([
          "2001-02-01T18:30:00.000Z", "2001-02-01T23:30:00.000Z", 30, jobA,
        ]);
        const p2 = await row(a2);
        expect([iso(p2.clock_in), iso(p2.clock_out), p2.job_id, p2.split_from, p2.split_how]).toEqual([
          "2001-02-01T23:30:00.000Z", "2001-02-02T00:30:00.000Z", jobB, e1, "converted",
        ]);
        // E2: C first 10:14-14:02, then B (home) 14:02-17:32 with the lunch.
        const p3 = await row(a3);
        expect([iso(p3.clock_in), iso(p3.clock_out), p3.job_id]).toEqual(["2001-02-03T17:14:00.000Z", "2001-02-03T21:02:00.000Z", jobC]);
        const k2 = await row(e2);
        expect([iso(k2.clock_in), iso(k2.clock_out), num(k2.lunch_minutes)]).toEqual(["2001-02-03T21:02:00.000Z", "2001-02-04T00:32:00.000Z", 30]);
        // E3: one whole entry again, untouched.
        const k3 = await row(e3);
        expect([iso(k3.clock_in), iso(k3.clock_out), k3.job_id]).toEqual(["2001-02-05T22:00:00.000Z", "2001-02-06T01:30:32.917Z", jobB]);
        expect(await row(a4)).toBeUndefined();
        expect(await row(a5)).toBeUndefined();

        // Worked seconds per entry family are exactly what they were.
        expect(await workedS([e1, a2])).toBe(5.5 * 3600);
        expect(await workedS([e2, a3])).toBe(24480);
        expect(await workedS([e3])).toBe(12632.917);

        // Paid lines: byte-identical. The draft: + e2, + e3; the retired ids off; a2 stays (it IS an entry now).
        expect([await lineIds(paidLine), await lineIds(paidCLine)]).toEqual(paidBefore);
        expect(new Set(await lineIds(draftLine))).toEqual(new Set([a2, e2, e3]));
        expect(num((await one("select quantity from public.invoice_items where id = $1", [draftLine])).quantity)).toBe(50.5);

        // The old rows: archived with where their hours went, and gone from the live table.
        const arch = (await c.query("select id, became, carve_note from archive.time_allocations where time_entry_id = any($1::uuid[])", [[e1, e2, e3]])).rows;
        const note = Object.fromEntries(arch.map((x) => [x.id, [x.became, x.carve_note]]));
        expect(note[a1]).toEqual([e1, "home"]);
        expect(note[a2]).toEqual([a2, "piece"]);
        expect(note[a3]).toEqual([a3, "piece"]);
        expect(note[a4]).toEqual([e2, "home"]);
        expect(note[a5]).toEqual([e3, "home"]);
        expect(note[a6]).toEqual([e3, "home"]);
        expect(num((await one("select count(*) as n from public.time_allocations where time_entry_id = any($1::uuid[])", [[e1, e2, e3]])).n)).toBe(0);
      });
    });

    it("keeps a paid split paid exactly: lock, rate and day copied, gross unchanged", async () => {
      if (!needs("0289")) return;
      await step(async () => {
        const paidAt = "2001-02-20T00:00:00.000Z";
        const e = await entry({ in: "2001-02-07T20:30:00Z", out: "2001-02-08T00:00:00Z", rate: 40, paidAt });
        const home = await alloc(e, jobA, 1, 0);
        const other = await alloc(e, jobB, 2.5, 1);
        await one("select public.carve_legacy_allocations(false, $1::uuid[], null) as r", [[e]]);
        const p = await row(other);
        expect([iso(p.paid_at), num(p.rate_override)]).toEqual([paidAt, 40]);
        expect(iso((await row(e)).clock_out)).toBe("2001-02-07T21:30:00.000Z");
        expect(await workedS([e, other])).toBe(3.5 * 3600);
        expect(home).toBeTruthy();
      });
    });

    it("trims an unclaimed, unpaid over-split to the clock, last non-home piece first", async () => {
      if (!needs("0289")) return;
      await step(async () => {
        const e = await entry({ in: "2001-02-09T16:00:00Z", out: "2001-02-09T18:00:00Z" }); // 2 h
        await alloc(e, jobA, 1, 0);
        const b = await alloc(e, jobB, 0.5, 1);
        await c.query("update public.time_allocations set hours = 1.5 where id = $1", [b]); // 2.5 h of rows now
        const r = await one("select public.carve_legacy_allocations(false, $1::uuid[], null) as r", [[e]]);
        expect(r.r.trims).toHaveLength(1);
        expect(num(r.r.trims[0].trimmed_seconds)).toBe(1800);
        expect(iso((await row(e)).clock_out)).toBe("2001-02-09T17:00:00.000Z");
        expect(iso((await row(b)).clock_in)).toBe("2001-02-09T17:00:00.000Z");
        expect(await workedS([e, b])).toBe(2 * 3600);
      });
    });

    it("stops the whole run on a billed split that disagrees with its clock, and on an open one", async () => {
      if (!needs("0289")) return;
      await step(async () => {
        const e = await entry({ in: "2001-02-10T16:00:00Z", out: "2001-02-10T18:00:00Z" });
        await alloc(e, jobA, 1, 0);
        const b = await alloc(e, jobB, 0.5, 1);
        await c.query("update public.time_allocations set hours = 1.5 where id = $1", [b]);
        const inv = await invoice("draft", jobB);
        await line(inv.id, [b]);
        const r = await refusal(() => one("select public.carve_legacy_allocations(false, $1::uuid[], null)", [[e]]));
        expect(r?.message).toMatch(/worked 2\.0000 h but its split rows total 2\.5000 h, and it is billed/);
        expect(num((await one("select count(*) as n from public.time_allocations where time_entry_id = $1", [e])).n)).toBe(2);

        if (idleId) {
          const open = await entry({ profile: idleId, in: "2001-02-11T16:00:00Z", status: "open" });
          await alloc(open, jobA, 0.5, 0);
          const r2 = await refusal(() => one("select public.carve_legacy_allocations(false, $1::uuid[], null)", [[open]]));
          expect(r2?.message).toMatch(/still open/);
        }

        const wrongOrder = await refusal(() =>
          one("select public.carve_legacy_allocations(false, $1::uuid[], $2::jsonb)", [[e], JSON.stringify({ [e]: [e] })]),
        );
        expect(wrongOrder?.message).toMatch(/names a row that is not on that entry/);
      });
    });

    it("after 0289 the old table takes no rows from anyone but the fixture door, and replace_time_allocations says why", async () => {
      if (!needs("0289")) return;
      await step(async () => {
        const e = await entry({ in: "2001-02-12T16:00:00Z", out: "2001-02-12T18:00:00Z" });
        const frozen = await refusal(() =>
          c.query("insert into public.time_allocations (time_entry_id, org_id, job_id, hours) values ($1, $2, $3, 1)", [e, orgId, jobA]),
        );
        expect(frozen?.message).toMatch(/Splits are ordinary entries now/);
        await as(staffId);
        const viaRpc = await refusal(() => rpc("replace_time_allocations", [e, JSON.stringify([{ hours: 1 }])]));
        expect(viaRpc?.message).toMatch(/Splits are ordinary entries now/);
        // The fixture flag means nothing to a PostgREST caller.
        await c.query("select set_config('cn.legacy_fixture', 'on', true)");
        const staffInsert = await refusal(() =>
          c.query("insert into public.time_allocations (time_entry_id, org_id, job_id, hours) values ($1, $2, $3, 1)", [e, orgId, jobA]),
        );
        expect(staffInsert?.message).toMatch(/Splits are ordinary entries now/);
      });
    });

    it("the carve is not callable by any client role", async () => {
      if (!needs("0289")) return;
      const { rows } = await c.query(
        `select has_function_privilege('authenticated', p.oid, 'execute') as authed,
                has_function_privilege('anon', p.oid, 'execute') as anon,
                has_function_privilege('service_role', p.oid, 'execute') as service
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = 'carve_legacy_allocations'`,
      );
      expect(rows[0]).toEqual({ authed: false, anon: false, service: false });
    });
  });
}
