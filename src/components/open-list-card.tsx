"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Archive, Check, Columns3, Loader2, Store } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { FIELD_LABELS, sayDollars, type OpenListColumns, type OpenListField, type OpenListView, type PlanPaper } from "@/lib/supplier-open-list";
import { applyOpenList, pickOpenListAccount, pickOpenListColumns } from "@/app/(app)/bills/open-list-actions";
import { keepPaperwork } from "@/app/(app)/organize/paperwork-actions";

/**
 * A SUPPLIER'S OPEN LIST, AS ONE CARD IN SORT THESE (Erik, 2026-09-26: "we cant get too complicated
 * for the user"). One sentence says what it changes, in the supplier's own name; Apply and Not Now
 * are the only buttons; the detail is folded. When the list can't be read yet, the card asks the
 * one thing it needs (whose list, or which columns) and nothing else.
 *
 * MARKING PAPERS PAID FROM A LIST THAT MAY BE PARTIAL is never one press: a list that prints no
 * total or count of its own needs a person to tick "It's the whole list" first, and a list whose own
 * total or count says it is short closes nothing at all (Apply then only adds and corrects).
 */

type Run = (key: string, fn: () => Promise<{ ok: boolean; error?: string; message?: string }>, filedSentence?: string) => void;

const PICK_ORDER: OpenListField[] = ["reference", "openBalance", "amount", "invoiceDate", "type", "po", "dueDate", "discountAmount", "discountDate"];

const kindWord = (k: string) => (k === "credit_memo" ? "credit" : k === "service_charge" ? "service charge" : k === "statement" ? "statement" : "invoice");

