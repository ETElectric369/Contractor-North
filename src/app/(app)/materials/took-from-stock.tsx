"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, Delete, Loader2, PackageMinus, Search } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/toast";
import { formatDateShort } from "@/lib/utils";
import { isTransportError } from "@/lib/chunk-reload";
import { fmtQty, TAKES_READ_FAILED, takeDoor, takeLine, takeShort, takeShortWords, takeUnheardWords, type JobTake, type ShelfRow } from "@/lib/stock-take";
import { loadShelf, takeFromStockAction, undoTakeAction } from "./stock-actions";

/**
 * TOOK FROM STOCK (Shop Stock, Phase 3). One big button on the job's Materials tab and on the
 * job's materials list page, the same for the crew and the office, built for one hand at 60 mph:
 *
 *   Took From Stock → pick the item (names and how much is on the shelf, never a price) → a number
 *   pad with the unit already there ("ft") → Take It → "Took 60 ft of 12/2 NM-B for Herringbone"
 *   with Undo.
 *
 * A take bigger than the shelf shows still saves, so nobody hits a dead end in the field: the pad
 * says so before the tap ("20 ft more than the shelf shows — the office will settle it") and the
 * office gets a Settle item. The warning is worked from what a take can REACH (filed rolls, 0344's
 * takeable), not the bare count, so the sheet and the toast never disagree. Nort fills the same sheet (?take=<item>&qty=60 on the job's link); a
 * person taps Take It.
 *
 * Under the button, the job's takes (stock_takes_for_job, 0344): who took what and when, with Undo
 * until an invoice bills it. Once one does, the Undo reads "Take It Off INV-078 First". A read of
 * them that failed says so in the list's place (`readFailed`), never an empty list: an empty list
 * reads as "nothing taken", and that is the list the sheet sends people to before tapping again.
 *
 * NOT ONE PRICE, for anyone: the rows this draws have no field that could hold one (lib/stock-take).
 */

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0", "back"] as const;

/** A pad key pressed on the current entry. At most three decimals, no leading zeros, one dot. */
export function padPress(current: string, key: (typeof KEYS)[number]): string {
  if (key === "back") return current.slice(0, -1);
  if (key === ".") return current.includes(".") ? current : current === "" ? "0." : current + ".";
  if (current === "0") return key;
  const next = current + key;
  const dot = next.indexOf(".");
  if (dot >= 0 && next.length - dot - 1 > 3) return current;
  if (next.replace(".", "").length > 7) return current;
  return next;
}

export type SheetStep = { kind: "pick" } | { kind: "count"; row: ShelfRow };

