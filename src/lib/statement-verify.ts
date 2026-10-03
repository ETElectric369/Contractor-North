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
  /**
   * THE ACCOUNT THIS LINE IS ON, when the file prints one beside it (BankLine.last4 satisfies this).
   *
   * A FILE MAY MIX A CARD AND A CHECKING ACCOUNT — the bank reader says so in as many words — and two
   * accounts each printing their OWN correct running balance are TWO chains, not one. Walked as one,
   * the seam between them came out as "a line there is missing, in twice, or its amount or its sign was
   * read wrong" on a file with nothing wrong in it, which is the false alarm this module calls worse
   * than no check at all. Optional, because a file with no Account column has nothing to say here.
   */
  last4?: string | null;
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
  /**
   * LINKS CHECKED (a link is one line held to the one before it), and the lines they were walked across.
   *
   * A day settled as a DAY rather than line by line counts as the links it settles, not as one — it holds
   * every one of its posted lines inside a single step, and counting it as one put the right reading of a
   * file BELOW a wrong one when the two were compared on how much they explained.
   *
   * `links === lines - runs` is the whole file proved: each run's first line has nothing above it to be
   * held to, so it only ever seeds its own walk.
   */
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
  /**
   * HOW MANY SEPARATE RUNNING BALANCES THE FILE TURNED OUT TO HOLD. One is the ordinary case. More means
   * the file carries more than one account, or two statements stuck together — each walked on its own,
   * because the join between them is not a missing line and must never be reported as one. Every run's
   * first line only seeds its own walk, so a fully proved file has `links === lines - runs`.
   */
  runs: number;
  /** The runs are the file's own Account column, rather than a join found in the file's own days. */
  byAccount: boolean;
  /**
   * LINES THE WALK COULD NOT CHECK AT ALL, and the first day they sit on.
   *
   * A multi-line day with nothing before it to hold it to, whose own lines are not printed in the order
   * its balance was worked out in, cannot be checked: which of its printed balances closes it is not on
   * the paper. Such a day used to be dropped in SILENCE under a sentence that said every line was
   * proved — a claim over a check that did not run, which is the one thing this module exists to never
   * do. It is counted here and said in the report.
   */
  unwalked: number;
  unwalkedDay: string | null;
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
 * A SHAPE HAS TO EXPLAIN THE WHOLE FILE, AND THE RANKING SAYS SO FIRST (fixed 2026-10-02). This used to
 * pick the shape with the MOST agreed links, which is not the same promise: a correct short file whose
 * multi-line day is printed against posting order gives the right reading ONE link settled as a day and
 * no break, while the wrong direction walks that day line by line for two links and one break — and two
 * beat one, so a correct file was reported broken (and a correct scan refused). Zero breaks now comes
 * first, and a day settled as a day counts as the links it actually settles, so the two readings are
 * compared on the same footing.
 *
 * AND A DIRECTION THE FILE'S OWN DAYS RULE OUT IS NOT TRIED AT ALL (`ruledOut`). Reading a file whose
 * days only ever go forward as a newest-first file is not a second opinion; it is an arithmetic
 * coincidence waiting to happen, and one of the four shapes is exactly the coincidence that matters.
 */
type Shape = { reversed: boolean; card: boolean };
const SHAPES: readonly Shape[] = [
  { reversed: false, card: false },
  { reversed: true, card: false },
  { reversed: false, card: true },
  { reversed: true, card: true },
];

/**
 * THE DIRECTION THE FILE'S OWN DAYS RULE OUT, and why it has to be ruled out rather than merely scored.
 *
 * The shape {reversed, card} walks, in file order, bal(j+1) = bal(j) + money(j). That is ALGEBRAICALLY
 * THE SAME RELATION as "every amount sits on the row above its own line" — a whole amount column slipped
 * one row, which is a classic table-extraction failure — and as "the balance printed is the balance
 * BEFORE the line". So a file with that fault walked perfectly in that shape and was passed as clean,
 * with a sentence explaining it as a card listed newest first, on a checking account whose dates ascend.
 *
 * A file whose days go only FORWARD cannot be a file listed newest-first, and the other way round. So
 * that reading is not offered. A file all on one day, or with its days in no order at all, rules nothing
 * out and is untouched — which is why the dates could never have decided the order on their own.
 */
function ruledOut(lines: readonly ChainLine[]): { reversed: boolean } | null {
  const days: string[] = [];
  for (const l of lines) if (days[days.length - 1] !== l.postedOn) days.push(l.postedOn);
  if (days.length < 2) return null;
  let up = true;
  let down = true;
  for (let i = 1; i < days.length; i++) {
    if (!(days[i] > days[i - 1])) up = false;
    if (!(days[i] < days[i - 1])) down = false;
  }
  if (up) return { reversed: true };
  if (down) return { reversed: false };
  return null;
}

