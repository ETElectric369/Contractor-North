import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * THE BELL RECORDS EVERY PUSH (Wave 1, W1-10 rewritten). Erik kept the Bell: "where would push
 * notifications be recorded?" Sixteen push sites wrote no bell line, so a push missed on the lock
 * screen left nothing to go back to.
 *
 * THE GUARD. Every push goes through notifyPeople (which writes the line, then pushes), or is one of
 * the known sites below that write their own line beside the push. So every real
 * `sendPushToProfiles(` call outside lib/push.ts (the definition) and lib/notifications.ts (ringOffice
 * and notifyPeople) is counted, per file, comments stripped, and a file or a count that isn't on the
 * list fails: a new push must either go through notifyPeople or join the list with its own line.
 *
 * It counts calls only. billing/actions.ts's payment-recorded push gets its bell line from lane 4's
 * createNotifications, pinned in lane 4's own test (a check for it here would be red until that lane
 * merges first).
 */
const ROOT = process.cwd();

/** The sites that write their own bell line beside the push: wrapping them would put it twice. */
const OWN_LINE: Record<string, number> = {
  "src/app/(app)/materials/stock-actions.ts": 1, // the stock ring: its line, then the push
  "src/app/(app)/materials/actions.ts": 1, // requestMaterials: every add on the bell
  "src/app/(app)/quotes/actions.ts": 1, // an estimate accepted: createNotifications, then the push
  "src/app/(app)/timeclock/crew-actions.ts": 1, // a crew change: its own line
  "src/app/(app)/timeclock/actions.ts": 2, // the clock-out reminder and the daily report: their own lines
  "src/app/(app)/billing/actions.ts": 1, // a payment recorded: lane 4's createNotifications
  "src/app/api/timeclock/long-shift/route.ts": 2, // the long-shift job: the line first, then each push
  "src/app/api/pick/confirmed/route.ts": 1, // a customer picked a time: its own line
  "src/app/q/[token]/actions.ts": 1, // an estimate accepted from the public page: its own line
  "src/lib/crew-notify.ts": 1, // added to a job's crew: its own line
  "src/lib/inquiries/create-triaged-inquiry.ts": 1, // a new request: its own line
  "src/lib/actions/public-schedule.ts": 1, // a booking from the public schedule: its own line
};

/** The sites that were bare pushes and now go through notifyPeople (the line, then the push). */
const THROUGH_NOTIFY: string[] = [
  "src/app/inquire/[org]/actions.ts",
  "src/app/(app)/appointments/actions.ts",
  "src/app/(app)/timeclock/actions.ts", // notifyGeofenceExit, the "Clock out?" reminder
  "src/app/(app)/billing/tap-actions.ts",
  "src/app/api/stripe/webhook/route.ts",
  "src/lib/bank-transfer-alerts.ts",
  "src/lib/action-items/digest.ts",
  "src/lib/action-items/eod-sweep.ts",
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && !/\.test-util\.ts$/.test(name)) out.push(p);
  }
  return out;
}

/** The code with its comments taken out (a URL's "//" inside a string is kept). */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/(^|[^:"'`\\])\/\/.*$/, "$1"))
    .join("\n");
}

const pushCalls = (text: string) => (code(text).match(/\bsendPushToProfiles\s*\(/g) ?? []).length - (code(text).match(/function\s+sendPushToProfiles\s*\(/g) ?? []).length;

describe("every push rings the bell", () => {
  const counts: Record<string, number> = {};
  for (const f of walk(join(ROOT, "src"))) {
    const rel = relative(ROOT, f);
    if (rel === "src/lib/push.ts" || rel === "src/lib/notifications.ts") continue;
    const n = pushCalls(readFileSync(f, "utf8"));
    if (n) counts[rel] = n;
  }

  it("finds the push sites (so an empty scan can never pass)", () => {
    expect(Object.keys(counts).length).toBeGreaterThan(8);
  });

  it("every bare push is a known site that writes its own line, at its known count", () => {
    expect(counts).toEqual(OWN_LINE);
  });

  it("a push named only in a comment is no push (the daily automations route)", () => {
    const route = readFileSync(join(ROOT, "src/app/api/automations/daily/route.ts"), "utf8");
    expect(route).toMatch(/sendPushToProfiles/);
    expect(pushCalls(route)).toBe(0);
  });

  it("the sites that were bare pushes go through notifyPeople", () => {
    for (const rel of THROUGH_NOTIFY) {
      const src = code(readFileSync(join(ROOT, rel), "utf8"));
      expect(src, rel).toMatch(/\bnotifyPeople\s*\(/);
    }
  });

  it("the comment stripper keeps a URL and drops a comment", () => {
    expect(pushCalls('const u = "https://x.test"; // sendPushToProfiles(a)\n/* sendPushToProfiles(b) */')).toBe(0);
    expect(pushCalls('await sendPushToProfiles(ids, "inquiry", { url: "https://x.test" }); // ok')).toBe(1);
  });
});

// ── notifyPeople: the line, then the push ────────────────────────────────────────────────────────

const bell = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[], order: [] as string[], fail: false }));
const push = vi.hoisted(() => ({ calls: [] as unknown[][], pushed: null as null | string[] }));
vi.mock("@/lib/supabase/server", () => ({
  createServiceClient: () => ({
    from: () => ({
      insert: async (rows: Record<string, unknown>[]) => {
        bell.order.push("bell");
        if (bell.fail) return { error: { message: "insert failed" } };
        bell.rows.push(...rows);
        return { error: null };
      },
    }),
  }),
}));
vi.mock("@/lib/push", () => ({
  pushKindIsOptIn: (kind: string) => kind === "day_ahead",
  sendPushToProfiles: async (...a: unknown[]) => {
    bell.order.push("push");
    push.calls.push(a);
    // Default: everyone asked for is pushed, but a muted "office-2" never is.
    return push.pushed ?? (a[0] as string[]).filter((id) => id !== "office-2");
  },
}));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));

