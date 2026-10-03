import { sayDay, sayDollars } from "@/lib/supplier-open-list";

/**
 * ONE VERIFICATION FOR A STATEMENT, HOWEVER IT ARRIVED (2026-10-02).
 *
 * Erik asked for this after cn-v1050 shipped a totals check on the SCANNED path only: "I imagine
 * everything will get verified with the reconcile anyway no matter what document is input correct, the
 * way that the PDF needs his own verification system — is there a second one for all of it as I'm
 * imagining there is?" The honest answer was no, and he was right that there should be. What the app
 * already had was about NOT COUNTING TWICE (a line matched against everything in the books within
 * three days) and A PERSON LOOKING (nothing written until Apply). Neither answers "is what I just read
 * complete and correct?".
 *
 * SO THIS MODULE HOLDS BOTH CHECKS, AND EVERY DOOR ASKS IT — the CSV/Excel/OFX path, the text-PDF path
 * and the scanned-statement path alike:
 *
 *   1. THE CHAIN. Every line proves the one before it: the running balance the file prints after one
 *      line, plus the next line's money, is the balance printed after that one, in integer cents.
 *   2. THE PRINTED TOTALS (lifted out of statement-scan.ts, unchanged): beginning + in - out ===
 *      ending, and the lines going each way against the two totals a statement prints.
 *
 * WHY THE CHAIN IS THE BETTER OF THE TWO, and why it is the one that got widened:
 *   · IT WORKS ON EVERY SOURCE. A running balance is printed on a bank CSV, an Excel export and a
 *     statement's pages alike; a beginning/ending balance and two printed totals are a STATEMENT's
 *     furniture, which a download of six weeks' activity simply does not have.
 *   · IT CATCHES MORE. A totals check passes when two errors cancel; a chain cannot. It catches a
 *     missing line, a duplicated line, a wrong amount and a flipped sign.
 *   · IT LOCALISES. A totals check says "you are $47 out somewhere". A chain says "it broke at line
 *     23, by $47" — the difference between a person finding it and giving up.
 *
 * AND IT NEVER CLAIMS WHAT IT DID NOT CHECK. A check with no figure to check against does not fail; it
 * goes UNRUN and is NAMED. "This paper prints no figures to hold the read against" is a sentence that
 * has to be in front of a person at the moment he presses Apply.
 *
 * PURE: cents in, verdict out. No model, no HTTP, no database, no org — so it can be tested to the
 * cent, and so the one place that knows what was checked is the one place that says so.
 */

// ── HOW HARD TO LOOK ───────────────────────────────────────────────────────────────────────────

/**
 * HOW THESE LINES WERE READ (Erik, on the four tiers of reliability: a person should be told how hard
 * to look). It is said after the fact, in one short clause, with no decision attached to it — NO MERRY
 * GO ROUND (Erik, 2026-10-02): the person dropped what he was given and the app worked out what it is.
 *
 *   rows    — the file's own rows (CSV, Excel, OFX/QFX). Arithmetic from end to end, no transcription.
 *   page    — lifted off a PDF's own text. Code read it, but a column read one place over is possible.
 *   picture — a model looked at the pixels. A proposal, never a write, and the one path that refuses
 *             its own read when the arithmetic disagrees.
 */
export type StatementSource = "rows" | "page" | "picture";

/** The clause that names the source, in plain words for an electrician between jobs. */
export function sourceSaid(source: StatementSource): string {
  if (source === "picture") return "Read from a picture of the page.";
  if (source === "page") return "Read off the page itself.";
  return "Read from the file's own rows.";
}

// ── THE CHAIN ──────────────────────────────────────────────────────────────────────────────────

/**
 * One line as the chain sees it: where it is on the paper, its day, its money in signed cents, and the
 * running balance the file printed AFTER it (null when this line carries none). This is a structural
 * shape on purpose — BankLine satisfies it — so this module needs no import from the bank reader and
 * the two cannot become a cycle.
 */
export type ChainLine = {
  row: number;
  postedOn: string;
  cents: number;
  balanceAfterCents: number | null;
};

