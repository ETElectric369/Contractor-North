import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { isStaffRole } from "@/lib/actions/perms";
import { PageHeader } from "@/components/page-header";
import { Card } from "@/components/ui/card";
import { formatCurrency } from "@/lib/utils";
import { notOnAnAccountSentence } from "@/lib/supplier-owed";
import { readSupplierOwed } from "@/lib/supplier-owed-read";
import {
  RECONCILE_KINDS,
  openKindsHere,
  reconcileRowsWaiting,
  type ReconcileAnsweredHere,
} from "@/lib/reconcile-kinds";
import { figuresFrom, readReconcileWork } from "./reconcile-read";
import { SupplierGap, disagreeing, moneyInDispute, type SupplierGapRow } from "./supplier-gap";
import { SupplierCandidateReview, SupplierMergeReview, SupplierUnfiledSpellings } from "@/app/(app)/bills/supplier-merge-review";
import { SupplierDuplicates } from "@/app/(app)/bills/supplier-duplicates";
import {
  acceptSupplierMerge,
  dismissSupplierMerge,
  fileSpellingAsItsOwnAccount,
  resolveDuplicateBill,
  unresolveDuplicateBill,
} from "@/app/(app)/bills/supplier-actions";

export const dynamic = "force-dynamic";

/**
 * ── RECONCILE ─────────────────────────────────────────────────────────────────────────────────
 *
 * Erik, 2026-10-01, and it is the acceptance test for every line of this page:
 *
 *   "reconcile is the bottom fold filling in dots not controlling systems, a peace maker"
 *
 * EVERY ROW IS THE SAME SENTENCE: two records that should agree, and do not. Our tickets against
 * the supplier's own open papers. Five spellings against one supplier. A spelling against no
 * account at all. One ticket against two jobs. Nothing else belongs here, and the kinds are a typed
 * Record (lib/reconcile-kinds.ts) so a sixth kind cannot ship without somebody writing down what
 * its two records are, what it is counted by, and where its button lives.
 *
 * ── WHERE THIS CAME FROM ──────────────────────────────────────────────────────────────────────
 *
 * All of it was crammed into one collapsed fold at the bottom of /bills, under the heading "More".
 * That fold was a confession: somebody already knew this work did not belong on the page that
 * answers "what came in and what do I owe", and had nowhere to put it. The fold is gone now, not
 * hidden — /bills keeps Snap Or Note, Add By Hand, Needs You, the paper feed, the Suppliers card
 * and All Bills, and points here with ONE link where it needs to.
 *
 * ── THE FOUR THINGS THIS PAGE MAY NOT DO ──────────────────────────────────────────────────────
 *
 *  1. IT OWNS NO RECORD. An account is owned by the Suppliers card; a bill by the bill. Every write
 *     here goes through a server action /bills already had, writing supplier_aliases,
 *     supplier_accounts or bills.superseded_by_bill_id — nothing of this page's own. There is no
 *     reconcile table and there must never be one.
 *  2. IT IS NEVER THE ONLY DOOR. A bank download and a supplier's open list arrive in the one paper
 *     queue and are answered on their own card under Needs You, which is where they stay. The
 *     supplier gap is read-only here and links to the card that owns those figures.
 *  3. IT READS THE SAME FUNCTIONS THE OWNING SCREENS READ. Every supplier figure comes out of
 *     `readSupplierOwed` — the one read behind Nort, the Suppliers card, the workbook and the P&L —
 *     and no amount is added up on this page.
 *  4. IT PROPOSES; A PERSON PRESSES. Additive, non-destructive, and nothing happens on arrival.
 *
 * ── STAFF ONLY, AND IT IS A REDIRECT RATHER THAN A HIDDEN ROW ────────────────────────────────
 *
 * Techs never see prices. The dock row is staffOnly, which hides the door; this redirect is the
 * boundary — nothing below it reads a figure or serializes one into a prop for a man who should not
 * see it. (/bills itself has no page-level role check; that is not a pattern to copy. /payroll is.)
 */
