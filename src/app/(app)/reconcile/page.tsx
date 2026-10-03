import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { isStaffRole } from "@/lib/actions/perms";
import { getOrgSettings } from "@/lib/org-settings";
import { viewerSeesOwnerMoney } from "@/lib/bank-viewer";
import { PageHeader } from "@/components/page-header";
import { Card } from "@/components/ui/card";
import { formatCurrency } from "@/lib/utils";
import { reportError } from "@/lib/observe";
import { papersOnNoAccountAside, settledAtTheRegisterSentence } from "@/lib/supplier-owed";
import { readSupplierOwed } from "@/lib/supplier-owed-read";
import {
  RECONCILE_KINDS,
  openKindsHere,
  reconcileRowsWaiting,
  type ReconcileAnsweredHere,
} from "@/lib/reconcile-kinds";
import { figuresFrom, readReconcileWork, supplierGapRows } from "./reconcile-read";
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
import { BankDropLine } from "./bank-drop-line";
import { readStatementCards } from "./statement-cards";
import { PaperworkList } from "@/components/paperwork-row";

export const dynamic = "force-dynamic";
/**
 * A SERVER ACTION RUNS UNDER THIS PAGE'S TIME (api/paperwork/read/route.ts says so; intake's page says
 * it too). Bring In A Statement now hosts a read that is an Opus transcription of a whole statement —
 * up to four passes of 16,000 output tokens — so the platform default would end the invocation in the
 * middle of it, which says nothing to the person and cannot meter the tokens already bought. The
 * reader gets the reader's own time, as Bills and Organize already give theirs (audit v994, SI4); 300
 * is what google/sync and the intake page use. 60 would be the kill, not the cure: forty lines is
 * already tens of seconds of model output. The read keeps its OWN budget inside this one
 * (statement-scan.ts SCAN_READ_MS), so it always comes back in words.
 */
export const maxDuration = 300;

/**
 * WHAT TO CALL THE SUPPLIER FIGURES READ WHEN IT DOES NOT COME BACK AT ALL. Its own failures arrive
 * named by table ("bills", "payments you have sent"); a thrown read names nothing, so it gets words
 * that mean something to him rather than a module name.
 */
