"use client";

import { useMemo, useState } from "react";
import { X } from "lucide-react";
import { Input, Select } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { formatCurrency } from "@/lib/utils";
import { describeChoice, priceBookLine, type BookPricing } from "@/lib/pricing/item-options";
import { laborRateFor, laborRateFromWords, type LaborRateFrom } from "@/lib/pricing/labor-rate";
import {
  detailExplains,
  laborMoney,
  lineFromDetail,
  lineNameWithUnits,
  lineQty,
  partMoney,
  reexpandTaskDetail,
  taskMoney,
  type TaskKit,
} from "@/lib/estimate/task-lines";
import { rowForWho, type RuleInputs } from "@/lib/estimate/reprice-rows";
import { kitFromTaskDetail, kitNameFromLine, kitSummary } from "@/lib/estimate/kit-from-task";
import { rememberTaskAsKit } from "../price-list/kit-actions";
import type { DraftLineItem, TaskDetail, TaskDetailMaterial, TaskLabor } from "@/lib/estimate/line-map";

export interface PriceItemLite {
  id: string;
  code: string | null;
  description: string;
  category?: string | null;
  unit: string;
  buy_price: number;
  markup_pct: number;
}

/** ONE PERSON ON THE TEAM, for a labor row's Who select (cn-v1131): their own bill rate (Team page)
 *  is the top rung of the one labor-rate rule, so a row that names them prices at it. */
export interface PersonOption {
  id: string;
  name: string;
  billRate: number | null;
}

/** SWAP A LINE AGAINST THE BOOK (Andrew, live-testing the plan take-off: "we ended up going
 *  with a metal roof ... had that been a drop down, I would have just dropped it in there —
 *  or at the very least an autocomplete"): the description input of every line autocompletes
 *  against the org's price book; picking a match RE-PRICES the line in place — description,
 *  unit, and unit $ at this customer's markup, the same math as the Add picker. */