/**
 * WHAT THE PAPER ITSELF SAID ITS BALANCE IS, when a paper came with the lines.
 *
 * ONE FACT MUST NOT HAVE TWO RULES WITH OPPOSITE POLICIES. `checkScanTotals` refuses to read a balance
 * the other way round unless the paper's own two totals already pinned every line's side, and says why
 * in as many words: accepting either direction with no printed totals would launder a read with its
 * signs inverted. The chain was accepting the other direction on its own, so a scanned DEPOSIT statement
 * whose every column had been swapped came back "proves every line … its balance is what you owe", and
 * Apply would have counted every deposit as a cost. Same fact, same policy, now.
 */
export type ChainExpect = {
  /** The kind the paper named. Null counts as a deposit account, exactly as the totals check reads it. */
  account: ScanAccountKind | null;
  /** Did the paper's own two totals pin every line's side? Only then may the other sense be walked. */
  pinned: boolean;
};

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

type Walk = { agreed: number; sameDay: number; breaks: ChainBreak[]; runs: number; unwalked: number; unwalkedDay: string | null };

/**
 * ONE DAY'S LINES, WALKED STRICTLY: the balance reached so far, plus each line's money in turn, has to
 * be the balance printed beside that line. `ok: false` means some line in the day didn't follow.
 *
 * A LINE WITH NO BALANCE PRINTED ON IT STOPS THE WALK AND STARTS IT AGAIN at the next line that has
 * one. A bank leaves a line out of its own balance column when it has not posted it, and walking such a
 * line's amount THROUGH the column would break a correct file — a check that cries wolf is worse than
 * no check at all. The links checked are then fewer than the lines, and the report says both figures.
 */
function strictDay(from: number | null, block: readonly ChainLine[], sign: 1 | -1): { ok: boolean; agreed: number; close: number | null; offByCents: number } {
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
    const want = cursor + sign * l.cents;
    if (want !== l.balanceAfterCents) return { ok: false, agreed: 0, close: null, offByCents: Math.abs(l.balanceAfterCents - want) };
    agreed++;
    cursor = l.balanceAfterCents;
  }
  return { ok: true, agreed, close: cursor, offByCents: 0 };
}

/**
 * THE SAME DAY WALKED LOOSELY: after each disagreement the walk goes on from the FILE'S OWN figure, so
 * one bad line breaks ONE link and the lines after it are judged on their own merits.
 *
 * This is what the top-level walk does between days, applied INSIDE a day — and it is used in exactly one
 * place: a day whose own printed figures are provably broken whatever order its lines posted in (see
 * `dayOnItsOwn`). A month printed all on ONE day is that case when one of its amounts is wrong, and the
 * whole day used to go unchecked, so a 40-line file with one $5.00 error reported that there was no walk
 * to make. Thirty-eight good links must not be thrown away with the one bad one.
 */
function looseDay(from: number | null, block: readonly ChainLine[], sign: 1 | -1): { agreed: number; breaks: ChainBreak[]; close: number | null } {
  let cursor = from;
  let agreed = 0;
  const breaks: ChainBreak[] = [];
  for (const l of block) {
    if (l.balanceAfterCents === null) {
      cursor = null;
      continue;
    }
    if (cursor === null) {
      cursor = l.balanceAfterCents;
      continue;
    }
    const want = cursor + sign * l.cents;
    if (want === l.balanceAfterCents) agreed++;
    else breaks.push({ row: l.row, day: l.postedOn, offByCents: Math.abs(l.balanceAfterCents - want) });
    cursor = l.balanceAfterCents;
  }
  return { agreed, breaks, close: cursor };
}

/**
 * A DAY THE WALK CANNOT ENTER, JUDGED ON ITS OWN PRINTED FIGURES ALONE — and this is the rule that
 * decides whether such a day is BROKEN, merely out of order, or not readable either way.
 *
 * A file that OPENS on a multi-line day has no balance before that day. If that day's lines are printed
 * in the order they posted in, the strict walk seeds from the first and handles it. If they are not,
 * nothing outside the day can say which of its printed balances closes it. The old code simply dropped
 * such a day, left the walk with no figure, and so could not enter any later out-of-order day either —
 * which is why an ordinary correct short file came back "stops adding up", and why a wrong amount, a
 * duplicate or a flipped sign on that day was missed every single time.
 *
 * THE DAY'S OWN ARITHMETIC ANSWERS IT. Whichever of its lines posted FIRST opens the day at its own
 * printed balance less its own money, and the day then CLOSES at that open plus the day's net. A close
 * the day never printed cannot be the day's close, so that line did not post first. Run that over every
 * line and:
 *
 *   · NO line can have posted first  → no order of its lines explains its own balance column. The day is
 *     broken, whatever order it is in, and `looseDay` names the line.
 *   · EXACTLY ONE close survives     → that is the day's close. The walk goes on from it. The day's own
 *     lines are still NOT claimed (this condition is necessary, not sufficient, past two lines), so they
 *     are counted as unwalked and the report says so.
 *   · SEVERAL survive                → the paper does not say. The walk starts again at the next day.
 *
 * The net is taken over the lines that PRINT a balance, exactly as the strict walk is: a bank leaves an
 * unposted line out of its own balance column, so counting that line's money against the column breaks a
 * correct file.
 */
