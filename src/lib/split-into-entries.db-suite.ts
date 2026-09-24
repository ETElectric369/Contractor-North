/**
 * THE SPLIT-INTO-ENTRIES DATABASE SUITE (migrations 0288 + 0290), written once and run against any
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
 * green lie, and the rest of the run still goes. That is also what keeps CI green in the minutes
 * between a push and the migration it needs being applied.
 *
 * 0289 (the one-time conversion of the old splits) had its own cases here: the carve, its proofs and
 * the freeze. 0290 dropped the old split table and the carve with it, so those cases went too, and
 * this file no longer names the table (tests/no-time-allocations.test.ts has no exemption now).
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
  let has0290 = false;
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
  const needs = (what: "0288" | "0290") => {
    const ok = what === "0288" ? has0288 : has0290;
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

  beforeAll(async () => {
    c = await connect();
    await c.query("begin");
    const fns = (
      await c.query(
        `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = 'split_time_entry'`,
      )
    ).rows.map((r) => r.proname);
    has0288 = fns.includes("split_time_entry");
    // 0290 dropped the old split table. The name is built so no source file spells it.
    const oldTable = ["time", "allocations"].join("_");
    has0290 = has0288 && (await one("select to_regclass($1) is null as gone", [`public.${oldTable}`])).gone === true;

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
        const split = (id: string, at: string, lunch: string | null = null) =>
          refusal(() => rpc("split_time_entry", [id, at, jobB, null, lunch, null]));

        await as(staffId);
        if (open) expect((await split(open, "2001-01-05T17:00:00Z"))?.message).toMatch(/still running\. Use Switch Job/);
        expect((await split(ghost, "2001-01-04T23:00:00Z"))?.message).toMatch(/has no length/);
        expect((await split(closed, "2001-01-04T23:30:00Z"))?.message).toMatch(/Pick a split time inside the shift/);
        expect((await split(closed, "2001-01-04T16:00:30Z", "right"))?.message).toMatch(/at least a minute/);
        expect((await split(closed, "2001-01-04T16:20:00Z", "left"))?.message).toMatch(/30-minute lunch does not fit in the first part/);
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

    it("join refuses pieces billed differently, paid differently, not touching, or not from one shift", async () => {
      if (!needs("0288")) return;
      await step(async () => {
        // Two pieces of one shift, the first billed on a draft after the cut.
        const a = await entry({ in: "2001-01-13T16:00:00Z", out: "2001-01-13T20:00:00Z" });
        await as(staffId);
        const b = (await rpc("split_time_entry", [a, "2001-01-13T18:00:00Z", jobB, null, null, null])).right_id;
        await asServer();
        const gap = await entry({ in: "2001-01-13T21:00:00Z", out: "2001-01-13T22:00:00Z" });
        const inv = await invoice("draft", jobA);
        await line(inv.id, [a]);
        await as(staffId);
        const billed = await refusal(() => rpc("join_time_entries", [a, b]));
        expect(billed?.message).toBe(`${inv.number} bills the first part and not the second, so joining them would make unbilled hours look billed.`);
        expect((await refusal(() => rpc("join_time_entries", [b, gap])))?.message).toMatch(/do not touch/);
        await asServer();
        const p1 = await entry({ in: "2001-01-14T16:00:00Z", out: "2001-01-14T20:00:00Z" });
        await as(staffId);
        const p2 = (await rpc("split_time_entry", [p1, "2001-01-14T18:00:00Z", jobB, null, null, null])).right_id;
        await asServer();
        await c.query("update public.time_entries set paid_at = '2001-01-20T00:00:00Z' where id = $1", [p1]);
        await as(staffId);
        expect((await refusal(() => rpc("join_time_entries", [p1, p2])))?.message).toMatch(/paid period/);
        await asServer();

        // Two ordinary entries that merely touch are not one shift: a join would take an original
        // source id off a paid line that billed the second in its own right.
        const o1 = await entry({ in: "2001-01-24T16:00:00Z", out: "2001-01-24T18:00:00Z" });
        const o2 = await entry({ in: "2001-01-24T18:00:00Z", out: "2001-01-24T20:00:00Z" });
        const paid = await invoice("paid", jobA);
        const both = await line(paid.id, [o1, o2], 4);
        await as(staffId);
        const strangers = await refusal(() => rpc("join_time_entries", [o1, o2]));
        await asServer();
        expect(strangers?.message).toBe("Those two entries were not split from one shift, so they cannot be joined. Edit their times instead.");
        expect(await lineIds(both)).toEqual([o1, o2]);
        expect(await row(o2)).toBeDefined();
      });
    });

    it("move refuses to hand billed hours to a part billed differently, and still moves between parts billed together", async () => {
      if (!needs("0288")) return;
      await step(async () => {
        // A cross-job split, then the first part billed on a PAID invoice: sliding the cut earlier
        // would move an hour INV paid for onto the unbilled part on job B, and the importer would
        // bill it again.
        const id = await entry({ in: "2001-01-26T16:00:00Z", out: "2001-01-26T22:00:00Z" });
        await as(staffId);
        const r = await rpc("split_time_entry", [id, "2001-01-26T19:00:00Z", jobB, null, null, null]);
        await asServer();
        const inv = await invoice("paid", jobA);
        const l = await line(inv.id, [id], 3);
        await as(staffId);
        const out = await refusal(() => rpc("move_time_entry_cut", [id, r.right_id, "2001-01-26T18:00:00Z"]));
        // The other way too: the unbilled part may not swallow billed time either.
        const back = await refusal(() => rpc("move_time_entry_cut", [id, r.right_id, "2001-01-26T20:00:00Z"]));
        await asServer();
        expect(out?.message).toBe(
          `${inv.number} (paid) bills the first part and not the second, so moving the split would hand billed hours to a part that could be billed again.`,
        );
        expect(out?.detail).toBe(`invoice:${inv.id}`);
        expect(back?.message).toMatch(/bills the first part and not the second/);
        expect(iso((await row(id)).clock_out)).toBe("2001-01-26T19:00:00.000Z");
        expect(iso((await row(r.right_id)).clock_in)).toBe("2001-01-26T19:00:00.000Z");
        expect(await lineIds(l)).toEqual([id]);

        // A same-job split shares one claim: the typo fix still moves, and names the invoice.
        const id2 = await entry({ in: "2001-01-27T16:00:00Z", out: "2001-01-27T22:00:00Z" });
        const inv2 = await invoice("sent", jobA);
        await line(inv2.id, [id2], 6);
        await as(staffId);
        const r2 = await rpc("split_time_entry", [id2, "2001-01-27T19:00:00Z", jobA, "TRIM", null, null]);
        const m = await rpc("move_time_entry_cut", [id2, r2.right_id, "2001-01-27T20:00:00Z"]);
        await asServer();
        expect(m.moved).toBe(true);
        expect(m.billed.map((b: any) => b.invoice_number)).toEqual([inv2.number, inv2.number]);
        expect(await workedS([id2, r2.right_id])).toBe(6 * 3600);
      });
    });

    it("a same-job split of a shift held by a void line and a live line carries the claim onto both", async () => {
      if (!needs("0288")) return;
      await step(async () => {
        // Void-and-rebill leaves exactly this: the old void invoice and the live one both hold the shift.
        const id = await entry({ in: "2001-01-29T16:00:00Z", out: "2001-01-29T22:00:00Z" });
        const dead = await invoice("void", jobA);
        const deadLine = await line(dead.id, [id], 6);
        const live = await invoice("sent", jobA);
        const liveLine = await line(live.id, [id], 6);
        await as(staffId);
        const r = await rpc("split_time_entry", [id, "2001-01-29T19:00:00Z", jobA, null, null, null]);
        await asServer();
        expect(await lineIds(deadLine)).toEqual([id, r.right_id]);
        expect(await lineIds(liveLine)).toEqual([id, r.right_id]);
        expect(r.carried.map((x: any) => x.status).sort()).toEqual(["sent", "void"]);
      });
    });

    it("a forgotten-punch shift over 18 hours keeps its reason on every piece still over 18 hours", async () => {
      if (!needs("0288")) return;
      await step(async () => {
        const id = await entry({ in: "2001-01-30T16:00:00Z", out: "2001-01-31T12:00:00Z", reason: "Forgot to clock out" });
        await as(staffId);
        const r = await rpc("split_time_entry", [id, "2001-01-31T11:00:00Z", jobB, null, null, null]);
        await asServer();
        expect((await row(id)).auto_closed_reason).toBe("Forgot to clock out");
        expect(await workedS([id, r.right_id])).toBe(20 * 3600);
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
        expect(cent?.message).toBe(
          "Cutting at 9:00am would change the paid hours on this shift by 0.01 h. Move the split a minute earlier or later.",
        );
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

    it("a lunch already on the running row moves to the new part when it does not fit the part before", async () => {
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
        // The office set "his lunch was 45" on the open row; he switches 10 minutes in.
        const open = (
          await one(
            `insert into public.time_entries (org_id, profile_id, job_id, clock_in, status, source, lunch_minutes)
             values ($1, $2, $3, now() - interval '10 minutes', 'open', 'app', 45) returning id`,
            [orgId, t.id, jobA],
          )
        ).id;
        await as(t.id);
        const r = await rpc("switch_job", [open, jobB, null, null]);
        await asServer();
        expect(r.mode).toBe("cut");
        expect(num(r.lunch_moved)).toBe(45);
        expect(num((await row(open)).lunch_minutes)).toBe(0);
        expect(num((await row(r.entry_id)).lunch_minutes)).toBe(45);
        // The closed part worked its whole 10 minutes, not less than nothing.
        expect(num(r.closed_hours)).toBeGreaterThan(0.1);
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
  });

  // ── 0290: the old table is gone ───────────────────────────────────────────────────────────────
  describe("the old split table is gone (0290)", () => {
    it("the table and every function that served it are gone, and the archive stays", async () => {
      if (!needs("0290")) return;
      const oldTable = ["time", "allocations"].join("_");
      const naming = (
        await c.query(
          `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.prosrc ilike '%' || $1 || '%'`,
          [oldTable],
        )
      ).rows.map((r) => r.proname);
      expect(naming).toEqual([]);
      const served = (
        await c.query(
          `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public'
              and p.proname ilike '%alloc%'`,
        )
      ).rows.map((r) => r.proname);
      // guard_time_allocation, guard_billed_time_allocation, refuse_time_allocation_insert, the frozen
      // replace RPC and carve_legacy_allocations: nothing else in public was ever named for them.
      expect(served).toEqual([]);
      expect((await one("select to_regclass($1) is not null as kept", [`archive.${oldTable}`])).kept).toBe(true);
    });

    // The three functions 0290 rewrote (guard_billed_time_entry, guard_invoice_item_claim,
    // split_time_entry) must behave the same before and after it, so these run on both sides of it.
    it("a billed shift still cannot be deleted, and an unbilled one can", async () => {
      if (!needs("0288")) return;
      await step(async () => {
        const billed = await entry({ in: "2001-02-20T16:00:00Z", out: "2001-02-20T20:00:00Z" });
        const inv = await invoice("sent", jobA);
        await line(inv.id, [billed], 4);
        const r = await refusal(() => c.query("delete from public.time_entries where id = $1", [billed]));
        expect(r?.message).toBe(`${inv.number} already bills this shift`);
        expect(await row(billed)).toBeTruthy();

        const free = await entry({ in: "2001-02-21T16:00:00Z", out: "2001-02-21T20:00:00Z" });
        expect(await refusal(() => c.query("delete from public.time_entries where id = $1", [free]))).toBeNull();
      });
    });

    it("a shift billed on one invoice is refused on a second, and the refusal still calls it hours", async () => {
      if (!needs("0288")) return;
      await step(async () => {
        const id = await entry({ in: "2001-02-22T16:00:00Z", out: "2001-02-22T20:00:00Z" });
        const first = await invoice("sent", jobA);
        await line(first.id, [id], 4);
        const second = await invoice("draft", jobA);
        const r = await refusal(() => line(second.id, [id], 4));
        expect(r?.message).toBe(`hours already billed on ${first.number}`);
      });
    });

    it("split_time_entry cuts a shift with or without the old table", async () => {
      if (!needs("0288")) return;
      await step(async () => {
        const id = await entry({ in: "2001-02-23T16:00:00Z", out: "2001-02-23T20:00:00Z" });
        await as(staffId);
        const r = await rpc("split_time_entry", [id, "2001-02-23T18:00:00Z", jobB, null, null, null]);
        await asServer();
        expect(r.right_id).toBeTruthy();
        expect(await workedS([id, r.right_id])).toBe(4 * 3600);
      });
    });
  });
}
