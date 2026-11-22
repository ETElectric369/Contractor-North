import { describe, it, expect } from "vitest";
import { dbError } from "./db-error";

/**
 * The real string Erik was looking at when he said "i cant even make an estimate for some reason"
 * is the first case. Every other one is a shape that will eventually land under somebody's Save
 * button; the last block is the promise that we never hide one we don't recognise.
 */

const pg = (message: string) => ({ message, code: "23505", details: null, hint: null });

describe("dbError — the shapes people actually hit", () => {
  it("the one that blocked the estimate", () => {
    expect(dbError(pg('duplicate key value violates unique constraint "quotes_org_number_key"')))
      .toBe("That estimate number is already in use. Try saving again — it'll take the next one.");
  });

  it("an unrecognised unique constraint still says something a person can act on", () => {
    const got = dbError(pg('duplicate key value violates unique constraint "some_new_thing_key"'));
    expect(got).toBe("Something with that value already exists — change it and try again.");
    expect(got).not.toContain("constraint");
  });

  it("RLS is an ACCESS answer, never 'try again'", () => {
    const got = dbError(pg('new row violates row-level security policy for table "quotes"'));
    expect(got).toMatch(/don't have access/);
    expect(got).not.toMatch(/try again/i);
  });

  it("a missing required field names the field, not the column", () => {
    expect(dbError(pg('null value in column "customer_id" of relation "jobs" violates not-null constraint')))
      .toBe("customer is required.");
    expect(dbError(pg('null value in column "full_name" violates not-null constraint')))
      .toBe("name is required.");
  });

  it("a foreign key means something was deleted under you", () => {
    expect(dbError(pg('insert or update on table "jobs" violates foreign key constraint "jobs_customer_id_fkey"')))
      .toMatch(/no longer exists/);
  });

  it("a check constraint, a too-long value, and a mid-deploy column", () => {
    expect(dbError(pg('new row for relation "appointments" violates check constraint "appointments_type_check"')))
      .toMatch(/isn't one this field accepts/);
    // A named check with its own sentence says it (0300's portal constraints).
    expect(dbError(pg('new row for relation "job_stretches" violates check constraint "job_stretches_dates_in_order"')))
      .toBe("The stretch ends before it starts. Check the two dates.");
    expect(dbError(pg("value too long for type character varying(40)"))).toMatch(/shorten it/);
    expect(dbError(pg('column quotes.unit does not exist'))).toMatch(/mid-update/);
  });
});

describe("dbError — never swallows what it doesn't recognise", () => {
  it("hands an unknown message back verbatim, because Erik files bugs by copying it", () => {
    const odd = "deadlock detected while waiting for ShareLock on transaction 8817";
    expect(dbError(pg(odd))).toBe(odd);
  });

  it("takes a bare string, an Error, or nothing at all", () => {
    expect(dbError("plain string")).toBe("plain string");
    expect(dbError(new Error("boom"))).toBe("boom");
    expect(dbError(null)).toBe("Something went wrong.");
    expect(dbError(undefined)).toBe("Something went wrong.");
    expect(dbError({})).toBe("Something went wrong.");
  });

  it("never returns an empty string — a blank error box says nothing at all", () => {
    for (const v of [null, undefined, {}, "", { message: "" }, { message: null }])
      expect(dbError(v).length).toBeGreaterThan(0);
  });
});

describe("dbError — one sale, one deposit (cn-v1178, carried C38)", () => {
  it("0414's one-live-deposit index says what stands and the way out, never the generic duplicate", () => {
    const said = dbError({ code: "23505", message: 'duplicate key value violates unique constraint "invoices_one_live_deposit_request_per_estimate"' });
    expect(said).toBe("This estimate already has a live deposit request. Void that one first, or use it. Nothing was changed.");
  });
  it("0416's guard speaks for itself: its words pass through as the database says them", () => {
    const msg = "This sale already has a deposit request: INV-900. Use that one. Nothing was made.";
    expect(dbError({ code: "P0001", message: msg })).toBe(msg);
  });
});
