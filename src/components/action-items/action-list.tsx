"use client";

import { useId, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Phone } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { Label, Select } from "@/components/ui/input";
import { SHEET_REFUSAL } from "@/components/ui/refusal";
import { MoveToDay } from "@/components/move-to-day";
import { RowMoreSheet, SHEET_ROW } from "@/components/row-more-sheet";
import { ComeBackPicker } from "@/components/come-back-picker";
import { SendSheet } from "@/components/send-sheet";
import { useToast } from "@/components/toast";
import { useLang } from "@/components/lang-provider";
import { dispatchAction } from "@/lib/action-items/dispatch";
import type { DispatchPayload } from "@/lib/action-items/dispatch-map";
import { KIND_GROUP, type ActionItem, type Affordance, type Group, type PileName } from "@/lib/action-items/types";
import { rowButtons, type RowDoor } from "@/lib/action-items/row-buttons";
import { pileUnfoldsHere } from "@/lib/action-items/piles";
import { isUnreadLine, maxLevel, summarize } from "@/lib/action-items/needs-you-rule";
import { pileTitleWords, rowWords } from "@/lib/action-items/row-words";
import { relativeWhen } from "@/lib/action-items/dated-when";
import { translator } from "@/lib/i18n";
import { fillSlots, type Words } from "@/lib/lang-words";
import type { Lang } from "@/lib/locale";
import { DEFAULT_TIMEZONE, formatCurrency } from "@/lib/utils";
import { SupplierPaperCards, SUPPLIER_PAPERS_SCOPE } from "@/components/supplier-paper-cards";
import { AlreadyBilledButton, AlreadyInvoicedSheet } from "@/components/already-billed-sheet";
import { LevelMark } from "./level-mark";
import { KindPicture } from "./kind-picture";
import { NeedsYouCounts, NeedsYouTiles, TILE_NAME_KEY } from "./needs-you-tiles";

/** English, for a caller that hands in no translator (a test, a pure helper). */
const EN = translator("en");

/** The page a pile's See All opens, said by the pile's name in the reader's language. */
const LIST_LABEL_KEY: Partial<Record<PileName, string>> = {
  estimates_not_sent: "ny_btn_seeAllOnEstimates",
  no_answer_yet: "ny_btn_seeAllOnEstimates",
  won_needs_a_day: "ny_btn_seeAllOnEstimates",
  late_invoices: "ny_btn_seeAllOnInvoices",
  invoices_not_sent: "ny_btn_seeAllOnInvoices",
  leads_to_call: "ny_btn_seeAllOnLeads",
  inspections_to_write_up: "ny_btn_seeAllInspections",
  jobs_needing_a_day: "ny_btn_seeAllOnSchedule",
  holds_back: "ny_btn_seeAllOnJobs",
  papers_to_sort: "ny_btn_seeAllOnBills",
  receipts_not_on_a_bill: "ny_btn_seeAllOnBills",
  notes_to_review: "ny_btn_seeAllInOrganize",
  stock_to_settle: "ny_btn_seeAllOnShopStock",
  materials_to_buy: "ny_btn_seeAllMaterials",
};

/** The list's own refusal banner, neutral: on the list's surface red and amber are the marks' alone,
 *  so a red banner among them would read as NOW. A sheet sits above the box and keeps the app's
 *  refusal look (ui/refusal SHEET_REFUSAL), the one MoveToDay, the Send sheet and Come Back draw. */
const BANNER = "rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-900";

/**
 * Friendly relative day for the "when" line; times for datetime values. A thin name for
 * relativeWhen (lib/action-items/dated-when), the one function the rows say their age with, so the
 * hydration and age pins in action-list.test exercise exactly what the rows draw. HYDRATION LAW
 * lives there: no runtime clock or zone, only the server's today and the business timezone.
 */
export function prettyWhen(
  when: string | null | undefined,
  todayStr: string,
  tz: string,
  deadline = true,
  lang: Lang = "en",
  words: Words = EN,
): string | null {
  return relativeWhen(when, todayStr, tz, deadline, { lang, words });
}