/** Where the chain stopped adding up, and by how much, so a person can go and find it on the paper. */
export type ChainBreak = {
  /** The line in the file (BankLine.row), and its day. Both, because "line 23" alone is no help on
   *  paper and "Sep 12" alone is no help in a spreadsheet. */
  row: number;
  day: string;
  /** How far apart the printed balance and the walked one are. Always a magnitude. */
  offByCents: number;
};

export type ChainCheck = {
  /** Did it run at all? False is never a failure — it is a thing to SAY. */
  ran: boolean;
  /** Links checked (a link is one step of the walk), and the lines they were walked across. */
  links: number;
  lines: number;
  /** How many of those lines carry a printed balance: the coverage figure a partial column needs. */
  withBalance: number;
  /** The file lists its lines newest-first, so the walk ran down the page backwards in time. */
  reversed: boolean;
  /** The balance is what is OWED (a card), not money held, so the walk runs the other way. */
  card: boolean;
  /**
   * THE FIRST FEW LINKS THAT BROKE, the first one first — and `broke` is how many there were in all.
   *
   * IT IS CAPPED because this verdict is STORED on the download (a jsonb column), and a file whose column
   * walks for a while and then goes wrong everywhere would otherwise put thousands of break objects in
   * one row. Nothing is lost: the report says the first break in full and counts the rest, because one
   * missing line can break more than one link and a refusal listing forty of them is useless.
   */
  breaks: ChainBreak[];
  /** How many links broke in all, however many of them `breaks` kept. */
  broke: number;
  /** Links settled as a DAY rather than line by line (see SAME-DAY LINES below). */
  sameDay: number;
  /** Why it could not run, when it could not. Null when it ran. */
  why: string | null;
};

/**
 * THE FOUR SHAPES A PRINTED RUNNING BALANCE MAY HAVE, and not one of them is guessed at.
 *
 * ORDER. A download may be newest-first or oldest-first, and a chain walked backwards fails on a
 * perfectly correct file. DATE ORDER ALONE CANNOT ANSWER IT: a statement whose lines are all one day
 * tells you nothing, and a two-line file tells you almost nothing. So the order is not sniffed — the
 * walk is tried both ways round and a shape only counts if it explains the WHOLE file.
 *
 * SENSE. A bank account's balance is money you HAVE, so money in raises it. A CARD's balance is what
 * you OWE, so a purchase raises it and the payment lowers it. Same two directions, same treatment.
 *
 * WHY THIS IS NOT "TRY BOTH AND TAKE WHICHEVER HAS FEWER BREAKS". A broken file breaks in EVERY shape,
 * because a shape has to explain every link to be believed; nothing here can repair one. The only
 * thing the four shapes decide is which reading the SENTENCE is written against, so the break named is
 * the one a person can go and find. A file is reported as clean only when some shape has NO break in
 * it at all.
 */
type Shape = { reversed: boolean; card: boolean };
const SHAPES: readonly Shape[] = [
  { reversed: false, card: false },
  { reversed: true, card: false },
  { reversed: false, card: true },
  { reversed: true, card: true },
];

/** Lines sharing a day, in the order the file prints them: one block per day, in printed order. */
function dayBlocks(seq: readonly ChainLine[]): ChainLine[][] {
  const out: ChainLine[][] = [];
  for (const l of seq) {
    const last = out[out.length - 1];
    if (last && last[0].postedOn === l.postedOn) last.push(l);
    else out.push([l]);
  }
  return out;
}

type Walk = { agreed: number; sameDay: number; breaks: ChainBreak[] };

/**
 * ONE DAY'S LINES, WALKED STRICTLY: the balance reached so far, plus each line's money in turn, has to
 * be the balance printed beside that line. Null `ok` means some line in the day didn't follow.
 *
 * A LINE WITH NO BALANCE PRINTED ON IT STOPS THE WALK AND STARTS IT AGAIN at the next line that has
 * one. A bank leaves a line out of its own balance column when it has not posted it, and walking such a
 * line's amount THROUGH the column would break a correct file — a check that cries wolf is worse than
 * no check at all. The links checked are then fewer than the lines, and the report says both figures.
 */
