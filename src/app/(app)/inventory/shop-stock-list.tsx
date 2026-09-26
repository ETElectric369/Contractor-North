"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, ChevronDown, ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { Modal, ModalActions } from "@/components/ui/modal";
import { NumberInput } from "@/components/ui/number-input";
import { useToast } from "@/components/toast";
import { formatCurrency } from "@/lib/utils";
import type { InventoryItem } from "@/lib/types";
import { addOpeningRoll, countItem, returnToSupplier, shelfCredits, takeLotOffShelf, undoShelfMove, undoShelfTake, writeOffPieces, type ShelfCreditOption } from "./actions";
import { returnDoorLabel, shelfReturnMoney } from "@/lib/supplier-returns";
import { ItemActions } from "./item-actions";
import { settleShortAction } from "../materials/stock-actions";

export type ShelfLotView = {
  id: string;
  pieces: number;
  unit: string;
  cost: number;
  piecesLeft: number;
  costLeft: number;
  /** Where it came from, in words: "from CED, 8/19 (bought on Herringbone)". */
  from: string;
  boughtOn: string | null;
  live: boolean;
  liveMoves: number;
  stale: boolean;
  /** The day it was taken back off the shelf, when it was. */
  offOn: string | null;
  /** Where its dollars go if it comes back off the shelf: the job whose ticket it came off, or
   *  null for a roll counted in by hand. */
  backTo: string | null;
  /** It came in on a ticket bought for the shelf: there is no job to send it back to, so it has no
   *  Take It Off The Shelf (the ticket's Undo in the tray is the way back). */
  shelfTicket: boolean;
  /** The supplier on its ticket (null for a roll counted in): names Return To CED. */
  supplier: string | null;
};

export type ShelfMoveView = {
  id: string;
  kind: string;
  text: string;
  cost: number;
  undone: boolean;
  drawGroup: string | null;
  settled: boolean;
  /** "the Stock Used list, Oct 1": an accountant download already carried it, so it has no Undo (0350). */
  exported: string | null;
};

export type ShelfItemView = {
  id: string;
  name: string;
  unit: string;
  partNumber: string | null;
  category: string | null;
  location: string | null;
  vendor: string | null;
  description: string | null;
  reorderPoint: number;
  onHand: number;
  value: number;
  lots: ShelfLotView[];
  moves: ShelfMoveView[];
  /** False on the Show Inactive Items list. */
  active: boolean;
};

/** The item as the edit sheet reads it: its own fields, never a cost. */
function asItem(it: ShelfItemView): InventoryItem {
  return {
    id: it.id,
    name: it.name,
    part_number: it.partNumber,
    description: it.description,
    category: it.category,
    unit: it.unit,
    quantity_on_hand: it.onHand,
    reorder_point: it.reorderPoint,
    unit_cost: null,
    vendor: it.vendor,
    location: it.location,
    active: it.active,
    created_at: "",
    updated_at: "",
  };
}

const qty = (n: number) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 1000) / 1000));

/**
 * THE SHELF, ONE ROW PER ITEM ("12/2 NM-B · 250 ft · $180.17"). Tap a row for where each roll came
 * from and where each piece went, and the doors the record allows: Count It, Add A Roll Counted In,
 * Take It Off The Shelf (a roll nothing was taken from), and Undo on a count or a take. A take an
 * invoice already bills refuses its Undo in words that name the invoice.
 */
