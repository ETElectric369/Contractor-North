import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * THE ERROR SINK TRIAGES ITSELF (0399, cn-v1136), read from the migration file the way
 * migration-0397.test.ts reads 0397: the two columns, the writer that counts a repeat without
 * rewriting the first sighting, the one-way status rule, the level that is never lowered, the
 * platform-only marker and broom with their revokes, the one read policy, and that it leaves
 * 0001–0398 alone (applied migrations are immutable; the DB proof is
 * src/lib/error-sink.integration.test.ts against the test database).
 */
const migrations = join(process.cwd(), "supabase/migrations");
const migration = (prefix: string) => {
  const f = readdirSync(migrations).find((n) => n.startsWith(prefix));
  if (!f) throw new Error(`no migration ${prefix}`);
  return readFileSync(join(migrations, f), "utf8");
};

/** The three functions 0399 may define, and no other. */
const ALLOWED_FUNCTIONS = ["record_app_error", "platform_set_error_status", "sweep_error_events"] as const;

/** platform_set_error_status's refusals, as the SQL spells them (an escaped apostrophe). */
const REFUSALS = {
  notAdmin: "Only North''s own team can mark an error.",
  badStatus: "That isn''t an error status.",
} as const;

describe("migration 0399: the error sink triages itself", () => {
  const sql = migration("0399_");
  const SIX = "public.record_app_error(text, text, text, text, jsonb, uuid)";
  const FIVE = "public.record_app_error(text, text, text, text, jsonb)";

  it("exists, names itself, and runs under the house timeouts", () => {
    expect(sql).toContain("migration 0399: the error sink triages itself");
    expect(sql).toContain("set local lock_timeout = '3s';");
    expect(sql).toContain("set local statement_timeout = '15s';");
    expect(sql).toMatch(/raise notice '0399: the error sink triages itself/);
  });

  it("adds org_id and last_payload, twice-safe, and the two indexes", () => {
    expect(sql).toContain(
      "alter table public.error_events add column if not exists org_id uuid references public.organizations(id) on delete set null;",
    );
    expect(sql).toContain("alter table public.error_events add column if not exists last_payload jsonb;");
    // last_seen alone (skeptic #42, N6): the predicate already pins status, so a leading status column was dead weight.
    expect(sql).toContain(
      "create index if not exists error_events_new_idx on public.error_events (last_seen desc) where status = 'new';",
    );
    expect(sql).not.toMatch(/error_events_new_idx on public\.error_events \(status/);
    expect(sql).toContain("and indexdef like '%(last_seen DESC) WHERE (status = ''new''::text)'");
    expect(sql).toContain(
      "create index if not exists error_events_org_idx on public.error_events (org_id, last_seen desc) where org_id is not null;",
    );
  });

  it("drops the five-argument writer BEFORE creating the six-argument one (p_org defaulted)", () => {
    const drop = sql.indexOf("drop function if exists public.record_app_error(text, text, text, text, jsonb);");
    const create = sql.indexOf("create or replace function public.record_app_error(");
    expect(drop).toBeGreaterThan(-1);
    expect(create).toBeGreaterThan(drop);
    expect(sql).toMatch(/p_key text, p_title text, p_where text, p_level text, p_payload jsonb, p_org uuid default null\s*\) returns jsonb/);
    // One function, not two: the self-check refuses a database where the five-argument one survives.
    expect(sql).toContain(`if to_regprocedure('${FIVE}') is not null then`);
    expect(sql).toContain(`if to_regprocedure('${SIX}') is null then`);
  });

  describe("the upsert", () => {
    const setList = sql.slice(sql.indexOf("do update set"), sql.indexOf("returning id, event_count, level, status, (xmax = 0)"));

    it("is read from the file (the slice is the DO UPDATE set-list)", () => {
      expect(setList.length).toBeGreaterThan(100);
      expect(setList).toContain("event_count  = public.error_events.event_count + 1");
      expect(setList).toContain("last_seen    = now()");
    });

    it("keeps the first sighting: payload is never assigned, last_payload takes the repeat", () => {
      expect(setList).toContain("last_payload = excluded.payload");
      expect(setList).not.toMatch(/(^|[^_])payload\s*=/);
      // And neither title nor culprit is rewritten any more (0146 replaced both).
      expect(setList).not.toMatch(/\btitle\s*=|\bculprit\s*=/);
    });

    it("keeps the company once known", () => {
      expect(setList).toContain("org_id       = coalesce(public.error_events.org_id, excluded.org_id)");
    });

    it("never lowers the level: only 'blocker' promotes", () => {
      expect(setList).toContain("level        = case when excluded.level = 'blocker' then 'blocker' else public.error_events.level end");
    });

    it("moves status one way: a fixed error that returns is new; new, triaged and ignored stay", () => {
      expect(setList).toContain("status       = case when public.error_events.status = 'fixed' then 'new' else public.error_events.status end");
      expect(setList).not.toMatch(/status\s*=\s*'new'/);
    });

    it("answers what happened: id, inserted, reopened, escalated, event_count, level, status", () => {
      for (const k of ["'id'", "'inserted'", "'reopened'", "'escalated'", "'event_count'", "'level'", "'status'"]) expect(sql).toContain(`${k},`);
      expect(sql).toContain("coalesce(not v_inserted and v_prev = 'fixed' and v_status = 'new', false)");
      // ESCALATED (skeptic #42, S2): an existing row that was not a blocker and now is — the first time it
      // pages. v_prev_level is NOT NULL on purpose: the loser of a concurrent first insert read no row and
      // must not page a second time for the winner's first sighting.
      expect(sql).toContain("coalesce(not v_inserted and v_prev_level is not null and v_prev_level <> 'blocker' and v_now = 'blocker', false)");
      expect(sql).toContain("v_prev_level text;");
      // An unknown level lands as 'error'; 'trace' and 'blocker' are the other two words.
      expect(sql).toContain("case when p_level in ('error', 'blocker', 'trace') then p_level else 'error' end");
      expect(sql).toContain("Answers {id, inserted, reopened, escalated, event_count, level, status}.");
    });

    it("locks the row it reads before the upsert (S3): the status and the level, FOR UPDATE, so two concurrent sightings answer once", () => {
      expect(sql).toContain("select e.status, e.level into v_prev, v_prev_level from public.error_events e where e.issue_id = p_key for update;");
      expect(sql).not.toMatch(/select e\.status into v_prev from public\.error_events e where e\.issue_id = p_key;/);
      // The self-check proves both on the database's own copy of the function, not only in the file.
      expect(sql).toContain("position('escalated' in pg_get_functiondef(");
      expect(sql).toContain("position('for update' in pg_get_functiondef(");
    });

    it("resolves p_org against organizations (S5): an unknown company lands as null, never a broken foreign key and a lost row", () => {
      expect(sql).toContain("(select o.id from public.organizations o where o.id = p_org), 1, 'new')");
      expect(sql).not.toMatch(/p_payload, p_org, 1, 'new'/);
    });
  });

  it("re-levels the rows as they stand: resolved → fixed, Nort's traces → trace, null → error", () => {
    expect(sql).toContain("update public.error_events set status = 'fixed' where status = 'resolved';");
    expect(sql).toContain(
      "update public.error_events set level = 'trace' where level = 'error' and culprit = 'client:nort-voice' and title like 'trace turn%';",
    );
    expect(sql).toContain("update public.error_events set level = 'error' where level is null;");
  });

  it("the marker: platform admins only, the four statuses, status column only, refused in plain words", () => {
    const fn = sql.slice(sql.indexOf("create or replace function public.platform_set_error_status"), sql.indexOf("comment on function public.platform_set_error_status"));
    expect(fn).toContain("if not public.is_platform_admin() then");
    expect(fn).toContain(`raise exception '${REFUSALS.notAdmin}' using errcode = '42501';`);
    expect(fn).toContain("p_status not in ('new', 'triaged', 'fixed', 'ignored')");
    expect(fn).toContain(`raise exception '${REFUSALS.badStatus}' using errcode = '22023';`);
    expect(fn).toContain("update public.error_events set status = p_status where id = p_id;");
    expect(fn).toContain("return v_n = 1;");
    for (const words of Object.values(REFUSALS)) {
      expect(words).toMatch(/^(Only |That )/);
      expect(words).not.toMatch(/_|0\d{3}/);
    }
  });

  it("the broom: closed rows after ninety days, traces after fourteen, never an open error", () => {
    const fn = sql.slice(sql.indexOf("create or replace function public.sweep_error_events"), sql.indexOf("comment on function public.sweep_error_events"));
    expect(fn).toContain("delete from public.error_events where status in ('fixed', 'ignored') and last_seen < now() - interval '90 days';");
    expect(fn).toContain("delete from public.error_events where level = 'trace' and last_seen < now() - interval '14 days';");
    expect((fn.match(/delete from/g) ?? []).length).toBe(2);
    expect(fn).not.toMatch(/'new'|'triaged'/);
    expect(fn).toContain("jsonb_build_object('closed_deleted', v_closed, 'trace_deleted', v_trace)");
  });

  it("one read policy for North's own team; writes stay the RPCs'", () => {
    expect(sql).toContain("drop policy if exists error_events_platform_read on public.error_events;");
    expect(sql).toContain(
      "create policy error_events_platform_read on public.error_events for select to authenticated using (public.is_platform_admin());",
    );
    expect((sql.match(/create policy/g) ?? []).length).toBe(1);
    expect(sql).toContain("alter table public.error_events enable row level security;");
  });

  it("every SECURITY DEFINER function carries its revoke (0182's law) and its grant", () => {
    expect(sql).toContain(`revoke execute on function ${SIX} from public, anon, authenticated;`);
    expect(sql).toContain(`grant execute on function ${SIX} to service_role;`);
    expect(sql).toContain("revoke execute on function public.platform_set_error_status(uuid, text) from public, anon;");
    expect(sql).toContain("grant execute on function public.platform_set_error_status(uuid, text) to authenticated;");
    expect(sql).toContain("revoke execute on function public.sweep_error_events() from public, anon, authenticated;");
    expect(sql).toContain("grant execute on function public.sweep_error_events() to service_role;");
    // Three function headers say it (the self-check's own words name it a fourth time, in prose).
    expect((sql.match(/^security definer$/gm) ?? []).length).toBe(3);
    expect((sql.match(/^set search_path = public$/gm) ?? []).length).toBe(3);
    // The self-check proves the grants on the database, not only in the file.
    expect(sql).toContain("has_function_privilege('anon', v_fn, 'execute')");
    expect(sql).toContain("if not has_function_privilege('authenticated', 'public.platform_set_error_status(uuid, text)', 'execute') then");
  });

  it("leaves 0001–0398 alone: no trigger dropped, no other function defined or dropped", () => {
    expect(sql).not.toMatch(/drop trigger/i);
    expect(sql).not.toMatch(/create trigger/i);
    const defined = [...sql.matchAll(/create or replace function public\.(\w+)/g)].map((m) => m[1]);
    expect(defined.sort()).toEqual([...ALLOWED_FUNCTIONS].sort());
    const dropped = [...sql.matchAll(/drop function (?:if exists )?public\.(\w+)/g)].map((m) => m[1]);
    expect(dropped).toEqual(["record_app_error"]);
    expect(sql).not.toMatch(/drop table|alter table public\.(?!error_events\b)/i);
    expect(sql).not.toMatch(/drop index/i);
  });
});