function strictDay(from: number | null, block: readonly ChainLine[], sign: 1 | -1): { ok: boolean; agreed: number; close: number | null } {
  let cursor = from;
  let agreed = 0;
  for (const l of block) {
    if (l.balanceAfterCents === null) {
      cursor = null;
      continue;
    }
    if (cursor === null) {
      cursor = l.balanceAfterCents;
      continue;
    }
    if (cursor + sign * l.cents !== l.balanceAfterCents) return { ok: false, agreed: 0, close: null };
    agreed++;
    cursor = l.balanceAfterCents;
  }
  return { ok: true, agreed, close: cursor };
}

/**
 * ONE WALK DOWN THE FILE IN ONE SHAPE.
 *
 * SAME-DAY LINES, AND WHY A DAY GETS A SECOND CHANCE. Several transactions on one day may be printed in
 * an order they did not post in, so the running balance beside them can look out of step while the file
 * is perfectly correct. So each day is held to the STRICT line-by-line walk first — full strength, and
 * what almost every file does — and only a day that fails it is held to its own NET instead: the day's
 * money added to the balance before it has to land on a balance printed somewhere inside that day,
 * because the day's net is what the balance column actually proves whichever order its lines are in.
 * That is counted, and SAID, as a day settled rather than a line. A line MISSING out of such a day
 * still breaks it, because the day's net is then wrong by exactly that line.
 *
 * AFTER A BREAK THE WALK GOES ON FROM THE FILE'S OWN FIGURE, not from the one it wanted. One bad line
 * then breaks ONE link and the lines after it are judged on their own merits — which is why a refusal
 * here names a line and not forty.
 */
function walk(lines: readonly ChainLine[], shape: Shape): Walk {
  const seq = shape.reversed ? [...lines].reverse() : lines;
  const sign = shape.card ? -1 : 1;
  let agreed = 0;
  let sameDay = 0;
  const breaks: ChainBreak[] = [];
  let close: number | null = null;
  for (const block of dayBlocks(seq)) {
    const strict = strictDay(close, block, sign);
    if (strict.ok) {
      agreed += strict.agreed;
      close = strict.close;
      continue;
    }
    // NOTHING TO ENTER THE DAY FROM, so the day's net cannot be checked either (its own lines disagree
    // with each other, and which of its printed balances is the day's CLOSE is exactly what is unknown).
    // It goes UNCHECKED and the walk starts again at the next day — never reported, because a figure
    // worked out from a missing one is the "something wrong" this is here to say nothing instead of.
    // Only a multi-line day can land here: a single line with no balance before it simply seeds the walk.
    if (close === null) continue;
    const printed = block.map((l) => l.balanceAfterCents).filter((b): b is number => b !== null);
    const net = block.reduce((n, l) => n + l.cents, 0);
    const want = close + sign * net;
    if (block.length > 1 && printed.includes(want)) {
      // THE DAY ADDS UP, its lines are simply not printed in the order its balance was worked out in.
      agreed++;
      sameDay++;
      close = want;
      continue;
    }
    const last = printed[printed.length - 1];
    breaks.push({ row: Math.min(...block.map((l) => l.row)), day: block[0].postedOn, offByCents: Math.abs(last - want) });
    close = last;
  }
  return { agreed, sameDay, breaks };
}

/**
 * WHY NOTHING WAS WALKED, each a whole clause rather than a fragment the sentence has to prop up: these
 * go straight on the card, and "it prints no running balance" twice in one sentence is how a report
 * starts reading like a machine instead of like a person.
 */
const NO_COLUMN = "this file prints no running balance beside its lines, so nothing here walked them against one";
const ONE_BALANCE = "only one of its lines carries a running balance, so there is no walk to make";
const NO_PAIR = "no two lines next to each other both carry a running balance, so there was no walk to make";
/**
 * A "Balance" COLUMN THAT IS NOT A RUNNING ACCOUNT BALANCE. A supplier's open list prints one too — its
 * "Balance" is what is still open on each paper, and bank-download.ts keeps the word out of BANK_ONLY
 * for exactly this reason — and a bank's export may carry an available balance on one row in ten.
 *
 * SUCH A COLUMN MUST SAY NOTHING RATHER THAN SOMETHING WRONG, so it is believed only once at least ONE
 * link in it actually walks. A column of per-paper balances walks nowhere at all (its steps are the
 * difference between two papers' amounts, not one line's money), so it falls out here instead of being
 * reported as forty breaks, which is the shape a check that cries wolf takes.
 */
