import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { isPinned, pinArm, PUSH_SIX, rankPoolCut, rankSix, type SixRankTask } from "@/lib/six-rank";
import { KIND_STREAM, AFFORDANCES, type ActionItem, type PileName } from "@/lib/action-items/types";
import { supplierPaperActionItem } from "@/lib/action-items/supplier-paper-item";
import { supplierPayActionItems } from "@/lib/action-items/supplier-pay-item";
import { PAY_CARD_WINDOW_DAYS } from "@/app/(app)/bills/supplier-pay-due";
import { PILE_DEFS, codeCount, rollUpPiles, sqlCount } from "@/lib/action-items/piles";

// THE BADGE INVARIANT (src/lib/action-items/types.ts): a number on chrome =
// distinct items needing a HUMAN DECISION TODAY that the app cannot defer,
// shown where the deciding happens, display-capped at 9+. No count may be the
// length of an unbounded or undated set. These tests pin the law two ways:
// structurally (the task feeder stays deleted — the "19 badge" can't come back
// by accident) and functionally (the six-slot rank that replaced it).

const src = (rel: string) => readFileSync(new URL(`../src/${rel}`, import.meta.url), "utf8");

describe("badge economy: the inbox is decisions-only (the task feeder stays dead)", () => {
  const querySrc = src("lib/action-items/query.ts");

  it("never emits kind 'task' or 'work_order' — the feeder and its projection are deleted", () => {
    // Structural: the union must not query tasks at all, nor project the kinds.
    expect(querySrc).not.toContain('.from("tasks")');
    expect(querySrc).not.toContain('kind: "task"');
    expect(querySrc).not.toContain('kind: "work_order"');
  });

  it("no feeder counts an undated set as due-now (the due-now-forever cut is gone)", () => {
    // The old arm `due_date.is.null,due_date.lte.<today>` made every undated
    // task a permanent badge resident. No feeder may resurrect it.
    expect(querySrc).not.toContain("due_date.is.null");
  });

  it("the badge count stays derived from the list (the never-disagree doctrine): it is Now's length, never the fold's", () => {
    expect(querySrc).toContain("(await getActionItems(ctx)).now.length");
    expect(querySrc).not.toContain("waiting.length");
    // One build hands back both lists (one cache() fan-out for the badge and the page).
    expect(querySrc).toMatch(/const actionItemsForRequest = cache\(\s*\(todayStr: string, isStaff: boolean, userId: string, tz: string, off: string\): Promise<NeedsYou> =>/);
    expect(querySrc).toContain("return { now, waiting: fold };");
  });

  it("tasks are gone from Needs You's grammar entirely, and so is the Convert verb (Wave 1, W1-16)", () => {
    // A job's tasks live on its Tasks chip and a person's Reminders in Today's 6 (0358): no task or
    // work_order kind, no stream for one, and no Convert sheet on any row. (The registry keeps
    // task.* and inquiry.convert for Nort; Needs You reaches neither.)
    expect(Object.keys(KIND_STREAM)).not.toContain("task");
    expect(Object.keys(KIND_STREAM)).not.toContain("work_order");
    expect(Object.keys(AFFORDANCES)).toEqual(Object.keys(KIND_STREAM));
    for (const [kind, verbs] of Object.entries(AFFORDANCES)) expect(verbs as string[], kind).not.toContain("convert");
    const dispatchSrc = src("lib/action-items/dispatch.ts");
    expect(dispatchSrc).not.toContain('"convert"');
    expect(dispatchSrc).not.toContain("ConvertTarget");
    expect(dispatchSrc).not.toContain("isTask");
  });

  it("the supplier bills ride as ONE rolled-up item, however many papers wait (Bills plan, Wave A)", () => {
    // A supplier's backlog is an unbounded set; eleven CED papers must badge +1, not +11. The
    // feeder pushes the rollup once and never an item per paper.
    expect(querySrc).toContain("supplierPaperActionItem(await supplierPapersP)");
    // No Now row per paper: the one `kind: "supplier_paper"` the build writes is a WAITING row, a
    // paper set aside waiting on a credit (the fold, never the badge).
    expect(querySrc.match(/kind: "supplier_paper"/g)).toHaveLength(1);
    expect(querySrc).toMatch(/const row = waitingRow\(\{\s*id: `credit-\$\{c\.invoiceId\}`,\s*kind: "supplier_paper",/);
    expect(KIND_STREAM.supplier_paper).toBe("money");
    expect(AFFORDANCES.supplier_paper).toEqual(["open"]);
    const card = { invoiceId: "x", invoiceNumber: "8802-1", supplier: "CED", date: "2026-09-04", total: 1, closed: false, said: null, state: "needs_job" as const, verdict: "blank" as const, suggestion: null, candidates: [], onJob: null, because: "", samePurchase: [] };
    const cards = Array.from({ length: 11 }, (_, i) => ({ ...card, invoiceId: `p${i}` }));
    const item = supplierPaperActionItem({ cards, jobs: [] });
    expect(item?.title).toBe("Supplier Bills · 11");
    expect(item?.when).toBeNull(); // undated: never a red "overdue" nobody set
  });

  it("the Pay By line is DATED, one per account, and exists only while the discount does", () => {
    // A number on chrome needs an expiry. Each pay line carries its deadline as `when`, is one line
    // per supplier account (never one per invoice), and supplierPayDue drops it the day after.
    expect(querySrc).toContain("withPayees(supplierPayActionItems((await supplierDeskP)?.payDue), desk?.payDue)");
    expect(querySrc).not.toContain('kind: "supplier_pay"');
    expect(KIND_STREAM.supplier_pay).toBe("money");
    expect(AFFORDANCES.supplier_pay).toEqual(["open"]);
    const due = (accountId: string, payBy: string) => ({ accountId, accountName: "X", supplier: "CED", owed: 100, saves: 1, invoices: 7, sent: 0, payBy, daysLeft: 5 });
    const items = supplierPayActionItems([due("a", "2026-10-10"), due("b", "2026-10-12")]);
    expect(items).toHaveLength(2);
    for (const it of items) expect(it.when).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(new Set(items.map((i) => i.id)).size).toBe(2);
    expect(supplierPayActionItems([])).toEqual([]);
    expect(supplierPayActionItems(null)).toEqual([]);
    // The window is bounded (two weeks) and ends at the deadline: nothing past it is ever counted.
    expect(PAY_CARD_WINDOW_DAYS).toBeLessThanOrEqual(14);
  });

  it("the shifts on no job ride as ONE rolled-up line, with no three-day window (the duplicate punches)", () => {
    // Every past-day shift on no job is an unbounded set: it badges +1 through the rollup, and the
    // per-shift stray rows are only for running clocks (a closed one used to vanish after 3 days).
    expect(querySrc).toContain("noJobHoursActionItem(noJob.summary, { failed: noJob.failed })");
    expect(querySrc).toContain(".filter((f) => f.openStill || !tz)");
    expect(querySrc).toContain("readNoJobHours(supabase, { tz, todayStr })");
    // The rollup's Already Billed door reads its reach beside the fan-out (chained off the rollup's
    // own read), never as two serial reads after it on every staff build.
    expect(querySrc).toContain("const noJobReachP: Promise<boolean> = noJobP.then(");
    expect(querySrc.indexOf("const noJobReachP")).toBeLessThan(querySrc.indexOf("await Promise.all(["));
    expect(querySrc.match(/readNoJobHoursReach\(supabase, orgId, \[\]\)/g)).toHaveLength(1);
    expect(querySrc).not.toContain('kind: "time_stray",\n      title: `Hours On No Job');
    expect(KIND_STREAM.time_stray).toBe("today");
    expect(AFFORDANCES.time_stray).toEqual(["open"]);
  });

  it("a pile counts ONE on the badge: seven estimates not sent add 1, a lone one stays a plain row", () => {
    const draft = (i: number): ActionItem => ({
      id: `qdraft-q${i}`,
      kind: "quote_draft",
      stream: KIND_STREAM.quote_draft,
      title: `Estimate E-0${i} started, never sent`,
      when: `2026-09-${String(10 + i).padStart(2, "0")}`,
      urgency: 0,
      done: false,
      href: `/quotes/q${i}`,
      affordances: AFFORDANCES.quote_draft,
    });
    const seven = rollUpPiles(Array.from({ length: 7 }, (_, i) => draft(i)), { todayStr: "2026-09-27", isStaff: true });
    expect(seven).toHaveLength(1);
    expect(seven[0].title).toBe("Estimates Not Sent · 7");
    expect(seven[0].affordances).toEqual(["open"]);
    const one = rollUpPiles([draft(1)], { todayStr: "2026-09-27", isStaff: true });
    expect(one).toHaveLength(1);
    expect(one[0].id).toBe("qdraft-q1");
    expect(one[0].title).not.toMatch(/· 1$/);
  });

  it("a capped read never prints a short count: a pile's title is never the read's .limit()", () => {
    const LIMIT = 50;
    const rows: ActionItem[] = Array.from({ length: LIMIT }, (_, i) => ({
      id: `r${i}`,
      kind: "inquiry",
      stream: KIND_STREAM.inquiry,
      title: `Lead ${i}`,
      urgency: 1,
      done: false,
      href: "/leads",
      affordances: AFFORDANCES.inquiry,
    }));
    const read = { data: rows, count: 83 };
    for (const fact of [sqlCount(read), codeCount(read), codeCount({ data: rows }, LIMIT)]) {
      const [pile] = rollUpPiles(rows, { todayStr: "2026-09-27", isStaff: true, counts: { leads_to_call: fact } });
      expect(pile.title).not.toBe(`Leads To Call · ${LIMIT}`);
      expect(pile.title).toMatch(/^Leads To Call · (83|50\+)$/);
    }
    // Every piled feeder in the build hands over a real count (its exact count or its cap).
    for (const name of Object.keys(PILE_DEFS) as PileName[]) expect(querySrc, name).toContain(`counts.${name} =`);
    expect(querySrc).not.toMatch(/`[^`]*· \$\{[^}]*\.length\}`/);
  });

  it("the dock's chrome badge display-caps at 9+", () => {
    const dockSrc = src("components/app-shell/dock.tsx");
    expect(dockSrc).toContain('badge > 9 ? "9+" : badge');
  });

  it("the morning digest never writes the pool cut itself: it calls THE shared one, so the push can't drift from the card", () => {
    const digestSrc = src("lib/action-items/digest.ts");
    // ONE RULE, ONE PLACE. The digest and the planner each used to spell the arms out, which is how
    // `focus_date.eq.<today>` came to live in two files and expire a pin in both (Erik, 2026-09-30:
    // "the tasks keep disappearing even the pinned ones").
    expect(digestSrc).toContain("rankPoolQuery(");
    expect(digestSrc).not.toContain("focus_date.eq.");
    expect(digestSrc).not.toContain("due_date.is.null,due_date.lte");
    // The push's scope is the ONE named difference, and it is the narrow one: an undated Reminder
    // rides a push only when it is flagged or pinned (the badge invariant — no pushed number is the
    // length of an undated set).
    expect(digestSrc).toContain('scope: "push"');
    expect(rankPoolCut("2026-07-02", "push")).toContain("and(due_date.is.null,priority.gte.1)");
    expect(rankPoolCut("2026-07-02", "my_day")).toContain("due_date.is.null");
    expect(rankPoolCut("2026-07-02", "my_day")).not.toContain("priority.gte.1");
    // Both scopes carry the SAME pin arm, and it is lte — a carried pin is fetched by both.
    for (const scope of ["my_day", "push"] as const) {
      expect(rankPoolCut("2026-07-02", scope)).toContain(pinArm("2026-07-02"));
    }
    expect(pinArm("2026-07-02")).toBe("focus_date.lte.2026-07-02");
    // The phone's morning read-back comes from the same rank as the card — a parallel cut would
    // drift (phone says 18, app says 4). Since 0358 it ranks each PERSON's own Reminders.
    expect(digestSrc).toContain('from "./digest-six"');
    expect(digestSrc).toContain("sixForPerson(pool, personId, today)");
    const sixSrc = src("lib/action-items/digest-six.ts");
    expect(sixSrc).toContain('from "@/lib/six-rank"');
    expect(sixSrc).toContain("rankSix(");
    // A PUSH is still bounded even though the card is not: a notification is one sentence.
    expect(sixSrc).toContain("slots: PUSH_SIX");
    expect(PUSH_SIX).toBe(6);
  });

  it("the digest's pool is Reminders only and pushes one person at a time (0358), each on their own bell too", () => {
    const digestSrc = src("lib/action-items/digest.ts");
    expect(digestSrc).toContain('.is("job_id", null)');
    // One person at a time, through the door that writes the bell line for whoever it went to (0366 wave).
    expect(digestSrc).toContain("notifyPeople(\n        org.id,\n        [personId],\n        \"day_ahead\",");
    expect(digestSrc).not.toContain("sendPushToProfiles(");
    expect(digestSrc).not.toContain("scheduledJobIds");
    // The decisions headline is the card's own name: "Needs You: 3", never "Needs action: 3 items".
    expect(digestSrc).toContain("title: `Needs You: ${decisions}`");
    expect(digestSrc).not.toContain("Needs action:");
  });

  it("the morning push counts every hold that is back (its day today or earlier, or no day), filtered to the company, and it joins the decisions", () => {
    const digestSrc = src("lib/action-items/digest.ts");
    expect(digestSrc).toMatch(/\.from\("jobs"\)\s*\.select\("id", \{ count: "exact", head: true \}\)\s*\.eq\("org_id", org\.id\)\s*\.eq\("status", "on_hold"\)\s*\.or\(`hold_until\.is\.null,hold_until\.lte\.\$\{today\}`\)/);
    expect(digestSrc).toContain("const decisions = holdsBack + (invR.count ?? 0) + (leadR.count ?? 0);");
    // First line, and it stands for every hold it counts.
    expect(digestSrc.indexOf("decisionTitles.push(holdsBackLine(holdsBack))")).toBeLessThan(digestSrc.indexOf("Invoice ${i.invoice_number} overdue"));
  });
});

// ── rankSix: carried pins > today's pins > overdue > due today > flagged undated > plain undated ──
// REWRITTEN for Erik's report of 2026-09-30 (/planner): "the tasks keep disappearing even the pinned
// ones, I think those reminders should be visible". The cases that used to pin the OLD behaviour —
// "a stale pin does not squat a slot", "caps overdue auto-fill at 3", "never returns more than
// SIX_SLOTS", "plain undated tasks never fill a slot" — were pinning the three defects he was
// reporting. Each is rewritten below to pin what he asked for instead; none was deleted to get green.

const TODAY = "2026-07-02";
const YESTERDAY = "2026-07-01";
let seq = 0;
const task = (over: Partial<SixRankTask> = {}): SixRankTask => ({
  id: `t${++seq}`,
  status: "open",
  priority: 0,
  due_date: null,
  focus_date: null,
  category: "operations",
  job_id: null,
  parent_id: null,
  // The total order's middle term: distinct and ascending with seq, so "the oldest keeps its place"
  // is actually exercised instead of falling through to the id.
  created_at: `2026-06-01T00:00:${String(seq % 60).padStart(2, "0")}Z`,
  ...over,
});

describe("rankSix: a pin is a promise and it CARRIES (Erik, 2026-09-30)", () => {
  it("THE BUG, as he lived it: pin it today, come back tomorrow, it is still the first thing on the card", () => {
    // Day one: he pins it. It leads.
    const pin = task({ focus_date: TODAY });
    const dueToday = task({ due_date: TODAY });
    expect(rankSix([dueToday, pin], { todayStr: TODAY }).map((t) => t.id)).toEqual([pin.id, dueToday.id]);
    // The day turns over. NOTHING about the row changes — nobody wrote to it, nobody swept it.
    const tomorrow = "2026-07-03";
    const stillThere = rankSix([dueToday, pin], { todayStr: tomorrow });
    // It used to be gone: focus_date === todayStr was false, and no other rank claimed an undated
    // priority-0 row, so the pin he set yesterday simply was not on the card.
    expect(stillThere.map((t) => t.id)).toContain(pin.id);
    expect(stillThere[0].id).toBe(pin.id); // and it still LEADS, as a carried pin
  });

  it("carried pins lead, oldest first, ahead of today's pins", () => {
    const old = task({ focus_date: "2026-06-20" });
    const newer = task({ focus_date: YESTERDAY });
    const todays = task({ focus_date: TODAY });
    const six = rankSix([todays, newer, old], { todayStr: TODAY });
    expect(six.map((t) => t.id)).toEqual([old.id, newer.id, todays.id]);
  });

  it("a carried pin beats even an urgent overdue, and priority can't jump the carry order", () => {
    const urgentOverdue = task({ priority: 2, due_date: "2026-06-01" });
    const carried = task({ priority: 0, focus_date: YESTERDAY });
    expect(rankSix([urgentOverdue, carried], { todayStr: TODAY })[0].id).toBe(carried.id);
  });

  it("a pin set for a LATER day does not LEAD today — a pin is a promise from its own day onward", () => {
    // Nort's "propose tomorrow's six" writes focus_date = tomorrow. It must not jump the queue today;
    // it is just one of his open Reminders until its day comes (and it wears no pin glyph: isPinned).
    const tomorrowPin = task({ focus_date: "2026-07-03" });
    const dueToday = task({ due_date: TODAY });
    expect(rankSix([tomorrowPin, dueToday], { todayStr: TODAY }).map((t) => t.id)).toEqual([dueToday.id, tomorrowPin.id]);
    expect(isPinned(tomorrowPin.focus_date, TODAY)).toBe(false);
    // Its own day: it leads.
    expect(rankSix([tomorrowPin, dueToday], { todayStr: "2026-07-03" })[0].id).toBe(tomorrowPin.id);
    expect(isPinned(tomorrowPin.focus_date, "2026-07-03")).toBe(true);
  });

  it("pinned (focus_date=today) still beats everything dated", () => {
    const overdue = task({ priority: 2, due_date: YESTERDAY });
    const pinned = task({ priority: 0, focus_date: TODAY });
    expect(rankSix([overdue, pinned], { todayStr: TODAY }).map((t) => t.id)).toEqual([pinned.id, overdue.id]);
  });

  it("orders today's pins by priority desc", () => {
    const p0 = task({ focus_date: TODAY, priority: 0 });
    const p2 = task({ focus_date: TODAY, priority: 2 });
    const p1 = task({ focus_date: TODAY, priority: 1 });
    expect(rankSix([p0, p2, p1], { todayStr: TODAY }).map((t) => t.id)).toEqual([p2.id, p1.id, p0.id]);
  });
});

describe("rankSix: no display cap (Erik: \"lets not limit it\")", () => {
  it("every overdue Reminder is shown — the 3-row auto-fill cap is gone", () => {
    const overdue = Array.from({ length: 8 }, (_, i) =>
      task({ due_date: `2026-06-${String(10 + i).padStart(2, "0")}` }),
    );
    // It used to return exactly 3 of these and silently keep five missed deadlines off the card.
    expect(rankSix(overdue, { todayStr: TODAY })).toHaveLength(8);
  });

  it("twelve things due today are twelve rows, not six", () => {
    const many = Array.from({ length: 12 }, () => task({ due_date: TODAY }));
    expect(rankSix(many, { todayStr: TODAY })).toHaveLength(12);
  });

  it("a PUSH is still bounded, because a notification is a sentence: slots caps it", () => {
    const many = Array.from({ length: 12 }, () => task({ due_date: TODAY }));
    expect(rankSix(many, { todayStr: TODAY, slots: PUSH_SIX })).toHaveLength(PUSH_SIX);
  });

  it("within overdue: priority desc, then due DESC (a yesterday-miss beats a June-8 zombie)", () => {
    const zombie = task({ priority: 0, due_date: "2026-06-08" });
    const fresh = task({ priority: 0, due_date: YESTERDAY });
    const flagged = task({ priority: 1, due_date: "2026-06-15" });
    const six = rankSix([zombie, fresh, flagged], { todayStr: TODAY });
    expect(six.map((t) => t.id)).toEqual([flagged.id, fresh.id, zombie.id]);
  });

  it("fills the whole rank order: carried pin → today's pin → overdue → due today → flagged → plain", () => {
    const plain = task(); // undated, priority 0 → the last rank, and it DOES rank now
    const flagged = task({ priority: 1 });
    const dueToday = task({ due_date: TODAY });
    const overdue = task({ due_date: YESTERDAY });
    const pinned = task({ focus_date: TODAY });
    const carried = task({ focus_date: "2026-06-30" });
    const six = rankSix([plain, flagged, dueToday, overdue, pinned, carried], { todayStr: TODAY });
    expect(six.map((t) => t.id)).toEqual([carried.id, pinned.id, overdue.id, dueToday.id, flagged.id, plain.id]);
  });
});

describe("rankSix: a plain undated Reminder is VISIBLE (his word)", () => {
  it("priority 0, no due date, no pin: it ranks last, but it ranks", () => {
    const undated = task();
    const dueToday = task({ due_date: TODAY });
    // It used to be absent entirely, which is why the Add line had to stamp a pin on everything it
    // typed — and that pin is what expired at midnight.
    expect(rankSix([undated, dueToday], { todayStr: TODAY }).map((t) => t.id)).toEqual([dueToday.id, undated.id]);
  });

  it("the My Day pool ASKS for them: the cut carries a bare undated arm", () => {
    expect(rankPoolCut(TODAY, "my_day").split(",")).toContain("due_date.is.null");
  });

  it("a FUTURE due date still never ranks — the sheet promises it waits till then", () => {
    const later = task({ due_date: "2026-08-01" });
    expect(rankSix([later], { todayStr: TODAY })).toHaveLength(0);
  });
});

describe("rankSix: a job's task is never a slot (0358: these are Reminders)", () => {
  it("pinned, carried, overdue, due today or flagged, a row with a job never ranks", () => {
    const onJob = [
      task({ job_id: "job-1", focus_date: TODAY, priority: 2 }),
      task({ job_id: "job-1", focus_date: YESTERDAY }),
      task({ job_id: "job-1", due_date: YESTERDAY }),
      task({ job_id: "job-1", due_date: TODAY }),
      task({ job_id: "job-1", priority: 1 }),
      task({ job_id: "job-1" }),
    ];
    const reminder = task({ due_date: TODAY });
    expect(rankSix([...onJob, reminder], { todayStr: TODAY }).map((t) => t.id)).toEqual([reminder.id]);
  });

  it("the My Day pool never asks for them either: the cut names job_id null and no on-site arm", () => {
    const planner = src("app/(app)/planner/page.tsx");
    expect(planner).toContain('(q as any).is("job_id", null).or(');
    expect(planner).not.toContain("job_id.in.(");
    expect(planner).not.toContain("scheduledJobIds");
  });
});

describe("rankSix: exclusions (what never ranks)", () => {
  it("excludes office from the UNDATED ranks only (a stated date beats the category)", () => {
    const officeFlagged = task({ category: "office", priority: 2 }); // undated → excluded
    const officePlain = task({ category: "office" }); // undated → excluded
    const officeOverdue = task({ category: "office", due_date: YESTERDAY }); // dated → ranks
    const officeDueToday = task({ category: "office", due_date: TODAY }); // dated → ranks
    const officePinned = task({ category: "office", focus_date: TODAY }); // a pin overrides
    const six = rankSix([officeFlagged, officePlain, officeOverdue, officeDueToday, officePinned], { todayStr: TODAY });
    expect(six.map((t) => t.id)).toEqual([officePinned.id, officeOverdue.id, officeDueToday.id]);
  });

  it("subtasks (parent_id set) are never slots — they nest under their parent", () => {
    const child = task({ parent_id: "parent-1", due_date: TODAY, priority: 2 });
    const parent = task({ due_date: TODAY });
    expect(rankSix([child, parent], { todayStr: TODAY }).map((t) => t.id)).toEqual([parent.id]);
  });

  it("drops non-open rows defensively", () => {
    const done = task({ status: "done", due_date: YESTERDAY });
    expect(rankSix([done], { todayStr: TODAY })).toHaveLength(0);
  });
});

describe("rankSix: a TOTAL order, so the list can't shuffle between polls (defect 2)", () => {
  it("the SAME pool handed over in a different sequence comes back identical", () => {
    // Seven pinned, undated, priority-0 rows: under the old comparator these tied all the way down
    // and fell through to whatever order Postgres happened to return, so which six he saw changed
    // while he watched (an UPDATE relocates a row in the heap).
    const pins = Array.from({ length: 7 }, () => task({ focus_date: TODAY }));
    const first = rankSix(pins, { todayStr: TODAY }).map((t) => t.id);
    const shuffled = [...pins].reverse();
    expect(rankSix(shuffled, { todayStr: TODAY }).map((t) => t.id)).toEqual(first);
    const rotated = [...pins.slice(3), ...pins.slice(0, 3)];
    expect(rankSix(rotated, { todayStr: TODAY }).map((t) => t.id)).toEqual(first);
  });

  it("the oldest keeps its place: created_at asc breaks a priority tie", () => {
    const younger = { ...task({ due_date: TODAY }), created_at: "2026-06-30T09:00:00Z" };
    const older = { ...task({ due_date: TODAY }), created_at: "2026-06-02T09:00:00Z" };
    expect(rankSix([younger, older], { todayStr: TODAY }).map((t) => t.id)).toEqual([older.id, younger.id]);
  });

  it("rows created in the same instant still have ONE order: the id decides", () => {
    const stamp = "2026-06-10T09:00:00Z";
    const a = { ...task({ due_date: TODAY }), id: "aaa", created_at: stamp };
    const b = { ...task({ due_date: TODAY }), id: "bbb", created_at: stamp };
    expect(rankSix([b, a], { todayStr: TODAY }).map((t) => t.id)).toEqual(["aaa", "bbb"]);
    expect(rankSix([a, b], { todayStr: TODAY }).map((t) => t.id)).toEqual(["aaa", "bbb"]);
  });

  it("priority still wins over age", () => {
    const old0 = { ...task({ due_date: TODAY, priority: 0 }), created_at: "2026-01-01T00:00:00Z" };
    const new2 = { ...task({ due_date: TODAY, priority: 2 }), created_at: "2026-06-30T00:00:00Z" };
    expect(rankSix([old0, new2], { todayStr: TODAY }).map((t) => t.id)).toEqual([new2.id, old0.id]);
  });

  it("never mutates the caller's array", () => {
    const a = task({ due_date: YESTERDAY });
    const b = task({ focus_date: TODAY });
    const input = [a, b];
    rankSix(input, { todayStr: TODAY });
    expect(input.map((t) => t.id)).toEqual([a.id, b.id]);
  });
});
