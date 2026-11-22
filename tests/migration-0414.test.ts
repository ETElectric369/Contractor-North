import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { EXPORT_TABLES } from "@/lib/export/registry";
import { DRAW_KINDS } from "@/lib/invoice-math";
import { DRAW_CREDIT, PREPAID_CREDIT, PREPAYMENT_KIND, PREPAYMENT_LINE } from "@/lib/prepayments";

/**
 * MONEY AHEAD OF THE WORK (0414; cn-v1177. The owner, 2026-11-21: "i think we do need to think about
 * setting up a deposit schedule ability if desired and to be able to have them pay the deposit with
 * their card from the link"), read from the migration file the way migration-0413.test.ts reads 0413:
 *   1. invoices_invoice_kind_check takes 'prepayment';
 *   2. quotes.deposit_amount and quotes.deposit_by_hand, no backfill;
 *   3. invoice_items.prepaid_invoice_id, set exactly on a 'prepaid_credit' line, one per request on a
 *      bill, and NO foreign key (a second key between the two tables makes every PostgREST embed
 *      between them ambiguous): the triggers hold what the key would have;
 *   4-6. THE BOUNDARY: two bills never take the same dollar of one request (the request's row locked
 *      FOR UPDATE before the sum), and every rule of a credit line, in the database;
 *   7. one live deposit request per estimate;
 *   8. public.public_quote re-made from 0408's body with three keys added and nothing else.
 * NO DATABASE RUNS HERE. What this file proves is the text; that the database does it is
 * src/lib/payment-request.integration.test.ts. Applied migrations are immutable: 0414 is pinned the
 * day it is applied.
 */
const migrations = join(process.cwd(), "supabase/migrations");
const names = readdirSync(migrations).filter((n) => /^\d{4}_.*\.sql$/.test(n)).sort();
const migration = (prefix: string) => {
  const f = names.find((n) => n.startsWith(prefix));
  if (!f) throw new Error(`no migration ${prefix}`);
  return readFileSync(join(migrations, f), "utf8");
};
const noComments = (s: string) => s.replace(/--.*$/gm, "");
const squash = (s: string) => s.replace(/\s+/g, " ").trim();
const count = (s: string, needle: string) => s.split(needle).length - 1;
const BS = String.fromCharCode(92);

const QUOTE = "create or replace function public.public_quote(p_token text)";
const quoteText = (sql: string) => {
  const at = sql.indexOf(QUOTE);
  if (at < 0) throw new Error(`no ${QUOTE}`);
  const open = sql.indexOf("as $$", at) + "as $$".length;
  const close = sql.indexOf("$$", open);
  return { head: sql.slice(at, open), whole: sql.slice(at, close + 2), body: sql.slice(open, close) };
};
/** The ground check's reading of a body: statements only (the JS twin of
 *  md5(translate(regexp_replace(prosrc, E'-{2}[^\n]*', '', 'g'), E' \t\n\r', ''))). */
const statementsMd5 = (body: string) =>
  createHash("md5").update(body.replace(/-{2}[^\n]*/g, "").replace(/[ \t\n\r]/g, ""), "utf8").digest("hex");

const M0408_MD5 = "1fb44c873db221169e56bf191659db3d";

/** WHAT 0414 ADDS TO 0408's BODY, and nothing else: the three keys, with their comment, right before
 *  0408's own comment on estimate_format. Cut out of the new body, what is left is 0408's to the byte.
 *  Re-cut after skeptic #80 (F4, F5): the amount is the live request's own ask when there is one, and
 *  a voided request or a job that is over with none live reads 'none'. Still one block. */