export function ShopStockList({ items, openItem = null }: { items: ShelfItemView[]; openItem?: string | null }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  // A Settle item links here with ?item=<id>: that item starts open, so Settle From The Shelf is
  // on screen instead of somewhere down a list of closed rows.
  const [open, setOpen] = useState<Record<string, boolean>>(() => (openItem ? { [openItem]: true } : {}));
  useEffect(() => {
    if (!openItem) return;
    setOpen((o) => (o[openItem] ? o : { ...o, [openItem]: true }));
    const el = typeof document !== "undefined" ? document.getElementById(`stock-item-${openItem}`) : null;
    el?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [openItem]);
  const [counting, setCounting] = useState<ShelfItemView | null>(null);
  const [adding, setAdding] = useState<ShelfItemView | null>(null);
  const [writingOff, setWritingOff] = useState<{ item: ShelfItemView; lot: ShelfLotView } | null>(null);
  const [returning, setReturning] = useState<{ item: ShelfItemView; lot: ShelfLotView } | null>(null);

  function act(fn: () => Promise<{ ok: boolean; error?: string; message?: string }>, done: string) {
    start(async () => {
      const res = await fn();
      if (!res?.ok) {
        toast(res?.error ?? "That didn't work. Nothing changed.", "error");
        return;
      }
      toast(res.message ?? done, "success");
      router.refresh();
    });
  }

  return (
    <Card className="overflow-hidden">
      <ul className="divide-y divide-slate-100">
        {items.map((it) => {
          const low = it.reorderPoint > 0 && it.onHand <= it.reorderPoint;
          const isOpen = !!open[it.id];
          const liveLots = it.lots.filter((l) => l.live);
          const pastLots = it.lots.filter((l) => !l.live);
          return (
            <li key={it.id} id={`stock-item-${it.id}`} className={`scroll-mt-20 ${low ? "bg-amber-50/40" : ""}`}>
              <button
                type="button"
                onClick={() => setOpen((o) => ({ ...o, [it.id]: !o[it.id] }))}
                aria-expanded={isOpen}
                className="flex min-h-14 w-full items-center gap-3 px-4 py-3 text-left hover:bg-slate-50"
              >
                {isOpen ? <ChevronDown className="h-4 w-4 shrink-0 text-slate-400" /> : <ChevronRight className="h-4 w-4 shrink-0 text-slate-400" />}
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2 font-medium text-slate-900">
                    {it.name}
                    {low && (
                      <Badge tone="amber" className="gap-1">
                        <AlertTriangle className="h-3 w-3" /> Reorder
                      </Badge>
                    )}
                  </span>
                  <span className="block truncate text-xs text-slate-400">
                    {[it.partNumber ? `#${it.partNumber}` : null, it.category, it.location].filter(Boolean).join(" · ") ||
                      `${liveLots.length} ${liveLots.length === 1 ? "roll" : "rolls"} on the shelf`}
                  </span>
                </span>
                <span className="shrink-0 text-right">
                  <span className="block text-base font-semibold tabular-nums text-slate-900">
                    {qty(it.onHand)} <span className="text-xs font-normal text-slate-500">{it.unit}</span>
                  </span>
                  <span className="block text-xs tabular-nums text-slate-500">{formatCurrency(it.value)}</span>
                </span>
              </button>

              {isOpen && (
                <div className="space-y-3 px-4 pb-4">
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => setCounting(it)}
                      className="flex min-h-11 items-center rounded-lg border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 hover:bg-slate-50"
                    >
                      Count It
                    </button>
                    <button
                      type="button"
                      onClick={() => setAdding(it)}
                      className="flex min-h-11 items-center rounded-lg border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 hover:bg-slate-50"
                    >
                      Add A Roll Counted In
                    </button>
                    <ItemActions item={asItem(it)} hasHistory={it.lots.length > 0 || it.moves.length > 0} />
                  </div>

                  <div>
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Where It Came From</h3>
                    {liveLots.length === 0 ? (
                      <p className="mt-1 text-sm text-slate-400">No rolls on the shelf.</p>
                    ) : (
                      <ul className="mt-1 space-y-1.5">
                        {liveLots.map((l) => (
                          <li key={l.id} className="rounded-md bg-slate-50 px-3 py-2 text-sm">
                            <p className="text-slate-800">
                              In: {qty(l.pieces)} {l.unit} {l.from} · {formatCurrency(l.cost)}
                            </p>
                            <p className="text-xs text-slate-500">
                              {qty(l.piecesLeft)} {l.unit} left, {formatCurrency(l.costLeft)}
                              {l.stale ? " · its receipt changed, so its cost is being worked out again" : ""}
                            </p>
                            {l.liveMoves === 0 && !l.shelfTicket && (
                              <button
                                type="button"
                                disabled={pending}
                                onClick={() =>
                                  act(
                                    () => takeLotOffShelf(l.id),
                                    l.backTo
                                      ? `That roll is off the shelf; its ${formatCurrency(l.cost)} is back on ${l.backTo}.`
                                      : "That roll is off the shelf. It was counted in, not bought on a ticket, so no cost moves.",
                                  )
                                }
                                className="-ml-1 flex min-h-11 items-center rounded-lg px-1 text-xs font-medium text-brand hover:underline disabled:opacity-50"
                              >
                                Take It Off The Shelf
                              </button>
                            )}
                            {l.liveMoves === 0 && l.shelfTicket && (
                              <p className="text-xs text-slate-500">
                                Bought for the shelf, so it has no job to go back to. Undo its ticket in the tray to take it back.
                              </p>
                            )}
                            {/* SHELF UPKEEP (Phase 4): pieces gone for good, or sent back. Each is a
                                move with its cost stamped off this roll, and an Undo below. */}
                            {l.piecesLeft > 0 && !l.stale && (
                              <div className="-ml-1 flex flex-wrap gap-x-3">
                                <button
                                  type="button"
                                  disabled={pending}
                                  onClick={() => setWritingOff({ item: it, lot: l })}
                                  className="flex min-h-11 items-center rounded-lg px-1 text-xs font-medium text-brand hover:underline disabled:opacity-50"
                                >
                                  Write Off
                                </button>
                                <button
                                  type="button"
                                  disabled={pending}
                                  onClick={() => setReturning({ item: it, lot: l })}
                                  className="flex min-h-11 items-center rounded-lg px-1 text-xs font-medium text-brand hover:underline disabled:opacity-50"
                                >
                                  {returnDoorLabel(l.supplier)}
                                </button>
                              </div>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                    {pastLots.length > 0 && (
                      <ul className="mt-1.5 space-y-1 text-xs text-slate-400">
                        {pastLots.map((l) => (
                          <li key={l.id}>
                            Was on the shelf: {qty(l.pieces)} {l.unit} {l.from}
                            {l.offOn ? `, taken off ${l.offOn}` : ""}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>

                  <div>
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Where It Went</h3>
                    {it.moves.length === 0 ? (
                      <p className="mt-1 text-sm text-slate-400">Nothing taken from it yet.</p>
                    ) : (
                      <ul className="mt-1 space-y-1">
                        {it.moves.map((m) => {
                          const takeUndo = !m.undone && (m.kind === "draw" || m.kind === "short") && m.drawGroup;
                          const upkeep = m.kind === "recount_down" || m.kind === "recount_up" || m.kind === "write_off" || m.kind === "supplier_return";
                          const countUndo = !m.undone && upkeep && !m.exported;
                          return (
                            <li key={m.id} className={`flex flex-wrap items-center gap-x-2 text-sm ${m.undone ? "text-slate-400 line-through" : "text-slate-700"}`}>
                              <span>
                                {m.text}
                                {m.cost > 0 ? ` · ${formatCurrency(m.cost)}` : ""}
                              </span>
                              {takeUndo && (
                                <button
                                  type="button"
                                  disabled={pending}
                                  onClick={() => act(() => undoShelfTake(m.drawGroup!), "Undone: the pieces are back on the shelf.")}
                                  className="flex min-h-11 items-center rounded-lg px-1 text-xs font-medium text-brand hover:underline disabled:opacity-50"
                                >
                                  Undo
                                </button>
                              )}
                              {countUndo && (
                                <button
                                  type="button"
                                  disabled={pending}
                                  onClick={() => act(() => undoShelfMove(m.id), "Undone.")}
                                  className="flex min-h-11 items-center rounded-lg px-1 text-xs font-medium text-brand hover:underline disabled:opacity-50"
                                >
                                  Undo
                                </button>
                              )}
                              {!m.undone && upkeep && m.exported && (
                                <span className="text-xs text-slate-400">With your accountant ({m.exported}), so it stays</span>
                              )}
                              {/* The answer to a Settle item (Phase 3): once a roll is on the shelf,
                                  the pieces taken past it are settled at that roll's cost. */}
                              {!m.undone && m.kind === "short" && !m.settled && (
                                <button
                                  type="button"
                                  disabled={pending}
                                  onClick={() => act(() => settleShortAction(m.id), "Settled from the shelf.")}
                                  className="flex min-h-11 items-center rounded-lg px-1 text-xs font-medium text-brand hover:underline disabled:opacity-50"
                                >
                                  Settle From The Shelf
                                </button>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {counting && (
        <CountIt
          item={counting}
          onClose={() => setCounting(null)}
          onDone={(message) => {
            setCounting(null);
            toast(message, "success");
            router.refresh();
          }}
        />
      )}
      {writingOff && (
        <WriteOff
          item={writingOff.item}
          lot={writingOff.lot}
          onClose={() => setWritingOff(null)}
          onDone={(message) => {
            setWritingOff(null);
            toast(message, "success");
            router.refresh();
          }}
        />
      )}
      {returning && (
        <ReturnToSupplier
          item={returning.item}
          lot={returning.lot}
          onClose={() => setReturning(null)}
          onDone={(message) => {
            setReturning(null);
            toast(message, "success");
            router.refresh();
          }}
        />
      )}
      {adding && (
        <AddOpeningRoll
          item={adding}
          onClose={() => setAdding(null)}
          onDone={() => {
            setAdding(null);
            toast("On the shelf.", "success");
            router.refresh();
          }}
        />
      )}
    </Card>
  );
}

/** COUNT IT: what is really on the shelf. The difference is written as moves, never typed over. */
function CountIt({ item, onClose, onDone }: { item: ShelfItemView; onClose: () => void; onDone: (message: string) => void }) {
  const [count, setCount] = useState(item.onHand);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const diff = Math.round((count - item.onHand) * 1000) / 1000;
  function save() {
    setSaving(true);
    setError(null);
    countItem(item.id, count, note.trim() || null)
      .then((res) => {
        setSaving(false);
        if (!res.ok) return setError(res.error ?? "The count didn't save. Nothing changed.");
        onDone(res.message ?? "Counted.");
      })
      .catch(() => {
        setSaving(false);
        setError("The count didn't save: the connection dropped. Nothing changed.");
      });
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={`Count ${item.name}`}
      size="sm"
      dirty={diff !== 0}
      footer={<ModalActions onCancel={onClose} onSave={save} saving={saving} saveLabel="Save The Count" disabled={saving || count < 0} />}
    >
      <div className="space-y-3">
        <p className="text-sm text-slate-600">
          The shelf&apos;s record says {qty(item.onHand)} {item.unit}. How many are really there?
        </p>
        <div className="flex items-center gap-2">
          <NumberInput value={count} onValueChange={setCount} className="h-11 w-32" aria-label="Counted" />
          <span className="text-sm text-slate-500">{item.unit}</span>
        </div>
        <div>
          <Label htmlFor={`count-note-${item.id}`}>Note (optional)</Label>
          <Input id={`count-note-${item.id}`} value={note} onChange={(e) => setNote(e.target.value)} className="h-11" placeholder="Counted in the truck" />
        </div>
        {diff < 0 && (
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
            {qty(-diff)} {item.unit} short. They are written off oldest roll first, at what they cost, as Shop Stock Lost.
          </p>
        )}
        {diff > 0 && (
          <p className="rounded-lg bg-sky-50 px-3 py-2 text-sm text-sky-900">
            {qty(diff)} {item.unit} more than the record. They go on the shelf at $0, because there is no receipt behind them.
          </p>
        )}
        {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      </div>
    </Modal>
  );
}

/** A roll already on the shelf with no receipt in the app: a count, what it cost, and where from. */
function AddOpeningRoll({ item, onClose, onDone }: { item: ShelfItemView; onClose: () => void; onDone: () => void }) {
  const [pieces, setPieces] = useState(0);
  const [cost, setCost] = useState(0);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  function save() {
    setSaving(true);
    setError(null);
    addOpeningRoll({ itemId: item.id, pieces, cost, note })
      .then((res) => {
        setSaving(false);
        if (!res.ok) return setError(res.error ?? "Nothing went on the shelf.");
        onDone();
      })
      .catch(() => {
        setSaving(false);
        setError("Nothing went on the shelf: the connection dropped.");
      });
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={`Add A Roll Of ${item.name}`}
      size="sm"
      dirty={pieces > 0 || cost > 0 || !!note}
      footer={<ModalActions onCancel={onClose} onSave={save} saving={saving} saveLabel="Put It On The Shelf" disabled={saving || !(pieces > 0) || !note.trim()} />}
    >
      <div className="space-y-3">
        <p className="text-sm text-slate-600">
          For something already on the shelf that no receipt in the app covers. A roll off a receipt goes on from that receipt instead, so its cost
          comes off the paper.
        </p>
        <div>
          <Label htmlFor={`open-pieces-${item.id}`}>How many ({item.unit})</Label>
          <NumberInput id={`open-pieces-${item.id}`} value={pieces} onValueChange={setPieces} className="h-11 w-32" />
        </div>
        <div>
          <Label htmlFor={`open-cost-${item.id}`}>What it cost, all together ($0 if you don&apos;t know)</Label>
          <NumberInput id={`open-cost-${item.id}`} value={cost} onValueChange={setCost} className="h-11 w-32" />
        </div>
        <div>
          <Label htmlFor={`open-note-${item.id}`}>Where it came from</Label>
          <Input id={`open-note-${item.id}`} value={note} onChange={(e) => setNote(e.target.value)} className="h-11" placeholder="Counted in the truck, 9/24" />
        </div>
        {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      </div>
    </Modal>
  );
}

/** About what `n` pieces off this roll cost: the database stamps the exact figure (the roll's rate,
 *  or its exact remainder when they empty it). Shown before saving as "about". */
function aboutCost(lot: ShelfLotView, n: number): number {
  if (!(n > 0)) return 0;
  if (n >= lot.piecesLeft) return lot.costLeft;
  return lot.pieces > 0 ? Math.min(Math.round(((n * lot.cost) / lot.pieces) * 100) / 100, lot.costLeft) : 0;
}

/** WRITE OFF: pieces off this roll gone for good. Shop Stock Lost this month; never a customer's. */
function WriteOff({ item, lot, onClose, onDone }: { item: ShelfItemView; lot: ShelfLotView; onClose: () => void; onDone: (message: string) => void }) {
  const [n, setN] = useState(lot.piecesLeft);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  function save() {
    setSaving(true);
    setError(null);
    writeOffPieces({ lotId: lot.id, qty: n, reason })
      .then((res) => {
        setSaving(false);
        if (!res.ok) return setError(res.error ?? "Nothing was written off.");
        onDone(res.message ?? "Written off.");
      })
      .catch(() => {
        setSaving(false);
        setError("Nothing was written off: the connection dropped.");
      });
  }
  const bad = !(n > 0) || n > lot.piecesLeft || !reason.trim();
  return (
    <Modal
      open
      onClose={onClose}
      title={`Write Off ${item.name}`}
      size="sm"
      dirty={!!reason || n !== lot.piecesLeft}
      footer={<ModalActions onCancel={onClose} onSave={save} saving={saving} saveLabel="Write It Off" disabled={saving || bad} />}
    >
      <div className="space-y-3">
        <p className="text-sm text-slate-600">
          From the roll {lot.from}: {qty(lot.piecesLeft)} {lot.unit} left.
        </p>
        <div>
          <Label htmlFor={`wo-n-${lot.id}`}>How many are gone ({lot.unit})</Label>
          <NumberInput id={`wo-n-${lot.id}`} value={n} onValueChange={setN} className="h-11 w-32" />
        </div>
        <div>
          <Label htmlFor={`wo-why-${lot.id}`}>Why (Required)</Label>
          <Input
            id={`wo-why-${lot.id}`}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="h-11"
            placeholder="For example: ruined in the rain"
            aria-required="true"
          />
          {!reason.trim() && <p className="mt-1 text-xs text-slate-500">Say why to write it off, so it explains itself later.</p>}
        </div>
        {n > 0 && n <= lot.piecesLeft && (
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
            About {formatCurrency(aboutCost(lot, n))}, what they cost off the roll, shows as Shop Stock Lost this month. The company eats it: no
            customer is charged. Undo stays until it goes to your accountant.
          </p>
        )}
        {n > lot.piecesLeft && (
          <p className="text-sm text-red-700">
            Only {qty(lot.piecesLeft)} {lot.unit} are left on this roll.
          </p>
        )}
        {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      </div>
    </Modal>
  );
}

/**
 * RETURN TO CED: pieces off this roll go back to the supplier, tied to its credit when the credit is
 * in the books. The credit is filed to the shelf, so no customer is ever credited for shelf stock;
 * what the pieces cost minus the credit is written off, and the sheet says the figure before saving.
 */
function ReturnToSupplier({ item, lot, onClose, onDone }: { item: ShelfItemView; lot: ShelfLotView; onClose: () => void; onDone: (message: string) => void }) {
  const [n, setN] = useState(lot.piecesLeft);
  const [credits, setCredits] = useState<ShelfCreditOption[] | null>(null);
  const [onJobs, setOnJobs] = useState(0);
  const [cantTieWhy, setCantTieWhy] = useState<string | null>(null);
  const [creditId, setCreditId] = useState<string>("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    shelfCredits()
      .then((res) => {
        if (!live) return;
        if (!res.ok) {
          setCredits([]);
          setLoadError(`${res.error} You can still send the pieces back without a credit.`);
          return;
        }
        // Before 0350 no credit can be tied: none is offered, and the sheet says why.
        setCredits(res.canTie ? res.credits : []);
        setCantTieWhy(res.canTie ? null : res.cantTieWhy);
        setOnJobs(res.onJobs);
      })
      .catch(() => {
        if (!live) return;
        setCredits([]);
        setLoadError("The credits couldn't be read just now. You can still send the pieces back without one.");
      });
    return () => {
      live = false;
    };
  }, []);
  const label = returnDoorLabel(lot.supplier);
  const picked = credits?.find((c) => c.id === creditId) ?? null;
  const preview =
    n > 0 && n <= lot.piecesLeft
      ? shelfReturnMoney({
          qty: n,
          unit: lot.unit,
          supplier: lot.supplier,
          cost: aboutCost(lot, n),
          creditAmount: picked ? picked.amount : null,
          otherReturnsCost: picked?.tiedCost ?? 0,
        })
      : null;
  function save() {
    setSaving(true);
    setError(null);
    returnToSupplier({ lotId: lot.id, qty: n, creditBillId: creditId || null })
      .then((res) => {
        setSaving(false);
        if (!res.ok) return setError(res.error ?? "Nothing went back.");
        onDone(res.message ?? "Sent back.");
      })
      .catch(() => {
        setSaving(false);
        setError("Nothing went back: the connection dropped.");
      });
  }
  const day = (ymd: string | null) => (ymd ? `${Number(ymd.slice(5, 7))}/${Number(ymd.slice(8, 10))}` : "");
  return (
    <Modal
      open
      onClose={onClose}
      title={`${label}: ${item.name}`}
      size="sm"
      dirty={!!creditId || n !== lot.piecesLeft}
      footer={<ModalActions onCancel={onClose} onSave={save} saving={saving} saveLabel="Send It Back" disabled={saving || !(n > 0) || n > lot.piecesLeft} />}
    >
      <div className="space-y-3">
        <p className="text-sm text-slate-600">
          From the roll {lot.from}: {qty(lot.piecesLeft)} {lot.unit} left.
        </p>
        <div>
          <Label htmlFor={`ret-n-${lot.id}`}>How many went back ({lot.unit})</Label>
          <NumberInput id={`ret-n-${lot.id}`} value={n} onValueChange={setN} className="h-11 w-32" />
        </div>
        <div>
          <Label htmlFor={`ret-credit-${lot.id}`}>The supplier&apos;s credit for them</Label>
          {credits == null ? (
            <p className="text-sm text-slate-500">Reading the credits…</p>
          ) : cantTieWhy ? (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">{cantTieWhy}</p>
          ) : (
            <select
              id={`ret-credit-${lot.id}`}
              value={creditId}
              onChange={(e) => setCreditId(e.target.value)}
              className="h-11 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm"
            >
              <option value="">No Credit Yet</option>
              {credits.map((c) => (
                <option key={c.id} value={c.id}>
                  {`${c.supplier}${c.number ? ` #${c.number}` : ""}${c.date ? `, ${day(c.date)}` : ""}: ${formatCurrency(c.amount)}${c.tiedCost > 0 ? " (already tied to a return)" : ""}`}
                </option>
              ))}
            </select>
          )}
          {!cantTieWhy && (
            <p className="mt-1 text-xs text-slate-500">
              Only credits filed to no job are listed, and the one you pick is filed to the shelf (Undo takes it back off).
              {onJobs > 0 ? ` ${onJobs} credit${onJobs === 1 ? " is" : "s are"} filed on jobs and left out: those come off that job's customer bill.` : ""}
            </p>
          )}
          {loadError && <p className="mt-1 text-xs text-amber-800">{loadError}</p>}
        </div>
        {preview && <p className="rounded-lg bg-sky-50 px-3 py-2 text-sm text-sky-900">About: {preview.words}</p>}
        {n > lot.piecesLeft && (
          <p className="text-sm text-red-700">
            Only {qty(lot.piecesLeft)} {lot.unit} are left on this roll.
          </p>
        )}
        {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      </div>
    </Modal>
  );
}
