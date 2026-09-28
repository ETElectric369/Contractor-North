"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Phone } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { Label, Select } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { MoveToDay } from "@/components/move-to-day";
import { RowMoreSheet, SHEET_ROW } from "@/components/row-more-sheet";
import { ComeBackPicker } from "@/components/come-back-picker";
import { SendSheet } from "@/components/send-sheet";
import { useToast } from "@/components/toast";
import { dispatchAction } from "@/lib/action-items/dispatch";
import type { DispatchPayload } from "@/lib/action-items/dispatch-map";
import { KIND_META, chipOf, type ActionItem, type Affordance } from "@/lib/action-items/types";
import { rowButtons, type RowDoor } from "@/lib/action-items/row-buttons";
import { pileAges, pileTitle, pileUnfoldsHere } from "@/lib/action-items/piles";
import { DEFAULT_TIMEZONE } from "@/lib/utils";
import { SupplierPaperCards, SUPPLIER_PAPERS_SCOPE } from "@/components/supplier-paper-cards";
import { AlreadyBilledButton } from "@/components/already-billed-sheet";

/**
 * Friendly relative day for the "when" line; times for datetime values.
 *
 * HYDRATION LAW: this runs during SSR (Vercel, UTC) AND in the browser (Pacific), and React
 * #418s on any text difference — which is exactly what happened every evening ("Today" on one
 * side, "Tomorrow" on the other) and for timed items all day (UTC vs local clock formatting).
 * So nothing here may consult the runtime's clock or timezone: "today" comes from the
 * server-computed business-tz `todayStr` prop, date-only values are compared as noon-UTC
 * instants (tz-independent difference), and all display formatting pins the business timezone.
 */
function prettyWhen(when: string | null | undefined, todayStr: string, tz: string): string | null {
  if (!when) return null;
  const hasTime = when.includes("T");
  const d = hasTime ? new Date(when) : new Date(`${when}T12:00:00Z`);
  if (isNaN(d.getTime())) return null;
  const dayStr = hasTime
    ? d.toLocaleDateString("en-CA", { timeZone: tz }) // en-CA = YYYY-MM-DD
    : when;
  const diffDays = Math.round((Date.parse(`${dayStr}T12:00:00Z`) - Date.parse(`${todayStr}T12:00:00Z`)) / 86_400_000);
  const rel =
    diffDays < 0
      ? `${-diffDays}d overdue`
      : diffDays === 0
        ? "Today"
        : diffDays === 1
          ? "Tomorrow"
          : d.toLocaleDateString("en-US", { timeZone: hasTime ? tz : "UTC", weekday: "short", month: "short", day: "numeric" });
  if (hasTime) {
    const t = d.toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" });
    return diffDays === 0 ? t : `${rel} · ${t}`;
  }
  return rel;
}

/** A row's named button: 44px tall without growing the row (the Call Back negative-margin pattern). */
export const ROW_BUTTON =
  "-my-3 inline-flex h-11 shrink-0 items-center gap-1 rounded-md px-2 text-xs font-semibold text-brand hover:bg-brand-light/40 disabled:opacity-50";

type Run = (item: ActionItem, verb: Affordance, payload?: DispatchPayload, opts?: RunOpts) => Promise<{ ok: boolean; error?: string }>;
type RunOpts = {
  /** A pile's child: acting on it drops it (the pile counts down in place), it never sinks. */
  child?: boolean;
  /** Sent from a sheet (⋯, a Snooze or Still Waiting picker, Assign, a confirm, Pick A Day): the
   *  sheet lives inside its row, and it says the refusal. */
  sheet?: boolean;
};

/**
 * WHAT A ROW DOES WHEN A VERB IS SENT (pure, so it is tested whole):
 *   · hides: "sink" (Called or Close Out on a plain row: ticked done, sunk to the bottom), "remove"
 *     (it leaves: the verb ends it or gives it a day), or "none" (Assign: crew puts nothing ahead of a
 *     job, so the server keeps the row, and hiding it here would drop a job that still has no day
 *     off the list while the badge still counts it);
 *   · optimistic: hide it now, before the server answers. Only a bare button's verb is: a sheet's
 *     verb waits for the answer, because the sheet lives inside its row, and hiding the row first
 *     would take the sheet (and the refusal it has to say) with it.
 */
