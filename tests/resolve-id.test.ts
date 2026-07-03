import { describe, it, expect } from "vitest";
import {
  resolveEntityId,
  resolveCustomerId,
  resolveJobId,
  isUuid,
  looksLikePlaceholder,
  type ResolverClient,
} from "@/lib/actions/resolve-id";

/**
 * resolve-id is the fragment-first SAFETY NET behind Nort's "ids are uuids" prompt rule —
 * the fix for the 'invalid uuid: John Chmura / {{APACHE_JOB_ID}} / c1a-first-rob' error class.
 * These pin the four load-bearing branches: a uuid passes through untouched, a single name
 * resolves, an ambiguous name ASKS (never guesses — a wrong customer on a quote is a real
 * money-adjacent error), and a fabricated placeholder is refused before any DB round-trip.
 *
 * The resolver takes the supabase client as an argument specifically so it can be tested in
 * plain Node with a fake — no DB, no Next runtime. The fake records the `.or()` filter it was
 * handed and returns a preset row set (or error), matching the real PostgREST query shape.
 */

/** Build a fake ResolverClient that always returns `rows` (or `error`) and captures the last
 *  `or()` filter string so a test can assert HOW the name was matched. */
function fakeClient(
  result: { rows?: { id: string }[]; error?: { message: string } },
): { client: ResolverClient; calls: { table: string; orFilter: string }[] } {
  const calls: { table: string; orFilter: string }[] = [];
  const client: ResolverClient = {
    from(table: string) {
      return {
        select(_cols: string) {
          return {
            or(orFilter: string) {
              calls.push({ table, orFilter });
              return {
                limit(_n: number) {
                  return Promise.resolve({ data: result.rows ?? null, error: result.error ?? null });
                },
              };
            },
          };
        },
      };
    },
  };
  return { client, calls };
}

/** A fake whose EXACT pass returns nothing but whose CONTAINS pass (2nd call) returns rows —
 *  lets a test exercise the exact→contains fallthrough. */
function fakeExactThenContains(exactRows: { id: string }[], containsRows: { id: string }[]): ResolverClient {
  let call = 0;
  return {
    from(_table: string) {
      return {
        select(_cols: string) {
          return {
            or(_orFilter: string) {
              return {
                limit(_n: number) {
                  const rows = call === 0 ? exactRows : containsRows;
                  call += 1;
                  return Promise.resolve({ data: rows, error: null });
                },
              };
            },
          };
        },
      };
    },
  };
}

const A_UUID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

describe("isUuid / looksLikePlaceholder — the classifiers", () => {
  it("recognizes a real v4 uuid and rejects names/slugs", () => {
    expect(isUuid(A_UUID)).toBe(true);
    expect(isUuid(`  ${A_UUID}  `)).toBe(true); // trims
    expect(isUuid("John Chmura")).toBe(false);
    expect(isUuid("c1a-first-rob")).toBe(false);
  });

  it("flags template tokens as placeholders, not ordinary names", () => {
    expect(looksLikePlaceholder("{{APACHE_JOB_ID}}")).toBe(true);
    expect(looksLikePlaceholder("<job_id>")).toBe(true);
    expect(looksLikePlaceholder("[CUSTOMER_ID]")).toBe(true);
    expect(looksLikePlaceholder("APACHE_JOB_ID")).toBe(true); // bare ALL_CAPS snake token
    // A real spoken name — including a single all-caps word — is NOT a placeholder.
    expect(looksLikePlaceholder("Miller")).toBe(false);
    expect(looksLikePlaceholder("John Chmura")).toBe(false);
    expect(looksLikePlaceholder("ACME")).toBe(false);
  });
});

describe("resolveEntityId — the four branches", () => {
  it("passes a uuid straight through, UNCHANGED, with no DB call", async () => {
    const { client, calls } = fakeClient({ rows: [] });
    const r = await resolveEntityId(client, "customers", A_UUID, { thing: "customer" });
    expect(r).toEqual({ id: A_UUID });
    expect(calls).toHaveLength(0); // fast-path never queried
  });

  it("returns { id: null } for null / empty / whitespace (caller decides if required)", async () => {
    const { client } = fakeClient({ rows: [] });
    expect(await resolveEntityId(client, "jobs", null)).toEqual({ id: null });
    expect(await resolveEntityId(client, "jobs", undefined)).toEqual({ id: null });
    expect(await resolveEntityId(client, "jobs", "   ")).toEqual({ id: null });
  });

  it("resolves a name to its id on a SINGLE match", async () => {
    const { client } = fakeClient({ rows: [{ id: A_UUID }] });
    const r = await resolveJobId(client, "Miller deck");
    expect(r).toEqual({ id: A_UUID });
  });

  it("ASKS on TWO+ matches — never picks one (money-adjacent)", async () => {
    const { client } = fakeClient({ rows: [{ id: A_UUID }, { id: "another-id" }] });
    const r = await resolveCustomerId(client, "Miller");
    expect("error" in r && r.error).toMatch(/Several customers match "Miller"/);
    expect("id" in r).toBe(false);
  });

  it("ASKS on ZERO matches with a spelled-right/create nudge", async () => {
    const { client } = fakeClient({ rows: [] });
    const r = await resolveCustomerId(client, "Nobody Here");
    expect("error" in r && r.error).toMatch(/No customer named "Nobody Here"/);
  });

  it("refuses a placeholder token BEFORE any DB round-trip", async () => {
    const { client, calls } = fakeClient({ rows: [{ id: A_UUID }] });
    const r = await resolveEntityId(client, "jobs", "{{APACHE_JOB_ID}}", { thing: "job" });
    expect("error" in r && r.error).toMatch(/placeholder, not a real job/);
    expect(calls).toHaveLength(0); // never queried — refused up front
  });

  it("falls through from an empty exact match to a contains hit", async () => {
    const client = fakeExactThenContains([], [{ id: A_UUID }]);
    const r = await resolveJobId(client, "deck");
    expect(r).toEqual({ id: A_UUID });
  });

  it("surfaces a lookup error instead of silently resolving null", async () => {
    const { client } = fakeClient({ error: { message: "boom" } });
    const r = await resolveCustomerId(client, "Miller");
    expect("error" in r && r.error).toMatch(/Couldn't look up that customer/);
  });

  it("asks rather than querying when the name is only .or()-breaking punctuation", async () => {
    // "(),:" sanitizes to empty — never build an empty/injectable filter; ask instead.
    const { client, calls } = fakeClient({ rows: [{ id: A_UUID }] });
    const r = await resolveCustomerId(client, "(),:");
    expect("error" in r && r.error).toMatch(/No customer named/);
    expect(calls).toHaveLength(0);
  });
});