describe("notifyPeople", () => {
  beforeEach(() => {
    bell.rows = [];
    bell.order = [];
    bell.fail = false;
    push.calls = [];
    push.pushed = null;
  });

  it("a default-on kind: the line goes to every intended person, the one who muted the buzz included, and then the push", async () => {
    const { notifyPeople } = await import("./notifications");
    const r = await notifyPeople("org-1", ["office-1", "office-2", "office-1", null], "invoice_paid", {
      title: "Payment received",
      body: "$150.00 paid online on INV-080",
      url: "/billing/inv-80",
    });
    expect(bell.order).toEqual(["bell", "push"]);
    expect(bell.rows).toEqual([
      { org_id: "org-1", user_id: "office-1", type: "invoice_paid", title: "Payment received", body: "$150.00 paid online on INV-080", url: "/billing/inv-80" },
      { org_id: "org-1", user_id: "office-2", type: "invoice_paid", title: "Payment received", body: "$150.00 paid online on INV-080", url: "/billing/inv-80" },
    ]);
    expect(push.calls).toEqual([[["office-1", "office-2"], "invoice_paid", { title: "Payment received", body: "$150.00 paid online on INV-080", url: "/billing/inv-80" }]]);
    expect(r).toEqual({ bell: true, pushed: ["office-1"] });
  });

  it("an opt-in kind (day_ahead): the push first, and the line only for the people it went to", async () => {
    const { notifyPeople } = await import("./notifications");
    push.pushed = ["erik"];
    const r = await notifyPeople("org-1", ["erik", "office-9"], "day_ahead", { title: "Needs You: 3", body: "Invoice INV-071 overdue", url: "/planner" });
    expect(bell.order).toEqual(["push", "bell"]);
    expect(bell.rows.map((x) => x.user_id)).toEqual(["erik"]);
    expect(r).toEqual({ bell: true, pushed: ["erik"] });
    // Nobody opted in: no line on anybody's bell.
    bell.rows = [];
    push.pushed = [];
    expect(await notifyPeople("org-1", ["office-9"], "day_ahead", { title: "Needs You: 1", url: "/planner" })).toEqual({ bell: true, pushed: [] });
    expect(bell.rows).toEqual([]);
  });

  it("nobody to tell, no company, or no words: nothing written, nothing pushed", async () => {
    const { notifyPeople } = await import("./notifications");
    expect(await notifyPeople("org-1", [], "inquiry", { title: "New inquiry" })).toEqual({ bell: true, pushed: [] });
    expect(await notifyPeople(null, ["office-1"], "inquiry", { title: "New inquiry" })).toEqual({ bell: true, pushed: [] });
    expect(await notifyPeople("org-1", ["office-1"], "inquiry", { title: "" })).toEqual({ bell: true, pushed: [] });
    expect(bell.order).toEqual([]);
  });

  it("a failed line never stops the push, and never throws: it says so (bell: false)", async () => {
    const { notifyPeople } = await import("./notifications");
    bell.fail = true;
    const r = await notifyPeople("org-1", ["office-1"], "assigned", { title: "New appointment assigned", body: "Walk-through at 85 Whitney" });
    expect(r).toEqual({ bell: false, pushed: ["office-1"] });
    expect(push.calls).toHaveLength(1);
  });
});