export function LineDescInput({
  value,
  onText,
  onPick,
  onBlur,
  onFocus,
  autoFocus,
  disabled,
  priceItems,
  pricing,
  placeholder = "Description",
  className,
}: {
  value: string;
  onText: (v: string) => void;
  onPick: (p: PriceItemLite) => void;
  /** After the box loses focus (the dropdown's own close still runs). The editor commits the line
   *  here; a task's part drops a row he left nameless. */
  onBlur?: () => void;
  /** When the box takes focus. Add A Task uses it to let go of the line it just focused. */
  onFocus?: () => void;
  /** Focus this box as it mounts: the line Add A Task just made is the one he is about to name. */
  autoFocus?: boolean;
  /** While a write is on the wire (the one save model): the box waits with the rest of the form. */
  disabled?: boolean;
  priceItems: PriceItemLite[];
  /** The document's pricing (customer level + org default): each row shows priceBookLine's price,
   *  the same number the pick writes. */
  pricing: BookPricing;
  /** The same box, standing in for something smaller than a line: a task's PART. */
  placeholder?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  // BROWSE, DON'T GUESS — the same rule the Add picker above it runs on (add-line-items.tsx).
  // This sibling still demanded two typed characters before it would show anything, so tapping a
  // Description box to see what's in the book gave you an empty screen: "no drop down menu with
  // line items". You cannot search a catalog you have never seen. Empty box → the book; typing
  // narrows it.
  const matches = useMemo(() => {
    const q = value.trim().toLowerCase();
    const pool = q
      ? priceItems.filter((p) => [p.code, p.description, p.category].some((v) => (v ?? "").toLowerCase().includes(q)))
      : priceItems;
    return pool.slice(0, q ? 25 : 200);
  }, [value, priceItems]);
  return (
    <div className="relative">
      <Input
        placeholder={placeholder}
        className={className}
        value={value}
        autoFocus={autoFocus}
        disabled={disabled}
        onChange={(e) => {
          onText(e.target.value);
          setOpen(true);
        }}
        // Open on focus only when the box is EMPTY — that's the "I want to see what's in the
        // book" case. Tapping back into a line you already wrote (to fix a typo) shouldn't drop a
        // list over the rows below it; typing opens the list either way. (The overlay there would
        // be the MATCHES for what's already typed, not the whole book — `matches` is derived from
        // `value` — so this is about not covering the page mid-edit, not about size.)
        onFocus={() => {
          if (!value.trim()) setOpen(true);
          onFocus?.();
        }}
        // Escape closes it without touching the line — a list you can't get out of is a trap
        // when the description you want is one you're typing by hand. Enter is the commit: it
        // leaves the box, and the blur below writes the line (the one save model).
        onKeyDown={(e) => {
          if (e.key === "Escape") setOpen(false);
          if (e.key === "Enter") {
            setOpen(false);
            e.currentTarget.blur();
          }
        }}
        onBlur={() => {
          setTimeout(() => setOpen(false), 150);
          onBlur?.();
        }}
      />
      {open && priceItems.length === 0 && (
        <div className="absolute z-20 mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-500 shadow-lg">
          {/* Price List sits in the dock's Money group (lib/dock.ts); Tools holds only Calculators & Tools. */}
          No price book yet. Upload or build one under Money → Price List and these will autocomplete.
        </div>
      )}
      {open && priceItems.length > 0 && (
        <ul className="absolute z-20 mt-1 max-h-56 w-full overflow-auto rounded-lg border border-slate-200 bg-white py-1 shadow-lg">
          {matches.map((p) => {
            const line = priceBookLine(p, pricing);
            return (
              <li key={p.id}>
                <button
                  type="button"
                  // min-h-[44px]: the 44px touch-target rule. These rows were about 32px on a phone.
                  className="flex min-h-[44px] w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-slate-50"
                  // preventDefault on mousedown keeps the input focused so the blur-timer doesn't
                  // pull the list out from under the tap; the PICK itself rides onClick. It used to
                  // ride mousedown alone, and iOS only synthesizes mouse events for a tap that
                  // doesn't drift — so a finger that moved a pixel selected nothing and the list
                  // just vanished. That is the "glitchy" part.
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    onPick(p);
                    setOpen(false);
                  }}
                >
                  <span className="truncate">{p.code ? `${p.code} — ${p.description}` : p.description}</span>
                  {/* NOTHING SILENT: a code that prices at its default vendor names the vendor
                      beside the price, so $1,938 next to an $830 allowance is never a mystery. */}
                  <span className="shrink-0 text-slate-500">
                    {line.isItemOwn ? "" : `${line.makerLabel} `}
                    {formatCurrency(line.unitPrice)}
                  </span>
                </button>
              </li>
            );
          })}
          {matches.length === 0 && (
            // Say it out loud. A dropdown that renders nothing at all reads as a broken control
            // rather than as an answer.
            <li className="px-3 py-2 text-sm text-slate-400">Nothing in your price list matches that.</li>
          )}
          {/* A silent slice reads as "that's everything". */}
          {!value.trim() && priceItems.length > matches.length && (
            <li className="border-t border-slate-100 px-3 py-2 text-xs text-slate-400">
              Showing {matches.length} of {priceItems.length} — type to narrow it down.
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

/**
 * THE TASK BEHIND A LINE, EDITABLE (0386). A line built from a task carries its breakdown: HIS hours
 * at the rate, and his parts, each with a count and a price. The line's Unit $ is the SUM, so every
 * edit here goes through lineFromDetail and the flag follows it (taskFlags): a task with no hours
 * reads "hours?", a part with no count "how many?", a part nobody priced "price?" — a $0 that ASKS,
 * never a figure typed for him ([[no-speculation]]).
 *
 * LABOR IS ONE ROW PER RATE (cn-v1131). Erik: "im curious how to add time at a different pay rate
 * and i noticed the 145 on there and i thought i had updated that in the backend to 135". The 145
 * was the company default, the 135 his own Team rate, and the one Hours line said neither. Now each
 * row says WHO (Labor · a person · his own word, "Helper") and, beside the figure, WHERE IT CAME
 * FROM through the one rule (laborRateFor / laborRateFromWords): "company default", "the customer's
 * level", "<name>'s rate" — or "typed" when he tapped the chip and wrote one, "from the scope" when
 * he dictated it. Add Labor At Another Rate puts a second row under the task; the first row is the
 * task's labor and never leaves.
 *
 * A part is picked from the price book through the same autocomplete the line's description uses
 * (LineDescInput), so a pick lands the book's words with the vendor named (describeChoice), the
 * company's cost and the sell at THIS customer's markup (priceBookLine) — the one price. A part in
 * his own words stays at "price?" until he picks it from the book or types what it sells for.
 *
 * A part he adds and leaves nameless prices nothing and flags nothing (taskMoney/taskFlags skip it)
 * and is dropped by the save (coerceTaskDetail); it stays on screen until he names it or removes it,
 * so tapping into its count box never deletes the row under his finger.
 *
 * TWO WAYS OUT, ONE SAVE MODEL (cn-v1132): typing moves the line on screen (onChange: the sums read
 * live); leaving a box, or a tap that is a decision (Who, a pick from the book, Use …, Add Labor,
 * a row removed), COMMITS the line (onCommit) and the editor writes it — once, on its own row.
 *
 * Lines without a breakdown never render this; nothing changes for them.
 */
export function TaskBreakdown({
  line,
  detail: d,
  priceItems,
  pricing,
  taskKits = [],
  kitsOn = true,
  scopeWord = null,
  people = [],
  levelRate = null,
  defaultLaborRate = 0,
  disabled = false,
  onChange,
  onCommit,
}: {
  line: DraftLineItem;
  detail: TaskDetail;
  priceItems: PriceItemLite[];
  pricing: BookPricing;
  /** The team, for a row's Who select; a row that names one prices at their own rate (the rule). */
  people?: PersonOption[];
  /** The two lower rungs of the rule for THIS estimate: the customer's level rate and the company
   *  default. A row with no person prices at them; a row with one is held under the level. */
  levelRate?: number | null;
  defaultLaborRate?: number;
  /** The visit's scope word ("Deck"): what Remember As A Kit files the kit under, unless he
   *  changes it. Null when the estimate did not come from a visit with a scope. */
  scopeWord?: string | null;
  /** The org's task kits with their lines (W4): a line built from one says which, and its units
   *  box re-derives the kit's hours and parts for another count (reexpandTaskDetail). */
  taskKits?: TaskKit[];
  /** The company's Kits switch (0352): off hides the door, as it hides every other kit door. */
  kitsOn?: boolean;
  /** A write is on the wire: every control waits (the one save model). */
  disabled?: boolean;
  /** The whole re-priced line (lineFromDetail) as it is TYPED: unit_price, flag and detail move together. */
  onChange: (next: DraftLineItem) => void;
  /** Write the line: as it stands (a box left), or as `next` says (a tap that decided something). */
  onCommit: (next?: DraftLineItem) => void;
}) {
  const type = (next: TaskDetail) => onChange(lineFromDetail(line, next));
  const commit = (next: TaskDetail) => onCommit(lineFromDetail(line, next));
  const leave = () => onCommit();
  // A HAND EDIT IS HIS: a kit part he changes stops being the kit's (from_kit off), so a later
  // change of units leaves it alone; typed hours likewise stop being the kit's.
  const partWith = (i: number, patch: Partial<TaskDetailMaterial>): TaskDetail => ({
    ...d,
    materials: d.materials.map((m, j) => {
      if (j !== i) return m;
      const { from_kit: _k, ...rest } = m;
      return { ...rest, ...patch };
    }),
  });
  const setPart = (i: number, patch: Partial<TaskDetailMaterial>) => type(partWith(i, patch));
  // THE RULE FOR WHOEVER IS ON A ROW (laborRateFor): the person's Team rate under the customer's
  // level, else the level, else the company default — recomputed live, so the chip beside the figure
  // can say where it came from. The row's own `rate` is what prices the line; a "rule" row follows
  // the rule (the editor's rule pass), a typed or dictated one stands.
  const ruleFor = (personId: string | null) => {
    const person = personId ? people.find((p) => p.id === personId) ?? null : null;
    return { ...laborRateFor({ personRate: person?.billRate, levelRate, orgDefault: defaultLaborRate }), person };
  };
  const laborWith = (i: number, patch: Partial<TaskLabor>): TaskDetail => ({ ...d, labor: d.labor.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
  const setLabor = (i: number, patch: Partial<TaskLabor>) => type(laborWith(i, patch));
  // TYPED HOURS ARE HIS: the kit's hours on that row stop being the kit's (from_kit off), so a later
  // change of units leaves them alone.
  const setHours = (i: number, n: number) =>
    type({
      ...d,
      labor: d.labor.map((r, j) => {
        if (j !== i) return r;
        const { from_kit: _k, ...rest } = r;
        return { ...rest, hours: n > 0 ? n : null };
      }),
    });
  // The rule's inputs for THIS estimate, in the shape the pure rules take (lib/estimate/reprice-rows).
  const ruleInputs: RuleInputs = { levelRate, orgDefault: defaultLaborRate, people };
  const pickWho = (i: number, v: string) => {
    const row = d.labor[i];
    // WHO THE ROW NAMES: a person, nobody ("Labor"), or his own word ("Other…", keeping a word already
    // there). The rate follows through rowForWho: a rule or legacy row asks the rule again for whoever is
    // named now; a typed or dictated rate is HIS and stands — who does the hours is not what they cost.
    const who = v === "other" ? { personId: null, label: row.label ?? "" } : { personId: v.startsWith("person:") ? v.slice("person:".length) : null, label: null };
    commit(laborWith(i, rowForWho(row, who, ruleInputs)));
  };
  const addLabor = () => commit({ ...d, labor: [...d.labor, { label: null, person_id: null, hours: null, rate: ruleFor(null).rate, rate_from: "rule" }] });
  const dropLabor = (i: number) => commit({ ...d, labor: d.labor.filter((_, j) => j !== i) });
  // The row whose rate chip is open as a box (one at a time; tapping the chip again closes it).
  const [rateOpen, setRateOpen] = useState<number | null>(null);
  // A figure the one way the rows carry it (two decimals), so a live answer is compared to a stored one as
  // the row holds it and a rate like 133.333 does not read as a drift against its own 133.33.
  const cents = (n: number) => Math.round(n * 100) / 100;
  // THE CHIP'S WORDS: the figure and where it came from. A typed or dictated rate names his act; a row
  // read from the old one-figure shape says only what it was quoted at. A rule row names the rule's
  // source — WHILE the stored figure is the rule's answer now. A draft saved at $145 after the default
  // moved to $135 holds a rule row at 145 (the pass never runs on the first render: the seed carries
  // its rate; or the person has since left; or the estimate is SENT and nothing moves on it), and
  // "× $145.00/h · company default" would be a lie. It reads "quoted at $145.00/h · the rule says
  // $135.00/h now", and the way back is named when the chip is open (backWords), exactly as it is
  // for a typed figure.
  const rateWords = (row: TaskLabor, live: { rate: number; from: LaborRateFrom; person: PersonOption | null }): string => {
    const at = `${formatCurrency(row.rate)}/h`;
    if (row.rate_from === "hand") return `× ${at} · typed`;
    if (row.rate_from === "stated") return `× ${at} · from the scope`;
    if (row.rate_from === "legacy") return `quoted at ${at}`;
    if (cents(live.rate) === row.rate) return `× ${at} · ${laborRateFromWords(live.from, live.person?.name)}`;
    return `quoted at ${at} · the rule says ${live.rate > 0 ? `${formatCurrency(live.rate)}/h` : "no rate"} now`;
  };
  // The one way back from a typed figure, named for what it goes back TO (a button, so Title Case).
  const backWords = (live: { from: LaborRateFrom; person: PersonOption | null }): string | null =>
    live.from === "person" && live.person ? `Use ${live.person.name}'s Rate` : live.from === "level" ? "Use The Customer's Level" : live.from === "default" ? "Use The Company Default" : null;
  // THE UNITS BOX on a kit-built line: the kit's hours and parts are derived again for the new
  // count through THE one expandTaskKit, his own stand, and the count rides the line's name.
  const setUnits = (n: number) => {
    // A blank or a 0 mid-typing is not a count: the line waits for a real one.
    if (!fromKit || !(n > 0)) return;
    const next = reexpandTaskDetail(d, n, fromKit, { orgDefaultPct: pricing.orgDefaultPct ?? 0, levelPct: pricing.levelPct });
    const renamed = { ...line, description: lineNameWithUnits(line.description, d.units, next.units) };
    // A Unit $ he typed over the sum is HIS price and stands (the rate rule): the parts and hours
    // follow the count beneath it, and the amber note keeps saying the paper leaves them off.
    const hand = !detailExplains(d, line);
    const priced = lineFromDetail(renamed, next);
    onChange(hand ? { ...priced, unit_price: line.unit_price } : priced);
  };
  const dropPart = (i: number) => commit({ ...d, materials: d.materials.filter((_, j) => j !== i) });
  const money = taskMoney(d);
  // THIS MANY OF THE TASK (cn-v1133): the breakdown prices ONE; the line's Qty box multiplies it.
  // (Destructured: the dotted spelling of a total is a materials-list footer's, and the
  // materials-money scan fails any screen that prints one for itself.)
  const qty = lineQty(line);
  const { total: oneOfTheTask } = money;
  const box = "h-7 px-2 text-xs";
  // REMEMBER AS A KIT (W4): the breakdown becomes a task kit — his hours and parts PER UNIT — so
  // the next visit's Inspector offers it by name (lib/estimate/kit-from-task). The pure rule says
  // BEFORE the round trip what is still missing (the hours, a part's count) with the one action
  // that would let the kit be made; the server applies the same rule again and writes. A line
  // already built from a kit names it instead — no kit is made from a kit.
  const [kitOpen, setKitOpen] = useState(false);
  const [kitName, setKitName] = useState(() => kitNameFromLine(line.description));
  const [kitUnit, setKitUnit] = useState("ea");
  // THE SCOPE IT FILES UNDER: the visit's word first, his to change (lib/playbook/scope).
  const [kitCategory, setKitCategory] = useState(scopeWord ?? "");
  const [kitBusy, setKitBusy] = useState(false);
  const [kitSaid, setKitSaid] = useState<{ ok: boolean; text: string } | null>(null);
  // The kit behind the line, while the company's Kits switch is on (off = no kit door, as everywhere).
  const fromKit = kitsOn && d.kit_id ? taskKits.find((k) => k.id === d.kit_id) ?? null : null;
  const openKit = () => {
    const probe = kitFromTaskDetail(d, { name: kitName || "kit", unit: kitUnit });
    if (!probe.ok) {
      setKitSaid({ ok: false, text: probe.error });
      return;
    }
    setKitSaid(null);
    setKitOpen(true);
  };
  const remember = async () => {
    setKitBusy(true);
    try {
      const r = await rememberTaskAsKit({ name: kitName, unit: kitUnit, detail: d, category: kitCategory.trim() || null });
      if (r.ok) {
        setKitOpen(false);
        setKitSaid({ ok: true, text: `Remembered as the kit ${r.name ?? kitName} — it's under Kits on the Price List and in the Inspector's kit picker.` });
      } else {
        setKitSaid({ ok: false, text: r.error ?? "Could not remember the kit." });
      }
    } catch {
      setKitSaid({ ok: false, text: "Could not reach the server — press Save The Kit again." });
    } finally {
      setKitBusy(false);
    }
  };
  // WHAT WILL BE SAVED, before he saves it: the per-unit figures the rule will write, or the one
  // thing still in the way. Nothing is divided by a count he cannot see.
  const planned = kitOpen ? kitFromTaskDetail(d, { name: kitName || "kit", unit: kitUnit }) : null;
  return (
    <div className="mt-1.5 space-y-1 rounded-md border border-slate-100 bg-slate-50/60 px-2 py-1.5 text-xs text-slate-600">
      {d.labor.map((row, i) => {
        const live = ruleFor(row.person_id);
        const who = row.person_id ? `person:${row.person_id}` : row.label !== null ? "other" : "";
        // A row priced for somebody who has since left the team keeps a row to sit on, or the
        // select would show the first option over a rate that is not its answer.
        const known = !row.person_id || people.some((p) => p.id === row.person_id);
        const words = rateWords(row, live);
        // The way back is offered whenever the stored figure is not the rule's answer — a typed one, a
        // dictated one, or a rule row the rule has moved out from under (the chip says so).
        const back = cents(live.rate) !== row.rate ? backWords(live) : null;
        return (
          <div key={i} className="flex flex-wrap items-center gap-1.5">
            <Select aria-label="Who" className={`${box} w-28 py-0`} value={who} disabled={disabled} onChange={(e) => pickWho(i, e.target.value)}>
              <option value="">Labor</option>
              {people.map((p) => (
                <option key={p.id} value={`person:${p.id}`}>
                  {p.name}
                </option>
              ))}
              {!known && <option value={`person:${row.person_id}`}>Someone No Longer On The Team</option>}
              <option value="other">Other…</option>
            </Select>
            {who === "other" && (
              <Input
                aria-label="Who, in your words"
                placeholder="Helper, 2-man crew…"
                className={`${box} w-28`}
                value={row.label ?? ""}
                disabled={disabled}
                onChange={(e) => setLabor(i, { label: e.target.value })}
                onBlur={leave}
              />
            )}
            <NumberInput aria-label="Hours" placeholder="hours?" className={`${box} w-20`} value={row.hours ?? 0} disabled={disabled} onValueChange={(n) => setHours(i, n)} onBlur={leave} />
            {/* THE RATE CHIP: the figure and where it came from (rateWords). Tapping it opens a box; a
                typed figure is his ("typed") and stands until he goes back to the rule by name. */}
            <button
              type="button"
              onClick={() => setRateOpen(rateOpen === i ? null : i)}
              className="whitespace-nowrap rounded px-1 hover:bg-white hover:underline"
              aria-label="Change The Rate"
            >
              {words}
            </button>
            {rateOpen === i && (
              <>
                <NumberInput
                  aria-label="Rate"
                  placeholder="$/h"
                  className={`${box} w-20`}
                  value={row.rate}
                  autoFocus
                  disabled={disabled}
                  onValueChange={(n) => setLabor(i, { rate: n > 0 ? n : 0, rate_from: "hand" })}
                  onBlur={leave}
                />
                {back && (
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => {
                      commit(laborWith(i, { rate: cents(live.rate), rate_from: "rule" }));
                      setRateOpen(null);
                    }}
                    className="font-medium text-brand hover:underline disabled:opacity-50"
                  >
                    {back}
                  </button>
                )}
              </>
            )}
            <span className="ml-auto tabular-nums text-slate-700">{formatCurrency(laborMoney(row))}</span>
            {/* The first row is the task's labor; a task always has one. The others can go. */}
            {i > 0 && (
              <button type="button" disabled={disabled} onClick={() => dropLabor(i)} className="rounded p-0.5 text-slate-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-50" aria-label="Remove This Labor">
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        );
      })}
      <div className="flex flex-wrap items-center justify-between gap-2 pt-0.5">
        <button type="button" disabled={disabled} onClick={addLabor} className="font-medium text-brand hover:underline disabled:opacity-50">
          Add Labor At Another Rate
        </button>
        {d.labor.length > 1 && <span className="tabular-nums text-slate-500">Labor {formatCurrency(money.labor)}</span>}
      </div>
      {d.materials.map((m, i) => (
        <div key={i} className="flex flex-wrap items-center gap-1.5">
          <div className="min-w-[8rem] flex-1">
            <LineDescInput
              placeholder="Part"
              className={box}
              value={m.name}
              disabled={disabled}
              onText={(v) => setPart(i, { name: v })}
              onBlur={leave}
              onPick={(pi) => {
                // THE ONE PRICE (priceBookLine) and the book's words with the vendor named, no code
                // in front — the customer may read this part under the task.
                const choice = priceBookLine(pi, pricing);
                commit(partWith(i, { code: pi.code, name: describeChoice(pi.description, pi, choice), cost: choice.buyPrice, sell: choice.unitPrice }));
              }}
              priceItems={priceItems}
              pricing={pricing}
            />
          </div>
          <NumberInput
            aria-label="How many"
            placeholder="how many"
            className={`${box} w-20`}
            value={m.qty ?? 0}
            disabled={disabled}
            onValueChange={(n) => setPart(i, { qty: n > 0 ? n : null })}
            onBlur={leave}
          />
          <span>×</span>
          <NumberInput
            aria-label="Price each"
            placeholder="price?"
            className={`${box} w-20`}
            value={m.sell ?? 0}
            disabled={disabled}
            onValueChange={(n) => setPart(i, { sell: n > 0 ? n : null })}
            onBlur={leave}
          />
          <span className="ml-auto tabular-nums text-slate-700">
            {m.qty !== null && m.sell !== null ? formatCurrency(partMoney(m)) : "—"}
          </span>
          <button
            type="button"
            disabled={disabled}
            onClick={() => dropPart(i)}
            className="rounded p-0.5 text-slate-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
            aria-label="Remove This Part"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
      <div className="flex flex-wrap items-center justify-between gap-2 pt-0.5">
        {/* A new part is a row to type into, not a write: nameless it prices nothing (and the save
            would drop it), so it reaches the server with its name, on the blur that names it. */}
        <button
          type="button"
          disabled={disabled}
          onClick={() => type({ ...d, materials: [...d.materials, { code: null, name: "", qty: null, cost: null, sell: null }] })}
          className="font-medium text-brand hover:underline disabled:opacity-50"
        >
          Add A Part
        </button>
        {d.materials.length > 0 && <span className="tabular-nums text-slate-500">Parts {formatCurrency(money.parts)}</span>}
      </div>
      {/* The sum is for ONE of the task; when the line's Qty is more, the row says what the paper will
          charge, so $540 under a $1,080 line is not a puzzle (the Qty box is "this many of the task"). */}
      {qty !== 1 && (
        <div className="flex justify-end pt-0.5">
          <span className="tabular-nums text-slate-500">
            {formatCurrency(oneOfTheTask)} × {qty} = {formatCurrency(Math.round(oneOfTheTask * qty * 100) / 100)}
          </span>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
        {d.kit_id ? (
          <>
            <span className="text-slate-500">
              From the kit {fromKit ? fromKit.name : kitsOn ? "it was built from (no longer in your kits)" : "it was built from"}
            </span>
            {fromKit ? (
              <>
                <span className="text-slate-500">· Units</span>
                {/* A blank count reads BLANK, never as a chosen 1 (audit v1085, carried [5]): the line's flag
                    asks "units?" until he types one; the kit prices at one unit meanwhile. */}
                <NumberInput aria-label="Units" placeholder="units" className={`${box} w-20`} value={d.units ?? 0} disabled={disabled} onValueChange={setUnits} onBlur={leave} />
                {fromKit.unit && <span className="text-slate-500">{fromKit.unit}</span>}
                {d.labor.some((r) => r.hours !== null && r.from_kit !== true) && Number(fromKit.labor_minutes) > 0 && (
                  <span className="text-slate-400">· your hours stand; the kit&rsquo;s parts follow the units</span>
                )}
              </>
            ) : (
              d.units !== null && d.units !== 1 && <span className="text-slate-500">· ×{d.units}</span>
            )}
          </>
        ) : !kitsOn ? null : kitOpen ? (
          <>
            <Input aria-label="Kit name" placeholder="Kit name" className={`${box} w-40`} value={kitName} onChange={(e) => setKitName(e.target.value)} />
            <span>per</span>
            <Input aria-label="Unit" placeholder="ea" className={`${box} w-20`} value={kitUnit} onChange={(e) => setKitUnit(e.target.value)} />
            <span>under</span>
            <Input aria-label="Scope" placeholder="the scope, like Deck" className={`${box} w-32`} value={kitCategory} onChange={(e) => setKitCategory(e.target.value)} />
            <button
              type="button"
              disabled={kitBusy || !kitName.trim() || !planned?.ok}
              onClick={() => void remember()}
              className="font-medium text-brand hover:underline disabled:opacity-50"
            >
              {kitBusy ? "Saving…" : "Save The Kit"}
            </button>
            <button type="button" onClick={() => setKitOpen(false)} className="text-slate-500 hover:underline">
              Cancel
            </button>
          </>
        ) : (
          <button type="button" onClick={openKit} className="font-medium text-brand hover:underline">
            Remember As A Kit
          </button>
        )}
      </div>
      {planned && (
        <p className={planned.ok ? "text-slate-500" : "text-amber-700"}>
          {planned.ok ? `Will save: ${kitSummary(planned.value, d.units)}` : planned.error}
        </p>
      )}
      {kitSaid && <p className={kitSaid.ok ? "text-emerald-700" : "text-amber-700"}>{kitSaid.text}</p>}
      {/* A Unit $ typed over the sum is HIS price and stands; the breakdown then describes a number
          the customer is not being asked for, so the document leaves it off (quote-document.tsx
          prints it only while detailExplains). Nothing is deleted: the job still reads the hours. */}
      {!detailExplains(d, line) && <p className="text-amber-700">Price set by hand — the breakdown stays off the paper</p>}
    </div>
  );
}