function dayOnItsOwn(block: readonly ChainLine[], sign: 1 | -1): { closes: number[]; broken: boolean } {
  const posted = block.filter((l) => l.balanceAfterCents !== null);
  if (posted.length < 2) return { closes: [], broken: false };
  const printed = new Set(posted.map((l) => l.balanceAfterCents as number));
  const net = posted.reduce((n, l) => n + sign * l.cents, 0);
  const closes = new Set<number>();
  for (const l of posted) {
    const close = (l.balanceAfterCents as number) - sign * l.cents + net;
    if (printed.has(close)) closes.add(close);
  }
  return { closes: [...closes], broken: closes.size === 0 };
}

/** What one day's lines did to the walk: the links it proved, the one break it owns, and where the
 *  column stands after it (null when the paper does not say). */
type DayStep = { agreed: number; sameDay: number; breaks: ChainBreak[]; unwalked: number; close: number | null };

/**
 * ONE DAY, AND EVERY WAY A DAY MAY BE HELD TO THE COLUMN — the one place that rule lives, so the walk
 * between days and the walk inside a day cannot drift apart.
 *
 * SAME-DAY LINES, AND WHY A DAY GETS A SECOND CHANCE. Several transactions on one day may be printed in
 * an order they did not post in, so the running balance beside them can look out of step while the file
 * is perfectly correct. So each day is held to the STRICT line-by-line walk first — full strength, and
 * what almost every file does — and only a day that fails it is held to its own NET instead: the day's
 * money added to the balance before it has to land on a balance printed somewhere inside that day,
 * because the day's net is what the balance column actually proves whichever order its lines are in.
 * That is counted, and SAID, as a day settled rather than line by line. A line MISSING out of such a day
 * still breaks it, because the day's net is then wrong by exactly that line.
 *
 * A DAY CARRYING A LINE THE BANK HAS NOT POSTED LEAVES THE COLUMN'S FIGURE UNKNOWN AFTER IT when it had
 * to be settled as a day. Its net lands on a printed balance, which is a real check — but whether that
 * balance is the day's close (the bank left the line out) or short by that line's money (the cell simply
 * didn't read) is not on the paper. Guessing it broke the NEXT day on a correct statement, and on the
 * scanned lane that refused it outright, so the walk starts again instead.
 *
 * AFTER A BREAK ON A SINGLE-LINE DAY THE WALK GOES ON FROM THE FILE'S OWN FIGURE, which is that day's
 * close beyond doubt — one bad line then breaks ONE link and a refusal names a line and not forty. A
 * MULTI-LINE day that failed both the strict walk and its own net has no close anybody knows, so the
 * walk starts again rather than manufacturing a second break out of a figure it guessed.
 */
function oneDay(from: number | null, block: readonly ChainLine[], sign: 1 | -1): DayStep {
  const strict = strictDay(from, block, sign);
  if (strict.ok) return { agreed: strict.agreed, sameDay: 0, breaks: [], unwalked: 0, close: strict.close };
  const posted = block.filter((l) => l.balanceAfterCents !== null);
  const printed = posted.map((l) => l.balanceAfterCents as number);
  const whole = posted.length === block.length;
  const row = Math.min(...block.map((l) => l.row));
  const day = block[0].postedOn;
  if (from !== null) {
    const want = from + posted.reduce((n, l) => n + sign * l.cents, 0);
    if (block.length > 1 && printed.includes(want)) {
      // THE DAY ADDS UP AS A DAY. Every one of its posted lines is inside that one step, so they count as
      // the links they are — a day settled as a day used to count as ONE link however many lines it
      // settled, which put the right reading of a file below a wrong one in the ranking.
      return { agreed: posted.length, sameDay: 1, breaks: [], unwalked: 0, close: whole ? want : null };
    }
    const last = printed[printed.length - 1];
    return { agreed: 0, sameDay: 0, breaks: [{ row, day, offByCents: Math.abs(last - want) }], unwalked: 0, close: block.length === 1 ? last : null };
  }
  const own = dayOnItsOwn(block, sign);
  if (own.broken) {
    const loose = looseDay(null, block, sign);
    return { agreed: loose.agreed, sameDay: 0, breaks: loose.breaks, unwalked: 0, close: loose.close };
  }
  // NOT CLAIMED, AND NOT REPORTED EITHER: a figure worked out from a missing one is the "something wrong"
  // this check is here to say nothing instead of. It is COUNTED, and the report names the day.
  return { agreed: 0, sameDay: 0, breaks: [], unwalked: block.length, close: own.closes.length === 1 && whole ? own.closes[0] : null };
}