const NOT_RUNNING = "its Balance column doesn't walk with its lines, so it isn't a running account balance and nothing was walked against it";

/** The most breaks kept with the verdict: enough to look at, few enough to store. */
const KEEP_BREAKS = 5;

/**
 * THE CHAIN, AND IT IS THE WHOLE POINT OF THIS LANE: every line proves the one before it.
 *
 *     balance after line n  +  line n+1's money  ===  balance after line n+1,  in integer cents
 *
 * Integer cents, never floats: 0.1 + 0.2 is not 0.3, and a chain that disagreed by a hundredth of a
 * cent on a correct file would be a check that cries wolf on every statement.
 */
export function balanceChain(lines: readonly ChainLine[]): ChainCheck {
  const withBalance = lines.filter((l) => (l.balanceAfterCents ?? null) !== null).length;
  const base = { links: 0, lines: lines.length, withBalance, reversed: false, card: false, breaks: [] as ChainBreak[], broke: 0, sameDay: 0 };
  if (withBalance === 0) return { ...base, ran: false, why: NO_COLUMN };
  if (withBalance === 1) return { ...base, ran: false, why: ONE_BALANCE };
  const clean = lines.map((l) => ({ ...l, balanceAfterCents: l.balanceAfterCents ?? null }));
  // THE SHAPE THAT EXPLAINS THE MOST OF THE FILE, and the first shape in the list wins a tie, so the
  // same file always reports the same way round. `sameDay` breaks a tie last: a reading that needed no
  // day-level forgiveness is the stricter one, and the stricter true reading is the one to report.
  let best = { shape: SHAPES[0], w: walk(clean, SHAPES[0]) };
  for (const shape of SHAPES.slice(1)) {
    const w = walk(clean, shape);
    const better = w.agreed > best.w.agreed || (w.agreed === best.w.agreed && (w.breaks.length < best.w.breaks.length || (w.breaks.length === best.w.breaks.length && w.sameDay < best.w.sameDay)));
    if (better) best = { shape, w };
  }
  const links = best.w.agreed + best.w.breaks.length;
  if (links === 0) return { ...base, ran: false, why: NO_PAIR };
  if (best.w.agreed === 0) return { ...base, ran: false, why: NOT_RUNNING };
  return {
    ran: true,
    links,
    lines: lines.length,
    withBalance,
    reversed: best.shape.reversed,
    card: best.shape.card,
    breaks: best.w.breaks.slice(0, KEEP_BREAKS),
    broke: best.w.breaks.length,
    sameDay: best.w.sameDay,
    why: null,
  };
}

// ── THE PRINTED TOTALS (moved here from statement-scan.ts, unchanged) ──────────────────────────

/** Which way this account's balance moves. Null: the reader didn't say, so "deposit" is assumed. */
export type ScanAccountKind = "deposit" | "card";

/** The statement's own control figures, in cents. Null means the paper does not print it. */
export type ScanControls = {
  beginning: number | null;
  ending: number | null;
  /** Printed totals as positive magnitudes: a statement may print its withdrawals as -4,210.00. */
  deposits: number | null;
  withdrawals: number | null;
  /**
   * A BANK ACCOUNT'S BALANCE AND A CARD'S RUN OPPOSITE WAYS, and the gate has to walk the right one.
   * On a deposit account the balance is money you HAVE, so money in raises it; on a card it is what
   * you OWE, so a purchase raises it and a payment lowers it. One walk for both refused EVERY
   * correctly read card statement — and this lane is offered for cards in as many words (SCAN_KIND
   * _SYSTEM: "a bank's or card company's statement").
   */
  account: ScanAccountKind | null;
};

export type ScanFail = { which: "withdrawals" | "deposits" | "balance" | "chain"; said: string; offByCents: number };

export type ScanCheck = {
  /** May these lines be proposed at all? False only when a check RAN and disagreed. */
  pass: boolean;
  /** The checks that ran and agreed, in plain words. */
  agreed: string[];
  /** The checks that could not run, each saying which figure the paper does not print. */
  unchecked: string[];
  /** Every check that ran and disagreed: which, by how much, in words a person can act on. */
  failed: ScanFail[];
};

