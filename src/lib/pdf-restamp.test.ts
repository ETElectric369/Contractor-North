import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * THE 0200 TRIGGER BUG, PINNED (0207).
 *
 * The re-stamp trigger compared doc_pdf_cache.doc_status (text) against NEW/OLD.status, which on
 * quotes and invoices is an ENUM. Postgres has no text = enum operator, so the trigger raised —
 * and a raising trigger aborts the whole statement, which meant NO estimate could be accepted or
 * declined and NO invoice could be sent or marked paid, live, for two days. A payment's insert
 * succeeded while the invoice header update was rejected, leaving real money unrecorded on the
 * document.
 *
 * Nothing in the suite touched a status through the database, so CI was green throughout. This
 * test reads the migration itself: the comparison must be textual on BOTH sides, forever.
 */
describe("0207 — the re-stamp trigger must compare text to text", () => {
  const sql = readFileSync("supabase/migrations/0207_restamp_trigger_enum_cast.sql", "utf8");

  it("casts NEW.status when writing the stamp", () => {
    expect(sql).toMatch(/set\s+doc_status\s*=\s*new\.status::text/i);
  });

  it("casts OLD.status in the guard that matches the stored stamp", () => {
    expect(sql).toMatch(/doc_status\s*=\s*old\.status::text/i);
  });

  it("never compares a bare .status against the text column", () => {
    // `doc_status = old.status` (no cast) is the exact shape that took the app down.
    expect(sql).not.toMatch(/doc_status\s*=\s*(new|old)\.status(?!::text)/i);
  });
});