/**
 * ONE WALK DOWN THE FILE IN ONE SHAPE, day by day (`oneDay` holds every day to the column).
 *
 * A JOIN IS NOT A BREAK (2026-10-02). A file may carry two accounts one after the other, or a combined
 * statement's checking table and then its savings table, each printing its own correct running balance.
 * Walked as one chain, the join came out as "a line there is missing" on a file with nothing wrong in it —
 * and on the scanned lane that REFUSED a perfect read, with "Drop it again" buying another model read and
 * the same refusal, which is a dead end wearing a sentence.
 *
 * WHAT TELLS A JOIN FROM A MISSING LINE IS THE FILE'S OWN DAYS. A second account's section starts over at
 * an earlier day; a line lost out of the middle of one run never makes the days go backwards. So a break
 * at a day EARLIER than the day the walk is standing on is not a break: it is where a second running
 * balance starts, and the walk starts again there. It is COUNTED as a run and the report says how many
 * the file turned out to hold, because a statement that holds two balances is a thing a person should be
 * told. A day printed out of order that still walks is left alone — only a break can be a join.
 */
function walk(lines: readonly ChainLine[], shape: Shape): Walk {
  const seq = shape.reversed ? [...lines].reverse() : lines;
  const sign = shape.card ? -1 : 1;
  let agreed = 0;
  let sameDay = 0;
  let unwalked = 0;
  let unwalkedDay: string | null = null;
  let runs = 1;
  const breaks: ChainBreak[] = [];
  let close: number | null = null;
  /** The day the column's figure belongs to, so a break can be told from a join. */
  let standing: string | null = null;
  for (const block of dayBlocks(seq)) {
    let step = oneDay(close, block, sign);
    if (step.breaks.length && standing !== null && block[0].postedOn < standing) {
      runs++;
      step = oneDay(null, block, sign);
    }
    agreed += step.agreed;
    sameDay += step.sameDay;
    breaks.push(...step.breaks);
    if (step.unwalked) {
      unwalked += step.unwalked;
      unwalkedDay = unwalkedDay ?? block[0].postedOn;
    }
    close = step.close;
    standing = close === null ? null : block[0].postedOn;
  }
  return { agreed, sameDay, breaks, runs, unwalked, unwalkedDay };
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
/**
 * A FILE THAT IS ALL ONE DAY, PRINTED OUT OF THE ORDER ITS BALANCE WAS WORKED OUT IN. Its column may be
 * perfectly good; there is simply nothing before its lines to hold them to, and which of its balances
 * closes the day is not on the paper. Saying "it isn't a running account balance" about such a file would
 * be the wrong reason for the right silence, and a wrong reason sends a person looking in the wrong place.
 */
const noEntry = (day: string) => `its lines on ${sayDay(day)} aren't printed in the order its running balance was worked out in, and nothing before them prints a balance to hold them to, so there was no walk to make`;
/**
 * THE COLUMN ONLY ADDS UP READ AS THE OTHER KIND OF ACCOUNT, which the paper doesn't say it is.
 *
 * A BREAK HERE WOULD BE A CRIED WOLF, and on the scanned lane a cried wolf is a refusal. The named kind is
 * not allowed to vouch for the other direction (see ChainExpect) — but a break in the named direction is
 * no proof of a missing line either when the other direction explains the whole file: far likelier the
 * reader named the account wrongly, or read its two money columns the wrong way round. Both of those are
 * worth saying, and neither is "a line there is missing".
 *
 * THE DATES GET NO SUCH MERCY, and the difference is real: a file cannot be both oldest-first and
 * newest-first, so a break in the only order the dates allow IS a break. A kind the paper named can simply
 * be wrong.
 */
const otherKind = (card: boolean) =>
  `its running balance only adds up read as ${card ? "a card, where what you owe goes up with a purchase" : "money you hold"} — which isn't what this paper says the account is — so nothing was walked against it. Check that its money in and money out didn't come off the paper the wrong way round`;

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
export function balanceChain(lines: readonly ChainLine[], expect?: ChainExpect | null): ChainCheck {
  const whole = oneAccountChain(lines, expect ?? null);
  // THE WHOLE FILE FIRST, ALWAYS: a card export may put several card numbers against ONE account balance,
  // and splitting that by card number would break a file that walks. Only a file the whole-file walk could
  // not explain is tried as the accounts the file says it holds.
  if (whole.ran && whole.broke === 0) return whole;
  const groups = byAccount(lines);
  if (!groups) return whole;
  const parts = groups.map((g) => oneAccountChain(g, expect ?? null));
  // EVERY ACCOUNT HAS TO WALK ON ITS OWN, or this says nothing: a partition that explains part of the file
  // is a guess, and the whole-file answer is at least the one the file's own order gives.
  if (!parts.every((p) => p.ran && p.broke === 0)) return whole;
  const lead = parts.reduce((a, b) => (b.links > a.links ? b : a));
  return {
    ran: true,
    links: parts.reduce((n, p) => n + p.links, 0),
    lines: lines.length,
    withBalance: whole.withBalance,
    reversed: lead.reversed,
    card: lead.card,
    breaks: [],
    broke: 0,
    sameDay: parts.reduce((n, p) => n + p.sameDay, 0),
    // EVERY RUN FOUND, not one per account: an account may itself hold two (a statement appended to a
    // statement), and `links === lines - runs` is what lets the report say every line after the first.
    runs: parts.reduce((n, p) => n + p.runs, 0),
    byAccount: true,
    unwalked: parts.reduce((n, p) => n + p.unwalked, 0),
    unwalkedDay: parts.map((p) => p.unwalkedDay).filter((d): d is string => !!d).sort()[0] ?? null,
    why: null,
  };
}

/**
 * THE FILE SPLIT INTO THE ACCOUNTS IT SAYS IT HOLDS, or null when it says it holds one.
 *
 * Only when EVERY line names an account and at least two of them differ: a file where some lines carry an
 * account number and some do not is a file whose own column cannot be trusted to split it.
 */
function byAccount(lines: readonly ChainLine[]): ChainLine[][] | null {
  if (!lines.length || lines.some((l) => !l.last4)) return null;
  const groups = new Map<string, ChainLine[]>();
  for (const l of lines) {
    const key = l.last4 as string;
    const got = groups.get(key);
    if (got) got.push(l);
    else groups.set(key, [l]);
  }
  return groups.size >= 2 ? [...groups.values()] : null;
}

/** ONE ACCOUNT'S LINES, IN WHICHEVER OF THE FOUR SHAPES EXPLAINS THEM. */
function oneAccountChain(lines: readonly ChainLine[], expect: ChainExpect | null): ChainCheck {
  const withBalance = lines.filter((l) => (l.balanceAfterCents ?? null) !== null).length;
  const base = { links: 0, lines: lines.length, withBalance, reversed: false, card: false, breaks: [] as ChainBreak[], broke: 0, sameDay: 0, runs: 0, byAccount: false, unwalked: 0, unwalkedDay: null };
  if (withBalance === 0) return { ...base, ran: false, why: NO_COLUMN };
  if (withBalance === 1) return { ...base, ran: false, why: ONE_BALANCE };
  const clean = lines.map((l) => ({ ...l, balanceAfterCents: l.balanceAfterCents ?? null }));
  // TWO LINES NEXT TO EACH OTHER BOTH CARRYING A BALANCE IS WHAT MAKES A WALK POSSIBLE, and it is a fact
  // about the FILE, not about what the walk managed. It used to be read off "no links came out of the
  // walk", so a month printed all on one day with one amount wrong — every line carrying a balance — was
  // told "no two lines next to each other both carry a running balance", which is plainly false.
  const adjacent = clean.some((l, i) => i > 0 && l.balanceAfterCents !== null && clean[i - 1].balanceAfterCents !== null);
  if (!adjacent) return { ...base, ran: false, why: NO_PAIR };
  const out = ruledOut(clean);
  const named: ScanAccountKind = expect?.account === "card" ? "card" : "deposit";
  const byDate = SHAPES.filter((s) => out === null || s.reversed !== out.reversed);
  const senseOk = (s: Shape) => !expect || expect.pinned || s.card === (named === "card");
  const allowed = byDate.filter(senseOk);
  const shapes = allowed.length ? allowed : byDate;
  // THE SHAPE THAT EXPLAINS THE WHOLE FILE, and only then the one that explains the most of it. The first
  // shape in the list wins a tie, so the same file always reports the same way round; `unwalked` and then
  // `sameDay` break the last ties, because the reading that claimed least on faith is the truer one.
  let best = { shape: shapes[0], w: walk(clean, shapes[0]) };
  for (const shape of shapes.slice(1)) {
    const w = walk(clean, shape);
    if (betterWalk(w, best.w)) best = { shape, w };
  }
  if (best.w.breaks.length) {
    // THE KIND THE PAPER NAMED MAY SIMPLY BE WRONG, so a break in that direction is not reported when the
    // other direction explains the whole file. It is said, as the thing to go and check.
    const other = byDate.filter((s) => !senseOk(s)).map((s) => ({ s, w: walk(clean, s) })).find(({ w }) => w.agreed > 0 && w.breaks.length === 0);
    if (other) return { ...base, ran: false, why: otherKind(other.s.card) };
  }
  const links = best.w.agreed + best.w.breaks.length;
  if (best.w.agreed === 0) return { ...base, ran: false, unwalked: best.w.unwalked, unwalkedDay: best.w.unwalkedDay, why: best.w.unwalkedDay ? noEntry(best.w.unwalkedDay) : NOT_RUNNING };
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
    runs: best.w.runs,
    byAccount: false,
    unwalked: best.w.unwalked,
    unwalkedDay: best.w.unwalkedDay,
    why: null,
  };
}