/** A MAGNITUDE: what went out, what came in, how far apart two figures are. Never a balance. */
const D = (cents: number) => sayDollars(Math.abs(cents) / 100);
/**
 * A BALANCE, WITH ITS SIGN. An overdrawn account prints -300.00 and the reader copies it as printed,
 * so stripping the sign gave a sentence that contradicted itself and the paper: "$300.00 to start …
 * ends at $190.00 — $10.00 short" reads as OVER, and neither figure is on his statement. The sentence
 * exists so a person can go and find the line; it has to match what he is holding.
 */
const S = (cents: number) => sayDollars(cents / 100);
const gap = (lines: number, printed: number) => `${D(Math.abs(lines - printed))} ${lines < printed ? "short" : "over"}`;

/** How the balance walk is named in the report, so which direction held is never left to be guessed. */
const BALANCE_SAID = { deposit: "the balance from end to end", card: "the balance from end to end (a card's balance: what you owe)" } as const;

/**
 * THE WHOLE REASON A MODEL MAY TOUCH A STATEMENT AT ALL: its own printed figures judge the read.
 *
 * Nothing in here knows about models, HTTP or the database — it is cents in, verdict out, so it can
 * be tested to the cent. A check with no figure to check against does not fail: it goes unrun, and
 * is NAMED, because "never claim what you did not check" is the law this path lives or dies by.
 *
 * IT TAKES ANY LINES WITH CENTS ON THEM, not only a scan's: that widening is what lets one
 * verification serve every door. Its arithmetic and its sentences are untouched.
 */
export function checkScanTotals(lines: readonly { cents: number }[], c: ScanControls): ScanCheck {
  const out = lines.reduce((n, l) => (l.cents < 0 ? n - l.cents : n), 0);
  const money = lines.reduce((n, l) => (l.cents > 0 ? n + l.cents : n), 0);
  const agreed: string[] = [];
  const unchecked: string[] = [];
  const failed: ScanFail[] = [];

  // WHETHER THE PAPER'S OWN TWO TOTALS PINNED EVERY LINE. It decides one thing below and nothing else:
  // whether the balance may be walked the other way round when the named direction doesn't hold.
  let pinned = 0;

  if (c.withdrawals === null) unchecked.push("the money going out (it prints no total of withdrawals)");
  else if (out !== c.withdrawals) {
    failed.push({
      which: "withdrawals",
      offByCents: Math.abs(out - c.withdrawals),
      said: `The money going out doesn't add up: these lines come to ${D(out)} out and your statement prints ${D(c.withdrawals)} — ${gap(out, c.withdrawals)}.`,
    });
  } else {
    agreed.push("the money going out");
    pinned++;
  }

  if (c.deposits === null) unchecked.push("the money coming in (it prints no total of deposits)");
  else if (money !== c.deposits) {
    failed.push({
      which: "deposits",
      offByCents: Math.abs(money - c.deposits),
      said: `The money coming in doesn't add up: these lines come to ${D(money)} in and your statement prints ${D(c.deposits)} — ${gap(money, c.deposits)}.`,
    });
  } else {
    agreed.push("the money coming in");
    pinned++;
  }

  if (c.beginning === null || c.ending === null) {
    const missing = c.beginning === null && c.ending === null ? "no beginning or ending balance" : c.beginning === null ? "no beginning balance" : "no ending balance";
    unchecked.push(`the balance from end to end (it prints ${missing})`);
  } else {
    /**
     * THE WALK GOES THE WAY THIS ACCOUNT'S BALANCE GOES. A bank account: beginning + in - out. A card:
     * beginning + out - in, because the balance is what is OWED and a purchase adds to it. Walking
     * every statement as a bank account refused every correctly read card month — $709.38 "over" on a
     * paper with no error on it — and "Drop it again" could never fix it, so each retry bought a fresh
     * Opus read to print the same sentence.
     *
     * THE OTHER DIRECTION IS ONLY EVER ACCEPTED WHEN THE PAPER'S OWN TWO TOTALS ALREADY AGREED. Then
     * every line's side is pinned by the statement's own printed labels, so the only thing the other
     * direction can mean is that this is a liability account the reader named wrongly — it cannot
     * launder a read with its signs inverted, because inverted lines fail those two totals first.
     * Accepting either direction with no printed totals WOULD launder exactly that, so it is not done.
     */
    const asDeposit = c.beginning + money - out;
    const asCard = c.beginning + out - money;
    const named: ScanAccountKind = c.account === "card" ? "card" : "deposit";
    const walked = named === "card" ? asCard : asDeposit;
    const other = named === "card" ? asDeposit : asCard;
    if (walked === c.ending) agreed.push(BALANCE_SAID[named]);
    else if (pinned === 2 && other === c.ending) agreed.push(BALANCE_SAID[named === "card" ? "deposit" : "card"]);
    else {
      const how =
        named === "card"
          ? `this reads as a card, so ${S(c.beginning)} owed to start, ${D(out)} charged and ${D(money)} paid makes ${S(walked)}`
          : `${S(c.beginning)} to start, ${D(money)} in and ${D(out)} out makes ${S(walked)}`;
      failed.push({
        which: "balance",
        offByCents: Math.abs(walked - c.ending),
        said: `The balances don't meet: ${how}, but your statement ends at ${S(c.ending)} — ${gap(walked, c.ending)}.`,
      });
    }
  }
  return { pass: failed.length === 0, agreed, unchecked, failed };
}

