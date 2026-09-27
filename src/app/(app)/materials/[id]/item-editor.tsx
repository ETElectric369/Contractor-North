"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2, Pencil, Check, ChevronDown, Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { formatCurrency } from "@/lib/utils";
import { useToast } from "@/components/toast";
import { checklistGroups, openToBuyCount, tickWord, toBuyWords } from "@/lib/materials-checklist";
import {
  addMaterialItem,
  deleteMaterialItem,
  updateMaterialItem,
  setMaterialItemPurchased,
  setMaterialItemTool,
  ensureJobMaterialList,
} from "../actions";

interface Item {
  id: string;
  description: string;
  part_number: string | null;
  quantity: number;
  unit: string | null;
  /** Optional because a tech's page projection never selects them (see the
   *  viewerIsStaff note below) — they simply aren't on the wire. */
  vendor?: string | null;
  est_cost?: number | null;
  purchased?: boolean;
  is_tool?: boolean;
}

type Flip = { from: boolean; to: boolean };

/** The optimistic ticks still waiting on the server: a flip leaves once the server's `purchased`
 *  equals its `to` (settled), when its line is gone, or when it never changed anything (from = to).
 *  Returns the same map when nothing settled, so the effect re-renders nothing. */
export function settleFlips(flips: ReadonlyMap<string, Flip>, items: readonly { id: string; purchased?: boolean }[]): Map<string, Flip> {
  const server = new Map(items.map((i) => [i.id, !!i.purchased]));
  let next: Map<string, Flip> | null = null;
  for (const [id, f] of flips) {
    if (!server.has(id) || server.get(id) === f.to || f.from === f.to) (next ??= new Map(flips)).delete(id);
  }
  return next ?? (flips as Map<string, Flip>);
}

/** The one materials item editor — the /materials/[id] page AND the job hub's
 *  Materials tab both render THIS (no forked row logic). The job tab passes
 *  listId: null when the job has no list yet: the editor still shows the add row,
 *  and the FIRST added item lazily ensures the job's canonical list
 *  (ensureJobMaterialList) — so viewing never creates data, adding does.
 *
 *  ONE LIST, TWO VIEWS (Erik, 2026-09-11): "techs should have easy access to the same
 *  materials list per job (just one, the same one) and honestly we probably won't ever
 *  be putting prices in those lines anyway." So a tech gets THIS editor, not a read-only
 *  copy — add / edit / remove lines, tick bought — and the only thing that differs is
 *  that money is the office's: with viewerIsStaff=false there is no est. cost, no vendor,
 *  no list total and no tool toggle. The DB pins those columns for techs anyway (a
 *  trigger, not just the UI), so this isn't the boundary — it just keeps them off the
 *  screen so nothing here is a control he can't use. Everything else is pixel-identical,
 *  because the point is that it is visibly THE SAME list the office is looking at.
 *
 *  A CHECKLIST (Erik, 2026-09-27: "this is really just a checklist and the checked boxes can
 *  fold away"). What's still to buy stays on top; a checked line folds into ONE "Bought (N)"
 *  fold at the bottom, closed until someone opens it, and unchecking it there brings it back up.
 *  "Checked" is the list's own `purchased` column, written by the same setMaterialItemPurchased
 *  as always: only the grouping is new (lib/materials-checklist).
 *
 *  Every target is 44px (one-handed, at the supply house): the checkbox sits in a 44px label,
 *  and the line's words ARE its edit door (the pencil is the cue, inside the same button), with
 *  Remove on the edit row. That is the job's Tasks list's shape too: tap a task to open it. */
