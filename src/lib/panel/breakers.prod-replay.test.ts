import { describe, it, expect, vi } from "vitest";
import pg from "pg";
import { assertReadOnlyReplay } from "@/lib/db-guard";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { breakerCard, lineKey, groupLabel, type ListLine } from "./breakers";
import { decodeBreaker, decodeCode } from "./breaker-catalog";
import { normalisePartNumber } from "@/lib/shelf-plan";
import { FINAL_MAP, PHOTO_EXISTING } from "./__fixtures__/herringbone";
import type { JobPanel } from "@/lib/types";

vi.mock("@/components/toast", () => ({ useToast: () => () => {} }));
vi.mock("@/app/(app)/jobs/panel-actions", () => ({}));
import { BreakersCardView, type BreakersData } from "@/app/(app)/jobs/[id]/job-panel-breakers";

/**
 * THE BREAKERS CARD ON J-011's LIVE TICKETS, REPLAYED WITHOUT WRITING (Panel plan, phase 3).
 *
 * The crew's door (breakers_bought_for_job, 0334) is called on J-011 AS AN ET TECH, exactly as the
 * card's load calls it; the office's extras (which ticket, what it cost, the price book) are read
 * the way the office's session reads them, filtered to ET's org (postgres bypasses RLS, so the
 * filter is ours). The circuits are the night's final map as data (J-011's list isn't entered yet).
 * It must say "Short One 2P 20A (Bath Floor Heat). One 1P 20A Spare." against 8 x Q2020 + 1 x
 * Q21530CT, offer Add Q220 To Materials ($18.76 in the book) and the quad swap with "Not Q22020CT2,
 * That Is Two 2-Pole 20s".
 *
 * One READ ONLY transaction, rolled back: nothing is written (0334 must already be applied).
 * Opt-in (PANEL_REPLAY=1) as well as creds-gated: it reads live data that
 * stops matching the moment the job's tickets change.
 */
// A PRODUCTION REPLAY (db-guard.ts): REPLAY_DB_* creds, opt-in, never in CI, read-only session.
//   REPLAY_DB_HOST=… REPLAY_DB_USER=… REPLAY_DBPW=… PANEL_REPLAY=1 npx vitest run <this file>
const { REPLAY_DBPW, REPLAY_DB_HOST, REPLAY_DB_USER, PANEL_REPLAY } = process.env;
const d = REPLAY_DBPW && REPLAY_DB_HOST && REPLAY_DB_USER && PANEL_REPLAY === "1" && !process.env.CI ? describe : describe.skip;

const ET = "60195593-2e18-4230-bc8e-7a32d36d038d";
const J011 = "8760a051-b6f8-4a6b-b3a5-6ac7078f9ac1";