const list = (parts: readonly string[]): string =>
  parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;

/**
 * WHAT THE READ REPORT SAYS THE PRINTED TOTALS DID — carried into pdfReadSaid (supplier-open-list.ts)
 * as the one report's own "held against" clause, never printed as a second summary somewhere else.
 *
 * A paper with no totals on it is the case this sentence exists for: the lines still reach the card,
 * and the card says out loud that NOTHING checked them.
 */
export function scanCheckSaid(check: ScanCheck): string {
  const cannot = check.unchecked.length ? ` It could not check ${list(check.unchecked)}, so go down those lines against the paper before you Apply.` : "";
  if (!check.agreed.length) {
    return "This statement prints no totals to hold the read against, so NOTHING here checked it: every line is the reader's word. Go down them against the paper before you Apply.";
  }
  return `Held against the statement's own printed figures: ${list(check.agreed)} agree to the cent.${cannot}`;
}

// ── THE ONE VERDICT ────────────────────────────────────────────────────────────────────────────

export type StatementVerdict = {
  source: StatementSource;
  chain: ChainCheck;
  /** The printed-totals check, when the paper printed figures to run it. Null when it was never asked
   *  (a download of six weeks' activity has no beginning balance, no ending balance and no totals). */
  totals: ScanCheck | null;
  /** The statement's own control figures, kept so a download re-read after a Swap can be judged again
   *  without the paper. Null when there were none. */
  controls: ScanControls | null;
  /** Every check that RAN and disagreed, the most findable one first. */
  failed: ScanFail[];
  /** False only when a check ran and disagreed. A check that could not run never fails a read. */
  pass: boolean;
};

/** "line 23 (Sep 12)" — a break said the two ways a person might go looking for it: by where it is
 *  in the file, and by the day it is under on the paper. */
const at = (b: ChainBreak) => `line ${b.row} (${sayDay(b.day)})`;

/**
 * WHAT THE CHAIN FOUND, IN ONE CLAUSE. The FIRST break is said in full and the rest are counted: one
 * missing line can break more than one link, and a refusal listing forty of them is useless — the
 * first break is the one to go and look at.
 */
export function chainSaid(chain: ChainCheck): string {
  const shape = `${chain.reversed ? " (it lists its lines newest first)" : ""}${chain.card ? ", and its balance is what you owe, so the walk runs the other way" : ""}`;
  const day = chain.sameDay
    ? ` ${chain.sameDay === 1 ? "One day was" : `${chain.sameDay} days were`} settled as a day rather than line by line, because a statement may print one day's lines in an order its balance wasn't worked out in.`
    : "";
  const covered = `${chain.links} ${chain.links === 1 ? "link" : "links"} across ${chain.lines} ${chain.lines === 1 ? "line" : "lines"}`;
  // NOTHING RAN, AND IT SAYS SO IN ITS OWN WORDS. `why` is a whole clause, capitalised here, because a
  // lead-in of "checked nothing:" in front of it read as two attempts at the same sentence.
  if (!chain.ran) return `${(chain.why ?? "").charAt(0).toUpperCase()}${(chain.why ?? "").slice(1)}.`;
  const first = chain.breaks[0];
  if (!first) return `Its own running balance proves every line: ${covered} add up to the cent${shape}.${day}`;
  const more = chain.broke - 1;
  const also = more > 0 ? ` ${more === 1 ? "One more link" : `${more} more links`} further down ${more === 1 ? "doesn't" : "don't"} add up either.` : "";
  // THE DIAGNOSIS, THEN WHAT ELSE BROKE, THEN HOW MUCH WAS WALKED, THEN ONE NEXT ACTION — in that order,
  // so the sentence ends on the thing to do rather than on a count.
  return `Its running balance stops adding up at ${at(first)}, by ${D(first.offByCents)}: a line there is missing, in twice, or its amount or its sign was read wrong.${also} ${covered} were walked${shape}.${day} Go and look at that line against the paper before you Apply.`;
}