export function ItemEditor({
  listId,
  items,
  jobId,
  viewerIsStaff = true,
}: {
  listId: string | null;
  items: Item[];
  /** Enables the lazy list-ensure when listId is null (job Materials tab). */
  jobId?: string;
  /** false = a tech: same list, same verbs, no money and no tool toggle. */
  viewerIsStaff?: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // add
  const [desc, setDesc] = useState("");
  const [part, setPart] = useState("");
  const [qty, setQty] = useState(1);
  const [unit, setUnit] = useState("ea");
  const [vendor, setVendor] = useState("");
  const [cost, setCost] = useState(0);
  // edit
  const [editId, setEditId] = useState<string | null>(null);
  const [eDesc, setEDesc] = useState("");
  const [ePart, setEPart] = useState("");
  const [eQty, setEQty] = useState(1);
  const [eUnit, setEUnit] = useState("ea");
  const [eVendor, setEVendor] = useState("");
  const [eCost, setECost] = useState(0);
  // The Bought fold: closed until someone opens it (the open lines lead).
  const [foldOpen, setFoldOpen] = useState(false);
  // THE TICK LANDS UNDER THE THUMB. A checked line moves to the fold the moment it is tapped, not a
  // round trip later: `from` is the server's value when it was tapped, so the flip applies only while
  // the server still says `from` (the save in flight).
  const [flips, setFlips] = useState<Map<string, Flip>>(new Map());
  // ...and it is DROPPED the moment the server agrees with it. A settled flip left in the map would
  // wake up again later: someone else unticks the line, the next refresh brings back `from`, and this
  // screen would show it Bought while the chip and Buy Materials count it open. An in-flight flip
  // (the server still says `from`) stays, so an unrelated refresh landing first can't flicker it.
  useEffect(() => {
    setFlips((m) => settleFlips(m, items));
  }, [items]);

  const bought = (it: Item) => {
    const f = flips.get(it.id);
    const server = !!it.purchased;
    return f && f.from === server ? f.to : server;
  };
  const view = items.map((it) => ({ ...it, purchased: bought(it) }));
  const total = view.reduce((s, i) => s + (i.est_cost ?? 0) * i.quantity, 0);
  const openCount = openToBuyCount(view);
  // Tools float to the top (grab from the shop first), materials to buy below, both in their own
  // sort_order; every checked line (tools too) folds into Bought. The tools-first grouping is for
  // the crew (load what you own, then shop), so a tech still sees it — he just can't move a line
  // between the groups.
  const groups = checklistGroups(view);

  function add() {
    if (!desc.trim()) return;
    setError(null);
    start(async () => {
      let lid = listId;
      if (!lid) {
        if (!jobId) return setError("No list to add to.");
        const ensured = await ensureJobMaterialList(jobId);
        if (!ensured.ok || !ensured.id)
          return setError(ensured.error ?? "Could not start the job's materials list.");
        lid = ensured.id;
      }
      // A tech's line lands with no vendor and no cost — the office fills those in
      // later if it ever wants to. The inputs don't exist on his screen, so the
      // state is untouched anyway; nulls here make that explicit rather than relying
      // on the initial "" / 0 happening to coerce.
      const res = await addMaterialItem(lid, {
        description: desc,
        part_number: part || null,
        quantity: qty || 1,
        unit: unit || "ea",
        vendor: viewerIsStaff ? vendor || null : null,
        est_cost: viewerIsStaff ? cost || null : null,
      });
      if (!res.ok) return setError(res.error ?? "Could not add the item.");
      setDesc("");
      setPart("");
      setQty(1);
      setUnit("ea");
      setVendor("");
      setCost(0);
      router.refresh();
    });
  }

  // Toggle/edit/delete only ever fire on an existing row, so listId is real by
  // then — the lid guards below are for the type system, not a reachable path
  // (const capture so the narrowing survives into the transition closure).
  function remove(id: string) {
    const lid = listId;
    if (!lid) return;
    setError(null);
    start(async () => {
      const res = await deleteMaterialItem(id, lid);
      if (!res.ok) return setError(res.error ?? "Could not remove the item.");
      setEditId(null);
      router.refresh();
    });
  }

  // TICK, TICK, TICK AT THE COUNTER. A tick is not the card's shared transition: it used to be, and
  // every checkbox went disabled while any one line saved, so the next line (sliding up under the
  // thumb as the ticked one folded away) ignored a quick second tap. Each line saves on its own
  // (setMaterialItemPurchased is one row), and only the line still saving refuses a second tap, so
  // two writes for one line can't race.
  const [saving, setSaving] = useState<ReadonlySet<string>>(new Set());

  function toggleBought(it: Item) {
    const lid = listId;
    if (!lid || saving.has(it.id)) return;
    saveTick(lid, it, !!it.purchased, !bought(it));
  }

  // One tick's round trip. Only functional state updates and stable handles (router, toast), so the
  // toast's Undo can run it seconds later from an older render and still be right.
  function saveTick(lid: string, it: Item, from: boolean, next: boolean) {
    setFlips((m) => new Map(m).set(it.id, { from, to: next }));
    setSaving((s) => new Set(s).add(it.id));
    setError(null);
    void (async () => {
      const res = await setMaterialItemPurchased(it.id, lid, next).catch(() => ({
        ok: false as const,
        error: "Couldn't reach the server. Try again.",
      }));
      setSaving((s) => {
        const n = new Set(s);
        n.delete(it.id);
        return n;
      });
      if (!res.ok) {
        // Refused: the line goes back where it was, and the sentence says why: on the card, and as a
        // toast, because the card's top can be a long scroll above the line on a phone.
        setFlips((m) => {
          const n = new Map(m);
          n.delete(it.id);
          return n;
        });
        const why = res.error ?? "Could not update.";
        setError(why);
        toast(why, "error");
        return;
      }
      // A ticked line folds away into the closed Bought fold, so the tick says where it went, with an
      // Undo: a mis-tap at the counter is one tap to take back, never a fold to open and a line to
      // find (the job's Tasks card does the same when a checked task leaves it).
      if (next) {
        toast(`${tickWord(it)}: ${it.description}`, "success", {
          label: "Undo",
          onClick: () => saveTick(lid, it, true, false),
        });
      }
      router.refresh();
    })();
  }

  function toggleTool(it: Item) {
    const lid = listId;
    if (!lid) return;
    setError(null);
    start(async () => {
      const res = await setMaterialItemTool(it.id, lid, !it.is_tool);
      if (!res.ok) return setError(res.error ?? "Could not update.");
      router.refresh();
    });
  }

  const renderRow = (it: Item) =>
    editId === it.id ? (
      <li key={it.id} className="space-y-2 bg-slate-50/80 px-3 py-3">
        <div className="flex gap-2">
          <Input value={eDesc} onChange={(e) => setEDesc(e.target.value)} className="h-11 flex-1" placeholder="Description" aria-label="Description" />
          <Input value={ePart} onChange={(e) => setEPart(e.target.value)} className="h-11 w-24 shrink-0" placeholder="Part #" aria-label="Part #" />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <NumberInput value={eQty} onValueChange={setEQty} className="h-11 w-16 text-center" aria-label="Quantity" />
          <Input value={eUnit} onChange={(e) => setEUnit(e.target.value)} className="h-11 w-16 shrink-0" aria-label="Unit" />
          {viewerIsStaff && (
            <>
              <Input value={eVendor} onChange={(e) => setEVendor(e.target.value)} className="h-11 min-w-[7rem] flex-1" placeholder="Vendor" aria-label="Vendor" />
              <NumberInput value={eCost} onValueChange={setECost} className="h-11 min-w-[6rem] flex-1 text-right" placeholder="Est. cost" aria-label="Est. cost" />
            </>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={() => remove(it.id)} disabled={pending} className="px-3 text-red-600 hover:text-red-700">
            <Trash2 /> Remove
          </Button>
          <Button variant="outline" onClick={() => setEditId(null)} className="ml-auto">
            Cancel
          </Button>
          <Button onClick={saveEdit} disabled={pending || !eDesc.trim()}>
            <Check /> Save
          </Button>
        </div>
      </li>
    ) : (
      <li key={it.id} className="flex items-center gap-1 pr-2 text-sm">
        {/* 44px: the checkbox is the row's most-tapped target, one-handed at the counter. */}
        <label className="flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center">
          <input
            type="checkbox"
            checked={!!it.purchased}
            onChange={() => toggleBought(it)}
            disabled={saving.has(it.id)}
            aria-label={it.purchased ? `Not ${tickWord(it)} Yet: ${it.description}` : `${tickWord(it)}: ${it.description}`}
            className="h-5 w-5 rounded border-slate-300 text-brand focus:ring-brand"
          />
        </label>
        <button
          type="button"
          onClick={() => startEdit(it)}
          disabled={pending}
          title="Edit this line"
          className="flex min-h-[44px] min-w-0 flex-1 items-center gap-2 py-1 text-left"
        >
          <span className={`min-w-0 flex-1 ${it.purchased ? "opacity-50" : ""}`}>
            <span className={`block font-medium text-slate-800 ${it.purchased ? "line-through" : ""}`}>{it.description}</span>
            <span className="block text-xs text-slate-400">
              {it.part_number ? `#${it.part_number} · ` : ""}
              {it.quantity} {it.unit}
              {viewerIsStaff && it.est_cost != null ? ` × ${formatCurrency(it.est_cost)}` : ""}
            </span>
          </span>
          {viewerIsStaff && (
            <span className="shrink-0 font-medium text-slate-900">
              {it.est_cost != null ? formatCurrency(it.est_cost * it.quantity) : "—"}
            </span>
          )}
          <Pencil className="h-3.5 w-3.5 shrink-0 text-slate-300" aria-hidden />
        </button>
        {viewerIsStaff && (
          <button
            onClick={() => toggleTool(it)}
            disabled={pending}
            className={`flex h-11 w-11 shrink-0 items-center justify-center ${it.is_tool ? "text-amber-500" : "text-slate-300 hover:text-amber-500"}`}
            aria-label={it.is_tool ? "Unmark Tool" : "Mark As A Tool"}
            title={it.is_tool ? "Tool — tap to unmark" : "Mark as a tool (sorts to the top)"}
          >
            <Wrench className="h-4 w-4" />
          </button>
        )}
      </li>
    );

  function startEdit(it: Item) {
    setEditId(it.id);
    setEDesc(it.description);
    setEPart(it.part_number ?? "");
    setEQty(it.quantity);
    setEUnit(it.unit ?? "ea");
    setEVendor(it.vendor ?? "");
    setECost(it.est_cost ?? 0);
  }

  function saveEdit() {
    const lid = listId;
    if (!lid || !editId || !eDesc.trim()) return;
    setError(null);
    start(async () => {
      // A tech's edit never carries vendor / est_cost: the patch is Partial, and a key
      // that isn't sent isn't touched — so his fixing a typo in the description can't
      // wipe a cost the office already put on the line (and can't trip the DB pin).
      const res = await updateMaterialItem(editId, lid, {
        description: eDesc,
        part_number: ePart || null,
        quantity: eQty || 1,
        unit: eUnit || "ea",
        ...(viewerIsStaff ? { vendor: eVendor || null, est_cost: eCost || null } : {}),
      });
      if (!res.ok) return setError(res.error ?? "Could not save.");
      setEditId(null);
      router.refresh();
    });
  }

  const nothingOpen = items.length > 0 && groups.tools.length === 0 && groups.toBuy.length === 0;

  return (
    <div className="rounded-xl border border-slate-200 bg-white">
      {error && <div className="border-b border-red-100 bg-red-50 px-4 py-2 text-sm text-red-700">{error}</div>}
      {/* ADD AT THE TOP (Erik 2026-09-08: "Add an item needs to be at the top" / "Can't add new
          materials"). It used to sit under the whole list: on a phone, adding a 12th item meant
          scrolling past eleven, and the field ended up at the bottom of the page where the
          keyboard covers it — which is what "can't add" felt like. It's the first thing on the
          card now, so the list you're building grows underneath what you're typing into.
          Qty/unit/vendor/cost wrap onto their own line rather than sharing one crushed row. */}
      <div className="space-y-2 border-b border-slate-100 bg-slate-50/60 p-3">
        <div className="flex gap-2">
          <Input placeholder="Add an item…" value={desc} onChange={(e) => setDesc(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} className="h-11 flex-1" />
          <Input placeholder="Part #" value={part} onChange={(e) => setPart(e.target.value)} className="h-11 w-24 shrink-0" />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <NumberInput value={qty} onValueChange={setQty} className="h-11 w-16 text-center" placeholder="Qty" />
          <Input value={unit} onChange={(e) => setUnit(e.target.value)} className="h-11 w-16 shrink-0" placeholder="ea" />
          {viewerIsStaff && (
            <>
              <Input value={vendor} onChange={(e) => setVendor(e.target.value)} className="h-11 min-w-[7rem] flex-1" placeholder="Vendor" />
              <NumberInput value={cost} onValueChange={setCost} className="h-11 min-w-[6rem] flex-1 text-right" placeholder="Est. cost" />
            </>
          )}
          <Button onClick={add} disabled={pending || !desc.trim()} className="ml-auto shrink-0">
            <Plus className="h-4 w-4" /> Add
          </Button>
        </div>
      </div>
      <ul className="divide-y divide-slate-100">
        {groups.tools.length > 0 && (
          <li className="flex items-center gap-1.5 bg-amber-50/70 px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-amber-700">
            <Wrench className="h-3.5 w-3.5" /> Tools — grab from the shop
          </li>
        )}
        {groups.tools.map(renderRow)}
        {groups.tools.length > 0 && groups.toBuy.length > 0 && (
          <li className="bg-slate-50/70 px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">To Buy</li>
        )}
        {groups.toBuy.map(renderRow)}
        {items.length === 0 && <li className="px-4 py-6 text-center text-slate-400">No items yet — add one above.</li>}
        {nothingOpen && <li className="px-4 py-3 text-sm text-slate-500">Everything on this list is bought.</li>}
      </ul>

      {/* THE BOUGHT FOLD: every checked line, closed until someone opens it. Unchecking a line in
          here brings it back up to the top. */}
      {groups.bought.length > 0 && (
        <div className="border-t border-slate-100">
          <button
            type="button"
            onClick={() => setFoldOpen((v) => !v)}
            aria-expanded={foldOpen}
            className="flex min-h-[44px] w-full items-center justify-between px-4 text-left text-sm font-medium text-slate-600 hover:bg-slate-50"
          >
            Bought ({groups.bought.length})
            <ChevronDown className={`h-4 w-4 transition-transform ${foldOpen ? "rotate-180" : ""}`} />
          </button>
          {foldOpen && <ul className="divide-y divide-slate-100 border-t border-slate-100">{groups.bought.map(renderRow)}</ul>}
        </div>
      )}

      {/* The footer: what's left to buy, in plain words, and (office only) the list's est. total —
          money, so it's the office's. */}
      {items.length > 0 && (
        <div className="flex items-center justify-between border-t border-slate-100 px-4 py-2 text-sm">
          <span className="text-slate-500">{toBuyWords(openCount)}</span>
          {viewerIsStaff && <span className="font-semibold text-slate-900">{formatCurrency(total)}</span>}
        </div>
      )}
    </div>
  );
}