const OWED_READ = "what your suppliers say you owe";

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
 *     queue and are ANSWERED on their own card under Needs You, which is where that stays. The
 *     supplier gap is read-only here and links to the card that owns those figures. Bringing one IN
 *     is a different thing and it does live here (Bring In A Statement, at the bottom): an intake is
 *     not a control, and Snap Or Note on Bills still takes the same files, so this is not the only
 *     way in either.
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

  // ── WHO MAY BRING A BANK DOWNLOAD IN, ASKED OF THE ONE RULE ──────────────────────────────────
  // A bank download is the owner's draw and personal spending line by line, so the drop door below
  // is gated exactly as it was on /analytics: by the owner's "Office Can See This" switch (0286).
  // The condition is NOT re-derived here — `viewerSeesOwnerMoney` (lib/bank-viewer.ts) is the one
  // function /analytics, the accountant page, its download route and every bank action ask, and a
  // page that spelled the condition out again is how the two sides of one rule drift apart.
  //
  // A FAILED SETTINGS READ IS A NO, never the default: the default is ON, so a lost read would hand
  // the owner's money to an office viewer the owner had switched off.
  //
  // AND THE OWNER IS ASKED FIRST, in viewerSortsBank's own order (bank-viewer.ts: "THE OWNER'S ANSWER
  // NEVER DEPENDS ON THE SWITCH, so their yes costs no second read"). Reading first and requiring the
  // row made a lost read a no for the OWNER too — his own door gone, and copy written for somebody
  // else in its place, while the same owner was still a yes through every server action. Fail-closed
  // is for the office viewer the switch is about; nobody can hand the owner money he already owns.
  let sortsBank = viewerSeesOwnerMoney(me.role, false);
  if (!sortsBank) {
    const { data: orgRow } = await supabase.from("organizations").select("settings").eq("id", orgId).maybeSingle();
    sortsBank = !!orgRow && viewerSeesOwnerMoney(me.role, getOrgSettings((orgRow as { settings?: unknown }).settings).office_sees_owner_money);
  }

  // ── THE FIGURES COME FIRST, BECAUSE THE PILES USE THEM ───────────────────────────────────────
  // One read for both supplier questions (and the identity and coverage behind them), then one read
  // for the rows this page draws. The second needs the first's answers so a spelling's unpaid slice
  // matches the Suppliers card to the cent, so they are not parallel — and that is the trade: one
  // extra round trip against two screens that can never disagree about a dollar.
  //
  // AND A THROWN READ IS A FAILED READ WITH A NAME, NEVER A SILENT NULL. `.catch(() => null)` here
  // turned the whole supplier half into nothing, and nothing then read as "nothing disagrees" — the
  // false all-clear audit v1018 names as its own class of fault. Caught, named, and said out loud.
  const owedRead = await readSupplierOwed(supabase, orgId).then(
    (r) => ({ owed: r, threw: false }),
    (e: unknown) => {
      // Named in the ops sink as well as on the screen, the way the shell's own caught reads are:
      // the screen tells him it could not check, and the sink tells us why it could not.
      reportError("reconcile:supplier-owed", e, { orgId });
      return { owed: null, threw: true };
    },
  );
  const owed = owedRead.owed;
  const work = await readReconcileWork(supabase, orgId, figuresFrom(owed));

  // ── THE STATEMENTS DROPPED HERE, ANSWERED HERE (2026-10-03) ──────────────────────────────────
  // Erik: "so it still doesnt make sense to me that all this reconcile stuff is on the bills page."
  // A bank download and a supplier's open list compare two records, which is this page's whole
  // sentence, so their cards live where they are dropped instead of sending him to /bills to press
  // Apply. The rule is lib/paperwork's `answeredOnReconcile`, read by this page and by Bills.
  //
  // AND IT IS WHY THE ALL-CLEAR BELOW MAY NOW SPEAK OF THE QUEUE AT ALL: it used to say "Nothing
  // here is waiting on you" precisely because this page did not read `organized_items`. It does now,
  // so `statementsWaiting` is in `nothingAtAll` — the sentence counts what it claims.
  const statements = await readStatementCards(supabase, orgId);
  const statementsWaiting = statements.items.length;

  // ── THE SUPPLIER GAP: TWO RECORDS, BOTH HANDED IN ────────────────────────────────────────────
  // One row per supplier whose own papers we hold, built by the read rather than here. Why it is not
  // filtered off "what you owe your suppliers" is written at `supplierGapRows`: a supplier whose own
  // papers are all CLOSED is owed nothing, has no line there, and is the loudest disagreement there is.
  const gapRows: SupplierGapRow[] = supplierGapRows(owed);
  const gaps = disagreeing(gapRows);
  const disputed = moneyInDispute(gaps);

  // ── THE DECISIONS, EACH DRAWN ONLY WHILE IT HAS SOMETHING OPEN ───────────────────────────────
  const open = openKindsHere(work.counts);
  const waiting = reconcileRowsWaiting(work.counts);
  const has = (k: ReconcileAnsweredHere) => open.includes(k);

  // ── WHAT COULD NOT BE READ, IN ONE LIST, BECAUSE THE LEAD IS WHERE HE STOPS READING ──────────
  // Two reads stand behind this page and either can lose a table. Whichever did, the sentence under
  // the one number may not claim an all-clear: with the supplier half unread "your papers line up" is
  // a sentence the app cannot stand behind, and he acts on the lead without scrolling.
  const couldNotRead = [...new Set([...(owed?.failed ?? []), ...work.failed, ...(owedRead.threw ? [OWED_READ] : []), ...(statements.error ? ["the statements waiting on you"] : [])])];
  const allRead = couldNotRead.length === 0;

  // The papers on no supplier account. They are in NEITHER side of any gap, so this page says so in
  // its own words — `notOnAnAccountSentence` is the Suppliers card's, where "of this" is true.
  const papersOnNoAccount = owed?.owed.notOnAnAccount.papers ?? 0;
  const notOnAnAccount = owed ? papersOnNoAccountAside(owed.owed.notOnAnAccount, formatCurrency) : null;
  // ── AND WHAT THE OPEN TEST TOOK OUT OF THAT PILE, IN ONE SENTENCE, WHEREVER THE PILE LANDS ──────
  // A purchase paid at the register has one record and is no disagreement, so it is not a row — and
  // nothing may leave a figure in silence. The sentence used to be typed inside the rows card, which
  // draws nothing when it has no rows, and the shape the measured book is in is exactly that: every
  // open paper held by a suggestion further up, or the whole pile settled and no section at all. So
  // the page holds the sentence and hands it to whichever of the three places is the one drawn.
  const settledSaid = settledAtTheRegisterSentence(work.notOnAccount.settledAtTheRegister);

  // ── WHICH SUGGESTION ABOVE ALREADY HOLDS THIS PILE'S ONLY ROW ─────────────────────────────────
  // Every paper on no account is in exactly one of the three name sections, and the pile's own
  // section draws what no suggestion speaks for. So a pile of ONE, under a spelling the matcher does
  // have an opinion about, left this section unrendered — and /bills' File It door, which links to
  // its anchor, landed on nothing. The anchor is drawn either way now, and when the row really is
  // upstairs it says which question holds it. Null when no question does, so the sentence is never
  // written over an empty page.
  const askedAbove: ReconcileAnsweredHere | null =
    (["supplier-names", "same-supplier-or-two"] as const).find((k) => has(k)) ?? null;

  // ── NOTHING TO READ AND NOTHING TO PRESS ────────────────────────────────────────────────────
  // Plain words, never an error, and never an empty heading. It must answer for EVERY pile the page
  // draws, including the papers on no account — /bills' own "File It" door lands here because of
  // them, and "Nothing for you to do here" printed directly above that pile is a dead end.
  const nothingAtAll = allRead && !gaps.length && !open.length && !papersOnNoAccount && !statementsWaiting;

  return (
    <div>
      <PageHeader title="Reconcile" description="Two records that should agree, and do not." />

      {/* ── THE ONE NUMBER ───────────────────────────────────────────────────────────────────────
          Erik leads with a figure, not a tally: "$5,600 of what you bought is not on your suppliers'
          papers" is something an electrician between jobs can act on; "14 things" is not. Where there
          is no money gap the lead is what is waiting, said as plain words — and where there is nothing
          at all it says so, which is not an error.

          AND IT NEVER CLAIMS WHAT IT DID NOT CHECK. Every all-clear below is gated on `allRead`, and
          each clause of the all-clear sentence names one pile this page really counted: a sentence
          that says the books line up over a pile it could not read is the worst thing on the page,
          because it is the one he acts on without scrolling. */}
      <Card id="reconcile-lead" className="mb-6 p-4">
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
            {/* EVERY CLAUSE IS A PILE THIS PAGE COUNTED, AND IT SPEAKS OF WHAT IS OPEN. It used to say
                "no ticket is filed twice" — which is a claim about the whole book, printed directly
                above the card naming a ticket he had already answered on two jobs. A pick he has made
                keeps its row on purpose; what is true is that none is WAITING on him. */}
            {/* AND IT CLAIMS ONLY WHAT IT COUNTED. It used to say "every supplier name is on an
                account", which the open test turned into a steady-state lie: settling the last open
                unmatched paper — which is precisely what he does with these ("anything not on an
                account will most likely be squared up as paid like everything else in my bills") —
                empties this pile while thirty-two names sit on no account, every one of them settled.
                What the page counted is that none of them is WAITING on an account, so that is what
                it says, and the settled count is said in the next breath rather than left out. */}
            {/* AND IT DOES NOT SAY "NOTHING FOR YOU TO DO HERE" OVER A DOOR. The statement door below
                is drawn even on an all-clear page — that is the moment he brings the next download in
                — and a flat "nothing to do" printed above it reads as a contradiction, so where the
                door is drawn the sentence ends by naming it instead.
                IT STILL SAYS "HERE", AND THE WORD IS LOAD-BEARING — for a different reason since
                2026-10-03. It used to be the scope: the door CREATED waiting work this page never read,
                so a bare "nothing is waiting on you" would have been printed over "Waiting under Needs
                You on Bills". The card is answered on this page now, so the page DOES read the queue
                (`statementsWaiting`), and the all-clear is gated on it being empty — which is what
                earned the right to say anything about it at all. "Here" stays because the claim is
                still only about what this page counted: a receipt waiting on Bills is not in it. */}
            <p className="mt-1 text-sm text-slate-600">
              Your bills and your suppliers&apos; own papers line up, no supplier name is waiting to be put on an account,
              and no ticket is waiting on you to pick a job.{" "}
              {sortsBank
                ? "Nothing here is waiting on you — when the next download comes off your bank or a supplier, drop it in below."
                : "Nothing for you to do here."}
            </p>
            {settledSaid && <p className="mt-1 text-sm text-slate-600">{settledSaid}</p>}
          </>
        ) : (
          <>
            <p className="text-base font-semibold text-slate-900">
              {waiting > 0
                ? `${waiting} ${waiting === 1 ? "Thing" : "Things"} To Sort Out`
                : !allRead
                  ? "Couldn't Check Everything Just Now"
                  : papersOnNoAccount > 0
                    ? `${papersOnNoAccount} ${papersOnNoAccount === 1 ? "Paper" : "Papers"} Not On A Supplier Account Yet`
                    : statementsWaiting > 0
                      ? `${statementsWaiting} ${statementsWaiting === 1 ? "Statement" : "Statements"} Waiting On You`
                      : "Nothing To Sort Out Right Now"}
            </p>
            {/* "No money gap" is itself an all-clear, so it waits on every read landing. */}
            <p className="mt-1 text-sm text-slate-600">
              {allRead
                ? "No money gap between your bills and your suppliers' own papers."
                : "Some of what this page compares could not be read just now, so there is no figure to lead with."}
              {/* WHAT IS BELOW, NAMED OFF THE RECORD RATHER THAN TYPED HERE. It used to say "supplier
                  names and tickets filed twice" whatever was actually drawn, which went stale the
                  moment the pile stopped being about names at all. */}
              {waiting > 0 ? ` What is below is ${open.map((k) => RECONCILE_KINDS[k].heading).join(", ")}.` : ""}
              {/* A STATEMENT HE DROPPED IS WAITING ON HIM, ON THIS PAGE, and it is named here because
                  this is where he stops reading. It is not one of the typed kinds (reconcile-kinds.ts):
                  a paper waiting for Apply is the answer to the intake door at the bottom, not a
                  disagreement between two records of ours, so it is a sentence and never a badge. */}
              {statementsWaiting > 0
                ? ` ${statementsWaiting === 1 ? "A statement you brought in is" : `${statementsWaiting} statements you brought in are`} waiting under Bring In A Statement below.`
                : ""}
            </p>
          </>
        )}
        {couldNotRead.length > 0 && (
          <p className="mt-2 text-sm text-amber-800" role="alert">
            Couldn&apos;t read {couldNotRead.join(", ")} just now, so{" "}
            {work.failed.length > 0 ? "nothing below is counted" : "some of what is below may be short"}. Reload the
            page to try again.
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

      {/* ── THE PILE /bills' "File It" DOOR LANDS ON ─────────────────────────────────────────────
          IT IS DRAWN WHENEVER THE PILE HAS A PAPER IN IT, not only while this kind has a row
          waiting. The door on the Suppliers card links to this anchor, and an anchor that is not
          drawn is a dead end: the one measured open paper arrived under a spelling the fuzzy matcher
          DID have an opinion about, so it was a row in the suggestions above and this section was
          never rendered — the door landed on a page with nothing about the paper it had just named.
          The COUNT stays open-only (badges show open); only the drawing is widened. */}
      {(has("not-on-an-account") || (papersOnNoAccount > 0 && askedAbove)) && (
        <section id={RECONCILE_KINDS["not-on-an-account"].anchor} className="scroll-mt-20">
          <SupplierUnfiledSpellings
            spellings={work.loose}
            // The Suppliers card's own door is what turns a running balance on, and copy must not
            // promise a button that is not there: the accounts read is what that door needs, and it
            // is the read this page just made.
            canSetOnAccount={!work.failed.includes("supplier accounts")}
            // ONE NUMBER FOR ONE PILE: the figure here is the same `notOnAnAccount` object the File
            // It door on /bills quotes, handed down the read rather than totalled again.
            figure={work.notOnAccount.figure}
            unnamed={work.notOnAccount.unnamed}
            settledAtTheRegister={work.notOnAccount.settledAtTheRegister}
            actions={{ fileAsItsOwnAccount: fileSpellingAsItsOwnAccount }}
          />
          {/* NO ROW OF ITS OWN, BUT THE PAPER IS UPSTAIRS. Every spelling in the pile is already
              offered a door in a suggestion above, so this section would be empty — and empty is the
              dead end. One line, pointing at the row that exists. */}
          {!has("not-on-an-account") && askedAbove && (
            <Card className="mb-6 p-4">
              {/* THE SAME HEADING AND THE SAME MONEY THE ROWS CARD WOULD HAVE SHOWN, out of the same
                  `notOnAnAccount` object /bills' File It door quotes. This card drew the count and no
                  figure at all, so the door said "$215.00 On 2 Bills" and landed on a card with no
                  money on it — one pile, two readings, nothing on either page joining them. */}
              <h2 className="text-base font-semibold text-slate-900">
                {RECONCILE_KINDS["not-on-an-account"].heading} ({papersOnNoAccount})
                {(work.notOnAccount.figure?.total ?? 0) > 0.005 ? (
                  <span className="font-normal text-slate-500"> · {formatCurrency(work.notOnAccount.figure!.total)} Still Open</span>
                ) : null}
              </h2>
              <p className="mt-1 text-sm text-slate-600">
                Every one of these is already in a question above, under the name on the paper, so it is answered there
                rather than twice.
              </p>
              {/* AND THE SETTLED PAPERS ARE ACCOUNTED FOR HERE TOO. This card is what gets drawn in the
                  shape the measured book is in, and the sentence lived in the card that is NOT drawn:
                  sixty-nine papers left a figure in silence on the one page whose law forbids it. */}
              {settledSaid && <p className="mt-1 text-sm text-slate-600">{settledSaid}</p>}
              <Link
                href={`#${RECONCILE_KINDS[askedAbove].anchor}`}
                className="mt-1 flex min-h-11 items-center text-sm font-medium text-brand hover:underline"
              >
                Go To The Question
              </Link>
            </Card>
          )}
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

      {/* ── BRING ONE IN HERE; IT IS ANSWERED WHERE THE PAPER IS ────────────────────────────────
          THE DOOR Erik asked for twice: "i want to upload my bank statement and supplier statement,
          every item will either match or need a category", and on finding it over on Money, "this
          should be in reconcile too i imagine". So it moved here and left /analytics — one door, on
          the page named for the job.

          AND IT HOLDS NO APPLY, WHICH IS THE LAW: "reconcile is the bottom fold filling in dots not
          controlling systems, a peace maker". Bringing a paper IN is an intake, not a control.
          ANSWERING it stays on the paper's own card under Needs You, the one place every paper is
          answered — carrying that Apply here would make Reconcile the only door to a queued paper,
          the one thing the law forbids outright.

          IT IS DRAWN EVEN WHEN NOTHING DISAGREES. It used to sit inside {!nothingAtAll}, which hid
          it at precisely the moment a person opens this page: the book is quiet and he has the next
          download in his hand. An all-clear page with no way to put anything on it is a dead end.

          IT NAMES NO FORMATS. Erik, 2026-10-02: "i dont want people to have to jump on a merry go
          round to do shit." This line used to list CSV, TSV, a text table, Excel old or new and a
          bank's OFX/QFX/QBO, which is a lecture on file types nobody should have to learn: a person
          is emailed a PDF and hands it over. Since the PDF reads (pdf-table.ts), the sentence is
          "drop what you were given" and the app works out what it is. Where one format really is
          better — OFX carries the bank's own transaction id, so an overlapping download can never
          count a line twice (0363's fitid: key) — that is the APP's preference to act on, never a
          choice to hand the person.

          AND IT NO LONGER NAMES A DOOR THIS ONE CANNOT DO. The sentence here used to send a SCANNED
          statement to the + button, which was true and is not any more: a scan is read off its pages
          and held against its own printed figures (statement-scan.ts). What the copy promises instead
          is the thing that makes a model read safe to look at — the arithmetic, and the plain word
          when a paper prints nothing to check against. Copy that promises or refuses the wrong thing
          is how he finds out by being turned away.

          AND IT SAYS "PICTURES", NOT "no text at all". The lane takes every PDF the text lane cannot
          tabulate, which includes his own September statement — that file HAS text (125 marks of
          back-page legal notice) and its table is an image. "With no text on its pages at all" was
          narrower than the code, and the drop line said the same untrue thing (bank-drop-line.tsx).
          The duration is here for the same reason: looking at the pages is a model reading a whole
          statement, which is not "a few seconds". */}
      {/* THE ANCHOR IS DRAWN FOR EVERY STAFF VIEWER, both halves of the gate, because the Net Profit
          card on /analytics links to it: an anchor that is not drawn is the dead end this page's own
          "File It" door already taught us (see the not-on-an-account section above). */}
      <Card id="bring-in-a-statement" className="mb-6 scroll-mt-20 p-4">
        <h2 className="text-base font-semibold text-slate-900">Bring In A Statement</h2>
        {sortsBank ? (
          <>
            {/* WHAT THIS SAYS IS TRACED TO THE CODE, LINE BY LINE (onboarding-truth law, rewritten
                2026-10-02 when the running-balance walk shipped). The old paragraph was written when the
                statement's printed totals were the only arithmetic there was, and it ended "if your
                statement prints no totals at all, it says that too, so you know nothing but your own eyes
                has checked it" — which became FALSE the moment a paper with no totals and a walking
                balance started saying "its own running balance proves every line" (statement-verify.ts).
                It also never named the walk, so a scan turned away on a chain break was turned away for a
                reason the page had never mentioned. Every clause below names something the code does:
                the walk (balanceChain), the refusal on a scan (statement-scan-actions.ts), the warning on
                a file (open-list-add-core.ts has no pass gate, on purpose), and the silence when a paper
                prints neither (verifySaid). */}
            <p className="mb-2 mt-1 text-sm text-slate-600">
              Drop your statement here — whatever your bank or supplier gave you, in whatever form they gave it.
              North works out what it is. Then it checks the read: every line has to add up against the running
              balance printed beside it, so each line proves the one before it to the cent, and the line underneath
              says how many of them it held and where it stopped if it stopped. A statement that also prints a
              beginning balance, an ending balance or totals is held against those as well. If two columns could both
              be the amount, it asks you which is which and adds them up once you have said. A statement whose lines
              are PICTURES is read as well — scanned, photographed, or a PDF whose columns don&apos;t come off as
              text: its pages are looked at, and then its own figures are held against what came off them, to the
              cent. A card statement is read the way a card works, where what you owe goes up with a purchase. On a
              picture, a read its own paper disagrees with is refused and nothing is added; on a file off your bank
              those rows are the bank&apos;s own, so the line says what doesn&apos;t add up and names the line to go
              and look at. If the paper prints no totals and no running balance, it says that out loud, so you know
              nothing but your own eyes has checked it. Looking at the pages takes a minute, and a long statement
              takes a few.
            </p>
            <BankDropLine />
          </>
        ) : (
          /* NOT A TEASE AND NOT A DEAD DOOR: no control is drawn, and the line names the door that
             IS this viewer's. A bank download is the owner's own money (0286), so the owner brings
             those in; a supplier's open list comes in through Snap Or Note on Bills like any paper. */
          <p className="mt-1 text-sm text-slate-600">
            The owner brings in bank downloads: they show the owner&apos;s own money line by line. A supplier&apos;s own
            list of what is open goes in through Snap Or Note on Bills, the same as any other paper.
          </p>
        )}
        {/* ── AND IT IS ANSWERED RIGHT HERE (2026-10-03) ──────────────────────────────────────
            Erik: "so it still doesnt make sense to me that all this reconcile stuff is on the bills
            page." He dropped a statement at the line above and then walked to /bills to press Apply —
            a merry-go-round for one paper. The card that arrives is the ANSWER to this card, so it is
            inside this one: no second section of its own, and no second place to answer the same paper.

            THIS IS NOT THE APPLY THE LAW FORBIDS. The law is "reconcile is the bottom fold filling in
            dots not controlling systems, a peace maker" — Reconcile must not RUN things. Answering a
            statement IS the reconciliation: two records held against each other, line by line, with a
            person pressing. What the law forbids is this page owning a record, and it still owns none
            — every write goes through the same server action the card always called.

            THE CARD, NOT A COPY OF IT. `PaperworkRow` returns the bank card or the open-list card and
            nothing else for these two states, which is why it takes no jobs and no number matches
            here: a statement is never filed onto a job. */}
        {statements.error ? (
          <p className="mt-2 text-sm text-amber-800" role="alert">
            {statements.error} Reload the page to try again.
          </p>
        ) : statementsWaiting > 0 ? (
          <div className="mt-3 space-y-3">
            <p className="text-sm text-slate-600">
              {statementsWaiting === 1 ? "This one is waiting on you" : `These ${statementsWaiting} are waiting on you`}: every
              line either matches a paper you already have or asks you what it was for, and nothing is written until you
              press Apply.
            </p>
            <PaperworkList items={statements.items} jobs={[]} matches={{}} />
          </div>
        ) : (
          <p className="mt-1 text-sm text-slate-600">
            Whatever you drop waits here on its own card: every line either matches a paper you already have or asks you
            what it was for, and nothing is written until you press Apply.
          </p>
        )}
      </Card>
    </div>
  );
}