/**
 * THE SENTENCE THE PERSON READS, and there is only ever ONE of it (pdfReadSaid's "held against" clause
 * and BankDownload.readSaid are the same string). THREE OUTCOMES, ALL SAID PLAINLY: it checked and
 * everything agrees; it checked and names where it broke and by how much; or there was nothing to
 * check it against, said out loud.
 *
 * THE SOURCE CLAUSE COMES LAST, after the fact, because it calibrates trust and asks for nothing.
 */
export function verifySaid(v: StatementVerdict): string {
  const parts: string[] = [];
  const totals = v.totals;
  if (totals) {
    // THE SCAN'S OWN SENTENCES, BYTE FOR BYTE, wherever they still apply. The one case they no longer
    // do is a paper that prints no totals while the chain DID check the lines: "NOTHING here checked
    // it" would then be the false claim this whole module exists to prevent.
    if (totals.agreed.length || !v.chain.ran) parts.push(scanCheckSaid(totals));
    else parts.push("This statement prints no totals to hold the read against.");
    for (const f of totals.failed) parts.push(f.said);
  }
  const alreadySaid = !!totals && !totals.agreed.length && !v.chain.ran;
  if (!alreadySaid) parts.push(chainSaid(v.chain));
  if (!v.chain.ran && !totals?.agreed.length) {
    // NOTHING HELD THIS READ TO ANYTHING, and that is the law: say so, and name ONE next action. The
    // scan's own "Go down them against the paper" has already named one, so it is not named twice.
    parts.push(
      v.source === "rows"
        ? "Hold the figures above against your account before you Apply."
        : totals
          ? ""
          : "Hold the figures above against the totals your statement prints before you Apply.",
    );
  }
  parts.push(sourceSaid(v.source));
  return parts.filter(Boolean).join(" ");
}

/**
 * THE ONE VERIFICATION EVERY DOOR ASKS. It is called from `readBankTable`, so a bank download cannot
 * come into being without it having run — that is the teeth, not a convention a new door might miss
 * (`bank-download.verify.test.ts` fails if a door stops naming how it read the file).
 *
 * A BREAK IS NOT THE SAME THING EVERYWHERE, and `pass` is only the arithmetic's verdict; the door
 * decides what to do with it. On a SCANNED statement a failed check means no card at all: the lines
 * are a model's word and nothing else vouches for them. On a CSV off the bank a break is telling the
 * person something real about his file, but the lines are still the bank's own rows and the card is
 * where they are confirmed — so that path warns and goes on.
 */
export function verifyStatement(a: { lines: readonly ChainLine[]; source: StatementSource; controls?: ScanControls | null }): StatementVerdict {
  const chain = balanceChain(a.lines);
  const controls = a.controls ?? null;
  const totals = controls ? checkScanTotals(a.lines, controls) : null;
  // THE CHAIN'S BREAK GOES FIRST: it is the only one of these that names a LINE, and a person holding
  // the paper can act on "line 23, $47 off" in a way "$47 out somewhere" never lets him.
  const failed: ScanFail[] = [];
  const first = chain.breaks[0];
  if (first) {
    failed.push({
      which: "chain",
      offByCents: first.offByCents,
      said: `The running balance doesn't add up: it breaks at ${at(first)}, by ${D(first.offByCents)}, so a line there is missing, in twice, or its amount or its sign was read wrong.`,
    });
  }
  if (totals) failed.push(...totals.failed);
  return { source: a.source, chain, totals, controls, failed, pass: failed.length === 0 };
}