d("the Breakers card on J-011, replayed against ET's live tickets", () => {
  it("reads every line on every ET ticket and materials list: each one a breaker it can name, unknown, or not a breaker", async () => {
    const c = new pg.Client({ host: REPLAY_DB_HOST, port: 5432, user: REPLAY_DB_USER, password: REPLAY_DBPW, database: "postgres", ssl: { rejectUnauthorized: false } });
    await c.connect();
    await assertReadOnlyReplay(c);
    try {
      await c.query("begin transaction read only");
      const lines = (
        await c.query(
          `select distinct li.description from public.bill_line_items li join public.bills b on b.id = li.bill_id and b.org_id = li.org_id
            where b.org_id = $1 and li.description is not null
           union
           select distinct concat_ws(' ', i.part_number, i.description) from public.material_list_items i where i.org_id = $1`,
          [ET],
        )
      ).rows.map((r) => r.description as string);
      const read = lines.map((l) => ({ l, r: decodeBreaker(l) }));
      const breakers = read.filter((x) => x.r.kind === "breaker").map((x) => `${x.l} → ${x.r.kind === "breaker" ? `${x.r.code ?? "words"}: ${x.r.words}` : ""}`);
      const unknown = read.filter((x) => x.r.kind === "unknown").map((x) => `${x.l} → ${x.r.kind === "unknown" ? x.r.reason : ""}`);
      // Every breaker line the plan named (17 on the bills) plus J-011's twin and quad on its list.
      for (const must of [
        "SIEM Q2020 SP 20/20A 120/240V CB",
        "SIEM Q21530CT",
        "SIEM Q2100 2P 100A 120/240V CB",
        "1P 20A CKT BRKR GFCI (SIEM QF120AN)",
        "SP 15A 120/240V CB (Q115)",
        "SP 20A 120/240V CB (Q120)",
        "SP 20A 120/240V CB (SIEM Q120)",
        "SP 20A 120/240V CB",
        "2P 30A 120/240V CB (Q230)",
        "2P 50A 120/240V CB (Q250)",
        "2P 20A 120/240 plug-in CB",
        "2P 30A 120/240V CB",
        "2P 50A 120/240V CB",
        "SQD HOM120 Miniature Circuit",
        "SQD HOMT1515 Miniature Circuit",
        "SQD HOMT2020 Miniature Circuit",
        "SQD HOMT230250 Miniature Ckt Brkr",
        "20a twin breaker",
        "Quad 2p - 30a - 1p-15s breaker",
      ]) {
        expect(breakers.some((b) => b.startsWith(`${must} →`)), must).toBe(true);
      }
      console.log("[decoder replay] ET:", JSON.stringify({ lines: lines.length, breakers, unknown }, null, 1));
    } finally {
      await c.query("rollback").catch(() => {});
      await c.end();
    }
  });

  it("says Short One 2P 20A (Bath Floor Heat). One 1P 20A Spare., and offers the Q220 and the quad swap", async () => {
    const c = new pg.Client({ host: REPLAY_DB_HOST, port: 5432, user: REPLAY_DB_USER, password: REPLAY_DBPW, database: "postgres", ssl: { rejectUnauthorized: false } });
    await c.connect();
    await assertReadOnlyReplay(c);
    try {
      await c.query("begin transaction read only");
      await c.query("set local lock_timeout = '3s'");
      await c.query("set local statement_timeout = '15s'");
      const has = (await c.query("select to_regprocedure('public.breakers_bought_for_job(uuid)') is not null as yes")).rows[0].yes;
      expect(has, "0334 (breakers_bought_for_job) is on this database").toBe(true);

      const job = (await c.query("select id, job_number, name from public.jobs where id = $1 and org_id = $2", [J011, ET])).rows[0];
      expect(job?.job_number).toBe("J-011");
      const who = (
        await c.query("select id, role from public.profiles where org_id = $1 and active and role = 'tech' order by created_at limit 1", [ET])
      ).rows[0] ?? (await c.query("select id, role from public.profiles where org_id = $1 and active and role = 'owner' limit 1", [ET])).rows[0];
      expect(who).toBeTruthy();

      // ── AS THE CREW: the door, the list, the shelf ──
      await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: who.id, role: "authenticated" })]);
      await c.query("set local role authenticated");
      const bought = (await c.query("select description, qty::float as qty from public.breakers_bought_for_job($1)", [J011])).rows as { description: string; qty: number }[];
      const listId = (await c.query("select id from public.material_lists where job_id = $1 and org_id = $2 order by created_at desc, id desc limit 1", [J011, ET])).rows[0]?.id ?? null;
      const list: ListLine[] = listId
        ? (
            await c.query("select description, part_number, quantity::float as qty, coalesce(purchased,false) as purchased from public.material_list_items where list_id = $1 and org_id = $2 order by sort_order", [
              listId,
              ET,
            ])
          ).rows.filter((i: ListLine) => decodeBreaker(i.part_number, i.description).kind !== "not_breaker")
        : [];
      const shelf = (await c.query("select name, on_hand::float as on_hand from public.shelf_for_crew()")).rows.filter(
        (s: { name: string; on_hand: number }) => s.on_hand > 0 && decodeBreaker(s.name).kind === "breaker",
      );
      await c.query("reset role");
      await c.query("select set_config('request.jwt.claims', '', true)");

      // ── THE OFFICE'S EXTRAS, filtered to ET ──
      const tix = (
        await c.query(
          `select b.bill_number, b.supplier, b.bill_date::text as bill_date, li.description, li.quantity::float as qty, li.amount::float as amount
             from public.bills b join public.bill_line_items li on li.bill_id = b.id and li.org_id = b.org_id
            where b.org_id = $1 and b.job_id = $2 and b.superseded_by_bill_id is null
              and not coalesce(b.is_statement, false) and not coalesce(b.on_shelf, false) and coalesce(b.status, '') <> 'void'
              and not coalesce(li.is_stock, false)`,
          [ET, J011],
        )
      ).rows
        .filter((l) => decodeBreaker(l.description).kind !== "not_breaker")
        .map((l) => ({ key: lineKey(l.description), description: l.description, qty: l.qty, bill_number: l.bill_number, supplier: l.supplier, bill_date: l.bill_date, each: l.qty > 0 ? Math.round((l.amount / l.qty) * 100) / 100 : null }));
      const prices = (
        await c.query("select id, code, buy_price::float as buy_price from public.price_list_items where org_id = $1 and not archived and code is not null", [ET])
      ).rows
        .filter((r) => decodeCode(r.code)?.kind === "breaker")
        .map((r) => ({ id: r.id, code: normalisePartNumber(r.code)!, buy_price: r.buy_price }));
      const panel = ((await c.query("select * from public.job_panels where job_id = $1 and org_id = $2 and removed_at is null order by created_at limit 1", [J011, ET])).rows[0] ??
        null) as JobPanel | null;

      // ── THE CARD ──
      const circuits = [...FINAL_MAP, ...PHOTO_EXISTING];
      const card = breakerCard({ circuits, panel, bought, list, shelf });
      expect(card.bought.map((g) => [groupLabel(g), g.qty])).toEqual([
        ["Q2020 · Twin 1P 20A + 1P 20A", 8],
        ["Q21530CT · Quad 1P 15A + 1P 15A + 2P 30A", 1],
      ]);
      expect(card.unreadable).toEqual([]);
      expect(card.check.verdict).toBe("Short One 2P 20A (Bath Floor Heat). One 1P 20A Spare.");
      expect(card.orders.map((o) => o.part)).toEqual(["Q220"]);
      expect(card.check.swaps.map((s) => [s.get.part, s.warning])).toEqual([["Q22020CT", "Not Q22020CT2, That Is Two 2-Pole 20s"]]);

      const base = { ok: true as const, ticketsReady: true, bought, list, listId, shelf };
      const crewData: BreakersData = { ...base, staff: false, office: null };
      const officeData: BreakersData = { ...base, staff: true, office: { tickets: tix, prices } };
      const draw = (data: BreakersData) => renderToStaticMarkup(createElement(BreakersCardView, { data, circuits, panel, onAddToMaterials: () => {}, onAddPanel: () => {}, onPlace: () => {} }));
      const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
      const labels = (h: string) => [...h.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((m) => m[1].replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'").trim());
      const crew = draw(crewData);
      const office = draw(officeData);
      for (const h of [crew, office]) {
        expect(text(h)).toContain("Short One 2P 20A (Bath Floor Heat). One 1P 20A Spare.");
        expect(text(h)).toContain("Not Q22020CT2, That Is Two 2-Pole 20s");
        expect(labels(h)).toContain("Add Q220 To Materials");
        expect(labels(h)).toContain("Add Q22020CT To Materials");
      }
      expect(text(office)).toContain("Q220 Is $18.76 In Your Price Book.");
      expect(text(office)).toContain("8802-SO-257555");
      for (const secret of ["8802-SO-257555", "$", "Price Book"]) expect(text(crew)).not.toContain(secret);

      console.log(
        "[breakers replay] J-011:",
        JSON.stringify(
          {
            as: who.role,
            door_0334_applied: has,
            bought,
            list: list.map((l) => `${l.qty} x ${l.description}${l.purchased ? " (bought)" : ""}`),
            shelf,
            panel: panel ? { name: panel.name, twin_spaces: panel.twin_spaces } : null,
            need: card.needWords,
            already_in: card.alreadyInWords,
            verdict: card.check.verdict,
            orders: card.orders.map((o) => ({ part: o.part, qty: o.qty, also: o.alsoOn })),
            swaps: card.check.swaps.map((s) => ({ words: s.words, warning: s.warning, if_space: s.ifSpaceTakesQuad })),
            on_list: card.onList.map((g) => ({ words: g.words, qty: g.qty, on_ticket: g.onTicket })),
            crew_buttons: labels(crew),
            office_buttons: labels(office),
            office_tickets: tix.map((t) => `${t.bill_number} ${t.supplier}: ${t.qty} x ${t.description} @ ${t.each}`),
          },
          null,
          1,
        ),
      );
    } finally {
      await c.query("rollback").catch(() => {});
      await c.end();
    }
  });
});
