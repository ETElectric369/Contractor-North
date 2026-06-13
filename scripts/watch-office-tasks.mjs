// watch-office-tasks.mjs — the "remote control" watcher.
//
// Reads NEW office-category tasks out of the live Contractor North database so
// the scheduled automation can pick them up and tee each one up on a branch
// (branch + notify — never push to main, never deploy). Reads only; it makes
// NO changes to the database. Uses the Supabase service-role key over the REST
// API, so it does NOT need the Postgres password.
//
//   node scripts/watch-office-tasks.mjs                 # list new office tasks (JSON + summary)
//   node scripts/watch-office-tasks.mjs --all           # ignore the watermark, list ALL open office tasks
//   node scripts/watch-office-tasks.mjs --commit-watermark <iso>   # advance the watermark after processing
//
// State lives in ./automation/last-seen.txt (gitignored). The watermark is an
// ISO timestamp; only tasks created strictly after it are reported.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

const root = process.cwd();
const stateDir = path.join(root, "automation");
const markFile = path.join(stateDir, "last-seen.txt");

function loadEnvLocal() {
  const p = path.join(root, ".env.local");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
loadEnvLocal();

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("✗ Need NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local.");
  process.exit(1);
}

const args = process.argv.slice(2);
const commitIdx = args.indexOf("--commit-watermark");
if (commitIdx !== -1) {
  const iso = args[commitIdx + 1];
  if (!iso || isNaN(Date.parse(iso))) {
    console.error("✗ --commit-watermark needs an ISO timestamp.");
    process.exit(1);
  }
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
  writeFileSync(markFile, new Date(iso).toISOString() + "\n");
  console.log(`✓ Watermark advanced to ${new Date(iso).toISOString()}`);
  process.exit(0);
}

const seeAll = args.includes("--all");
let watermark = null;
if (!seeAll && existsSync(markFile)) {
  const raw = readFileSync(markFile, "utf8").trim();
  if (raw && !isNaN(Date.parse(raw))) watermark = new Date(raw).toISOString();
}

const supabase = createClient(url, key, { auth: { persistSession: false } });

let q = supabase
  .from("tasks")
  .select("id, title, notes, category, status, priority, due_date, job_id, created_at")
  .eq("category", "office")
  .eq("status", "open")
  .order("created_at", { ascending: true });
if (watermark) q = q.gt("created_at", watermark);

const { data, error } = await q;
if (error) {
  console.error(`✗ Query failed: ${error.message}`);
  process.exit(1);
}

const tasks = data ?? [];
// First run with no watermark: don't stampede the whole backlog. Establish the
// watermark at "now" and report nothing, so only genuinely NEW tasks trigger work.
if (!watermark && !seeAll) {
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
  writeFileSync(markFile, new Date().toISOString() + "\n");
  console.log("FIRST_RUN: watermark initialised to now; no tasks processed this run.");
  console.log(JSON.stringify({ newCount: 0, tasks: [] }, null, 2));
  process.exit(0);
}

const newest = tasks.length ? tasks[tasks.length - 1].created_at : watermark;
console.log(`Found ${tasks.length} new office task(s)` + (watermark ? ` since ${watermark}` : " (all open)") + ".");
for (const t of tasks) {
  console.log(`\n• [${t.id}] ${t.title}`);
  if (t.notes) console.log(`    ${String(t.notes).replace(/\n/g, "\n    ")}`);
  console.log(`    created ${t.created_at}${t.due_date ? `, due ${t.due_date}` : ""}${t.job_id ? `, job ${t.job_id}` : ""}`);
}
console.log("\n--- JSON ---");
console.log(JSON.stringify({ newCount: tasks.length, newestCreatedAt: newest, tasks }, null, 2));
