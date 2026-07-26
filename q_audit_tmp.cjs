const { Client } = require('pg');
const cs = 'postgresql://postgres.rbpokaozcxqownollqlx:Sh1neH0me%21.%24@aws-1-us-east-2.pooler.supabase.com:5432/postgres';
(async () => {
  const c = new Client({ connectionString: cs, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const q = process.argv[2];
  const r = await c.query(q);
  console.log(JSON.stringify(r.rows, null, 2));
  await c.end();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
