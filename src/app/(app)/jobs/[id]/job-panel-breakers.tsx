"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Check, CircuitBoard, Loader2, MapPin, PackagePlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/toast";
import { cn, formatCurrency } from "@/lib/utils";
import { normalisePartNumber } from "@/lib/shelf-plan";
import { breakerCard, groupLabel, type BreakerCard, type HaveGroup } from "@/lib/panel/breakers";
import { circuitName, countWord } from "@/lib/panel/model";
import type { JobCircuit, JobPanel } from "@/lib/types";
import {
  addBreakerToMaterials,
  addBreakerToPriceBook,
  loadPanelBreakers,
  removeBreakerFromMaterials,
  saveCircuit,
  takeBreakerOutOfPriceBook,
  takeOffCircuit,
  type BookPrice,
  type BreakersLoad,
  type OfficeTicketLine,
  type PlaceResult,
} from "../panel-actions";
import { PlaceBreakerSheet } from "./place-breaker-sheet";

/**
 * THE BREAKERS CARD (Panel plan, phase 3). Tonight's pole count, run by itself for the office and
 * the crew alike: what the new circuits need, what came on the job's tickets, and the verdict in
 * plain words ("Short One 2P 20A (Bath Floor Heat). One 1P 20A Spare."). Each shortfall has its
 * door: Add Q220 To Materials, or the quad swap with its lookalike said beside it. A breaker that
 * came can be placed at a space (Place From What Was Bought), its halves pre-filled as circuits a
 * person confirms.
 *
 * THE SAME COUNT FOR EVERYONE (0334): the crew's card and the office's count the same tickets. The
 * office's card only ADDS what the office may see: which ticket, what it cost, the price book, and
 * Add To Price Book for a code the book doesn't have (never silent: the cost is shown and editable
 * before it is written, and Undo takes it back out). A tech's load never carries any of it.
 */

export type BreakersData = Extract<BreakersLoad, { ok: true }>;

const card = "rounded-xl border border-slate-200 bg-white p-4 shadow-sm";

type PriceForm = { code: string; value: string; supplier: string | null };

/** Everything on the card, drawn from a load and the tab's live circuits. Render-only: the doors
 *  are passed in, so the tests and the J-011 replay draw exactly what a person sees. */
