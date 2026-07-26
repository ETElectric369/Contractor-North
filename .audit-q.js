const { Client } = require('pg');
const cs = 'postgresql://postgres.rbpokaozcxqownollqlx:Sh1neH0me%21.%24@aws-1-us-east-2.pooler.supabase.com:5432/postgres';
(async () => {
  const c = new Client({ connectionString: cs, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const sql = process.argv[2];
  try {
    const r = await c.query(sql);
    const rows = Array.isArray(r) ? r : [r];
    for (const rr of rows) {
      if (rr.rows) console.log(JSON.stringify(rr.rows, null, 1));
      console.log('---');
    }
  } catch (e) { console.error('ERR', e.message); }
  await c.end();
})();