/**
 * WHICH OF TWO READINGS OF THE SAME FILE TO BELIEVE. A reading that WALKED something and broke NOWHERE
 * beats every reading that broke somewhere — that is the module's own promise, that a file is reported
 * clean only when some shape explains all of it.
 *
 * "WALKED SOMETHING" IS NOT OPTIONAL IN THAT TEST. A shape that walked nothing also broke nothing, and
 * ranking it above a shape with one walked link and one break would hand a genuinely broken file a verdict
 * of "nothing was walked" instead of naming the line. Breaking nothing only counts for a reading that
 * actually held some line to another.
 */
function betterWalk(a: Walk, b: Walk): boolean {
  const clean = (w: Walk) => w.agreed > 0 && w.breaks.length === 0;
  if (clean(a) !== clean(b)) return clean(a);
  if (a.agreed !== b.agreed) return a.agreed > b.agreed;
  if (a.breaks.length !== b.breaks.length) return a.breaks.length < b.breaks.length;
  if (a.unwalked !== b.unwalked) return a.unwalked < b.unwalked;
  return a.sameDay < b.sameDay;
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
  /**
   * HOW MANY OF THE PAPER'S OWN TWO TOTALS PINNED EVERY LINE'S SIDE (0, 1 or 2). It decides ONE thing and
   * nothing else: whether the balance may be read the other way round. The CHAIN needs the same answer,
   * so it is handed out rather than worked out twice — one fact, one rule, one place.
   */
  pinned: number;
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
  return { pass: failed.length === 0, agreed, unchecked, failed, pinned };
}