export function BreakersCardView({
  data,
  circuits,
  panel,
  busy = null,
  priceForm = null,
  onAddToMaterials,
  onPlace,
  onAddPanel,
  onPriceForm,
  onAddToBook,
}: {
  data: BreakersData;
  circuits: JobCircuit[];
  panel: JobPanel | null;
  busy?: string | null;
  priceForm?: PriceForm | null;
  onAddToMaterials?: (part: string | null, description: string, qty: number) => void;
  onPlace?: (g: HaveGroup) => void;
  onAddPanel?: () => void;
  onPriceForm?: (f: PriceForm | null) => void;
  onAddToBook?: (f: PriceForm) => void;
}) {
  const c: BreakerCard = useMemo(
    () => breakerCard({ circuits, panel, bought: data.bought, list: data.list, shelf: data.shelf }),
    [circuits, panel, data.bought, data.list, data.shelf],
  );
  // NOTHING COUNTED YET: no kept new circuit (J-011 before anyone taps Keep). Then there is no
  // verdict and no spares: "No new breakers needed" and every breaker as a green spare would read,
  // at the panel, as "you have everything" when nobody has counted anything.
  const nothingCounted = c.need.lines.length === 0 && c.need.unsized.length === 0;
  const waiting = circuits.filter((x) => x.state === "suggested" && !x.removed_at && !x.source_row?.flag_for && x.work === "new").length;
  const keptOld = circuits.some((x) => x.state === "kept" && !x.removed_at);
  const office = data.office;
  const book = useMemo(() => new Map((office?.prices ?? []).map((p) => [p.code, p])), [office]);
  const off = busy !== null;

  /** The office's line under a part number: its price in the book, or Add To Price Book. */
  const bookLine = (code: string | null, fromTicket?: OfficeTicketLine | null) => {
    if (!office || !code) return null;
    const key = normalisePartNumber(code)!;
    const hit: BookPrice | undefined = book.get(key);
    if (hit) {
      return (
        <p className="text-xs text-slate-500">
          {key} Is {formatCurrency(hit.buy_price)} In Your Price Book.
        </p>
      );
    }
    if (priceForm?.code === key) {
      return (
        <form
          className="mt-1 grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            onAddToBook?.(priceForm);
          }}
        >
          <label className="min-w-0">
            <span className="sr-only">What One {key} Costs</span>
            <Input
              className="h-11"
              inputMode="decimal"
              placeholder="Cost Each"
              value={priceForm.value}
              onChange={(e) => onPriceForm?.({ ...priceForm, value: e.target.value })}
              autoFocus
            />
          </label>
          <Button type="submit" disabled={off}>
            {busy === `book:${key}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Add
          </Button>
          <Button type="button" variant="ghost" onClick={() => onPriceForm?.(null)} disabled={off}>
            Cancel
          </Button>
        </form>
      );
    }
    return (
      <div className="flex flex-wrap items-center gap-x-2 text-xs text-slate-500">
        <span>{key} Isn&apos;t In Your Price Book.</span>
        <button
          type="button"
          disabled={off}
          onClick={() => onPriceForm?.({ code: key, value: fromTicket?.each != null ? fromTicket.each.toFixed(2) : "", supplier: fromTicket?.supplier ?? null })}
          className="min-h-[44px] font-semibold text-[rgb(var(--glass-ink))] disabled:opacity-50"
        >
          Add To Price Book
        </button>
      </div>
    );
  };

  const ticketsFor = (g: HaveGroup) => (office?.tickets ?? []).filter((t) => t.key === g.key);

  return (
    <section className={card} aria-label="Breakers">
      <h3 className="flex items-center gap-2 text-base font-semibold text-slate-900">
        <CircuitBoard className="h-4 w-4 text-[rgb(var(--glass-ink))]" /> Breakers
      </h3>

      {/* NEED: the kept, live, NEW circuits, counted by poles and amps. */}
      {nothingCounted ? (
        <>
          <p className="mt-1 text-sm font-medium text-slate-800">
            {waiting > 0
              ? "Nothing Counted Yet. Keep The New Circuits To Count What They Need."
              : keptOld
                ? "No New Circuits On The List Yet. Add The New Work To Count Its Breakers."
                : "Nothing Counted Yet. Add The New Circuits To Count What They Need."}
          </p>
          {waiting > 0 && (
            <p className="text-xs text-slate-500">
              {countWord(waiting)} {waiting === 1 ? "Suggestion Is" : "Suggestions Are"} Waiting Above.
            </p>
          )}
        </>
      ) : (
        <p className="mt-1 text-sm font-medium text-slate-800">{c.needWords || "Give The New Circuits Their Amps To Count Them."}</p>
      )}
      {c.alreadyInWords && <p className="text-xs text-slate-500">{c.alreadyInWords}</p>}

      {!data.ticketsReady ? (
        <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">
          The job&apos;s tickets can&apos;t be read here yet. It turns on with the next update.
        </p>
      ) : (
        <>
          {/* HAVE: what came on the job's tickets. */}
          <div className="mt-3">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">Came For This Job</div>
            {c.bought.length === 0 ? (
              <p className="mt-1 text-sm text-slate-500">No breakers on this job&apos;s tickets yet.</p>
            ) : (
              <ul className="mt-1 divide-y divide-slate-100">
                {c.bought.map((g) => {
                  const tix = ticketsFor(g);
                  const from = [...new Set(tix.map((t) => [t.bill_number ?? "A Ticket With No Number", t.supplier].filter(Boolean).join(", ")))];
                  const each = tix.find((t) => t.each != null) ?? null;
                  return (
                    <li key={g.key} className="flex items-start gap-2 py-2">
                      <div className="min-w-0 flex-1">
                        <div className="break-words text-sm font-medium text-slate-900">
                          {Number.isInteger(g.qty) ? g.qty : g.qty.toFixed(2)} x {groupLabel(g)}
                        </div>
                        {office && from.length > 0 && (
                          <p className="text-xs text-slate-500">
                            From {from.join("; ")}
                            {each?.each != null ? ` · ${formatCurrency(each.each)} Each` : ""}
                          </p>
                        )}
                        {g.codes.map((code) => (
                          <div key={code}>{bookLine(code, each)}</div>
                        ))}
                      </div>
                      {panel ? (
                        <Button variant="outline" onClick={() => onPlace?.(g)} disabled={off} aria-label={`Place ${g.codes[0] ?? g.words}`}>
                          <MapPin className="h-4 w-4" /> Place
                        </Button>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
            {!panel && c.bought.length > 0 && (
              <div className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-slate-500">
                <span>Add the panel to place these at their spaces.</span>
                {onAddPanel && (
                  <button type="button" onClick={onAddPanel} className="min-h-[44px] font-semibold text-[rgb(var(--glass-ink))]">
                    Add The Panel
                  </button>
                )}
              </div>
            )}
          </div>

          {/* CAN'T READ: counted as zero, named in both views. */}
          {c.unreadable.length > 0 && (
            <ul className="mt-2 space-y-1">
              {c.unreadable.map((u) => (
                <li key={`${u.credit ? "credit" : "read"}:${u.description}`} className="flex items-start gap-1.5 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span className="min-w-0 break-words">
                    {u.credit ? "A Credit On A Ticket" : "Can't Read This Breaker"}: {u.description} ({u.qty}). {u.reason} It isn&apos;t counted
                    {u.credit ? " either way" : ""}.
                  </span>
                </li>
              ))}
            </ul>
          )}

          {/* THE VERDICT, in the words a person says it. */}
          {!nothingCounted && (
            <div
              className={cn(
                "mt-3 rounded-lg px-3 py-2 text-sm font-semibold",
                c.check.ok ? "bg-emerald-50 text-emerald-900" : "bg-amber-50 text-amber-900",
              )}
              role="status"
            >
              {c.check.verdict}
            </div>
          )}

          {/* WHAT TO DO ABOUT A SHORTFALL: order it, or swap for a quad. */}
          {c.orders.map((o) => {
            const onTheList = o.alsoOn.some((w) => w.startsWith("On The List"));
            const name = o.part ?? `${o.short.poles}P ${o.short.amps}A Breaker`;
            return (
              <div key={`${o.short.poles}|${o.short.amps}|${o.short.kind ?? ""}`} className="mt-2 space-y-1">
                {o.alsoOn.map((w) => (
                  <p key={w} className="text-xs text-slate-500">
                    {w}
                  </p>
                ))}
                <Button
                  className="w-full"
                  variant={onTheList ? "outline" : "primary"}
                  onClick={() => onAddToMaterials?.(o.part, o.description, o.qty)}
                  disabled={off}
                >
                  {busy === `mat:${o.part ?? o.description}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <PackagePlus className="h-4 w-4" />}
                  {onTheList ? `Add Another ${name} To Materials` : `Add ${o.qty > 1 ? `${countWord(o.qty)} ` : ""}${name} To Materials`}
                </Button>
                {bookLine(o.part)}
              </div>
            );
          })}
          {c.check.swaps.map((s) => (
            <div key={s.get.part} className="mt-3 rounded-lg border border-slate-200 p-3">
              <p className="text-sm text-slate-800">{s.words}</p>
              {s.warning && (
                <p className="mt-1 flex items-start gap-1 text-xs font-semibold text-red-700">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {s.warning}
                </p>
              )}
              {s.ifSpaceTakesQuad &&
                (panel ? (
                  <p className="mt-1 text-xs text-slate-500">Only if a space takes a quad. The panel label says which; set them on Edit Panel.</p>
                ) : (
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-slate-500">
                    <span>Only if a space takes a quad. The panel label says which: add the panel and set its tandem spaces.</span>
                    {onAddPanel && (
                      <button type="button" onClick={onAddPanel} className="min-h-[44px] font-semibold text-[rgb(var(--glass-ink))]">
                        Add The Panel
                      </button>
                    )}
                  </div>
                ))}
              <Button
                className="mt-2 w-full"
                variant="outline"
                onClick={() => onAddToMaterials?.(s.get.part, `${s.get.part} Quad 1P ${s.get.outer}A + 1P ${s.get.outer}A + 2P ${s.get.inner}A Breaker`, 1)}
                disabled={off}
              >
                {busy === `mat:${s.get.part}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <PackagePlus className="h-4 w-4" />} Add {s.get.part} To Materials
              </Button>
              {bookLine(s.get.part)}
            </div>
          ))}
        </>
      )}

      {/* THE LIST AND THE SHELF: shown beside the count, never added into it. */}
      {c.onList.length > 0 && (
        <div className="mt-3">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">On The List, Not Bought Yet</div>
          <ul className="mt-1 space-y-1">
            {c.onList.map((g) => (
              <li key={g.key} className="text-sm text-slate-700">
                {Number.isInteger(g.qty) ? g.qty : g.qty.toFixed(2)} x {g.lines.join(", ")} <span className="text-slate-500">({g.words})</span>
                {g.onTicket >= g.qty && (
                  <span className="block text-xs text-slate-500">
                    {g.onTicket} came on a ticket already. If they&apos;re the same ones, tick them bought on the Materials list.
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {c.listUnreadable.length > 0 && (
        <ul className="mt-2 space-y-1">
          {c.listUnreadable.map((u) => (
            <li key={u.description} className="text-xs text-amber-800">
              On The List, Can&apos;t Read This Breaker: {u.description}. {u.reason}
            </li>
          ))}
        </ul>
      )}
      {c.shelf.length > 0 && (
        <div className="mt-3">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">On The Shelf</div>
          <ul className="mt-1 space-y-1">
            {c.shelf.map((g) => (
              <li key={g.key} className="text-sm text-slate-700">
                {Number.isInteger(g.qty) ? g.qty : g.qty.toFixed(2)} x {groupLabel(g)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/**
 * The card on the tab: reads its load when the tab opens (the hub pays nothing until someone looks),
 * runs the doors, and hands placed circuits back to the list.
 */
export function JobPanelBreakers({
  jobId,
  circuits,
  panel,
  onRows,
  onAddPanel,
}: {
  jobId: string;
  circuits: JobCircuit[];
  panel: JobPanel | null;
  onRows: (rows: JobCircuit[]) => void;
  onAddPanel: () => void;
}) {
  const toast = useToast();
  const [data, setData] = useState<BreakersLoad | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [priceForm, setPriceForm] = useState<PriceForm | null>(null);
  const [placing, setPlacing] = useState<HaveGroup | null>(null);

  const load = useCallback(() => {
    loadPanelBreakers(jobId)
      .then(setData)
      .catch(() => setData({ ok: false, error: "The breakers couldn't load. Check your connection and try again." }));
  }, [jobId]);
  useEffect(load, [load]);

  async function run<T extends { ok: boolean }>(key: string, fn: () => Promise<T>): Promise<T | null> {
    setBusy(key);
    try {
      const r = await fn();
      if (!r.ok) toast((r as unknown as { error: string }).error, "error");
      return r;
    } catch {
      toast("That didn't save. Check your connection and try again.", "error");
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function addToMaterials(part: string | null, description: string, qty: number) {
    const r = await run(`mat:${part ?? description}`, () => addBreakerToMaterials(jobId, { part, description, qty }));
    if (!r || !r.ok) return;
    load();
    toast(`Added ${r.words} to the materials list.`, "success", {
      label: "Undo",
      onClick: async () => {
        const u = await run("unmat", () => removeBreakerFromMaterials(jobId, r.id, r.listId));
        if (u && u.ok) {
          load();
          toast(`Took ${r.words} off the materials list.`, "success");
        }
      },
    });
  }

  async function addToBook(f: PriceForm) {
    const price = Number(String(f.value).replace(/[$,\s]/g, ""));
    const r = await run(`book:${f.code}`, () => addBreakerToPriceBook({ code: f.code, buy_price: price, supplier: f.supplier }));
    if (!r || !r.ok) return;
    setPriceForm(null);
    load();
    toast(r.words, "success", {
      label: "Undo",
      onClick: async () => {
        const u = await run("unbook", () => takeBreakerOutOfPriceBook(r.row.id));
        if (u && u.ok) {
          load();
          toast(`Took ${r.row.code} back out of your price book.`, "success");
        }
      },
    });
  }

  function placed(r: Extract<PlaceResult, { ok: true }>, label: string, space: number) {
    onRows(r.rows);
    setPlacing(null);
    const names = r.rows.map((x) => circuitName(x)).join(", ");
    toast(`Placed ${label} at space ${space}: ${names}.${r.problems.length ? ` ${r.problems.join(" ")}` : ""}`, r.problems.length ? "info" : "success", {
      label: "Undo",
      onClick: async () => {
        // Only what this placement did, and only if it still says so: a crewmate's later move stays.
        for (const m of r.moved) {
          const u = await run(`unplace:${m.id}`, () => saveCircuit(m.id, { space: null }, { space: m.space }));
          if (u && u.ok) onRows([u.row]);
        }
        for (const id of r.added) {
          const u = await run(`unplace:${id}`, () => takeOffCircuit(id));
          if (u && u.ok) onRows([u.row]);
        }
      },
    });
  }

  if (!data) {
    return (
      <section className={card} aria-label="Breakers">
        <div className="flex items-center gap-2 text-sm text-slate-500">
          <Loader2 className="h-4 w-4 animate-spin" /> Counting the breakers…
        </div>
      </section>
    );
  }
  if (!data.ok) {
    return (
      <section className={cn(card, "border-red-200 bg-red-50 text-sm text-red-800")} aria-label="Breakers">
        <p>{data.error}</p>
        <Button variant="outline" className="mt-2" onClick={load}>
          Try Again
        </Button>
      </section>
    );
  }
  return (
    <>
      <BreakersCardView
        data={data}
        circuits={circuits}
        panel={panel}
        busy={busy}
        priceForm={priceForm}
        onAddToMaterials={addToMaterials}
        onPlace={setPlacing}
        onAddPanel={onAddPanel}
        onPriceForm={setPriceForm}
        onAddToBook={addToBook}
      />
      {placing && panel && (
        <PlaceBreakerSheet jobId={jobId} panel={panel} group={placing} circuits={circuits} onPlaced={placed} onClose={() => setPlacing(null)} />
      )}
    </>
  );
}