/** THE SHEET'S INSIDE, drawn from state alone (tests render it without a browser). */
export function TakeSheetView({
  step,
  rows,
  loading,
  error,
  search,
  entry,
  busy,
  onSearch,
  onPick,
  onKey,
  onBack,
  onTake,
}: {
  step: SheetStep;
  rows: ShelfRow[];
  loading: boolean;
  error: string | null;
  search: string;
  entry: string;
  busy: boolean;
  onSearch: (s: string) => void;
  onPick: (row: ShelfRow) => void;
  onKey: (k: (typeof KEYS)[number]) => void;
  onBack: () => void;
  onTake: () => void;
}) {
  if (step.kind === "count") {
    const row = step.row;
    const qty = Number(entry || "0");
    const shortSaid = takeShortWords({ ...takeShort(row, qty), unit: row.unit });
    return (
      <div className="space-y-3">
        <button
          type="button"
          onClick={onBack}
          className="-ml-1 inline-flex min-h-[44px] items-center gap-1.5 rounded-lg px-1 text-sm font-medium text-slate-600 hover:text-slate-900"
        >
          <ArrowLeft className="h-4 w-4" /> Pick Another Item
        </button>
        <div>
          <p className="text-base font-semibold text-slate-900">{row.name}</p>
          <p className="text-sm text-slate-500">{onHandWords(row)}</p>
        </div>
        {/* The count, with the item's own unit already there: nobody types "ft". */}
        <div className="flex items-baseline justify-end gap-2 rounded-xl border border-slate-300 bg-white px-4 py-3" aria-live="polite">
          <span data-testid="take-count" className="text-4xl font-bold tabular-nums text-slate-900">
            {entry || "0"}
          </span>
          <span data-testid="take-unit" className="text-xl font-medium text-slate-500">
            {row.unit}
          </span>
        </div>
        {shortSaid && (
          <p data-testid="take-short" className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
            {shortSaid}.
          </p>
        )}
        <div className="grid grid-cols-3 gap-2">
          {KEYS.map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => onKey(k)}
              aria-label={k === "back" ? "Delete" : k}
              className="flex min-h-[56px] items-center justify-center rounded-xl border border-slate-200 bg-slate-50 text-2xl font-semibold text-slate-900 active:bg-slate-200"
            >
              {k === "back" ? <Delete className="h-6 w-6" /> : k}
            </button>
          ))}
        </div>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button
          type="button"
          onClick={onTake}
          disabled={busy || !(qty > 0)}
          className="btn-gloss flex min-h-[56px] w-full items-center justify-center gap-2 rounded-xl bg-[rgb(var(--glass-ink))] text-lg font-semibold text-white disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : null}
          Take It
        </button>
      </div>
    );
  }

  const q = search.trim().toLowerCase();
  const shown = q ? rows.filter((r) => r.name.toLowerCase().includes(q)) : rows;
  return (
    <div className="space-y-3">
      <label className="relative block">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        <input
          type="search"
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          placeholder="Search the shelf"
          aria-label="Search the shelf"
          className="h-11 w-full rounded-lg border border-slate-300 bg-white pl-9 pr-3 text-base"
        />
      </label>
      {loading && <p className="py-4 text-center text-sm text-slate-500">Reading the shelf…</p>}
      {error && <p className="text-sm text-red-600">{error}</p>}
      {!loading && !error && rows.length === 0 && (
        <p className="py-4 text-center text-sm text-slate-500">Nothing is on the shelf yet. The office puts rolls and boxes on it from their tickets.</p>
      )}
      {!loading && rows.length > 0 && shown.length === 0 && <p className="py-4 text-center text-sm text-slate-500">Nothing on the shelf is called that.</p>}
      <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white">
        {shown.map((r) => (
          <li key={r.id}>
            <button
              type="button"
              onClick={() => onPick(r)}
              className="flex min-h-[52px] w-full items-center justify-between gap-3 px-4 py-2 text-left hover:bg-slate-50"
            >
              <span className="text-base font-medium text-slate-900">{r.name}</span>
              <span className="shrink-0 text-sm text-slate-500">{onHandWords(r)}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function onHandWords(r: ShelfRow): string {
  return r.onHand > 0 ? `${fmtQty(r.onHand)} ${r.unit} on the shelf` : `None on the shelf's record`;
}

/** THE JOB'S TAKES, drawn from the rows alone. */
export function TakesListView({
  takes,
  viewerIsStaff,
  pendingGroup,
  onUndo,
  readFailed = false,
}: {
  takes: JobTake[];
  viewerIsStaff: boolean;
  pendingGroup: string | null;
  onUndo: (t: JobTake) => void;
  /** stock_takes_for_job failed: `takes` is empty because nothing was read, not because nothing was taken. */
  readFailed?: boolean;
}) {
  if (readFailed) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white">
        <div className="border-b border-slate-100 px-4 py-2.5 text-sm font-semibold text-slate-900">Taken From Stock</div>
        <p data-testid="takes-read-failed" className="px-4 py-2.5 text-sm text-amber-700">
          {TAKES_READ_FAILED}
        </p>
      </div>
    );
  }
  if (!takes.length) return null;
  return (
    <div className="rounded-xl border border-slate-200 bg-white">
      <div className="border-b border-slate-100 px-4 py-2.5 text-sm font-semibold text-slate-900">Taken From Stock</div>
      <ul className="divide-y divide-slate-100">
        {takes.map((t) => {
          const door = takeDoor(t);
          return (
            <li key={t.drawGroup} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-sm">
              <span className="text-slate-800">{takeLine(t)}</span>
              <span className="text-xs text-slate-400">{formatDateShort(t.takenAt)}</span>
              <span className="ml-auto">
                {door.kind === "undo" && (
                  <button
                    type="button"
                    disabled={pendingGroup === t.drawGroup}
                    onClick={() => onUndo(t)}
                    className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg px-3 text-sm font-medium text-brand hover:underline disabled:opacity-50"
                  >
                    Undo
                  </button>
                )}
                {door.kind === "billed" &&
                  (viewerIsStaff && t.billedInvoiceId ? (
                    <>
                      {/* Billed in part: said beside the door, so this row agrees with the Costs tab. */}
                      {door.part && <span className="text-xs text-amber-700">{door.status}</span>}
                      <Link
                        href={`/billing/${t.billedInvoiceId}`}
                        className="inline-flex min-h-[44px] items-center rounded-lg px-3 text-sm font-medium text-brand hover:underline"
                      >
                        {door.label}
                      </Link>
                    </>
                  ) : (
                    <span className="inline-flex min-h-[44px] items-center px-3 text-sm text-slate-500">{door.status}</span>
                  ))}
                {door.kind === "none" && door.why && <span className="text-xs text-slate-400">{door.why}</span>}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** The big button, the sheet, and the job's takes. */
export function TookFromStock({
  jobId,
  takes,
  viewerIsStaff,
  readFailed = false,
}: {
  jobId: string;
  takes: JobTake[];
  viewerIsStaff: boolean;
  /** The page's read of the job's takes failed (jobTakes' error): said in the list's place. */
  readFailed?: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<ShelfRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Take It threw: whether it saved is unknown. The words are worked out on render from whether the
  // takes list read on the refresh, so they never point at a list that isn't there.
  const [unheard, setUnheard] = useState<{ noSignal: boolean } | null>(null);
  const [search, setSearch] = useState("");
  const [step, setStep] = useState<SheetStep>({ kind: "pick" });
  const [entry, setEntry] = useState("");
  const [via, setVia] = useState<"sheet" | "nort">("sheet");
  const [busy, startTake] = useTransition();
  const [pendingGroup, setPendingGroup] = useState<string | null>(null);
  const prefill = useRef<{ item: string; qty: string } | null>(null);

  const read = useCallback(async () => {
    setLoading(true);
    setError(null);
    let r: Awaited<ReturnType<typeof loadShelf>>;
    try {
      r = await loadShelf();
    } catch (e) {
      // No signal in the truck: say so and leave the sheet usable, never "Reading the shelf…" forever.
      r = { ok: false, error: isTransportError(e) ? "No signal, so the shelf couldn't be read. Close this and try again." : "The shelf couldn't be read. Close this and try again." };
    } finally {
      setLoading(false);
    }
    if (!r.ok) {
      setError(r.error);
      return [] as ShelfRow[];
    }
    setRows(r.rows);
    return r.rows;
  }, []);

  const openSheet = useCallback(
    async (fill?: { item: string; qty: string } | null) => {
      setStep({ kind: "pick" });
      setEntry("");
      setSearch("");
      setError(null);
      setUnheard(null);
      setVia(fill ? "nort" : "sheet");
      setOpen(true);
      const fresh = await read();
      if (fill) {
        const row = fresh.find((r) => r.id === fill.item);
        if (row) {
          setStep({ kind: "count", row });
          setEntry(/^\d*\.?\d{0,3}$/.test(fill.qty) ? fill.qty : "");
        } else setError("That item isn't on the shelf any more. Pick what you took.");
      }
    },
    [read],
  );

  // NORT'S FILL: the job's link carries ?take=<item>&qty=60. Open the sheet filled in once, then take
  // the words off the address so a refresh doesn't open it again. A person still taps Take It.
  const takeParam = params?.get("take") ?? "";
  const qtyParam = params?.get("qty") ?? "";
  useEffect(() => {
    // Once the words are off the address, let the next fill through, even for the same item ("make
    // it 40, not 60"): Nort is an overlay, so this page stays mounted between two of its links.
    if (!takeParam) {
      prefill.current = null;
      return;
    }
    if (prefill.current?.item === takeParam && prefill.current.qty === qtyParam) return;
    prefill.current = { item: takeParam, qty: qtyParam };
    void openSheet({ item: takeParam, qty: qtyParam });
    const next = new URLSearchParams(params?.toString() ?? "");
    next.delete("take");
    next.delete("qty");
    router.replace(`${pathname}${next.toString() ? `?${next}` : ""}`, { scroll: false });
  }, [takeParam, qtyParam, openSheet, params, pathname, router]);

  const undo = useCallback(
    async (drawGroup: string) => {
      setPendingGroup(drawGroup);
      let r: Awaited<ReturnType<typeof undoTakeAction>>;
      try {
        r = await undoTakeAction(drawGroup, jobId);
      } catch (e) {
        r = {
          ok: false,
          error: isTransportError(e)
            ? "No signal, so the Undo didn't hear back. Check Taken From Stock once you have signal before tapping it again."
            : "The Undo didn't go through. Reload the job to see where it stands.",
        };
      } finally {
        setPendingGroup(null);
      }
      if (r.ok) toast(r.message, "success");
      // A billed take says which invoice holds it; that sentence has to be read, not glimpsed.
      else toast(r.error, "error", undefined, { sticky: true });
      router.refresh();
    },
    [jobId, router, toast],
  );

  const take = () => {
    if (step.kind !== "count") return;
    const qty = Number(entry || "0");
    if (!(qty > 0)) {
      setError("Say how many you took.");
      return;
    }
    const itemId = step.row.id;
    startTake(async () => {
      setError(null);
      setUnheard(null);
      let r: Awaited<ReturnType<typeof takeFromStockAction>>;
      try {
        r = await takeFromStockAction({ itemId, jobId, qty, via });
      } catch (e) {
        // A throw here would reach the page's error card and the sheet would vanish without saying
        // whether the take saved. Each Take It is a new take, so tapping again blind could take the
        // pieces twice: keep the sheet, say so, and show the job's takes as they stand.
        setUnheard({ noSignal: isTransportError(e) });
        router.refresh();
        return;
      }
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setOpen(false);
      const group = r.drawGroup;
      toast(r.message, "success", { label: "Undo", onClick: () => void undo(group) });
      router.refresh();
    });
  };

  return (
    <div className="space-y-3">
      <button
        type="button"
        onClick={() => void openSheet(null)}
        className="btn-gloss flex min-h-[56px] w-full items-center justify-center gap-2 rounded-xl border border-slate-300 bg-white px-4 text-base font-semibold text-slate-900 shadow-sm hover:bg-slate-50"
      >
        <PackageMinus className="h-5 w-5 shrink-0" /> Took From Stock
      </button>
      <TakesListView takes={takes} viewerIsStaff={viewerIsStaff} pendingGroup={pendingGroup} onUndo={(t) => void undo(t.drawGroup)} readFailed={readFailed} />
      <Modal open={open} onClose={() => setOpen(false)} title="Took From Stock" size="md" dirty={step.kind === "count" && entry !== ""}>
        <TakeSheetView
          step={step}
          rows={rows}
          loading={loading}
          error={unheard ? takeUnheardWords(unheard.noSignal, !readFailed) : error}
          search={search}
          entry={entry}
          busy={busy}
          onSearch={setSearch}
          onPick={(row) => {
            setStep({ kind: "count", row });
            setEntry("");
            setError(null);
            setUnheard(null);
          }}
          onKey={(k) => setEntry((e) => padPress(e, k))}
          onBack={() => {
            setStep({ kind: "pick" });
            setError(null);
            setUnheard(null);
          }}
          onTake={take}
        />
      </Modal>
    </div>
  );
}