const list = (parts: readonly string[]): string =>
  parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;

/**
 * WHAT THE READ REPORT SAYS THE PRINTED TOTALS DID — carried into pdfReadSaid (supplier-open-list.ts)
 * as the one report's own "held against" clause, never printed as a second summary somewhere else.
 *
 * A paper with no totals on it is the case this sentence exists for: the lines still reach the card,
 * and the card says out loud that NOTHING checked them.
 *
 * "NOTHING AGREED" IS NOT "NOTHING WAS PRINTED" (fixed 2026-10-02). A check that RAN AND FAILED also
 * leaves `agreed` empty. cn-v1050 never met that case, because a scan whose figures disagreed was refused
 * before this sentence was ever built — but a person's Swap re-verifies a stored scan with its own kept
 * control figures, so a card could lead with "This statement prints no totals to hold the read against"
 * and then quote the three totals the statement prints. That is the claim this module's header promises
 * never to make, so the two cases are told apart on whether ANY check ran at all.
 */
export function scanCheckSaid(check: ScanCheck, walked?: boolean): string {
  // AND IT DOES NOT ORDER A PERSON TO DO WHAT THE WALK JUST DID. With `walked`, the running balance has
  // already held these lines to each other, and "go down those lines against the paper" immediately above
  // "its own running balance proves every line" is two instructions pulling opposite ways in one report.
  // What the walk cannot see is said once, by verifySaid, with the one action that answers it.
  const cannot = check.unchecked.length ? ` It could not check ${list(check.unchecked)}${walked ? "." : ", so go down those lines against the paper before you Apply."}` : "";
  if (!check.agreed.length && !check.failed.length) {
    return "This statement prints no totals to hold the read against, so NOTHING here checked it: every line is the reader's word. Go down them against the paper before you Apply.";
  }
  if (!check.agreed.length) return `Held against the statement's own printed figures, and the read does not stand up.${cannot}`;
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
 *
 * AND IT SAYS WHAT IT PROVED, NOT MORE (fixed 2026-10-02). "Its own running balance proves every line"
 * was printed whatever the coverage: over the first line, whose own amount only ever SEEDS the walk and
 * is never held to anything; over a line carrying no balance, which is in no link; and over a whole day
 * the walk could not enter, which was dropped in silence. A sentence like that over a wrong amount on the
 * opening day is an assurance printed above an unverified figure, which this module exists to never do.
 * So "every line" has to EARN itself: every line after the first of each run, and no day left unchecked.
 *
 * THE SOURCE DECIDES WHAT "GO AND LOOK" POINTS AT. A bank's own CSV has no paper to hold it against — its
 * rows ARE the bank's, which is the whole reason that door warns instead of refusing — so it is sent to
 * the account instead of to a paper nobody has.
 */
export function chainSaid(chain: ChainCheck, source?: StatementSource): string {
  const shape = `${chain.reversed ? " (it lists its lines newest first)" : ""}${chain.card ? ", and its balance is what you owe, so the walk runs the other way" : ""}`;
  const day = chain.sameDay
    ? ` ${chain.sameDay === 1 ? "One day was" : `${chain.sameDay} days were`} settled as a day rather than line by line, because a statement may print one day's lines in an order its balance wasn't worked out in.`
    : "";
  const covered = `${chain.links} ${chain.links === 1 ? "link" : "links"} across ${chain.lines} ${chain.lines === 1 ? "line" : "lines"}`;
  // NOTHING RAN, AND IT SAYS SO IN ITS OWN WORDS. `why` is a whole clause, capitalised here, because a
  // lead-in of "checked nothing:" in front of it read as two attempts at the same sentence.
  if (!chain.ran) return `${(chain.why ?? "").charAt(0).toUpperCase()}${(chain.why ?? "").slice(1)}.`;
  // MORE THAN ONE RUNNING BALANCE IN ONE FILE IS A FACT ABOUT THE PAPER, so it is said rather than hidden
  // behind a count that quietly got smaller.
  const runs =
    chain.runs > 1
      ? ` This file holds ${chain.runs} separate running balances — ${chain.byAccount ? "its own Account column says so" : "more than one account, or two statements in one file"} — and each was walked on its own.`
      : "";
  const look = source === "rows" ? "in the file against your account" : "against the paper";
  const first = chain.breaks[0];
  if (!first) {
    // EVERY LINE AFTER THE FIRST, said as that: with no opening balance printed anywhere, the oldest line's
    // own amount has nothing above it to prove it, and claiming otherwise is claiming what wasn't checked.
    if (chain.links === chain.lines - chain.runs && !chain.unwalked) {
      return `Its own running balance proves every line after the first: ${covered} add up to the cent${shape} — each line's balance is the one before it plus that line's money.${day}${runs}`;
    }
    // THE COUNT, THEN WHAT ELSE IS TRUE OF THE FILE, THEN ONE NEXT ACTION LAST, like every other outcome
    // here: a sentence that ends on a count leaves a person with nothing to do.
    const missed = chain.unwalkedDay
      ? ` It could not check ${sayDay(chain.unwalkedDay)}'s ${chain.unwalked} ${chain.unwalked === 1 ? "line" : "lines"}: nothing before them prints a balance to hold them to, and which of that day's balances closes it isn't on the paper. Go down those ${look} before you Apply.`
      : " Its other lines print no balance beside them, so nothing held those.";
    return `Its own running balance holds ${covered} to the cent${shape}.${day}${runs}${missed}`;
  }
  const more = chain.broke - 1;
  const also = more > 0 ? ` ${more === 1 ? "One more link" : `${more} more links`} ${more === 1 ? "doesn't" : "don't"} add up either.` : "";
  // THE DIAGNOSIS, THEN WHAT ELSE BROKE, THEN HOW MUCH WAS CHECKED, THEN ONE NEXT ACTION — in that order,
  // so the sentence ends on the thing to do rather than on a count.
  return `Its running balance stops adding up at ${at(first)}, by ${D(first.offByCents)}: a line there is missing, in twice, or its amount or its sign was read wrong.${also} ${covered} were checked${shape}.${day}${runs} Go and look at that line ${look} before you Apply.`;
}

/**
 * THE SENTENCE THE PERSON READS, and there is only ever ONE of it (pdfReadSaid's "held against" clause
 * and BankDownload.readSaid are the same string). THREE OUTCOMES, ALL SAID PLAINLY: it checked and
 * everything agrees; it checked and names where it broke and by how much; or there was nothing to
 * check it against, said out loud.
 *
 * THE SOURCE CLAUSE COMES LAST, after the fact, because it calibrates trust and asks for nothing.
 */
/** Did the paper's OWN beginning and ending balance close both ends of this read? Only then has anything
 *  held a line that may have been lost off the top or the bottom of the table. */
const endsHeld = (v: StatementVerdict): boolean =>
  !!v.controls && v.controls.beginning !== null && v.controls.ending !== null && !(v.totals?.failed ?? []).some((f) => f.which === "balance");

export function verifySaid(v: StatementVerdict): string {
  const parts: string[] = [];
  const totals = v.totals;
  // THE PAPER PRINTED NO TOTALS only when nothing was held to them either way: see scanCheckSaid.
  const nonePrinted = !!totals && !totals.agreed.length && !totals.failed.length;
  if (totals) {
    // THE SCAN'S OWN SENTENCES, BYTE FOR BYTE, wherever they still apply. The one case they no longer
    // do is a paper that prints no totals while the chain DID check the lines: "NOTHING here checked
    // it" would then be the false claim this whole module exists to prevent.
    if (nonePrinted && v.chain.ran) parts.push("This statement prints no totals to hold the read against.");
    else parts.push(scanCheckSaid(totals, v.chain.ran));
    for (const f of totals.failed) parts.push(f.said);
  }
  // THE CHAIN STILL SPEAKS UNLESS IT HAS NOTHING TO ADD. "NOTHING here checked it" already covers a file
  // that printed no balance column at all; every other reason the walk could not run names something about
  // THIS paper that a person can act on — one balance on one line, a column that walks nowhere, a day with
  // nothing above it, or a balance that only adds up read as the other kind of account. Swallowing those
  // behind the scan's generic sentence threw away the only clue in the report.
  const alreadySaid = nonePrinted && !v.chain.ran && v.chain.why === NO_COLUMN;
  if (!alreadySaid) parts.push(chainSaid(v.chain, v.source));
  // A RUNNING BALANCE THAT ADDS UP DOES NOT CLEAR A PRINTED FIGURE THAT DOESN'T, and it must not be left
  // reading as though it did. The chain cannot tell a read with every sign turned over from a correct one
  // — that is what the four shapes are, and it is why the printed totals exist — so an unqualified "proves
  // every line" under three failed totals is an assurance over the one error the chain is blind to.
  if (totals?.failed.length && v.chain.ran && !v.chain.breaks.length) {
    parts.push("The running balance adding up does not clear the figures above: a read with its signs turned over walks just as well.");
  }
  if (!v.chain.ran && !totals?.agreed.length) {
    // NOTHING HELD THIS READ TO ANYTHING, and that is the law: say so, and name ONE next action. The
    // scan's own "Go down them against the paper" has already named one, so it is not named twice.
    parts.push(
      v.source === "rows"
        ? // NOT "the figures above": on a CSV, Excel or OFX there are none. The drop line carries a count of
          // lines and the card's headline carries dates and counts, with the first dollar figure BELOW this
          // sentence — so it points at the lines, which are on the card, and not at a figure that isn't.
          "Go down these lines against your account before you Apply."
        : totals
          ? ""
          : "Hold the figures above against the totals your statement prints before you Apply.",
    );
  } else if (v.chain.ran && !v.chain.breaks.length && v.source !== "rows" && !endsHeld(v)) {
    // THE ONE THING A RUNNING BALANCE CANNOT SEE, said where a person can act on it. A link needs a
    // NEIGHBOURING balance, so a transaction lost off the TOP or the BOTTOM of the table leaves every
    // remaining link adding up to the cent. Only the paper's own beginning and ending balance close those
    // two ends, and on a text PDF there are none at all.
    //
    // IT USED TO BE pdfReadSaid'S OWN "Check that against the totals your statement prints" — and the
    // moment every download started carrying a read report, that report became pdfReadSaid's `checked` and
    // silently REPLACED the instruction, on the one door where the person's own five-second comparison was
    // the whole of the proof. A statement whose extractor dropped its tail page then read "proves every
    // line" with nothing left asking him to look.
    parts.push("The walk can't see a line lost off the top or the bottom of the table, so hold the figures above against the totals your statement prints before you Apply.");
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
  const controls = a.controls ?? null;
  const totals = controls ? checkScanTotals(a.lines, controls) : null;
  // THE PAPER'S OWN NAMED ACCOUNT KIND DECIDES WHICH WAY ITS BALANCE RUNS, for the chain exactly as it
  // already did for the printed totals. The totals run first because the chain needs their answer to one
  // question: did the paper's own two totals pin every line's side? Only then may the balance be read the
  // other way round, because only then can the other direction mean nothing worse than a mislabelled
  // account. A download that came with no paper constrains nothing: a card's CSV names no kind anywhere.
  const chain = balanceChain(a.lines, controls ? { account: controls.account, pinned: totals !== null && totals.pinned === 2 } : null);
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
