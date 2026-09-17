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

/** Build a fake ResolverClient that always returns `rows` (or `error`) and captures every query
 *  so a test can assert HOW the name was matched. `.or()` calls are the sanitized filter passes;
 *  `.ilike()` calls are the literal "as they said it" pass. */
function fakeClient(
  result: { rows?: { id: string }[]; error?: { message: string } },
): {
  client: ResolverClient;
  calls: { table: string; orFilter: string }[];
  literal: { table: string; column: string; pattern: string }[];
} {
  const calls: { table: string; orFilter: string }[] = [];
  const literal: { table: string; column: string; pattern: string }[] = [];
  const answer = () =>
    Promise.resolve({ data: result.rows ?? null, error: result.error ?? null });
  const client: ResolverClient = {
    from(table: string) {
      return {
        select(_cols: string) {
          return {
            or(orFilter: string) {
              calls.push({ table, orFilter });
              return { limit: (_n: number) => answer() };
            },
            ilike(column: string, pattern: string) {
              literal.push({ table, column, pattern });
              return { limit: (_n: number) => answer() };
            },
          };
        },
      };
    },
  };
  return { client, calls, literal };
}

/** A fake whose LITERAL (.ilike) pass returns `literalRows` and whose sanitized `.or()` passes
 *  return nothing — the shape of the "Joe's Plumbing" bug: the punctuated name is findable only
 *  when it is searched for as written. */
function fakeLiteralOnly(literalRows: { id: string }[]): {
  client: ResolverClient;
  literal: { column: string; pattern: string }[];
  orCalls: string[];
} {
  const literal: { column: string; pattern: string }[] = [];
  const orCalls: string[] = [];
  const client: ResolverClient = {
    from(_table: string) {
      return {
        select(_cols: string) {
          return {
            or(orFilter: string) {
              orCalls.push(orFilter);
              return { limit: (_n: number) => Promise.resolve({ data: [], error: null }) };
            },
            ilike(column: string, pattern: string) {
              literal.push({ column, pattern });
              return { limit: (_n: number) => Promise.resolve({ data: literalRows, error: null }) };
            },
          };
        },
      };
    },
  };
  return { client, literal, orCalls };
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
            // The literal pass only runs for a punctuated name; these fixtures use plain ones.
            ilike(_column: string, _pattern: string) {
              return { limit: (_n: number) => Promise.resolve({ data: [], error: null }) };
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
    // "(),:" sanitizes to empty — never build an empty/injectable filter; ask instead. Nothing is
    // named "(),:" either, so the literal pass isn't worth a round trip.
    const { client, calls, literal } = fakeClient({ rows: [{ id: A_UUID }] });
    const r = await resolveCustomerId(client, "(),:");
    expect("error" in r && r.error).toMatch(/No customer named/);
    expect(calls).toHaveLength(0);
    expect(literal).toHaveLength(0);
  });
});

describe("resolveEntityId — a punctuated name is matched AS IT WAS SAID (audit v947)", () => {
  it("finds \"Joe's Plumbing\" that the sanitized filter could never equal", async () => {
    // The bug: safeForOr turned the name into "Joe s Plumbing" BEFORE the equality check, so the
    // exact pass compared a string that matches nothing and the contains pass searched for the
    // same mangled text. Nort reported a real customer as not found.
    const { client, literal, orCalls } = fakeLiteralOnly([{ id: A_UUID }]);
    const r = await resolveCustomerId(client, "Joe's Plumbing");
    expect(r).toEqual({ id: A_UUID });
    // The apostrophe reaches the query intact, as a filter VALUE on a single column.
    expect(literal[0]).toEqual({ column: "name", pattern: "Joe's Plumbing" });
    // Decided before any or() filter was built.
    expect(orCalls).toHaveLength(0);
  });

  it("carries commas and periods through too (\"Smith & Sons, Inc.\")", async () => {
    const { client, literal } = fakeLiteralOnly([{ id: A_UUID }]);
    const r = await resolveCustomerId(client, "Smith & Sons, Inc.");
    expect(r).toEqual({ id: A_UUID });
    expect(literal[0].pattern).toBe("Smith & Sons, Inc.");
  });

  it("keeps % and _ literal instead of wildcarding them", async () => {
    const { client, literal } = fakeLiteralOnly([{ id: A_UUID }]);
    await resolveCustomerId(client, "10% Off, LLC");
    expect(literal[0].pattern).toBe("10\\% Off, LLC");
  });

  it("still refuses to pick when the literal name matches two rows", async () => {
    const { client } = fakeLiteralOnly([{ id: A_UUID }, { id: "another-id" }]);
    const r = await resolveCustomerId(client, "Joe's Plumbing");
    expect("error" in r && r.error).toMatch(/Several customers match/);
  });

  it("counts a row matching on BOTH name columns as one match, not an ambiguity", async () => {
    // name and company_name are queried separately; the same row coming back twice must not read
    // as "several customers".
    const { client } = fakeLiteralOnly([{ id: A_UUID }]);
    const r = await resolveCustomerId(client, "Joe's Plumbing");
    expect(r).toEqual({ id: A_UUID });
  });

  it("skips the extra round trip when the name has nothing to sanitize", async () => {
    const { client, literal } = fakeClient({ rows: [{ id: A_UUID }] });
    const r = await resolveJobId(client, "Miller deck");
    expect(r).toEqual({ id: A_UUID });
    expect(literal).toHaveLength(0);
  });

  it("surfaces a literal-pass lookup error instead of falling through to a miss", async () => {
    const { client } = fakeClient({ error: { message: "boom" } });
    const r = await resolveCustomerId(client, "Joe's Plumbing");
    expect("error" in r && r.error).toMatch(/Couldn't look up that customer/);
  });

  it("finds a punctuated PARTIAL name as a last resort (\"Joe's\" → Joe's Plumbing)", async () => {
    // The same blind spot one rung down: the sanitized contains pass searched "%Joe s%".
    let call = 0;
    const patterns: string[] = [];
    const client: ResolverClient = {
      from(_t: string) {
        return {
          select(_c: string) {
            return {
              or(_f: string) {
                return { limit: (_n: number) => Promise.resolve({ data: [], error: null }) };
              },
              ilike(_col: string, pattern: string) {
                patterns.push(pattern);
                // Exact passes (calls 0–1) miss; the contains passes find the row.
                const rows = pattern.startsWith("%") ? [{ id: A_UUID }] : [];
                call += 1;
                return { limit: (_n: number) => Promise.resolve({ data: rows, error: null }) };
              },
            };
          },
        };
      },
    };
    const r = await resolveCustomerId(client, "Joe's");
    expect(r).toEqual({ id: A_UUID });
    expect(patterns).toContain("%Joe's%");
    expect(call).toBeGreaterThan(0);
  });
});
