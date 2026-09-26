import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { mintThrowawayOrg } from "@/lib/throwaway-org.db-fixture";
import { assertTestDatabase } from "@/lib/db-guard";

/**
 * THE PRICE BOOK READS THE EXTENSION, NOT THE TYPED UNIT PRICE (0274).
 *
 * CED prices a decora plate "50.00 C" - fifty dollars per HUNDRED. The receipt reader dropped the
 * letter on five lines and `learned_prices` read the column straight, so Erik's book said a wall
 * plate cost fifty dollars and a weatherproof cover cost $1,458.96. His invoices were never wrong,
 * because every money path in the app reads the EXTENSION - which is exactly why this could sit
 * there unseen. These run against the real function, in a rolled-back transaction.
 *
 * Gated on DB creds (no infra committed); skips cleanly without them:
 *   TEST_DB_HOST=… TEST_DB_USER=… TEST_DBPW=… npm test
 */
const { TEST_DBPW, TEST_DB_HOST, TEST_DB_USER } = process.env;
const d = TEST_DBPW && TEST_DB_HOST && TEST_DB_USER ? describe : describe.skip;

d("learned_prices reads the extension (DB integration)", () => {
  let client: pg.Client;
  beforeAll(async () => {
    client = new pg.Client({
      host: TEST_DB_HOST,
      port: 5432,
      user: TEST_DB_USER,
      password: TEST_DBPW,
      database: "postgres",
      ssl: { rejectUnauthorized: false },
    });
    await client.connect();
    await assertTestDatabase(client);
  });
  afterAll(async () => {
    await client?.end();
  });

  /** A throwaway bill in a throwaway TEST org, inside the caller's open transaction. */
  async function billWithLines(
    lines: { description: string; quantity: number; unit_price: number | null; amount: number | null }[],
    bill: { provisional?: boolean } = {},
  ) {
    const org = { id: (await mintThrowawayOrg(client, { label: "learned-prices", techs: 0 })).orgId };
    const { rows: [b] } = await client.query(
      `insert into bills (org_id, supplier, amount, status, bill_date, pricing_provisional)
       values ($1,'TEST integ supplier',0,'unpaid',current_date,$2) returning id`,
      [org.id, !!bill.provisional],
    );
    for (const [i, l] of lines.entries()) {
      await client.query(
        `insert into bill_line_items (org_id, bill_id, description, quantity, unit_price, amount, sort_order)
         values ($1,$2,$3,$4,$5,$6,$7)`,
        [org.id, b.id, l.description, l.quantity, l.unit_price, l.amount, i],
      );
    }
    return b.id as string;
  }

  const book = async (search: string) => {
    const { rows } = await client.query("select * from learned_prices($1, 40)", [search]);
    return rows as { item: string; last_price: string; avg_price: string; low_price: string; high_price: string; times_bought: string }[];
  };

  it("learns the each-price from the extension when the unit price is quoted per hundred", async () => {
    await client.query("begin");
    try {
      // CED's own row: one plate, "50.00 C", extension $0.50.
      await billWithLines([
        { description: "TEST integ 1G BRN Decora plate", quantity: 1, unit_price: 50.0, amount: 0.5 },
      ]);
      const [row] = await book("TEST integ 1G BRN Decora plate");
      expect(row).toBeTruthy();
      expect(Number(row.last_price)).toBe(0.5); // not 50.00
      expect(Number(row.avg_price)).toBe(0.5);
      expect(Number(row.high_price)).toBe(0.5);
    } finally {
      await client.query("rollback");
    }
  });

  it("divides a multi-quantity extension into a real per-piece price", async () => {
    await client.query("begin");
    try {
      // 55 feet of 6/3 at $4,321.03 per THOUSAND: the extension is $237.66, so a foot is $4.32.
      await billWithLines([
        { description: "TEST integ NMB 6/3 reel", quantity: 55, unit_price: 4321.03, amount: 237.66 },
      ]);
      const [row] = await book("TEST integ NMB 6/3 reel");
      expect(Number(row.last_price)).toBe(4.32); // not 4321.03
    } finally {
      await client.query("rollback");
    }
  });

  it("does not learn a price from a line nothing shipped on", async () => {
    await client.query("begin");
    try {
      // A BACK-ORDERED LINE is a real price beside a $0.00 extension, because nothing shipped.
      // 0274 fell back to that stated price, so the next back-ordered plate would have taught the
      // book a per-hundred figure all over again; 0275 leaves it out, because this book is what he
      // has PAID and he has not paid for it. A line with no count to divide by still falls back,
      // since there is nothing else to read.
      await billWithLines([
        { description: "TEST integ back ordered luminaire", quantity: 1, unit_price: 38.98, amount: 0 },
        { description: "TEST integ back ordered plate per hundred", quantity: 5, unit_price: 50.0, amount: 0 },
        { description: "TEST integ no quantity at all", quantity: 0, unit_price: 12.5, amount: 12.5 },
      ]);
      expect(await book("TEST integ back ordered luminaire")).toHaveLength(0);
      expect(await book("TEST integ back ordered plate per hundred")).toHaveLength(0);
      const [nq] = await book("TEST integ no quantity at all");
      expect(Number(nq.last_price)).toBe(12.5);
    } finally {
      await client.query("rollback");
    }
  });

  it("still refuses to learn from a counter preview (0271)", async () => {
    await client.query("begin");
    try {
      await billWithLines(
        [{ description: "TEST integ provisional part", quantity: 1, unit_price: 99.0, amount: 99.0 }],
        { provisional: true },
      );
      expect(await book("TEST integ provisional part")).toHaveLength(0);
    } finally {
      await client.query("rollback");
    }
  });

});