export function verbLanding(item: Pick<ActionItem, "kind">, verb: Affordance, opts?: RunOpts): { hides: "sink" | "remove" | "none"; optimistic: boolean } {
  const hides = verb === "assign" ? "none" : verb === "do" && !opts?.child && (item.kind === "inquiry" || item.kind === "appointment") ? "sink" : "remove";
  return { hides, optimistic: hides !== "none" && !opts?.sheet };
}

/**
 * THE SERVER'S LIST DECIDES WHAT SHOWS. When a fresh list arrives (router.refresh after a verb, the
 * page coming back into view), the rows hidden here are shown again unless their verb is still on
 * its way: a row the server dropped isn't in the new list anyway, and one it kept (a Snooze to
 * today, a verb that didn't end it) is back instead of hidden while the badge counts it.
 */
export function keepInFlight(hidden: Set<string>, inFlight: Set<string>): Set<string> {
  return new Set([...hidden].filter((id) => inFlight.has(id)));
}

/**
 * The one "needs action" list (Needs You on My Day). Renders the NOW list IN THE ORDER THE SERVER SENT
 * IT (the build sorts once: money, leads, today, other; then urgency; then oldest first), only
 * sinking the rows ticked done here.
 *
 * ONE NAMED BUTTON PER ROW, AND ⋯ (Wave 1, W1-13). Each row says its verb ("Send It", "Pick A Day",
 * "Close Out") and keeps only what is real for it behind lane 1a's ⋯: a Snooze that picks a day,
 * Assign, and its honest ending behind a confirm. The row table is row-buttons.ts, so this list and
 * anything else that names a row's doors read one table. Tapping the row opens it.
 *
 * PILES (Wave 1, W1-14; piles.ts). "Estimates Not Sent · 6" is one row: its count, a pip per estimate
 * (amber when it has waited over a week), the first estimate as a full row with its own button and
 * ⋯, then See All, which unfolds the rest in place (a second tap folds them) or, when not every
 * estimate is here, opens the list page. Acting on a child drops it and counts down in place; the
 * last one takes the pile away.
 *
 * ONE FLAT LIST OF PLAIN CHIPS (Wave 1, W1-15): no section headers; each row's chip says the state
 * it is in.
 */