const ADDED = [
  "      -- 0414: THE DEPOSIT, AND WHERE IT STANDS: ONE NUMBER FOR THE PAPER, THE BUTTON AND THE CHARGE.",
  "      -- deposit_amount: when the estimate has a live (not void) deposit request, THAT request's ask",
  "      -- (the sum of its own lines), which is what its card door charges; otherwise the figure the",
  "      -- office's save wrote (null on an estimate not saved since 0414: nothing is said for it).",
  "      -- deposit_state: paid (the live request is paid); requested (it exists and is not paid yet: a",
  "      -- live request is owed, on a finished job too); none (no live request and no figure, or 0; or",
  "      -- the office voided the request, and a new one is made only by the office's own form; or the",
  "      -- estimate's job is complete or cancelled); else due. can_take_card is the company's card",
  "      -- door, the same expression public_invoice reads (0301's projection).",
  "      'deposit_amount', coalesce((select sum(it.line_total) from public.invoices d",
  "                                    join public.invoice_items it on it.invoice_id = d.id",
  "                                   where d.quote_id = q.id and d.org_id = q.org_id",
  "                                     and d.invoice_kind = 'prepayment' and d.status <> 'void'),",
  "                                 q.deposit_amount),",
  "      'deposit_state', case",
  "        when exists (select 1 from public.invoices d",
  "                      where d.quote_id = q.id and d.org_id = q.org_id",
  "                        and d.invoice_kind = 'prepayment' and d.status = 'paid') then 'paid'",
  "        when exists (select 1 from public.invoices d",
  "                      where d.quote_id = q.id and d.org_id = q.org_id",
  "                        and d.invoice_kind = 'prepayment' and d.status <> 'void') then 'requested'",
  "        when coalesce(q.deposit_amount, 0) <= 0 then 'none'",
  "        when exists (select 1 from public.invoices d",
  "                      where d.quote_id = q.id and d.org_id = q.org_id",
  "                        and d.invoice_kind = 'prepayment' and d.status = 'void') then 'none'",
  "        when exists (select 1 from public.jobs j",
  "                      where j.id = q.job_id and j.org_id = q.org_id",
  "                        and (j.status = 'complete' or j.status = 'cancelled')) then 'none'",
  "        else 'due' end,",
  "      'can_take_card', (select coalesce(o.stripe_charges_enabled, false)",
  "                          from public.organizations o where o.id = q.org_id),",
  "",
].join("\n");