export default async function ReconcilePage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { data: me } = await supabase.from("profiles").select("org_id, role").eq("id", user?.id ?? "").maybeSingle();
  if (!me || !isStaffRole(me.role)) redirect("/timeclock");
  const orgId = String((me as { org_id?: string }).org_id ?? "");

  // ── THE FIGURES COME FIRST, BECAUSE THE PILES USE THEM ───────────────────────────────────────
  // One read for both supplier questions (and the identity and coverage behind them), then one read
  // for the rows this page draws. The second needs the first's answers so a spelling's unpaid slice
  // matches the Suppliers card to the cent, so they are not parallel — and that is the trade: one
  // extra round trip against two screens that can never disagree about a dollar.
  const owed = await readSupplierOwed(supabase, orgId).catch(() => null);
  const work = await readReconcileWork(supabase, orgId, figuresFrom(owed));

  // ── THE SUPPLIER GAP: TWO RECORDS, BOTH HANDED IN ────────────────────────────────────────────
  // Only where two records EXIST to disagree — an account whose own papers we hold (model
  // `their-own-papers`). An account we hold no papers for has one record, not two, and its figure is
  // already our own tickets less what we have sent them: putting it here would invent a quarrel.
  const gapRows: SupplierGapRow[] = (owed?.owed.lines ?? [])
    .filter((l) => l.how === "their-own-papers" && l.accountId)
    .map((l) => {
      const ours = owed?.boughtByAccount[l.accountId];
      return {
        accountId: l.accountId,
        name: l.name,
        theirs: l.owed,
        ours: ours?.total ?? 0,
        oursPapers: ours?.papers ?? 0,
      };
    });
  const gaps = disagreeing(gapRows);
  const disputed = moneyInDispute(gaps);

  // ── THE DECISIONS, EACH DRAWN ONLY WHILE IT HAS SOMETHING OPEN ───────────────────────────────
  const open = openKindsHere(work.counts);
  const waiting = reconcileRowsWaiting(work.counts);
  const has = (k: ReconcileAnsweredHere) => open.includes(k);

  // Nothing to read and nothing to press. Plain words, never an error, and never an empty heading.
  const nothingAtAll = !gaps.length && !open.length && !work.failed.length && !(owed?.failed.length ?? 0);

  // The papers on no supplier account, in the words the Suppliers card and Nort already use.
  const notOnAnAccount = owed ? notOnAnAccountSentence(owed.owed.notOnAnAccount, formatCurrency) : null;

  return (
    <div>
      <PageHeader title="Reconcile" description="Two records that should agree, and do not." />

      {/* ── THE ONE NUMBER ───────────────────────────────────────────────────────────────────────
          Erik leads with a figure, not a tally: "$5,600 of what you bought is not on your suppliers'
          papers" is something an electrician between jobs can act on; "14 things" is not. Where
          there is no money gap the lead is what is waiting, said as plain words — and where there is
          nothing at all it says so, which is not an error. */}
      <Card className="mb-6 p-4">
        {disputed > 0.005 ? (
          <>
            <p className="text-3xl font-bold tabular-nums tracking-tight text-slate-900">{formatCurrency(disputed)}</p>
            <p className="mt-1 text-sm text-slate-600">
              is the difference between what your own bills say you bought on account and what your suppliers&apos; own
              papers say is still open, across {gaps.length} {gaps.length === 1 ? "supplier" : "suppliers"}.
            </p>
          </>
        ) : nothingAtAll ? (
          <>
            <p className="text-base font-semibold text-slate-900">Nothing Disagrees Right Now</p>
            <p className="mt-1 text-sm text-slate-600">
              Your bills and your suppliers&apos; own papers line up, every supplier name is on an account, and no ticket
              is filed twice. Nothing for you to do here.
            </p>
          </>
        ) : (
          <>
            <p className="text-base font-semibold text-slate-900">
              {waiting > 0
                ? `${waiting} ${waiting === 1 ? "Thing" : "Things"} To Sort Out`
                : "Nothing To Sort Out Right Now"}
            </p>
            <p className="mt-1 text-sm text-slate-600">
              No money gap between your bills and your suppliers&apos; own papers.
              {waiting > 0 ? " What is below is supplier names and tickets filed twice." : ""}
            </p>
          </>
        )}
        {work.failed.length > 0 && (
          <p className="mt-2 text-sm text-amber-800" role="alert">
            Couldn&apos;t read {work.failed.join(", ")} just now, so nothing below is counted. Reload the page to try
            again.
          </p>
        )}
        {notOnAnAccount && <p className="mt-2 text-sm text-slate-600">{notOnAnAccount}</p>}
      </Card>

      <SupplierGap
        rows={gapRows}
        couldNotTotal={owed?.owed.couldNotTotal ? [...owed.owed.couldNotTotal] : []}
        failed={owed?.failed ?? []}
      />

      {/* SUPPLIER-NAME HOUSEKEEPING, in the order of how sure the app is: what it thinks, what it
          cannot tell, what it has no opinion about. The three piles are derived from each other —
          what is "loose" is what no proposal and no question already speaks for — so they are built
          together and drawn together, or the same spelling gets two buttons doing one thing. */}
      {has("supplier-names") && (
        <section id={RECONCILE_KINDS["supplier-names"].anchor} className="scroll-mt-20">
          <SupplierMergeReview
            proposals={work.proposals}
            actions={{ acceptMerge: acceptSupplierMerge, dismissMerge: dismissSupplierMerge }}
          />
        </section>
      )}

      {has("same-supplier-or-two") && (
        <section id={RECONCILE_KINDS["same-supplier-or-two"].anchor} className="scroll-mt-20">
          <SupplierCandidateReview
            questions={work.questions}
            actions={{ acceptMerge: acceptSupplierMerge, dismissMerge: dismissSupplierMerge }}
          />
        </section>
      )}

      {has("not-on-an-account") && (
        <section id={RECONCILE_KINDS["not-on-an-account"].anchor} className="scroll-mt-20">
          <SupplierUnfiledSpellings
            spellings={work.loose}
            // The Suppliers card's own door is what turns a running balance on, and copy must not
            // promise a button that is not there: the accounts read is what that door needs, and it
            // is the read this page just made.
            canSetOnAccount={!work.failed.includes("supplier accounts")}
            actions={{ fileAsItsOwnAccount: fileSpellingAsItsOwnAccount }}
          />
        </section>
      )}

      {/* The picker is not drawn at all on a database without 0271's superseded_by_bill_id: a
          control that could only refuse is a dead end wearing a button. */}
      {work.supersedeReady && work.duplicates.length > 0 && (
        <SupplierDuplicates
          groups={work.duplicates}
          actions={{ resolveDuplicate: resolveDuplicateBill, unresolveDuplicate: unresolveDuplicateBill }}
        />
      )}

      {/* ── WHAT IS ANSWERED SOMEWHERE ELSE, SAID ONCE ──────────────────────────────────────────
          A bank download against the books, and a supplier's open list against our bills, are both
          this page's sentence — and both arrive as a PAPER in the one paper queue and are answered
          on their own card under Needs You. Carrying their Apply here would make Reconcile the only
          door to a queued paper, which is the one thing Erik's law forbids outright. So this is a
          line of words and a link, never a control. */}
      {!nothingAtAll && (
        <Card className="mb-6 p-4">
          <h2 className="text-base font-semibold text-slate-900">Answered Where The Paper Is</h2>
          <p className="mt-1 text-sm text-slate-600">
            A bank download against your books, and a supplier&apos;s open list against your bills, are the same kind of
            disagreement — and both arrive as a paper and are answered on the paper&apos;s own card under Needs You, the
            one place every paper is answered. Nothing about them is repeated here.
          </p>
          <Link href="/bills" className="mt-1 flex min-h-11 items-center text-sm font-medium text-brand hover:underline">
            Open Bills
          </Link>
        </Card>
      )}
    </div>
  );
}