export function ActionList({
  items,
  people = [],
  emptyLabel = "All caught up.",
  todayStr,
  tz = DEFAULT_TIMEZONE,
  leadsOn = true,
  isStaff = false,
  textReady = true,
}: {
  items: ActionItem[];
  people?: { id: string; full_name: string | null }[];
  emptyLabel?: string;
  /** The business-tz "today" (YYYY-MM-DD), computed ONCE on the server — the only clock this
      component may consult, so SSR and hydration can never disagree about what day it is. */
  todayStr: string;
  /** The ORG's timezone — must be the same clock todayStr was computed in, or a chip can
   *  read "Today · 9:00 PM" for an item the day math already counted as tomorrow. */
  tz?: string;
  /** The Leads switch (0352). Off, a request lands here as a request: its chip reads Request, and
   *  Call Back is its button. Absent = on, as always. */
  leadsOn?: boolean;
  /** The office: a row's money doors (Pay <Supplier>) are drawn only for staff. */
  isStaff?: boolean;
  /** The company can text (smsReadiness, read once on the page): the Send sheet's Text It. */
  textReady?: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [doneIds, setDoneIds] = useState<Set<string>>(new Set());
  const [removedIds, setRemovedIds] = useState<Set<string>>(new Set());
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openPiles, setOpenPiles] = useState<Set<string>>(new Set());
  // Rows whose verb is still on its way to the server (keepInFlight).
  const [inFlight, setInFlight] = useState<Set<string>>(new Set());
  // A FRESH LIST FROM THE SERVER shows every row it holds, except those whose verb is still on its
  // way (keepInFlight): state adjusted while rendering, so no frame draws the stale hidden set.
  const [seenItems, setSeenItems] = useState(items);
  if (seenItems !== items) {
    setSeenItems(items);
    setRemovedIds((s) => keepInFlight(s, inFlight));
    setDoneIds((s) => keepInFlight(s, inFlight));
  }

  const without = (s: Set<string>, id: string) => {
    const n = new Set(s);
    n.delete(id);
    return n;
  };

  /** Send a verb (verbLanding says how its row lands). A bare button's verb is optimistic: the row
   *  leaves now (a plain row's Called or Close Out sinks to the bottom instead) and comes back if the
   *  server says no, and the refusal is said on the list. A sheet's verb waits for the server, so the
   *  sheet is still there to say the refusal. A pile's child leaves: its pile counts down in place. */
  const run: Run = async (item, verb, payload, opts) => {
    setError(null);
    setBusyId(item.id);
    const landing = verbLanding(item, verb, opts);
    const hide = () => {
      if (landing.hides === "sink") setDoneIds((s) => new Set(s).add(item.id));
      else if (landing.hides === "remove") setRemovedIds((s) => new Set(s).add(item.id));
    };
    setInFlight((s) => new Set(s).add(item.id));
    if (landing.optimistic) hide();
    const res = await dispatchAction({ kind: item.kind, id: item.id, verb, payload, target: item.targetId ?? null }).catch(() => ({
      ok: false,
      error: "That didn't reach the server - check your connection and try again.",
      note: undefined as string | undefined,
    }));
    setBusyId(null);
    setInFlight((s) => without(s, item.id));
    if (!res.ok) {
      const message = res.error ?? "Couldn't do that.";
      setDoneIds((s) => without(s, item.id));
      setRemovedIds((s) => without(s, item.id));
      // NOTHING SILENT: a row hidden before the answer took no sheet along, so the list says it.
      if (!opts?.sheet) setError(message);
      return { ok: false, error: message };
    }
    if (!landing.optimistic) hide();
    // NOTHING SILENT: what the action says it did (a finished job's draft, what isn't billed yet).
    if (res.note) toast(res.note, "info", undefined, { sticky: true });
    router.refresh();
    return { ok: true };
  };
  /** A verb straight from a button (no sheet to hold its refusal): run() says it on the list. */
  const runOnList = async (item: ActionItem, verb: Affordance, opts?: { child?: boolean }) => {
    await run(item, verb, undefined, opts);
  };
  const removeHere = (id: string) => setRemovedIds((s) => new Set(s).add(id));

  // THE SERVER'S ORDER (the build sorts once, types.ts sortActionItems), with only the rows ticked
  // done HERE sunk to the bottom, in their own order.
  const shown = items.filter((i) => !removedIds.has(i.id)).map((i) => ({ ...i, done: i.done || doneIds.has(i.id) }));
  const visible = [...shown.filter((i) => !i.done), ...shown.filter((i) => i.done)];

  const rowProps = { todayStr, tz, leadsOn, isStaff, textReady, people, busyId, run, runOnList, removeHere, router };

  const drawn = visible
    .map((item) => {
      if (!item.pile) return <Row key={item.id} item={item} {...rowProps} />;
      const kids = (item.children ?? []).filter((c) => !removedIds.has(c.id)).map((c) => ({ ...c, done: c.done || doneIds.has(c.id) }));
      const gone = (item.children ?? []).length - kids.length;
      const count = Math.max(0, item.pile.count - gone);
      // The last child takes the pile away; a lone one left is a plain row, never "· 1".
      if (!kids.length && !item.pile.capped && count <= 0) return null;
      if (kids.length === 1 && !item.pile.capped && count <= 1) return <Row key={kids[0].id} item={kids[0]} {...rowProps} />;
      return (
        <PileRow
          key={item.id}
          item={item}
          kids={kids}
          count={count}
          open={openPiles.has(item.id)}
          onToggle={() => setOpenPiles((s) => (s.has(item.id) ? without(s, item.id) : new Set(s).add(item.id)))}
          {...rowProps}
        />
      );
    })
    .filter(Boolean);

  if (drawn.length === 0) return <p className="px-1 py-2 text-sm text-slate-400">{emptyLabel}</p>;

  return (
    <div className="space-y-1.5">
      {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
      {drawn}
    </div>
  );
}

type RowProps = {
  item: ActionItem;
  todayStr: string;
  tz: string;
  leadsOn: boolean;
  isStaff: boolean;
  textReady: boolean;
  people: { id: string; full_name: string | null }[];
  busyId: string | null;
  run: Run;
  runOnList: (item: ActionItem, verb: Affordance, opts?: { child?: boolean }) => Promise<void>;
  removeHere: (id: string) => void;
  router: ReturnType<typeof useRouter>;
  /** A pile's child: acting on it drops it (the pile counts down in place). */
  nested?: boolean;
};

/** One row: two lines (who/what and when; its chip, its context and its button), then ⋯. */
function Row(p: RowProps) {
  const { item, todayStr, tz, leadsOn } = p;
  const meta = KIND_META[item.kind];
  // The row's own words when its state has them, else its kind's; a request with Leads off
  // reads Request even on a row built without its chip.
  const chip = item.kind === "inquiry" && !leadsOn && !item.chip ? "Request" : chipOf(item);
  const when = prettyWhen(item.when, todayStr, tz);
  const overdue = item.when && !item.when.includes("T") && item.when < todayStr;
  const doors = rowButtons(item, { leadsOn, isStaff: p.isStaff });
  const open = () => p.router.push(item.href);
  return (
    <div
      className={`relative flex items-center gap-1 rounded-xl border bg-white py-1.5 pl-3 pr-1 ${
        item.done ? "border-slate-100 opacity-55" : p.nested ? "border-slate-100" : "border-slate-200"
      }`}
    >
      {/* TAPPING THE ROW OPENS ITS THING: one target the size of the whole row (44px and up), lying
          under its words; its named buttons and ⋯ sit on top of it. */}
      <button type="button" onClick={open} aria-label={`Open ${item.title}`} className="absolute inset-0 rounded-xl" />
      {/* TWO LINES, THE LEAD-BOARD SHAPE. Line 1 is WHO/WHAT with the date hard right in mono so the
          column reads down the page; line 2 is the chip, the context and the row's one button. */}
      <div className="pointer-events-none relative min-w-0 flex-1">
        <div className="flex w-full min-w-0 items-baseline gap-2">
          <span className={`min-w-0 flex-1 truncate text-sm ${item.done ? "text-slate-400 line-through" : "font-medium text-slate-900"}`}>
            {item.urgency >= 2 && !item.done && <span className="mr-1 text-red-500">!</span>}
            {item.title}
          </span>
          {when && (
            <span className={`shrink-0 font-mono text-[11px] tabular-nums ${overdue ? "font-semibold text-red-600" : "text-slate-400"}`}>{when}</span>
          )}
        </div>
        {/* AT PHONE WIDTH the buttons keep 9rem of context beside them, or wrap together onto a line
            of their own (right-aligned): a long button never squeezes the subtitle to nothing. */}
        <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
          <div className="flex min-w-0 flex-[1_1_9rem] items-center gap-1.5 truncate text-xs text-slate-500">
            <Badge tone={meta.tone}>{chip}</Badge>
            {item.subtitle && <span className="truncate">{item.subtitle}</span>}
            {item.who && <span className="truncate">· {item.who}</span>}
          </div>
          {!item.done && (doors.primary || doors.also) && (
            <div className="pointer-events-auto ml-auto flex shrink-0 items-center gap-1">
              {doors.primary && <DoorButton {...p} door={doors.primary} />}
              {doors.also && <DoorButton {...p} door={doors.also} />}
            </div>
          )}
        </div>
        {/* A SHIFT ON NO JOB BILLED BY HAND on an invoice with no job (0357, TTUSD on INV-055): the
            office says which line charged it, right here. */}
        {item.noJobHours && (
          <div className="pointer-events-auto mt-2">
            <AlreadyBilledButton jobId={null} target={{ kind: "time", ids: item.noJobHours.entryIds, what: "Those hours" }} />
          </div>
        )}
        {/* THE SUPPLIER BILLS ROLLUP carries its cards inside it: one line on the badge, every paper
            answerable right here with one tap (Bills plan, Wave A). ONE card at a time (readable at
            60mph); the rest are a link to /bills, which draws them all. */}
        {item.kind === "supplier_paper" && item.supplierPapers && (
          <div className="pointer-events-auto mt-2">
            <SupplierPaperCards feed={item.supplierPapers} refreshAfter={false} scope={SUPPLIER_PAPERS_SCOPE} limit={1} moreHref="/bills#needs-you" />
          </div>
        )}
      </div>
      {!item.done && doors.more.length > 0 && (
        <div className="relative">
          <RowMoreSheet title={item.title} subline={item.subtitle ?? null}>
            {({ close }) => <MoreSheetBody {...p} doors={doors.more} close={close} />}
          </RowMoreSheet>
        </div>
      )}
    </div>
  );
}

/** A pile: its count and pips, its verb (opens it), the first child in full, then See All. */
function PileRow(p: RowProps & { kids: ActionItem[]; count: number; open: boolean; onToggle: () => void }) {
  const { item, kids, count, open } = p;
  const pile = item.pile!;
  const here = pileUnfoldsHere({ count, capped: pile.capped }, kids.length);
  const { pips, more } = pileAges(kids, p.todayStr);
  const [first, ...rest] = kids;
  const title = pileTitle({ label: pile.label, count, capped: pile.capped });
  const seeAll = here ? (
    <button type="button" onClick={p.onToggle} aria-expanded={open} className="flex min-h-11 w-full items-center justify-center text-sm font-medium text-brand hover:bg-slate-50">
      {open ? "See Less" : `See All ${count}`}
    </button>
  ) : pile.listHref ? (
    <Link href={pile.listHref} className="flex min-h-11 w-full items-center justify-center text-sm font-medium text-brand hover:bg-slate-50">
      {pile.listLabel ?? `See All ${count}${pile.capped ? "+" : ""}`}
    </Link>
  ) : (
    <button type="button" onClick={p.onToggle} aria-expanded={open} className="flex min-h-11 w-full items-center justify-center text-sm font-medium text-brand hover:bg-slate-50">
      {open ? "See Less" : `See All ${kids.length} Here`}
    </button>
  );
  const unfold = () => (here || !pile.listHref ? p.onToggle() : p.router.push(pile.listHref));
  // The pile's verb, only when its rows have a button for this viewer (row-buttons.ts).
  const verb = rowButtons({ ...item, children: kids }, { leadsOn: p.leadsOn, isStaff: p.isStaff }).primary;
  return (
    <div className="rounded-xl border border-slate-200 bg-white" data-pile={pile.name}>
      <div className="relative flex items-center gap-1 py-1.5 pl-3 pr-1">
        {/* The whole header opens the pile: one target the size of the header, under its words. */}
        <button type="button" onClick={unfold} aria-label={title} aria-expanded={here ? open : undefined} className="absolute inset-0 rounded-t-xl" />
        <div className="pointer-events-none relative min-w-0 flex-1">
          <div className="flex w-full min-w-0 items-baseline gap-2">
            <span className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-900">
              {item.urgency >= 2 && <span className="mr-1 text-red-500">!</span>}
              {title}
            </span>
          </div>
          <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
            <div className="flex min-w-0 flex-[1_1_9rem] items-center gap-1.5 truncate text-xs text-slate-500">
              {/* TEXT TO VISUAL: one pip per row in the pile, amber once it has waited over a week. */}
              <span className="inline-flex shrink-0 items-center gap-0.5" aria-label={`${pips.filter((x) => x === "old").length} waiting over a week`}>
                {pips.map((age, i) => (
                  <span key={i} data-pip={age} className={`h-1.5 w-1.5 rounded-full ${age === "old" ? "bg-amber-500" : "bg-slate-300"}`} />
                ))}
                {more && <span className="text-[10px] font-semibold text-slate-400">+</span>}
              </span>
              {item.subtitle && <span className="truncate">{item.subtitle}</span>}
            </div>
            {verb && (
              <button type="button" onClick={unfold} className={`${ROW_BUTTON} pointer-events-auto ml-auto`}>
                {verb.label}
              </button>
            )}
          </div>
        </div>
      </div>
      {first && (
        <div className="space-y-1.5 border-t border-slate-100 px-1.5 py-1.5">
          <Row {...p} item={first} nested />
          {open && rest.map((c) => <Row key={c.id} {...p} item={c} nested />)}
        </div>
      )}
      {(rest.length > 0 || !here) && <div className="border-t border-slate-100">{seeAll}</div>}
    </div>
  );
}

/** A row's named button, whatever its door does. */
function DoorButton(p: RowProps & { door: RowDoor }) {
  const { door, item } = p;
  const [sheet, setSheet] = useState(false);
  const [sendOpen, setSendOpen] = useState(false);
  const busy = p.busyId === item.id;
  const a = door.act;
  if (a.type === "open") {
    return (
      <Link href={a.href} className={ROW_BUTTON}>
        {door.label}
      </Link>
    );
  }
  if (a.type === "call") {
    return (
      <a href={`tel:${a.tel}`} className={ROW_BUTTON}>
        <Phone className="h-3.5 w-3.5 shrink-0" /> {door.label}
      </a>
    );
  }
  if (a.type === "run") {
    return (
      <button type="button" onClick={() => p.runOnList(item, a.verb, { child: p.nested })} disabled={busy} className={ROW_BUTTON}>
        {door.label}
      </button>
    );
  }
  if (a.type === "pickDay") {
    return (
      <MoveToDay label={door.label} triggerClassName={ROW_BUTTON} onPick={async (d) => (d ? p.run(item, a.verb, { date: d }, { child: p.nested, sheet: true }) : { ok: false, error: "Pick a day." })}>
        {door.label}
      </MoveToDay>
    );
  }
  if (a.type === "send") {
    const s = item.send;
    return (
      <>
        <button type="button" onClick={() => setSendOpen(true)} className={ROW_BUTTON}>
          {door.label}
        </button>
        {s && (
          <SendSheet
            open={sendOpen}
            onClose={() => setSendOpen(false)}
            kind={s.kind}
            id={s.id}
            number={s.number}
            customerName={s.customerName}
            amount={s.amount}
            lineCount={s.lineCount}
            openHref={s.openHref}
            textReady={p.textReady}
            onSent={() => p.removeHere(item.id)}
          />
        )}
      </>
    );
  }
  if (a.type === "unfold") return null; // a pile draws its own
  // comeBack, assign, confirm: the door's question in its own sheet.
  return (
    <>
      <button type="button" onClick={() => setSheet(true)} disabled={busy} className={ROW_BUTTON}>
        {door.label}
      </button>
      <Modal open={sheet} onClose={() => setSheet(false)} title={sheetTitle(door, item)} size="sm">
        {sheet && <DoorForm {...p} door={door} onBack={() => setSheet(false)} onDone={() => setSheet(false)} />}
      </Modal>
    </>
  );
}

function sheetTitle(door: RowDoor, item: ActionItem): string {
  if (door.act.type === "confirm") return door.act.title;
  if (door.act.type === "assign") return "Assign To";
  return `${door.label}: ${item.title}`.slice(0, 80);
}

/** What ⋯ holds: one 44px row per door; a door with a question asks it right here. */
function MoreSheetBody(p: RowProps & { doors: RowDoor[]; close: () => void }) {
  const [asking, setAsking] = useState<RowDoor | null>(null);
  const [err, setErr] = useState<string | null>(null);
  if (asking) return <DoorForm {...p} door={asking} onBack={() => setAsking(null)} onDone={p.close} />;
  return (
    <>
      {/* A refused verb says why right here: the row (and this sheet) stay until the server answers. */}
      {err && <div className="mb-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{err}</div>}
      {p.doors.map((d) => {
        const a = d.act;
        if (a.type === "open") {
          return (
            <Link key={d.label} href={a.href} className={SHEET_ROW}>
              {d.label}
            </Link>
          );
        }
        if (a.type === "call") {
          return (
            <a key={d.label} href={`tel:${a.tel}`} className={SHEET_ROW}>
              <Phone className="mr-2 h-4 w-4 shrink-0" /> {d.label}
            </a>
          );
        }
        if (a.type === "run") {
          return (
            <button
              key={d.label}
              type="button"
              className={SHEET_ROW}
              disabled={p.busyId === p.item.id}
              onClick={async () => {
                setErr(null);
                const r = await p.run(p.item, a.verb, undefined, { child: p.nested, sheet: true });
                if (r.ok) p.close();
                else setErr(r.error ?? "Couldn't do that.");
              }}
            >
              {d.label}
            </button>
          );
        }
        return (
          <button key={d.label} type="button" className={`${SHEET_ROW} ${a.type === "confirm" ? "text-red-700 hover:text-red-700" : ""}`} onClick={() => setAsking(d)}>
            {d.label}
          </button>
        );
      })}
    </>
  );
}

/** A door's question: when it comes back, who, or "are you sure?". Its refusal is said right here. */
function DoorForm(p: RowProps & { door: RowDoor; onBack: () => void; onDone: () => void }) {
  const { door, item } = p;
  const a = door.act;
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [person, setPerson] = useState("");
  const send = async (verb: Affordance, payload?: DispatchPayload) => {
    setErr(null);
    setPending(true);
    const r = await p.run(item, verb, payload, { child: p.nested, sheet: true });
    setPending(false);
    if (r.ok) p.onDone();
    else setErr(r.error ?? "Couldn't do that.");
  };
  if (a.type === "comeBack") {
    return (
      <ComeBackPicker
        label={a.button}
        askWhy={a.askWhy}
        initialWhy={item.holdReason ?? ""}
        todayStr={p.todayStr}
        pending={pending}
        error={err}
        onCancel={p.onBack}
        onSubmit={({ why, when }) => send(a.verb, { date: "date" in when ? when.date : undefined, reason: why || undefined })}
      />
    );
  }
  if (a.type === "assign") {
    // NEVER on the unpicked default: for a job, an empty assignee is job.assign's clear-the-whole-crew
    // branch (written for the agent). The button waits for a person (blocksCrewWipe is the belt).
    return (
      <div className="space-y-3">
        {err && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{err}</div>}
        <div>
          <Label htmlFor={`assign-${item.id}`}>Person</Label>
          <Select id={`assign-${item.id}`} value={person} onChange={(e) => setPerson(e.target.value)}>
            <option value="">— Pick a person —</option>
            {p.people.map((x) => (
              <option key={x.id} value={x.id}>
                {x.full_name ?? "Unnamed"}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" onClick={() => send("assign", { assignee: person })} disabled={pending || !person}>
            {pending ? "Saving…" : "Assign"}
          </Button>
          <Button type="button" variant="ghost" onClick={p.onBack} disabled={pending}>
            Back
          </Button>
        </div>
      </div>
    );
  }
  if (a.type === "confirm") {
    return (
      <div className="space-y-3">
        <p className="text-sm text-slate-600">{a.body}</p>
        {err && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{err}</div>}
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="destructive" onClick={() => send(a.verb)} disabled={pending}>
            {pending ? "Saving…" : a.button}
          </Button>
          <Button type="button" variant="ghost" onClick={p.onBack} disabled={pending}>
            {a.keep}
          </Button>
        </div>
      </div>
    );
  }
  return null;
}