describe("migration 0414: money ahead of the work", () => {
  const sql = migration("0414_");
  const code = noComments(sql);
  const quote = quoteText(sql);
  const was = quoteText(migration("0408_"));
  const at = (heading: string) => {
    const i = sql.indexOf(heading);
    if (i < 0) throw new Error(`no heading: ${heading}`);
    return i;
  };
  const GROUND = "-- ── The ground it stands on";
  const KIND = "-- ── 1. The fifth kind";
  const DEPOSIT = "-- ── 2. The deposit an estimate states";
  const LINE = "-- ── 3. The request a credit line takes off";
  const BOUNDARY = "-- ── 4. The boundary";
  const SHAPE = "-- ── 5. A request, and a bill that takes requests off, keep their shape";
  const RESTRICT = "-- ── 6. A request a line names is not deleted";
  const UNIQUE = "-- ── 7. One live deposit request per estimate";
  const LINK = "-- ── 8. The customer's estimate link says the deposit";
  const SELF = "-- ── Self-check";
  const HEADINGS = [GROUND, KIND, DEPOSIT, LINE, BOUNDARY, SHAPE, RESTRICT, UNIQUE, LINK, SELF];
  const ground = sql.slice(at(GROUND), at(KIND));
  const self = sql.slice(at(SELF));
  const between = (a: string, b: string) => sql.slice(at(a), at(b));

  it("is the one 0414 (what sits past it is the newest migration's own test: migration-0415.test.ts), under the house timeouts, with no transaction of its own", () => {
    expect(names.filter((n) => n.startsWith("0414_"))).toEqual(["0414_money_ahead.sql"]);
    // The newest-migration line moved to migration-0415.test.ts the night 0415 was written.
    expect(code).toContain("set local lock_timeout = '3s';");
    expect(code).toContain("set local statement_timeout = '15s';");
    expect(code).not.toMatch(/^\s*(begin|commit|rollback|start transaction)\b[^;\n]*;/im);
    expect(code).not.toMatch(/\bsavepoint\b/i);
    expect(HEADINGS.map(at)).toEqual(HEADINGS.map(at).sort((a, b) => a - b));
  });

  it("quotes the owner, names its readers, writers and its database suite, and names nobody by name", () => {
    const unwrapped = sql.replace(/\n\s*-- ?/g, " ").replace(/ {2,}/g, " ");
    expect(unwrapped).toContain(
      '"i think we do need to think about setting up a deposit schedule ability if desired and to be able to have them pay the deposit with their card from the link or something like that"',
    );
    for (const named of [
      "src/lib/prepayments.ts",
      "src/lib/payment-request.ts",
      "src/lib/deposit-rule.ts",
      "src/app/(app)/quotes/actions.ts",
      "src/lib/export/registry.ts",
      "tests/migration-0414.test.ts",
      "src/lib/payment-request.integration.test.ts",
      "NO BACKFILL",
      "NO FOREIGN KEY, ON PURPOSE",
      "BEFORE the deploy",
      "NOT twice-safe, on purpose",
    ]) {
      expect(sql).toContain(named);
    }
    expect(existsSync(join(process.cwd(), "src/lib/payment-request.integration.test.ts"))).toBe(true);
    expect(sql).not.toMatch(/\bErik\b/);
    // The accept function is not touched here (migration-0413 pins its makers).
    expect(sql).not.toContain("accept_public_quote");
  });

  describe("the ground it stands on", () => {
    it("checks before it changes anything, refuses in a plain sentence, and only reads", () => {
      for (const stands of [
        "if to_regclass('public.' || r.tbl) is null then",
        "if (select count(*) from pg_roles where rolname in ('anon', 'authenticated')) <> 2 then",
        "where c.table_schema = 'public' and c.table_name = r.tbl and c.column_name = r.col and c.data_type = r.kind",
        "c.udt_name = 'invoice_status'",
        "<> array['deposit', 'final', 'progress', 'standard'] then",
        "k.conname = 'invoice_items_line_kind_known'",
        "if exists (select 1 from public.invoice_items where import_source in ('prepayment', 'prepaid_credit')) then",
        "if to_regprocedure('public.public_quote(text)') is null then",
        "if not has_function_privilege('anon', 'public.public_quote(text)', 'execute')",
        "or not has_function_privilege('authenticated', 'public.public_quote(text)', 'execute') then",
      ]) {
        expect(ground).toContain(stands);
      }
      expect(noComments(ground)).not.toMatch(/\balter\b|\bcreate\b|\bdrop\b|\bgrant\b|\brevoke\b|\binsert\b|\bupdate\b|\bdelete\b/i);
      expect(noComments(ground).match(/raise exception/g)?.length).toBe((noComments(ground).match(/Nothing was changed\./g) ?? []).length);
      // The ground runs first: nothing is added before it.
      expect(code.indexOf("do $$")).toBeLessThan(code.indexOf("add column"));
    });

    it("every column it names is added by the migration it names", () => {
      const rows = [...ground.matchAll(/^\s*\('(\w+)',\s*'(\w+)',\s*'([a-z ]+)',\s*'(\d{4})'\),?$/gm)].map((m) => ({ table: m[1], column: m[2], kind: m[3], born: m[4] }));
      expect(rows.length).toBe(13);
      const type = (k: string) => ({ text: "text", uuid: "uuid", numeric: "numeric", boolean: "boolean", "timestamp with time zone": "timestamptz" })[k]!;
      for (const r of rows) {
        const file = noComments(migration(`${r.born}_`));
        const altered = new RegExp(`add column if not exists ${r.column}\\s+${type(r.kind)}\\b`, "i").test(file);
        const made = file.search(new RegExp(`create table (?:if not exists )?(?:public\\.)?${r.table}\\s*\\(`, "i"));
        const inCreate = made >= 0 && new RegExp(`^\\s*${r.column}\\s+${type(r.kind)}\\b`, "im").test(file.slice(made, file.indexOf("\n);", made)));
        const orgLoop = r.column === "org_id" && r.born === "0004" && file.includes(`'${r.table}'`) && file.includes("add column if not exists org_id uuid");
        expect(altered || inCreate || orgLoop, `${r.table}.${r.column} (${r.kind}) is not added by ${r.born}`).toBe(true);
      }
    });

    it("holds the live public_quote to 0408's body by the statements alone, and the self-check to this file's", () => {
      const makers = names.filter((n) => /function\s+(public\.)?public_quote\s*\(/i.test(readFileSync(join(migrations, n), "utf8")));
      expect(makers.slice(-2)).toEqual(["0408_one_materials_line_under_each_task.sql", "0414_money_ahead.sql"]);
      for (const n of names.filter((x) => x >= "0409_" && x < "0414_")) {
        expect(readFileSync(join(migrations, n), "utf8").replace(/accept_public_quote|decline_public_quote/g, ""), n).not.toContain("public_quote");
      }
      expect(statementsMd5(was.body)).toBe(M0408_MD5);
      const mine = statementsMd5(quote.body);
      expect(mine).not.toBe(M0408_MD5);
      const reading = `coalesce(md5(translate(regexp_replace(v_src, E'-{2}[^${BS}n]*', '', 'g'), E' ${BS}t${BS}n${BS}r', '')), '')`;
      expect(ground).toContain(`  if ${reading} <> '${M0408_MD5}' then`);
      expect(self).toContain(`  if ${reading} <> '${mine}' then`);
      expect(count(code, M0408_MD5)).toBe(1);
      expect(count(code, mine)).toBe(1);
      // A comment, a blank line or an indent changes neither reading.
      expect(statementsMd5(`-- a note\n${quote.body.replace(/\n/g, "\n   ")}\n\n-- another\n`)).toBe(mine);
      // Two hyphens in the body only ever open a comment, never sit inside a string.
      for (const line of quote.body.split("\n").filter((l) => l.includes("--"))) expect(count(line.slice(0, line.indexOf("--")), "'") % 2, line).toBe(0);
    });

    it("notes who owns public_quote and who may call it, and the self-check reads it back", () => {
      const reading = "'was:' || pg_get_userbyid(p.proowner) || ' ' || coalesce(p.proacl::text, '')";
      expect(ground).toContain(`perform set_config(\n    'cn.m0414_quote_was',\n    (select ${reading} from pg_proc p where p.oid = 'public.public_quote(text)'::regprocedure),\n    true);`);
      expect(self).toContain("v_was := current_setting('cn.m0414_quote_was', true);");
      expect(self).toContain(`select ${reading} into v_now from pg_proc p where p.oid = v_quote;`);
      expect(self).toContain("if v_now is distinct from v_was then");
    });
  });

  describe("1. the fifth kind", () => {
    it("swaps 0063's check for the same check with 'prepayment', and the app's words are the database's", () => {
      const flat = squash(noComments(between(KIND, DEPOSIT)));
      expect(flat).toBe(
        "alter table public.invoices drop constraint invoices_invoice_kind_check; alter table public.invoices add constraint invoices_invoice_kind_check check (invoice_kind in ('deposit', 'progress', 'final', 'standard', 'prepayment'));",
      );
      expect(PREPAYMENT_KIND).toBe("prepayment");
      // A request is NOT a draw: it never locks a job out of a standard invoice.
      expect((DRAW_KINDS as readonly string[]).includes(PREPAYMENT_KIND)).toBe(false);
      expect(self).toContain("<> array['deposit', 'final', 'prepayment', 'progress', 'standard'] then");
    });
  });

  describe("2. the deposit an estimate states", () => {
    it("two columns, a check, no backfill", () => {
      const flat = squash(noComments(between(DEPOSIT, LINE)));
      expect(flat).toContain("alter table public.quotes add column deposit_amount numeric(12,2);");
      expect(flat).toContain("alter table public.quotes add column deposit_by_hand boolean not null default false;");
      expect(flat).toContain("add constraint quotes_deposit_amount_not_negative check (deposit_amount is null or deposit_amount >= 0);");
      expect(code).not.toMatch(/update public\.quotes\b/i);
      expect(code).not.toMatch(/\binsert into\b/i);
    });
  });

  describe("3. the request a credit line takes off", () => {
    const part = squash(noComments(between(LINE, BOUNDARY)));
    it("set exactly on a prepaid_credit line, one per request on a bill, indexed", () => {
      expect(part).toContain("alter table public.invoice_items add column prepaid_invoice_id uuid;");
      expect(part).toContain(
        "add constraint invoice_items_prepaid_credit_names_its_request check ((import_source is not distinct from 'prepaid_credit') = (prepaid_invoice_id is not null));",
      );
      expect(part).toContain("create unique index invoice_items_one_credit_per_request on public.invoice_items (invoice_id, prepaid_invoice_id) where prepaid_invoice_id is not null;");
      expect(part).toContain("create index invoice_items_prepaid_invoice_idx on public.invoice_items (prepaid_invoice_id) where prepaid_invoice_id is not null;");
      expect(PREPAID_CREDIT).toBe("prepaid_credit");
      expect(PREPAYMENT_LINE).toBe("prepayment");
      expect(DRAW_CREDIT).toBe("draw_credit");
    });

    it("declares NO foreign key to invoices (it would make every embed between the two tables ambiguous), and the self-check refuses one", () => {
      expect(code).not.toMatch(/\breferences\b/i);
      expect(self).toContain("and k.contype = 'f'");
      expect(self).toContain("carries a foreign key, which makes every embed between invoices and invoice_items ambiguous");
      // …and the app embeds the two tables in both directions today: the reason is real.
      const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
      expect(read("src/lib/unbilled-work.ts")).toContain("invoice_items(import_source, line_total)");
      expect(read("src/lib/already-billed-read.ts")).toContain("invoices(invoice_number)");
    });
  });

  describe("4-6. the boundary", () => {
    const boundary = noComments(between(BOUNDARY, SHAPE));
    const shape = noComments(between(SHAPE, RESTRICT));
    const restrict = noComments(between(RESTRICT, UNIQUE));
    const fnBody = (text: string, name: string) => {
      const from = text.indexOf(`create or replace function public.${name}(`);
      const open = text.indexOf("as $$", from);
      return text.slice(open, text.indexOf("end $$;", open));
    };

    it("THE SUM locks the request's row first, then counts every credit line on a bill that is not void against the request's own lines", () => {
      const hold = fnBody(boundary, "prepayment_hold");
      const lock = hold.indexOf("select i.invoice_number into v_number from public.invoices i where i.id = p_request for update;");
      expect(lock).toBeGreaterThan(0);
      expect(hold.indexOf("select coalesce(sum(it.line_total), 0) into v_asked")).toBeGreaterThan(lock);
      expect(squash(hold)).toContain(
        "select coalesce(sum(-it.line_total), 0) into v_taken from public.invoice_items it join public.invoices b on b.id = it.invoice_id where it.import_source = 'prepaid_credit' and it.prepaid_invoice_id = p_request and b.status <> 'void';",
      );
      expect(hold).toContain("if v_taken > v_asked then");
    });

    it("EVERY RULE OF A LINE: the request exists, is one, is live, is on the same job of the same company, the bill is not a request, the line takes money off", () => {
      const holds = squash(fnBody(boundary, "prepaid_credit_line_holds"));
      for (const rule of [
        "from public.invoices i where i.id = p_request for update; if not found then raise exception",
        "if v_req.invoice_kind <> 'prepayment' then",
        "if v_req.status = 'void' then",
        "if v_req.status = 'draft' then",
        "if v_bill.invoice_kind = 'prepayment' then",
        "if v_bill.org_id is distinct from v_req.org_id or v_bill.job_id is null or v_bill.job_id is distinct from v_req.job_id then",
        "if coalesce(p_line_total, 0) > 0 then",
        "perform public.prepayment_hold(p_request, 'credit');",
      ]) {
        expect(holds, rule).toContain(rule);
      }
      const line = squash(fnBody(boundary, "guard_prepaid_credit_line"));
      expect(line).toContain("if new.import_source = 'prepaid_credit' then perform public.prepaid_credit_line_holds(new.invoice_id, new.prepaid_invoice_id, new.line_total);");
      expect(line).toContain("if v_kind = 'prepayment' then perform public.prepayment_hold(new.invoice_id, 'own');");
      expect(line).toContain("perform public.prepayment_hold(old.invoice_id, 'own');");
      expect(squash(boundary)).toContain(
        "create trigger invoice_items_prepaid_boundary after insert or update or delete on public.invoice_items for each row execute function public.guard_prepaid_credit_line();",
      );
    });

    it("ON THE BILLS: a request a bill took off is not voided or put back to draft, keeps its kind and its job; a carrier is checked when it goes out or comes back", () => {
      const bill = squash(fnBody(shape, "guard_prepayment_bill"));
      for (const rule of [
        "if v_named and new.invoice_kind is distinct from old.invoice_kind then",
        "if v_named and (new.job_id is distinct from old.job_id or new.org_id is distinct from old.org_id) then",
        "if new.status is distinct from old.status and new.status::text in ('void', 'draft') then",
        "and b.status::text not in ('void', 'draft')",
        // Back from void AS A DRAFT is not re-checked (skeptic #80): its lines are derived, the next
        // recalculation re-resolves them, and they are checked when it goes out.
        "if (old.status::text = 'void' and new.status::text not in ('void', 'draft')) or (old.status::text = 'draft' and new.status::text not in ('draft', 'void')) then",
        "perform public.prepaid_credit_line_holds(new.id, r.prepaid_invoice_id, r.line_total);",
      ]) {
        expect(bill, rule).toContain(rule);
      }
      expect(squash(shape)).toContain(
        "create trigger invoices_prepayment_boundary after update of status, job_id, org_id, invoice_kind on public.invoices for each row execute function public.guard_prepayment_bill();",
      );
      expect(squash(restrict)).toContain("create trigger invoices_prepayment_restrict before delete on public.invoices for each row execute function public.guard_prepayment_delete();");
      expect(squash(fnBody(restrict, "guard_prepayment_delete"))).toContain("where it.import_source = 'prepaid_credit' and it.prepaid_invoice_id = old.id and it.invoice_id <> old.id");
    });

    it("every function is the definer's with its search path pinned, nobody outside the database may call it, and every refusal is a sentence", () => {
      const all = noComments(between(BOUNDARY, UNIQUE));
      const made = [...all.matchAll(/create or replace function public\.(\w+)\(([^)]*)\)/g)].map((m) => m[1]);
      expect(made).toEqual(["prepayment_hold", "prepaid_credit_line_holds", "guard_prepaid_credit_line", "guard_prepayment_bill", "guard_prepayment_delete"]);
      expect(count(all, "security definer")).toBe(5);
      expect(count(all, "set search_path = public")).toBe(5);
      for (const fn of ["prepayment_hold(uuid, text)", "prepaid_credit_line_holds(uuid, uuid, numeric)", "guard_prepaid_credit_line()", "guard_prepayment_bill()", "guard_prepayment_delete()"]) {
        expect(all).toContain(`revoke all on function public.${fn} from public, anon, authenticated;`);
        expect(self).toContain(`('public.${fn}')`);
      }
      // A refusal a person reads: plain words, ends on what happened, never a constraint's name.
      const raises = [...all.matchAll(/raise exception '([^']|'')*'/g)].map((m) => m[0]);
      expect(raises.length).toBe(15);
      // No raise names an action a void bill does not have (skeptic #80): "open ... again" is gone.
      expect(all).not.toMatch(/Open % again|open this bill again/);
      for (const r of raises) {
        expect(r, r).toMatch(/Nothing was (saved|deleted)\.'$|Void % first, or leave % as it is\.'$/);
        expect(r, r).not.toMatch(/constraint|violat|prepaid_invoice_id|invoice_kind|import_source/);
      }
    });
  });

  describe("7. one live deposit request per estimate", () => {
    it("a unique index on the estimate, for requests that are not void", () => {
      expect(squash(noComments(between(UNIQUE, LINK)))).toBe(
        "create unique index invoices_one_live_deposit_request_per_estimate on public.invoices (quote_id) where invoice_kind = 'prepayment' and quote_id is not null and status <> 'void';",
      );
    });
  });

  describe("8. public_quote: 0408's body, and the three keys", () => {
    it("the same door: its signature, its security, its search path; no grant or revoke of its own (replace keeps them)", () => {
      expect(quote.head).toBe(was.head);
      expect(quote.head).toBe("create or replace function public.public_quote(p_token text)\nreturns json language sql stable security definer set search_path = public as $$");
      expect(noComments(between(LINK, SELF))).not.toMatch(/\bgrant\b|\brevoke\b/i);
    });

    it("differs from 0408's body by the additions only: cut them out and what is left is 0408's to the byte", () => {
      expect(count(quote.body, ADDED)).toBe(1);
      expect(quote.body.replace(ADDED, "")).toBe(was.body);
      // They sit inside the quote object, right before 0408's estimate_format.
      expect(quote.body).toContain(`'doc_type', q.doc_type, 'created_at', q.created_at,\n${ADDED}      -- 0408: THE WORD THE PAGE PRINTS BY`);
    });

    it("the additions build exactly three keys, read no column the company keeps to itself, and card is public_invoice's own expression", () => {
      const keys = [...noComments(ADDED).matchAll(/(?<!->)'([a-z_]+)'\s*,/g)].map((m) => m[1]);
      expect(keys).toEqual(["deposit_amount", "deposit_state", "can_take_card"]);
      // A request's own lines (line_total) are read; never a bill's total, its payments or settings.
      expect(noComments(ADDED)).not.toMatch(/settings|\btotal\b|amount_paid|stripe_account/);
      const states = [...noComments(ADDED).matchAll(/then '([a-z]+)'|else '([a-z]+)'/g)].map((m) => m[1] ?? m[2]);
      expect(states).toEqual(["paid", "requested", "none", "none", "none", "due"]);
      // Every read of a request, and of the job, is in the estimate's own company.
      expect(count(noComments(ADDED), "d.quote_id = q.id and d.org_id = q.org_id")).toBe(4);
      expect(noComments(ADDED)).toContain("where j.id = q.job_id and j.org_id = q.org_id");
      // The card door: the same words 0301's projection reads for public_invoice.
      expect(migration("0301_")).toContain("'can_take_card', coalesce(o.stripe_charges_enabled, false),");
      expect(ADDED).toContain("coalesce(o.stripe_charges_enabled, false)");
    });

    it("ONE NUMBER (F4): a live deposit request's own ask is the amount; the stored figure only when there is none", () => {
      const flat = squash(noComments(ADDED));
      expect(flat).toContain(
        "'deposit_amount', coalesce((select sum(it.line_total) from public.invoices d join public.invoice_items it on it.invoice_id = d.id where d.quote_id = q.id and d.org_id = q.org_id and d.invoice_kind = 'prepayment' and d.status <> 'void'), q.deposit_amount),",
      );
    });

    it("NO DEAD BUTTON (F5): a live request first (owed, even on a finished job); then none for no figure, a voided request, or a job that is over", () => {
      const flat = squash(noComments(ADDED));
      const at = (needle: string) => {
        const i = flat.indexOf(needle);
        expect(i, needle).toBeGreaterThan(0);
        return i;
      };
      const order = [
        "d.status = 'paid') then 'paid'",
        "d.status <> 'void') then 'requested'",
        "when coalesce(q.deposit_amount, 0) <= 0 then 'none'",
        "d.status = 'void') then 'none'",
        "(j.status = 'complete' or j.status = 'cancelled')) then 'none'",
        "else 'due' end,",
      ].map(at);
      expect(order).toEqual([...order].sort((a, b) => a - b));
    });
  });

  describe("the self-check", () => {
    it("proves the kind, the columns, no key, the indexes, the functions, the triggers, the door, and that it runs", () => {
      for (const proof of [
        "k.conname = 'invoices_invoice_kind_check' and k.convalidated",
        "column_name = 'deposit_amount'",
        "data_type = 'numeric' and numeric_precision = 12 and numeric_scale = 2 and is_nullable = 'YES' and column_default is null",
        "data_type = 'boolean' and is_nullable = 'NO' and column_default = 'false'",
        "k.conname = 'quotes_deposit_amount_not_negative'",
        "k.conname = 'invoice_items_prepaid_credit_names_its_request'",
        "('invoices_one_live_deposit_request_per_estimate', true, 'prepayment')",
        "('public.invoice_items', 'invoice_items_prepaid_boundary', 'public.guard_prepaid_credit_line()', 'after', 'insert update delete')",
        "('public.invoices', 'invoices_prepayment_boundary', 'public.guard_prepayment_bill()', 'after', 'update')",
        "('public.invoices', 'invoices_prepayment_restrict', 'public.guard_prepayment_delete()', 'before', 'delete')",
        "if has_function_privilege('anon', to_regprocedure(r.fn), 'execute') or has_function_privilege('authenticated', to_regprocedure(r.fn), 'execute') then",
        "or (select p.provolatile from pg_proc p where p.oid = v_quote) <> 's'",
        "if not has_function_privilege('anon', v_quote, 'execute') or not has_function_privilege('authenticated', v_quote, 'execute') then",
        "if public.public_quote('0414 self-check: no estimate has this token') is not null then",
      ]) {
        expect(self, proof).toContain(proof);
      }
      expect((noComments(self).match(/raise exception/g) ?? []).length).toBe((noComments(self).match(/Nothing was changed\.|Run it through the migration runner\./g) ?? []).length);
    });
  });

  it("the company export names the three new columns", () => {
    const cols = (t: string) => EXPORT_TABLES.find((x) => x.table === t)?.columns ?? [];
    expect(cols("quotes")).toEqual(expect.arrayContaining(["deposit_amount", "deposit_by_hand"]));
    expect(cols("invoice_items")).toContain("prepaid_invoice_id");
  });
});