function Papers({ title, papers, note }: { title: string; papers: PlanPaper[]; note?: string }) {
  if (!papers.length) return null;
  return (
    <div>
      <p className="font-medium text-slate-800">
        {title} ({papers.length})
      </p>
      {note && <p className="text-xs text-slate-500">{note}</p>}
      <ul className="mt-1 space-y-0.5">
        {papers.map((p) => (
          <li key={p.id} className="flex flex-wrap gap-x-3 text-slate-700">
            <span className="font-mono text-xs">{p.number}</span>
            <span className="text-xs text-slate-500">{p.date ?? "no date"}</span>
            <span className="ml-auto tabular-nums">{sayDollars(p.open)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function OpenListCard({
  itemId,
  view,
  run,
  busy,
  working,
}: {
  itemId: string;
  view: OpenListView | null | undefined;
  run: Run;
  busy: string | null;
  working: boolean;
}) {
  const router = useRouter();
  const [accountPick, setAccountPick] = useState(view?.suggestedAccountId ?? "");
  const [sure, setSure] = useState(false);
  const [cols, setCols] = useState<OpenListColumns>(() => view?.needs?.columns ?? {});

  const notNow = (
    <Button variant="outline" onClick={() => run("keep", () => keepPaperwork(itemId), "Set aside.")} disabled={working} title="Set it aside in Organize's Archive">
      <Archive /> Not Now
    </Button>
  );

  if (!view) {
    return (
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <p className="w-full text-sm text-slate-600">This list couldn&apos;t be compared right now. Refresh the page to try again.</p>
        {notNow}
      </div>
    );
  }

  if (view.problem) {
    return (
      <div className="mt-2 space-y-2">
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900" role="status">
          {view.problem}
        </p>
        <div className="flex flex-wrap gap-2">{notNow}</div>
      </div>
    );
  }

  // WHICH COLUMNS: asked once per supplier; the answer is remembered on their account.
  if (view.needs) {
    const n = view.needs;
    const columnName = (i: number) => (n.header[i]?.trim() ? n.header[i].trim() : `Column ${i + 1}${n.sample[0]?.[i] ? `: ${String(n.sample[0][i]).slice(0, 20)}` : ""}`);
    const ready = cols.reference !== undefined && (cols.openBalance !== undefined || cols.amount !== undefined);
    return (
      <div className="mt-2 space-y-3">
        <p className="text-sm text-slate-700">
          This reads as a supplier&apos;s list, but its column names are new to the app. Point at the columns once; they are remembered for this supplier.
        </p>
        <div className="max-w-full overflow-x-auto rounded-lg border border-slate-200">
          <table className="min-w-full text-xs">
            {n.header.length > 0 && (
              <thead className="bg-slate-50 text-left text-slate-600">
                <tr>
                  {n.header.map((h, i) => (
                    <th key={i} className="whitespace-nowrap px-2 py-1 font-medium">
                      {h || `Column ${i + 1}`}
                    </th>
                  ))}
                </tr>
              </thead>
            )}
            <tbody>
              {n.sample.map((r, ri) => (
                <tr key={ri} className="border-t border-slate-100">
                  {Array.from({ length: n.width }, (_, i) => (
                    <td key={i} className="whitespace-nowrap px-2 py-1 text-slate-700">
                      {r[i] ?? ""}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          {PICK_ORDER.map((f) => (
            <label key={f} className="flex flex-col gap-1 text-xs font-medium text-slate-600">
              {FIELD_LABELS[f]}
              {f === "reference" ? " (needed)" : f === "openBalance" ? " (needed, or Amount)" : ""}
              <Select
                value={cols[f] === undefined ? "" : String(cols[f])}
                onChange={(e) => setCols((c) => ({ ...c, [f]: e.target.value === "" ? undefined : Number(e.target.value) }))}
                disabled={working}
                className="h-11"
              >
                <option value="">Not In This List</option>
                {Array.from({ length: n.width }, (_, i) => (
                  <option key={i} value={i}>
                    {columnName(i)}
                  </option>
                ))}
              </Select>
            </label>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => run("columns", () => pickOpenListColumns(itemId, cols))} disabled={working || !ready}>
            {busy === "columns" ? <Loader2 className="animate-spin" /> : <Columns3 />} Read It With These Columns
          </Button>
          {notNow}
        </div>
      </div>
    );
  }

  // WHOSE LIST: nothing the list prints names one of the accounts.
  if (!view.plan) {
    return (
      <div className="mt-2 space-y-2">
        <p className="text-sm text-slate-700">Whose list is this? Nothing on it names one of your supplier accounts.</p>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={accountPick} onChange={(e) => setAccountPick(e.target.value)} disabled={working} className="h-11 min-w-0 flex-1 sm:w-64 sm:flex-none" aria-label="Whose List">
            <option value="">Pick A Supplier</option>
            {view.accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
          <Button onClick={() => run("account", () => pickOpenListAccount(itemId, accountPick))} disabled={working || !accountPick}>
            {busy === "account" ? <Loader2 className="animate-spin" /> : <Store />} Use This Supplier
          </Button>
          {notNow}
        </div>
      </div>
    );
  }

  const plan = view.plan;
  const asks = !plan.complete.ok && plan.complete.overridable;
  // A list its own figures call short, with nothing to add or correct: there is nothing to apply.
  const canApply = plan.complete.ok || !plan.nothing;
  const needsSure = asks && plan.close.length > 0;
  const apply = () =>
    run(
      "apply",
      async () => {
        const res = await applyOpenList(itemId, { fingerprint: plan.fingerprint, wholeList: asks && (sure || !needsSure) });
        // The books moved under the card: the page brings the new figures.
        if (res.stale) router.refresh();
        return res;
      },
      "Applied.",
    );

  return (
    <div className="mt-2 space-y-2">
      <p className="text-sm font-medium text-slate-900">{plan.headline}</p>
      {plan.discountLine && <p className="text-xs text-slate-600">{plan.discountLine}</p>}
      {!plan.complete.ok && (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900" role="status">
          {plan.complete.said}
        </p>
      )}
      {needsSure && (
        <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border border-slate-200 px-3 text-sm text-slate-800">
          <input type="checkbox" className="h-5 w-5 shrink-0" checked={sure} onChange={(e) => setSure(e.target.checked)} disabled={working} />
          It&apos;s The Whole List: Mark {plan.close.length === 1 ? "1 Paper" : `${plan.close.length} Papers`} Paid
        </label>
      )}
      {plan.firstList && !plan.nothing && (
        <p className="text-xs text-slate-600">
          This is the first list from {view.supplier}: from now on its balance here is what {view.supplier} says is open.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {canApply && (
          <Button onClick={apply} disabled={working || (needsSure && !sure)}>
            {busy === "apply" ? <Loader2 className="animate-spin" /> : <Check />} {plan.nothing && plan.complete.ok ? "Done: It Matches" : "Apply"}
          </Button>
        )}
        {notNow}
      </div>
      <details className="rounded-lg border border-slate-200 px-3 py-2 text-sm">
        <summary className="flex min-h-11 cursor-pointer items-center font-medium text-slate-700">See What It Changes</summary>
        <div className="mt-2 space-y-3">
          <p className="text-xs text-slate-500">
            Dated {view.dateSaid}. Balance here before: {sayDollars(plan.before)}; after: {sayDollars(plan.after)}
            {plan.afterNet !== plan.after ? ` in papers, ${sayDollars(plan.afterNet)} less the payment on the list` : ""}.
            {plan.closeBy
              ? ` Only papers dated ${plan.closeBy} or before can be marked paid: the newest paper on the list, or a week before its date, since a supplier can take days to post a paper.`
              : " The list prints no dates on its papers, so nothing can be marked paid from it."}
            {view.accountFrom === "number" ? " Matched by the account number it prints." : view.accountFrom === "papers" ? " Matched by papers it lists that are already on that account." : ""}
          </p>
          <Papers title="Marked Paid" papers={plan.close} note="Open here, not on the list, and dated on or before it." />
          {plan.add.length > 0 && (
            <div>
              <p className="font-medium text-slate-800">New ({plan.add.length})</p>
              <ul className="mt-1 space-y-0.5">
                {plan.add.map((a) => (
                  <li key={a.number} className="flex flex-wrap gap-x-3 text-slate-700">
                    <span className="font-mono text-xs">{a.number}</span>
                    <span className="text-xs text-slate-500">
                      {kindWord(a.kind)}
                      {a.date ? `, ${a.date}` : ""}
                      {a.po ? `, ${a.po}` : ""}
                    </span>
                    <span className="ml-auto tabular-nums">{sayDollars(a.open)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {plan.update.length > 0 && (
            <div>
              <p className="font-medium text-slate-800">Changed ({plan.update.length})</p>
              <ul className="mt-1 space-y-0.5">
                {plan.update.map((u) => (
                  <li key={u.number} className="text-slate-700">
                    <span className="font-mono text-xs">{u.number}</span> <span className="text-xs text-slate-500">{u.said}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <Papers title="Left Open, List May Be Short" papers={plan.keepPartial} note="Not on the list, but the list's own figures say it is missing papers." />
          <Papers title="Left Open, Dated After The List" papers={plan.keepNewer} note="The supplier may not have posted them yet." />
          <Papers title="Left Open, No Date" papers={plan.keepUndated} note="Nothing shows they are older than the list." />
          {plan.conflicts.length > 0 && (
            <div>
              <p className="font-medium text-slate-800">Not Touched ({plan.conflicts.length})</p>
              <ul className="mt-1 space-y-0.5 text-xs text-slate-600">
                {plan.conflicts.map((c) => (
                  <li key={c.number}>{c.why}</li>
                ))}
              </ul>
            </div>
          )}
          {plan.payments.length > 0 && (
            <div>
              <p className="font-medium text-slate-800">Payments On The List ({plan.payments.length})</p>
              <p className="text-xs text-slate-500">
                Counted in the list&apos;s total and taken off the balance above; not papers, so nothing is added for them, and the Pay figure still counts the papers they will pay.
              </p>
              <ul className="mt-1 space-y-0.5">
                {plan.payments.map((p) => (
                  <li key={p.reference} className="flex gap-x-3 text-slate-700">
                    <span className="font-mono text-xs">{p.reference}</span>
                    <span className="ml-auto tabular-nums">{sayDollars(p.open)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {plan.skipped.length > 0 && (
            <div>
              <p className="font-medium text-slate-800">Rows That Didn&apos;t Read ({plan.skipped.length})</p>
              <ul className="mt-1 space-y-0.5 text-xs text-slate-600">
                {plan.skipped.map((s) => (
                  <li key={s.line}>
                    Line {s.line}: {s.why}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {plan.nothing && <p className="text-slate-600">Every paper on the list matches what is here.</p>}
        </div>
      </details>
    </div>
  );
}