/** A row's named button: 44px tall without growing the row (the Call Back negative-margin pattern).
 *  A label longer than the row (Spanish, a narrow phone) wraps inside its own button, right-aligned,
 *  instead of running under the card's edge: max-w-full and text-right are the fallback only. */
export const ROW_BUTTON =
  "-my-3 inline-flex h-11 max-w-full items-center gap-1 rounded-md px-2 text-right text-xs font-semibold leading-tight text-brand hover:bg-brand-light/40 disabled:opacity-50";

type Run = (item: ActionItem, verb: Affordance, payload?: DispatchPayload, opts?: RunOpts) => Promise<{ ok: boolean; error?: string }>;
type RunOpts = {
  /** A pile's child: acting on it drops it (the pile counts down in place), it never sinks. */
  child?: boolean;
  /** Sent from a sheet (⋯, a Snooze or Still Waiting picker, Assign, a confirm, Pick a Day): the
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
 * THE NEEDS YOU BOARD (the redraw, cn-v1161). Top to bottom:
 *
 *   1. The header: the title, then how many to act on today (an octagon), how many soon (a
 *      triangle), and the rest. Each count is drawn only above zero.
 *   2. Act Today: the NOW rows, the few that cost money or a legal right if they wait. Not drawn
 *      when there are none.
 *   3. Four tiles (staff only): Get Paid, Sales, Operations, Bookkeeping. One is open at a
 *      time; a second tap on the open one closes it.
 *   4. The open tile's rows: that group's rows that are not NOW.
 *   (5. The Waiting fold, drawn by the page under this.)
 *
 * THE SERVER'S ORDER (the build sorts once, types.ts sortActionItems), with only the rows ticked done
 * HERE sunk to the bottom. Everything this board shows is a FILTER of that order; it never sorts.
 * The counts are lib/action-items/needs-you-rule summarize() over the LIVE rows (after a row left
 * here, before the server's next list), so the header and the tiles never disagree mid-flight. The
 * tile that opens first comes from the server's rows alone (no clock, no storage, no address), so
 * the server's render and the phone's are the same.
 *
 * ONE NAMED BUTTON PER ROW, AND ⋯ (Wave 1, W1-13). Each row says its verb and keeps only what is
 * real for it behind ⋯; the row table is row-buttons.ts. Tapping the row opens it.
 *
 * PILES (Wave 1, W1-14; piles.ts). "Estimates Not Sent · 6" is one row: its mark, its count, how many
 * are soon, its sum, its verb, the first estimate as a full row, then See All. Acting on a child drops
 * it and counts down in place; the last one takes the pile away.
 *
 * A TECH sees no tiles and no strip (he has one kind in one group): the title, the counts and his
 * rows flat, with no button, no ⋯ and no money.
 */
export function ActionList({
  items,
  people = [],
  emptyLabel,
  todayStr,
  tz = DEFAULT_TIMEZONE,
  leadsOn = true,
  isStaff = false,
  textReady = true,
  title,
  defaultOpen,
}: {
  items: ActionItem[];
  people?: { id: string; full_name: string | null }[];
  emptyLabel?: string;
  /** The business-tz "today" (YYYY-MM-DD), computed ONCE on the server — the only clock this
      component may consult, so SSR and hydration can never disagree about what day it is. */
  todayStr: string;
  /** The ORG's timezone — must be the same clock todayStr was computed in, or a row can
   *  read "Today · 9:00 PM" for an item the day math already counted as tomorrow. */
  tz?: string;
  /** The Leads switch (0352). Off, a request lands here as a request, and Call Back is its button.
   *  Absent = on, as always. */
  leadsOn?: boolean;
  /** The office: tiles, the strip, buttons and money are drawn only for staff. */
  isStaff?: boolean;
  /** The company can text (smsReadiness, read once on the page): the Send sheet's Text It. */
  textReady?: boolean;
  /** The board's heading (the page's own words). */
  title?: string;
  /** The tile open at first. Absent: summarize()'s pick over the server's rows. Null: none. */
  defaultOpen?: Group | null;
}) {
  const router = useRouter();
  const toast = useToast();
  const lang = useLang();
  const t = translator(lang);
  const rowsId = useId();
  const [doneIds, setDoneIds] = useState<Set<string>>(new Set());
  const [removedIds, setRemovedIds] = useState<Set<string>>(new Set());
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openPiles, setOpenPiles] = useState<Set<string>>(new Set());
  // The one tile that is open. Picked once from the server's rows; a refresh keeps the person's pick.
  const [openTile, setOpenTile] = useState<Group | null>(() => (defaultOpen !== undefined ? defaultOpen : summarize(items, { isStaff }).open));
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
      error: t("su_didntReachServer"),
      note: undefined as string | undefined,
    }));
    setBusyId(null);
    setInFlight((s) => without(s, item.id));
    if (!res.ok) {
      const message = res.error ?? t("ny_couldntDoThat");
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

  const rowProps = { todayStr, tz, leadsOn, isStaff, textReady, people, busyId, run, runOnList, removeHere, router, lang, t };

  const kidsOf = (item: ActionItem) => (item.children ?? []).filter((c) => !removedIds.has(c.id)).map((c) => ({ ...c, done: c.done || doneIds.has(c.id) }));

  /** One row of the server's list as it stands here: a plain row, a pile counted down, or nothing. */
  const draw = (item: ActionItem) => {
    if (!item.pile) return <Row key={item.id} item={item} {...rowProps} />;
    const kids = kidsOf(item);
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
  };

  /** What `draw` shows, as a row to count: the same rules, so a count never disagrees with a row. A
   *  pile that lost children wears its remaining children's mark and sum. */
  const live = (item: ActionItem): ActionItem | null => {
    if (!item.pile) return item;
    const kids = kidsOf(item);
    const gone = (item.children ?? []).length - kids.length;
    const count = Math.max(0, item.pile.count - gone);
    if (!kids.length && !item.pile.capped && count <= 0) return null;
    if (kids.length === 1 && !item.pile.capped && count <= 1) return kids[0];
    if (!gone) return item;
    const sum = item.amount == null ? null : kids.reduce((s, k) => s + (k.amount ?? 0), 0);
    return { ...item, level: maxLevel(kids.map((k) => k.level)), amount: sum };
  };

  const rows = visible.map((item) => ({ item, now: live(item) })).filter((r): r is { item: ActionItem; now: ActionItem } => r.now !== null);
  const summary = summarize(
    rows.map((r) => r.now),
    { isStaff },
  );
  const groupOf = (i: ActionItem) => i.group ?? KIND_GROUP[i.kind];
  const strip = isStaff ? rows.filter((r) => r.now.level === "now") : [];
  const inTile = isStaff && openTile ? rows.filter((r) => r.now.level !== "now" && groupOf(r.now) === openTile) : [];
  const tileName = openTile ? t(TILE_NAME_KEY[openTile]) : undefined;

  const header = (
    <div className="flex min-h-11 items-center justify-between gap-3 border-b border-slate-100 px-5 py-2">
      {title ? <h2 className="text-sm font-semibold text-slate-900">{title}</h2> : <span />}
      <NeedsYouCounts summary={summary} />
    </div>
  );

  // NOTHING OPEN HERE: the title and one plain sentence (the Waiting fold, if any, is the page's).
  if (rows.length === 0) {
    return (
      <div>
        {header}
        <p className="px-5 py-3 text-sm text-slate-600">{emptyLabel ?? t("md_nothingNeedsYou")}</p>
      </div>
    );
  }

  return (
    <div>
      {header}
      <div className="space-y-3 p-3">
        {error && (
          <div role="alert" className={BANNER}>
            {error}
          </div>
        )}
        {isStaff ? (
          <>
            {strip.length > 0 && (
              <section aria-label={t("ny_stripTitle")} data-strip="" className="space-y-1.5">
                <h3 className="px-1 text-xs font-semibold text-slate-700">{t("ny_stripTitle")}</h3>
                {strip.map((r) => draw(r.item))}
              </section>
            )}
            <NeedsYouTiles
              tiles={summary.tiles}
              openId={openTile}
              onToggle={(g) => setOpenTile((cur) => (cur === g ? null : g))}
              controlsId={rowsId}
              isStaff={isStaff}
            />
            <div id={rowsId} role="region" aria-label={tileName ?? title ?? t("md_needsYou")} data-group={openTile ?? undefined} className="space-y-1.5">
              {openTile && (inTile.length > 0 ? inTile.map((r) => draw(r.item)) : <p className="px-1 py-2 text-sm text-slate-600">{t("ny_groupEmpty")}</p>)}
            </div>
          </>
        ) : (
          <div className="space-y-1.5">{rows.map((r) => draw(r.item))}</div>
        )}
      </div>
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
  /** The reader's language and its translator. */
  lang: Lang;
  t: Words;
  /** A pile's child: acting on it drops it (the pile counts down in place). */
  nested?: boolean;
};

/**
 * A NAME WHOSE LAST WORD IS A SHORT TAG (" · 3", " · 3+", " · J-061") keeps that tag with the word
 * before it (cn-v1162). A name may run to a second line on a phone now, and left to itself the line
 * broke at the last space: "Cuentas de Proveedores ·" over a lone "3". The words are not changed, only
 * where the line may break.
 */
function Tagged({ text }: { text: string }) {
  const m = /^(.*\S)( · \S{1,8})$/.exec(text);
  if (!m) return <>{text}</>;
  return (
    <>
      {m[1]}
      <span className="whitespace-nowrap">{m[2]}</span>
    </>
  );
}

/** The fixed-width slot a mark sits in, empty when there is none: every row's words start at one x. */
function MarkSlot({ level }: { level: ActionItem["level"] }) {
  return (
    <span className="flex w-4 shrink-0 items-center justify-center" data-mark-slot="">
      <LevelMark level={level} />
    </span>
  );
}

/**
 * One row: the mark slot · the picture slot · WHO in bold · the right edge (the money for staff, else the age), then
 * WHAT in plain weight under it, the ONE named button, and ⋯. A failed read is a row with no mark and
 * no button whose sentence is never cut; it opens the page that can say what it could not.
 */
function Row(p: RowProps) {
  const { item, todayStr, tz, leadsOn } = p;
  const unread = isUnreadLine(item);
  const w = rowWords(item, { lang: p.lang, words: p.t, isStaff: p.isStaff, todayStr, tz });
  // A tech's rows only open: no button, no ⋯.
  const doors = p.isStaff && !unread ? rowButtons(item, { leadsOn, isStaff: p.isStaff, lang: p.lang, words: p.t }) : { primary: null, also: null, more: [] as RowDoor[] };
  const open = () => p.router.push(item.href);
  return (
    <div
      className={`relative flex items-center gap-1 rounded-xl border bg-white py-1.5 pl-2 pr-2 ${
        item.done ? "border-slate-100 opacity-55" : p.nested ? "border-slate-100" : "border-slate-200"
      }`}
      data-row={item.id}
      data-level={item.level ?? "none"}
    >
      {/* TAPPING THE ROW OPENS ITS THING: one target the size of the whole row (44px and up), lying
          under its words; its named buttons and ⋯ sit on top of it. */}
      <button type="button" onClick={open} aria-label={fillSlots(p.t("ny_openRow"), { title: item.title })} className="absolute inset-0 rounded-xl" />
      <div className="pointer-events-none relative min-w-0 flex-1">
        {/* THE TWO SLOTS, THEN THE WORDS (cn-v1162, the owner's mock): [mark 16px] [picture 24px]
            [who / what]. The picture says what there is to do, grey until the row carries a mark, then
            coloured in with its TILE's chip (kind-picture.tsx), so in Act Today it says which tile the
            row is from. Both are centred on the row, and gap-1.5 holds the pair to 28px more than the
            mark alone cost: a 375px phone keeps its words. A failed read (isUnreadLine) asks for no
            action, so its picture slot stays empty, the way its mark slot does.
            WHO MAY RUN TO A SECOND LINE ON A PHONE (seen at 375px in Spanish): cut at one line, the
            28px the picture took turned "Cuentas de Proveedores · 3" into "Cuentas de Proveedore…",
            and what a cut loses is the end, which on a rollup is its count. So a name wraps there and
            is never cut short of its count; the amount stays on the first line (the pair is aligned
            on their baselines). From sm up there is room, and it is one line, as before. */}
        <div className="flex min-w-0 items-center gap-1.5">
          <MarkSlot level={unread ? "none" : item.level} />
          <KindPicture kind={unread ? null : item.kind} group={item.group ?? KIND_GROUP[item.kind]} level={item.level} done={item.done} />
          <div className="min-w-0 flex-1">
            <div className="flex w-full min-w-0 items-baseline gap-2">
              <span className={`line-clamp-2 min-w-0 flex-1 text-sm font-semibold [overflow-wrap:anywhere] sm:line-clamp-1 ${item.done ? "text-slate-600 line-through" : "text-slate-900"}`}>
                <Tagged text={w.who} />
              </span>
              {w.right && (
                <span className={`shrink-0 text-xs tabular-nums ${w.rightKind === "money" ? "font-semibold text-slate-900" : "text-slate-600"}`} data-right={w.rightKind ?? undefined}>
                  {w.right}
                </span>
              )}
            </div>
            {/* AT PHONE WIDTH the buttons keep 9rem of words beside them, or wrap together onto a line
                of their own (right-aligned): a long button never squeezes WHAT to nothing. And WHAT
                may run to a second line there: cut at one, a phone read "offer ends…" with the day
                gone and "needs a…" with the point gone. From sm up there is room, and it is one line.
                THE ⋯ RIDES THIS LINE, AFTER THE BUTTON, never a column of its own beside the row:
                as a column it pushed the amount in by its own width on every row that had one, so
                the money and the ages stepped in and out down the list instead of ending at one
                edge, which is the one place the eye runs down to compare them.
                THE BUTTONS MAY WRAP AMONG THEMSELVES (skeptic #64): at 320px a long Spanish button
                and the ⋯ are wider than the row, and as one unbreakable run the ⋯ slid under the
                card's edge. Each is a 44px target on a 20px line, so two wrapped lines are 24px
                apart (gap-y-6) and neither target lies over the other. Seen at 320px: the button on
                one line, the ⋯ under it at the same right edge. */}
            <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
              {w.what && <div className={`min-w-0 flex-[1_1_9rem] text-xs text-slate-600 ${unread ? "whitespace-normal" : "line-clamp-2 sm:line-clamp-1"}`}>{w.what}</div>}
              {!item.done && (doors.primary || doors.also || doors.more.length > 0) && (
                <div className="pointer-events-auto ml-auto flex max-w-full flex-wrap items-center justify-end gap-x-1 gap-y-6">
                  {doors.primary && <DoorButton {...p} door={doors.primary} />}
                  {doors.also && <DoorButton {...p} door={doors.also} />}
                  {doors.more.length > 0 && (
                    <div className="relative -my-3 -mr-2 flex h-11 items-center">
                      <RowMoreSheet title={item.title} subline={item.subtitle ?? null}>
                        {({ close }) => <MoreSheetBody {...p} doors={doors.more} close={close} />}
                      </RowMoreSheet>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
        {/* A SHIFT ON NO JOB BILLED BY HAND on an invoice with no job (0357): the office says which
            line charged it, right here. */}
        {item.noJobHours && (
          <div className="pointer-events-auto mt-2">
            <AlreadyBilledButton jobId={null} target={{ kind: "time", ids: item.noJobHours.entryIds, what: p.t("ny_thoseHours") }} />
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
    </div>
  );
}

/** A pile: its mark, its picture, "Label · N", how many are soon, its sum, its verb (opens it), the first child in full, then See All. */
function PileRow(p: RowProps & { kids: ActionItem[]; count: number; open: boolean; onToggle: () => void }) {
  const { item, kids, count, open, t } = p;
  const pile = item.pile!;
  const here = pileUnfoldsHere({ count, capped: pile.capped }, kids.length);
  const [first, ...rest] = kids;
  const title = pileTitleWords({ name: pile.name, label: pile.label, count, capped: pile.capped }, { lang: p.lang, words: t });
  // Its mark is its most urgent child's; the count of its SOON children rides beside the label.
  const level = maxLevel(kids.map((k) => k.level));
  const soon = kids.filter((k) => k.level === "soon").length;
  const sum = p.isStaff && kids.length === (item.children ?? []).length && typeof item.amount === "number" && item.amount > 0 ? formatCurrency(item.amount, p.lang) : null;
  const listKey = LIST_LABEL_KEY[pile.name];
  const seeAll = here ? (
    <button type="button" onClick={p.onToggle} aria-expanded={open} className="flex min-h-11 w-full items-center justify-center text-sm font-medium text-brand hover:bg-slate-50">
      {open ? t("ny_btn_seeLess") : fillSlots(t("ny_btn_seeAll"), { n: count })}
    </button>
  ) : pile.listHref ? (
    <Link href={pile.listHref} className="flex min-h-11 w-full items-center justify-center text-sm font-medium text-brand hover:bg-slate-50">
      {listKey ? t(listKey) : fillSlots(t("ny_btn_seeAll"), { n: `${count}${pile.capped ? "+" : ""}` })}
    </Link>
  ) : (
    <button type="button" onClick={p.onToggle} aria-expanded={open} className="flex min-h-11 w-full items-center justify-center text-sm font-medium text-brand hover:bg-slate-50">
      {open ? t("ny_btn_seeLess") : fillSlots(t("ny_btn_seeAllHere"), { n: kids.length })}
    </button>
  );
  const unfold = () => (here || !pile.listHref ? p.onToggle() : p.router.push(pile.listHref));
  // The pile's verb, only when its rows have a button for this viewer (row-buttons.ts).
  const verb = p.isStaff ? rowButtons({ ...item, children: kids }, { leadsOn: p.leadsOn, isStaff: p.isStaff, lang: p.lang, words: t }).primary : null;
  return (
    <div className="rounded-xl border border-slate-200 bg-white" data-pile={pile.name} data-level={level}>
      <div className="relative flex items-center gap-1 py-1.5 pl-2 pr-2">
        {/* The whole header opens the pile: one target the size of the header, under its words. */}
        <button type="button" onClick={unfold} aria-label={title} aria-expanded={here ? open : undefined} className="absolute inset-0 rounded-t-xl" />
        <div className="pointer-events-none relative min-w-0 flex-1">
          {/* Its kind's picture (every pile's kinds share one), coloured in by the pile's own mark. */}
          <div className="flex min-w-0 items-center gap-1.5">
            <MarkSlot level={level} />
            <KindPicture kind={item.kind} group={item.group ?? KIND_GROUP[item.kind]} level={level} />
            <div className="min-w-0 flex-1">
              <div className="flex w-full min-w-0 items-baseline gap-2">
                <span className="line-clamp-2 min-w-0 flex-1 text-sm font-semibold text-slate-900 [overflow-wrap:anywhere] sm:line-clamp-1">
                  <Tagged text={title} />
                </span>
                {sum && (
                  <span className="shrink-0 text-xs font-semibold tabular-nums text-slate-900" data-right="money">
                    {sum}
                  </span>
                )}
              </div>
              <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
                <div className="min-w-0 flex-[1_1_9rem] truncate text-xs text-slate-600">
                  {soon > 0 && level !== "now" && <span data-soon-count={soon}>{fillSlots(t(soon === 1 ? "ny_countDueOne" : "ny_countDue"), { n: soon })}</span>}
                </div>
                {verb && (
                  <button type="button" onClick={unfold} className={`${ROW_BUTTON} pointer-events-auto ml-auto`}>
                    {verb.label}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
      {first && (
        <div className="space-y-1.5 border-t border-slate-100 px-1.5 py-1.5">
          {/* ONE KEYED LIST: the first child is keyed like the rest, so when it changes (a removal, a
              refusal putting a row back, a refresh) an open sheet closes with its own row and never
              confirms on the record that took its place. */}
          {[first, ...(open ? rest : [])].map((c) => (
            <Row key={c.id} {...p} item={c} nested />
          ))}
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
      <MoveToDay label={door.label} triggerClassName={ROW_BUTTON} onPick={async (d) => (d ? p.run(item, a.verb, { date: d }, { child: p.nested, sheet: true }) : { ok: false, error: p.t("ny_pickADay") })}>
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
  if (a.type === "alreadyInvoiced") return <AlreadyInvoicedDoor {...p} door={door} className={ROW_BUTTON} />;
  // comeBack, assign, confirm: the door's question in its own sheet.
  return (
    <>
      <button type="button" onClick={() => setSheet(true)} disabled={busy} className={ROW_BUTTON}>
        {door.label}
      </button>
      <Modal open={sheet} onClose={() => setSheet(false)} title={sheetTitle(door, item, p.t)} size="sm">
        {sheet && <DoorForm {...p} door={door} onBack={() => setSheet(false)} onDone={() => setSheet(false)} />}
      </Modal>
    </>
  );
}

function sheetTitle(door: RowDoor, item: ActionItem, t: Words): string {
  if (door.act.type === "confirm") return door.act.title;
  if (door.act.type === "assign") return t("ny_btn_assignTitle");
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
      {err && (
        <div role="alert" className={`mb-2 ${SHEET_REFUSAL}`}>
          {err}
        </div>
      )}
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
        if (a.type === "alreadyInvoiced") return <AlreadyInvoicedDoor key={d.label} {...p} door={d} className={SHEET_ROW} after={p.close} />;
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
                else setErr(r.error ?? p.t("ny_couldntDoThat"));
              }}
            >
              {d.label}
            </button>
          );
        }
        return (
          <button key={d.label} type="button" className={SHEET_ROW} onClick={() => setAsking(d)}>
            {d.label}
          </button>
        );
      })}
    </>
  );
}

/**
 * ALREADY INVOICED: the sheet of the customer's live invoices; the one picked is tied to the row's
 * work (a real fact), the answer is said as a toast, and the row leaves on the refresh. A refusal is
 * said on the sheet itself.
 */
function AlreadyInvoicedDoor(p: RowProps & { door: RowDoor; className: string; after?: () => void }) {
  const [open, setOpen] = useState(false);
  const toast = useToast();
  const a = p.door.act;
  if (a.type !== "alreadyInvoiced") return null;
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={p.className}>
        {p.door.label}
      </button>
      {open && (
        <AlreadyInvoicedSheet
          target={a.target}
          onClose={() => setOpen(false)}
          onTied={(message) => {
            setOpen(false);
            p.removeHere(p.item.id);
            toast(message, "success");
            p.router.refresh();
            p.after?.();
          }}
        />
      )}
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
    else setErr(r.error ?? p.t("ny_couldntDoThat"));
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
        {err && (
          <div role="alert" className={SHEET_REFUSAL}>
            {err}
          </div>
        )}
        <div>
          <Label htmlFor={`assign-${item.id}`}>{p.t("ny_person")}</Label>
          <Select id={`assign-${item.id}`} value={person} onChange={(e) => setPerson(e.target.value)}>
            <option value="">{p.t("ny_pickAPerson")}</option>
            {p.people.map((x) => (
              <option key={x.id} value={x.id}>
                {x.full_name ?? p.t("ny_unnamed")}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" onClick={() => send("assign", { assignee: person })} disabled={pending || !person}>
            {pending ? p.t("ny_saving") : p.t("ny_btn_assign")}
          </Button>
          <Button type="button" variant="ghost" onClick={p.onBack} disabled={pending}>
            {p.t("ny_btn_back")}
          </Button>
        </div>
      </div>
    );
  }
  if (a.type === "confirm") {
    return (
      <div className="space-y-3">
        <p className="text-sm text-slate-600">{a.body}</p>
        {err && (
          <div role="alert" className={SHEET_REFUSAL}>
            {err}
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="destructive" onClick={() => send(a.verb)} disabled={pending}>
            {pending ? p.t("ny_saving") : a.button}
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
