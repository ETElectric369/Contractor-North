import { describe, it, expect, vi } from "vitest";
import pg from "pg";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { newSuggestionsOnly, offerEstimates, quoteCircuitsToSuggestions, rankEstimateCandidates } from "./model";
import type { JobCircuit, QuoteCircuit } from "@/lib/types";

vi.mock("@/components/toast", () => ({ useToast: () => () => {} }));
vi.mock("@/app/(app)/jobs/panel-actions", () => ({}));
import { JobPanel } from "@/app/(app)/jobs/[id]/job-panel";

/**
 * BRING IN E-017, REPLAYED READ-ONLY AGAINST J-011 (Panel plan, phase 2). Exactly what the office's
 * Bring Them In would do on 13897 Herringbone — WITHOUT WRITING. Inside a READ ONLY transaction it
 * runs the finder bringInEstimateCircuits / loadJobPanel run (the job's own estimates, then the same
 * customer's with no job, each only with circuits; always inside ET's org), picks E-017, builds the
 * suggestions with the same pure code, and diffs them against what the job already holds (nothing
 * yet: 0333 is not applied). It prints the rows the insert would carry.
 *
 * Opt-in (PANEL_REPLAY=1) as well as creds-gated, because it reads live data that stops matching the
 * moment Erik really taps Bring Them In.
 */
const { TEST_DBPW, TEST_DB_HOST, TEST_DB_USER, PANEL_REPLAY } = process.env;
const d = TEST_DBPW && TEST_DB_HOST && TEST_DB_USER && PANEL_REPLAY === "1" ? describe : describe.skip;

const ET = "60195593-2e18-4230-bc8e-7a32d36d038d";
const J011 = "8760a051-b6f8-4a6b-b3a5-6ac7078f9ac1";
const E017 = "0e685ab4-4d2a-4065-bc56-9a59e381cf96";

d("Bring In E-017 on J-011, replayed read-only against ET's live books", () => {
  it("finds E-017 for J-011 and would bring in its 12 circuits as suggestions, writing nothing", async () => {
    const c = new pg.Client({ host: TEST_DB_HOST, port: 5432, user: TEST_DB_USER, password: TEST_DBPW, database: "postgres", ssl: { rejectUnauthorized: false } });
    await c.connect();
    try {
      await c.query("begin transaction read only");
      const job = (await c.query("select id, job_number, name, customer_id from public.jobs where id = $1 and org_id = $2", [J011, ET])).rows[0];
      expect(job?.job_number).toBe("J-011");

      // The finder, as loadJobPanel runs it (org-filtered: postgres bypasses RLS, so the filter is ours).
      const quotes = (
        await c.query(
          `select id, quote_number, job_id, customer_id, circuits, address, created_at::text as created_at
             from public.quotes
            where org_id = $1 and circuits is not null
              and (job_id = $2 or (job_id is null and customer_id = $3))
            order by created_at desc limit 20`,
          [ET, J011, job.customer_id],
        )
      ).rows;
      const candidates = rankEstimateCandidates(J011, job.customer_id, quotes);
      const e017 = candidates.find((q) => q.id === E017);
      expect(e017).toMatchObject({ quote_number: "E-017", count: 12 });

      const q = quotes.find((x) => x.id === E017)!;
      const drafts = quoteCircuitsToSuggestions({ id: q.id, quote_number: q.quote_number, circuits: q.circuits as QuoteCircuit[] });
      const tableThere = (await c.query("select to_regclass('public.job_circuits') is not null as yes")).rows[0].yes;
      const onJob: Pick<JobCircuit, "source_quote_id" | "source_row" | "removed_at">[] = tableThere
        ? (await c.query("select source_quote_id, source_row, removed_at from public.job_circuits where job_id = $1 and org_id = $2", [J011, ET])).rows
        : [];
      const { fresh, already, setAside } = newSuggestionsOnly(drafts, onJob);

      expect(drafts).toHaveLength(12);
      expect(fresh).toHaveLength(tableThere ? 12 - already - setAside : 12);
      expect(drafts.every((x) => x.state === "suggested" && x.source === "estimate" && x.source_quote_id === E017)).toBe(true);

      // THE DEAD-DOOR COUNT ON J-011's LIVE STATE (the dead-door law: run the screen against live
      // data and count the buttons). Before Bring In the office sees exactly three doors and the
      // crew two, each wired in job-panel.tsx: Bring Them In → bringInEstimateCircuits, Add The
      // Panel → the panel sheet, Add Circuit → the form's submit (addCircuit).
      const panelData = {
        ok: true as const,
        panels: [],
        circuits: [],
        photos: [],
        plans: [],
        walkthrough: null,
        people: {},
        estimates: offerEstimates(J011, job.customer_id, quotes, []),
      };
      const labels = (html: string) => [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((m) => m[1].replace(/<[^>]+>/g, "").trim());
      const office = renderToStaticMarkup(createElement(JobPanel, { jobId: J011, initial: { ...panelData, staff: true } }));
      expect(labels(office)).toEqual(["Bring Them In", "Add The Panel", "Add Circuit"]);
      expect(office).toContain("E-017 Has 12 Circuits");
      const crew = renderToStaticMarkup(createElement(JobPanel, { jobId: J011, initial: { ...panelData, staff: false, estimates: [] } }));
      expect(labels(crew)).toEqual(["Add The Panel", "Add Circuit"]);
      expect(office).not.toMatch(/<button[^>]* disabled=""/);
      // Nothing was written: the transaction is read only and is rolled back below.
      console.log(
        "[bring-in replay] J-011 ← E-017:",
        JSON.stringify(
          {
            job: `${job.job_number} ${job.name}`,
            candidates: candidates.map((x) => ({ number: x.quote_number, count: x.count, address: x.address, own_job: x.job_id === J011 })),
            panel_tables_live: tableThere,
            already_on_job: already,
            set_aside: setAside,
            would_insert: fresh.map((x) => ({
              room: x.room,
              description: x.description,
              amps: x.amps,
              poles: x.poles,
              wire: x.wire,
              state: x.state,
              from: x.source_row.quote_number,
              load: x.source_row.load,
              check: x.source_row.check,
            })),
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
